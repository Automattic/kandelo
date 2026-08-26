export interface VfsProductCatalog {
  productById(id: string): unknown;
  productIds: readonly string[];
}

export function loadVfsProductCatalog(catalogPath: string): VfsProductCatalog;
