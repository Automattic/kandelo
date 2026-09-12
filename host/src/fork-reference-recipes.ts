/**
 * Reference reconstruction recipe MODEL: the node shapes a fork reference
 * graph is expressed in.
 *
 * This is a type-only module. The KFRR wire codec, the instance-local type
 * catalog and the transactional replay coordinator that used to live here
 * were the JavaScript reference engine. Capture now writes KFRV records from
 * `crates/fork-codec` and replay is driven through the co-resident
 * fork-module, so none of them had a production caller.
 *
 * `ReferenceRecipeNode` and `ReferenceRecipeEntry` in
 * `crates/fork-codec/src/reference_recipes.rs` are the authoritative model.
 * The declarations below are the host-side mirror used to type the values
 * that cross the `fm_*` boundary.
 */

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
