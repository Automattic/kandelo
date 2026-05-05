/**
 * Build a pre-built VFS image containing the full shell environment:
 * dash, coreutils symlinks, grep/sed symlinks, extended tool symlinks,
 * magic database, system configs, and a lazy archive reference for vim.
 *
 * Produces: examples/browser/public/shell.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-shell-vfs-image.ts
 */
import { execFileSync } from "child_process";
import { readFileSync, lstatSync, existsSync } from "fs";
import { join } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import { resolveBinary, tryResolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { COREUTILS_NAMES } from "../lib/init/shell-binaries";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDirRecursive,
  symlink,
  saveImage,
} from "./vfs-image-helpers";

const REPO_ROOT = findRepoRoot();

const DASH_PATH = resolveBinary("programs/dash.wasm");

// Resolve magic.lite from the file package's cache canonical dir
// (populated by `cargo xtask build-deps resolve file`, which either
// runs build-file.sh or fetches the release archive). file's
// build-file.sh stages magic.lite into OUT_DIR; deps.toml declares it
// as an [[outputs]] entry. Falls back to the in-tree source layout
// `examples/libs/file/bin/magic.lite` when a cache lookup fails —
// useful while iterating on build-file.sh without going through the
// resolver. Mirrors examples/browser/scripts/build-{vim,nethack}-zip.sh.
function resolveMagicPath(): string {
  let cacheDir: string | null = null;
  try {
    const out = execFileSync(
      "cargo",
      ["run", "-p", "xtask", "--quiet", "--",
       "build-deps", "resolve", "file", "--arch", "wasm32"],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    ).trim();
    if (out) cacheDir = out;
  } catch {
    // Resolve failed — fall through to in-tree fallback.
  }
  if (cacheDir && existsSync(join(cacheDir, "magic.lite"))) {
    return join(cacheDir, "magic.lite");
  }
  return "examples/libs/file/bin/magic.lite";
}
const MAGIC_PATH = resolveMagicPath();
// vim.zip and nethack.zip may come from binaries/ (as a program bundle) or
// still live in examples/browser/public/ as a local-built artifact.
const VIM_ZIP_PATH = tryResolveBinary("programs/vim.zip") ??
  "examples/browser/public/vim.zip";
const NETHACK_ZIP_PATH = tryResolveBinary("programs/nethack.zip") ??
  "examples/browser/public/nethack.zip";
const OUT_FILE = "examples/browser/public/shell.vfs";

// --- System setup ---

function populateSystem(fs: MemoryFileSystem): void {
  for (const dir of [
    "/bin", "/usr/bin", "/usr/local/bin", "/usr/share", "/usr/share/misc",
    "/usr/share/file", "/etc", "/root", "/tmp", "/home", "/dev", "/usr/sbin",
    // NetHack VAR_PLAYGROUND — writable saves, scores, bones. Pre-create
    // because /etc/profile can't `mkdir -p` without coreutils installed.
    "/home/.nethack",
  ]) {
    ensureDirRecursive(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
  fs.chmod("/home/.nethack", 0o777);

  // NetHack's getlock() calls link(filename, lockname) on an empty
  // marker file named `perm` in VAR_PLAYGROUND. The file must exist or
  // link() returns ENOENT and nethack exits. Drop an empty `perm` here.
  writeVfsFile(fs, "/home/.nethack/perm", "");

  // Git config
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
  // VAR_PLAYGROUND (/home/.nethack) is pre-created in the VFS image
  // above, so the profile only sets env vars.
  const profile = [
    "alias ls='ls --color=auto'",
    "alias grep='grep --color=auto'",
    "export USER=player",
    "export NETHACKOPTIONS='windowtype:curses,color,lit_corridor,hilite_pet'",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/profile", profile);
}

// --- Dash binary ---

function populateDash(fs: MemoryFileSystem): void {
  const dashBytes = readFileSync(DASH_PATH);
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes));
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
}

// --- Coreutils symlinks ---

function populateCoreutilsSymlinks(fs: MemoryFileSystem): void {
  for (const name of [...COREUTILS_NAMES, "["]) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }
}

// --- Grep / Sed symlinks ---

function populateGrepSedSymlinks(fs: MemoryFileSystem): void {
  // grep
  symlink(fs, "/usr/bin/grep", "/bin/grep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/fgrep");
  symlink(fs, "/usr/bin/grep", "/bin/fgrep");

  // sed
  symlink(fs, "/usr/bin/sed", "/bin/sed");
}

// --- Extended tool symlinks (targets are lazy-loaded at runtime) ---

function populateExtendedSymlinks(fs: MemoryFileSystem): void {
  symlink(fs, "/usr/bin/bc", "/bin/bc");
  symlink(fs, "/usr/bin/file", "/bin/file");
  symlink(fs, "/usr/bin/less", "/bin/less");
  symlink(fs, "/usr/bin/m4", "/bin/m4");
  symlink(fs, "/usr/bin/make", "/bin/make");
  symlink(fs, "/usr/bin/tar", "/bin/tar");
  symlink(fs, "/usr/bin/curl", "/bin/curl");
  symlink(fs, "/usr/bin/wget", "/bin/wget");

  // git
  symlink(fs, "/usr/bin/git", "/bin/git");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-https");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-ftp");
  symlink(fs, "/usr/bin/git-remote-http", "/usr/bin/git-remote-ftps");

  // gzip
  symlink(fs, "/usr/bin/gzip", "/bin/gzip");
  symlink(fs, "/usr/bin/gzip", "/usr/bin/gunzip");
  symlink(fs, "/usr/bin/gzip", "/bin/gunzip");
  symlink(fs, "/usr/bin/gzip", "/usr/bin/zcat");
  symlink(fs, "/usr/bin/gzip", "/bin/zcat");

  // bzip2
  symlink(fs, "/usr/bin/bzip2", "/bin/bzip2");
  symlink(fs, "/usr/bin/bzip2", "/usr/bin/bunzip2");
  symlink(fs, "/usr/bin/bzip2", "/bin/bunzip2");
  symlink(fs, "/usr/bin/bzip2", "/usr/bin/bzcat");
  symlink(fs, "/usr/bin/bzip2", "/bin/bzcat");

  // xz
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

  // zstd
  symlink(fs, "/usr/bin/zstd", "/bin/zstd");
  symlink(fs, "/usr/bin/zstd", "/usr/bin/unzstd");
  symlink(fs, "/usr/bin/zstd", "/bin/unzstd");
  symlink(fs, "/usr/bin/zstd", "/usr/bin/zstdcat");
  symlink(fs, "/usr/bin/zstd", "/bin/zstdcat");

  // zip / unzip
  symlink(fs, "/usr/bin/zip", "/bin/zip");
  symlink(fs, "/usr/bin/unzip", "/bin/unzip");
  symlink(fs, "/usr/bin/unzip", "/usr/bin/zipinfo");
  symlink(fs, "/usr/bin/unzip", "/bin/zipinfo");
  symlink(fs, "/usr/bin/unzip", "/usr/bin/funzip");
  symlink(fs, "/usr/bin/unzip", "/bin/funzip");

  // nano / vim
  symlink(fs, "/usr/bin/nano", "/bin/nano");
  symlink(fs, "/usr/bin/vim", "/bin/vim");
  symlink(fs, "/usr/bin/vim", "/usr/bin/vi");
  symlink(fs, "/usr/bin/vim", "/bin/vi");

  // nethack
  symlink(fs, "/usr/bin/nethack", "/bin/nethack");

  // lsof
  symlink(fs, "/usr/bin/lsof", "/bin/lsof");
}

// --- Magic database ---

function populateMagic(fs: MemoryFileSystem): void {
  const magicBytes = readFileSync(MAGIC_PATH);
  writeVfsBinary(fs, "/usr/share/misc/magic", new Uint8Array(magicBytes), 0o644);
}

// --- Vim (lazy archive) ---

/**
 * Register vim.zip as a lazy archive group. Stubs are created for the
 * binary (/usr/bin/vim) and every runtime file under /usr/share/vim/vim91/,
 * but content is deferred until the first exec of vim.
 *
 * The URL stored here is a plain filename; the browser runtime prepends
 * its base URL before fetching via `fs.rewriteLazyArchiveUrls()`.
 */
function populateVimArchive(fs: MemoryFileSystem): number {
  const zipBytes = readFileSync(VIM_ZIP_PATH);
  const entries = parseZipCentralDirectory(new Uint8Array(zipBytes));
  const group = fs.registerLazyArchiveFromEntries("vim.zip", entries, "/usr/");
  // /usr/bin/vim now exists as a stub; populateExtendedSymlinks will create
  // the /bin/vim, /usr/bin/vi, /bin/vi aliases pointing at it.
  return group.entries.size;
}

// --- NetHack (lazy archive) ---

/**
 * Register nethack.zip as a lazy archive group. Same pattern as vim:
 * /usr/bin/nethack (the wasm binary) and the runtime tree at
 * /usr/share/nethack/ (nhdat, symbols, license) are stubs in the VFS
 * image; the archive is fetched in full on first exec.
 */
function populateNetHackArchive(fs: MemoryFileSystem): number {
  const zipBytes = readFileSync(NETHACK_ZIP_PATH);
  const entries = parseZipCentralDirectory(new Uint8Array(zipBytes));
  const group = fs.registerLazyArchiveFromEntries("nethack.zip", entries, "/usr/");
  return group.entries.size;
}

// --- Main ---

async function main() {
  // Validate prerequisites
  try {
    lstatSync(DASH_PATH);
  } catch {
    console.error("dash.wasm not found. Run: bash build.sh");
    process.exit(1);
  }

  try {
    lstatSync(MAGIC_PATH);
  } catch {
    console.error("magic.lite not found. Build the file utility first.");
    process.exit(1);
  }

  try {
    lstatSync(VIM_ZIP_PATH);
  } catch {
    console.error(`vim.zip not found at ${VIM_ZIP_PATH}. Run: bash examples/browser/scripts/build-vim-zip.sh`);
    process.exit(1);
  }

  try {
    lstatSync(NETHACK_ZIP_PATH);
  } catch {
    console.error(`nethack.zip not found at ${NETHACK_ZIP_PATH}. Run: bash examples/browser/scripts/build-nethack-zip.sh`);
    process.exit(1);
  }

  // 16MB is sufficient for dash + symlinks + magic + vim stubs (archive
  // is fetched on demand so the image stays small)
  const sab = new SharedArrayBuffer(16 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  console.log("Populating system directories and configs...");
  populateSystem(fs);

  console.log("Writing dash binary and symlinks...");
  populateDash(fs);

  console.log("Creating coreutils symlinks...");
  populateCoreutilsSymlinks(fs);

  console.log("Creating grep/sed symlinks...");
  populateGrepSedSymlinks(fs);

  console.log("Registering vim lazy archive (binary + runtime stubs)...");
  const vimCount = populateVimArchive(fs);
  console.log(`  Vim archive: ${vimCount} entries (content deferred)`);

  console.log("Registering nethack lazy archive (binary + runtime stubs)...");
  const nhCount = populateNetHackArchive(fs);
  console.log(`  NetHack archive: ${nhCount} entries (content deferred)`);

  console.log("Creating extended tool symlinks...");
  populateExtendedSymlinks(fs);

  console.log("Writing magic database...");
  populateMagic(fs);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
