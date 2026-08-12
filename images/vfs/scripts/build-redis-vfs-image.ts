/**
 * Build a fully-bootable VFS image for the Redis demo. dinit, the first user process,
 * brings up redis-server on port 6379 with persistence disabled.
 *
 * Produces: apps/browser-demos/public/redis.vfs
 *
 * Usage: npx tsx images/vfs/scripts/build-redis-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import {
  exactVfsImageMetadata,
  saveImage,
  type ExactVfsImageAbi,
} from "./vfs-image-helpers";
import {
  addDinitInit,
  type DinitBinaryInputs,
} from "./dinit-image-helpers";

export interface RedisVfsImageBuildInputs {
  redis: Uint8Array;
  dinit?: DinitBinaryInputs;
  services?: Uint8Array;
  outputPath: string;
  targetAbi?: ExactVfsImageAbi;
}

export async function buildRedisVfsImage(
  inputs: RedisVfsImageBuildInputs,
): Promise<void> {
  const sab = new SharedArrayBuffer(32 * 1024 * 1024, { maxByteLength: 128 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 128 * 1024 * 1024);

  for (const dir of ["/tmp", "/home", "/dev", "/etc", "/run", "/var", "/data"]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
  fs.chmod("/data", 0o777);
  ensureDirRecursive(fs, "/usr/local/bin");

  writeVfsBinary(fs, "/usr/local/bin/redis-server", inputs.redis);

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
  ], { binaries: inputs.dinit, services: inputs.services });

  await saveImage(fs, inputs.outputPath, inputs.targetAbi === undefined
    ? {}
    : {
        kernelAbi: inputs.targetAbi.version,
        metadata: exactVfsImageMetadata(
          inputs.targetAbi,
          "images/vfs/scripts/build-redis-vfs-image.ts",
        ),
      });
}

async function main(): Promise<void> {
  const repositoryRoot = findRepoRoot();
  await buildRedisVfsImage({
    redis: new Uint8Array(
      readFileSync(resolveBinary("programs/redis/redis-server.wasm")),
    ),
    outputPath: join(
      repositoryRoot,
      "apps",
      "browser-demos",
      "public",
      "redis.vfs.zst",
    ),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
