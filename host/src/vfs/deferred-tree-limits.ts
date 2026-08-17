/** Public bounds for one deferred tree stored in a Kandelo VFS image. */
export const VFS_DEFERRED_TREE_LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxPayloadBytes: 256 * 1024 * 1024,
  maxEntries: 100_000,
  maxPathBytes: 4096,
  maxSymlinkTargetBytes: 65_536,
  maxStringBytes: 8192,
  maxTransportsPerTree: 8,
  maxActivationCapabilities: 32,
  maxActivationRoots: 64,
  maxActivationCapabilityBytes: 255,
} as const;

/**
 * Aggregate resources retained by all pending deferred trees in one VFS.
 *
 * This is deliberately distinct from the per-tree bounds above. A producer
 * must reject one oversized object, but a valid image may retain several
 * independently bounded objects up to the image-wide 512 MiB budget.
 */
export const VFS_DEFERRED_TREE_COLLECTION_LIMITS = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxPayloadBytes: 512 * 1024 * 1024,
  maxEntries: 100_000,
  maxGroups: 512,
} as const;

/** Aggregate resources retained by pending deferred trees in one VFS image. */
export interface VfsDeferredTreeUsage {
  groups: number;
  archiveBytes: number;
  expandedBytes: number;
  payloadBytes: number;
  entries: number;
}

/** Enforce the shared image-wide deferred-tree resource contract. */
export function assertVfsDeferredTreeCollectionUsage(
  usage: VfsDeferredTreeUsage,
  label = "Deferred tree collection",
): void {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} ${name} usage is invalid`);
    }
  }
  if (usage.groups > VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups) {
    throw new Error(
      `${label} exceeds the ` +
        `${VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups}-group cap`,
    );
  }
  if (
    usage.archiveBytes > VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes
  ) {
    throw new Error(`${label} exceeds the archive-byte cap`);
  }
  if (
    usage.expandedBytes > VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxExpandedBytes
  ) {
    throw new Error(`${label} exceeds the expansion cap`);
  }
  if (
    usage.payloadBytes > VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxPayloadBytes
  ) {
    throw new Error(`${label} exceeds the payload-byte cap`);
  }
  if (usage.entries > VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxEntries) {
    throw new Error(`${label} exceeds the entry-count cap`);
  }
}
