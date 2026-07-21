/**
 * Build a pre-built VFS image containing the full shell environment.
 * The base utility layout comes from the canonical rootfs image. The shell
 * overlay layout lives in `shell-vfs-build.ts` so the WordPress (SQLite/LAMP)
 * demos can reuse it where they still build standalone images.
 *
 * Produces: apps/browser-demos/public/shell.vfs.zst
 *
 * Usage: npx tsx images/vfs/scripts/build-shell-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  saveImage,
  writeVfsBinary,
} from "./vfs-image-helpers";
import { populateShellEnvironment, resolveVfsArtifact } from "./shell-vfs-build";
import { writeMainShellDemoConfig } from "./main-shell-demo-config";

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

  console.log("Populating Doom runtime...");
  populateDoomRuntime(fs);
  console.log("Populating modeset runtime...");
  populateModesetRuntime(fs);
  writeMainShellDemoConfig(fs);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function populateDoomRuntime(fs: MemoryFileSystem): void {
  const fbdoomBytes = readFileSync(resolveVfsArtifact("programs/fbdoom.wasm", "fbdoom"));
  writeVfsBinary(fs, "/usr/local/bin/fbdoom", new Uint8Array(fbdoomBytes), 0o755);
}

function populateModesetRuntime(fs: MemoryFileSystem): void {
  const modesetBytes = readFileSync(resolveVfsArtifact("programs/modeset.wasm", "modeset"));
  writeVfsBinary(fs, "/usr/local/bin/modeset", new Uint8Array(modesetBytes), 0o755);
}
