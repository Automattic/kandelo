import { resolve } from "node:path";

/**
 * Repository-owned aliases shared by Vite and the browser input scanner.
 *
 * WHY: the input scanner decides which package archives CI must materialize.
 * If it maintains a second alias list, a new Vite alias can make the product
 * import package bytes that the scanner never sees.
 */
export function browserRepositoryAliases(repoRoot) {
  return Object.freeze({
    "@host": resolve(repoRoot, "host", "src"),
  });
}

/**
 * Virtual modules whose bytes are supplied outside the JavaScript graph.
 * Callers must bind every discovered capability to either a local build or a
 * fetchable package; recognizing an alias alone is not proof that its bytes
 * exist.
 */
export const browserKernelModuleSpecifier = "@kernel-wasm";
export const browserRootfsModuleSpecifier = "@rootfs-vfs";
/**
 * The wasm32 image-writer module (`crates/kandelo-image-module`) that
 * `KandeloImageFs` instantiates. The browser BUILDS its boot images with it
 * (`apps/browser-demos/lib/kernel-owned-boot.ts` installs its bytes once per
 * page), so a build that cannot supply it cannot boot a machine.
 */
export const browserImageModule32ModuleSpecifier = "@kandelo-image-module32-wasm";
export const browserPagesVfsProductsModuleSpecifier =
  "virtual:kandelo-pages-vfs-products";

export const browserVirtualModuleCapabilities = Object.freeze({
  [browserKernelModuleSpecifier]: "kernel-wasm",
  [browserImageModule32ModuleSpecifier]: "kandelo-image-module32-wasm",
  [browserPagesVfsProductsModuleSpecifier]: "pages-vfs-products",
  [browserRootfsModuleSpecifier]: "rootfs-vfs",
});
