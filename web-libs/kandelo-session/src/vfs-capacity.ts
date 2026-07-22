export const DEFAULT_VFS_PROFILE_MAX_BYTES = 256 * 1024 * 1024;
export const MAIN_SHELL_VFS_PROFILE_MAX_BYTES = 512 * 1024 * 1024;
// A product image must have room to copy the canonical shell's complete inode
// inventory and then add its own files. SharedFS sizes its inode table from the
// declared byte ceiling, so reusing the shell's exact ceiling can exhaust
// inodes even while statfs still reports hundreds of MiB of free data blocks.
export const SHELL_DERIVED_VFS_PROFILE_MAX_BYTES =
  768 * 1024 * 1024;
// Product images need space for ordinary runtime state after their immutable
// build contents have been written. Build-time save helpers enforce both
// dimensions because free blocks cannot compensate for an exhausted inode
// table (and vice versa).
export const SHELL_DERIVED_VFS_MIN_FREE_BYTES = 64 * 1024 * 1024;
export const SHELL_DERIVED_VFS_MIN_FREE_INODES = 8 * 1024;
export const CUSTOM_VFS_PROFILE_MAX_BYTES = 512 * 1024 * 1024;

export interface KandeloVfsImageCapacity {
  byteLength: number;
  maxByteLength: number;
}

/**
 * Validate an image's authoritative SharedFS capacity before allocating its
 * live SharedArrayBuffer. A metadata declaration, when present, must match the
 * superblock; profile policy remains the upper bound for untrusted images.
 */
export function assertVfsImageFitsProfile(
  capacity: KandeloVfsImageCapacity,
  profileMaxBytes: number,
  declaredMaxBytes: unknown,
  label: string,
): void {
  if (
    !Number.isSafeInteger(capacity.byteLength) ||
    !Number.isSafeInteger(capacity.maxByteLength) ||
    capacity.byteLength <= 0 ||
    capacity.maxByteLength < capacity.byteLength
  ) {
    throw new Error(`${label} has an invalid filesystem capacity`);
  }
  if (!Number.isSafeInteger(profileMaxBytes) || profileMaxBytes <= 0) {
    throw new Error(`${label} profile has an invalid filesystem capacity limit`);
  }
  if (declaredMaxBytes !== undefined) {
    if (
      !Number.isSafeInteger(declaredMaxBytes) ||
      declaredMaxBytes !== capacity.maxByteLength
    ) {
      throw new Error(
        `${label} capacity metadata does not match its filesystem superblock`,
      );
    }
  }
  if (
    capacity.byteLength > profileMaxBytes ||
    capacity.maxByteLength > profileMaxBytes
  ) {
    throw new Error(
      `${label} requires ${capacity.maxByteLength} VFS bytes, ` +
        `but its profile permits ${profileMaxBytes}`,
    );
  }
}

export function declaredVfsMaxByteLength(metadata: unknown): unknown {
  if (!isRecord(metadata) || !isRecord(metadata.capacity)) return undefined;
  return metadata.capacity.maxByteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
