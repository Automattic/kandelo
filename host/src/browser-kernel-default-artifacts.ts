import kernelWasmUrl from "@kernel-wasm?url";
import rootfsVfsUrl from "@rootfs-vfs?url";

/**
 * Default browser artifacts are a product-build concern, not a prerequisite
 * for callers which supply both byte arrays explicitly.
 */
export const browserKernelDefaultArtifactUrls = {
  kernelWasm: kernelWasmUrl,
  rootfsVfs: rootfsVfsUrl,
} as const;
