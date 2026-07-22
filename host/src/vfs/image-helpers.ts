/**
 * Pure VFS-image construction helpers — operate on a MemoryFileSystem in
 * memory. No host-disk I/O. Safe to use anywhere a memfs exists: build
 * scripts, Node demos, browser demos, tests.
 *
 * For host-disk-aware utilities (walking a directory, saving to a file),
 * see scripts-side helpers.
 */
import type { MemoryFileSystem } from "./memory-fs";
import { EEXIST } from "./sharedfs-vendor";

const O_WRONLY_CREAT_TRUNC = 0o1101;

/** Write text content to a path in the memfs. Creates parent dirs implicitly via writeVfsBinary. */
export function writeVfsFile(
  fs: MemoryFileSystem,
  path: string,
  content: string,
  mode = 0o644,
): void {
  writeVfsBinary(fs, path, new TextEncoder().encode(content), mode);
}

/** Write binary content to a path in the memfs. */
export function writeVfsBinary(
  fs: MemoryFileSystem,
  path: string,
  data: Uint8Array,
  mode = 0o755,
): void {
  const fd = fs.open(path, O_WRONLY_CREAT_TRUNC, mode);
  try {
    let offset = 0;
    while (offset < data.length) {
      const remaining = data.subarray(offset);
      const written = fs.write(fd, remaining, offset, remaining.length);
      if (
        !Number.isInteger(written)
        || written <= 0
        || written > remaining.length
      ) {
        const detail = written < 0
          ? `write failed with error code ${written}`
          : `write made invalid progress ` +
            `(${written} of ${remaining.length} remaining bytes)`;
        throw new Error(`Failed to stage complete VFS file ${path}: ${detail}`);
      }
      offset += written;
    }
  } finally {
    fs.close(fd);
  }
}

function hasVfsErrorCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code: unknown }).code === code;
}

/** mkdir, swallowing only EEXIST. */
export function ensureDir(
  fs: MemoryFileSystem,
  path: string,
  mode = 0o755,
): void {
  try {
    fs.mkdir(path, mode);
  } catch (error) {
    if (!hasVfsErrorCode(error, EEXIST)) throw error;
  }
}

/** mkdir -p — creates every missing component along the path. */
export function ensureDirRecursive(
  fs: MemoryFileSystem,
  path: string,
  mode = 0o755,
): void {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    ensureDir(fs, current, mode);
  }
}

/** symlink, swallowing only EEXIST. */
export function symlink(fs: MemoryFileSystem, target: string, path: string): void {
  try {
    fs.symlink(target, path);
  } catch (error) {
    if (!hasVfsErrorCode(error, EEXIST)) throw error;
  }
}
