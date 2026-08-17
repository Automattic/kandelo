/**
 * Versioned, activation-owned reconstruction recipes for Wasm references.
 *
 * The wire image contains only integers and graph edges. JavaScript/Wasm
 * objects stay under an explicit reconstruction owner and never become
 * accidental evidence that a fresh fork Worker inherited module state.
 */

import {
  ForkFunctionCatalog,
  type ForkFunctionRecipe,
} from "./fork-function-catalog";
import {
  ForkExternrefBroker,
  type ForkExternrefGeneration,
  type ForkExternrefLease,
} from "./fork-reference-broker";
import {
  ForkStaticRootCatalog,
  type ForkStaticRootRecipe,
} from "./fork-static-root-catalog";

export const FORK_REFERENCE_RECIPE_VERSION = 1;

const WIRE_MAGIC = 0x5252_464b; // "KFRR", little endian.
const HEADER_SIZE = 40;
const NODE_SIZE = 32;
const MAX_I31 = 0x3fff_ffff;
const MIN_I31 = -0x4000_0000;

// Version 1 is: a 40-byte header, 32-byte node records in ascending recipe-ID
// order, ordered root IDs, one canonical edge vector, then exact scalar
// payload bytes. Fixed records make bounds validation O(1) per node and let
// decoders reject overlapping or reordered edge/blob ranges rather than
// accepting multiple encodings of one graph.

const enum WireNodeKind {
  Null = 0,
  Funcref = 1,
  Externref = 2,
  Exnref = 3,
  I31 = 4,
  Struct = 5,
  Array = 6,
  StaticRoot = 7,
}

export interface ForkReferenceRecipeLimits {
  readonly maxWireBytes: number;
  readonly maxNodes: number;
  readonly maxRoots: number;
  readonly maxEdges: number;
}

const MAX_WIRE_U32 = 0xffff_ffff;

export const DEFAULT_FORK_REFERENCE_RECIPE_LIMITS: ForkReferenceRecipeLimits =
  Object.freeze({
    // These are the version-1 wire fields' representational bounds, not
    // smaller policy quotas. The canonical byte-length equation below is the
    // tighter combined bound and allocation failure remains the truthful
    // resource boundary for a valid process graph.
    maxWireBytes: MAX_WIRE_U32,
    maxNodes: MAX_WIRE_U32,
    maxRoots: MAX_WIRE_U32,
    maxEdges: MAX_WIRE_U32,
  });

export interface ForkNullRecipe {
  readonly kind: "null";
}

export interface ForkFuncrefRecipe {
  readonly kind: "funcref";
  readonly moduleActivation: number;
  readonly functionOrdinal: number;
}

export interface ForkExternrefRecipe {
  readonly kind: "externref";
  readonly handle: number;
}

export interface ForkExnrefRecipe {
  readonly kind: "exnref";
  readonly moduleActivation: number;
  readonly tagOrdinal: number;
  /** Stable artifact-emitted payload layout for this tag. */
  readonly layoutId?: number;
  /** Exact scalar payload bits; reference payloads remain graph edges. */
  readonly scalars?: Uint8Array;
  readonly payloads: readonly number[];
}

export interface ForkI31Recipe {
  readonly kind: "i31";
  readonly value: number;
}

export interface ForkStructRecipe {
  readonly kind: "struct";
  readonly moduleActivation: number;
  readonly typeOrdinal: number;
  readonly layoutId?: number;
  /** Exact packed/non-reference field bits in artifact-catalog order. */
  readonly scalars?: Uint8Array;
  readonly fields: readonly number[];
}

export interface ForkArrayRecipe {
  readonly kind: "array";
  readonly moduleActivation: number;
  readonly typeOrdinal: number;
  readonly layoutId?: number;
  /** Exact element bits for scalar arrays; empty for reference arrays. */
  readonly scalars?: Uint8Array;
  readonly elements: readonly number[];
}

export interface ForkStaticReferenceRootRecipe {
  readonly kind: "static-root";
  readonly moduleActivation: number;
  readonly staticRootOrdinal: number;
}

export type ForkReferenceRecipeNode =
  | ForkNullRecipe
  | ForkFuncrefRecipe
  | ForkExternrefRecipe
  | ForkExnrefRecipe
  | ForkI31Recipe
  | ForkStructRecipe
  | ForkArrayRecipe
  | ForkStaticReferenceRootRecipe;

export interface ForkReferenceRecipeEntry {
  /** Graph-local identity. Aggregate edges and roots refer to this value. */
  readonly id: number;
  readonly node: ForkReferenceRecipeNode;
}

export interface ForkReferenceRecipeGraph {
  readonly roots: readonly number[];
  readonly nodes: readonly ForkReferenceRecipeEntry[];
}

export interface ForkReferenceModuleTypes {
  readonly tags?: readonly {
    readonly ordinal: number;
    readonly payloadCount: number;
  }[];
  readonly structs?: readonly {
    readonly ordinal: number;
    readonly fieldCount: number;
  }[];
  readonly arrays?: readonly {
    readonly ordinal: number;
  }[];
}

interface RegisteredReferenceTypes {
  tags: Map<number, number>;
  structs: Map<number, number>;
  arrays: Set<number>;
}

/**
 * Instance-local ownership for exception tags and Wasm GC type identities.
 *
 * Ordinals are emitted from deterministic artifact catalogs. A child registers
 * the same module-activation/type coordinates after instantiation, before a
 * recipe is allowed to allocate anything.
 */
export class ForkReferenceTypeCatalog {
  private readonly modules = new Map<number, RegisteredReferenceTypes>();

  register(moduleActivation: number, types: ForkReferenceModuleTypes): void {
    assertU32(moduleActivation, "module activation");
    if (this.modules.has(moduleActivation)) {
      throw new Error(
        `reference type catalog ${moduleActivation} is already registered`,
      );
    }

    const registered: RegisteredReferenceTypes = {
      tags: new Map(),
      structs: new Map(),
      arrays: new Set(),
    };
    for (const tag of types.tags ?? []) {
      assertU32(tag.ordinal, "exception tag ordinal");
      assertU32(tag.payloadCount, "exception tag payload count");
      if (registered.tags.has(tag.ordinal)) {
        throw new Error(`duplicate exception tag ordinal ${tag.ordinal}`);
      }
      registered.tags.set(tag.ordinal, tag.payloadCount);
    }
    for (const struct of types.structs ?? []) {
      assertU32(struct.ordinal, "struct type ordinal");
      assertU32(struct.fieldCount, "struct field count");
      if (registered.structs.has(struct.ordinal)) {
        throw new Error(`duplicate struct type ordinal ${struct.ordinal}`);
      }
      registered.structs.set(struct.ordinal, struct.fieldCount);
    }
    for (const array of types.arrays ?? []) {
      assertU32(array.ordinal, "array type ordinal");
      if (registered.arrays.has(array.ordinal)) {
        throw new Error(`duplicate array type ordinal ${array.ordinal}`);
      }
      registered.arrays.add(array.ordinal);
    }
    this.modules.set(moduleActivation, registered);
  }

  validateTag(
    moduleActivation: number,
    tagOrdinal: number,
    payloadCount: number,
  ): void {
    const types = this.requireModule(moduleActivation);
    assertU32(tagOrdinal, "exception tag ordinal");
    const expected = types.tags.get(tagOrdinal);
    if (expected === undefined) {
      throw new Error(
        `exception tag ${moduleActivation}:${tagOrdinal} is not registered`,
      );
    }
    if (expected !== payloadCount) {
      throw new Error(
        `exception tag ${moduleActivation}:${tagOrdinal} expects `
        + `${expected} reference payloads, found ${payloadCount}`,
      );
    }
  }

  validateStruct(
    moduleActivation: number,
    typeOrdinal: number,
    fieldCount: number,
  ): void {
    const types = this.requireModule(moduleActivation);
    assertU32(typeOrdinal, "struct type ordinal");
    const expected = types.structs.get(typeOrdinal);
    if (expected === undefined) {
      throw new Error(
        `struct type ${moduleActivation}:${typeOrdinal} is not registered`,
      );
    }
    if (expected !== fieldCount) {
      throw new Error(
        `struct type ${moduleActivation}:${typeOrdinal} expects `
        + `${expected} reference fields, found ${fieldCount}`,
      );
    }
  }

  validateArray(moduleActivation: number, typeOrdinal: number): void {
    const types = this.requireModule(moduleActivation);
    assertU32(typeOrdinal, "array type ordinal");
    if (!types.arrays.has(typeOrdinal)) {
      throw new Error(
        `array type ${moduleActivation}:${typeOrdinal} is not registered`,
      );
    }
  }

  clear(): void {
    this.modules.clear();
  }

  private requireModule(moduleActivation: number): RegisteredReferenceTypes {
    assertU32(moduleActivation, "module activation");
    const types = this.modules.get(moduleActivation);
    if (!types) {
      throw new Error(
        `reference type catalog ${moduleActivation} is not registered`,
      );
    }
    return types;
  }
}

/**
 * One fresh-instance staging arena.
 *
 * Aggregate allocation and edge initialization are separate so the target can
 * preserve cycles and shared identity. `commit` must atomically install the
 * roots and release its staging roots. `abort` must discard every staged root.
 */
export interface ForkReferenceReplayArena {
  materializeExternref(handle: number): unknown;
  materializeI31(value: number): unknown;
  allocateException(
    moduleActivation: number,
    tagOrdinal: number,
    payloadCount: number,
  ): unknown;
  allocateStruct(
    moduleActivation: number,
    typeOrdinal: number,
    fieldCount: number,
  ): unknown;
  allocateArray(
    moduleActivation: number,
    typeOrdinal: number,
    length: number,
  ): unknown;
  setExceptionPayload(exception: unknown, index: number, value: unknown): void;
  setStructField(struct: unknown, index: number, value: unknown): void;
  setArrayElement(array: unknown, index: number, value: unknown): void;
  commit(roots: readonly unknown[]): void;
  abort(): void;
}

export interface ForkReferenceReplayTarget {
  readonly functions: ForkFunctionCatalog;
  readonly types: ForkReferenceTypeCatalog;
  readonly staticRoots?: ForkStaticRootCatalog;
  beginReferenceReplay(nodeCount: number): ForkReferenceReplayArena;
}

export interface ForkReferenceReplayRequest {
  readonly parentGeneration: ForkExternrefGeneration;
  readonly childGeneration: ForkExternrefGeneration;
  readonly wire: Uint8Array;
  readonly target: ForkReferenceReplayTarget;
}

/**
 * Numeric broker ownership transferred to the child by a successful replay.
 *
 * The coordinator retains no JS/Wasm references after `replay` returns. The
 * process/activation owner releases this lease when the reconstructed values
 * can no longer reach host externrefs.
 */
export interface ForkReferenceReplayOwnership {
  readonly childGeneration: ForkExternrefGeneration;
  readonly childPid: number;
  release(): void;
}

class BrokerReferenceReplayOwnership implements ForkReferenceReplayOwnership {
  private released = false;
  readonly childPid: number;

  constructor(
    readonly childGeneration: ForkExternrefGeneration,
    private readonly lease: ForkExternrefLease,
  ) {
    this.childPid = childGeneration.pid;
  }

  release(): void {
    if (this.released) {
      throw new Error("reference replay ownership is already released");
    }
    this.lease.release();
    this.released = true;
  }
}

export class ForkReferenceRecipeCoordinator {
  constructor(
    private readonly sourceFunctions: ForkFunctionCatalog,
    private readonly sourceTypes: ForkReferenceTypeCatalog,
    private readonly broker: ForkExternrefBroker,
    private readonly limits: ForkReferenceRecipeLimits =
      DEFAULT_FORK_REFERENCE_RECIPE_LIMITS,
    private readonly sourceStaticRoots?: ForkStaticRootCatalog,
  ) {
    validateLimits(limits);
  }

  replay(request: ForkReferenceReplayRequest): ForkReferenceReplayOwnership {
    if (request.parentGeneration === request.childGeneration) {
      throw new Error(
        "fork reference replay requires distinct parent and child generations",
      );
    }

    const graph = decodeForkReferenceRecipes(request.wire, this.limits);
    validateCatalogOwnership(
      graph,
      this.sourceFunctions,
      this.sourceTypes,
      this.sourceStaticRoots,
      "source",
    );
    validateCatalogOwnership(
      graph,
      request.target.functions,
      request.target.types,
      request.target.staticRoots,
      "target",
    );
    const handles = externrefOwnershipSet(graph);

    let lease: ForkExternrefLease | undefined;
    let arena: ForkReferenceReplayArena | undefined;
    const values: unknown[] = new Array(graph.nodes.length);
    let roots: unknown[] = [];
    try {
      lease = this.broker.acquireFork(
        request.parentGeneration,
        request.childGeneration,
        handles,
      );
      arena = request.target.beginReferenceReplay(graph.nodes.length);

      for (const entry of graph.nodes) {
        values[entry.id] = allocateRecipeNode(
          entry.node,
          request.target.functions,
          request.target.staticRoots,
          arena,
        );
      }
      for (const entry of graph.nodes) {
        connectRecipeNode(entry, values, arena);
      }
      roots = graph.roots.map((id) => values[id]);
      arena.commit(roots);

      // WHY: successful installation transfers the only strong roots to the
      // child activation. The coordinator keeps only numeric broker ownership.
      values.fill(undefined);
      roots.fill(undefined);
      return new BrokerReferenceReplayOwnership(
        request.childGeneration,
        lease,
      );
    } catch (error) {
      const rollbackErrors: unknown[] = [error];
      if (arena) {
        try {
          arena.abort();
        } catch (abortError) {
          rollbackErrors.push(abortError);
        }
      }
      values.fill(undefined);
      roots.fill(undefined);
      if (lease) {
        try {
          lease.release();
        } catch (releaseError) {
          rollbackErrors.push(releaseError);
        }
      }
      if (rollbackErrors.length === 1) throw error;
      throw new AggregateError(
        rollbackErrors,
        "reference replay failed and rollback was incomplete",
      );
    }
  }
}

export function encodeForkReferenceRecipes(
  graph: ForkReferenceRecipeGraph,
  limits: ForkReferenceRecipeLimits =
    DEFAULT_FORK_REFERENCE_RECIPE_LIMITS,
): Uint8Array {
  validateLimits(limits);
  if (graph.nodes.length > limits.maxNodes) {
    throw new RangeError(
      `reference recipe has ${graph.nodes.length} nodes; limit is ${limits.maxNodes}`,
    );
  }
  if (graph.roots.length > limits.maxRoots) {
    throw new RangeError(
      `reference recipe has ${graph.roots.length} roots; limit is ${limits.maxRoots}`,
    );
  }

  const ordered = graph.nodes.slice().sort((left, right) => left.id - right.id);
  const remap = new Map<number, number>();
  for (const [wireId, entry] of ordered.entries()) {
    assertU32(entry.id, `reference recipe node ${wireId} id`);
    if (remap.has(entry.id)) {
      throw new Error(`duplicate reference recipe node id ${entry.id}`);
    }
    remap.set(entry.id, wireId);
    validateNodeScalars(entry.node, `reference recipe node ${entry.id}`);
  }

  const canonicalNodes: ForkReferenceRecipeEntry[] = ordered.map(
    (entry, id) => ({
      id,
      node: remapNodeEdges(entry.node, remap, `reference recipe node ${entry.id}`),
    }),
  );
  const roots = graph.roots.map((id, index) =>
    remapRequiredId(remap, id, `reference recipe root ${index}`)
  );
  const canonical: ForkReferenceRecipeGraph = { roots, nodes: canonicalNodes };
  validateReachability(canonical);

  const edgeCount = canonicalNodes.reduce(
    (count, entry) => checkedAdd(count, nodeEdges(entry.node).length, "edge count"),
    0,
  );
  if (edgeCount > limits.maxEdges) {
    throw new RangeError(
      `reference recipe has ${edgeCount} edges; limit is ${limits.maxEdges}`,
    );
  }
  const blobByteLength = canonicalNodes.reduce(
    (count, entry) =>
      checkedAdd(count, nodeScalarBytes(entry.node).byteLength, "scalar blob byte length"),
    0,
  );
  const totalBytes = wireByteLength(
    canonicalNodes.length,
    roots.length,
    edgeCount,
    blobByteLength,
  );
  if (totalBytes > limits.maxWireBytes) {
    throw new RangeError(
      `reference recipe needs ${totalBytes} bytes; limit is ${limits.maxWireBytes}`,
    );
  }

  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, WIRE_MAGIC, true);
  view.setUint16(4, FORK_REFERENCE_RECIPE_VERSION, true);
  view.setUint16(6, HEADER_SIZE, true);
  view.setUint32(8, totalBytes, true);
  view.setUint32(12, canonicalNodes.length, true);
  view.setUint32(16, roots.length, true);
  view.setUint32(20, edgeCount, true);
  view.setUint32(24, blobByteLength, true);
  view.setUint32(28, NODE_SIZE, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, 0, true);

  const rootsOffset = HEADER_SIZE + canonicalNodes.length * NODE_SIZE;
  const edgesOffset = rootsOffset + roots.length * 4;
  const blobsOffset = edgesOffset + edgeCount * 4;
  let nextEdge = 0;
  let nextBlobByte = 0;
  for (const entry of canonicalNodes) {
    const offset = HEADER_SIZE + entry.id * NODE_SIZE;
    const edges = nodeEdges(entry.node);
    const blob = nodeScalarBytes(entry.node);
    encodeNodeRecord(
      view,
      offset,
      entry.node,
      nextEdge,
      edges.length,
      nextBlobByte,
      blob.byteLength,
    );
    for (const edge of edges) {
      view.setUint32(edgesOffset + nextEdge * 4, edge, true);
      nextEdge++;
    }
    bytes.set(blob, blobsOffset + nextBlobByte);
    nextBlobByte += blob.byteLength;
  }
  for (const [index, root] of roots.entries()) {
    view.setUint32(rootsOffset + index * 4, root, true);
  }
  return bytes;
}

export function decodeForkReferenceRecipes(
  bytes: Uint8Array,
  limits: ForkReferenceRecipeLimits =
    DEFAULT_FORK_REFERENCE_RECIPE_LIMITS,
): ForkReferenceRecipeGraph {
  validateLimits(limits);
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error("reference recipe header is truncated");
  }
  if (bytes.byteLength > limits.maxWireBytes) {
    throw new RangeError(
      `reference recipe has ${bytes.byteLength} bytes; limit is ${limits.maxWireBytes}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== WIRE_MAGIC) {
    throw new Error("reference recipe has invalid magic");
  }
  const version = view.getUint16(4, true);
  if (version !== FORK_REFERENCE_RECIPE_VERSION) {
    throw new Error(`unsupported reference recipe version ${version}`);
  }
  if (view.getUint16(6, true) !== HEADER_SIZE) {
    throw new Error("reference recipe declares an invalid header size");
  }
  if (view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error("reference recipe declared byte length does not match its buffer");
  }
  const nodeCount = view.getUint32(12, true);
  const rootCount = view.getUint32(16, true);
  const edgeCount = view.getUint32(20, true);
  const blobByteLength = view.getUint32(24, true);
  if (nodeCount > limits.maxNodes) {
    throw new RangeError(
      `reference recipe has ${nodeCount} nodes; limit is ${limits.maxNodes}`,
    );
  }
  if (rootCount > limits.maxRoots) {
    throw new RangeError(
      `reference recipe has ${rootCount} roots; limit is ${limits.maxRoots}`,
    );
  }
  if (edgeCount > limits.maxEdges) {
    throw new RangeError(
      `reference recipe has ${edgeCount} edges; limit is ${limits.maxEdges}`,
    );
  }
  if (view.getUint32(28, true) !== NODE_SIZE) {
    throw new Error("reference recipe declares an invalid node record size");
  }
  if (view.getUint32(32, true) !== 0 || view.getUint32(36, true) !== 0) {
    throw new Error("reference recipe reserved header fields are nonzero");
  }
  const expectedBytes = wireByteLength(
    nodeCount,
    rootCount,
    edgeCount,
    blobByteLength,
  );
  if (expectedBytes !== bytes.byteLength) {
    throw new Error(
      `reference recipe layout needs ${expectedBytes} bytes, `
      + `found ${bytes.byteLength}`,
    );
  }

  const rootsOffset = HEADER_SIZE + nodeCount * NODE_SIZE;
  const edgesOffset = rootsOffset + rootCount * 4;
  const blobsOffset = edgesOffset + edgeCount * 4;
  const edgeIds = new Uint32Array(edgeCount);
  for (let index = 0; index < edgeCount; index++) {
    const id = view.getUint32(edgesOffset + index * 4, true);
    if (id >= nodeCount) {
      throw new Error(`reference recipe edge ${index} targets missing node ${id}`);
    }
    edgeIds[index] = id;
  }

  let expectedEdgeStart = 0;
  let expectedBlobStart = 0;
  const nodes: ForkReferenceRecipeEntry[] = [];
  for (let id = 0; id < nodeCount; id++) {
    const offset = HEADER_SIZE + id * NODE_SIZE;
    const decoded = decodeNodeRecord(
      view,
      offset,
      id,
      edgeIds,
      expectedEdgeStart,
      bytes.subarray(blobsOffset, blobsOffset + blobByteLength),
      expectedBlobStart,
    );
    expectedEdgeStart += nodeEdges(decoded).length;
    expectedBlobStart += nodeScalarBytes(decoded).byteLength;
    nodes.push(Object.freeze({ id, node: decoded }));
  }
  if (expectedEdgeStart !== edgeCount) {
    throw new Error(
      `reference recipe node records consume ${expectedEdgeStart} edges, `
      + `header declares ${edgeCount}`,
    );
  }
  if (expectedBlobStart !== blobByteLength) {
    throw new Error(
      `reference recipe node records consume ${expectedBlobStart} scalar bytes, `
      + `header declares ${blobByteLength}`,
    );
  }

  const roots: number[] = [];
  for (let index = 0; index < rootCount; index++) {
    const id = view.getUint32(rootsOffset + index * 4, true);
    if (id >= nodeCount) {
      throw new Error(`reference recipe root ${index} targets missing node ${id}`);
    }
    roots.push(id);
  }
  const graph: ForkReferenceRecipeGraph = Object.freeze({
    roots: Object.freeze(roots),
    nodes: Object.freeze(nodes),
  });
  validateReachability(graph);
  return graph;
}

function validateCatalogOwnership(
  graph: ForkReferenceRecipeGraph,
  functions: ForkFunctionCatalog,
  types: ForkReferenceTypeCatalog,
  staticRoots: ForkStaticRootCatalog | undefined,
  side: "source" | "target",
): void {
  for (const entry of graph.nodes) {
    const node = entry.node;
    try {
      switch (node.kind) {
        case "funcref":
          functions.decode(functionRecipe(node));
          break;
        case "exnref":
          types.validateTag(
            node.moduleActivation,
            node.tagOrdinal,
            node.payloads.length,
          );
          break;
        case "struct":
          types.validateStruct(
            node.moduleActivation,
            node.typeOrdinal,
            node.fields.length,
          );
          break;
        case "array":
          types.validateArray(node.moduleActivation, node.typeOrdinal);
          break;
        case "static-root":
          if (!staticRoots) {
            throw new Error("static-root catalog is not registered");
          }
          staticRoots.decode(staticRootRecipe(node));
          break;
        case "null":
        case "externref":
        case "i31":
          break;
      }
    } catch (error) {
      throw new Error(
        `${side} catalog rejected reference recipe node ${entry.id}: `
        + `${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function allocateRecipeNode(
  node: ForkReferenceRecipeNode,
  functions: ForkFunctionCatalog,
  staticRoots: ForkStaticRootCatalog | undefined,
  arena: ForkReferenceReplayArena,
): unknown {
  switch (node.kind) {
    case "null":
      return null;
    case "funcref":
      return functions.decode(functionRecipe(node));
    case "externref":
      return arena.materializeExternref(node.handle);
    case "exnref":
      return arena.allocateException(
        node.moduleActivation,
        node.tagOrdinal,
        node.payloads.length,
      );
    case "i31":
      return arena.materializeI31(node.value);
    case "struct":
      return arena.allocateStruct(
        node.moduleActivation,
        node.typeOrdinal,
        node.fields.length,
      );
    case "array":
      return arena.allocateArray(
        node.moduleActivation,
        node.typeOrdinal,
        node.elements.length,
      );
    case "static-root":
      if (!staticRoots) {
        throw new Error("static-root catalog is not registered");
      }
      return staticRoots.decode(staticRootRecipe(node));
  }
}

function connectRecipeNode(
  entry: ForkReferenceRecipeEntry,
  values: readonly unknown[],
  arena: ForkReferenceReplayArena,
): void {
  const value = values[entry.id];
  switch (entry.node.kind) {
    case "exnref":
      entry.node.payloads.forEach((payload, index) => {
        arena.setExceptionPayload(value, index, values[payload]);
      });
      break;
    case "struct":
      entry.node.fields.forEach((field, index) => {
        arena.setStructField(value, index, values[field]);
      });
      break;
    case "array":
      entry.node.elements.forEach((element, index) => {
        arena.setArrayElement(value, index, values[element]);
      });
      break;
    case "null":
    case "funcref":
    case "externref":
    case "i31":
    case "static-root":
      break;
  }
}

function externrefOwnershipSet(
  graph: ForkReferenceRecipeGraph,
): Set<number> {
  const handles = new Set<number>();
  // WHY: reference-graph multiplicity expresses Wasm aliasing, not independent
  // host lifetime. One process execution generation owns one lease per opaque
  // identity no matter how many roots or aggregate fields point at it.
  const addIfExternref = (id: number): void => {
    const node = graph.nodes[id]?.node;
    if (node?.kind !== "externref") return;
    handles.add(node.handle);
  };
  graph.roots.forEach(addIfExternref);
  for (const entry of graph.nodes) {
    nodeEdges(entry.node).forEach(addIfExternref);
  }
  return handles;
}

function functionRecipe(node: ForkFuncrefRecipe): ForkFunctionRecipe {
  return {
    moduleActivation: node.moduleActivation,
    ordinal: node.functionOrdinal,
  };
}

function staticRootRecipe(
  node: ForkStaticReferenceRootRecipe,
): ForkStaticRootRecipe {
  return {
    moduleActivation: node.moduleActivation,
    ordinal: node.staticRootOrdinal,
  };
}

function encodeNodeRecord(
  view: DataView,
  offset: number,
  node: ForkReferenceRecipeNode,
  edgeStart: number,
  edgeCount: number,
  blobStart: number,
  blobByteLength: number,
): void {
  let kind: WireNodeKind;
  let first = 0;
  let second = 0;
  let third = 0;
  switch (node.kind) {
    case "null":
      kind = WireNodeKind.Null;
      break;
    case "funcref":
      kind = WireNodeKind.Funcref;
      first = node.moduleActivation;
      second = node.functionOrdinal;
      break;
    case "externref": {
      kind = WireNodeKind.Externref;
      const handle = BigInt(node.handle);
      first = Number(handle & 0xffff_ffffn);
      second = Number(handle >> 32n);
      break;
    }
    case "exnref":
      kind = WireNodeKind.Exnref;
      first = node.moduleActivation;
      second = node.tagOrdinal;
      third = node.layoutId ?? 0;
      break;
    case "i31":
      kind = WireNodeKind.I31;
      first = node.value >>> 0;
      break;
    case "struct":
      kind = WireNodeKind.Struct;
      first = node.moduleActivation;
      second = node.typeOrdinal;
      third = node.layoutId ?? 0;
      break;
    case "array":
      kind = WireNodeKind.Array;
      first = node.moduleActivation;
      second = node.typeOrdinal;
      third = node.layoutId ?? 0;
      break;
    case "static-root":
      kind = WireNodeKind.StaticRoot;
      first = node.moduleActivation;
      second = node.staticRootOrdinal;
      break;
  }
  const aggregate =
    node.kind === "exnref" || node.kind === "struct" || node.kind === "array";
  const recordEdgeStart = aggregate ? edgeStart : 0;
  const recordBlobStart = aggregate ? blobStart : 0;
  view.setUint8(offset, kind);
  view.setUint8(offset + 1, 0);
  view.setUint16(offset + 2, 0, true);
  view.setUint32(offset + 4, first, true);
  view.setUint32(offset + 8, second, true);
  view.setUint32(offset + 12, third, true);
  view.setUint32(offset + 16, recordEdgeStart, true);
  view.setUint32(offset + 20, edgeCount, true);
  view.setUint32(offset + 24, recordBlobStart, true);
  view.setUint32(offset + 28, blobByteLength, true);
}

function decodeNodeRecord(
  view: DataView,
  offset: number,
  id: number,
  edges: Uint32Array,
  expectedEdgeStart: number,
  blobs: Uint8Array,
  expectedBlobStart: number,
): ForkReferenceRecipeNode {
  const context = `reference recipe node ${id}`;
  const kind = view.getUint8(offset);
  if (
    view.getUint8(offset + 1) !== 0
    || view.getUint16(offset + 2, true) !== 0
  ) {
    throw new Error(`${context} has nonzero flags or reserved fields`);
  }
  const first = view.getUint32(offset + 4, true);
  const second = view.getUint32(offset + 8, true);
  const third = view.getUint32(offset + 12, true);
  const edgeStart = view.getUint32(offset + 16, true);
  const edgeCount = view.getUint32(offset + 20, true);
  const blobStart = view.getUint32(offset + 24, true);
  const blobByteLength = view.getUint32(offset + 28, true);
  const edgeEnd = checkedAdd(edgeStart, edgeCount, `${context} edge range`);
  if (edgeEnd > edges.length) {
      throw new Error(`${context} edge range exceeds the shared edge vector`);
  }
  const blobEnd = checkedAdd(
    blobStart,
    blobByteLength,
    `${context} scalar blob range`,
  );
  if (blobEnd > blobs.byteLength) {
    throw new Error(`${context} scalar blob range exceeds the shared blob vector`);
  }

  const requireNoAggregateData = (): void => {
    if (
      edgeStart !== 0
      || edgeCount !== 0
      || blobStart !== 0
      || blobByteLength !== 0
    ) {
      throw new Error(`${context} scalar record declares graph edges or payload bytes`);
    }
  };
  const requireZeroScalars = (): void => {
    if (first !== 0 || second !== 0 || third !== 0) {
      throw new Error(`${context} has noncanonical scalar fields`);
    }
  };
  const aggregateEdges = (): readonly number[] => {
    if (edgeStart !== expectedEdgeStart) {
      throw new Error(
        `${context} has noncanonical edge start ${edgeStart}; `
        + `expected ${expectedEdgeStart}`,
      );
    }
    return Object.freeze(Array.from(edges.subarray(edgeStart, edgeEnd)));
  };
  const aggregateBlob = (): Uint8Array => {
    if (blobStart !== expectedBlobStart) {
      throw new Error(
        `${context} has noncanonical scalar blob start ${blobStart}; `
        + `expected ${expectedBlobStart}`,
      );
    }
    return blobs.slice(blobStart, blobEnd);
  };

  let node: ForkReferenceRecipeNode;
  switch (kind) {
    case WireNodeKind.Null:
      requireNoAggregateData();
      requireZeroScalars();
      node = { kind: "null" };
      break;
    case WireNodeKind.Funcref:
      requireNoAggregateData();
      if (third !== 0) {
        throw new Error(`${context} funcref reserved scalar field is nonzero`);
      }
      node = {
        kind: "funcref",
        moduleActivation: first,
        functionOrdinal: second,
      };
      break;
    case WireNodeKind.Externref: {
      requireNoAggregateData();
      if (third !== 0) {
        throw new Error(`${context} externref reserved scalar field is nonzero`);
      }
      const handle = Number((BigInt(second) << 32n) | BigInt(first));
      assertHandle(handle, `${context} externref handle`);
      node = { kind: "externref", handle };
      break;
    }
    case WireNodeKind.Exnref:
      node = {
        kind: "exnref",
        moduleActivation: first,
        tagOrdinal: second,
        layoutId: third,
        scalars: aggregateBlob(),
        payloads: aggregateEdges(),
      };
      break;
    case WireNodeKind.I31:
      requireNoAggregateData();
      if (second !== 0 || third !== 0) {
        throw new Error(`${context} i31 reserved scalar field is nonzero`);
      }
      node = { kind: "i31", value: first | 0 };
      break;
    case WireNodeKind.Struct:
      node = {
        kind: "struct",
        moduleActivation: first,
        typeOrdinal: second,
        layoutId: third,
        scalars: aggregateBlob(),
        fields: aggregateEdges(),
      };
      break;
    case WireNodeKind.Array:
      node = {
        kind: "array",
        moduleActivation: first,
        typeOrdinal: second,
        layoutId: third,
        scalars: aggregateBlob(),
        elements: aggregateEdges(),
      };
      break;
    case WireNodeKind.StaticRoot:
      requireNoAggregateData();
      if (third !== 0) {
        throw new Error(`${context} static-root reserved scalar field is nonzero`);
      }
      node = {
        kind: "static-root",
        moduleActivation: first,
        staticRootOrdinal: second,
      };
      break;
    default:
      throw new Error(`${context} has unknown kind ${kind}`);
  }
  validateNodeScalars(node, context);
  return Object.freeze(node);
}

function remapNodeEdges(
  node: ForkReferenceRecipeNode,
  remap: ReadonlyMap<number, number>,
  context: string,
): ForkReferenceRecipeNode {
  switch (node.kind) {
    case "exnref":
      return {
        ...node,
        scalars: nodeScalarBytes(node).slice(),
        payloads: node.payloads.map((id, index) =>
          remapRequiredId(remap, id, `${context} payload ${index}`)
        ),
      };
    case "struct":
      return {
        ...node,
        scalars: nodeScalarBytes(node).slice(),
        fields: node.fields.map((id, index) =>
          remapRequiredId(remap, id, `${context} field ${index}`)
        ),
      };
    case "array":
      return {
        ...node,
        scalars: nodeScalarBytes(node).slice(),
        elements: node.elements.map((id, index) =>
          remapRequiredId(remap, id, `${context} element ${index}`)
        ),
      };
    case "null":
    case "funcref":
    case "externref":
    case "i31":
    case "static-root":
      return { ...node };
  }
}

function remapRequiredId(
  remap: ReadonlyMap<number, number>,
  id: number,
  context: string,
): number {
  assertU32(id, context);
  const mapped = remap.get(id);
  if (mapped === undefined) {
    throw new Error(`${context} targets missing node ${id}`);
  }
  return mapped;
}

function nodeEdges(node: ForkReferenceRecipeNode): readonly number[] {
  switch (node.kind) {
    case "exnref":
      return node.payloads;
    case "struct":
      return node.fields;
    case "array":
      return node.elements;
    case "null":
    case "funcref":
    case "externref":
    case "i31":
    case "static-root":
      return [];
  }
}

function nodeScalarBytes(node: ForkReferenceRecipeNode): Uint8Array {
  switch (node.kind) {
    case "exnref":
    case "struct":
    case "array":
      return node.scalars ?? new Uint8Array();
    case "null":
    case "funcref":
    case "externref":
    case "i31":
    case "static-root":
      return new Uint8Array();
  }
}

function validateNodeScalars(
  node: ForkReferenceRecipeNode,
  context: string,
): void {
  switch (node.kind) {
    case "null":
      return;
    case "funcref":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.functionOrdinal, `${context} function ordinal`);
      return;
    case "externref":
      assertHandle(node.handle, `${context} externref handle`);
      return;
    case "exnref":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.tagOrdinal, `${context} tag ordinal`);
      assertU32(node.layoutId ?? 0, `${context} layout id`);
      if (!(nodeScalarBytes(node) instanceof Uint8Array)) {
        throw new TypeError(`${context} scalar payload is not a Uint8Array`);
      }
      assertU32(node.payloads.length, `${context} payload count`);
      return;
    case "i31":
      if (
        !Number.isInteger(node.value)
        || node.value < MIN_I31
        || node.value > MAX_I31
      ) {
        throw new RangeError(`${context} has invalid i31 value ${node.value}`);
      }
      return;
    case "struct":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.typeOrdinal, `${context} type ordinal`);
      assertU32(node.layoutId ?? 0, `${context} layout id`);
      if (!(nodeScalarBytes(node) instanceof Uint8Array)) {
        throw new TypeError(`${context} scalar payload is not a Uint8Array`);
      }
      assertU32(node.fields.length, `${context} field count`);
      return;
    case "array":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.typeOrdinal, `${context} type ordinal`);
      assertU32(node.layoutId ?? 0, `${context} layout id`);
      if (!(nodeScalarBytes(node) instanceof Uint8Array)) {
        throw new TypeError(`${context} scalar payload is not a Uint8Array`);
      }
      assertU32(node.elements.length, `${context} element count`);
      return;
    case "static-root":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.staticRootOrdinal, `${context} static-root ordinal`);
      return;
  }
}

function validateReachability(graph: ForkReferenceRecipeGraph): void {
  const reached = new Uint8Array(graph.nodes.length);
  const pending = [...graph.roots];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reached[id] !== 0) continue;
    reached[id] = 1;
    for (const edge of nodeEdges(graph.nodes[id]!.node)) pending.push(edge);
  }
  const unreachable = reached.findIndex((value) => value === 0);
  if (unreachable !== -1) {
    throw new Error(
      `reference recipe node ${unreachable} is unreachable from every root`,
    );
  }
}

function wireByteLength(
  nodeCount: number,
  rootCount: number,
  edgeCount: number,
  blobByteLength: number,
): number {
  const nodesEnd = checkedAdd(
    HEADER_SIZE,
    checkedMultiply(nodeCount, NODE_SIZE, "node byte length"),
    "node section end",
  );
  const rootsEnd = checkedAdd(
    nodesEnd,
    checkedMultiply(rootCount, 4, "root byte length"),
    "root section end",
  );
  const edgesEnd = checkedAdd(
    rootsEnd,
    checkedMultiply(edgeCount, 4, "edge byte length"),
    "edge section end",
  );
  return checkedAdd(edgesEnd, blobByteLength, "wire byte length");
}

function validateLimits(limits: ForkReferenceRecipeLimits): void {
  for (const [label, value] of [
    ["wire byte", limits.maxWireBytes],
    ["node", limits.maxNodes],
    ["root", limits.maxRoots],
    ["edge", limits.maxEdges],
  ] as const) {
    if (
      !Number.isSafeInteger(value)
      || value < 0
      || value > 0xffff_ffff
    ) {
      throw new RangeError(`invalid reference recipe ${label} limit ${value}`);
    }
  }
  if (limits.maxWireBytes < HEADER_SIZE) {
    throw new RangeError(
      `reference recipe wire byte limit must be at least ${HEADER_SIZE}`,
    );
  }
}

function checkedAdd(left: number, right: number, context: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${context} exceeds the host safe integer range`);
  }
  return value;
}

function checkedMultiply(left: number, right: number, context: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${context} exceeds the host safe integer range`);
  }
  return value;
}

function assertU32(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${context} is not an unsigned 32-bit integer`);
  }
}

function assertHandle(value: number, context: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new RangeError(`${context} is not a positive unsigned 32-bit integer`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
