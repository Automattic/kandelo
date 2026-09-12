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

interface RegisteredCatalog {
  table: WebAssembly.Table;
  entries: Array<CallableFunction>;
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
  private recipesByFunction =
    new WeakMap<CallableFunction, ForkFunctionRecipe[]>();

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
      const recipes = this.recipesByFunction.get(value) ?? [];
      if (!recipes.some((recipe) =>
        recipe.moduleActivation === moduleActivation
        && recipe.ordinal === ordinal
      )) {
        recipes.push({ moduleActivation, ordinal });
        recipes.sort(
          (left, right) =>
            left.moduleActivation - right.moduleActivation
            || left.ordinal - right.ordinal,
        );
        this.recipesByFunction.set(value, recipes);
      }
    }
    this.catalogs.set(moduleActivation, { table, entries });
  }

  unregister(moduleActivation: number): void {
    assertU32(moduleActivation, "module activation");
    const catalog = this.catalogs.get(moduleActivation);
    if (!catalog) {
      throw new Error(`function catalog ${moduleActivation} is not registered`);
    }
    for (const value of new Set(catalog.entries)) {
      const remaining = (this.recipesByFunction.get(value) ?? [])
        .filter((recipe) => recipe.moduleActivation !== moduleActivation);
      this.recipesByFunction.set(value, remaining);
    }
    this.catalogs.delete(moduleActivation);
  }

  encode(value: unknown): ForkFunctionRecipe | null {
    if (value === null) return null;
    if (typeof value !== "function") {
      throw new TypeError("funcref encoder received a non-function value");
    }
    const recipe = this.recipesByFunction.get(value)?.[0];
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
    const value = catalog.entries[recipe.ordinal];
    if (!value) {
      throw new Error(
        `function recipe ${recipeKey(recipe.moduleActivation, recipe.ordinal)} is out of bounds`,
      );
    }
    return value;
  }

  clear(): void {
    // WeakMap entries disappear with their function objects. Catalog entries
    // are the only strong roots owned here and must not outlive replay/abort.
    this.catalogs.clear();
    this.recipesByFunction =
      new WeakMap<CallableFunction, ForkFunctionRecipe[]>();
  }
}
