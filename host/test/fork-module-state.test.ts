import { describe, expect, it } from "vitest";
import {
  activationContinuationsForChild,
  decodeForkActivationContinuations,
  decodeForkModuleStateDescriptor,
  decodeForkImportedGlobalBindings,
  decodeForkImportedTableBindings,
  encodeForkActivationContinuations,
  encodeForkImportedGlobalBindings,
  encodeForkImportedTableBindings,
  encodeForkModuleStateDescriptor,
  computeForkModuleTemplateId,
  computeForkModuleTemplateIdSync,
  ForkImportedGlobalBindingKind,
  ForkImportedTableBindingKind,
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
  ForkTableDirtyTracker,
  FORK_MODULE_STATE_DESCRIPTOR_SIZE,
  FORK_MODULE_STATE_DESCRIPTOR_VERSION,
  FORK_MODULE_STATE_REQUIRED_FLAGS,
  FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
  FORK_MODULE_STATE_SECTION,
  readForkModuleStateDescriptor,
  readForkImportedGlobals,
  readForkImportedTables,
  readForkModuleStateRoot,
  writeForkModuleStateRoot,
  replayEventsForChild,
  type ForkSparseTableSnapshot,
} from "../src/fork-module-state";
import {
  type ForkReplayEvent,
  ForkReplayEventJournal,
} from "../src/fork-replay-events";
import {
  WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE,
  WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
  WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE,
  WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED,
  WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE,
  WPK_FORK_IMPORTED_GLOBALS_MAGIC,
  WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
  WPK_FORK_IMPORTED_GLOBALS_SECTION,
  WPK_FORK_IMPORTED_GLOBALS_VERSION,
  WPK_FORK_IMPORTED_TABLES_HEADER_SIZE,
  WPK_FORK_IMPORTED_TABLES_MAGIC,
  WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE,
  WPK_FORK_IMPORTED_TABLES_SECTION,
  WPK_FORK_IMPORTED_TABLES_VERSION,
} from "../src/generated/abi";

const PAGE_SIZE = 65_536;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function replayEventCapture(
  events: readonly ForkReplayEvent[],
): ForkReplayEventJournal {
  const journal = new ForkReplayEventJournal();
  journal.beginCapture();
  for (const event of events) {
    journal.recordCommit(event.activationId, event.functionOrdinal);
  }
  journal.sealCapture();
  return journal;
}

function replayEventRecords(events: readonly ForkReplayEvent[]) {
  const journal = replayEventCapture(events);
  return [
    ...[...journal.capturedSegmentPayloads()].map((payload) => ({
      kind: ForkModuleStateRecordKind.ReplayEventSegment,
      activationId: 0,
      ownerId: 1,
      payload,
    })),
    {
      kind: ForkModuleStateRecordKind.ReplayEvents,
      activationId: 0,
      ownerId: 1,
      payload: journal.capturedManifestPayload(),
    },
  ];
}

describe("fork module template identity", () => {
  it("matches the published SHA-256 empty and abc vectors synchronously", () => {
    expect(hex(computeForkModuleTemplateIdSync(new Uint8Array())))
      .toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(computeForkModuleTemplateIdSync(new TextEncoder().encode("abc"))))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches WebCrypto for sliced inputs spanning several blocks", async () => {
    const storage = new Uint8Array(271);
    for (let index = 0; index < storage.length; index++) {
      storage[index] = (index * 73 + 19) & 0xff;
    }
    const source = storage.subarray(7, 264);
    expect(computeForkModuleTemplateIdSync(source))
      .toEqual(await computeForkModuleTemplateId(source));
  });
});

describe("fork table dirty journal", () => {
  it("merges mutation ranges and enumerates pages deterministically", () => {
    const tracker = new ForkTableDirtyTracker();
    tracker.markPages(7, 20n, 3n);
    tracker.markPages(7, 4n, 2n);
    tracker.markPages(7, 6n, 4n);
    tracker.markPages(7, 9n, 12n);
    tracker.markPages(7, 5n, 0n);

    expect(tracker.pageCount(7)).toBe(19);
    expect(
      Array.from({ length: tracker.pageCount(7) }, (_, ordinal) =>
        tracker.pageAt(7, ordinal)
      ),
    ).toEqual(Array.from({ length: 19 }, (_, index) => BigInt(index + 4)));
    expect(() => tracker.pageAt(7, 19)).toThrow("has no page ordinal");
  });

  it("round-trips unsigned i64 page bits through signed Wasm BigInt", () => {
    const tracker = new ForkTableDirtyTracker();
    tracker.markPages(1, -1n, 1n);
    expect(tracker.pageCount(1)).toBe(1);
    expect(tracker.pageAt(1, 0)).toBe(-1n);
  });

  it("unions per-activation journals for one imported Table identity", () => {
    const provider = new ForkTableDirtyTracker();
    const consumer = new ForkTableDirtyTracker();
    provider.markPages(4, 1n, 2n);
    consumer.markPages(9, 7n, 1n);
    consumer.aliasOwner(9, provider, 4);
    expect(provider.ownsState(4)).toBe(true);
    expect(consumer.ownsState(9)).toBe(false);
    provider.markPages(4, 12n, 2n);
    consumer.markPages(9, 20n, 1n);

    const expected = [1n, 2n, 7n, 12n, 13n, 20n];
    for (const [tracker, owner] of [[provider, 4], [consumer, 9]] as const) {
      expect(tracker.pageCount(owner)).toBe(expected.length);
      expect(expected.map((_, index) => tracker.pageAt(owner, index)))
        .toEqual(expected);
    }

    // A provider can be dlclosed while its physical Table remains reachable
    // through a consumer import. Ownership moves without severing the merged
    // mutation journal or losing pages written through the old provider.
    provider.setStateOwner(4, false);
    consumer.setStateOwner(9, true);
    expect(provider.ownsState(4)).toBe(false);
    expect(consumer.ownsState(9)).toBe(true);
    expect(expected.map((_, index) => consumer.pageAt(9, index)))
      .toEqual(expected);
  });
});

function allocator(memory: WebAssembly.Memory) {
  let next = PAGE_SIZE;
  const allocations: Array<{ addr: number; size: number }> = [];
  const releases: Array<{ addr: number; size: number }> = [];
  return {
    allocations,
    releases,
    allocate(size: number): number {
      const addr = next;
      next += size;
      if (next > memory.buffer.byteLength) {
        memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE_SIZE));
      }
      allocations.push({ addr, size });
      return addr;
    },
    deallocate(addr: number, size: number): void {
      releases.push({ addr, size });
    },
  };
}

function cloneMemory(memory: WebAssembly.Memory): WebAssembly.Memory {
  const clone = new WebAssembly.Memory({
    initial: memory.buffer.byteLength / PAGE_SIZE,
  });
  new Uint8Array(clone.buffer).set(new Uint8Array(memory.buffer));
  return clone;
}

function uleb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function moduleWithDescriptors(...descriptors: Uint8Array[]): WebAssembly.Module {
  return moduleWithCustomSections(FORK_MODULE_STATE_SECTION, ...descriptors);
}

function moduleWithCustomSections(
  sectionName: string,
  ...descriptors: Uint8Array[]
): WebAssembly.Module {
  const name = [...new TextEncoder().encode(sectionName)];
  const sections = descriptors.flatMap((descriptor) => {
    const payload = [...uleb128(name.length), ...name, ...descriptor];
    return [0, ...uleb128(payload.length), ...payload];
  });
  return new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sections,
  ]));
}

function importedGlobalsSection(
  records: ReadonlyArray<{
    module: string;
    name: string;
    ownerId: number;
    importOrdinal?: number;
    typeCode: number;
    mutable?: boolean;
    shared?: boolean;
  }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = records.map((record, importOrdinal) => ({
    ...record,
    importOrdinal: record.importOrdinal ?? importOrdinal,
    moduleBytes: encoder.encode(record.module),
    nameBytes: encoder.encode(record.name),
  }));
  const size = WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE
    + encoded.reduce(
      (sum, record) =>
        sum
        + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
        + record.moduleBytes.byteLength
        + record.nameBytes.byteLength,
      0,
    );
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(WPK_FORK_IMPORTED_GLOBALS_MAGIC, 0);
  view.setUint16(4, WPK_FORK_IMPORTED_GLOBALS_VERSION, true);
  view.setUint16(6, WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE, true);
  view.setUint32(8, encoded.length, true);
  let offset = WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE;
  for (const record of encoded) {
    const recordSize = WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
      + record.moduleBytes.byteLength
      + record.nameBytes.byteLength;
    view.setUint32(offset, recordSize, true);
    view.setUint32(offset + 4, record.ownerId, true);
    view.setUint8(offset + 8, record.typeCode);
    view.setUint8(
      offset + 9,
      (record.mutable ? WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE : 0)
      | (record.shared ? WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED : 0),
    );
    view.setUint32(offset + 12, record.moduleBytes.byteLength, true);
    view.setUint32(offset + 16, record.nameBytes.byteLength, true);
    view.setUint32(offset + 20, record.importOrdinal, true);
    bytes.set(
      record.moduleBytes,
      offset + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
    );
    bytes.set(
      record.nameBytes,
      offset
        + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
        + record.moduleBytes.byteLength,
    );
    offset += recordSize;
  }
  return bytes;
}

function importedTablesSection(
  records: ReadonlyArray<{
    module: string;
    name: string;
    ownerId: number;
    importOrdinal?: number;
    typeCode: number;
    table64?: boolean;
  }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = records.map((record, importOrdinal) => ({
    ...record,
    importOrdinal: record.importOrdinal ?? importOrdinal,
    moduleBytes: encoder.encode(record.module),
    nameBytes: encoder.encode(record.name),
  }));
  const size = WPK_FORK_IMPORTED_TABLES_HEADER_SIZE
    + encoded.reduce(
      (sum, record) =>
        sum
        + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
        + record.moduleBytes.byteLength
        + record.nameBytes.byteLength,
      0,
    );
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(WPK_FORK_IMPORTED_TABLES_MAGIC, 0);
  view.setUint16(4, WPK_FORK_IMPORTED_TABLES_VERSION, true);
  view.setUint16(6, WPK_FORK_IMPORTED_TABLES_HEADER_SIZE, true);
  view.setUint32(8, encoded.length, true);
  let offset = WPK_FORK_IMPORTED_TABLES_HEADER_SIZE;
  for (const record of encoded) {
    const recordSize = WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
      + record.moduleBytes.byteLength
      + record.nameBytes.byteLength;
    view.setUint32(offset, recordSize, true);
    view.setUint32(offset + 4, record.ownerId, true);
    view.setUint8(offset + 8, record.typeCode);
    view.setUint8(offset + 9, record.table64 ? 1 : 0);
    view.setUint32(offset + 12, record.moduleBytes.byteLength, true);
    view.setUint32(offset + 16, record.nameBytes.byteLength, true);
    view.setUint32(offset + 20, record.importOrdinal, true);
    bytes.set(
      record.moduleBytes,
      offset + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE,
    );
    bytes.set(
      record.nameBytes,
      offset
        + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
        + record.moduleBytes.byteLength,
    );
    offset += recordSize;
  }
  return bytes;
}

function templateId(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function mutableI32(value: number): Uint8Array {
  const payload = new Uint8Array(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE + 4);
  const view = new DataView(payload.buffer);
  view.setUint8(0, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32);
  view.setUint8(1, 4);
  view.setInt32(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE, value, true);
  return payload;
}

function sparseTable(
  overrides: Partial<ForkSparseTableSnapshot> = {},
): ForkSparseTableSnapshot {
  return {
    activationId: 0,
    ownerId: 4,
    indexWidth: 4,
    pageShift: 4,
    length: 40,
    baselineLength: 16,
    baselineFingerprint: new Uint8Array(32).fill(0x5a),
    pages: [
      {
        pageIndex: 0,
        runs: [
          { start: 2, recipeIds: [10, 11] },
          { start: 8, recipeIds: new Uint32Array([12, 13, 14]) },
        ],
      },
      {
        pageIndex: 2,
        runs: [{ start: 0, recipeIds: [20, 21, 22, 23] }],
      },
    ],
    ...overrides,
  };
}

describe("fork module-state descriptor", () => {
  it.each([4, 8] as const)(
    "round-trips the exact wasm%s descriptor and custom section",
    (ptrWidth) => {
      const bytes = encodeForkModuleStateDescriptor(ptrWidth);
      expect(bytes).toHaveLength(FORK_MODULE_STATE_DESCRIPTOR_SIZE);
      expect(decodeForkModuleStateDescriptor(bytes)).toEqual({
        version: FORK_MODULE_STATE_DESCRIPTOR_VERSION,
        ptrWidth,
        alignment: 8,
        flags: FORK_MODULE_STATE_REQUIRED_FLAGS,
        arenaVersion: 1,
        recordVersion: 1,
        rootPointerWordOffset: FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
      });
      expect(readForkModuleStateDescriptor(moduleWithDescriptors(bytes))).toEqual(
        decodeForkModuleStateDescriptor(bytes),
      );
    },
  );

  it("rejects duplicate, unknown, and noncanonical descriptors", () => {
    const exact = encodeForkModuleStateDescriptor(4);
    expect(() => readForkModuleStateDescriptor(
      moduleWithDescriptors(exact, exact),
    )).toThrow("expected one kandelo.wpk_fork.module_state section, found 2");

    const unknownFlags = exact.slice();
    new DataView(unknownFlags.buffer).setUint16(
      10,
      FORK_MODULE_STATE_REQUIRED_FLAGS | 0x8000,
      true,
    );
    expect(() => decodeForkModuleStateDescriptor(unknownFlags))
      .toThrow("unknown module-state descriptor flags");

    const wrongRootWord = exact.slice();
    new DataView(wrongRootWord.buffer).setUint32(16, 2, true);
    expect(() => decodeForkModuleStateDescriptor(wrongRootWord))
      .toThrow("unsupported module-state root-pointer word offset 2");

    const reserved = exact.slice();
    new DataView(reserved.buffer).setUint32(20, 1, true);
    expect(() => decodeForkModuleStateDescriptor(reserved))
      .toThrow("reserved field is nonzero");
  });
});

describe("fork imported-global ownership", () => {
  it("parses immutable and mutable pre-instantiation recipes exactly", () => {
    const descriptor = importedGlobalsSection([
      {
        module: "callbacks",
        name: "handler",
        importOrdinal: 0,
        ownerId: 2,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
      },
      {
        module: "env",
        name: "counter",
        importOrdinal: 1,
        ownerId: 7,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
        mutable: true,
        shared: true,
      },
    ]);
    expect(readForkImportedGlobals(
      moduleWithCustomSections(WPK_FORK_IMPORTED_GLOBALS_SECTION, descriptor),
    )).toEqual([
      {
        module: "callbacks",
        name: "handler",
        importOrdinal: 0,
        ownerId: 2,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        mutable: false,
        shared: false,
      },
      {
        module: "env",
        name: "counter",
        importOrdinal: 1,
        ownerId: 7,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
        mutable: true,
        shared: true,
      },
    ]);
  });

  it("preserves repeated bindings but rejects ambiguous owners and trailing bytes", () => {
    const duplicate = importedGlobalsSection([
      {
        module: "env",
        name: "value",
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
      },
      {
        module: "env",
        name: "value",
        ownerId: 2,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
      },
    ]);
    expect(readForkImportedGlobals(
      moduleWithCustomSections(WPK_FORK_IMPORTED_GLOBALS_SECTION, duplicate),
    )).toHaveLength(2);

    const duplicateOwner = importedGlobalsSection([
      {
        module: "env",
        name: "first",
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
      },
      {
        module: "env",
        name: "second",
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
      },
    ]);
    expect(() => readForkImportedGlobals(
      moduleWithCustomSections(WPK_FORK_IMPORTED_GLOBALS_SECTION, duplicateOwner),
    )).toThrow("duplicates owner 1");

    const trailing = new Uint8Array(duplicate.byteLength + 1);
    trailing.set(importedGlobalsSection([]));
    expect(() => readForkImportedGlobals(
      moduleWithCustomSections(WPK_FORK_IMPORTED_GLOBALS_SECTION, trailing),
    )).toThrow("trailing bytes");
  });
});

describe("fork imported-table ownership", () => {
  it("parses exact import ordinals, reference classes, and table64 flags", () => {
    const descriptor = importedTablesSection([
      {
        module: "env",
        name: "dispatch",
        importOrdinal: 2,
        ownerId: 3,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
      },
      {
        module: "shared",
        name: "objects",
        importOrdinal: 7,
        ownerId: 8,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        table64: true,
      },
    ]);
    expect(readForkImportedTables(
      moduleWithCustomSections(WPK_FORK_IMPORTED_TABLES_SECTION, descriptor),
    )).toEqual([
      {
        module: "env",
        name: "dispatch",
        importOrdinal: 2,
        ownerId: 3,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        table64: false,
      },
      {
        module: "shared",
        name: "objects",
        importOrdinal: 7,
        ownerId: 8,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        table64: true,
      },
    ]);
  });

  it("rejects duplicate owners, unordered ordinals, and non-reference elements", () => {
    expect(() => readForkImportedTables(moduleWithCustomSections(
      WPK_FORK_IMPORTED_TABLES_SECTION,
      importedTablesSection([
        {
          module: "env",
          name: "a",
          importOrdinal: 1,
          ownerId: 1,
          typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        },
        {
          module: "env",
          name: "b",
          importOrdinal: 0,
          ownerId: 2,
          typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        },
      ]),
    ))).toThrow("duplicated or unordered import ordinal");
    expect(() => readForkImportedTables(moduleWithCustomSections(
      WPK_FORK_IMPORTED_TABLES_SECTION,
      importedTablesSection([
        {
          module: "env",
          name: "a",
          ownerId: 1,
          typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        },
        {
          module: "env",
          name: "b",
          ownerId: 1,
          typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        },
      ]),
    ))).toThrow("duplicates owner 1");
    expect(() => readForkImportedTables(moduleWithCustomSections(
      WPK_FORK_IMPORTED_TABLES_SECTION,
      importedTablesSection([{
        module: "env",
        name: "bad",
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
      }]),
    ))).toThrow("unknown element type");
  });
});

describe("fork tail replay manifest", () => {
  it("round-trips commit order and exposes reverse replay order", () => {
    const events = [
      { activationId: 0, functionOrdinal: 9 },
      { activationId: 4, functionOrdinal: 3 },
      { activationId: 4, functionOrdinal: 3 },
    ];
    const memory = new WebAssembly.Memory({ initial: 3 });
    const arenaAllocator = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "tail-events",
    );
    arena.begin();
    arena.appendModule({ activationId: 2, templateId: templateId(2) });
    arena.appendModule({ activationId: 4, templateId: templateId(4) });
    arena.appendReplayEvents(replayEventCapture(events));
    arena.seal();
    const replay = new ForkReplayEventJournal();
    replay.attachChild(replayEventsForChild(arena.recordViews()));
    for (const event of [...events].reverse()) {
      expect(replay.peek()).toEqual(event);
      replay.consume(event.activationId, event.functionOrdinal);
    }
    replay.finishReplay();
    arena.release();
  });

  it("requires at most one process-owned manifest", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const arenaAllocator = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "duplicate-tail-events",
    );
    arena.begin();
    arena.appendModule({ activationId: 1, templateId: templateId(1) });
    const empty = replayEventCapture([]);
    arena.appendReplayEvents(empty);
    arena.appendReplayEvents(empty);
    expect(() => arena.seal()).toThrow("duplicate process replay-event record");
    arena.release();
  });

  it("requires every ordered segment to precede the final manifest", () => {
    const records = replayEventRecords([
      { activationId: 0, functionOrdinal: 1 },
    ]);
    expect(() => replayEventsForChild([...records].reverse()))
      .toThrow("segment follows its final manifest");
    expect(() => replayEventsForChild(records.slice(0, -1)))
      .toThrow("no process replay-event manifest");
  });
});

describe("fork imported-global binding manifest", () => {
  const bindings = [
    {
      consumerActivation: 1,
      consumerOwner: 1,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      recipeId: 0,
      rawBits: 0x7ff8_0000_0000_0042n,
      kind: ForkImportedGlobalBindingKind.RawNumber,
      mutable: false,
      shared: false,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
    },
    {
      consumerActivation: 1,
      consumerOwner: 2,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      recipeId: 0,
      rawBits: 0xffff_ffff_ffff_fffen,
      kind: ForkImportedGlobalBindingKind.RawBigInt,
      mutable: false,
      shared: false,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
    },
    {
      consumerActivation: 2,
      consumerOwner: 1,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      recipeId: 17,
      rawBits: 0n,
      kind: ForkImportedGlobalBindingKind.RawReference,
      mutable: false,
      shared: false,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
    },
    {
      consumerActivation: 2,
      consumerOwner: 2,
      sourceActivation: 7,
      sourceOwner: 4,
      reserved: 0,
      recipeId: 0,
      rawBits: 0n,
      kind: ForkImportedGlobalBindingKind.ActivationGlobal,
      mutable: true,
      shared: false,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
    },
    {
      consumerActivation: 3,
      consumerOwner: 1,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      recipeId: 0,
      rawBits: 0n,
      kind: ForkImportedGlobalBindingKind.BaseImport,
      mutable: true,
      shared: true,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    },
  ] as const;

  it("round-trips every deterministic provider kind with exact scalar bits", () => {
    expect(decodeForkImportedGlobalBindings(
      encodeForkImportedGlobalBindings(bindings),
    )).toEqual(bindings);
  });

  it("rejects duplicate declarations, inconsistent owners, and reserved bytes", () => {
    expect(() => encodeForkImportedGlobalBindings([
      bindings[0],
      bindings[0],
    ])).toThrow("unique and strictly ordered");
    expect(() => encodeForkImportedGlobalBindings([{
      ...bindings[3],
      sourceOwner: 0,
    }])).toThrow("activation-global binding fields are inconsistent");

    const wire = encodeForkImportedGlobalBindings(bindings);
    wire[24 + 35] = 1;
    expect(() => decodeForkImportedGlobalBindings(wire))
      .toThrow("reserved fields are nonzero");
  });
});

describe("fork imported-table binding manifest", () => {
  const bindings = [
    {
      consumerActivation: 1,
      consumerOwner: 2,
      sourceActivation: 4,
      sourceOwner: 3,
      reserved: 0,
      kind: ForkImportedTableBindingKind.ActivationTable,
    },
    {
      consumerActivation: 7,
      consumerOwner: 1,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      kind: ForkImportedTableBindingKind.BaseImport,
    },
  ] as const;

  it("round-trips activation and base-import table identities", () => {
    expect(decodeForkImportedTableBindings(
      encodeForkImportedTableBindings(bindings),
    )).toEqual(bindings);
  });

  it("rejects duplicate consumers, inconsistent owners, and reserved bytes", () => {
    expect(() => encodeForkImportedTableBindings([
      bindings[0],
      bindings[0],
    ])).toThrow("unique and strictly ordered");
    expect(() => encodeForkImportedTableBindings([{
      ...bindings[0],
      sourceOwner: 0,
    }])).toThrow("activation-table binding fields are inconsistent");
    expect(() => encodeForkImportedTableBindings([{
      ...bindings[1],
      sourceActivation: 1,
    }])).toThrow("base-import binding fields are inconsistent");

    const wire = encodeForkImportedTableBindings(bindings);
    wire[24 + 21] = 1;
    expect(() => decodeForkImportedTableBindings(wire))
      .toThrow("reserved fields are nonzero");
  });
});

describe("fork activation-continuation manifest", () => {
  const continuations = [
    { activationId: 0, root: 0x1_0000n },
    { activationId: 7, root: 0x1_0000_0040n },
  ] as const;
  const events = [
    { activationId: 0, functionOrdinal: 3 },
    { activationId: 7, functionOrdinal: 11 },
    { activationId: 7, functionOrdinal: 9 },
  ] as const;

  it("round-trips sorted nonzero u64 roots and checks the exact replay set", () => {
    const payload = encodeForkActivationContinuations(continuations);
    expect(decodeForkActivationContinuations(payload)).toEqual(continuations);
    const records = [
      ...replayEventRecords(events),
      {
        kind: ForkModuleStateRecordKind.ActivationContinuations,
        activationId: 0,
        ownerId: 3,
        payload,
      },
    ];
    expect(activationContinuationsForChild(records, 8)).toEqual(continuations);
    expect(() => activationContinuationsForChild(records, 4))
      .toThrow("does not fit wasm32");
  });

  it("accepts side-only stacks and rejects empty, zero, unordered, or drifted manifests", () => {
    expect(decodeForkActivationContinuations(
      encodeForkActivationContinuations([
        { activationId: 7, root: 1n },
      ]),
    )).toEqual([{ activationId: 7, root: 1n }]);
    expect(() => encodeForkActivationContinuations([]))
      .toThrow("must not be empty");
    expect(() => encodeForkActivationContinuations([
      { activationId: 0, root: 0n },
    ])).toThrow("root is zero");
    expect(() => encodeForkActivationContinuations([
      continuations[1],
      continuations[0],
    ])).toThrow("strictly ordered");

    const zeroRoot = encodeForkActivationContinuations(continuations);
    zeroRoot.fill(
      0,
      WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE + 8,
      WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE + 16,
    );
    expect(() => decodeForkActivationContinuations(zeroRoot))
      .toThrow("continuation root is zero");

    const records = [
      ...replayEventRecords(events.slice(0, 1)),
      {
        kind: ForkModuleStateRecordKind.ActivationContinuations,
        activationId: 0,
        ownerId: 3,
        payload: encodeForkActivationContinuations(continuations),
      },
    ];
    expect(() => activationContinuationsForChild(records, 8))
      .toThrow("does not exactly match replay events");
  });

  it("seals only manifests whose active roots have module descriptors", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const owner = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      8,
      owner.allocate,
      owner.deallocate,
      "activation-continuations",
    );
    arena.begin();
    arena.appendModule({ activationId: 0, templateId: templateId(1) });
    arena.appendModule({ activationId: 7, templateId: templateId(7) });
    arena.appendReplayEvents(replayEventCapture(events));
    arena.appendActivationContinuations(continuations);
    expect(() => arena.seal()).not.toThrow();
    expect(activationContinuationsForChild(arena.records(), 8))
      .toEqual(continuations);
    arena.release();
  });
});

describe("module-state root-prefix ownership", () => {
  it.each([4, 8] as const)(
    "stores a wasm%s arena root in the reserved +P word and supports clearing it",
    (ptrWidth) => {
      const memory = new WebAssembly.Memory({ initial: 2 });
      const moduleBuffer = 256;
      writeForkModuleStateRoot(memory, moduleBuffer, ptrWidth, PAGE_SIZE);
      expect(readForkModuleStateRoot(memory, moduleBuffer, ptrWidth)).toBe(PAGE_SIZE);

      const view = new DataView(memory.buffer);
      const slot = moduleBuffer + ptrWidth;
      expect(
        ptrWidth === 8
          ? view.getBigUint64(slot, true)
          : BigInt(view.getUint32(slot, true)),
      ).toBe(BigInt(PAGE_SIZE));

      writeForkModuleStateRoot(memory, moduleBuffer, ptrWidth, 0);
      expect(readForkModuleStateRoot(memory, moduleBuffer, ptrWidth)).toBe(0);
    },
  );

  it("rejects roots that cannot own page-aligned arena mappings", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(() => writeForkModuleStateRoot(memory, 128, 4, 1234))
      .toThrow("arena root must be page-aligned");
  });
});

describe("ForkModuleStateArena", () => {
  it.each([4, 8] as const)(
    "streams, validates, clones, and releases typed wasm%s state",
    (ptrWidth) => {
      const parentMemory = new WebAssembly.Memory({ initial: 4 });
      const parentAllocator = allocator(parentMemory);
      const parent = new ForkModuleStateArena(
        parentMemory,
        ptrWidth,
        parentAllocator.allocate,
        parentAllocator.deallocate,
        `parent-wasm${ptrWidth * 8}`,
      );
      const root = parent.begin();
      parent.appendModule({
        activationId: 0,
        templateId: templateId(0xa0),
      });
      parent.appendRecord({
        kind: ForkModuleStateRecordKind.ReferenceRecipe,
        activationId: 0,
        ownerId: 1,
        payload: new Uint8Array(70_000).fill(0x91),
      });
      parent.appendRecord({
        kind: ForkModuleStateRecordKind.MutableGlobal,
        activationId: 0,
        ownerId: 2,
        payload: mutableI32(0x0908_0706),
      });
      parent.appendElementSegmentState({
        activationId: 0,
        ownerId: 3,
        segmentCount: 10,
        dropped: new Uint8Array([0b0101_0101, 0b0000_0010]),
      });
      parent.appendDataSegmentState({
        activationId: 0,
        ownerId: 5,
        segmentCount: 3,
        dropped: new Uint8Array([0b0000_0101]),
      });
      parent.appendSparseTable(sparseTable({
        indexWidth: ptrWidth,
        length: ptrWidth === 8 ? 40n : 40,
      }));
      parent.seal();
      expect(parentAllocator.allocations.length).toBeGreaterThan(1);

      const moduleBuffer = 512;
      writeForkModuleStateRoot(parentMemory, moduleBuffer, ptrWidth, root);
      const childMemory = cloneMemory(parentMemory);

      const parentRecords = parent.records();
      expect(parentRecords.map(({ kind, ownerId }) => [kind, ownerId])).toEqual([
        [ForkModuleStateRecordKind.Module, 0],
        [ForkModuleStateRecordKind.ReferenceRecipe, 1],
        [ForkModuleStateRecordKind.MutableGlobal, 2],
        [ForkModuleStateRecordKind.ElementSegments, 3],
        [ForkModuleStateRecordKind.DataSegments, 5],
        [ForkModuleStateRecordKind.Table, 4],
        [ForkModuleStateRecordKind.TablePage, 4],
        [ForkModuleStateRecordKind.TablePage, 4],
      ]);
      expect(parentRecords[1]!.payload[0]).toBe(0x91);
      expect(parentRecords[1]!.payload.at(-1)).toBe(0x91);
      const parentGlobalPayload = parent.findRecord(
        ForkModuleStateRecordKind.MutableGlobal,
        0,
        2,
        0,
      );
      expect(typeof parentGlobalPayload).toBe(ptrWidth === 8 ? "bigint" : "number");
      expect(
        new Uint8Array(
          parentMemory.buffer,
          Number(parentGlobalPayload),
          WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE + 4,
        ),
      ).toEqual(mutableI32(0x0908_0706));

      const childReleases: Array<{ addr: number; size: number }> = [];
      const child = new ForkModuleStateArena(
        childMemory,
        ptrWidth,
        () => { throw new Error("attached arena must not allocate"); },
        (addr, size) => childReleases.push({ addr, size }),
        `child-wasm${ptrWidth * 8}`,
      );
      child.attach(readForkModuleStateRoot(childMemory, moduleBuffer, ptrWidth));
      expect(child.records()).toEqual(parentRecords);
      const childGlobalPayload = child.findRecord(
        ForkModuleStateRecordKind.MutableGlobal,
        0,
        2,
        0,
      );
      expect(
        new Uint8Array(
          childMemory.buffer,
          Number(childGlobalPayload),
          WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE + 4,
        ),
      ).toEqual(mutableI32(0x0908_0706));
      expect(() => child.findRecord(
        ForkModuleStateRecordKind.MutableGlobal,
        0,
        2,
        1,
      )).toThrow("missing module-state record");
      expect(child.sparseTables()).toEqual([
        {
          activationId: 0,
          ownerId: 4,
          indexWidth: ptrWidth,
          pageShift: 4,
          length: 40n,
          baselineLength: 16n,
          baselineFingerprint: new Uint8Array(32).fill(0x5a),
          pages: [
            {
              pageIndex: 0n,
              runs: [
                { start: 2, recipeIds: new Uint32Array([10, 11]) },
                { start: 8, recipeIds: new Uint32Array([12, 13, 14]) },
              ],
            },
            {
              pageIndex: 2n,
              runs: [
                { start: 0, recipeIds: new Uint32Array([20, 21, 22, 23]) },
              ],
            },
          ],
        },
      ]);

      child.release();
      expect(child.hasActiveArena()).toBe(false);
      expect(childReleases).toEqual([...parentAllocator.allocations].reverse());

      parent.release();
      expect(parentAllocator.releases).toEqual(
        [...parentAllocator.allocations].reverse(),
      );
    },
  );

  it("rejects ownership ambiguity and undeclared activation state before sealing", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const arenaAllocator = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "ambiguous",
    );
    arena.begin();
    arena.appendModule({ activationId: 0, templateId: templateId(1) });
    arena.appendRecord({
      kind: ForkModuleStateRecordKind.MutableGlobal,
      activationId: 0,
      ownerId: 8,
      payload: mutableI32(1),
    });
    arena.appendRecord({
      kind: ForkModuleStateRecordKind.MutableGlobal,
      activationId: 0,
      ownerId: 8,
      payload: mutableI32(2),
    });
    expect(() => arena.seal()).toThrow("duplicate owner 8");
    expect(arena.hasActiveArena()).toBe(true);
    arena.release();

    const second = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "undeclared",
    );
    second.begin();
    second.appendRecord({
      kind: ForkModuleStateRecordKind.ReferenceRecipe,
      activationId: 99,
      ownerId: 1,
      payload: new Uint8Array(),
    });
    expect(() => second.seal()).toThrow("undeclared module activation 99");
    second.release();
  });

  it.each([4, 8] as const)(
    "publishes wasm%s guest-written records only after their exact reservation commits",
    (ptrWidth) => {
      const memory = new WebAssembly.Memory({ initial: 3 });
      const arenaAllocator = allocator(memory);
      const arena = new ForkModuleStateArena(
        memory,
        ptrWidth,
        arenaAllocator.allocate,
        arenaAllocator.deallocate,
        `transactional-wasm${ptrWidth * 8}`,
      );
      arena.begin();
      arena.appendModule({ activationId: 0, templateId: templateId(6) });
      const payload = arena.reserveRecord(
        ForkModuleStateRecordKind.MutableGlobal,
        0,
        7,
        ptrWidth === 8 ? 12n : 12,
      );
      expect(typeof payload).toBe(ptrWidth === 8 ? "bigint" : "number");
      new Uint8Array(memory.buffer, Number(payload), 12).set(mutableI32(0x0907_0503));
      expect(() => arena.seal()).toThrow("pending module-state record");
      expect(() => arena.commitRecord(Number(payload) + 8))
        .toThrow("does not match reservation");
      arena.commitRecord(payload);
      arena.seal();
      expect(arena.records().at(-1)).toEqual({
        kind: ForkModuleStateRecordKind.MutableGlobal,
        activationId: 0,
        ownerId: 7,
        payload: mutableI32(0x0907_0503),
      });
      arena.release();
    },
  );

  it("rejects sparse pages that are unordered, overlapping, or outside final length", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const arenaAllocator = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "bad-sparse-table",
    );
    arena.begin();
    arena.appendModule({ activationId: 0, templateId: templateId(2) });

    expect(() => arena.appendSparseTable(sparseTable({
      pages: [{
        pageIndex: 0,
        runs: [
          { start: 4, recipeIds: [1, 2] },
          { start: 5, recipeIds: [3] },
        ],
      }],
    }))).toThrow("unordered or out of bounds");
    arena.release();
  });

  it("rejects tampered sparse page counts during fresh-instance attachment", () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const arenaAllocator = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "table-count-parent",
    );
    const root = arena.begin();
    arena.appendModule({ activationId: 0, templateId: templateId(3) });
    arena.appendSparseTable(sparseTable({ pages: [sparseTable().pages[0]!] }));
    arena.seal();

    // wasm32 chunk header is 40 bytes. The module record occupies 64 bytes;
    // the following table record's payload begins after its 24-byte TLV header.
    const tablePayload = root + 40 + 64 + 24;
    new DataView(memory.buffer).setUint32(tablePayload + 4, 2, true);
    const releases: Array<{ addr: number; size: number }> = [];
    const child = new ForkModuleStateArena(
      cloneMemory(memory),
      4,
      () => { throw new Error("attachment must not allocate"); },
      (addr, size) => releases.push({ addr, size }),
      "table-count-child",
    );
    expect(() => child.attach(root)).toThrow("declares 2 sparse pages, found 1");
    expect(child.hasActiveArena()).toBe(false);
    expect(releases).toEqual([]);
    arena.release();
  });

  it("does not adopt or release unsealed or malformed guest arenas", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const arenaAllocator = allocator(memory);
    const parent = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "unsealed-parent",
    );
    const root = parent.begin();
    parent.appendModule({ activationId: 0, templateId: templateId(4) });
    const childReleases: Array<{ addr: number; size: number }> = [];
    const unsealedChild = new ForkModuleStateArena(
      cloneMemory(memory),
      4,
      () => { throw new Error("attachment must not allocate"); },
      (addr, size) => childReleases.push({ addr, size }),
      "unsealed-child",
    );
    expect(() => unsealedChild.attach(root)).toThrow("invalid or unsealed");
    expect(childReleases).toEqual([]);

    parent.seal();
    // Record kind is at root + wasm32 chunk header + 6.
    new DataView(memory.buffer).setUint16(root + 40 + 6, 0xffff, true);
    const malformedChild = new ForkModuleStateArena(
      cloneMemory(memory),
      4,
      () => { throw new Error("attachment must not allocate"); },
      (addr, size) => childReleases.push({ addr, size }),
      "malformed-child",
    );
    expect(() => malformedChild.attach(root)).toThrow("invalid record header");
    expect(malformedChild.hasActiveArena()).toBe(false);
    expect(childReleases).toEqual([]);
    parent.release();
  });

  it("rejects a copied multi-chunk cycle without adopting forged ownership", () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const arenaAllocator = allocator(memory);
    const parent = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "cycle-parent",
    );
    const root = parent.begin();
    parent.appendModule({ activationId: 0, templateId: templateId(7) });
    parent.appendRecord({
      kind: ForkModuleStateRecordKind.ReferenceRecipe,
      activationId: 0,
      ownerId: 1,
      payload: new Uint8Array(70_000),
    });
    parent.seal();
    expect(arenaAllocator.allocations).toHaveLength(2);
    const tail = arenaAllocator.allocations[1]!.addr;
    // wasm32 chunk next pointer is at +8 + 2P.
    new DataView(memory.buffer).setUint32(tail + 16, root, true);

    const releases: Array<{ addr: number; size: number }> = [];
    const child = new ForkModuleStateArena(
      cloneMemory(memory),
      4,
      () => { throw new Error("attachment must not allocate"); },
      (addr, size) => releases.push({ addr, size }),
      "cycle-child",
    );
    expect(() => child.attach(root)).toThrow("module-state chunk cycle");
    expect(child.hasActiveArena()).toBe(false);
    expect(releases).toEqual([]);
    parent.release();
  });

  it("drops ownership before reporting cleanup failure", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const arenaAllocator = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      () => { throw new Error("synthetic munmap failure"); },
      "release-failure",
    );
    arena.begin();
    arena.appendModule({ activationId: 0, templateId: templateId(5) });
    arena.seal();
    expect(() => arena.release()).toThrow("synthetic munmap failure");
    expect(arena.hasActiveArena()).toBe(false);
    expect(arena.isSealed()).toBe(false);
  });

  it("releases an uncommitted guest reservation during abort cleanup", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const arenaAllocator = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      arenaAllocator.allocate,
      arenaAllocator.deallocate,
      "pending-abort",
    );
    arena.begin();
    arena.appendModule({ activationId: 0, templateId: templateId(8) });
    arena.reserveRecord(
      ForkModuleStateRecordKind.ReferenceRecipe,
      0,
      1,
      128,
    );
    arena.release();
    expect(arena.hasActiveArena()).toBe(false);
    expect(arenaAllocator.releases).toEqual(
      [...arenaAllocator.allocations].reverse(),
    );
  });
});
