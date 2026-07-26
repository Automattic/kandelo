export { readPreparedPlatformFile, VirtualPlatformIO } from "./vfs";
export type { PreparedPlatformFile } from "./vfs";
export { HostFileSystem } from "./host-fs";
export { MemoryFileSystem } from "./memory-fs";
export {
  assertVfsDeferredTreeCollectionUsage,
  VFS_DEFERRED_TREE_COLLECTION_LIMITS,
  VFS_DEFERRED_TREE_LIMITS,
} from "./deferred-tree-limits";
export type { VfsDeferredTreeUsage } from "./deferred-tree-limits";
export {
  createClosedLazyAssetFetcher,
  loadClosedLazyAssetSources,
  MAX_CLOSED_LAZY_ASSETS,
  MAX_CLOSED_LAZY_ASSET_BYTES,
  snapshotClosedLazyAssets,
} from "./closed-lazy-assets";
export type {
  ClosedLazyAsset,
  ClosedLazyAssetSource,
} from "./closed-lazy-assets";
export type {
  LazyDownloadEvent,
  LazyDownloadKind,
  LazyDownloadListener,
  LazyDownloadStatus,
  LazyFileEntry,
  LazyFetcherOptions,
  LazyTreeActivation,
  LazyTreeContent,
  LazyTreeDecoder,
  LazyTreeGroup,
  LazyTreeRegistrationEntry,
  LazyTreeSourceEntry,
  LazyTreeSourceInventory,
  SerializedLazyTree,
  VfsImageCapacity,
  VfsImageMetadata,
  VfsImageOptions,
} from "./memory-fs";
export { loadVfsImage } from "./load-image";
export {
  DEFAULT_TAR_GZIP_LIMITS,
  TarParseError,
  parseTarGzip,
} from "./tar";
export type {
  ParseTarGzipOptions,
  TarDirectoryEntry,
  TarEntry,
  TarFileEntry,
  TarGzipLimits,
  TarHardlinkEntry,
  TarSymlinkEntry,
} from "./tar";
export { DeviceFileSystem } from "./device-fs";
export { OpfsFileSystem } from "./opfs";
export { OpfsChannel, OpfsChannelStatus, OpfsOpcode, OPFS_CHANNEL_SIZE } from "./opfs-channel";
export { NodeTimeProvider, BrowserTimeProvider } from "./time";
export type { FileSystemBackend, TimeProvider, MountConfig, DirEntry } from "./types";
export { PATHCONF_NAMES } from "../generated/abi";
export { filesystemPathconf } from "../pathconf";
export type { PathconfProfile } from "../pathconf";
export type { PathconfValue } from "../types";
export {
  DEFAULT_MOUNT_SPEC,
  ensureMountParentDirectories,
  resolveForBrowser,
} from "./default-mounts";
export type { MountSpec, BrowserResolverOptions } from "./default-mounts";
export { resolveForNode } from "./default-mounts-node";
export { overlayEtcFromRootfs } from "./rootfs-overlay";
