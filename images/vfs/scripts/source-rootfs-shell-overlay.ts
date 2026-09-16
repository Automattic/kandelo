import { statSync } from "node:fs";
import type { SffsImageFs } from "../lib/sffs-image-fs";
import { populateShellRuntimeLayout } from "./shell-runtime-layout";
import { symlink } from "../../../host/src/vfs/image-helpers";
import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../lib/init/shell-binaries";
import {
  displacePosixUtilsLiteManApplet,
  populateTerminfoDatabase,
  registerDeclaredShellLazyArchive,
  registerManShellProfile,
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
  fs: SffsImageFs,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  populateShellRuntimeLayout(fs);

  // WHY: every ncurses/termcap-linked guest program resolves $TERM against
  // /usr/share/terminfo on every run, so the shared database must be present
  // from boot rather than fetched lazily like the archives below.
  populateTerminfoDatabase(fs, resolveArtifact);

  // `getLazyEntry` rather than `isPathDeferred`, because a path that is not
  // there yet is a legitimate answer HERE -- a fresh rootfs carries none of
  // these -- and `isPathDeferred` throws so a typo cannot pass as a `no`.
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

  // Whether an archive is ALREADY here is asked of the tree, not of a table of
  // URLs. The imported rootfs may already carry one, and re-registering it is
  // what this skip exists to avoid.
  //
  // Asking the tree is the better question as well as the available one. A URL
  // is the archive's TRANSPORT and lives in the fetch description the kernel
  // carries without reading; two builds could reach the same content through
  // different URLs, and a rebuild that changed one would re-register an archive
  // whose files are already present. `requiredMember` is in each spec precisely
  // because it names a path the archive must provide, so "already registered"
  // is "that path is here and still deferred".
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    if (!fs.isPathDeferred(`${spec.mountPrefix}${spec.requiredMember}`)) {
      // posix-utils-lite's raw `man` applet may already occupy /usr/bin/man
      // on the imported rootfs; clear it first so mandoc's formatting `man`
      // wins the path instead of colliding (EEXIST) with the archive symlink.
      if (spec.id === "man") displacePosixUtilsLiteManApplet(fs);
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
    ["/usr/bin/man", "/bin/man"],
  ] as const) {
    symlink(fs, target, alias);
  }

  registerPythonShellProfile(fs);
  registerManShellProfile(fs);
}
