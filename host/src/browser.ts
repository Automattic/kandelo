// Browser-compatible exports (zero Node.js dependencies)
export { WasmPosixKernel } from "./kernel";
export type { KernelCallbacks } from "./kernel";
export { CentralizedKernelWorker } from "./kernel-worker";
export type {
  CentralizedKernelCallbacks,
  ForkContinuationContext,
  ForkLaunchRequest,
  ProcessSnapshot,
  SyscallTraceEvent,
  ThreadChannelAttachment,
} from "./kernel-worker";
export { SYSCALL_NAMES } from "./kernel-worker";
export { SyscallChannel, ChannelStatus } from "./channel";
export { SharedPipeBuffer } from "./shared-pipe-buffer";
export { BrowserWorkerAdapter } from "./worker-adapter-browser";
export { centralizedWorkerMain, centralizedThreadWorkerMain, patchWasmForThread } from "./worker-main";
export type { MessagePort as WorkerMessagePort } from "./worker-main";
export type {
  HostFileOffset,
  KernelConfig,
  PathconfValue,
  PlatformIO,
  StatResult,
  StatfsResult,
} from "./types";
export { PATHCONF_NAMES } from "./generated/abi";
export { filesystemPathconf } from "./pathconf";
export type { PathconfProfile } from "./pathconf";
export type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
export type { HostDiagnostic } from "./host-diagnostic";
export {
  BrowserCorsProxy,
  BrowserCorsProxyRequestError,
  validateBrowserCorsProxyConfig,
} from "./networking/browser-cors-proxy";
export type {
  BrowserCorsProxyConfig,
  HttpHeaderOccurrence,
} from "./networking/browser-cors-proxy";
export type {
  HostToWorkerMessage, WorkerToHostMessage,
  WorkerReadyMessage, WorkerExitMessage, WorkerErrorMessage,
  ExecRequestMessage, ExecReplyMessage,
  ExecCompleteMessage, AlarmSetMessage,
  CentralizedWorkerInitMessage,
} from "./worker-protocol";
export { VirtualPlatformIO } from "./vfs/vfs";
export {
  MemoryFileSystem,
  resolveMountSetIdCapability,
} from "./vfs/memory-fs";
export {
  loadVfsImage,
  restoreVerifiedVfsImage,
  restoreVerifiedVfsImagePreservingCapacity,
} from "./vfs/load-image";
export type {
  LazyDownloadEvent,
  LazyDownloadKind,
  LazyDownloadListener,
  LazyDownloadStatus,
  LazyAtomicGroupMembership,
  LazyFileEntry,
  LazyFetcherOptions,
  LazyTreeActivation,
  LazyTreeContent,
  LazyTreeDecoder,
  LazyTreeGroup,
  LazyTreeRegistrationEntry,
  SerializedLazyTree,
  VfsImageCapacity,
  VfsImageRestoreOptions,
} from "./vfs/memory-fs";
