import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { resolve } from "node:path";

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function requireNamedFile(path: string, opened: Stats): void {
  const named = lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink() || realpathSync(path) !== resolve(path) || !sameFile(opened, named)) {
    throw new Error(`Original-program artifact changed or crosses a symlink: ${path}`);
  }
}

export function readStableArtifactIdentity(path: string): { mode: number; size: number; sha256: string } {
  const limit = 512 * 1024 * 1024;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) {
      throw new Error(`Artifact must be a regular file within the ${limit}-byte limit: ${path}`);
    }
    requireNamedFile(path, before);
    const digest = createHash("sha256");
    const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (count === 0) throw new Error(`Original-program artifact ended during its stable read: ${path}`);
      digest.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (!sameFile(before, after)) throw new Error(`Original-program artifact changed during its stable read: ${path}`);
    requireNamedFile(path, after);
    return { mode: before.mode & 0o7777, size: before.size, sha256: digest.digest("hex") };
  } finally { closeSync(descriptor); }
}
