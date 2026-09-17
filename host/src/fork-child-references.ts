/**
 * What a fresh child can be told about a reference BEFORE anything is
 * instantiated.
 *
 * The child's import objects may carry references -- a funcref, a host
 * externref, a statically rooted value -- and those have to exist before the
 * instance that would otherwise produce them. That is the whole reason this
 * exists, and it is why it is deliberately much smaller than the replay
 * transaction: at this moment no activation is live, so the only answerable
 * questions are which activation must exist first, and what a leaf reference
 * reconstructs to.
 *
 * Every fact comes from the module's decoded graph. What the host adds is the
 * one thing wasm cannot do: turn a coordinate into a live JavaScript reference.
 * A funcref becomes a `Table.get` on the merged catalog, an externref becomes a
 * `resolve_externref` on the broker handle -- the identity floor the 2026-09-03
 * probe found and could not move.
 *
 * WHAT IS NOT HERE, against the 1,619-line attic provider it replaces:
 *
 *  - `activationDependencies`, the full reachable closure. It needs the graph's
 *    EDGES, which no `fm_*` entry exposes, and it exists for typed GC
 *    aggregates -- which this refuses anyway, because materializing one needs
 *    the module's drive rather than a host lookup. The planner falls back to
 *    the direct owner, which the attic's own comment says is what
 *    `ownerActivation` always meant.
 *  - `adoptInto`, which handed early-materialized roots to the replay
 *    transaction. `fm_attach_child` seeds the driver from the arena now, so
 *    there is nothing to hand over.
 *  - The scratch allocator, the GC transit staging and the one-shot poisoning
 *    that went with them. This allocates nothing, so there is nothing to
 *    release on failure.
 */

/** `wire_node_kind` in `crates/fork-module/src/lib.rs`. */
const KIND_NULL = 0;
const KIND_FUNCREF = 1;
const KIND_EXTERNREF = 2;
const KIND_EXNREF = 3;
const KIND_I31 = 4;
const KIND_STRUCT = 5;
const KIND_ARRAY = 6;
const KIND_STATIC_ROOT = 7;

/** `WPK_FORK_MODULE_STATE_GLOBAL_TYPE_*`, for the type a binding declared. */
const TYPE_FUNCREF = 6;
const TYPE_EXTERNREF = 7;
const TYPE_EXNREF = 8;
const TYPE_ANYREF = 9;

/** The module reads this graph; the host only asks it questions. */
export interface ForkChildReferenceGraph {
  decodedNodeKind(index: number): number;
  decodedNodeModuleActivation(index: number): number;
  /** `fm_funcref_ordinal`: the merged-catalog slot a funcref recipe names. */
  funcrefOrdinal(recipeId: number): number;
  /** `fm_externref_handle`: the broker handle an externref recipe names. */
  externrefHandle(recipeId: number): number;
  /** `fm_static_root_slot`: the catalog slot a static-root recipe names. */
  staticRootSlot(recipeId: number): number;
}

/** The two host tables a coordinate resolves through, plus the broker. */
export interface ForkChildReferenceFloor {
  readonly functionCatalog: WebAssembly.Table;
  readonly staticRootCatalog: WebAssembly.Table;
  /** The canonical host token for a broker handle. */
  resolveExternref(handle: number): unknown;
}

export class ForkChildReferences {
  constructor(
    private readonly graph: ForkChildReferenceGraph,
    private readonly floor: ForkChildReferenceFloor,
    private readonly label: string,
  ) {}

  /**
   * The activation that must be instantiated before `recipeId` resolves, or
   * null when nothing must be.
   *
   * Null is the ordinary answer for a host externref and for a null reference:
   * neither belongs to any activation, so making one a dependency would order
   * the child against an activation that has nothing to do with it.
   */
  ownerActivation(recipeId: number, typeCode: number): number | null {
    const kind = this.requireCompatible(recipeId, typeCode);
    if (kind === KIND_NULL || kind === KIND_EXTERNREF || kind === KIND_I31) {
      return null;
    }
    return this.graph.decodedNodeModuleActivation(recipeId);
  }

  /**
   * Reconstruct the reference `recipeId` names, at the type its binding
   * declared.
   *
   * The declared type is checked against the graph's kind rather than trusted,
   * because these two facts come from different records written at different
   * times: a mismatch means the arena disagrees with itself, and binding the
   * wrong reference into an import object is silent.
   */
  materialize(recipeId: number, typeCode: number): unknown {
    const kind = this.requireCompatible(recipeId, typeCode);
    switch (kind) {
      case KIND_NULL:
        return null;
      case KIND_FUNCREF: {
        const ordinal = this.graph.funcrefOrdinal(recipeId);
        const value = this.floor.functionCatalog.get(ordinal);
        if (typeof value !== "function") {
          throw new Error(
            `${this.label}: funcref recipe ${recipeId} names catalog slot `
              + `${ordinal}, which holds no function`,
          );
        }
        return value;
      }
      case KIND_EXTERNREF:
        return this.floor.resolveExternref(this.graph.externrefHandle(recipeId));
      case KIND_STATIC_ROOT: {
        const slot = this.graph.staticRootSlot(recipeId);
        return this.floor.staticRootCatalog.get(slot);
      }
      case KIND_EXNREF:
        // Not a limitation of this file: an `exnref` value cannot cross into a
        // JavaScript import at all. A child that needs one imports its owning
        // activation's exported Global instead.
        throw new Error(
          `${this.label}: exnref recipe ${recipeId} cannot cross JavaScript; `
            + `import its activation's WebAssembly.Global instead`,
        );
      case KIND_I31:
      case KIND_STRUCT:
      case KIND_ARRAY:
        // A typed GC value is rebuilt by the module driving the owning
        // activation's codec, which cannot run before that activation exists.
        // Refusing here is what keeps a child from being handed a placeholder
        // where a live aggregate belongs.
        throw new Error(
          `${this.label}: recipe ${recipeId} is a typed GC value (kind ${kind}); `
            + `it is reconstructed by the module's drive, not before `
            + `instantiation`,
        );
      default:
        throw new Error(
          `${this.label}: recipe ${recipeId} has unknown node kind ${kind}`,
        );
    }
  }

  /** The graph's kind for `recipeId`, checked against the declared type. */
  private requireCompatible(recipeId: number, typeCode: number): number {
    if (!Number.isInteger(recipeId) || recipeId < 0) {
      throw new Error(`${this.label}: ${recipeId} is not a recipe id`);
    }
    const kind = this.graph.decodedNodeKind(recipeId);
    if (kind === KIND_NULL) return kind;
    const admissible = typeCode === TYPE_FUNCREF
      ? kind === KIND_FUNCREF || kind === KIND_STATIC_ROOT
      : typeCode === TYPE_EXTERNREF
        ? kind === KIND_EXTERNREF || kind === KIND_STATIC_ROOT
        : typeCode === TYPE_EXNREF
          ? kind === KIND_EXNREF
          : typeCode === TYPE_ANYREF
            ? kind === KIND_I31 || kind === KIND_STRUCT || kind === KIND_ARRAY
              || kind === KIND_STATIC_ROOT
            : false;
    if (!admissible) {
      throw new Error(
        `${this.label}: recipe ${recipeId} is node kind ${kind}, which cannot `
          + `be imported at declared type ${typeCode}`,
      );
    }
    return kind;
  }
}
