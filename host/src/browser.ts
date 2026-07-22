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
export type {
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
  LazyTreeActivation,
  LazyTreeContent,
  LazyTreeDecoder,
  LazyTreeGroup,
  LazyTreeRegistrationEntry,
  SerializedLazyTree,
  VfsImageCapacity,
} from "./vfs/memory-fs";
export { DeviceFileSystem } from "./vfs/device-fs";
export { OpfsFileSystem } from "./vfs/opfs";
export { BrowserTimeProvider } from "./vfs/time";
export { OpfsChannel, OpfsChannelStatus, OpfsOpcode, OPFS_CHANNEL_SIZE } from "./vfs/opfs-channel";
export type { FileSystemBackend, TimeProvider, MountConfig, DirEntry } from "./vfs/types";
export {
  HomebrewVfsPlanError,
  planFederatedHomebrewVfs,
  planHomebrewVfs,
} from "./homebrew-vfs-planner";
export type {
  HomebrewBottleArch,
  HomebrewBottleSourceStatus,
  HomebrewBottleStatus,
  HomebrewDependency,
  HomebrewFederatedVfsPlan,
  HomebrewFederatedVfsPlanOptions,
  HomebrewLinkEntry,
  HomebrewLinkManifest,
  HomebrewMetadataBottle,
  HomebrewMetadataPackage,
  HomebrewRuntime,
  HomebrewTapMetadata,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
  HomebrewVfsPlanOptions,
  HomebrewVfsTapIdentity,
} from "./homebrew-vfs-planner";
export {
  HOMEBREW_RUNTIME_LAYER_POLICY_KIND,
  parseHomebrewRuntimeLayerPolicy,
  projectHomebrewRuntimeLayerPlan,
  selectHomebrewRuntimeLayer,
  selectHomebrewRuntimeLayers,
} from "./homebrew-runtime-layer-policy";
export {
  HOMEBREW_RUNTIME_LAYER_LIMITS,
  composeHomebrewRuntimeLayers,
  parseHomebrewRuntimeLayerDescriptor,
} from "./homebrew-runtime-layer-consumer";
export type {
  ComposedHomebrewRuntimeLayers,
  ComposeHomebrewRuntimeLayersOptions,
  HomebrewRuntimeLayerReference,
  RegisteredHomebrewRuntimeLayer,
} from "./homebrew-runtime-layer-consumer";
export type {
  HomebrewDeferredTreeDecoder,
  HomebrewDeferredTreeDescriptor,
  HomebrewDeferredTreeDraftDescriptor,
  HomebrewDeferredTreeDraftTransport,
  HomebrewDeferredTreeSourceEntry,
  HomebrewDeferredTreeTransport,
  HomebrewLazyLayerBasePackageSource,
  HomebrewLazyLayerDescriptor,
  HomebrewLazyLayerDraftDescriptor,
  HomebrewLazyLayerEntry,
  HomebrewLazyLayerPackageRecord,
  HomebrewLazyLayerPayload,
  HomebrewRuntimeLayerAssetIdentity,
} from "./homebrew-lazy-layer-descriptor";
export {
  canonicalHomebrewRuntimeLayerBundleIdentityBytes,
  canonicalHomebrewRuntimeLayerDescriptorBytes,
  homebrewRuntimeLayerBundleIdentityDocument,
} from "./homebrew-lazy-layer-descriptor";
export type {
  HomebrewRuntimeLayerBaseClosure,
  HomebrewRuntimeLayerBasePackageSourceIdentity,
  HomebrewRuntimeLayerPolicy,
  HomebrewRuntimeLayerPolicyEntry,
  HomebrewRuntimeLayerSelection,
} from "./homebrew-runtime-layer-policy";
