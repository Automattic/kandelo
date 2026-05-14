/**
 * Shared VFS-image populator for the Shell environment.
 *
 * Encapsulates everything build-shell-vfs-image.ts used to do inline so
 * the WordPress (SQLite) and LAMP demo builders can stand up the same
 * shell layout — dash + bash + coreutils + grep + sed + extended
 * utilities + magic + vim/nethack lazy archives + /etc/profile/gitconfig
 * /services — on top of which they layer nginx/php-fpm (+ MariaDB) and
 * the WordPress tree.
 *
 * The flag that distinguishes Shell from WP/LAMP usage is `eagerBinaries`.
 * Shell uses `false`: only dash + magic + lazy archives are baked into
 * shell.vfs.zst; every other tool is fetched + lazy-registered by the
 * Shell page at runtime via kernel.registerLazyFiles(). WP/LAMP use
 * `true`: every tool binary is baked into the image, because those
 * demos run in `kernelOwnedFs: true` mode where the main thread has no
 * VFS to lazy-register against.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import {
  resolveBinary,
  tryResolveBinary,
  findRepoRoot,
} from "../../../host/src/binary-resolver";
import { COREUTILS_NAMES } from "../lib/init/shell-binaries";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDirRecursive,
  symlink,
} from "./vfs-image-helpers";

export interface ShellVfsOptions {
  /**
   * When true, every tool binary (bash, coreutils, grep, sed, bc, file,
   * less, m4, make, tar, curl, wget, git, gzip/bzip2/xz/zstd, zip/unzip,
   * nano, lsof) is read from disk and baked into the VFS image. Required
   * for demos that run in `kernelOwnedFs: true` mode — there is no
   * main-thread filesystem to lazy-register against post-boot.
   *
   * When false, only dash + magic + the lazy archives (vim.zip,
   * nethack.zip) are baked; the page is expected to wire up runtime
   * lazy registration for the rest. This matches the Shell demo's
   * current behavior.
   */
  eagerBinaries: boolean;
}

/**
 * Populate `fs` with the canonical Shell environment. Called from
 * build-shell-vfs-image.ts (`eagerBinaries: false`) and from
 * build-wp-vfs-image.ts / build-lamp-vfs-image.ts (`eagerBinaries: true`).
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
  populateSystem(fs);
  populateDash(fs);
  if (opts.eagerBinaries) populateBash(fs);
  populateCoreutilsSymlinks(fs);
  if (opts.eagerBinaries) populateCoreutils(fs);
  populateGrepSedSymlinks(fs);
  if (opts.eagerBinaries) {
    populateGrep(fs);
    populateSed(fs);
  }
  populateVimArchive(fs);
  populateNetHackArchive(fs);
  populateExtendedSymlinks(fs);
  if (opts.eagerBinaries) populateExtendedBinaries(fs);
  populateMagic(fs);
}

// ── System layout ───────────────────────────────────────────────

function populateSystem(fs: MemoryFileSystem): void {
  for (const dir of [
    "/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin",
    "/usr/share", "/usr/share/misc", "/usr/share/file",
    "/etc", "/root", "/tmp", "/home", "/dev", "/usr/sbin",
    // NetHack VAR_PLAYGROUND — writable saves, scores, bones.
    "/home/.nethack",
  ]) {
    ensureDirRecursive(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
  fs.chmod("/home/.nethack", 0o777);

  // NetHack getlock() calls link(filename, lockname) on an empty marker
  // file named `perm` in VAR_PLAYGROUND. File must exist or link()
  // returns ENOENT and nethack exits.
  writeVfsFile(fs, "/home/.nethack/perm", "");

  // /etc/services — required for getservbyname/getservbyport calls in
  // nginx/php-fpm/MariaDB. Harmless in Shell-only builds.
  const services = [
    "tcpmux\t\t1/tcp",
    "echo\t\t7/tcp",
    "echo\t\t7/udp",
    "discard\t\t9/tcp\t\tsink null",
    "discard\t\t9/udp\t\tsink null",
    "ftp-data\t20/tcp",
    "ftp\t\t21/tcp",
    "ssh\t\t22/tcp",
    "telnet\t\t23/tcp",
    "smtp\t\t25/tcp\t\tmail",
    "domain\t\t53/tcp",
    "domain\t\t53/udp",
    "http\t\t80/tcp\t\twww",
    "pop3\t\t110/tcp\t\tpop-3",
    "nntp\t\t119/tcp\t\treadnews untp",
    "ntp\t\t123/udp",
    "imap\t\t143/tcp\t\timap2",
    "snmp\t\t161/udp",
    "https\t\t443/tcp",
    "imaps\t\t993/tcp",
    "pop3s\t\t995/tcp",
    "mysql\t\t3306/tcp",
  ].join("\n") + "\n";
  writeVfsFile(fs, "/etc/services", services);

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
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/profile", profile);
}

// ── Shell binaries ──────────────────────────────────────────────

function populateDash(fs: MemoryFileSystem): void {
  const dashBytes = readFileSync(resolveBinary("programs/dash.wasm"));
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes));
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
}

function populateBash(fs: MemoryFileSystem): void {
  const bashBytes = readFileSync(resolveBinary("programs/bash.wasm"));
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
  const bytes = readFileSync(resolveBinary("programs/coreutils.wasm"));
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
  const bytes = readFileSync(resolveBinary("programs/grep.wasm"));
  writeVfsBinary(fs, "/usr/bin/grep", new Uint8Array(bytes));
}

function populateSed(fs: MemoryFileSystem): void {
  const bytes = readFileSync(resolveBinary("programs/sed.wasm"));
  writeVfsBinary(fs, "/usr/bin/sed", new Uint8Array(bytes));
}

// ── Extended toolset ────────────────────────────────────────────

function populateExtendedSymlinks(fs: MemoryFileSystem): void {
  symlink(fs, "/usr/bin/bc", "/bin/bc");
  symlink(fs, "/usr/bin/file", "/bin/file");
  symlink(fs, "/usr/bin/less", "/bin/less");
  symlink(fs, "/usr/bin/m4", "/bin/m4");
  symlink(fs, "/usr/bin/make", "/bin/make");
  symlink(fs, "/usr/bin/tar", "/bin/tar");
  symlink(fs, "/usr/bin/curl", "/bin/curl");
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

/** Bake every extended-toolset binary. Required for kernelOwnedFs demos. */
function populateExtendedBinaries(fs: MemoryFileSystem): void {
  const extended: Array<{ relPath: string; vfsPath: string }> = [
    { relPath: "programs/bc.wasm",                   vfsPath: "/usr/bin/bc" },
    { relPath: "programs/file/file.wasm",            vfsPath: "/usr/bin/file" },
    { relPath: "programs/less.wasm",                 vfsPath: "/usr/bin/less" },
    { relPath: "programs/m4.wasm",                   vfsPath: "/usr/bin/m4" },
    { relPath: "programs/make.wasm",                 vfsPath: "/usr/bin/make" },
    { relPath: "programs/tar.wasm",                  vfsPath: "/usr/bin/tar" },
    { relPath: "programs/curl.wasm",                 vfsPath: "/usr/bin/curl" },
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
    const bytes = readFileSync(resolveBinary(relPath));
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
  return join(findRepoRoot(), "examples/libs/file/bin/magic.lite");
}

function populateMagic(fs: MemoryFileSystem): void {
  const magicPath = resolveMagicPath();
  try {
    lstatSync(magicPath);
  } catch {
    throw new Error(
      `magic.lite not found (expected at ${magicPath}). ` +
      `Build the file utility: bash examples/libs/file/build-file.sh`,
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
  const path = resolveLazyArchivePath("programs/vim.zip", "examples/browser/public/vim.zip");
  if (!path) {
    throw new Error(
      "vim.zip not found. Run: bash examples/browser/scripts/build-vim-zip.sh",
    );
  }
  const zipBytes = readFileSync(path);
  const entries = parseZipCentralDirectory(new Uint8Array(zipBytes));
  fs.registerLazyArchiveFromEntries("vim.zip", entries, "/usr/");
}

function populateNetHackArchive(fs: MemoryFileSystem): void {
  const path = resolveLazyArchivePath("programs/nethack.zip", "examples/browser/public/nethack.zip");
  if (!path) {
    throw new Error(
      "nethack.zip not found. Run: bash examples/browser/scripts/build-nethack-zip.sh",
    );
  }
  const zipBytes = readFileSync(path);
  const entries = parseZipCentralDirectory(new Uint8Array(zipBytes));
  fs.registerLazyArchiveFromEntries("nethack.zip", entries, "/usr/");
}
