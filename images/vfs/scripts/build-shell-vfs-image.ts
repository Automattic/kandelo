/**
 * Build a pre-built VFS image containing the full shell environment.
 * The base utility layout comes from the canonical rootfs image. The shell
 * overlay layout lives in `shell-vfs-build.ts` so the WordPress (SQLite/LAMP)
 * demos can reuse it where they still build standalone images.
 *
 * Produces: apps/browser-demos/public/shell.vfs
 *
 * Usage: npx tsx images/vfs/scripts/build-shell-vfs-image.ts
 */
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { readFileSync } from "node:fs";
import { saveImage } from "./vfs-image-helpers";
import { populateShellEnvironment } from "./shell-vfs-build";
import { resolveBinary } from "../../../host/src/binary-resolver";

const OUT_FILE = "apps/browser-demos/public/shell.vfs.zst";

function resolveRootfsImagePath(): string {
  try {
    return resolveBinary("rootfs.vfs");
  } catch {
    return resolveBinary("programs/rootfs.vfs");
  }
}

async function main() {
  const rootfsBytes = readFileSync(resolveRootfsImagePath());
  const fs = MemoryFileSystem.fromImage(new Uint8Array(rootfsBytes), {
    maxByteLength: 256 * 1024 * 1024,
  });

  console.log("Populating shell environment...");
  populateShellEnvironment(fs, { eagerBinaries: false, baseProvided: true });

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
