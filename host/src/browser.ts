// Browser-compatible exports (zero Node.js dependencies)
export { WasmPosixKernel } from "./kernel";
export type { KernelCallbacks } from "./kernel";
export { ProgramRunner } from "./program-runner";
export { SyscallChannel, ChannelStatus } from "./channel";
export { SharedPipeBuffer } from "./shared-pipe-buffer";
export { ProcessManager } from "./process-manager";
export { BrowserWorkerAdapter } from "./worker-adapter-browser";
export { workerMain } from "./worker-main";
export type { CreateIOFn, MessagePort as WorkerMessagePort } from "./worker-main";
export type { KernelConfig, PlatformIO, StatResult } from "./types";
export type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
export type { ProcessInfo, ProcessManagerConfig, SpawnOptions, WaitResult } from "./process-manager";
export type {
  HostToWorkerMessage, WorkerToHostMessage, WorkerInitMessage,
  WorkerReadyMessage, WorkerExitMessage, WorkerErrorMessage,
  RegisterPipeMessage, ConvertPipeMessage, DeliverSignalMessage,
  KillRequestMessage, ExecRequestMessage, ExecReplyMessage,
  ExecCompleteMessage, AlarmSetMessage, SerializedMountConfig,
} from "./worker-protocol";
export { VirtualPlatformIO } from "./vfs/vfs";
export { MemoryFileSystem } from "./vfs/memory-fs";
export { BrowserTimeProvider } from "./vfs/time";
export type { FileSystemBackend, TimeProvider, MountConfig, DirEntry } from "./vfs/types";
