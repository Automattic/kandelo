// Browser-compatible exports (zero Node.js dependencies)
export { WasmPosixKernel } from "./kernel";
export type { KernelCallbacks } from "./kernel";
export { SyscallChannel, ChannelStatus } from "./channel";
export { SharedPipeBuffer } from "./shared-pipe-buffer";
export { BrowserWorkerAdapter } from "./worker-adapter-browser";
export { centralizedWorkerMain } from "./worker-main";
export type { MessagePort as WorkerMessagePort } from "./worker-main";
export type { KernelConfig, PlatformIO, StatResult } from "./types";
export type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
export type {
  HostToWorkerMessage, WorkerToHostMessage,
  WorkerReadyMessage, WorkerExitMessage, WorkerErrorMessage,
  DeliverSignalMessage,
  ExecRequestMessage, ExecReplyMessage,
  ExecCompleteMessage, AlarmSetMessage,
  CentralizedWorkerInitMessage,
} from "./worker-protocol";
export { VirtualPlatformIO } from "./vfs/vfs";
export { MemoryFileSystem } from "./vfs/memory-fs";
export { DeviceFileSystem } from "./vfs/device-fs";
export { OpfsFileSystem } from "./vfs/opfs";
export { BrowserTimeProvider } from "./vfs/time";
export { OpfsChannel, OpfsChannelStatus, OpfsOpcode, OPFS_CHANNEL_SIZE } from "./vfs/opfs-channel";
export type { FileSystemBackend, TimeProvider, MountConfig, DirEntry } from "./vfs/types";
