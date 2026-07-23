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
import {
  MemoryFileSystem,
  type VfsImageMetadata,
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
  preserveSymlinks?: true;
}

/**
 * Walk a host directory and write all files into the VFS under mountPrefix.
 * Any host-read or VFS-write failure aborts the build. Product images must not
 * silently omit an entry; callers that intentionally exclude content must do
 * so through `exclude`.
 *
 * Unexcluded symlinks must be preserved explicitly. Silently omitting a
 * representable entry would produce an incomplete product image.
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

      const lstat = lstatSync(full);
      if (opts?.exclude?.(rel)) continue;
      if (lstat.isSymbolicLink()) {
        if (!opts?.preserveSymlinks) {
          throw new Error(
            `VFS image source symlink requires preserveSymlinks or an explicit exclude: ${full}`,
          );
        }
        ensureDirRecursive(fs, mountPath.slice(0, mountPath.lastIndexOf("/")) || "/");
        fs.symlink(readlinkSync(full), mountPath);
        count++;
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
      } else {
        throw new Error(`Unsupported VFS image source entry: ${full}`);
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
  /** Normalize all serialized inode times for reproducible product images. */
  normalizeTimestampsMs?: number;
  /** Runtime allocation reserve that must remain after build-time population. */
  headroom?: VfsImageHeadroom;
  /** Exact growth ceiling that the serialized artifact must encode. */
  expectedMaxByteLength?: number;
}

export interface VfsImageHeadroom {
  minimumFreeBytes: number;
  minimumFreeInodes: number;
}

const MAX_SOURCE_DATE_EPOCH_SECONDS = Math.floor(
  Number.MAX_SAFE_INTEGER / 1000,
);

/** Resolve reproducible build time from SOURCE_DATE_EPOCH, defaulting to epoch. */
export function sourceDateEpochMilliseconds(
  value: string | undefined,
): number {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`SOURCE_DATE_EPOCH must be a non-negative whole second: ${value}`);
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_SOURCE_DATE_EPOCH_SECONDS) {
    throw new Error(`SOURCE_DATE_EPOCH exceeds the supported timestamp range: ${value}`);
  }
  return seconds * 1000;
}

function readVfsBytes(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const buf = new Uint8Array(st.size);
    let offset = 0;
    while (offset < buf.length) {
      const remaining = buf.length - offset;
      const count = fs.read(fd, buf.subarray(offset), null, remaining);
      if (!Number.isSafeInteger(count) || count <= 0 || count > remaining) {
        throw new Error(
          `Incomplete VFS artifact read for ${path}: ` +
            `${offset} of ${buf.length} bytes before result ${count}`,
        );
      }
      offset += count;
    }
    return buf;
  } finally {
    fs.close(fd);
  }
}

/**
 * Reject a product image during its build when normal runtime writes would
 * immediately run out of data blocks or inode slots. SharedFS accounts for
 * those resources independently, so both reserves are part of the contract.
 */
export function assertVfsImageHeadroom(
  fs: MemoryFileSystem,
  headroom: VfsImageHeadroom,
  label: string,
): void {
  for (const [name, value] of [
    ["minimumFreeBytes", headroom.minimumFreeBytes],
    ["minimumFreeInodes", headroom.minimumFreeInodes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} ${name} must be a non-negative safe integer`);
    }
  }

  const stats = fs.statfs("/");
  const freeBytes = stats.bfree * stats.frsize;
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
    throw new Error(`${label} reports an invalid free-byte count`);
  }
  if (!Number.isSafeInteger(stats.ffree) || stats.ffree < 0) {
    throw new Error(`${label} reports an invalid free-inode count`);
  }
  const failures: string[] = [];
  if (freeBytes < headroom.minimumFreeBytes) {
    failures.push(
      `${freeBytes} free bytes remain; ${headroom.minimumFreeBytes} are required`,
    );
  }
  if (stats.ffree < headroom.minimumFreeInodes) {
    failures.push(
      `${stats.ffree} free inodes remain; ${headroom.minimumFreeInodes} are required`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`${label} lacks runtime VFS headroom: ${failures.join("; ")}`);
  }
}

/** Require a serialized artifact's encoded growth ceiling to match its product profile. */
export function assertVfsImageCapacity(
  image: Uint8Array,
  expectedMaxByteLength: number,
  label: string,
): void {
  if (!Number.isSafeInteger(expectedMaxByteLength) || expectedMaxByteLength <= 0) {
    throw new Error(
      `${label} expectedMaxByteLength must be a positive safe integer`,
    );
  }
  const actualMaxByteLength =
    MemoryFileSystem.readImageCapacity(image).maxByteLength;
  if (actualMaxByteLength !== expectedMaxByteLength) {
    throw new Error(
      `${label} has a ${actualMaxByteLength}-byte VFS capacity; ` +
        `${expectedMaxByteLength} bytes are required by its product profile`,
    );
  }
}

function walkVfsFiles(fs: MemoryFileSystem, dir: string, out: string[] = []): string[] {
  // WHY: this walk protects the artifact that will be published. A namespace
  // inspection failure is not an intentional omission and must stop the build.
  const dh = fs.opendir(dir);
  try {
    for (;;) {
      const entry = fs.readdir(dh);
      if (!entry) break;
      if (entry.name === "." || entry.name === "..") continue;
      const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
      const st = fs.lstat(path);
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
    // WHY: a deferred entry deliberately has no local bytes to inspect; its
    // closed package identity is validated at registration/materialization.
    // Every non-deferred read failure could otherwise hide a stale artifact.
    if (fs.isPathDeferred(path)) continue;
    const bytes = readVfsBytes(fs, path);
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
  if (options.headroom) {
    assertVfsImageHeadroom(fs, options.headroom, outFile);
  }
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
  const image = await fs.saveImage({
    metadata,
    normalizeTimestampsMs: options.normalizeTimestampsMs,
  });
  if (options.expectedMaxByteLength !== undefined) {
    assertVfsImageCapacity(image, options.expectedMaxByteLength, outFile);
  }
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
