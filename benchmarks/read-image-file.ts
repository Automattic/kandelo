import type { VfsImageFilesystem } from "../host/src/vfs/vfs-image-filesystem";

type ImageReader = Pick<VfsImageFilesystem, "stat" | "open" | "read" | "close">;

export function readImageFileBytes(filesystem: ImageReader, path: string): ArrayBuffer {
  const size = filesystem.stat(path).size;
  if (!Number.isSafeInteger(size) || size < 0 || size > 0xffff_ffff) {
    throw new Error(`Invalid benchmark image file size for ${path}: ${size}`);
  }
  const result = new ArrayBuffer(size);
  const bytes = new Uint8Array(result);
  const handle = filesystem.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < size) {
      const window = bytes.subarray(offset, Math.min(size, offset + 64 * 1024));
      const read = filesystem.read(handle, window, null, window.byteLength);
      if (!Number.isSafeInteger(read) || read <= 0 || read > window.byteLength) {
        throw new Error(`Incomplete benchmark image read for ${path} at ${offset}: ${read}`);
      }
      offset += read;
    }
    return result;
  } finally {
    filesystem.close(handle);
  }
}
