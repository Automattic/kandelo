export const MAX_VFS_FILE_RANGE_BYTES = 1024 * 1024;

export function assertVfsFileRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length <= 0 || length > MAX_VFS_FILE_RANGE_BYTES ||
      !Number.isSafeInteger(offset + length)) {
    throw new RangeError("VFS file range must have a safe offset and at most 1 MiB of bytes");
  }
}
