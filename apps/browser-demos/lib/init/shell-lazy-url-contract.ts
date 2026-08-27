import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import {
  SHELL_LAZY_URL_PREFIX,
} from "../../../../images/vfs/lib/init/shell-binaries";

/**
 * Fail before boot if a product image still contains a build-time lazy URL.
 *
 * VFS metadata is serialized authority. Letting an unmapped relative token
 * survive would defer the error until a user happens to run that command, and
 * could accidentally resolve against a different deployment path.
 */
export function assertShellLazyUrlsResolved(fs: MemoryFileSystem): void {
  const unresolvedFiles = fs.exportLazyEntries().filter((entry) =>
    entry.url.startsWith("binaries/") ||
    entry.url.startsWith(SHELL_LAZY_URL_PREFIX)
  );
  const unresolvedArchives = fs.exportLazyArchiveEntries().filter((entry) =>
    entry.url === "vim.zip" || entry.url === "nethack.zip" ||
    entry.url === "ruby.zip" || entry.url === "python.zip"
  );
  if (unresolvedFiles.length === 0 && unresolvedArchives.length === 0) return;
  const details = [
    ...unresolvedFiles.map((entry) => `${entry.path} -> ${entry.url}`),
    ...unresolvedArchives.map((entry) =>
      `${entry.mountPrefix} archive -> ${entry.url}`
    ),
  ];
  throw new Error(
    "Shell VFS contains unresolved lazy deployment URLs:\n" +
      details.map((detail) => `  ${detail}`).join("\n"),
  );
}
