// The protected evidence harness always supplies the exact attested kernel and
// candidate VFS bytes. If the exact host unexpectedly asks for product-build
// defaults, these closed same-origin paths fail instead of resolving an
// undeclared ambient artifact.
export const browserKernelDefaultArtifactUrls = {
  kernelWasm: "/__abi_staging_forbidden/default-kernel.wasm",
  rootfsVfs: "/__abi_staging_forbidden/default-rootfs.vfs.zst",
} as const;
