/**
 * Public bounds for deferred trees stored in a Kandelo VFS image.
 *
 * Producers must stay within these limits so every emitted image can be
 * imported by MemoryFileSystem without weakening validation at restore time.
 */
export const VFS_DEFERRED_TREE_LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 100_000,
  maxGroups: 512,
  maxPathBytes: 4096,
  maxSymlinkTargetBytes: 65_536,
  maxStringBytes: 8192,
  maxTransportsPerTree: 8,
  maxActivationCapabilities: 32,
  maxActivationRoots: 64,
  maxActivationCapabilityBytes: 255,
} as const;

/** Aggregate resources retained by pending deferred trees in one VFS image. */
export interface VfsDeferredTreeUsage {
  groups: number;
  archiveBytes: number;
  expandedBytes: number;
  payloadBytes: number;
  entries: number;
}
