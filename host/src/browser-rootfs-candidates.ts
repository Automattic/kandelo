import { resolve } from "node:path";

/** Legacy Vite rootfs alias order. SourceOnly uses its projection instead. */
export function browserRootfsCandidates(repoRoot: string): string[] {
  return [
    "host/wasm/rootfs.vfs.zst",
    "local-binaries/rootfs.vfs.zst",
    "binaries/rootfs.vfs.zst",
    "local-binaries/programs/wasm32/rootfs.vfs.zst",
    "binaries/programs/wasm32/rootfs.vfs.zst",
  ].map((path) => resolve(repoRoot, path));
}
