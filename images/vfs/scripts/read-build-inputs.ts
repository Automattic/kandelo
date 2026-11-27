/** Bounded stable read of resolver-owned build metadata. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
export function readBuildInputs(path: string): unknown {
  if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/.test(path)) throw Error("Invalid build input metadata path");
  if (realpathSync(path) !== path) throw new Error("Build input metadata cross a symlink");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new Error("Build input metadata must be a regular file within 4 MiB");
    const namedBefore = lstatSync(path);
    if (namedBefore.isSymbolicLink() || namedBefore.dev !== before.dev || namedBefore.ino !== before.ino) throw new Error("Build input metadata changed before read");
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("Build input metadata ended during read");
      offset += count;
    }
    const after = fstatSync(descriptor);
    const namedAfter = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size ||
      namedAfter.isSymbolicLink() || namedAfter.dev !== after.dev || namedAfter.ino !== after.ino || realpathSync(path) !== path) {
      throw new Error("Build input metadata changed during read");
    }
  } finally { closeSync(descriptor); }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
