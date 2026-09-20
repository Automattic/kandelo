// WHAT THIS BARREL NO LONGER RE-EXPORTS, 2026-09-17: `MemoryFileSystem`,
// `resolveMountSetIdCapability`, the materialization-plan verbs and eleven
// types, all from the filesystem this lane deleted. Nothing outside this file
// imported any of them — checked before removing — so the barrel was
// advertising a class no consumer named.
export { readPreparedPlatformFile, VirtualPlatformIO } from "./vfs";
export type { HostFileOffset } from "../types";
export type { PreparedPlatformFile } from "./vfs";
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
