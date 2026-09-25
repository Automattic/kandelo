import kernelWasmUrl from "@kernel-wasm?url";

/**
 * Default browser artifacts are a product-build concern, not a prerequisite
 * for callers which supply both byte arrays explicitly.
 */
export const browserKernelDefaultArtifactUrls = {
  kernelWasm: kernelWasmUrl,
} as const;

/**
 * Resolve the canonical rootfs image URL on demand.
 *
 * WHY this is a dynamic import and not a static one: every browser visitor
 * loads this module for `kernel.wasm`, but the canonical rootfs is only wanted
 * by supporting paths — `/etc` seeding for demos that start from an empty
 * filesystem, the network demo's own machine, and callers that pass
 * `vfsImage: "default"`. A static `@rootfs-vfs?url` import made the rootfs a
 * declared eager dependency of the whole app, so the Pages registry had to
 * publish it eagerly and every boot fetched an image it usually never mounted.
 * Importing it here, behind the branch that actually needs it, keeps the asset
 * in the deployed bundle as its own chunk while leaving the fetch on demand.
 */
export async function browserDefaultRootfsVfsUrl(): Promise<string> {
  const loaded = await import("@rootfs-vfs?url");
  return loaded.default as string;
}
