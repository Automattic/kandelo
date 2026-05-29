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
import { posix as pathPosix } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { extractZipEntry, parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import {
  ensureDirRecursive,
  saveImage,
  writeVfsBinary,
} from "./vfs-image-helpers";
import { populateShellEnvironment, resolveVfsArtifact } from "./shell-vfs-build";
import {
  externalAsset,
  framebufferPresentation,
  type DemoPresentationConfig,
  terminalPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";
import {
  BYTEPATH_COMMAND,
  DOOM_COMMAND,
  DOOM_WAD_SHA256,
  DOOM_WAD_URL,
  LOVE_COMMAND,
  bytepathGuide,
  loveGuide,
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
  console.log("Populating modeset runtime...");
  populateModesetRuntime(fs);
  console.log("Populating LOVE runtime...");
  populateLoveRuntime(fs);
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
      modeset: {
        presentation: kmsPresentation("/usr/local/bin/modeset"),
      },
      love: {
        presentation: framebufferPresentation(LOVE_COMMAND),
        guide: loveGuide(),
      },
      bytepath: {
        presentation: framebufferPresentation(BYTEPATH_COMMAND),
        guide: bytepathGuide(),
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

function populateModesetRuntime(fs: MemoryFileSystem): void {
  const modesetBytes = readFileSync(resolveVfsArtifact("programs/modeset.wasm", "modeset"));
  writeVfsBinary(fs, "/usr/local/bin/modeset", new Uint8Array(modesetBytes), 0o755);
}

function kmsPresentation(autoCommand: string): DemoPresentationConfig {
  return {
    bootPrimary: "syslog",
    runningPrimary: ["kms", "terminal", "syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
    autoCommand,
  };
}

function populateLoveRuntime(fs: MemoryFileSystem): void {
  const loveBytes = readFileSync(resolveVfsArtifact("programs/love/love.wasm", "love"));
  writeVfsBinary(fs, "/usr/local/bin/love", new Uint8Array(loveBytes), 0o755);

  const zipBytes = new Uint8Array(
    readFileSync(resolveVfsArtifact("programs/love/love-examples.zip", "love")),
  );
  const root = "/usr/local/share/love/examples";
  ensureDirRecursive(fs, root);
  for (const entry of parseZipCentralDirectory(zipBytes)) {
    const cleanName = entry.fileName.replace(/^\/+/, "");
    if (!cleanName || cleanName.includes("..")) continue;
    const target = `${root}/${cleanName}`;
    if (entry.isDirectory) {
      ensureDirRecursive(fs, target);
      continue;
    }
    if (entry.isSymlink) continue;
    ensureDirRecursive(fs, pathPosix.dirname(target));
    writeVfsBinary(fs, target, extractZipEntry(zipBytes, entry), entry.mode & 0o777 || 0o644);
  }
}
