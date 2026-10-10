// This barrel does not re-export a filesystem implementation. The kernel owns
// `/` and the scratch mounts, so the TypeScript filesystem it once exported
// (`MemoryFileSystem`, `resolveMountSetIdCapability`, the materialization-plan
// verbs and their types) is deleted; nothing outside this file imported those
// names through the barrel when they were removed.
export {
  readPreparedPlatformFile,
  VirtualPlatformIO,
} from "./vfs";
export type { HostFileOffset } from "../types";
export type {
  PreparedPlatformFile,
  VfsDirEntrySnapshot,
  VfsPathStat,
} from "./vfs";
export { HostFileSystem } from "./host-fs";
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
export { OpfsFileSystem } from "./opfs";
export { OpfsChannel, OpfsChannelStatus, OpfsOpcode, OPFS_CHANNEL_SIZE } from "./opfs-channel";
export { NodeTimeProvider, BrowserTimeProvider } from "./time";
export { ST_NOSUID } from "./types";
export type {
  FileSystemBackend,
  TimeProvider,
  MountConfig,
  MountSetIdCapability,
  DirEntry,
} from "./types";
export { PATHCONF_NAMES } from "../generated/abi";
export { backendPathconf } from "../pathconf";
export type { PathconfProfile } from "../pathconf";
export type { PathconfValue } from "../types";
export { DEFAULT_MOUNT_SPEC, resolveForBrowser } from "./default-mounts";
export type { MountSpec } from "./default-mounts";
export { resolveForNode } from "./default-mounts-node";
