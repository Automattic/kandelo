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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
import { resolveBinary } from "../../../host/src/binary-resolver";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  saveImage,
  walkAndWrite,
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
  console.log("Populating espeak-ng runtime...");
  populateEspeakRuntime(fs);
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

function populateEspeakRuntime(fs: MemoryFileSystem): void {
  const espeakBytes = readFileSync(resolveVfsArtifact("programs/espeak-ng.wasm", "espeak-ng"));
  writeVfsBinary(fs, "/usr/bin/espeak-ng", new Uint8Array(espeakBytes), 0o755);

  // espeak-ng's PATH_ESPEAK_DATA macro is baked at build time to
  // /usr/share/espeak-ng-data (set via CMAKE_INSTALL_PREFIX=/usr in
  // build-espeak-ng.sh). The runtime walks lang/<group>/<voice>,
  // voices/!v/*, phondata, phonindex, phontab, intonations, and per-
  // language *_dict files — copying the whole tree is the simplest
  // shape and the trimmed English-only data dir is only ~1.9 MB.
  const dataDir = path.join(
    SCRIPT_DIR,
    "../../../packages/registry/espeak-ng/espeak-ng-install/share/espeak-ng-data",
  );
  if (!existsSync(dataDir)) {
    throw new Error(
      `populateEspeakRuntime: espeak-ng-data not found at ${dataDir}. ` +
        `Run \`bash packages/registry/espeak-ng/build-espeak-ng.sh\` first.`,
    );
  }
  ensureDirRecursive(fs, "/usr/share/espeak-ng-data");
  const fileCount = walkAndWrite(fs, dataDir, "/usr/share/espeak-ng-data");
  console.log(`  staged ${fileCount} espeak-ng-data files at /usr/share/espeak-ng-data`);
}
