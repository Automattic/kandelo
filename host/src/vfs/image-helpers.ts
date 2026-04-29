/**
 * Pure VFS-image construction helpers — operate on a MemoryFileSystem in
 * memory. No host-disk I/O. Safe to use anywhere a memfs exists: build
 * scripts, Node demos, browser demos, tests.
 *
 * For host-disk-aware utilities (walking a directory, saving to a file),
 * see scripts-side helpers.
 */
import type { MemoryFileSystem } from "./memory-fs";

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
  fs.write(fd, data, 0, data.length);
  fs.close(fd);
}

/** mkdir, swallowing EEXIST. */
export function ensureDir(fs: MemoryFileSystem, path: string): void {
  try { fs.mkdir(path, 0o755); } catch { /* exists */ }
}

/** mkdir -p — creates every missing component along the path. */
export function ensureDirRecursive(fs: MemoryFileSystem, path: string): void {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    ensureDir(fs, current);
  }
}

/** symlink, swallowing EEXIST. */
export function symlink(fs: MemoryFileSystem, target: string, path: string): void {
  try { fs.symlink(target, path); } catch { /* exists */ }
}
