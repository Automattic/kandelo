/**
 * Low-level VFS write utilities for populating the in-memory filesystem.
 *
 * These helpers wrap MemoryFileSystem operations with convenient defaults
 * and are used by demo build scripts that construct VFS images.
 */
import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";

const encoder = new TextEncoder();

/**
 * Write a text file to the VFS. Opens with O_WRONLY|O_CREAT|O_TRUNC,
 * writes the encoded content, and closes the fd.
 */
export function writeVfsFile(
  fs: MemoryFileSystem,
  path: string,
  content: string,
  mode = 0o644,
): void {
  const data = encoder.encode(content);
  const fd = fs.open(path, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
  fs.write(fd, data, 0, data.length);
  fs.close(fd);
}

/**
 * Write a binary file to the VFS. Opens with O_WRONLY|O_CREAT|O_TRUNC,
 * writes the raw bytes, and closes the fd.
 */
export function writeVfsBinary(
  fs: MemoryFileSystem,
  path: string,
  data: Uint8Array,
  mode = 0o755,
): void {
  const fd = fs.open(path, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
  fs.write(fd, data, 0, data.length);
  fs.close(fd);
}

/**
 * Create a directory, ignoring EEXIST errors.
 */
export function ensureDir(
  fs: MemoryFileSystem,
  path: string,
  mode = 0o755,
): void {
  try {
    fs.mkdir(path, mode);
  } catch {
    /* already exists */
  }
}

/**
 * Create multiple directories, ignoring EEXIST errors.
 */
export function ensureDirs(fs: MemoryFileSystem, paths: string[]): void {
  for (const path of paths) {
    ensureDir(fs, path);
  }
}

/**
 * Recursively ensure all components of a path exist as directories.
 * E.g. ensureDirRecursive(fs, "/a/b/c") creates /a, /a/b, /a/b/c.
 */
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

