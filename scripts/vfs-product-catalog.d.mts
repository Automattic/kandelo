export interface VfsProductCatalog {
  productById(id: string): unknown;
  homebrewRoots(id: string): readonly Readonly<{
    tap: string;
    formula: string;
    materialization: "embedded" | "lazy";
  }>[];
  productIds: readonly string[];
}

export function loadVfsProductCatalog(catalogPath: string): VfsProductCatalog;
