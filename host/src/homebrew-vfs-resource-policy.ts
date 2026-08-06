const MEBIBYTE = 1024 * 1024;

export type HomebrewVfsResourcePolicyId =
  "kandelo-homebrew-vfs-generous-v1";

export interface HomebrewVfsResourcePolicy {
  id: HomebrewVfsResourcePolicyId;
  bottle: {
    maxCompressedBytes: number;
    maxExpandedBytes: number;
    maxEntries: number;
    maxPathBytes: number;
    maxLinkBytes: number;
  };
  aggregate: {
    maxCompressedBytes: number;
    maxExpandedBytes: number;
    maxEntries: number;
  };
  supportZip: {
    maxCompressedBytes: number;
    maxExpandedBytes: number;
    maxEntries: number;
  };
  vfs: {
    maxByteLength: number;
  };
}

/**
 * Provisional pre-release policy measured against the reuse-40 descriptor set.
 * Task 13 must remeasure the complete 41-bottle image before this unreleased
 * policy is frozen. Published semantics must move to a new ID, never acquire a
 * package-specific exception.
 */
const GENEROUS_V1: HomebrewVfsResourcePolicy = deepFreeze({
  id: "kandelo-homebrew-vfs-generous-v1",
  bottle: {
    maxCompressedBytes: 256 * MEBIBYTE,
    maxExpandedBytes: 256 * MEBIBYTE,
    maxEntries: 100_000,
    maxPathBytes: 4096,
    maxLinkBytes: 65_536,
  },
  aggregate: {
    maxCompressedBytes: 512 * MEBIBYTE,
    maxExpandedBytes: 512 * MEBIBYTE,
    maxEntries: 100_000,
  },
  supportZip: {
    maxCompressedBytes: 256 * MEBIBYTE,
    maxExpandedBytes: 256 * MEBIBYTE,
    maxEntries: 65_535,
  },
  vfs: {
    maxByteLength: 768 * MEBIBYTE,
  },
});

/** Resolve a closed, code-owned Homebrew VFS resource policy. */
export function resolveHomebrewVfsResourcePolicy(
  id: unknown,
): HomebrewVfsResourcePolicy {
  if (id === GENEROUS_V1.id) return GENEROUS_V1;
  throw new Error(`unknown Homebrew VFS resource policy: ${JSON.stringify(id)}`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
