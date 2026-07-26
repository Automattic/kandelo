import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
import { ForkExternrefBroker } from "../src/fork-reference-broker";
import { ForkStaticRootCatalog } from "../src/fork-static-root-catalog";
import {
  DEFAULT_FORK_REFERENCE_RECIPE_LIMITS,
  FORK_REFERENCE_RECIPE_VERSION,
  ForkReferenceRecipeCoordinator,
  ForkReferenceTypeCatalog,
  decodeForkReferenceRecipes,
  encodeForkReferenceRecipes,
  type ForkReferenceRecipeGraph,
  type ForkReferenceReplayArena,
  type ForkReferenceReplayTarget,
} from "../src/fork-reference-recipes";

interface MaterializedNode {
  kind: "externref" | "exnref" | "i31" | "struct" | "array";
  coordinate?: string;
  value?: number;
  edges: unknown[];
}

class RecordingArena implements ForkReferenceReplayArena {
  readonly staged = new Set<MaterializedNode>();
  readonly externrefs = new Map<number, MaterializedNode>();
  committedRoots: readonly unknown[] | undefined;
  aborted = false;
  failAt: "connect" | "commit" | undefined;

  materializeExternref(handle: number): unknown {
    let value = this.externrefs.get(handle);
    if (!value) {
      value = { kind: "externref", value: handle, edges: [] };
      this.externrefs.set(handle, value);
      this.staged.add(value);
    }
    return value;
  }

  materializeI31(value: number): unknown {
    return this.add({ kind: "i31", value, edges: [] });
  }

  allocateException(
    moduleActivation: number,
    tagOrdinal: number,
    payloadCount: number,
  ): unknown {
    return this.add({
      kind: "exnref",
      coordinate: `${moduleActivation}:${tagOrdinal}`,
      edges: new Array(payloadCount),
    });
  }

  allocateStruct(
    moduleActivation: number,
    typeOrdinal: number,
    fieldCount: number,
  ): unknown {
    return this.add({
      kind: "struct",
      coordinate: `${moduleActivation}:${typeOrdinal}`,
      edges: new Array(fieldCount),
    });
  }

  allocateArray(
    moduleActivation: number,
    typeOrdinal: number,
    length: number,
  ): unknown {
    return this.add({
      kind: "array",
      coordinate: `${moduleActivation}:${typeOrdinal}`,
      edges: new Array(length),
    });
  }

  setExceptionPayload(exception: unknown, index: number, value: unknown): void {
    this.connect(exception, index, value);
  }

  setStructField(struct: unknown, index: number, value: unknown): void {
    this.connect(struct, index, value);
  }

  setArrayElement(array: unknown, index: number, value: unknown): void {
    this.connect(array, index, value);
  }

  commit(roots: readonly unknown[]): void {
    if (this.failAt === "commit") throw new Error("injected commit failure");
    this.committedRoots = [...roots];
    this.staged.clear();
  }

  abort(): void {
    this.aborted = true;
    this.committedRoots = undefined;
    this.staged.clear();
    this.externrefs.clear();
  }

  private add(node: MaterializedNode): MaterializedNode {
    this.staged.add(node);
    return node;
  }

  private connect(container: unknown, index: number, value: unknown): void {
    if (this.failAt === "connect") throw new Error("injected connect failure");
    (container as MaterializedNode).edges[index] = value;
  }
}

class RecordingTarget implements ForkReferenceReplayTarget {
  beginCount = 0;
  readonly arenas: RecordingArena[] = [];

  constructor(
    readonly functions: ForkFunctionCatalog,
    readonly types: ForkReferenceTypeCatalog,
    private readonly failAt?: "connect" | "commit",
    readonly staticRoots?: ForkStaticRootCatalog,
  ) {}

  beginReferenceReplay(_nodeCount: number): RecordingArena {
    this.beginCount++;
    const arena = new RecordingArena();
    arena.failAt = this.failAt;
    this.arenas.push(arena);
    return arena;
  }
}

function emptyFunctions(): ForkFunctionCatalog {
  return new ForkFunctionCatalog();
}

function referenceTypes(): ForkReferenceTypeCatalog {
  const types = new ForkReferenceTypeCatalog();
  types.register(7, {
    tags: [{ ordinal: 5, payloadCount: 2 }],
    structs: [{ ordinal: 2, fieldCount: 3 }],
    arrays: [{ ordinal: 3 }],
  });
  return types;
}

function graphWithEveryKind(handle: number): ForkReferenceRecipeGraph {
  return {
    roots: [100, 100, 60, 80, 90, 30],
    nodes: [
      {
        id: 100,
        node: {
          kind: "struct",
          moduleActivation: 7,
          typeOrdinal: 2,
          layoutId: 12,
          scalars: Uint8Array.of(0x78, 0x56, 0x34, 0x12),
          fields: [20, 30, 60],
        },
      },
      {
        id: 20,
        node: {
          kind: "array",
          moduleActivation: 7,
          typeOrdinal: 3,
          layoutId: 13,
          scalars: Uint8Array.of(0xaa, 0xbb),
          elements: [100, 60],
        },
      },
      { id: 30, node: { kind: "externref", handle } },
      {
        id: 60,
        node: {
          kind: "exnref",
          moduleActivation: 7,
          tagOrdinal: 5,
          layoutId: 15,
          scalars: Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7),
          payloads: [100, 70],
        },
      },
      { id: 70, node: { kind: "i31", value: -17 } },
      {
        id: 80,
        node: {
          kind: "funcref",
          moduleActivation: 7,
          functionOrdinal: 0,
        },
      },
      { id: 90, node: { kind: "null" } },
    ],
  };
}

function catalogModule(): WebAssembly.Module {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-reference-recipes-"));
  const wat = join(dir, "catalog.wat");
  const wasm = join(dir, "catalog.wasm");
  writeFileSync(wat, `(module
    (table $catalog (export "__wpk_fork_function_catalog") 1 1 funcref)
    (func $value (result i32) i32.const 43)
    (elem (table $catalog) (i32.const 0) func $value)
  )`);
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  return new WebAssembly.Module(readFileSync(wasm));
}

function freshFunctionCatalogs(): {
  source: ForkFunctionCatalog;
  target: ForkFunctionCatalog;
  sourceFunction: CallableFunction;
  targetFunction: CallableFunction;
} {
  const module = catalogModule();
  const sourceTable = new WebAssembly.Instance(module).exports
    .__wpk_fork_function_catalog as WebAssembly.Table;
  const targetTable = new WebAssembly.Instance(module).exports
    .__wpk_fork_function_catalog as WebAssembly.Table;
  const source = new ForkFunctionCatalog();
  const target = new ForkFunctionCatalog();
  source.register(7, sourceTable);
  target.register(7, targetTable);
  return {
    source,
    target,
    sourceFunction: sourceTable.get(0) as CallableFunction,
    targetFunction: targetTable.get(0) as CallableFunction,
  };
}

describe("fork reference recipe wire codec", () => {
  it("uses wire-format bounds rather than arbitrary production quotas", () => {
    expect(DEFAULT_FORK_REFERENCE_RECIPE_LIMITS).toEqual({
      maxWireBytes: 0xffff_ffff,
      maxNodes: 0xffff_ffff,
      maxRoots: 0xffff_ffff,
      maxEdges: 0xffff_ffff,
    });
  });

  it("canonicalizes input IDs and preserves cycles, aliases, and every kind", () => {
    const graph = graphWithEveryKind(9);
    const reversed: ForkReferenceRecipeGraph = {
      roots: graph.roots,
      nodes: [...graph.nodes].reverse(),
    };

    const first = encodeForkReferenceRecipes(graph);
    const second = encodeForkReferenceRecipes(reversed);
    expect(second).toEqual(first);
    expect(new DataView(first.buffer).getUint16(4, true)).toBe(
      FORK_REFERENCE_RECIPE_VERSION,
    );

    const decoded = decodeForkReferenceRecipes(
      new Uint8Array(first.buffer, first.byteOffset, first.byteLength),
    );
    expect(decoded.nodes.map(({ node }) => node.kind)).toEqual([
      "array",
      "externref",
      "exnref",
      "i31",
      "funcref",
      "null",
      "struct",
    ]);
    const array = decoded.nodes[0]!.node;
    const exception = decoded.nodes[2]!.node;
    const struct = decoded.nodes[6]!.node;
    expect(array.kind === "array" && array.elements[0]).toBe(6);
    expect(array.kind === "array" && array.scalars).toEqual(
      Uint8Array.of(0xaa, 0xbb),
    );
    expect(exception.kind === "exnref" && exception.layoutId).toBe(15);
    expect(exception.kind === "exnref" && exception.scalars).toEqual(
      Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7),
    );
    expect(struct.kind === "struct" && struct.fields).toEqual([0, 1, 2]);
    expect(struct.kind === "struct" && struct.layoutId).toBe(12);
    expect(decoded.roots[0]).toBe(decoded.roots[1]);
    expect(encodeForkReferenceRecipes(decoded)).toEqual(first);
  });

  it("rejects malformed versions, kinds, reserved fields, edges, and reachability", () => {
    const scalar = encodeForkReferenceRecipes({
      roots: [0],
      nodes: [{ id: 0, node: { kind: "null" } }],
    });
    const mutate = (offset: number, value: number, width: 1 | 2 | 4): Uint8Array => {
      const bytes = scalar.slice();
      const view = new DataView(bytes.buffer);
      if (width === 1) view.setUint8(offset, value);
      else if (width === 2) view.setUint16(offset, value, true);
      else view.setUint32(offset, value, true);
      return bytes;
    };
    expect(() => decodeForkReferenceRecipes(mutate(4, 99, 2))).toThrow(
      "unsupported reference recipe version",
    );
    expect(() => decodeForkReferenceRecipes(mutate(40, 99, 1))).toThrow(
      "unknown kind",
    );
    expect(() => decodeForkReferenceRecipes(mutate(41, 1, 1))).toThrow(
      "nonzero flags",
    );
    expect(() => decodeForkReferenceRecipes(mutate(56, 1, 4))).toThrow(
      "edge range exceeds",
    );
    expect(() => decodeForkReferenceRecipes(mutate(32, 1, 4))).toThrow(
      "reserved header",
    );

    const aggregate = encodeForkReferenceRecipes({
      roots: [0],
      nodes: [
        {
          id: 0,
          node: {
            kind: "array",
            moduleActivation: 1,
            typeOrdinal: 0,
            elements: [1],
          },
        },
        { id: 1, node: { kind: "null" } },
      ],
    });
    const badEdge = aggregate.slice();
    const edgeOffset = 40 + 2 * 32 + 4;
    new DataView(badEdge.buffer).setUint32(edgeOffset, 2, true);
    expect(() => decodeForkReferenceRecipes(badEdge)).toThrow(
      "targets missing node",
    );

    const reachable = encodeForkReferenceRecipes({
      roots: [0, 1],
      nodes: [
        { id: 0, node: { kind: "null" } },
        { id: 1, node: { kind: "i31", value: 1 } },
      ],
    });
    const unreachable = reachable.slice();
    const rootOffset = 40 + 2 * 32;
    new DataView(unreachable.buffer).setUint32(rootOffset + 4, 0, true);
    expect(() => decodeForkReferenceRecipes(unreachable)).toThrow(
      "unreachable from every root",
    );
  });

  it("enforces bounded, exact layouts and i31/handle domains", () => {
    expect(() =>
      encodeForkReferenceRecipes(
        {
          roots: [0],
          nodes: [{ id: 0, node: { kind: "i31", value: 0x4000_0000 } }],
        },
      )
    ).toThrow("invalid i31");
    expect(() =>
      encodeForkReferenceRecipes({
        roots: [0],
        nodes: [{ id: 0, node: { kind: "externref", handle: 0 } }],
      })
    ).toThrow("positive unsigned 32-bit integer");
    expect(() =>
      encodeForkReferenceRecipes({
        roots: [0],
        nodes: [{
          id: 0,
          node: { kind: "externref", handle: 0x1_0000_0000 },
        }],
      })
    ).toThrow("positive unsigned 32-bit integer");
    const externref = encodeForkReferenceRecipes({
      roots: [0],
      nodes: [{ id: 0, node: { kind: "externref", handle: 1 } }],
    });
    const nonU32Externref = externref.slice();
    new DataView(nonU32Externref.buffer).setUint32(48, 1, true);
    expect(() => decodeForkReferenceRecipes(nonU32Externref)).toThrow(
      "positive unsigned 32-bit integer",
    );

    const i31 = encodeForkReferenceRecipes({
      roots: [0, 1],
      nodes: [
        { id: 0, node: { kind: "i31", value: -0x4000_0000 } },
        { id: 1, node: { kind: "i31", value: 0x3fff_ffff } },
      ],
    });
    expect(
      decodeForkReferenceRecipes(i31).nodes.map(({ node }) =>
        node.kind === "i31" ? node.value : undefined
      ),
    ).toEqual([-0x4000_0000, 0x3fff_ffff]);
    const noncanonicalI31 = i31.slice();
    new DataView(noncanonicalI31.buffer).setUint32(44, 0x4000_0000, true);
    expect(() => decodeForkReferenceRecipes(noncanonicalI31)).toThrow(
      "invalid i31",
    );

    const bytes = encodeForkReferenceRecipes({
      roots: [],
      nodes: [],
    });
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    new DataView(trailing.buffer).setUint32(8, trailing.length, true);
    expect(() => decodeForkReferenceRecipes(trailing)).toThrow(
      "layout needs",
    );
    expect(() =>
      decodeForkReferenceRecipes(bytes, {
        maxWireBytes: 40,
        maxNodes: 0,
        maxRoots: 0,
        maxEdges: 0,
      })
    ).not.toThrow();
    expect(() =>
      encodeForkReferenceRecipes(
        { roots: [0], nodes: [{ id: 0, node: { kind: "null" } }] },
        {
          maxWireBytes: 40,
          maxNodes: 1,
          maxRoots: 1,
          maxEdges: 0,
        },
      )
    ).toThrow("needs");
  });
});

describe("ForkReferenceRecipeCoordinator", () => {
  it("resolves static-root recipes against the fresh child activation", () => {
    const sourceValue = Object.freeze({ instance: "source" });
    const targetValue = Object.freeze({ instance: "target" });
    const sourceTable = new WebAssembly.Table({
      element: "externref",
      initial: 1,
      maximum: 1,
    });
    const targetTable = new WebAssembly.Table({
      element: "externref",
      initial: 1,
      maximum: 1,
    });
    sourceTable.set(0, sourceValue);
    targetTable.set(0, targetValue);
    const sourceRoots = new ForkStaticRootCatalog();
    const targetRoots = new ForkStaticRootCatalog();
    sourceRoots.register(6, sourceTable);
    targetRoots.register(6, targetTable);
    const target = new RecordingTarget(
      emptyFunctions(),
      new ForkReferenceTypeCatalog(),
      undefined,
      targetRoots,
    );
    const broker = new ForkExternrefBroker();
    const parentGeneration = broker.createGeneration(80);
    const childGeneration = broker.createGeneration(81);
    const coordinator = new ForkReferenceRecipeCoordinator(
      emptyFunctions(),
      new ForkReferenceTypeCatalog(),
      broker,
      DEFAULT_FORK_REFERENCE_RECIPE_LIMITS,
      sourceRoots,
    );
    const ownership = coordinator.replay({
      parentGeneration,
      childGeneration,
      wire: encodeForkReferenceRecipes({
        roots: [0],
        nodes: [{
          id: 0,
          node: {
            kind: "static-root",
            moduleActivation: 6,
            staticRootOrdinal: 0,
          },
        }],
      }),
      target,
    });
    expect(target.arenas[0]!.committedRoots).toEqual([targetValue]);
    expect(target.arenas[0]!.committedRoots![0]).not.toBe(sourceValue);
    ownership.release();
  });

  it("reconstructs fresh-instance identities and cyclic typed graphs transactionally", () => {
    const functions = freshFunctionCatalogs();
    expect(functions.targetFunction).not.toBe(functions.sourceFunction);
    const sourceTypes = referenceTypes();
    const targetTypes = referenceTypes();
    const broker = new ForkExternrefBroker();
    const parentGeneration = broker.createGeneration(41);
    const childGeneration = broker.createGeneration(42);
    const opaque = { owned: "outside workers" };
    const handle = broker.register(parentGeneration, opaque);
    expect(broker.register(parentGeneration, opaque)).toBe(handle);

    const target = new RecordingTarget(functions.target, targetTypes);
    const coordinator = new ForkReferenceRecipeCoordinator(
      functions.source,
      sourceTypes,
      broker,
    );
    const ownership = coordinator.replay({
      parentGeneration,
      childGeneration,
      wire: encodeForkReferenceRecipes(graphWithEveryKind(handle)),
      target,
    });

    const roots = target.arenas[0]!.committedRoots!;
    const struct = roots[0] as MaterializedNode;
    const exception = roots[2] as MaterializedNode;
    expect(roots[1]).toBe(struct);
    expect((struct.edges[0] as MaterializedNode).edges[0]).toBe(struct);
    expect(struct.edges[2]).toBe(exception);
    expect(exception.edges[0]).toBe(struct);
    expect((exception.edges[1] as MaterializedNode).kind).toBe("i31");
    expect(roots[3]).toBe(functions.targetFunction);
    expect(roots[4]).toBeNull();
    expect(roots[5]).toBe(struct.edges[1]);
    expect(broker.holderCount(handle, childGeneration)).toBe(1);
    expect(target.arenas[0]!.staged.size).toBe(0);

    ownership.release();
    expect(broker.holderCount(handle, childGeneration)).toBe(0);
    expect(() => ownership.release()).toThrow("already released");
  });

  it.each(["connect", "commit"] as const)(
    "aborts the arena and releases every acquired handle after a %s failure",
    (failAt) => {
      const broker = new ForkExternrefBroker();
      const parentGeneration = broker.createGeneration(51);
      const childGeneration = broker.createGeneration(52);
      const handle = broker.register(parentGeneration, { opaque: true });
      const sourceTypes = new ForkReferenceTypeCatalog();
      const targetTypes = new ForkReferenceTypeCatalog();
      sourceTypes.register(0, { arrays: [{ ordinal: 0 }] });
      targetTypes.register(0, { arrays: [{ ordinal: 0 }] });
      const target = new RecordingTarget(
        emptyFunctions(),
        targetTypes,
        failAt,
      );
      const coordinator = new ForkReferenceRecipeCoordinator(
        emptyFunctions(),
        sourceTypes,
        broker,
      );
      const wire = encodeForkReferenceRecipes({
        roots: [0],
        nodes: [
          {
            id: 0,
            node: {
              kind: "array",
              moduleActivation: 0,
              typeOrdinal: 0,
              elements: [1],
            },
          },
          { id: 1, node: { kind: "externref", handle } },
        ],
      });

      expect(() =>
        coordinator.replay({
          parentGeneration,
          childGeneration,
          wire,
          target,
        })
      ).toThrow(`injected ${failAt} failure`);
      expect(target.arenas[0]!.aborted).toBe(true);
      expect(target.arenas[0]!.staged.size).toBe(0);
      expect(target.arenas[0]!.externrefs.size).toBe(0);
      expect(broker.holderCount(handle, childGeneration)).toBe(0);
      expect(broker.resolve(parentGeneration, handle)).toEqual({ opaque: true });
    },
  );

  it("validates source and target coordinate ownership before acquisition", () => {
    const broker = new ForkExternrefBroker();
    const parentGeneration = broker.createGeneration(61);
    const childGeneration = broker.createGeneration(62);
    const handle = broker.register(parentGeneration, "opaque");
    const sourceTypes = new ForkReferenceTypeCatalog();
    const targetTypes = new ForkReferenceTypeCatalog();
    sourceTypes.register(1, { structs: [{ ordinal: 2, fieldCount: 1 }] });
    targetTypes.register(1, { structs: [{ ordinal: 9, fieldCount: 1 }] });
    const target = new RecordingTarget(emptyFunctions(), targetTypes);
    const coordinator = new ForkReferenceRecipeCoordinator(
      emptyFunctions(),
      sourceTypes,
      broker,
    );
    const wire = encodeForkReferenceRecipes({
      roots: [0],
      nodes: [
        {
          id: 0,
          node: {
            kind: "struct",
            moduleActivation: 1,
            typeOrdinal: 2,
            fields: [1],
          },
        },
        { id: 1, node: { kind: "externref", handle } },
      ],
    });

    expect(() =>
      coordinator.replay({
        parentGeneration,
        childGeneration,
        wire,
        target,
      })
    ).toThrow("target catalog rejected");
    expect(target.beginCount).toBe(0);
    expect(broker.holderCount(handle, childGeneration)).toBe(0);
  });

  it("acquires one host lease across every aliased occurrence in the graph", () => {
    const broker = new ForkExternrefBroker();
    const parentGeneration = broker.createGeneration(66);
    const childGeneration = broker.createGeneration(67);
    const handle = broker.register(parentGeneration, { opaque: true });
    const target = new RecordingTarget(
      emptyFunctions(),
      new ForkReferenceTypeCatalog(),
    );
    const coordinator = new ForkReferenceRecipeCoordinator(
      emptyFunctions(),
      new ForkReferenceTypeCatalog(),
      broker,
    );

    const ownership = coordinator.replay({
      parentGeneration,
      childGeneration,
      wire: encodeForkReferenceRecipes({
        roots: [0, 0],
        nodes: [{ id: 0, node: { kind: "externref", handle } }],
      }),
      target,
    });
    expect(target.arenas[0]!.committedRoots![0]).toBe(
      target.arenas[0]!.committedRoots![1],
    );
    expect(broker.holderCount(handle, childGeneration)).toBe(1);
    ownership.release();
    expect(broker.holderCount(handle, childGeneration)).toBe(0);
  });

  it("releases all replay leases when the child generation is retired", () => {
    const broker = new ForkExternrefBroker();
    const parentGeneration = broker.createGeneration(71);
    const childGeneration = broker.createGeneration(73);
    const first = broker.register(parentGeneration, "first");
    const second = broker.register(parentGeneration, "second");

    const coordinator = new ForkReferenceRecipeCoordinator(
      emptyFunctions(),
      new ForkReferenceTypeCatalog(),
      broker,
    );
    const replayOwnership = coordinator.replay({
      parentGeneration,
      childGeneration,
      wire: encodeForkReferenceRecipes({
        roots: [0, 1],
        nodes: [
          { id: 0, node: { kind: "externref", handle: first } },
          { id: 1, node: { kind: "externref", handle: second } },
        ],
      }),
      target: new RecordingTarget(
        emptyFunctions(),
        new ForkReferenceTypeCatalog(),
      ),
    });
    expect(broker.releaseGeneration(childGeneration)).toBe(true);
    expect(broker.holderCount(first, childGeneration)).toBe(0);
    expect(broker.holderCount(second, childGeneration)).toBe(0);
    expect(() => replayOwnership.release()).toThrow("already released");
  });
});

describe("ForkReferenceTypeCatalog", () => {
  it("binds tag and aggregate arity to one module activation", () => {
    const types = referenceTypes();
    expect(() => types.validateTag(7, 5, 2)).not.toThrow();
    expect(() => types.validateTag(7, 5, 1)).toThrow("expects 2");
    expect(() => types.validateStruct(7, 2, 2)).toThrow("expects 3");
    expect(() => types.validateArray(7, 3)).not.toThrow();
    expect(() => types.validateArray(8, 3)).toThrow("not registered");
    expect(() => types.register(7, {})).toThrow("already registered");
  });
});
