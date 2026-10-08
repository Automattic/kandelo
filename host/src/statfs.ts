import type { StatfsResult } from "./types";

export const DEFAULT_STATFS_BLOCK_SIZE = 4096;
export const DEFAULT_STATFS_NAMELEN = 255;

/**
 * The `f_type` `statfs(2)` reports for the Kandelo image filesystem.
 *
 * The same four bytes as the superblock magic, which is the Linux convention
 * (`EXT2_SUPER_MAGIC` and friends do the same). Guest-observable: a program
 * calling `statfs` sees this, so it moves with the filesystem's identity rather
 * than being an internal detail.
 */
export const KANDELO_IMAGE_SUPER_MAGIC = 0x5346494b; // "KIFS" in LE byte order

export function zeroCapacityStatfs(type: number, fsid = 0): StatfsResult {
  return {
    type,
    bsize: DEFAULT_STATFS_BLOCK_SIZE,
    blocks: 0,
    bfree: 0,
    bavail: 0,
    files: 0,
    ffree: 0,
    fsid,
    namelen: DEFAULT_STATFS_NAMELEN,
    frsize: DEFAULT_STATFS_BLOCK_SIZE,
    flags: 0,
  };
}
