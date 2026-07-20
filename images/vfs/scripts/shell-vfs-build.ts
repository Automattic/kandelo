/**
 * Shared VFS-image populator for the Shell environment.
 *
 * Encapsulates everything build-shell-vfs-image.ts used to do inline and
 * exposes a loader for service demos that layer nginx/php-fpm (+ MariaDB)
 * and application files on top of the already-built shell.vfs.zst image.
 *
 * The shell image uses `eagerBinaries: false`: the canonical rootfs provides
 * base utility lazy stubs, then shell.vfs.zst overlays demo lazy stubs and
 * lazy archives. Utility bytes are fetched on first exec.
 * Historical standalone service images used `true`: every tool binary was
 * baked into the image. Builtin Kandelo service demos now use shell.vfs.zst as
 * their base image and keep its lazy metadata intact.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import {
  resolveBinary,
  tryResolveBinary,
  findRepoRoot,
} from "../../../host/src/binary-resolver";
import {
  COREUTILS_NAMES,
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../lib/init/shell-binaries";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDirRecursive,
  symlink,
} from "./vfs-image-helpers";

function depEnvKey(name: string): string {
  return name.replaceAll("-", "_").toUpperCase();
}

function artifactDepName(relPath: string, depName?: string): string {
  if (depName) return depName === "git-remote-http" ? "git" : depName;
  if (relPath.startsWith("programs/git/")) return "git";
  if (relPath.startsWith("programs/file/")) return "file";
  return basename(relPath).replace(/\.(wasm|zip|zst)$/, "");
}

function depArtifactPath(relPath: string, depName?: string): string | null {
  const packageName = artifactDepName(relPath, depName);
  const depDir = process.env[`WASM_POSIX_DEP_${depEnvKey(packageName)}_DIR`];
  if (!depDir) return null;
  const path = join(depDir, basename(relPath));
  if (existsSync(path)) return path;
  throw new Error(
    `direct dependency ${packageName} is available at ${depDir}, ` +
    `but ${basename(relPath)} was not found`,
  );
}

export function tryResolveVfsArtifact(relPath: string, depName?: string): string | null {
  const depPath = depArtifactPath(relPath, depName);
  if (depPath) return depPath;
  return tryResolveBinary(relPath);
}

export function resolveVfsArtifact(relPath: string, depName?: string): string {
  const resolved = tryResolveVfsArtifact(relPath, depName);
  if (resolved) return resolved;
  return resolveBinary(relPath);
}

export function loadShellBaseFileSystem(maxByteLength: number): MemoryFileSystem {
  const shellImagePath = resolveVfsArtifact("programs/shell.vfs.zst", "shell");
  const shellImage = new Uint8Array(readFileSync(shellImagePath));
  const fs = MemoryFileSystem.fromImage(shellImage, { maxByteLength });
  const stats = fs.statfs("/");
  const effectiveMaxByteLength = stats.blocks * stats.bsize;
  if (effectiveMaxByteLength >= maxByteLength) return fs;

  console.log(
    `Rebasing shell base VFS capacity from ${Math.round(effectiveMaxByteLength / 1024 / 1024)} MiB ` +
      `to ${Math.round(maxByteLength / 1024 / 1024)} MiB...`,
  );
  return fs.rebaseToNewFileSystem(maxByteLength);
}

export interface ShellVfsOptions {
  /**
   * When true, every tool binary (bash, coreutils, grep, sed, bc, file,
   * less, m4, make, tar, curl, wget, git, gzip/bzip2/xz/zstd, zip/unzip,
   * nano, lsof) is read from disk and baked into the VFS image. Required
   * for demos that run in `kernelOwnedFs: true` mode — there is no
   * main-thread filesystem to lazy-register against post-boot.
   *
   * When false, utility binaries are stored as lazy VFS metadata. If a base
   * rootfs image was provided, only missing shell-demo tools are added here.
   */
  eagerBinaries: boolean;
  /**
   * When true, `fs` is already initialized from the canonical base rootfs.
   * Base utilities and static system files are left in place; this helper only
   * overlays shell/demo-specific directories, config, and non-base tools.
   */
  baseProvided?: boolean;
}

/**
 * Populate `fs` with the canonical Shell environment. Called by the shell VFS
 * builder itself; service-image builders should prefer
 * `loadShellBaseFileSystem()` so they inherit the exact shell.vfs.zst artifact.
 *
 * Order is load-bearing: lazy archive metadata must be written before
 * extended symlinks point at their (lazy-stub) targets — the symlink
 * targets are stored as path strings, but it's clearest to keep
 * "archive registers stub" → "symlink aliases stub" sequencing.
 */
export function populateShellEnvironment(
  fs: MemoryFileSystem,
  opts: ShellVfsOptions,
): void {
  if (opts.baseProvided) {
    populateShellOverlay(fs);
  } else {
    populateSystem(fs);
    populateDash(fs);
    if (opts.eagerBinaries) populateBash(fs);
    if (!opts.eagerBinaries) populateLazyBinaries(fs);
    populateCoreutilsSymlinks(fs);
    if (opts.eagerBinaries) populateCoreutils(fs);
    populateGrepSedSymlinks(fs);
    if (opts.eagerBinaries) {
      populateGrep(fs);
      populateSed(fs);
    }
    populateBaseExtendedSymlinks(fs);
    if (opts.eagerBinaries) populateBaseExtendedBinaries(fs);
    populateMagic(fs);
  }
  if (opts.baseProvided && !opts.eagerBinaries) {
    populateLazyBinaries(fs, { skipExisting: true });
  }
  populateVimArchive(fs);
  populateNetHackArchive(fs);
  populateDemoExtendedSymlinks(fs);
  if (opts.eagerBinaries) populateDemoExtendedBinaries(fs);
}

// ── System layout ───────────────────────────────────────────────

function populateSystem(fs: MemoryFileSystem): void {
  for (const dir of [
    "/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin",
    "/usr/share", "/usr/share/misc", "/usr/share/file",
    "/etc", "/root", "/tmp", "/home", "/home/user", "/dev", "/usr/sbin",
    // NetHack VAR_PLAYGROUND — writable saves, scores, bones.
    "/home/.nethack",
  ]) {
    ensureDirRecursive(fs, dir);
  }
  fs.chmod("/tmp", 0o1777);
  fs.chmod("/root", 0o700);
  fs.chown("/home/user", 1000, 1000);
  populateNetHackPlayground(fs);

  const gitconfig = [
    "[maintenance]",
    "\tauto = false",
    "[gc]",
    "\tauto = 0",
    "[core]",
    "\tpager = cat",
    "[user]",
    "\tname = User",
    "\temail = user@wasm.local",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/gitconfig", gitconfig);

  // Shell profile — color aliases + NetHack defaults. NetHack's
  // VAR_PLAYGROUND is pre-created above, so the profile only sets env.
  const profile = [
    "alias ls='ls --color=auto'",
    "alias grep='grep --color=auto'",
    "export USER=player",
    "export NETHACKOPTIONS='windowtype:curses,color,lit_corridor,hilite_pet'",
    "for kandelo_profile in /etc/profile.d/*.sh; do",
    "  [ -r \"$kandelo_profile\" ] && . \"$kandelo_profile\"",
    "done",
    "unset kandelo_profile",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/profile", profile);
}

function populateShellOverlay(fs: MemoryFileSystem): void {
  for (const dir of [
    "/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin",
    "/usr/share", "/usr/share/file", "/etc", "/root", "/tmp", "/home",
    "/home/user", "/dev", "/usr/sbin", "/home/.nethack",
  ]) {
    ensureDirRecursive(fs, dir);
  }
  fs.chmod("/tmp", 0o1777);
  fs.chmod("/root", 0o700);
  fs.chown("/home/user", 1000, 1000);
  populateNetHackPlayground(fs);

  const gitconfig = [
    "[maintenance]",
    "\tauto = false",
    "[gc]",
    "\tauto = 0",
    "[core]",
    "\tpager = cat",
    "[user]",
    "\tname = User",
    "\temail = user@wasm.local",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/gitconfig", gitconfig);

  const profile = [
    "alias ls='ls --color=auto'",
    "alias grep='grep --color=auto'",
    "export USER=player",
    "export NETHACKOPTIONS='windowtype:curses,color,lit_corridor,hilite_pet'",
    "for kandelo_profile in /etc/profile.d/*.sh; do",
    "  [ -r \"$kandelo_profile\" ] && . \"$kandelo_profile\"",
    "done",
    "unset kandelo_profile",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/profile", profile);

  // A rootfs artifact may provide the lazy binary inodes without the
  // user-facing aliases the shell demo expects. Recreate the aliases
  // here so shell.vfs stays self-contained even as rootfs stays minimal.
  populateCoreutilsSymlinks(fs);
  populateGrepSedSymlinks(fs);
  populateBaseExtendedSymlinks(fs);
  populateDemoExtendedSymlinks(fs);
}

function populateNetHackPlayground(fs: MemoryFileSystem): void {
  fs.chown("/home/.nethack", 1000, 1000);
  fs.chmod("/home/.nethack", 0o777);

  // NetHack expects VAR_PLAYGROUND to contain the lock marker and score
  // database before read-only score-listing commands such as `nethack -s`.
  for (const file of ["/home/.nethack/perm", "/home/.nethack/record"]) {
    writeVfsFile(fs, file, "");
    fs.chown(file, 1000, 1000);
    fs.chmod(file, 0o666);
  }
}

// ── Shell binaries ──────────────────────────────────────────────

function populateDash(fs: MemoryFileSystem): void {
  const dashBytes = readFileSync(resolveVfsArtifact("programs/dash.wasm", "dash"));
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes));
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
}

function populateBash(fs: MemoryFileSystem): void {
  const bashBytes = readFileSync(resolveVfsArtifact("programs/bash.wasm", "bash"));
  writeVfsBinary(fs, "/usr/bin/bash", new Uint8Array(bashBytes));
  symlink(fs, "/usr/bin/bash", "/bin/bash");
}

function populateCoreutilsSymlinks(fs: MemoryFileSystem): void {
  for (const name of [...COREUTILS_NAMES, "["]) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }
}

function populateCoreutils(fs: MemoryFileSystem): void {
  const bytes = readFileSync(resolveVfsArtifact("programs/coreutils.wasm", "coreutils"));
  writeVfsBinary(fs, "/bin/coreutils", new Uint8Array(bytes));
}

function populateGrepSedSymlinks(fs: MemoryFileSystem): void {
  symlink(fs, "/usr/bin/grep", "/bin/grep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/fgrep");
  symlink(fs, "/usr/bin/grep", "/bin/fgrep");

  symlink(fs, "/usr/bin/sed", "/bin/sed");
}

function populateGrep(fs: MemoryFileSystem): void {
  const bytes = readFileSync(resolveVfsArtifact("programs/grep.wasm", "grep"));
  writeVfsBinary(fs, "/usr/bin/grep", new Uint8Array(bytes));
}

function populateSed(fs: MemoryFileSystem): void {
  const bytes = readFileSync(resolveVfsArtifact("programs/sed.wasm", "sed"));
  writeVfsBinary(fs, "/usr/bin/sed", new Uint8Array(bytes));
}

function populateLazyBinaries(
  fs: MemoryFileSystem,
  opts: { skipExisting?: boolean } = {},
): void {
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    if (opts.skipExisting && fs.getLazyEntry(spec.vfsPath)) continue;
    const resolved = resolveVfsArtifact(spec.resolverPath, spec.id);
    const size = statSync(resolved).size;
    fs.registerLazyFile(
      spec.vfsPath,
      shellLazyPlaceholderUrl(spec),
      size,
      0o755,
    );
  }
}

// ── Extended toolset ────────────────────────────────────────────

function populateBaseExtendedSymlinks(fs: MemoryFileSystem): void {
  symlink(fs, "/usr/bin/bc", "/bin/bc");
  symlink(fs, "/usr/bin/file", "/bin/file");
  symlink(fs, "/usr/bin/m4", "/bin/m4");
  symlink(fs, "/usr/bin/make", "/bin/make");
}

function populateDemoExtendedSymlinks(fs: MemoryFileSystem): void {
  symlink(fs, "/usr/bin/less", "/bin/less");
  symlink(fs, "/usr/bin/tar", "/bin/tar");
  symlink(fs, "/usr/bin/curl", "/bin/curl");
  symlink(fs, "/usr/bin/nc", "/bin/nc");
  symlink(fs, "/usr/bin/nc", "/usr/bin/netcat");
  symlink(fs, "/usr/bin/nc", "/bin/netcat");
  symlink(fs, "/usr/bin/wget", "/bin/wget");

  symlink(fs, "/usr/bin/git", "/bin/git");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-https");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-ftp");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-ftps");

  symlink(fs, "/usr/bin/gzip", "/bin/gzip");
  symlink(fs, "/usr/bin/gzip", "/usr/bin/gunzip");
  symlink(fs, "/usr/bin/gzip", "/bin/gunzip");
  symlink(fs, "/usr/bin/gzip", "/usr/bin/zcat");
  symlink(fs, "/usr/bin/gzip", "/bin/zcat");

  symlink(fs, "/usr/bin/bzip2", "/bin/bzip2");
  symlink(fs, "/usr/bin/bzip2", "/usr/bin/bunzip2");
  symlink(fs, "/usr/bin/bzip2", "/bin/bunzip2");
  symlink(fs, "/usr/bin/bzip2", "/usr/bin/bzcat");
  symlink(fs, "/usr/bin/bzip2", "/bin/bzcat");

  symlink(fs, "/usr/bin/xz", "/bin/xz");
  symlink(fs, "/usr/bin/xz", "/usr/bin/unxz");
  symlink(fs, "/usr/bin/xz", "/bin/unxz");
  symlink(fs, "/usr/bin/xz", "/usr/bin/xzcat");
  symlink(fs, "/usr/bin/xz", "/bin/xzcat");
  symlink(fs, "/usr/bin/xz", "/usr/bin/lzma");
  symlink(fs, "/usr/bin/xz", "/bin/lzma");
  symlink(fs, "/usr/bin/xz", "/usr/bin/unlzma");
  symlink(fs, "/usr/bin/xz", "/bin/unlzma");
  symlink(fs, "/usr/bin/xz", "/usr/bin/lzcat");
  symlink(fs, "/usr/bin/xz", "/bin/lzcat");

  symlink(fs, "/usr/bin/zstd", "/bin/zstd");
  symlink(fs, "/usr/bin/zstd", "/usr/bin/unzstd");
  symlink(fs, "/usr/bin/zstd", "/bin/unzstd");
  symlink(fs, "/usr/bin/zstd", "/usr/bin/zstdcat");
  symlink(fs, "/usr/bin/zstd", "/bin/zstdcat");

  symlink(fs, "/usr/bin/zip", "/bin/zip");
  symlink(fs, "/usr/bin/unzip", "/bin/unzip");
  symlink(fs, "/usr/bin/unzip", "/usr/bin/zipinfo");
  symlink(fs, "/usr/bin/unzip", "/bin/zipinfo");
  symlink(fs, "/usr/bin/unzip", "/usr/bin/funzip");
  symlink(fs, "/usr/bin/unzip", "/bin/funzip");

  symlink(fs, "/usr/bin/nano", "/bin/nano");
  symlink(fs, "/usr/bin/vim", "/bin/vim");
  symlink(fs, "/usr/bin/vim", "/usr/bin/vi");
  symlink(fs, "/usr/bin/vim", "/bin/vi");

  symlink(fs, "/usr/bin/nethack", "/bin/nethack");

  symlink(fs, "/usr/bin/lsof", "/bin/lsof");
}

function populateBaseExtendedBinaries(fs: MemoryFileSystem): void {
  const extended: Array<{ relPath: string; vfsPath: string }> = [
    { relPath: "programs/bc.wasm",                   vfsPath: "/usr/bin/bc" },
    { relPath: "programs/file/file.wasm",            vfsPath: "/usr/bin/file" },
    { relPath: "programs/m4.wasm",                   vfsPath: "/usr/bin/m4" },
    { relPath: "programs/make.wasm",                 vfsPath: "/usr/bin/make" },
  ];
  for (const { relPath, vfsPath } of extended) {
    const bytes = readFileSync(resolveBinary(relPath));
    writeVfsBinary(fs, vfsPath, new Uint8Array(bytes));
  }
}

/** Bake every demo extended-toolset binary. Required for kernelOwnedFs demos. */
function populateDemoExtendedBinaries(fs: MemoryFileSystem): void {
  const extended: Array<{ relPath: string; vfsPath: string }> = [
    { relPath: "programs/less.wasm",                 vfsPath: "/usr/bin/less" },
    { relPath: "programs/tar.wasm",                  vfsPath: "/usr/bin/tar" },
    { relPath: "programs/curl.wasm",                 vfsPath: "/usr/bin/curl" },
    { relPath: "programs/nc.wasm",                   vfsPath: "/usr/bin/nc" },
    { relPath: "programs/wget.wasm",                 vfsPath: "/usr/bin/wget" },
    { relPath: "programs/git/git.wasm",              vfsPath: "/usr/bin/git" },
    { relPath: "programs/git/git-remote-http.wasm",  vfsPath: "/usr/bin/git-remote-http" },
    { relPath: "programs/gzip.wasm",                 vfsPath: "/usr/bin/gzip" },
    { relPath: "programs/bzip2.wasm",                vfsPath: "/usr/bin/bzip2" },
    { relPath: "programs/xz.wasm",                   vfsPath: "/usr/bin/xz" },
    { relPath: "programs/zstd.wasm",                 vfsPath: "/usr/bin/zstd" },
    { relPath: "programs/zip.wasm",                  vfsPath: "/usr/bin/zip" },
    { relPath: "programs/unzip.wasm",                vfsPath: "/usr/bin/unzip" },
    { relPath: "programs/nano.wasm",                 vfsPath: "/usr/bin/nano" },
    { relPath: "programs/lsof.wasm",                 vfsPath: "/usr/bin/lsof" },
  ];
  for (const { relPath, vfsPath } of extended) {
    const bytes = readFileSync(resolveVfsArtifact(relPath));
    writeVfsBinary(fs, vfsPath, new Uint8Array(bytes));
  }
}

// ── Magic database (for `file`) ─────────────────────────────────

/**
 * Resolve magic.lite. The file package declares it as a second output
 * alongside file.wasm, but build-file.sh only stages it into the
 * resolver cache scratch dir — it's NOT install_local_binary'd. So the
 * binary-resolver path only succeeds when a release archive that ships
 * magic.lite was fetched. The xtask fallback covers source-built
 * scenarios; the in-tree fallback covers direct build-file.sh runs.
 */
function resolveMagicPath(): string {
  const directDep = tryResolveVfsArtifact("programs/file/magic.lite", "file");
  if (directDep) return directDep;
  const released = tryResolveBinary("programs/file/magic.lite");
  if (released) return released;
  try {
    const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.startsWith("host:"))
      ?.split(/\s+/)[1];
    if (!hostTarget) throw new Error("could not determine host target");
    const cacheDir = execFileSync(
      "cargo",
      ["run", "-p", "xtask", "--target", hostTarget, "--quiet", "--",
       "build-deps", "resolve", "file", "--arch", "wasm32"],
      { cwd: findRepoRoot(), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    ).trim();
    if (cacheDir && existsSync(join(cacheDir, "magic.lite"))) {
      return join(cacheDir, "magic.lite");
    }
  } catch {
    // Fall through to in-tree fallback.
  }
  return join(findRepoRoot(), "packages/registry/file/bin/magic.lite");
}

function populateMagic(fs: MemoryFileSystem): void {
  const magicPath = resolveMagicPath();
  try {
    statSync(magicPath);
  } catch {
    throw new Error(
      `magic.lite not found (expected at ${magicPath}). ` +
      `Build the file utility: bash packages/registry/file/build-file.sh`,
    );
  }
  const bytes = readFileSync(magicPath);
  writeVfsBinary(fs, "/usr/share/misc/magic", new Uint8Array(bytes), 0o644);
}

// ── Lazy archives ───────────────────────────────────────────────

function resolveLazyArchivePath(programRel: string, legacyPublicRel: string): string | null {
  const released = tryResolveBinary(programRel);
  if (released) return released;
  const legacy = join(findRepoRoot(), legacyPublicRel);
  if (existsSync(legacy)) return legacy;
  return null;
}

function populateVimArchive(fs: MemoryFileSystem): void {
  const path = resolveLazyArchivePath("programs/vim.zip", "apps/browser-demos/public/vim.zip");
  if (!path) {
    throw new Error(
      "vim.zip not found. Run: bash images/vfs/scripts/build-vim-zip.sh",
    );
  }
  const zipBytes = readFileSync(path);
  const entries = parseZipCentralDirectory(new Uint8Array(zipBytes));
  fs.registerLazyArchiveFromEntries("vim.zip", entries, "/usr/");
}

function populateNetHackArchive(fs: MemoryFileSystem): void {
  const path = resolveLazyArchivePath("programs/nethack.zip", "apps/browser-demos/public/nethack.zip");
  if (!path) {
    throw new Error(
      "nethack.zip not found. Run: bash images/vfs/scripts/build-nethack-zip.sh",
    );
  }
  const zipBytes = readFileSync(path);
  const entries = parseZipCentralDirectory(new Uint8Array(zipBytes));
  fs.registerLazyArchiveFromEntries("nethack.zip", entries, "/usr/");
}
