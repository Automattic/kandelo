import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { resolveShellLazyArchiveUrl } from "./lazy-archives";
import { bindImageOwnedNodeRuntime } from "./node-image-runtime";
import {
  assertShellLazyUrlsResolved,
  rewriteShellLazyFileUrls,
} from "./shell-lazy-files";

export interface ImageOwnedRuntimeUrlBindings {
  nodeAssetUrl?: string;
}

/**
 * Bind every build-time lazy URL before accepting an image for serialization.
 */
export function bindImageOwnedRuntimeUrls(
  fs: MemoryFileSystem,
  bindings: ImageOwnedRuntimeUrlBindings = {},
): void {
  fs.rewriteLazyArchiveUrls(resolveShellLazyArchiveUrl);
  rewriteShellLazyFileUrls(fs);
  if (bindings.nodeAssetUrl !== undefined) {
    bindImageOwnedNodeRuntime(fs, bindings.nodeAssetUrl);
  }
  // WHY: this is the commit point for all profile-specific URL binders. An
  // earlier assertion rejects valid placeholders before their owning profile
  // can bind them; omitting the final assertion defers a broken URL to users.
  assertShellLazyUrlsResolved(fs);
}
