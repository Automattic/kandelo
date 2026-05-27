/**
 * Build a pre-built VFS image containing the full shell environment.
 * The actual layout (dash, coreutils symlinks, grep/sed symlinks,
 * extended tool symlinks, magic database, lazy archive references)
 * lives in `shell-vfs-build.ts` so the WordPress (SQLite/LAMP) demos
 * can reuse it.
 *
 * Produces: apps/browser-demos/public/shell.vfs.zst
 *
 * Usage: npx tsx images/vfs/scripts/build-shell-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  saveImage,
  writeVfsBinary,
} from "./vfs-image-helpers";
import { populateShellEnvironment, resolveVfsArtifact } from "./shell-vfs-build";
import {
  externalAsset,
  framebufferPresentation,
  terminalPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";
import {
  DOOM_COMMAND,
  DOOM_WAD_SHA256,
  DOOM_WAD_URL,
  shellGuide,
} from "./kandelo-demo-guides";

const OUT_FILE = "apps/browser-demos/public/shell.vfs.zst";

async function main() {
  // 32 MB leaves room for dash, fbDOOM, symlinks, magic, and
  // lazy-archive stubs.
  // The eager binaries (bash, coreutils, etc.) are not baked here. Utility
  // stubs + sizes are baked as lazy VFS metadata and their bytes are fetched
  // on first exec.
  const sab = new SharedArrayBuffer(32 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  console.log("Populating shell environment...");
  populateShellEnvironment(fs, { eagerBinaries: false });
  console.log("Populating Doom runtime...");
  populateDoomRuntime(fs);
  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      shell: {
        presentation: terminalPresentation(),
        guide: shellGuide(),
      },
      doom: {
        presentation: framebufferPresentation(DOOM_COMMAND),
        assets: [
          externalAsset({
            path: "/doom1.wad",
            url: DOOM_WAD_URL,
            sha256: DOOM_WAD_SHA256,
            mode: 0o644,
            devCorsProxy: true,
          }),
        ],
      },
    },
  });

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
