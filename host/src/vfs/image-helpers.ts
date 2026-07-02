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

/** True when a thrown memfs error carries the given negative errno code. */
function isErrno(err: unknown, code: number): boolean {
  return (err as { code?: number } | null)?.code === code;
}

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

/**
 * mkdir a single directory, swallowing only EEXIST (the directory already
 * exists). Any other failure — e.g. ENOSPC (out of space), ENOTDIR (a path
 * component is a file), ENOENT (parent missing) — is a real error and is
 * rethrown. Swallowing those masks the failure: a silently-skipped mkdir
 * resurfaces far away as a confusing "No such file or directory" when a later
 * write cannot resolve the parent that never got created (see kd-n6vr: a
 * perl-vfs build overflowed a too-small buffer, ENOSPC was swallowed here, and
 * it surfaced as an ENOENT at an unrelated file write).
 */
export function ensureDir(fs: MemoryFileSystem, path: string): void {
  try {
    fs.mkdir(path, 0o755);
  } catch (err) {
    if (isErrno(err, EEXIST)) return;
    throw err;
  }
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

/** symlink, swallowing only EEXIST; any other failure is rethrown (see ensureDir). */
export function symlink(fs: MemoryFileSystem, target: string, path: string): void {
  try {
    fs.symlink(target, path);
  } catch (err) {
    if (isErrno(err, EEXIST)) return;
    throw err;
  }
}
