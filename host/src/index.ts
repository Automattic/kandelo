export { WasmPosixKernel } from "./kernel";
export type { KernelCallbacks } from "./kernel";
export { CentralizedKernelWorker } from "./kernel-worker";
export type {
  CentralizedKernelCallbacks, ProcessSnapshot, SyscallTraceEvent,
} from "./kernel-worker";
export { SYSCALL_NAMES } from "./kernel-worker";
export { SyscallChannel, ChannelStatus } from "./channel";
export { NodePlatformIO } from "./platform/node";
export { SharedPipeBuffer } from "./shared-pipe-buffer";
export { SharedLockTable } from "./shared-lock-table";
export type { LockInfo } from "./shared-lock-table";
export { NodeWorkerAdapter, MockWorkerAdapter, MockWorkerHandle } from "./worker-adapter";
export { centralizedWorkerMain, centralizedThreadWorkerMain } from "./worker-main";
export type { MessagePort as WorkerMessagePort } from "./worker-main";
export type { KernelConfig, PlatformIO, StatResult, StatfsResult, NetworkIO } from "./types";
export { TcpNetworkBackend, FetchNetworkBackend } from "./networking";
export type { FetchBackendOptions, HttpRequest, HttpResponse } from "./networking";
export type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
export type {
  HostToWorkerMessage,
  WorkerToHostMessage,
  WorkerReadyMessage,
  WorkerExitMessage,
  WorkerErrorMessage,
  DeliverSignalMessage,
  ExecRequestMessage,
  ExecReplyMessage,
  ExecCompleteMessage,
  AlarmSetMessage,
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  ThreadExitMessage,
  WorkerTerminateMessage,
} from "./worker-protocol";
export * from "./vfs/index";
export {
  resolveBinary,
  tryResolveBinary,
  findRepoRoot,
  binariesDir,
  localBinariesDir,
} from "./binary-resolver";
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
export {
  HomebrewVfsBuildError,
  buildHomebrewVfs,
} from "./homebrew-vfs-builder";
export type {
  HomebrewVfsBuildOptions,
  HomebrewVfsBuildReport,
  HomebrewVfsBuildResult,
  HomebrewVfsPackageReport,
} from "./homebrew-vfs-builder";
export {
  HomebrewBottleFetchError,
  fetchHomebrewBottleBytes,
} from "./homebrew-vfs-fetch";
export { parseDylinkSection, loadSharedLibrary, loadSharedLibrarySync, DynamicLinker } from "./dylink";
export type { DylinkMetadata, LoadedSharedLibrary, LoadSharedLibraryOptions } from "./dylink";
export { WASM_PAGE_SIZE, CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, PAGES_PER_THREAD } from "./constants";
export { ThreadPageAllocator } from "./thread-allocator";
export type { ThreadAllocation, ThreadPageAllocatorOptions } from "./thread-allocator";
export {
  computeProcessMemoryLayout,
  createProcessMemory,
  growMemoryToCover,
  importedMemoryMinimumPages,
  PROCESS_MMAP_BASE,
} from "./process-memory";
export type { ProcessMemoryLayout } from "./process-memory";
export { WasiShim, WasiExit } from "./wasi-shim";
export { isWasiModule, wasiModuleImportsMemory, wasiModuleDefinesMemory } from "./wasi-detect";
export { NodeKernelHost } from "./node-kernel-host";
export type { NodeKernelHostOptions, SpawnOptions } from "./node-kernel-host";
export type {
  MainToKernelMessage,
  KernelToMainMessage,
} from "./node-kernel-protocol";
