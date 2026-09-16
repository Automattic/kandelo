import type { VfsImageFilesystem } from "./vfs-image-filesystem";
import {
  EEXIST,
} from "./vfs-errors";
/**
 * Pure VFS-image construction helpers — operate on a VfsImageFilesystem in
 * memory. No host-disk I/O. Safe to use anywhere a memfs exists: build
 * scripts, Node demos, browser demos, tests.
 *
 * For host-disk-aware utilities (walking a directory, saving to a file),
 * see scripts-side helpers.
 */
import { OPEN_FLAGS } from "../generated/abi";

const O_WRONLY_CREAT_TRUNC =
  OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_TRUNC;

/** Write text content to a path in the memfs. Creates parent dirs implicitly via writeVfsBinary. */
export function writeVfsFile(
  fs: VfsImageFilesystem,
  path: string,
  content: string,
  mode = 0o644,
): void {
  writeVfsBinary(fs, path, new TextEncoder().encode(content), mode);
}

/** Write binary content to a path in the memfs. */
export function writeVfsBinary(
  fs: VfsImageFilesystem,
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

/**
 * Does this error carry `code`, whatever the filesystem calls the field?
 *
 * The two implementations disagree twice over: `MemoryFileSystem` throws an
 * error with a NEGATIVE `code`, and the module bridge throws `KandeloImageError`
 * with a POSITIVE `errno`. This helper is what the EEXIST-swallowing wrappers below use, so
 * recognising only one spelling turns "swallow only EEXIST" into "rethrow
 * everything" for the other one — silently, because the wrapper still looks
 * like it is swallowing.
 *
 * It surfaced as `EEXIST: mkdir /usr` from a builder that had created `/usr`
 * exactly once and expected the second, idempotent call to be absorbed.
 *
 * `errno` is the surviving spelling; the `code` arm goes when `memory-fs.ts`
 * does.
 */
export function hasVfsErrorCode(error: unknown, code: number): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  const raw = typeof candidate.code === "number"
    ? candidate.code
    : typeof candidate.errno === "number"
      ? candidate.errno
      : undefined;
  if (raw === undefined) return false;
  // Compared as magnitudes because the two implementations disagree about the
  // SIGN as well as the field name: `vfs-errors.ts` defines `EEXIST` as
  // `-ERRNO.EEXIST` (the negative form a syscall returns), and the module
  // bridge reports the positive errno. Comparing them directly is how this
  // check silently answered "no" for every module error.
  return Math.abs(raw) === Math.abs(code);
}

/** mkdir, swallowing only EEXIST. */
export function ensureDir(
  fs: VfsImageFilesystem,
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
  fs: VfsImageFilesystem,
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
export function symlink(fs: VfsImageFilesystem, target: string, path: string): void {
  try {
    fs.symlink(target, path);
  } catch (error) {
    if (!hasVfsErrorCode(error, EEXIST)) throw error;
  }
}
