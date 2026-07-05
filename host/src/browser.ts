// Browser-compatible exports (zero Node.js dependencies)
export { WasmPosixKernel } from "./kernel";
export type { KernelCallbacks } from "./kernel";
export { CentralizedKernelWorker } from "./kernel-worker";
export type { CentralizedKernelCallbacks, ProcessSnapshot, SyscallTraceEvent } from "./kernel-worker";
export { SYSCALL_NAMES } from "./kernel-worker";
export { SyscallChannel, ChannelStatus } from "./channel";
export { SharedPipeBuffer } from "./shared-pipe-buffer";
export { BrowserWorkerAdapter } from "./worker-adapter-browser";
export { centralizedWorkerMain, centralizedThreadWorkerMain, patchWasmForThread } from "./worker-main";
export type { MessagePort as WorkerMessagePort } from "./worker-main";
export type { KernelConfig, PlatformIO, StatResult, StatfsResult } from "./types";
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
export type {
  LazyDownloadEvent,
  LazyDownloadKind,
  LazyDownloadListener,
  LazyDownloadStatus,
  LazyFileEntry,
} from "./vfs/memory-fs";
export { DeviceFileSystem } from "./vfs/device-fs";
export { OpfsFileSystem } from "./vfs/opfs";
export { BrowserTimeProvider } from "./vfs/time";
export { OpfsChannel, OpfsChannelStatus, OpfsOpcode, OPFS_CHANNEL_SIZE } from "./vfs/opfs-channel";
export type { FileSystemBackend, TimeProvider, MountConfig, DirEntry } from "./vfs/types";
export {
  HomebrewVfsPlanError,
  planHomebrewVfs,
} from "./homebrew-vfs-planner";
export type {
  HomebrewBottleArch,
  HomebrewBottleSourceStatus,
  HomebrewBottleStatus,
  HomebrewDependency,
  HomebrewLinkEntry,
  HomebrewLinkManifest,
  HomebrewMetadataBottle,
  HomebrewMetadataPackage,
  HomebrewRuntime,
  HomebrewTapMetadata,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
  HomebrewVfsPlanOptions,
} from "./homebrew-vfs-planner";
