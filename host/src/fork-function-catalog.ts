/**
 * Deterministic fresh-instance recipes for Wasm function references.
 *
 * A WebAssembly function object belongs to one JS Agent and cannot be moved to
 * a fork child's Worker. Instrumented modules therefore export an immutable
 * catalog table containing every function that can become a reference. The
 * parent records `(module activation, catalog ordinal)`; after main/side
 * modules are instantiated in the child, the same pair resolves to that
 * instance's fresh function object.
 */

import { snapshotFunctionCatalog } from "./fork-function-catalog-snapshot";

export const FORK_FUNCTION_CATALOG_EXPORT = "__wpk_fork_function_catalog";

export interface ForkFunctionRecipe {
  readonly moduleActivation: number;
  readonly ordinal: number;
}

interface RegisteredCatalog {
  readonly snapshot: WebAssembly.Table;
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`invalid ${label} ${value}`);
  }
}

function recipeKey(moduleActivation: number, ordinal: number): string {
  return `${moduleActivation}:${ordinal}`;
}

export class ForkFunctionCatalog {
  private readonly catalogs = new Map<number, RegisteredCatalog>();
  private recipesByFunction = new WeakMap<CallableFunction, ForkFunctionRecipe>();
  private indexed = false;

  register(moduleActivation: number, table: WebAssembly.Table): void {
    assertU32(moduleActivation, "module activation");
    if (this.catalogs.has(moduleActivation)) {
      throw new Error(`function catalog ${moduleActivation} is already registered`);
    }
    // Copy and validate before publishing any module or recipe state. Keeping
    // references in Wasm avoids exposing unused functions to JavaScript here.
    const snapshot = snapshotFunctionCatalog(table, moduleActivation);
    this.catalogs.set(moduleActivation, { snapshot });
    this.invalidateIndex();
  }

  unregister(moduleActivation: number): void {
    assertU32(moduleActivation, "module activation");
    const catalog = this.catalogs.get(moduleActivation);
    if (!catalog) {
      throw new Error(`function catalog ${moduleActivation} is not registered`);
    }
    this.catalogs.delete(moduleActivation);
    this.invalidateIndex();
  }

  encode(value: unknown): ForkFunctionRecipe | null {
    if (value === null) return null;
    if (typeof value !== "function") {
      throw new TypeError("funcref encoder received a non-function value");
    }
    this.ensureIndex();
    const recipe = this.recipesByFunction.get(value);
    if (!recipe) {
      throw new Error("funcref is absent from the process module catalogs");
    }
    return recipe;
  }

  decode(recipe: ForkFunctionRecipe | null): CallableFunction | null {
    if (recipe === null) return null;
    assertU32(recipe.moduleActivation, "module activation");
    assertU32(recipe.ordinal, "function ordinal");
    const catalog = this.catalogs.get(recipe.moduleActivation);
    if (!catalog) {
      throw new Error(`function catalog ${recipe.moduleActivation} is not registered`);
    }
    if (recipe.ordinal >= catalog.snapshot.length) {
      throw new Error(
        `function recipe ${recipeKey(recipe.moduleActivation, recipe.ordinal)} is out of bounds`,
      );
    }
    return catalog.snapshot.get(recipe.ordinal) as CallableFunction;
  }

  private invalidateIndex(): void {
    // A newly registered lower activation may be the canonical alias, and an
    // unloaded module must never leave recipes referring to its old instance.
    this.recipesByFunction = new WeakMap();
    this.indexed = false;
  }

  private ensureIndex(): void {
    if (this.indexed) return;
    // Build at most once per module set, keeping encode O(1) afterward. Scan
    // activations/ordinals in canonical order so shared imports keep the same
    // recipe regardless of registration order. Decode needs no reverse index.
    for (const activation of [...this.catalogs.keys()].sort((a, b) => a - b)) {
      const snapshot = this.catalogs.get(activation)!.snapshot;
      for (let ordinal = 0; ordinal < snapshot.length; ordinal++) {
        const value = snapshot.get(ordinal) as CallableFunction;
        if (!this.recipesByFunction.has(value)) {
          this.recipesByFunction.set(value, { moduleActivation: activation, ordinal });
        }
      }
    }
    this.indexed = true;
  }

  clear(): void {
    // The private Wasm tables are the strong reference snapshots owned here.
    this.catalogs.clear();
    this.invalidateIndex();
  }
}
