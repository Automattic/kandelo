export { VirtualPlatformIO } from "./vfs";
export { HostFileSystem } from "./host-fs";
export { MemoryFileSystem } from "./memory-fs";
export type { LazyFileEntry, VfsImageOptions } from "./memory-fs";
export { DeviceFileSystem } from "./device-fs";
export { OpfsFileSystem } from "./opfs";
export { OpfsChannel, OpfsChannelStatus, OpfsOpcode, OPFS_CHANNEL_SIZE } from "./opfs-channel";
export { NodeTimeProvider, BrowserTimeProvider } from "./time";
export type { FileSystemBackend, TimeProvider, MountConfig, DirEntry } from "./types";
