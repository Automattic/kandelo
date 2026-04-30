/**
 * Build a pre-built VFS image containing Erlang/OTP 28 runtime files
 * (kernel, stdlib, erts, compiler, and release boot scripts).
 *
 * Produces: examples/browser/public/erlang.vfs.zst
 *
 * Usage: npx tsx examples/browser/scripts/build-erlang-vfs-image.ts
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  walkAndWrite,
  saveImage,
} from "./vfs-image-helpers";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const LEGACY_INSTALL_DIR = join(REPO_ROOT, "examples", "libs", "erlang", "erlang-install");
const OUT_FILE = join(REPO_ROOT, "examples", "browser", "public", "erlang.vfs.zst");

/**
 * Resolve the OTP install tree.
 *
 *   1. If a local source build left the install at
 *      `examples/libs/erlang/erlang-install/`, use it directly.
 *   2. Otherwise, look up the erlang package's `erlang-otp.tar.zst`
 *      output in the resolver-managed cache and extract it once into
 *      a stable cache dir.
 */
function resolveOtpInstall(): string {
  if (existsSync(join(LEGACY_INSTALL_DIR, "lib", "kernel-10.4.2", "ebin"))) {
    return LEGACY_INSTALL_DIR;
  }
  const tarball = tryResolveBinary("programs/erlang/erlang-otp.tar.zst");
  if (!tarball) {
    console.error(
      "erlang-otp.tar.zst not resolvable. Run: bash examples/libs/erlang/build-erlang.sh\n" +
      "or fetch the latest binary release that ships the erlang multi-output package.",
    );
    process.exit(1);
  }
  const cacheRoot = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "wasm-posix-kernel")
    : join(homedir(), ".cache", "wasm-posix-kernel");
  const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const dest = join(cacheRoot, "vfs-build-sources", `erlang-otp-${sha.slice(0, 8)}`);
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    console.log(`==> Extracting ${tarball} → ${dest}`);
    execSync(`tar --zstd -xf "${tarball}" -C "${tmp}"`, { stdio: "inherit" });
    try { renameSync(tmp, dest); } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(dest)) throw e;
    }
  }
  return dest;
}

async function main() {
  const INSTALL_DIR = resolveOtpInstall();

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
