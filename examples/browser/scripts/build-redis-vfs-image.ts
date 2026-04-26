/**
 * Build a fully-bootable VFS image for the Redis demo. dinit (PID 1)
 * brings up redis-server on port 6379 with persistence disabled.
 *
 * Produces: examples/browser/public/redis.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-redis-vfs-image.ts
 */
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { saveImage } from "./vfs-image-helpers";
import { addDinitInit } from "./dinit-image-helpers";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const REDIS_WASM = join(REPO_ROOT, "examples", "libs", "redis", "bin", "redis-server.wasm");
const OUT_FILE = join(REPO_ROOT, "examples", "browser", "public", "redis.vfs");

async function main() {
  try { lstatSync(REDIS_WASM); }
  catch { throw new Error(`redis-server.wasm not found at ${REDIS_WASM} — run 'bash run.sh build redis'`); }

  const sab = new SharedArrayBuffer(32 * 1024 * 1024, { maxByteLength: 128 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 128 * 1024 * 1024);

  for (const dir of ["/tmp", "/home", "/dev", "/etc", "/run", "/var", "/data"]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
  fs.chmod("/data", 0o777);
  ensureDirRecursive(fs, "/usr/local/bin");

  writeVfsBinary(fs, "/usr/local/bin/redis-server", new Uint8Array(readFileSync(REDIS_WASM)));

  // dinit + service tree.
  // Persistence disabled (--save "" --appendonly no) since the in-kernel
  // VFS doesn't survive page reload anyway. --io-threads 1 keeps the
  // process count manageable for the browser's worker budget.
  addDinitInit(fs, [
    {
      name: "redis",
      type: "process",
      command:
        "/usr/local/bin/redis-server --port 6379 --bind 0.0.0.0 " +
        "--save \"\" --appendonly no --io-threads 1 --dir /data",
      restart: true,
      restartDelay: 2,
    },
  ]);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
