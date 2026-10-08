// Shared verbatim with the peer host protocol. See kernel-protocol-shared.ts
// for which types are NOT shared and why.
export type {
  SignalProcessMessage,
  GetForkCountRequestMessage,
  GetKernelMemoryPagesRequestMessage,
  GetWasmModuleCacheStatsRequestMessage,
  GetSpawnScratchCapacityRequestMessage,
  EnumProcsRequestMessage,
  ReadProcMapsRequestMessage,
  SetSyscallTraceMessage,
  DrainSyscallTraceMessage,
  KmsAttachCanvasMessage,
  KmsAttachStatsMessage,
  InitErrorMessage,
  KernelFatalMessage,
  ResponseMessage,
  StdoutMessage,
  StderrMessage,
  PtyOutputMessage,
  LazyDownloadMessage,
  AppendStdinDataMessage,
  DestroyMessage,
  ExportRootfsImageMessage,
  InjectConnectionMessage,
  PickListenerTargetMessage,
  PipeCloseReadMessage,
  PipeCloseWriteMessage,
  PipeIsWriteOpenMessage,
  PipeReadMessage,
  PipeWriteMessage,
  PtyResizeMessage,
  PtyWriteMessage,
  SetStdinDataMessage,
  TerminateProcessMessage,
  WakeBlockedReadersMessage,
  WakeBlockedWritersMessage,
  HttpRequestMessage,
  WriteVfsFileMessage,
  ProcEventMessage,
} from "./kernel-protocol-shared";
import type {
  SignalProcessMessage,
  GetForkCountRequestMessage,
  GetKernelMemoryPagesRequestMessage,
  GetWasmModuleCacheStatsRequestMessage,
  GetSpawnScratchCapacityRequestMessage,
  EnumProcsRequestMessage,
  ReadProcMapsRequestMessage,
  SetSyscallTraceMessage,
  DrainSyscallTraceMessage,
  KmsAttachCanvasMessage,
  KmsAttachStatsMessage,
  InitErrorMessage,
  KernelFatalMessage,
  ResponseMessage,
  StdoutMessage,
  StderrMessage,
  PtyOutputMessage,
  LazyDownloadMessage,
  AppendStdinDataMessage,
  DestroyMessage,
  ExportRootfsImageMessage,
  InjectConnectionMessage,
  PickListenerTargetMessage,
  PipeCloseReadMessage,
  PipeCloseWriteMessage,
  PipeIsWriteOpenMessage,
  PipeReadMessage,
  PipeWriteMessage,
  PtyResizeMessage,
  PtyWriteMessage,
  SetStdinDataMessage,
  TerminateProcessMessage,
  WakeBlockedReadersMessage,
  WakeBlockedWritersMessage,
  HttpRequestMessage,
  WriteVfsFileMessage,
  ProcEventMessage,
} from "./kernel-protocol-shared";

/**
 * Message protocol for Node.js main thread ↔ kernel worker_thread communication.
 *
 * Mirrors browser-kernel-protocol.ts but adapted for Node.js:
 * - No SharedArrayBuffer VFS (Node uses real filesystem via NodePlatformIO)
 * - No worker entry URLs (Node uses NodeWorkerAdapter)
 * - Pipe/inject operations match the browser peer for protected in-kernel
 *   protocol clients; ambient outbound TCP still uses NodePlatformIO.
 *
 * The `http_request` message is a host-driven HTTP request injected
 * straight into an in-kernel server's accept queue, bypassing real TCP.
 * See docs/plans/2026-04-30-external-kernel-http-request-interface.md.
 */
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";
import type { HostDiagnosticMessage } from "./host-diagnostic";
import type { LazyDownloadEvent } from "./vfs/lazy-download-event";
import type { ImageBuildDeterminism } from "./types";
import type {
  ClosedLazyAsset,
  ClosedLazyAssetSource,
} from "./vfs/closed-lazy-assets";
import type { MountSpec } from "./vfs/default-mounts";
import type { NodeSessionSeedTree } from "./vfs/default-mounts-node";
import type { InputEvent } from "./input/input-source";

export type { HttpRequest, HttpResponse };
export type { HostDiagnostic } from "./host-diagnostic";

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  kernelWasmBytes: ArrayBuffer;
  config: {
    maxWorkers: number;
    maxPages?: number;
    /**
     * Sampled live-allocation admission budget. Unmediated memory.grow can
     * cross it until the next allocation observes current byte lengths.
     */
    maxProcessMemoryBytes: number;
    /** Host default pthread slots for process-wasm declarations of -1. */
    defaultThreadSlots?: number;
    dataBufferSize?: number;
    useSharedMemory?: boolean;
    /** See `NodeKernelHostOptions.imageBuildDeterminism`. */
    imageBuildDeterminism?: ImageBuildDeterminism;
  };
  /**
   * Virtual path → immutable host file for spawn-only preflight. Exec never
   * consults this map and uses only a retained kernel VFS target.
   */
  execPrograms?: Record<string, string>;
  /**
   * Virtual path → worker-owned bytes for spawn-only preflight through Task
   * 12. Exec never consults this map.
   */
  execProgramBytes?: Record<string, ArrayBuffer>;
  /**
   * Bytes of `host/wasm/rootfs.vfs.zst`, read on the main thread and forwarded
   * to the worker. When present, the worker materialises the default mount
   * spec (rootfs at `/`, scratch dirs at `/tmp` etc.) and constructs a
   * `VirtualPlatformIO`. Absent → worker falls back to `NodePlatformIO`
   * (custom-io / legacy path).
   */
  rootfsImage?: ArrayBuffer;
  /** Exact image/scratch mount contract. Absent preserves the host default. */
  rootfsMountSpec?: MountSpec[];
  /** Base used to resolve relative lazy URLs embedded in rootfsImage. */
  rootfsLazyUrlBase?: string;
  /** Exhaustive exact-byte lazy transport for this rootfs; no network fallback. */
  rootfsLazyAssets?: ClosedLazyAsset[];
  /** Exhaustive verified sources fetched only on first use of their exact URL. */
  rootfsLazyAssetSources?: ClosedLazyAssetSource[];
  extraMounts?: Array<{
    mountPoint: string;
    hostPath: string;
    readonly?: boolean;
    exclusiveNativeWriters?: boolean;
    uid?: number;
    gid?: number;
  }>;
  /**
   * Quiescent host trees copied beneath existing worker-owned scratch mounts
   * before ready. Guest mutations never write back to the source.
   */
  sessionSeedTrees?: NodeSessionSeedTree[];
  /** Attach a real-TCP backend (TcpNetworkBackend) to the worker's PlatformIO
   *  so wasm programs can dial external hosts via Node `net.Socket`. */
  enableTcpNetwork?: boolean;
}

export interface SpawnMessage {
  type: "spawn";
  requestId: number;
  /**
   * Supply exactly one program source. `programPath` resolves inside the
   * worker-owned VFS and is the Node peer of BrowserKernel.spawnFromVfs().
   */
  programBytes?: ArrayBuffer;
  programPath?: string;
  argv: string[];
  env?: string[];
  cwd?: string;
  /** Initial real/effective user ID for the process. Defaults to root. */
  uid?: number;
  /** Initial real/effective group ID for the process. Defaults to root. */
  gid?: number;
  pty?: boolean;
  /** Initial PTY winsize. When set with `pty: true`, the kernel applies
   *  the winsize before the wasm program starts so the first ioctl
   *  returns the correct cols/rows. */
  ptyCols?: number;
  ptyRows?: number;
  stdin?: Uint8Array;
  /** Limit heap growth to protect thread channel pages */
  maxAddr?: number;
}

/** Read one regular file through the worker-owned VFS. */
export interface ReadVfsFileMessage {
  type: "read_vfs_file";
  requestId: number;
  path: string;
}

/** List one directory through the worker-owned VFS. */
export interface ReadVfsDirMessage {
  type: "read_vfs_dir";
  requestId: number;
  path: string;
}

/** Describe one path (following symlinks) through the worker-owned VFS. */
export interface StatVfsPathMessage {
  type: "stat_vfs_path";
  requestId: number;
  path: string;
}

export interface ResolveExecResponseMessage {
  type: "resolve_exec_response";
  requestId: number;
  programBytes: ArrayBuffer | null;
}

/** Report the display size (device pixels) of a CRTC's canvas element.
 *  Mirrors the Browser-side message. Feeds the virtual connector's
 *  PREFERRED mode and (with an OffscreenCanvas polyfill) the
 *  `webgl2-scanout` presenter's drawing-buffer size. */
export interface KmsSetDisplaySizeMessage {
  type: "kms_set_display_size";
  crtcId: number;
  width: number;
  height: number;
  /** The display's physical size in millimetres, when the embedder knows
   *  it; the kernel reports it on the DRM connector (mm_width/mm_height). */
  physicalMm?: { width: number; height: number };
}

/**
 * Main-thread → kernel-worker evdev injection. Mirrors the Browser-side
 * `InputEventInjectMessage`. Under Node there is no DOM, so production
 * traffic on this channel comes from tests / headless drivers; the
 * Node-side `NodeInputSource` is a null-source. Routes to
 * `CentralizedKernelWorker.injectInputEvent`.
 */
export interface InputEventInjectMessage {
  type: "input_event_inject";
  device: 0 | 1;
  ev_type: number;
  code: number;
  value: number;
}

/**
 * Main-thread → kernel-worker batched evdev injection. Mirrors the
 * Browser-side `InputEventBatchInjectMessage`: one `SYN_REPORT` frame per
 * message, so the worker runs a single kernel entry and wake scan for the
 * whole frame. Routes to `CentralizedKernelWorker.injectInputEventBatch`.
 */
export interface InputEventBatchInjectMessage {
  type: "input_event_batch_inject";
  records: InputEvent[];
}

/**
 * Main-thread → kernel-worker canvas-dims update. Mirrors the
 * Browser-side `SetInputCanvasDimsMessage`. Sets `ABS_X.maximum` /
 * `ABS_Y.maximum` reported by EVIOCGABS on `/dev/input/event1`.
 */
export interface SetInputCanvasDimsMessage {
  type: "set_input_canvas_dims";
  width: number;
  height: number;
}

/**
 * Offer host clipboard text to the guest's clipboard agent through
 * `/dev/kandelo/clipboard`. Answered with a `ClipboardOfferResult` once the
 * agent installs it, or with the reason it could not.
 */
export interface ClipboardOfferMessage {
  type: "clipboard_offer";
  requestId: number;
  /** UTF-8, line endings already normalized (`encodeClipboardText`). */
  text: Uint8Array;
  timeoutMs?: number;
}

/**
 * Copy-out: answer with the next desktop selection the guest's clipboard
 * agent reports (a `GuestClipboardResult`). Sent before the copy chord.
 */
export interface ClipboardGuestWaitMessage {
  type: "clipboard_guest_wait";
  requestId: number;
  timeoutMs?: number;
}

export type MainToKernelMessage =
  | InitMessage
  | SpawnMessage
  | AppendStdinDataMessage
  | SetStdinDataMessage
  | PtyWriteMessage
  | PtyResizeMessage
  | InjectConnectionMessage
  | PipeReadMessage
  | PipeWriteMessage
  | PipeCloseReadMessage
  | PipeCloseWriteMessage
  | PipeIsWriteOpenMessage
  | WakeBlockedReadersMessage
  | WakeBlockedWritersMessage
  | PickListenerTargetMessage
  | TerminateProcessMessage
  | DestroyMessage
  | ExportRootfsImageMessage
  | ClipboardOfferMessage
  | ClipboardGuestWaitMessage
  | ReadVfsFileMessage
  | ReadVfsDirMessage
  | StatVfsPathMessage
  | WriteVfsFileMessage
  | GetForkCountRequestMessage
  | GetKernelMemoryPagesRequestMessage
  | GetWasmModuleCacheStatsRequestMessage
  | GetSpawnScratchCapacityRequestMessage
  | SignalProcessMessage
  | ResolveExecResponseMessage
  | EnumProcsRequestMessage
  | ReadProcMapsRequestMessage
  | SetSyscallTraceMessage
  | DrainSyscallTraceMessage
  | HttpRequestMessage
  | KmsAttachCanvasMessage
  | KmsAttachStatsMessage
  | KmsSetDisplaySizeMessage
  | InputEventInjectMessage
  | InputEventBatchInjectMessage
  | SetInputCanvasDimsMessage;

// ── Kernel Worker → Main Thread ──

export interface ReadyMessage {
  type: "ready";
}

export interface ExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface ResolveExecRequestMessage {
  type: "resolve_exec";
  requestId: number;
  path: string;
}

/** Which teardown step `performDestroy` is in. */
export type DestroyPhase = "draining" | "terminating";

/**
 * Cumulative teardown progress. Counts processes, not bytes.
 *
 * `total` is a lower bound while `totalProvisional` is true: the drain phase
 * knows only the processes it woke, and the terminate phase adds stragglers it
 * discovers afterwards. `completed` never resets between phases.
 */
export interface DestroyProgressEvent {
  phase: DestroyPhase;
  completed: number;
  total: number;
  totalProvisional: boolean;
}

export interface DestroyProgressMessage {
  type: "destroy_progress";
  event: DestroyProgressEvent;
}

export type KernelToMainMessage =
  | ReadyMessage
  | InitErrorMessage
  | KernelFatalMessage
  | ResponseMessage
  | ExitMessage
  | StdoutMessage
  | StderrMessage
  | HostDiagnosticMessage
  | PtyOutputMessage
  | ResolveExecRequestMessage
  | ProcEventMessage
  | LazyDownloadMessage
  | DestroyProgressMessage;
