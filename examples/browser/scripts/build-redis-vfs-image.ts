/**
 * Build a fully-bootable VFS image for the Redis demo. dinit (PID 1)
 * brings up redis-server on port 6379 with persistence disabled.
 *
 * Produces: examples/browser/public/redis.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-redis-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { saveImage } from "./vfs-image-helpers";
import { addDinitInit } from "./dinit-image-helpers";

const OUT_FILE = join(findRepoRoot(), "examples", "browser", "public", "redis.vfs");

async function main() {
  const REDIS_WASM = resolveBinary("programs/redis/redis-server.wasm");

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
