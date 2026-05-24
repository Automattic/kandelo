import type { StatfsResult } from "./types";

export const DEFAULT_STATFS_BLOCK_SIZE = 4096;
export const DEFAULT_STATFS_NAMELEN = 255;

export const SFFS_SUPER_MAGIC = 0x53464653; // "SFFS"
export const DEVFS_SUPER_MAGIC = 0x1373;

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
