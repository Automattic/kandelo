export { VirtualPlatformIO } from "./vfs";
export { HostFileSystem } from "./host-fs";
export { MemoryFileSystem } from "./memory-fs";
export type { LazyFileEntry, VfsImageMetadata, VfsImageOptions } from "./memory-fs";
export { loadVfsImage } from "./load-image";
export { DeviceFileSystem } from "./device-fs";
export { OpfsFileSystem } from "./opfs";
export { OpfsVfsImageStore } from "./opfs-image-store";
export type {
  OpfsVfsImageLoadOptions,
  OpfsVfsImageManifest,
  OpfsVfsImageSaveOptions,
  OpfsVfsImageStoreOptions,
} from "./opfs-image-store";
export { OpfsChannel, OpfsChannelStatus, OpfsOpcode, OPFS_CHANNEL_SIZE } from "./opfs-channel";
export { NodeTimeProvider, BrowserTimeProvider } from "./time";
export type { FileSystemBackend, TimeProvider, MountConfig, DirEntry } from "./types";
export {
  DEFAULT_MOUNT_SPEC,
  resolveForBrowser,
} from "./default-mounts";
export type { MountSpec, BrowserResolverOptions } from "./default-mounts";
export { resolveForNode } from "./default-mounts-node";
