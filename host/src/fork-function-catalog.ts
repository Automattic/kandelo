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

export const FORK_FUNCTION_CATALOG_EXPORT = "__wpk_fork_function_catalog";

export interface ForkFunctionRecipe {
  readonly moduleActivation: number;
  readonly ordinal: number;
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
  private readonly catalogs = new Map<number, CallableFunction[]>();
  private recipesByFunction?: Map<CallableFunction, ForkFunctionRecipe>;

  register(moduleActivation: number, table: WebAssembly.Table): void {
    assertU32(moduleActivation, "module activation");
    if (this.catalogs.has(moduleActivation)) {
      throw new Error(`function catalog ${moduleActivation} is already registered`);
    }
    const entries: Array<CallableFunction> = [];
    for (let ordinal = 0; ordinal < table.length; ordinal++) {
      const value = table.get(ordinal);
      if (typeof value !== "function") {
        throw new Error(
          `function catalog ${moduleActivation} has non-function entry ${ordinal}`,
        );
      }
      entries.push(value);
    }
    this.catalogs.set(moduleActivation, entries);
    this.recipesByFunction = undefined;
  }

  unregister(moduleActivation: number): void {
    assertU32(moduleActivation, "module activation");
    if (!this.catalogs.delete(moduleActivation)) {
      throw new Error(`function catalog ${moduleActivation} is not registered`);
    }
    this.recipesByFunction = undefined;
  }

  encode(value: unknown): ForkFunctionRecipe | null {
    if (value === null) return null;
    if (typeof value !== "function") {
      throw new TypeError("funcref encoder received a non-function value");
    }
    // Replay resolves ordinals directly from the snapshots. Only a capture
    // that encounters a non-null funcref needs the inverse mapping.
    if (!this.recipesByFunction) {
      const recipes = new Map<CallableFunction, ForkFunctionRecipe>();
      for (const [moduleActivation, entries] of this.catalogs) {
        for (const [ordinal, entry] of entries.entries()) {
          const previous = recipes.get(entry);
          // Ordinals arrive in ascending order within each activation.
          if (!previous || moduleActivation < previous.moduleActivation) {
            recipes.set(entry, { moduleActivation, ordinal });
          }
        }
      }
      this.recipesByFunction = recipes;
    }
    const recipe = this.recipesByFunction.get(value as CallableFunction);
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
    const value = catalog[recipe.ordinal];
    if (!value) {
      throw new Error(
        `function recipe ${recipeKey(recipe.moduleActivation, recipe.ordinal)} is out of bounds`,
      );
    }
    return value;
  }

  clear(): void {
    this.catalogs.clear();
    this.recipesByFunction = undefined;
  }
}
