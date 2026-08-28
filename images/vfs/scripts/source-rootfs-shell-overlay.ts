import { statSync } from "node:fs";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { populateShellRuntimeLayout } from "../../../host/src/shell-runtime-layout";
import { symlink } from "../../../host/src/vfs/image-helpers";
import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../lib/init/shell-binaries";
import {
  registerDeclaredShellLazyArchive,
  registerPythonShellProfile,
  SHELL_LAZY_ARCHIVE_SPECS,
  type ShellLazyArchiveResolver,
} from "./shell-lazy-archives";

export const PACKAGE_ROOTFS_SHELL_COMPOSITION = {
  schema: 1,
  kind: "package-rootfs-shell",
} as const;

/** Add the package-owned interactive toolset to an imported rootfs image. */
export function populateSourceRootfsShellOverlay(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  populateShellRuntimeLayout(fs);

  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    if (fs.getLazyEntry(spec.vfsPath) === null) {
      const source = resolveArtifact(spec.resolverPath, spec.id);
      fs.registerLazyFile(
        spec.vfsPath,
        shellLazyPlaceholderUrl(spec),
        statSync(source).size,
        0o755,
      );
    }
    for (const alias of spec.symlinks) {
      symlink(fs, spec.vfsPath, alias);
    }
  }

  const archiveUrls = new Set(
    fs.exportLazyArchiveEntries().map((entry) => entry.url),
  );
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    if (!archiveUrls.has(spec.archiveUrl)) {
      registerDeclaredShellLazyArchive(fs, spec, resolveArtifact);
    }
  }

  for (const [target, alias] of [
    ["/usr/bin/vim", "/bin/vim"],
    ["/usr/bin/vim", "/usr/bin/vi"],
    ["/usr/bin/vim", "/bin/vi"],
    ["/usr/bin/nethack", "/bin/nethack"],
    ["/usr/bin/ruby", "/bin/ruby"],
    ["/usr/bin/python3", "/bin/python3"],
    ["/usr/bin/python3", "/bin/python"],
    ["/usr/bin/node", "/bin/node"],
    ["/usr/bin/npm", "/bin/npm"],
    ["/usr/bin/npx", "/bin/npx"],
    ["/usr/bin/perl", "/bin/perl"],
  ] as const) {
    symlink(fs, target, alias);
  }

  registerPythonShellProfile(fs);
}
