export const DEFAULT_VFS_PROFILE_MAX_BYTES = 256 * 1024 * 1024;
export const MAIN_SHELL_VFS_PROFILE_MAX_BYTES = 512 * 1024 * 1024;
// Product images layered on the canonical shell must admit the shell's full
// capacity before adding their own files. Larger products (for example LAMP)
// may declare a higher, explicit profile ceiling.
export const SHELL_DERIVED_VFS_PROFILE_MAX_BYTES =
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES;
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
