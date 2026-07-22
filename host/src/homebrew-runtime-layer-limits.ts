import { VFS_DEFERRED_TREE_LIMITS } from "./vfs/deferred-tree-limits";

const MAX_RELEASE_ASSET_NAME_BYTES = 255;

/** Shared producer/consumer bounds for the public Homebrew runtime-layer wire contract. */
export const HOMEBREW_RUNTIME_LAYER_LIMITS = {
  maxLayers: 8,
  maxDescriptorBytes: 16 * 1024 * 1024,
  maxArchiveBytes: VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes,
  maxUncompressedBytes: VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes,
  maxEntries: VFS_DEFERRED_TREE_LIMITS.maxEntries,
  maxPathBytes: VFS_DEFERRED_TREE_LIMITS.maxPathBytes,
  maxSymlinkTargetBytes: VFS_DEFERRED_TREE_LIMITS.maxSymlinkTargetBytes,
  maxTrees: VFS_DEFERRED_TREE_LIMITS.maxGroups,
  maxPackages: VFS_DEFERRED_TREE_LIMITS.maxGroups,
  maxTapLocks: 32,
  maxPackageNameBytes: 255,
  maxRepositoryBytes: 512,
  maxStringBytes: VFS_DEFERRED_TREE_LIMITS.maxStringBytes,
  maxTransportsPerTree: VFS_DEFERRED_TREE_LIMITS.maxTransportsPerTree,
  maxActivationCapabilities: VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilities,
  maxActivationRoots: VFS_DEFERRED_TREE_LIMITS.maxActivationRoots,
  maxActivationCapabilityBytes:
    VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes,
  maxRequestedPackages: 128,
  maxReleaseAssetNameBytes: MAX_RELEASE_ASSET_NAME_BYTES,
  maxRuntimeLayerIdBytes:
    MAX_RELEASE_ASSET_NAME_BYTES -
      "kandelo-homebrew-".length -
      "-layer.json".length,
} as const;

export function isHomebrewRuntimeLayerId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= HOMEBREW_RUNTIME_LAYER_LIMITS.maxRuntimeLayerIdBytes &&
    /^[a-z0-9][a-z0-9-]*$/.test(value);
}

export function homebrewRuntimeLayerPayloadAsset(id: string): string {
  return runtimeLayerAssetName(id, "bin");
}

export function homebrewRuntimeLayerDescriptorAsset(id: string): string {
  return runtimeLayerAssetName(id, "json");
}

function runtimeLayerAssetName(id: string, extension: "bin" | "json"): string {
  if (!isHomebrewRuntimeLayerId(id)) {
    throw new Error(`invalid Homebrew runtime layer id ${id}`);
  }
  const name = `kandelo-homebrew-${id}-layer.${extension}`;
  if (new TextEncoder().encode(name).byteLength > MAX_RELEASE_ASSET_NAME_BYTES) {
    throw new Error(`Homebrew runtime layer id ${id} exceeds the release asset budget`);
  }
  return name;
}
