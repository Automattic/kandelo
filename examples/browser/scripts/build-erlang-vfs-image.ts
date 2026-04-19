/**
 * Build a pre-built VFS image containing Erlang/OTP 28 runtime files
 * (kernel, stdlib, erts, compiler, and release boot scripts).
 *
 * Produces: examples/browser/public/erlang.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-erlang-vfs-image.ts
 */
import { lstatSync } from "fs";
import { join } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  walkAndWrite,
  saveImage,
} from "./vfs-image-helpers";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const INSTALL_DIR = join(REPO_ROOT, "examples", "libs", "erlang", "erlang-install");
const OUT_FILE = join(REPO_ROOT, "examples", "browser", "public", "erlang.vfs");

async function main() {
  // Validate prerequisites
  const ebinCheck = join(INSTALL_DIR, "lib", "kernel-10.4.2", "ebin");
  try {
    lstatSync(ebinCheck);
  } catch {
    console.error(`Erlang OTP install not found at: ${ebinCheck}`);
    console.error("Ensure the Erlang/OTP install exists at examples/libs/erlang/erlang-install");
    process.exit(1);
  }

  // Create a 16MB MemoryFileSystem — OTP ebin files are relatively small
  const sab = new SharedArrayBuffer(16 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  // Standard directories
  ensureDir(fs, "/tmp");
  fs.chmod("/tmp", 0o777);
  ensureDir(fs, "/home");

  // OTP directory tree
  ensureDirRecursive(fs, "/usr/local/lib/erlang");
  ensureDirRecursive(fs, "/usr/local/lib/erlang/lib");
  ensureDirRecursive(fs, "/usr/local/lib/erlang/releases");

  // Walk specific OTP directories
  const otpLibs: Array<{ src: string; dest: string }> = [
    { src: "lib/kernel-10.4.2/ebin",   dest: "/usr/local/lib/erlang/lib/kernel-10.4.2/ebin" },
    { src: "lib/stdlib-7.1/ebin",       dest: "/usr/local/lib/erlang/lib/stdlib-7.1/ebin" },
    { src: "lib/erts-16.1.2/ebin",      dest: "/usr/local/lib/erlang/lib/erts-16.1.2/ebin" },
    { src: "lib/compiler-9.0.3/ebin",   dest: "/usr/local/lib/erlang/lib/compiler-9.0.3/ebin" },
    { src: "releases/28",               dest: "/usr/local/lib/erlang/releases/28" },
  ];

  let totalFiles = 0;
  for (const { src, dest } of otpLibs) {
    const srcDir = join(INSTALL_DIR, src);
    console.log(`Writing ${src}...`);
    const count = walkAndWrite(fs, srcDir, dest);
    console.log(`  ${count} files`);
    totalFiles += count;
  }

  console.log(`Total: ${totalFiles} files`);
  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
