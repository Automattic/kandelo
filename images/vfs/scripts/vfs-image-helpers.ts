/**
 * Build-script helpers for VFS images. Pure memfs operations are re-exported
 * from host/src/vfs/image-helpers.ts so demo runtime code can share them.
 * The Node-only helpers (host-disk walk, save-to-file) live here.
 */
import {
  readFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, relative } from "path";
import { zstdCompressSync, constants as zlibConstants } from "node:zlib";
import type {
  MemoryFileSystem,
  VfsImageMetadata,
} from "../../../host/src/vfs/memory-fs";
import { describeWasmArtifactPolicyFailures } from "../../../host/src/constants";
import { ABI_VERSION } from "../../../host/src/generated/abi";

export {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirRecursive,
  symlink,
} from "../../../host/src/vfs/image-helpers";

import { writeVfsBinary, ensureDirRecursive } from "../../../host/src/vfs/image-helpers";

export interface WalkOptions {
  exclude?: (relPath: string) => boolean;
  preserveMode?: boolean;
  preserveSymlinks?: boolean;
  failOnError?: boolean;
}

/**
 * Walk a host directory and write all files into the VFS under mountPrefix.
 * Returns the number of files written.
 */
export function walkAndWrite(
  fs: MemoryFileSystem,
  rootDir: string,
  mountPrefix: string,
  opts?: WalkOptions,
): number {
  let count = 0;
  ensureDirRecursive(fs, mountPrefix);

  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(rootDir, full);
      const mountPath = mountPrefix + "/" + rel;

      try {
        const lstat = lstatSync(full);
        if (opts?.exclude?.(rel)) continue;
        if (lstat.isSymbolicLink()) {
          if (opts?.preserveSymlinks) {
            ensureDirRecursive(fs, mountPath.slice(0, mountPath.lastIndexOf("/")) || "/");
            fs.symlink(readlinkSync(full), mountPath);
            count++;
          }
        } else if (lstat.isDirectory()) {
          ensureDirRecursive(fs, mountPath);
          if (opts?.preserveMode) fs.chmod(mountPath, lstat.mode & 0o7777);
          walk(full);
        } else if (lstat.isFile()) {
          const data = readFileSync(full);
          writeVfsBinary(
            fs,
            mountPath,
            new Uint8Array(data),
            opts?.preserveMode ? lstat.mode & 0o7777 : 0o644,
          );
          count++;
        }
      } catch (err) {
        if (opts?.failOnError) throw err;
        // Skip unreadable files
      }
    }
  }

  walk(rootDir);
  return count;
}

/**
 * Save a MemoryFileSystem image to disk as a zstd-compressed `.vfs.zst`
 * file. The empty regions of the SharedFS allocator compress to almost
 * nothing, so this typically shrinks images by 80–95%. The browser-side
 * loader (`MemoryFileSystem.fromImage`) detects the zstd magic and
 * decompresses on load.
 *
 * `outFile` must end in `.vfs.zst` to make the on-disk format obvious.
 */
export interface SaveImageOptions {
  metadata?: VfsImageMetadata;
  kernelAbi?: number;
  skipWasmArtifactCheck?: boolean;
}

function readVfsBytes(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const buf = new Uint8Array(st.size);
    fs.read(fd, buf, null, buf.length);
    return buf;
  } finally {
    fs.close(fd);
  }
}

function walkVfsFiles(fs: MemoryFileSystem, dir: string, out: string[] = []): string[] {
  let dh: number;
  try {
    dh = fs.opendir(dir);
  } catch {
    return out;
  }
  try {
    for (;;) {
      const entry = fs.readdir(dh);
      if (!entry) break;
      if (entry.name === "." || entry.name === "..") continue;
      const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
      let st;
      try {
        st = fs.lstat(path);
      } catch {
        continue;
      }
      const kind = st.mode & 0xf000;
      if (kind === 0x4000) {
        walkVfsFiles(fs, path, out);
      } else if (kind === 0x8000) {
        out.push(path);
      }
    }
  } finally {
    fs.closedir(dh);
  }
  return out;
}

function isWasm(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d;
}

function assertNoStaleWasmArtifacts(fs: MemoryFileSystem, kernelAbi: number): void {
  const failures: string[] = [];
  for (const path of walkVfsFiles(fs, "/")) {
    let bytes: Uint8Array;
    try {
      bytes = readVfsBytes(fs, path);
    } catch {
      continue;
    }
    if (!isWasm(bytes)) continue;
    const artifactBytes = new Uint8Array(bytes.byteLength);
    artifactBytes.set(bytes);
    const reasons = describeWasmArtifactPolicyFailures(
      artifactBytes.buffer,
      { expectedAbi: kernelAbi },
    );
    if (reasons.length > 0) failures.push(`${path}: ${reasons.join("; ")}`);
  }
  if (failures.length > 0) {
    throw new Error(
      "Refusing to save VFS image with stale wasm artifacts:\n" +
        failures.map((line) => `  ${line}`).join("\n"),
    );
  }
}

export async function saveImage(
  fs: MemoryFileSystem,
  outFile: string,
  options: SaveImageOptions = {},
): Promise<Uint8Array> {
  if (!outFile.endsWith(".vfs.zst")) {
    throw new Error(
      `saveImage outFile must end in .vfs.zst (got: ${outFile})`,
    );
  }

  console.log("Saving VFS image...");
  const kernelAbi = options.kernelAbi ?? ABI_VERSION;
  if (!options.skipWasmArtifactCheck) {
    assertNoStaleWasmArtifacts(fs, kernelAbi);
  }
  const metadata = options.metadata ??
    {
          version: 1 as const,
          kernelAbi,
          createdBy: "images/vfs/scripts/saveImage",
        };
  const image = await fs.saveImage({ metadata });
  // Level 19 — slow build, smaller download. Decompression speed is
  // unaffected by compression level, so this is a one-sided trade.
  const compressed = zstdCompressSync(image, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
  });

  const outDir = outFile.substring(0, outFile.lastIndexOf("/"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, compressed);

  const rawMB = (image.byteLength / (1024 * 1024)).toFixed(1);
  const compMB = (compressed.byteLength / (1024 * 1024)).toFixed(1);
  const ratio = ((compressed.byteLength / image.byteLength) * 100).toFixed(1);
  console.log(`VFS image: ${rawMB} MB raw → ${compMB} MB zstd (${ratio}%)`);
  console.log(`Written to: ${outFile}`);
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}
