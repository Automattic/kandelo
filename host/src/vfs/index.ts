export { VirtualPlatformIO } from "./vfs";
export { HostFileSystem } from "./host-fs";
export { MemoryFileSystem } from "./memory-fs";
export type {
  LazyDownloadEvent,
  LazyDownloadKind,
  LazyDownloadListener,
  LazyDownloadStatus,
  LazyFileEntry,
  VfsImageCapacity,
  VfsImageMetadata,
  VfsImageOptions,
} from "./memory-fs";
export { loadVfsImage } from "./load-image";
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
