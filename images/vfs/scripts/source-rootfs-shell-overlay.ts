import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { KandeloImageFs } from "../lib/kandelo-image-fs";
import { populateShellRuntimeLayout } from "./shell-runtime-layout";
import { installPackageSessionFiles } from "./package-session-files";
import { imageFileStat, registerResolvedProgramOriginal, type ProgramOriginalImageOptions } from "./program-originals";
import { symlink } from "../../../host/src/vfs/image-helpers";
import { ensureDirRecursive, writeVfsFile } from "./vfs-image-helpers";
import {
  SHELL_INIT_PATH,
  SHELL_LAZY_BINARY_SPECS,
  SHELL_SYSLOGD_PATH,
  shellLazyPlaceholderUrl,
  shellLazySpecDependency,
  shellLazySpecMode,
} from "../lib/init/shell-binaries";
import {
  displacePosixUtilsLiteManApplet,
  installNethackGames,
  populateTerminfoDatabase,
  registerDeclaredShellLazyArchive,
  registerShellProfileScripts,
  SHELL_LAZY_ARCHIVE_SPECS,
  type ShellLazyArchiveResolver,
} from "./shell-lazy-archives";

export const PACKAGE_ROOTFS_SHELL_COMPOSITION = {
  schema: 1,
  kind: "package-rootfs-shell",
} as const;

/** Add the package-owned interactive toolset to an imported rootfs image. */
export function populateSourceRootfsShellOverlay(
  fs: KandeloImageFs,
  resolveArtifact: ShellLazyArchiveResolver,
  options: ProgramOriginalImageOptions = {},
): void {
  const includes = options.includesPackage ?? (() => true);
  populateShellRuntimeLayout(fs);
  installPackageSessionFiles(fs, resolveArtifact, includes);

  // WHY: every ncurses/termcap-linked guest program resolves $TERM against
  // /usr/share/terminfo on every run, so the shared database must be present
  // from boot rather than fetched lazily like the archives below.
  populateTerminfoDatabase(fs, resolveArtifact);

  // WHY eager, when every other program here is lazy: /sbin/kandelo-shell-init
  // starts this daemon before it execs the login shell, so a deferred copy
  // would be fetched during boot -- a network round trip on the boot path, and
  // no logging at all on a machine that is offline. The same argument the
  // eager-program guard makes for Bash.
  if (includes("sysklogd")) {
    const source = resolveArtifact("programs/syslogd.wasm", "sysklogd");
    const daemon = registerResolvedProgramOriginal(
      fs, "programs/syslogd.wasm", "sysklogd", source, SHELL_SYSLOGD_PATH, options.resolveOriginal,
    );
    fs.writeFile(SHELL_SYSLOGD_PATH, daemon, 0o755);
    fs.chmod(SHELL_SYSLOGD_PATH, 0o755);
  }

  // The image's init. /sbin because starting the machine is boot
  // administration, alongside dinit and kandelo-init.
  //
  // This image has no supervisor, so the daemon is started without -F and
  // daemonizes itself, which keeps it alive past the exec below. Userspace
  // logging stays optional: a machine built without sysklogd has no daemon,
  // the test keeps the boot going, and syslog(3) silently drops messages as
  // POSIX says it must. A daemon that fails to start is reported rather than
  // allowed to stop the boot -- a machine the user cannot log into would be a
  // far worse failure than one that is not logging.
  ensureDirRecursive(fs, "/sbin");
  writeVfsFile(
    fs,
    SHELL_INIT_PATH,
    [
      "#!/bin/sh",
      "set -eu",
      `if [ -x ${SHELL_SYSLOGD_PATH} ]; then`,
      `  ${SHELL_SYSLOGD_PATH} || echo 'kandelo: the system log daemon failed to start' >&2`,
      "fi",
      "exec /bin/login -p -f maker",
      "",
    ].join("\n"),
    0o755,
  );

  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    const dependency = shellLazySpecDependency(spec);
    if (!includes(dependency)) continue;
    const existing = imageFileStat(fs, spec.vfsPath);
    if (existing !== null && !options.existingProgramDependencies?.has(dependency)) continue;
    const source = resolveArtifact(spec.resolverPath, dependency);
    const program = registerResolvedProgramOriginal(fs, spec.resolverPath, dependency, source, spec.vfsPath, options.resolveOriginal);
    if (existing === null) {
      // Same reason as the shell builder: length alone never distinguished the
      // right bytes from same-length wrong ones, and some of these run setuid.
      fs.registerLazyFile(
        spec.vfsPath,
        shellLazyPlaceholderUrl(spec),
        statSync(source).size,
        shellLazySpecMode(spec),
        createHash("sha256").update(program).digest("hex"),
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
    if (!includes(spec.dependency)) continue;
    if (!fs.isPathDeferred(`${spec.mountPrefix}${spec.requiredMember}`)) {
      // posix-utils-lite's raw `man` applet may already occupy /usr/bin/man
      // on the imported rootfs; clear it first so mandoc's formatting `man`
      // wins the path instead of colliding (EEXIST) with the archive symlink.
      if (spec.id === "man") displacePosixUtilsLiteManApplet(fs);
      registerDeclaredShellLazyArchive(fs, spec, resolveArtifact);
    }
  }
  if (includes("nethack-browser-bundle")) installNethackGames(fs);

  if (includes("vim-browser-bundle")) symlink(fs, "/usr/bin/vim", "/usr/bin/vi");

  // Every /etc/profile.d script this image ships, from the one list both
  // shell-family builders call. Listing individual registrations here is what
  // let the maker account's identity script ship in the layered base image
  // but not in this one.
  registerShellProfileScripts(fs, includes);
}
