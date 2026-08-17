import { describe, expect, it } from "vitest";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
import {
  ForkReferenceTransaction,
  type ForkExternrefRecipeProvider,
} from "../src/fork-reference-transaction";
import {
  ForkModuleStateArena,
  ForkModuleStateRecordKind,
  type ForkModuleStateRecord,
} from "../src/fork-module-state";
import { ForkStaticRootCatalog } from "../src/fork-static-root-catalog";
import {
  FORK_GC_FIELD_ALLOCATION_DEPENDENCY,
  FORK_GC_FIELD_MUTABLE,
  FORK_GC_FIELD_NULLABLE,
  FORK_GC_FIELD_REFERENCE,
  FORK_GC_LAYOUT_DEFAULTABLE_SHELL,
  FORK_GC_LAYOUT_REQUIRES_PROVENANCE,
  ForkGcCodecDescriptor,
  ForkGcConstructorKind,
  ForkGcLayoutKind,
  type ForkGcCodecProvider,
  type ForkGcLayoutDescriptor,
} from "../src/fork-gc-codec";

function makeFunctionCatalog(
  moduleActivation: number,
  functions: readonly CallableFunction[],
): ForkFunctionCatalog {
  const table = new WebAssembly.Table({
    element: "anyfunc",
    initial: functions.length,
    maximum: functions.length,
  });
  functions.forEach((fn, index) => table.set(index, fn));
  const catalog = new ForkFunctionCatalog();
  catalog.register(moduleActivation, table);
  return catalog;
}

function makeExternrefs(): {
  provider: ForkExternrefRecipeProvider;
  values: Map<number, unknown>;
} {
  let next = 1;
  const values = new Map<number, unknown>();
  const handles = new WeakMap<object, number>();
  const provider: ForkExternrefRecipeProvider = {
    capture(value) {
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        const known = handles.get(value as object);
        if (known) return known;
        const handle = next++;
        handles.set(value as object, handle);
        values.set(handle, value);
        return handle;
      }
      const handle = next++;
      values.set(handle, value);
      return handle;
    },
    materialize(handle) {
      if (!values.has(handle)) throw new Error(`missing handle ${handle}`);
      return values.get(handle);
    },
  };
  return { provider, values };
}

function withArena(
  run: (arena: ForkModuleStateArena) => void,
): ForkModuleStateRecord[] {
  const memory = new WebAssembly.Memory({ initial: 16 });
  let next = 0x1_0000;
  const arena = new ForkModuleStateArena(
    memory,
    4,
    (size) => {
      const addr = next;
      next += Number(size);
      return addr;
    },
    () => {},
    "reference transaction test",
  );
  arena.begin();
  arena.appendModule({
    activationId: 0,
    templateId: new Uint8Array(32),
  });
  run(arena);
  arena.seal();
  return arena.records();
}

describe("ForkReferenceTransaction", () => {
  it("returns original identities in the parent and fresh catalog identities in the child", () => {
    const parentFunction = new WebAssembly.Instance(
      new WebAssembly.Module(
        Uint8Array.from([
          0, 97, 115, 109, 1, 0, 0, 0,
          1, 4, 1, 96, 0, 0,
          3, 2, 1, 0,
          7, 5, 1, 1, 102, 0, 0,
          10, 4, 1, 2, 0, 11,
        ]),
      ),
    ).exports.f as CallableFunction;
    const childFunction = new WebAssembly.Instance(
      new WebAssembly.Module(
        Uint8Array.from([
          0, 97, 115, 109, 1, 0, 0, 0,
          1, 4, 1, 96, 0, 0,
          3, 2, 1, 0,
          7, 5, 1, 1, 102, 0, 0,
          10, 4, 1, 2, 0, 11,
        ]),
      ),
    ).exports.f as CallableFunction;
    const extern = Object.freeze({ owner: "process" });
    const parentExternrefs = makeExternrefs();
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, [parentFunction]),
      parentExternrefs.provider,
    );
    parent.beginCapture();
    const functionId = parent.encodeFuncref(parentFunction);
    const functionAsExternId = parent.encodeExternref(parentFunction);
    const externId = parent.encodeExternref(extern);
    expect(functionAsExternId).toBe(functionId);

    const records = withArena((arena) => parent.sealInto(arena));
    parent.beginParentReplay();
    expect(parent.decodeFuncref(functionId)).toBe(parentFunction);
    expect(parent.decodeExternref(functionAsExternId)).toBe(parentFunction);
    expect(parent.decodeExternref(externId)).toBe(extern);
    parent.finishReplay();

    const childTokens = new Map<number, object>();
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, [childFunction]),
      {
        capture() {
          throw new Error("child must not capture parent externrefs");
        },
        materialize(handle) {
          let token = childTokens.get(handle);
          if (!token) {
            token = Object.freeze({ handle });
            childTokens.set(handle, token);
          }
          return token;
        },
      },
    );
    child.attachChild(records);
    expect(child.decodeFuncref(functionId)).toBe(childFunction);
    expect(child.decodeFuncref(functionId)).not.toBe(parentFunction);
    expect(child.decodeExternref(functionAsExternId)).toBe(childFunction);
    expect(child.decodeExternref(externId)).toBe(child.decodeExternref(externId));
    expect(child.decodeExternref(externId)).not.toBe(extern);
    child.finishReplay();
  });

  it("deduplicates aliases across typed slots and reserves zero for null", () => {
    const externrefs = makeExternrefs();
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      externrefs.provider,
    );
    const shared = { value: 1 };
    transaction.beginCapture();
    expect(transaction.encodeExternref(null)).toBe(0);
    expect(transaction.encodeExternref(shared)).toBe(1);
    expect(transaction.encodeExternref(shared)).toBe(1);
    const records = withArena((arena) => transaction.sealInto(arena));
    transaction.beginParentReplay();
    expect(transaction.decodeExternref(0)).toBeNull();
    expect(transaction.decodeExternref(1)).toBe(shared);
    transaction.finishReplay();
    expect(records.filter(
      ({ kind }) => kind === ForkModuleStateRecordKind.ReferenceRecipe,
    )).toHaveLength(1);
    expect(records.some(
      ({ kind }) => kind === ForkModuleStateRecordKind.ReferenceRecipeSegment,
    )).toBe(true);
  });

  it("round-trips compact call-specific recipe vectors with O(1) lookup", () => {
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
    );
    parent.beginCapture();
    const first = parent.encodeExternref({ value: 1 });
    const second = parent.encodeExternref({ value: 2 });
    const builder = parent.beginReferenceVector(2);
    expect(builder).toBe(1);
    parent.appendReferenceVector(builder, first);
    parent.appendReferenceVector(builder, second);
    const vector = parent.finishReferenceVector(builder);
    expect(vector).toBe(1);
    const duplicateBuilder = parent.beginReferenceVector(2);
    // Completed builder handles are reused, while the frame-visible result is
    // the canonical content ordinal.
    expect(duplicateBuilder).toBe(builder);
    parent.appendReferenceVector(duplicateBuilder, first);
    parent.appendReferenceVector(duplicateBuilder, second);
    expect(parent.finishReferenceVector(duplicateBuilder)).toBe(vector);
    const records = withArena((arena) => parent.sealInto(arena));
    parent.beginParentReplay();
    expect(parent.getReferenceVector(vector, 0)).toBe(first);
    expect(parent.getReferenceVector(vector, 1)).toBe(second);

    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
    );
    child.attachChild(records);
    expect((child as unknown as {
      decodedReferenceVectors: Array<readonly number[]>;
    }).decodedReferenceVectors).toHaveLength(2);
    expect(child.getReferenceVector(vector, 0)).toBe(first);
    expect(child.getReferenceVector(vector, 1)).toBe(second);
    expect(() => child.getReferenceVector(vector, 2)).toThrow(/out of bounds/);
    child.finishReplay();
    parent.finishReplay();
  });

  it("does not seal a partially appended reference vector", () => {
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
    );
    transaction.beginCapture();
    const recipe = transaction.encodeExternref({ value: 1 });
    const builder = transaction.beginReferenceVector(2);
    transaction.appendReferenceVector(builder, recipe);
    expect(() => transaction.finishReferenceVector(builder)).toThrow(
      /expected 2/,
    );
    expect(() => withArena((arena) => transaction.sealInto(arena))).toThrow(
      /unfinished reference vector/,
    );
    transaction.abort();
  });

  it("encodes a module-static root before opaque capture and resolves the child root", () => {
    const parentRoot = Object.freeze({ instance: "parent" });
    const parentTable = new WebAssembly.Table({
      element: "externref",
      initial: 2,
      maximum: 2,
    });
    parentTable.set(0, parentRoot);
    parentTable.set(1, parentRoot);
    const parentRoots = new ForkStaticRootCatalog();
    parentRoots.register(5, parentTable);
    const parentExternrefs = makeExternrefs();
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      parentExternrefs.provider,
      undefined,
      undefined,
      undefined,
      "static-root parent",
      parentRoots,
    );
    parent.beginCapture();
    const recipeId = parent.encodeExternref(parentRoot);
    const builder = parent.beginReferenceVector(1);
    parent.appendReferenceVector(builder, recipeId);
    const vector = parent.finishReferenceVector(builder);
    expect(parentExternrefs.values.size).toBe(0);
    const records = withArena((arena) => parent.sealInto(arena));

    const childRoot = Object.freeze({ instance: "child" });
    const childTable = new WebAssembly.Table({
      element: "externref",
      initial: 2,
      maximum: 2,
    });
    childTable.set(0, childRoot);
    childTable.set(1, childRoot);
    const childRoots = new ForkStaticRootCatalog();
    childRoots.register(5, childTable);
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      undefined,
      undefined,
      undefined,
      "static-root child",
      childRoots,
    );
    child.attachChild(records);
    const restoredRecipeId = child.getReferenceVector(vector, 0);
    expect(restoredRecipeId).toBe(recipeId);
    expect(child.decodeExternref(restoredRecipeId)).toBe(childRoot);
    expect(child.decodeExternref(restoredRecipeId)).not.toBe(parentRoot);
    child.finishReplay();
    parent.abort();
  });

  it("upgrades an earlier external view to one structural exception identity", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const tag = new WebAssembly.Tag({ parameters: ["i32"] });
    const thrown = new WebAssembly.Exception(tag, [29]);
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      memory,
    );
    const provider = {
      throwSlot(_slot: number): never {
        throw thrown;
      },
      clearSlots(): void {},
    };
    transaction.beginCapture();
    const externalView = transaction.encodeExternref(thrown);
    expect(transaction.lookupExceptionSlot(0, provider)).toBe(0);
    const exceptionView = transaction.claimExceptionSlot(0, provider);
    expect(exceptionView).toBe(externalView);
    expect(transaction.encodeExternref(thrown)).toBe(externalView);
    transaction.defineException(
      exceptionView,
      8,
      3,
      4,
      0,
      0,
      0,
      0,
    );
    expect(transaction.exceptionOwner(externalView)).toBe(8);
    withArena((arena) => transaction.sealInto(arena));
    transaction.abort();
  });

  it("drops strong temporary roots after abort", () => {
    const externrefs = makeExternrefs();
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      externrefs.provider,
    );
    transaction.beginCapture();
    const reused = { value: 1 };
    transaction.encodeExternref(reused);
    transaction.abort();
    transaction.beginCapture();
    expect(transaction.encodeExternref(reused)).toBe(1);
    transaction.abort();
  });

  it("owns reentrant shared-memory scratch with LIFO release and zeroing", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    let next = 0x1_0000;
    const released: Array<[number, number]> = [];
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      memory,
      (size) => {
        const addr = next;
        next += size;
        return addr;
      },
      (addr, size) => released.push([addr, size]),
      "scratch test",
    );
    transaction.beginCapture();
    const outer = transaction.reserveScratch(24);
    const inner = transaction.reserveScratch(32);
    expect(inner).toBe(outer + 32);
    new Uint8Array(memory.buffer, outer, 24).fill(0xaa);
    new Uint8Array(memory.buffer, inner, 32).fill(0xbb);

    expect(() => transaction.releaseScratch(outer, 24)).toThrow(
      /most recent reservation/,
    );
    transaction.releaseScratch(inner, 32);
    expect(new Uint8Array(memory.buffer, inner, 32)).toEqual(new Uint8Array(32));
    transaction.releaseScratch(outer, 24);
    expect(new Uint8Array(memory.buffer, outer, 32)).toEqual(new Uint8Array(32));

    // The common page remains transaction-owned for reuse, then is cleared
    // and returned exactly once on abort.
    expect(transaction.reserveScratch(16)).toBe(outer);
    new Uint8Array(memory.buffer, outer, 16).fill(0xcc);
    transaction.abort();
    expect(new Uint8Array(memory.buffer, outer, 16)).toEqual(new Uint8Array(16));
    expect(released).toEqual([[0x1_0000, 65_536]]);
  });

  it("reports the exact capture scratch high-water before borrowed replay", () => {
    const memory = new WebAssembly.Memory({ initial: 8 });
    let next = 0x1_0000;
    const released: Array<[number, number]> = [];
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      memory,
      (size) => {
        const addr = next;
        next += size;
        return addr;
      },
      (addr, size) => released.push([addr, size]),
      "borrowed scratch high-water test",
    );
    transaction.beginCapture();
    const outer = transaction.reserveScratch(65_520);
    const inner = transaction.reserveScratch(32);
    transaction.releaseScratch(inner, 32);
    transaction.releaseScratch(outer, 65_520);

    withArena((arena) => transaction.sealInto(arena));
    expect(transaction.borrowedReplayScratchCapacity()).toBe(2 * 65_536);
    transaction.abort();
    expect(released).toEqual([
      [0x2_0000, 65_536],
      [0x1_0000, 65_536],
    ]);
  });

  it("interns Wasm-only exception identity and transfers exact scalar/reference payloads", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const thrown = new WebAssembly.Exception(
      new WebAssembly.Tag({ parameters: ["i32"] }),
      [17],
    );
    let cleared = 0;
    const externrefs = makeExternrefs();
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      externrefs.provider,
      memory,
    );
    parent.setExceptionSlotProvider({
      throwSlot(slot): never {
        if (slot !== 3 && slot !== 4) throw new Error(`invalid slot ${slot}`);
        throw thrown;
      },
      clearSlots() {
        cleared++;
      },
    });
    parent.beginCapture();
    expect(parent.lookupExceptionSlot(3)).toBe(0);
    const exceptionId = parent.claimExceptionSlot(3);
    expect(exceptionId).toBe(1);
    expect(parent.lookupExceptionSlot(4)).toBe(exceptionId);
    expect(parent.claimExceptionSlot(4)).toBe(exceptionId);

    const sourceScalars = Uint8Array.of(
      0x78, 0x56, 0x34, 0x12,
      0, 1, 2, 3, 4, 5, 6, 7,
      8, 9, 10, 11, 12, 13, 14, 15,
    );
    new Uint8Array(memory.buffer, 0x100, sourceScalars.length).set(sourceScalars);
    new DataView(memory.buffer).setUint32(0x200, 0, true);
    parent.defineException(
      exceptionId,
      7,
      5,
      9,
      0x100,
      sourceScalars.length,
      0x200,
      1,
    );
    const records = withArena((arena) => parent.sealInto(arena));
    parent.beginParentReplay();
    expect(parent.routeException(exceptionId, 7)).toBe(9);
    expect(parent.routeException(exceptionId, 8)).toBe(-1);
    expect(
      parent.loadException(
        exceptionId,
        7,
        5,
        9,
        0x300,
        sourceScalars.length,
        0x400,
        1,
      ),
    ).toBe(1);
    expect(new Uint8Array(memory.buffer, 0x300, sourceScalars.length)).toEqual(
      sourceScalars,
    );
    expect(new DataView(memory.buffer).getUint32(0x400, true)).toBe(0);
    parent.finishReplay();
    expect(cleared).toBe(1);

    const childMemory = new WebAssembly.Memory({ initial: 2 });
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      childMemory,
    );
    child.attachChild(records);
    expect(child.routeException(exceptionId, 7)).toBe(9);
    expect(
      child.loadException(
        exceptionId,
        7,
        5,
        9,
        0x100,
        sourceScalars.length,
        0x200,
        1,
      ),
    ).toBe(1);
    expect(
      new Uint8Array(childMemory.buffer, 0x100, sourceScalars.length),
    ).toEqual(sourceScalars);
    expect(() =>
      child.loadException(
        exceptionId,
        7,
        5,
        10,
        0x100,
        sourceScalars.length,
        0x200,
        1,
      )
    ).toThrow(/coordinate does not match/);
    child.finishReplay();
  });
});

function gcStructDescriptor(options: {
  defaultable?: boolean;
  mutable?: boolean;
  nullable?: boolean;
  dependency?: boolean;
}): ForkGcCodecDescriptor {
  const fieldFlags =
    FORK_GC_FIELD_REFERENCE
    | (options.mutable ? FORK_GC_FIELD_MUTABLE : 0)
    | (options.nullable ? FORK_GC_FIELD_NULLABLE : 0)
    | (options.dependency ? FORK_GC_FIELD_ALLOCATION_DEPENDENCY : 0);
  const layout: ForkGcLayoutDescriptor = {
    id: 1,
    typeOrdinal: 0,
    kind: ForkGcLayoutKind.Struct,
    constructor: ForkGcConstructorKind.Struct,
    flags: options.defaultable ? FORK_GC_LAYOUT_DEFAULTABLE_SHELL : 0,
    scalarLengthOrStride: 0,
    fields: [{
      storage: 8,
      flags: fieldFlags,
      scalarOffset: null,
      referenceOrdinal: 0,
    }],
    superTypeOrdinal: null,
    baseLayoutId: 1,
    auxiliary: 0,
    provenanceScalarLength: 0,
    provenanceReferenceCount: 0,
  };
  return new ForkGcCodecDescriptor([layout]);
}

function captureGcStructGraph(options: {
  descriptor: ForkGcCodecDescriptor;
  edges: readonly (readonly number[])[];
}): ForkModuleStateRecord[] {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const transaction = new ForkReferenceTransaction(
    makeFunctionCatalog(0, []),
    makeExternrefs().provider,
    memory,
  );
  const table = new WebAssembly.Table({
    element: "externref",
    initial: 1,
  });
  transaction.beginCapture();
  const recipeIds = options.edges.map((_, index) => {
    table.set(0, { index });
    return transaction.claimGcSlot(table, 0);
  });
  options.edges.forEach((edgeIndexes, index) => {
    const builder = transaction.beginReferenceVector(edgeIndexes.length);
    edgeIndexes.forEach((edgeIndex) => {
      const edgeRecipe = edgeIndex === -1 ? 0 : recipeIds[edgeIndex];
      if (edgeRecipe === undefined) {
        throw new Error(`test GC edge ${edgeIndex} is out of bounds`);
      }
      transaction.appendReferenceVector(builder, edgeRecipe);
    });
    const vector = transaction.finishReferenceVector(builder);
    transaction.defineGc(
      recipeIds[index]!,
      0,
      0,
      1,
      ForkGcLayoutKind.Struct,
      0,
      0,
      vector,
      options.descriptor,
      null,
    );
  });
  return withArena((arena) => transaction.sealInto(arena));
}

describe("ForkReferenceTransaction typed replay barrier", () => {
  it("reuses canonical GC edge vectors without rebuilding the vector directory", () => {
    const descriptor = gcStructDescriptor({
      defaultable: true,
      mutable: true,
      nullable: true,
    });
    const records = captureGcStructGraph({
      descriptor,
      edges: [[0], [1], [2]],
    });
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      new WebAssembly.Memory({ initial: 2 }),
    );
    child.attachChild(records);

    const internal = child as unknown as {
      decodedReferenceVectors: Array<readonly number[]>;
    };
    const directory = internal.decodedReferenceVectors;
    const firstOrdinal = child.loadGc(
      1,
      0,
      0,
      1,
      ForkGcLayoutKind.Struct,
      0,
      0,
    );
    const secondOrdinal = child.loadGc(
      2,
      0,
      0,
      1,
      ForkGcLayoutKind.Struct,
      0,
      0,
    );
    const thirdOrdinal = child.loadGc(
      3,
      0,
      0,
      1,
      ForkGcLayoutKind.Struct,
      0,
      0,
    );

    expect(internal.decodedReferenceVectors).toBe(directory);
    expect([firstOrdinal, secondOrdinal, thirdOrdinal]).toEqual([1, 2, 3]);
    expect(child.loadGc(
      1,
      0,
      0,
      1,
      ForkGcLayoutKind.Struct,
      0,
      0,
    )).toBe(firstOrdinal);
    expect(internal.decodedReferenceVectors).toHaveLength(4);
    child.abort();
  });

  it("materializes a deep immutable dependency chain without host stack recursion", () => {
    const nodeCount = 6_000;
    const descriptor = gcStructDescriptor({
      nullable: true,
      dependency: true,
    });
    const records = captureGcStructGraph({
      descriptor,
      edges: Array.from(
        { length: nodeCount },
        (_, index) => [index + 1 === nodeCount ? -1 : index + 1],
      ),
    });
    let allocations = 0;
    let fills = 0;
    let firstAllocated = 0;
    let lastAllocated = 0;
    const provider: ForkGcCodecProvider = {
      activationId: 0,
      descriptor,
      probe: () => 0n,
      encodeSlot: () => 0,
      allocate(recipeId) {
        if (allocations === 0) firstAllocated = recipeId;
        lastAllocated = recipeId;
        allocations++;
      },
      fill: () => { fills++; },
      publishExternref: () => {},
    };
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      new WebAssembly.Memory({ initial: 2 }),
      undefined,
      undefined,
      "deep typed child",
      undefined,
      {
        prepareTransit: () => {},
        publishTransit: () => {},
        publishExternref: () => {},
        provider: () => provider,
        providers: () => [provider],
        validateExceptionOwner: () => {},
        materializeException: () => {},
      },
    );
    child.attachChild(records);
    child.materializeAllTyped();

    expect(allocations).toBe(nodeCount);
    expect(fills).toBe(nodeCount);
    expect(firstAllocated).toBe(nodeCount);
    expect(lastAllocated).toBe(1);
    child.finishReplay();
  });

  it("publishes fresh static roots before dynamic GC constructors consume them", () => {
    const descriptor = gcStructDescriptor({ dependency: true });
    const parentRoot = Object.freeze({ instance: "parent-static-root" });
    const parentRoots = new ForkStaticRootCatalog();
    const parentCatalogTable = new WebAssembly.Table({
      element: "externref",
      initial: 1,
      maximum: 1,
    });
    parentCatalogTable.set(0, parentRoot);
    parentRoots.register(5, parentCatalogTable);
    const captureTable = new WebAssembly.Table({
      element: "externref",
      initial: 1,
    });
    const memory = new WebAssembly.Memory({ initial: 2 });
    const parent = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      memory,
      undefined,
      undefined,
      "static-root graph parent",
      parentRoots,
    );
    parent.beginCapture();
    captureTable.set(0, parentRoot);
    const staticRecipe = parent.lookupGcSlot(captureTable, 0);
    captureTable.set(0, { dynamic: true });
    const dynamicRecipe = parent.claimGcSlot(captureTable, 0);
    const builder = parent.beginReferenceVector(1);
    parent.appendReferenceVector(builder, staticRecipe);
    const vector = parent.finishReferenceVector(builder);
    parent.defineGc(
      dynamicRecipe,
      0,
      0,
      1,
      ForkGcLayoutKind.Struct,
      0,
      0,
      vector,
      descriptor,
      null,
    );
    const records = withArena((arena) => parent.sealInto(arena));

    const childRoot = Object.freeze({ instance: "child-static-root" });
    const childRoots = new ForkStaticRootCatalog();
    const childCatalogTable = new WebAssembly.Table({
      element: "externref",
      initial: 1,
      maximum: 1,
    });
    childCatalogTable.set(0, childRoot);
    childRoots.register(5, childCatalogTable);
    const transit = new Map<number, unknown>();
    const calls: string[] = [];
    const provider: ForkGcCodecProvider = {
      activationId: 0,
      descriptor,
      probe: () => 0n,
      encodeSlot: () => 0,
      allocate(recipeId) {
        expect(transit.get(staticRecipe)).toBe(childRoot);
        expect(transit.get(staticRecipe)).not.toBe(parentRoot);
        calls.push(`allocate:${recipeId}`);
      },
      fill: (recipeId) => { calls.push(`fill:${recipeId}`); },
      publishExternref: () => {},
    };
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      new WebAssembly.Memory({ initial: 2 }),
      undefined,
      undefined,
      "static-root graph child",
      childRoots,
      {
        prepareTransit: (max) => { calls.push(`prepare:${max}`); },
        publishTransit(recipeId, value) {
          transit.set(recipeId, value);
          calls.push(`publish:${recipeId}`);
        },
        publishExternref: () => {},
        provider: () => provider,
        providers: () => [provider],
        validateExceptionOwner: () => {},
        materializeException: () => {},
      },
    );
    child.attachChild(records);
    child.materializeAllTyped();
    expect(calls).toEqual([
      `prepare:${dynamicRecipe}`,
      `publish:${staticRecipe}`,
      `allocate:${dynamicRecipe}`,
      `fill:${dynamicRecipe}`,
    ]);
    child.finishReplay();
    parent.abort();
  });

  it("allocates all defaultable shells before filling cyclic mutable edges", () => {
    const descriptor = gcStructDescriptor({
      defaultable: true,
      mutable: true,
      nullable: true,
    });
    const records = captureGcStructGraph({
      descriptor,
      edges: [[0]],
    });
    const calls: string[] = [];
    const provider: ForkGcCodecProvider = {
      activationId: 0,
      descriptor,
      probe: () => 0n,
      encodeSlot: () => 0,
      allocate: (recipeId) => { calls.push(`allocate:${recipeId}`); },
      fill: (recipeId) => { calls.push(`fill:${recipeId}`); },
      publishExternref: () => {},
    };
    const memory = new WebAssembly.Memory({ initial: 2 });
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      memory,
      undefined,
      undefined,
      "typed child",
      undefined,
      {
        prepareTransit: (max) => { calls.push(`prepare:${max}`); },
        publishTransit: () => {},
        publishExternref: () => {},
        provider: () => provider,
        providers: () => [provider],
        validateExceptionOwner: () => {},
        materializeException: () => {},
      },
    );
    child.attachChild(records);
    child.materializeAllTyped();
    expect(calls).toEqual(["prepare:1", "allocate:1", "fill:1"]);
    child.finishReplay();
  });

  it("rejects an immutable constructor cycle before allocating any object", () => {
    const descriptor = gcStructDescriptor({
      dependency: true,
    });
    const records = captureGcStructGraph({
      descriptor,
      edges: [[1], [0]],
    });
    const calls: string[] = [];
    const provider: ForkGcCodecProvider = {
      activationId: 0,
      descriptor,
      probe: () => 0n,
      encodeSlot: () => 0,
      allocate: (recipeId) => { calls.push(`allocate:${recipeId}`); },
      fill: (recipeId) => { calls.push(`fill:${recipeId}`); },
      publishExternref: () => {},
    };
    const child = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      new WebAssembly.Memory({ initial: 2 }),
      undefined,
      undefined,
      "typed cycle",
      undefined,
      {
        prepareTransit: () => {},
        publishTransit: () => {},
        publishExternref: () => {},
        provider: () => provider,
        providers: () => [provider],
        validateExceptionOwner: () => {},
        materializeException: () => {},
      },
    );
    child.attachChild(records);
    expect(() => child.materializeAllTyped()).toThrow(
      /unallocatable constructor cycle/,
    );
    expect(calls).toEqual([]);
    child.abort();
  });

  it("requires constructor provenance when the selected layout declares it", () => {
    const base = gcStructDescriptor({}).require(1);
    const descriptor = new ForkGcCodecDescriptor([{
      ...base,
      flags: FORK_GC_LAYOUT_REQUIRES_PROVENANCE,
      provenanceReferenceCount: 1,
    }]);
    const memory = new WebAssembly.Memory({ initial: 2 });
    const transaction = new ForkReferenceTransaction(
      makeFunctionCatalog(0, []),
      makeExternrefs().provider,
      memory,
    );
    const table = new WebAssembly.Table({
      element: "externref",
      initial: 1,
    });
    table.set(0, {});
    transaction.beginCapture();
    const recipe = transaction.claimGcSlot(table, 0);
    const builder = transaction.beginReferenceVector(1);
    transaction.appendReferenceVector(builder, 0);
    const vector = transaction.finishReferenceVector(builder);
    expect(() => transaction.defineGc(
      recipe,
      0,
      0,
      1,
      ForkGcLayoutKind.Struct,
      0,
      0,
      vector,
      descriptor,
      null,
    )).toThrow(/missing constructor provenance/);
    transaction.abort();
  });
});
