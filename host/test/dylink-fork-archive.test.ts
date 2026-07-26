import { describe, expect, it } from "vitest";
import type { DylinkForkState } from "../src/dylink";
import {
  DylinkForkArchive,
  DylinkForkTableReplica,
} from "../src/dylink-fork-archive";

function fixture(ptrWidth: 4 | 8 = 4) {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
  let head = 0;
  let next = 4096;
  const allocations = new Map<number, number>();
  const deallocated: Array<{ address: number; size: number }> = [];
  const archive = () => new DylinkForkArchive(
    memory,
    ptrWidth,
    () => head,
    (value) => { head = value; },
    (size) => {
      const address = next;
      next += Math.ceil(size / 8) * 8;
      allocations.set(address, size);
      return { address, size };
    },
    ({ address, size }) => {
      expect(allocations.get(address)).toBe(size);
      allocations.delete(address);
      deallocated.push({ address, size });
    },
    "test dylink archive",
  );
  return {
    memory,
    archive,
    allocations,
    deallocated,
    get head() {
      return head;
    },
  };
}

function state(): DylinkForkState {
  return {
    nextHandle: 4,
    libraries: [
      {
        name: "libdependency.so",
        moduleBytes: new Uint8Array([0, 97, 115, 109, 1]),
        memoryBase: 8192,
        tableBase: 3,
        activationId: 7,
        globalVisibility: true,
        allocations: [{
          address: 8192,
          size: 64,
          mappingAddress: 8176,
          mappingSize: 95,
        }],
      },
      {
        name: "libconsumer.so",
        moduleBytes: new Uint8Array([0, 97, 115, 109, 2]),
        memoryBase: 12288,
        tableBase: 9,
        activationId: 8,
        tlsBase: 16384,
        globalVisibility: true,
        committedGlobalRoot: true,
        allocations: [{
          address: 12288,
          size: 128,
          mappingAddress: 12272,
          mappingSize: 159,
        }],
        handle: 3,
        refCount: 2,
      },
    ],
  };
}

describe("compact dylink fork archive", () => {
  it("round-trips dependency-first live state and updates records in place", () => {
    const f = fixture();
    const parent = f.archive();
    expect(parent.generation()).toBe(0);
    const first = parent.sync(state());
    expect(first.generation).toBe(1);
    const allocationCount = f.allocations.size;
    expect(parent.read()).toEqual({
      generation: 1,
      tableStateRoot: 0,
      tableCheckpointGeneration: 0,
      tablePatches: [],
      ...state(),
    });

    const updated = state();
    updated.libraries[1] = {
      ...updated.libraries[1]!,
      refCount: 3,
    };
    expect(parent.sync(updated).generation).toBe(2);
    expect(f.allocations.size).toBe(allocationCount);
    expect(parent.read()).toEqual({
      generation: 2,
      tableStateRoot: 0,
      tableCheckpointGeneration: 0,
      tablePatches: [],
      ...updated,
    });

    // A separately constructed worker owns no JS cache and must validate the
    // complete copied archive before returning any module bytes.
    const replica = f.archive();
    expect(replica.generation()).toBe(2);
    expect(replica.read()).toEqual({
      generation: 2,
      tableStateRoot: 0,
      tableCheckpointGeneration: 0,
      tablePatches: [],
      ...updated,
    });

    const closed: DylinkForkState = {
      nextHandle: 4,
      libraries: [updated.libraries[0]!],
    };
    parent.sync(closed);
    expect(parent.read()).toEqual({
      generation: 3,
      tableStateRoot: 0,
      tableCheckpointGeneration: 0,
      tablePatches: [],
      ...closed,
    });
    // The same replica must invalidate its JavaScript index after another
    // Worker publishes a generation.
    expect(replica.read()).toEqual({
      generation: 3,
      tableStateRoot: 0,
      tableCheckpointGeneration: 0,
      tablePatches: [],
      ...closed,
    });
    expect(f.deallocated).toHaveLength(1);
    expect(f.allocations.size).toBe(2); // persistent header + dependency
  });

  it("round-trips an issued initialization stage and retires its transaction", () => {
    const f = fixture();
    const archive = f.archive();
    const moduleBytes = new Uint8Array([0, 97, 115, 109, 43]);
    const pending: DylinkForkState = {
      nextHandle: 2,
      libraries: [{
        name: "libinitializing.so",
        moduleBytes,
        memoryBase: 8192,
        tableBase: 3,
        activationId: 7,
        globalVisibility: false,
        initialization: {
          transactionToken: 11,
          stage: "bootstrap",
          tableIndex: 19,
        },
      }],
      transactions: [{
        token: 11,
        name: "libinitializing.so",
        moduleBytes,
        globalVisibility: false,
      }],
    };

    archive.sync(pending);
    expect(f.archive().read()).toMatchObject({
      generation: 1,
      ...pending,
    });
    const allocationCount = f.allocations.size;

    const relocated: DylinkForkState = {
      ...pending,
      libraries: [{
        ...pending.libraries[0]!,
        tlsBase: 12288,
        initialization: {
          transactionToken: 11,
          stage: "constructors",
          tableIndex: 19,
        },
      }],
    };
    archive.sync(relocated);
    expect(f.allocations.size).toBe(allocationCount);
    expect(f.archive().read()).toMatchObject({
      generation: 2,
      ...relocated,
    });

    archive.sync({
      nextHandle: 3,
      libraries: [{
        ...relocated.libraries[0]!,
        initialization: undefined,
        handle: 2,
        refCount: 1,
      }],
    });
    expect(f.archive().read()).toMatchObject({
      generation: 3,
      nextHandle: 3,
      libraries: [{
        name: "libinitializing.so",
        handle: 2,
        refCount: 1,
      }],
    });
    expect(f.deallocated).toHaveLength(1);
  });

  it("replaces a live record when constructor binding ownership grows", () => {
    const f = fixture();
    const archive = f.archive();
    const initial = state();
    archive.sync(initial);
    const allocationCount = f.allocations.size;

    const withRuntimeProvider: DylinkForkState = {
      ...initial,
      libraries: [
        initial.libraries[0]!,
        {
          ...initial.libraries[1]!,
          providerDependencies: ["libdependency.so"],
        },
      ],
    };
    archive.sync(withRuntimeProvider);
    expect(f.allocations.size).toBe(allocationCount);
    expect(f.deallocated).toHaveLength(1);
    expect(f.archive().read().libraries[1]).toMatchObject({
      providerDependencies: ["libdependency.so"],
    });
  });

  it("retains an empty header so closed handle gaps survive another fork", () => {
    const f = fixture(8);
    const archive = f.archive();
    archive.sync({ nextHandle: 19, libraries: [] });

    expect(f.head).toBeGreaterThan(0);
    expect(f.archive().read()).toEqual({
      generation: 1,
      tableStateRoot: 0,
      tableCheckpointGeneration: 0,
      tablePatches: [],
      nextHandle: 19,
      libraries: [],
    });
  });

  it("publishes generation last and advances it without reallocating records", () => {
    const f = fixture();
    const archive = f.archive();
    const initial = archive.sync(state());
    const addresses = [...f.allocations.keys()];
    expect(initial.generation).toBe(1);
    expect(archive.generation()).toBe(1);

    const next = archive.sync(state());
    expect(next.generation).toBe(2);
    expect(archive.generation()).toBe(2);
    expect([...f.allocations.keys()]).toEqual(addresses);

    const view = new DataView(f.memory.buffer);
    view.setBigUint64(f.head + 40, 0n, true);
    expect(() => f.archive().read()).toThrow(/unpublished/);
  });

  it("publishes one sealed table root and preserves it across linker updates", () => {
    const f = fixture();
    const writer = f.archive();
    const reader = f.archive();
    writer.sync(state());

    const first = writer.publishTableState(2048);
    expect(first.previousTableStateRoot).toBe(0);
    expect(first.snapshot).toMatchObject({
      generation: 2,
      tableStateRoot: 2048,
      tableCheckpointGeneration: 2,
      tablePatches: [],
    });
    expect(reader.read()).toMatchObject({
      generation: 2,
      tableStateRoot: 2048,
    });

    const updated = state();
    updated.libraries[1] = {
      ...updated.libraries[1]!,
      refCount: 4,
    };
    expect(writer.sync(updated)).toMatchObject({
      generation: 3,
      tableStateRoot: 2048,
      tableCheckpointGeneration: 2,
    });
    const replacement = writer.publishTableState(3072);
    expect(replacement.previousTableStateRoot).toBe(2048);
    expect(reader.read()).toMatchObject({
      generation: 4,
      tableStateRoot: 3072,
      tableCheckpointGeneration: 4,
      tablePatches: [],
    });
  });

  it("round-trips bounded stable funcref patches after a checkpoint", () => {
    const f = fixture();
    const writer = f.archive();
    const reader = f.archive();
    writer.sync(state());
    writer.publishTableState(2048);

    const patch = {
      activationId: 7,
      ownerId: 3,
      start: 5,
      tableLength: 12,
      runs: [
        { length: 2, function: null },
        {
          length: 3,
          function: { activationId: 8, ordinal: 4 },
        },
      ],
    } as const;
    expect(writer.canPublishTablePatch(patch)).toBe(true);
    const publication = writer.publishTablePatch(patch);
    expect(publication.snapshot).toMatchObject({
      generation: 3,
      tableStateRoot: 2048,
      tableCheckpointGeneration: 2,
      tablePatches: [{ ...patch, generation: 3 }],
    });
    expect(reader.read()).toMatchObject(publication.snapshot);

    // A linker-only generation remains ordered after the patch without
    // duplicating or discarding its deterministic replay recipe.
    const linked = writer.sync(state());
    expect(linked.generation).toBe(4);
    expect(linked.tablePatches).toEqual([{ ...patch, generation: 3 }]);

    const allocationsBeforeCheckpoint = f.allocations.size;
    const replacement = writer.publishTableState(3072);
    expect(replacement.snapshot).toMatchObject({
      generation: 5,
      tableStateRoot: 3072,
      tableCheckpointGeneration: 5,
      tablePatches: [],
    });
    expect(f.allocations.size).toBe(allocationsBeforeCheckpoint - 1);
  });

  it("bounds the patch journal and requires checkpoint compaction", () => {
    const f = fixture();
    const writer = f.archive();
    writer.sync({ nextHandle: 2, libraries: [] });
    const patch = {
      activationId: 0,
      ownerId: 1,
      start: 0,
      tableLength: 1,
      runs: [{ length: 1, function: null }],
    } as const;

    for (let index = 0; index < 256; index++) {
      expect(writer.canPublishTablePatch(patch)).toBe(true);
      writer.publishTablePatch(patch);
    }
    expect(writer.canPublishTablePatch(patch)).toBe(false);
    expect(() => writer.publishTablePatch(patch)).toThrow(
      /requires compaction/,
    );
  });

  it("keeps the steady-state Worker table path to one generation read", () => {
    const f = fixture();
    const writer = f.archive();
    const reader = f.archive();
    const materialized: Array<[number, number]> = [];
    const replica = new DylinkForkTableReplica(
      reader,
      (snapshot, previousGeneration) => {
        materialized.push([snapshot.generation, previousGeneration]);
      },
      "pthread table replica",
    );

    expect(replica.reconcile()).toBe(false);
    writer.sync(state());
    expect(replica.reconcile()).toBe(true);
    expect(replica.generation()).toBe(1);
    expect(replica.reconcile()).toBe(false);

    const updated = state();
    updated.libraries[1] = {
      ...updated.libraries[1]!,
      refCount: 4,
    };
    writer.sync(updated);
    expect(replica.reconcile()).toBe(true);
    expect(replica.reconcile()).toBe(false);
    expect(materialized).toEqual([[1, 0], [2, 1]]);
  });

  it("rejects hash corruption and record cycles before exposing bytes", () => {
    const hashFixture = fixture();
    hashFixture.archive().sync(state());
    const hashView = new DataView(hashFixture.memory.buffer);
    const first = Number(hashView.getBigUint64(hashFixture.head + 32, true));
    const nameLength = hashView.getUint32(first + 60, true);
    const moduleOffset = first + 136 + Math.ceil(nameLength / 8) * 8;
    new Uint8Array(hashFixture.memory.buffer)[moduleOffset] ^= 0xff;
    expect(() => hashFixture.archive().read()).toThrow(/SHA-256 validation/);

    const cycleFixture = fixture();
    cycleFixture.archive().sync(state());
    const cycleView = new DataView(cycleFixture.memory.buffer);
    const cycleFirst = Number(cycleView.getBigUint64(cycleFixture.head + 32, true));
    cycleView.setBigUint64(cycleFirst + 8, BigInt(cycleFirst), true);
    expect(() => cycleFixture.archive().read()).toThrow(/cyclic or truncated/);

    const countFixture = fixture();
    countFixture.archive().sync({ nextHandle: 2, libraries: [] });
    new DataView(countFixture.memory.buffer).setUint32(
      countFixture.head + 24,
      0xffff_ffff,
      true,
    );
    expect(() => countFixture.archive().read()).toThrow(/memory geometry/);
  });

  it("rejects duplicate identities, impossible handles, and immutable drift", () => {
    const f = fixture();
    const archive = f.archive();
    const valid = state();
    expect(() => archive.sync({
      ...valid,
      libraries: [
        valid.libraries[0]!,
        { ...valid.libraries[0]! },
      ],
    })).toThrow(/duplicate live module/);
    expect(() => archive.sync({
      nextHandle: 3,
      libraries: [valid.libraries[1]!],
    })).toThrow(/handle 3 is out of range/);

    archive.sync(valid);
    expect(() => archive.sync({
      ...valid,
      libraries: [
        {
          ...valid.libraries[0]!,
          memoryBase: valid.libraries[0]!.memoryBase + 1,
        },
        valid.libraries[1]!,
      ],
    })).toThrow(/changed immutable archive identity/);
  });

  it("binds the copied archive to its pointer-width contract", () => {
    const f = fixture(4);
    f.archive().sync(state());
    const wrongWidth = new DylinkForkArchive(
      f.memory,
      8,
      () => f.head,
      () => { throw new Error("must not publish"); },
      () => { throw new Error("must not allocate"); },
      () => { throw new Error("must not deallocate"); },
      "wrong width",
    );
    expect(() => wrongWidth.read()).toThrow(/pointer-width mismatch/);
  });
});
