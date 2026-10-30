import type { KandeloImageFs } from "../../../../../images/vfs/lib/kandelo-image-fs";
import { ERRNO } from "../../../../../host/src/generated/abi";

export const MAX_COMPOSER_FILE_BYTES = 1024 * 1024;
export const COMPOSER_READ_CHUNK_BYTES = 64 * 1024;

export function readComposerFile(
  filesystem: Pick<KandeloImageFs, "stat" | "open" | "read" | "close">,
  path: string,
): ArrayBuffer {
  const length = filesystem.stat(path).size;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_COMPOSER_FILE_BYTES) {
    throw Object.assign(new Error(`Composer patch input ${path} exceeds the ${MAX_COMPOSER_FILE_BYTES}-byte limit`),
      { code: "ENOMEM", errno: ERRNO.ENOMEM });
  }
  const bytes = new Uint8Array(length);
  const descriptor = filesystem.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < length) {
      const destination = bytes.subarray(offset, Math.min(length, offset + COMPOSER_READ_CHUNK_BYTES));
      const count = filesystem.read(descriptor, destination, null, destination.byteLength);
      if (!Number.isInteger(count) || count <= 0 || count > destination.byteLength) {
        throw Object.assign(new Error(`Composer patch input ${path} could not be read completely`),
          { code: "EIO", errno: ERRNO.EIO });
      }
      offset += count;
    }
    return bytes.buffer;
  } finally { filesystem.close(descriptor); }
}
