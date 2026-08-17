import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ForkImportedGlobalCapture,
  ForkImportedGlobalPlanner,
  type ForkImportedReferenceProvider,
  type ForkWasmImports,
} from "../src/fork-imported-globals";
import {
  decodeForkImportedTableBindings,
  ForkImportedGlobalBindingKind,
  ForkImportedTableBindingKind,
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
  ForkTableDirtyTracker,
} from "../src/fork-module-state";
import {
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
  WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
} from "../src/generated/abi";

const PAGE_SIZE = 65_536;

function uleb128(value: number): number[] {
  const result: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    result.push(byte);
  } while (value !== 0);
  return result;
}

function importedGlobalsSection(
  records: ReadonlyArray<{
    module: string;
    name: string;
    importOrdinal?: number;
    ownerId: number;
    typeCode: number;
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
        sum + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
        + record.moduleBytes.byteLength + record.nameBytes.byteLength,
      0,
    );
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(WPK_FORK_IMPORTED_GLOBALS_MAGIC);
  view.setUint16(4, WPK_FORK_IMPORTED_GLOBALS_VERSION, true);
  view.setUint16(6, WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE, true);
  view.setUint32(8, encoded.length, true);
  let offset = WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE;
  for (const record of encoded) {
    const recordSize = WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
      + record.moduleBytes.byteLength + record.nameBytes.byteLength;
    view.setUint32(offset, recordSize, true);
    view.setUint32(offset + 4, record.ownerId, true);
    view.setUint8(offset + 8, record.typeCode);
    view.setUint32(offset + 12, record.moduleBytes.byteLength, true);
    view.setUint32(offset + 16, record.nameBytes.byteLength, true);
    view.setUint32(offset + 20, record.importOrdinal, true);
    bytes.set(
      record.moduleBytes,
      offset + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
    );
    bytes.set(
      record.nameBytes,
      offset + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
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
    importOrdinal?: number;
    ownerId: number;
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
        sum + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
        + record.moduleBytes.byteLength + record.nameBytes.byteLength,
      0,
    );
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(WPK_FORK_IMPORTED_TABLES_MAGIC);
  view.setUint16(4, WPK_FORK_IMPORTED_TABLES_VERSION, true);
  view.setUint16(6, WPK_FORK_IMPORTED_TABLES_HEADER_SIZE, true);
  view.setUint32(8, encoded.length, true);
  let offset = WPK_FORK_IMPORTED_TABLES_HEADER_SIZE;
  for (const record of encoded) {
    const recordSize = WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
      + record.moduleBytes.byteLength + record.nameBytes.byteLength;
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
      offset + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
        + record.moduleBytes.byteLength,
    );
    offset += recordSize;
  }
  return bytes;
}

function appendCustomSection(
  wasm: Uint8Array,
  name: string,
  data: Uint8Array,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const payload = new Uint8Array(
    uleb128(nameBytes.byteLength).length + nameBytes.byteLength + data.byteLength,
  );
  const nameLength = uleb128(nameBytes.byteLength);
  payload.set(nameLength);
  payload.set(nameBytes, nameLength.length);
  payload.set(data, nameLength.length + nameBytes.byteLength);
  const sectionSize = uleb128(payload.byteLength);
  const result = new Uint8Array(wasm.byteLength + 1 + sectionSize.length + payload.byteLength);
  result.set(wasm);
  let offset = wasm.byteLength;
  result[offset++] = 0;
  result.set(sectionSize, offset);
  offset += sectionSize.length;
  result.set(payload, offset);
  return result;
}

function compileModule(
  wat: string,
  descriptor: Uint8Array,
  tableDescriptor = importedTablesSection([]),
): WebAssembly.Module {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-imported-globals-"));
  try {
    const watPath = join(directory, "fixture.wat");
    const wasmPath = join(directory, "fixture.wasm");
    writeFileSync(watPath, wat);
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      watPath,
      "-o",
      wasmPath,
    ]);
    const withGlobals = appendCustomSection(
      readFileSync(wasmPath),
      WPK_FORK_IMPORTED_GLOBALS_SECTION,
      descriptor,
    );
    const bytes = appendCustomSection(
      withGlobals,
      WPK_FORK_IMPORTED_TABLES_SECTION,
      tableDescriptor,
    );
    // Node Buffers are typed as ArrayBufferLike, while the WebAssembly
    // constructor correctly requires an owned, non-shared BufferSource.
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    return new WebAssembly.Module(owned);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function allocator(memory: WebAssembly.Memory) {
  let next = PAGE_SIZE;
  return {
    allocate(size: number): number {
      const address = next;
      next += Math.ceil(size / 8) * 8;
      if (next > memory.buffer.byteLength) {
        memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE_SIZE));
      }
      return address;
    },
    deallocate(): void {},
  };
}

function referenceGlobal(typeCode: number, recipeId: number): Uint8Array {
  const payload = new Uint8Array(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE + 4);
  const view = new DataView(payload.buffer);
  view.setUint8(0, typeCode);
  view.setUint8(1, 4);
  view.setUint32(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE, recipeId, true);
  return payload;
}

describe("fork imported-global provider planning", () => {
  it("rebinds fresh funcref/externref/exnref providers before const initialization", () => {
    const providerModule = compileModule(
      `(module
        (func (export "callback") (result i32) i32.const 73)
        (global (export "__wpk_fork_global_1") exnref (ref.null exn)))`,
      importedGlobalsSection([]),
    );
    const descriptors = [
      {
        module: "provider",
        name: "callback",
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
      },
      {
        module: "provider",
        name: "token",
        ownerId: 2,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
      },
      {
        module: "provider",
        name: "exception",
        ownerId: 3,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
      },
    ] as const;
    const consumerModule = compileModule(
      `(module
        (import "provider" "callback" (global $callback funcref))
        (import "provider" "token" (global $token externref))
        (import "provider" "exception" (global $exception exnref))
        (global $callback_alias funcref (global.get $callback))
        (global $token_alias externref (global.get $token))
        (global $exception_alias exnref (global.get $exception))
        (export "__wpk_fork_global_1" (global $callback))
        (export "__wpk_fork_global_2" (global $token))
        (export "__wpk_fork_global_3" (global $exception))
        (export "callback_global" (global $callback))
        (export "callback_alias" (global $callback_alias))
        (export "token_global" (global $token))
        (export "token_alias" (global $token_alias))
        (export "exception_global" (global $exception))
        (export "exception_alias" (global $exception_alias)))`,
      importedGlobalsSection(descriptors),
    );

    const parentToken = Object.freeze({ generation: "parent" });
    const capture = new ForkImportedGlobalCapture("parent imported globals");
    const preparedProvider = capture.prepareActivation(1, providerModule, {});
    // Use the wrapped imports for the real instantiation boundary even though
    // this provider has no imported globals.
    const capturedParentProvider = new WebAssembly.Instance(
      providerModule,
      preparedProvider.imports as WebAssembly.Imports,
    );
    preparedProvider.complete(capturedParentProvider);
    const parentProvider = capturedParentProvider;
    const preparedConsumer = capture.prepareActivation(2, consumerModule, {
      provider: {
        callback: parentProvider.exports.callback,
        token: parentToken,
        exception: parentProvider.exports.__wpk_fork_global_1,
      },
    });
    const parentConsumer = new WebAssembly.Instance(
      consumerModule,
      preparedConsumer.imports as WebAssembly.Imports,
    );
    preparedConsumer.complete(parentConsumer);

    const memory = new WebAssembly.Memory({ initial: 4 });
    const allocations = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      allocations.allocate,
      allocations.deallocate,
      "imported-global capture",
    );
    arena.begin();
    arena.appendModule({ activationId: 1, templateId: new Uint8Array(32).fill(1) });
    arena.appendModule({ activationId: 2, templateId: new Uint8Array(32).fill(2) });
    for (const [ownerId, typeCode, recipeId] of [
      [1, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF, 1],
      [2, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF, 2],
      [3, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF, 0],
    ] as const) {
      arena.appendRecord({
        kind: ForkModuleStateRecordKind.MutableGlobal,
        activationId: 2,
        ownerId,
        payload: referenceGlobal(typeCode, recipeId),
      });
    }
    const capturedBindings = capture.appendTo(arena);
    expect(capturedBindings.map((binding) => binding.kind)).toEqual([
      ForkImportedGlobalBindingKind.RawReference,
      ForkImportedGlobalBindingKind.RawReference,
      ForkImportedGlobalBindingKind.ActivationGlobal,
    ]);
    expect(capturedBindings[2]).toMatchObject({
      sourceActivation: 1,
      sourceOwner: 1,
    });
    arena.seal();

    const childInstances = new Map<number, WebAssembly.Instance>();
    const childToken = Object.freeze({ generation: "child" });
    const references: ForkImportedReferenceProvider = {
      ownerActivation(recipeId) {
        return recipeId === 1 ? 1 : null;
      },
      materialize(recipeId) {
        if (recipeId === 1) return childInstances.get(1)!.exports.callback;
        if (recipeId === 2) return childToken;
        throw new Error(`unknown test recipe ${recipeId}`);
      },
    };
    const planner = new ForkImportedGlobalPlanner(
      arena.records(),
      new Map([
        [1, providerModule],
        [2, consumerModule],
      ]),
      references,
      "child imported globals",
    );
    expect(planner.instantiationOrder()).toEqual([1, 2]);
    for (const activationId of planner.instantiationOrder()) {
      const module = activationId === 1 ? providerModule : consumerModule;
      const imports = planner.importsForActivation(activationId, {});
      const instance = new WebAssembly.Instance(
        module,
        imports as WebAssembly.Imports,
      );
      childInstances.set(activationId, instance);
      planner.registerInstance(activationId, instance);
    }

    const childProvider = childInstances.get(1)!;
    const childConsumer = childInstances.get(2)!;
    expect(childProvider.exports.callback).not.toBe(parentProvider.exports.callback);
    expect(childConsumer.exports.callback_global).toBeInstanceOf(WebAssembly.Global);
    expect((childConsumer.exports.callback_global as WebAssembly.Global).value)
      .toBe(childProvider.exports.callback);
    expect((childConsumer.exports.callback_alias as WebAssembly.Global).value)
      .toBe(childProvider.exports.callback);
    expect((childConsumer.exports.token_global as WebAssembly.Global).value)
      .toBe(childToken);
    expect((childConsumer.exports.token_alias as WebAssembly.Global).value)
      .toBe(childToken);
    expect(childToken).not.toBe(parentToken);
    expect(childConsumer.exports.exception_global)
      .toBe(childProvider.exports.__wpk_fork_global_1);
    // The alias is a distinct immutable Global cell initialized from the exact
    // provider exnref. JavaScript cannot read exnref values, which is precisely
    // why the provider Global wrapper is the pre-instantiation transport.
    expect(childConsumer.exports.exception_alias)
      .toBeInstanceOf(WebAssembly.Global);
    expect(() => (childConsumer.exports.exception_alias as WebAssembly.Global).value)
      .toThrow();
  });

  it("rebinds an imported mutable table to its activation owner before restore", () => {
    const providerModule = compileModule(
      `(module
        (type $callback (func (result i32)))
        (func $initial (type $callback) (result i32) i32.const 11)
        (func $mutated (type $callback) (result i32) i32.const 22)
        (table $dispatch 2 funcref)
        (elem (i32.const 0) $initial)
        (export "__wpk_fork_table_1" (table $dispatch))
        (export "mutated" (func $mutated)))`,
      importedGlobalsSection([]),
    );
    const consumerModule = compileModule(
      `(module
        (type $callback (func (result i32)))
        (import "provider" "dispatch" (table $dispatch 2 funcref))
        (export "__wpk_fork_table_1" (table $dispatch))
        (func (export "call") (result i32)
          i32.const 0
          call_indirect (type $callback)))`,
      importedGlobalsSection([]),
      importedTablesSection([{
        module: "provider",
        name: "dispatch",
        importOrdinal: 0,
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
      }]),
    );

    const capture = new ForkImportedGlobalCapture("parent imported tables");
    const preparedProvider = capture.prepareActivation(1, providerModule, {});
    const parentProvider = new WebAssembly.Instance(
      providerModule,
      preparedProvider.imports as WebAssembly.Imports,
    );
    preparedProvider.complete(parentProvider);
    const preparedConsumer = capture.prepareActivation(2, consumerModule, {
      provider: { dispatch: parentProvider.exports.__wpk_fork_table_1 },
    });
    const parentConsumer = new WebAssembly.Instance(
      consumerModule,
      preparedConsumer.imports as WebAssembly.Imports,
    );
    preparedConsumer.complete(parentConsumer);

    const memory = new WebAssembly.Memory({ initial: 4 });
    const allocations = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      allocations.allocate,
      allocations.deallocate,
      "imported-table capture",
    );
    arena.begin();
    arena.appendModule({ activationId: 1, templateId: new Uint8Array(32).fill(1) });
    arena.appendModule({ activationId: 2, templateId: new Uint8Array(32).fill(2) });
    capture.appendTo(arena);
    const tableRecord = arena.recordsForCapture().find(
      (record) => record.kind === ForkModuleStateRecordKind.ImportedTableBindings,
    )!;
    expect(decodeForkImportedTableBindings(tableRecord.payload)).toEqual([{
      consumerActivation: 2,
      consumerOwner: 1,
      sourceActivation: 1,
      sourceOwner: 1,
      reserved: 0,
      kind: ForkImportedTableBindingKind.ActivationTable,
    }]);
    arena.seal();

    const planner = new ForkImportedGlobalPlanner(
      arena.records(),
      new Map([[1, providerModule], [2, consumerModule]]),
      {
        ownerActivation: () => null,
        materialize: () => null,
      },
      "child imported tables",
    );
    expect(planner.instantiationOrder()).toEqual([1, 2]);
    const children = new Map<number, WebAssembly.Instance>();
    for (const activationId of planner.instantiationOrder()) {
      const module = activationId === 1 ? providerModule : consumerModule;
      const instance = new WebAssembly.Instance(
        module,
        planner.importsForActivation(activationId, {}) as WebAssembly.Imports,
      );
      children.set(activationId, instance);
      planner.registerInstance(activationId, instance);
    }
    const childProvider = children.get(1)!;
    const childConsumer = children.get(2)!;
    expect(childConsumer.exports.__wpk_fork_table_1)
      .toBe(childProvider.exports.__wpk_fork_table_1);
    expect((childConsumer.exports.call as () => number)()).toBe(11);

    // KFMS restores table overrides through the consumer's imported alias.
    // Exercising the same identity here proves the mutation is immediately
    // visible to continuation code after the restore phase.
    (childProvider.exports.__wpk_fork_table_1 as WebAssembly.Table).set(
      0,
      childProvider.exports.mutated,
    );
    expect((childConsumer.exports.call as () => number)()).toBe(22);
  });

  it("re-resolves one fresh base-import table for every captured alias", () => {
    const module = compileModule(
      `(module
        (import "host" "dispatch" (table $dispatch 1 4 funcref))
        (export "__wpk_fork_table_1" (table $dispatch)))`,
      importedGlobalsSection([]),
      importedTablesSection([{
        module: "host",
        name: "dispatch",
        importOrdinal: 0,
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
      }]),
    );
    const parentTable = new WebAssembly.Table({
      element: "anyfunc",
      initial: 1,
      maximum: 4,
    });
    const capture = new ForkImportedGlobalCapture("base table parent");
    for (const activationId of [1, 2]) {
      const prepared = capture.prepareActivation(activationId, module, {
        host: { dispatch: parentTable },
      });
      const instance = new WebAssembly.Instance(
        module,
        prepared.imports as WebAssembly.Imports,
      );
      prepared.complete(instance);
    }
    const parentTrackers = new Map([
      [1, new ForkTableDirtyTracker()],
      [2, new ForkTableDirtyTracker()],
    ]);
    parentTrackers.get(1)!.markPages(1, 2n, 1n);
    parentTrackers.get(2)!.markPages(1, 7n, 1n);
    capture.bindTableDirtyTrackers(parentTrackers);
    expect(parentTrackers.get(1)!.ownsState(1)).toBe(true);
    expect(parentTrackers.get(2)!.ownsState(1)).toBe(false);
    parentTrackers.get(1)!.markPages(1, 11n, 1n);
    expect(
      [0, 1, 2].map((ordinal) =>
        parentTrackers.get(2)!.pageAt(1, ordinal)
      ),
    ).toEqual([2n, 7n, 11n]);

    const memory = new WebAssembly.Memory({ initial: 4 });
    const allocations = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      allocations.allocate,
      allocations.deallocate,
      "host table aliases",
    );
    arena.begin();
    arena.appendModule({ activationId: 1, templateId: new Uint8Array(32).fill(1) });
    arena.appendModule({ activationId: 2, templateId: new Uint8Array(32).fill(2) });
    capture.appendTo(arena);
    const tableBindingRecord = arena.recordsForCapture().find(
      (record) => record.kind === ForkModuleStateRecordKind.ImportedTableBindings,
    )!;
    expect(decodeForkImportedTableBindings(tableBindingRecord.payload)).toEqual([
      {
        consumerActivation: 1,
        consumerOwner: 1,
        sourceActivation: 0,
        sourceOwner: 0,
        reserved: 0,
        kind: ForkImportedTableBindingKind.BaseImport,
      },
      {
        consumerActivation: 2,
        consumerOwner: 1,
        sourceActivation: 0,
        sourceOwner: 0,
        reserved: 0,
        kind: ForkImportedTableBindingKind.BaseImport,
      },
    ]);
    arena.seal();

    const planner = new ForkImportedGlobalPlanner(
      arena.records(),
      new Map([[1, module], [2, module]]),
      { ownerActivation: () => null, materialize: () => null },
      "base table child",
    );
    const childTable = new WebAssembly.Table({
      element: "anyfunc",
      initial: 1,
      maximum: 4,
    });
    const instances = new Map<number, WebAssembly.Instance>();
    for (const activationId of planner.instantiationOrder()) {
      const instance = new WebAssembly.Instance(
        module,
        planner.importsForActivation(activationId, {
          host: { dispatch: childTable },
        }) as WebAssembly.Imports,
      );
      instances.set(activationId, instance);
      planner.registerInstance(activationId, instance);
    }
    const childTrackers = new Map([
      [1, new ForkTableDirtyTracker()],
      [2, new ForkTableDirtyTracker()],
    ]);
    childTrackers.get(1)!.markPages(1, 3n, 1n);
    childTrackers.get(2)!.markPages(1, 9n, 1n);
    planner.bindTableDirtyTrackers(childTrackers);
    expect(childTrackers.get(1)!.ownsState(1)).toBe(true);
    expect(childTrackers.get(2)!.ownsState(1)).toBe(false);
    childTrackers.get(2)!.markPages(1, 12n, 1n);
    expect(
      [0, 1, 2].map((ordinal) =>
        childTrackers.get(1)!.pageAt(1, ordinal)
      ),
    ).toEqual([3n, 9n, 12n]);
    expect(instances.get(1)!.exports.__wpk_fork_table_1)
      .toBe(instances.get(2)!.exports.__wpk_fork_table_1);
    expect(instances.get(1)!.exports.__wpk_fork_table_1).toBe(childTable);
    expect(instances.get(1)!.exports.__wpk_fork_table_1).not.toBe(parentTable);
    planner.clear();
  });

  it("rejects a provider cycle deterministically before instantiation", () => {
    const cycleModule = compileModule(
      `(module
        (import "peer" "value" (global $value i32))
        (export "__wpk_fork_global_1" (global $value)))`,
      importedGlobalsSection([{
        module: "peer",
        name: "value",
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
      }]),
    );
    const memory = new WebAssembly.Memory({ initial: 3 });
    const allocations = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      allocations.allocate,
      allocations.deallocate,
      "cycle",
    );
    arena.begin();
    arena.appendModule({ activationId: 1, templateId: new Uint8Array(32).fill(1) });
    arena.appendModule({ activationId: 2, templateId: new Uint8Array(32).fill(2) });
    arena.appendImportedGlobalBindings([
      {
        consumerActivation: 1,
        consumerOwner: 1,
        sourceActivation: 2,
        sourceOwner: 1,
        reserved: 0,
        recipeId: 0,
        rawBits: 0n,
        kind: ForkImportedGlobalBindingKind.ActivationGlobal,
        mutable: false,
        shared: false,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
      },
      {
        consumerActivation: 2,
        consumerOwner: 1,
        sourceActivation: 1,
        sourceOwner: 1,
        reserved: 0,
        recipeId: 0,
        rawBits: 0n,
        kind: ForkImportedGlobalBindingKind.ActivationGlobal,
        mutable: false,
        shared: false,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
      },
    ]);
    arena.appendImportedTableBindings([]);
    arena.seal();
    const planner = new ForkImportedGlobalPlanner(
      arena.records(),
      new Map([[1, cycleModule], [2, cycleModule]]),
      {
        ownerActivation: () => null,
        materialize: () => null,
      },
      "cycle",
    );
    expect(() => planner.instantiationOrder())
      .toThrow("provider cycle among activations 1, 2");
  });

  it("orders the complete typed-reference provider closure before its consumer", () => {
    const emptyModule = compileModule(
      `(module)`,
      importedGlobalsSection([]),
    );
    const consumerModule = compileModule(
      `(module
        (import "env" "token" (global $token externref))
        (export "token" (global $token)))`,
      importedGlobalsSection([{
        module: "env",
        name: "token",
        ownerId: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
      }]),
    );
    const memory = new WebAssembly.Memory({ initial: 3 });
    const allocations = allocator(memory);
    const arena = new ForkModuleStateArena(
      memory,
      4,
      allocations.allocate,
      allocations.deallocate,
      "typed reference dependency closure",
    );
    arena.begin();
    for (const activationId of [1, 2, 3]) {
      arena.appendModule({
        activationId,
        templateId: new Uint8Array(32).fill(activationId),
      });
    }
    arena.appendImportedGlobalBindings([{
      consumerActivation: 3,
      consumerOwner: 1,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      recipeId: 1,
      rawBits: 0n,
      kind: ForkImportedGlobalBindingKind.RawReference,
      mutable: false,
      shared: false,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
    }]);
    arena.appendImportedTableBindings([]);
    arena.seal();

    const registered = new Set<number>();
    const token = Object.freeze({ child: true });
    const planner = new ForkImportedGlobalPlanner(
      arena.records(),
      new Map([
        [1, emptyModule],
        [2, emptyModule],
        [3, consumerModule],
      ]),
      {
        ownerActivation: () => 1,
        activationDependencies: () => [2, 1],
        materialize: () => {
          expect([...registered].sort()).toEqual([1, 2]);
          return token;
        },
      },
      "typed reference dependency closure",
    );
    expect(planner.instantiationOrder()).toEqual([1, 2, 3]);
    for (const activationId of planner.instantiationOrder()) {
      const module = activationId === 3 ? consumerModule : emptyModule;
      const instance = new WebAssembly.Instance(
        module,
        planner.importsForActivation(
          activationId,
          activationId === 3 ? { env: {} } : {},
        ) as WebAssembly.Imports,
      );
      planner.registerInstance(activationId, instance);
      registered.add(activationId);
    }
  });
});
