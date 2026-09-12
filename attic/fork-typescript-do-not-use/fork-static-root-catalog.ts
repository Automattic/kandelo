/**
 * Deterministic identities for GC references recreated by instantiation.
 *
 * A structurally cloned child object is not interchangeable with an immutable
 * global or static element root: `ref.eq` would see two identities. Each
 * instrumented activation therefore exposes an instantiation-time harvest
 * table. The host records only weak identities and immediately clears every
 * table entry. Recipes name roots by `(activationId, ordinal)` and pin only
 * referenced child roots for the duration of replay.
 */

import {
  WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
  WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE,
  WPK_FORK_STATIC_ROOT_CATALOG_MAGIC,
  WPK_FORK_STATIC_ROOT_CATALOG_SECTION,
  WPK_FORK_STATIC_ROOT_CATALOG_VERSION,
  WPK_FORK_STATIC_ROOT_HARVEST_EXPORT,
} from "./generated/abi";

export const FORK_STATIC_ROOT_CATALOG_EXPORT =
  WPK_FORK_STATIC_ROOT_CATALOG_EXPORT;
export const FORK_STATIC_ROOT_HARVEST_EXPORT =
  WPK_FORK_STATIC_ROOT_HARVEST_EXPORT;
export const FORK_STATIC_ROOT_CATALOG_SECTION =
  WPK_FORK_STATIC_ROOT_CATALOG_SECTION;
export const FORK_STATIC_ROOT_CATALOG_VERSION =
  WPK_FORK_STATIC_ROOT_CATALOG_VERSION;
export const FORK_STATIC_ROOT_CATALOG_HEADER_SIZE =
  WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE;

const FORMAT_MAGIC = Uint8Array.from(WPK_FORK_STATIC_ROOT_CATALOG_MAGIC);

export interface ForkStaticRootRecipe {
  readonly moduleActivation: number;
  readonly ordinal: number;
}

interface RegisteredStaticRoots {
  readonly entries: readonly StaticRootHandle[];
}

type StaticRootHandle =
  | { readonly kind: "object"; readonly value: WeakRef<object> }
  | { readonly kind: "primitive"; readonly value: unknown };

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`invalid ${label} ${value}`);
  }
}

function isObjectIdentity(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null)
    || typeof value === "function"
  );
}

export function readForkStaticRootCatalogCount(
  module: WebAssembly.Module,
): number {
  const sections = WebAssembly.Module.customSections(
    module,
    FORK_STATIC_ROOT_CATALOG_SECTION,
  );
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${FORK_STATIC_ROOT_CATALOG_SECTION} section, `
      + `found ${sections.length}`,
    );
  }
  const bytes = new Uint8Array(sections[0]!);
  if (bytes.byteLength !== FORK_STATIC_ROOT_CATALOG_HEADER_SIZE) {
    throw new Error("fork static-root catalog descriptor has an invalid size");
  }
  if (FORMAT_MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("fork static-root catalog descriptor has invalid magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== FORK_STATIC_ROOT_CATALOG_VERSION) {
    throw new Error(`unsupported fork static-root catalog version ${version}`);
  }
  if (view.getUint16(6, true) !== FORK_STATIC_ROOT_CATALOG_HEADER_SIZE) {
    throw new Error("fork static-root catalog descriptor has an invalid header size");
  }
  return view.getUint32(8, true);
}

export function forkStaticRootTableFromInstance(
  module: WebAssembly.Module,
  instance: WebAssembly.Instance,
): WebAssembly.Table {
  const count = readForkStaticRootCatalogCount(module);
  const table = instance.exports[FORK_STATIC_ROOT_CATALOG_EXPORT];
  if (!(table instanceof WebAssembly.Table)) {
    throw new Error(
      `fork activation is missing table export ${FORK_STATIC_ROOT_CATALOG_EXPORT}`,
    );
  }
  if (table.length !== count) {
    throw new Error(
      `fork static-root catalog has ${table.length} entries; descriptor declares ${count}`,
    );
  }
  return table;
}

export function clearForkStaticRootTable(table: WebAssembly.Table): void {
  for (let ordinal = 0; ordinal < table.length; ordinal++) {
    table.set(ordinal, null);
  }
}

/**
 * Process-worker view of every activation's static roots.
 *
 * Aliases are canonicalized when registrations are read. Keeping the first
 * coordinate makes recipe selection deterministic even when an imported
 * immutable global exposes the same object through multiple activations. The
 * weak reverse handles preserve later-fork identity without extending object
 * lifetime after its guest-owned global/table/segment/local releases it.
 */
export class ForkStaticRootCatalog {
  private readonly catalogs = new Map<number, RegisteredStaticRoots>();
  private objectRecipes = new WeakMap<object, ForkStaticRootRecipe>();
  private readonly primitiveRecipes = new Map<unknown, ForkStaticRootRecipe>();

  register(moduleActivation: number, table: WebAssembly.Table): void {
    assertU32(moduleActivation, "static-root module activation");
    if (this.catalogs.has(moduleActivation)) {
      throw new Error(
        `static-root catalog ${moduleActivation} is already registered`,
      );
    }
    const entries: StaticRootHandle[] = [];
    try {
      for (let ordinal = 0; ordinal < table.length; ordinal++) {
        const value = table.get(ordinal);
        entries.push(
          isObjectIdentity(value)
            ? { kind: "object", value: new WeakRef(value) }
            : { kind: "primitive", value },
        );
      }
    } finally {
      // WHY: this table is only an instantiation-time observation window.
      // Retaining entries here would recreate the retired module stash after
      // table mutation or elem.drop.
      clearForkStaticRootTable(table);
    }
    this.catalogs.set(moduleActivation, {
      entries: Object.freeze(entries),
    });
    this.rebuildIndexes();
  }

  unregister(moduleActivation: number): void {
    assertU32(moduleActivation, "static-root module activation");
    if (!this.catalogs.delete(moduleActivation)) return;
    this.rebuildIndexes();
  }

  encode(value: unknown): ForkStaticRootRecipe | null {
    if (value === null) return null;
    return this.lookup(value) ?? null;
  }

  decode(recipe: ForkStaticRootRecipe): unknown {
    assertU32(recipe.moduleActivation, "static-root module activation");
    assertU32(recipe.ordinal, "static-root ordinal");
    const catalog = this.catalogs.get(recipe.moduleActivation);
    if (!catalog) {
      throw new Error(
        `static-root catalog ${recipe.moduleActivation} is not registered`,
      );
    }
    if (recipe.ordinal >= catalog.entries.length) {
      throw new Error(
        `static-root recipe ${recipe.moduleActivation}:${recipe.ordinal} `
        + "is out of bounds",
      );
    }
    const handle = catalog.entries[recipe.ordinal]!;
    if (handle.kind === "primitive") return handle.value;
    const value = handle.value.deref();
    if (value === undefined) {
      throw new Error(
        `static-root recipe ${recipe.moduleActivation}:${recipe.ordinal} `
        + "was collected before replay pinned it",
      );
    }
    return value;
  }

  clear(): void {
    this.catalogs.clear();
    this.objectRecipes = new WeakMap<object, ForkStaticRootRecipe>();
    this.primitiveRecipes.clear();
  }

  private lookup(value: unknown): ForkStaticRootRecipe | undefined {
    return isObjectIdentity(value)
      ? this.objectRecipes.get(value)
      : this.primitiveRecipes.get(value);
  }

  private rebuildIndexes(): void {
    this.objectRecipes = new WeakMap<object, ForkStaticRootRecipe>();
    this.primitiveRecipes.clear();
    const catalogs = [...this.catalogs].sort(
      ([left], [right]) => left - right,
    );
    for (const [moduleActivation, catalog] of catalogs) {
      catalog.entries.forEach((handle, ordinal) => {
        const value = handle.kind === "object"
          ? handle.value.deref()
          : handle.value;
        if (
          value === undefined
          || value === null
          || this.lookup(value) !== undefined
        ) {
          return;
        }
        const recipe = Object.freeze({ moduleActivation, ordinal });
        if (isObjectIdentity(value)) {
          this.objectRecipes.set(value, recipe);
        } else {
          this.primitiveRecipes.set(value, recipe);
        }
      });
    }
  }
}
