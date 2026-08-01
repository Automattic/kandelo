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

export const browserVirtualModuleCapabilities = Object.freeze({
  [browserKernelModuleSpecifier]: "kernel-wasm",
  [browserRootfsModuleSpecifier]: "rootfs-vfs",
});
