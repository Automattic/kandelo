/**
 * Build a pre-built VFS image containing the full shell environment:
 * dash, coreutils symlinks, grep/sed symlinks, extended tool symlinks,
 * magic database, vim runtime, and system configs.
 *
 * Produces: examples/browser/public/shell.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-shell-vfs-image.ts
 */
import { readFileSync, lstatSync } from "fs";
import { join } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { COREUTILS_NAMES } from "../lib/init/shell-binaries";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirRecursive,
  symlink,
  walkAndWrite,
  saveImage,
} from "./vfs-image-helpers";

const DASH_PATH = "examples/libs/dash/bin/dash.wasm";
const MAGIC_PATH = "examples/libs/file/bin/magic.lite";
const VIM_RUNTIME_DIR = "examples/libs/vim/runtime";
const OUT_FILE = "examples/browser/public/shell.vfs";

// --- System setup ---

function populateSystem(fs: MemoryFileSystem): void {
  for (const dir of [
    "/bin", "/usr/bin", "/usr/local/bin", "/usr/share", "/usr/share/misc",
    "/usr/share/file", "/etc", "/root", "/tmp", "/home", "/dev", "/usr/sbin",
  ]) {
    ensureDirRecursive(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

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

  // Shell profile — color aliases for interactive sessions
  const profile = "alias ls='ls --color=auto'\nalias grep='grep --color=auto'\n";
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

  // lsof
  symlink(fs, "/usr/bin/lsof", "/bin/lsof");
}

// --- Magic database ---

function populateMagic(fs: MemoryFileSystem): void {
  const magicBytes = readFileSync(MAGIC_PATH);
  writeVfsBinary(fs, "/usr/share/misc/magic", new Uint8Array(magicBytes), 0o644);
}

// --- Vim runtime ---

function populateVimRuntime(fs: MemoryFileSystem): number {
  return walkAndWrite(fs, VIM_RUNTIME_DIR, "/usr/share/vim/vim91");
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

  // 16MB is sufficient for dash + symlinks + magic + vim runtime
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

  console.log("Creating extended tool symlinks...");
  populateExtendedSymlinks(fs);

  console.log("Writing magic database...");
  populateMagic(fs);

  console.log("Writing Vim runtime files...");
  const vimCount = populateVimRuntime(fs);
  console.log(`  Vim runtime: ${vimCount} files`);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
