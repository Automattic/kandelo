import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { resolveShellLazyArchiveUrl } from "./lazy-archives";
import {
  assertShellLazyUrlsResolved,
  rewriteShellLazyFileUrls,
} from "./shell-lazy-files";

/**
 * Bind every build-time lazy URL before accepting an image for serialization.
 */
export function bindImageOwnedRuntimeUrls(
  fs: MemoryFileSystem,
): void {
  fs.rewriteLazyArchiveUrls(resolveShellLazyArchiveUrl);
  rewriteShellLazyFileUrls(fs);
  // WHY: this is the commit point for every image-owned transport rewrite.
  // Omitting the final assertion defers a broken build-time URL to users.
  assertShellLazyUrlsResolved(fs);
}
