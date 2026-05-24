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
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { resolveBinary } from "../../../host/src/binary-resolver";
import {
  saveImage,
  writeVfsBinary,
} from "./vfs-image-helpers";
import { populateShellEnvironment } from "./shell-vfs-build";
import {
  externalAsset,
  framebufferPresentation,
  terminalPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";
import { shellGuide } from "./kandelo-demo-guides";

const OUT_FILE = "apps/browser-demos/public/shell.vfs.zst";
const DOOM_COMMAND = "/usr/local/bin/fbdoom -iwad /doom1.wad";
const DOOM_WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";
const DOOM_WAD_SHA256 = "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";

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
  const fbdoomBytes = readFileSync(resolveBinary("programs/fbdoom.wasm"));
  writeVfsBinary(fs, "/usr/local/bin/fbdoom", new Uint8Array(fbdoomBytes), 0o755);
}
