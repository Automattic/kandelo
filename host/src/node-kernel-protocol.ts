// Shared verbatim with the peer host protocol. See kernel-protocol-shared.ts
// for which types are NOT shared and why.
export type {
  SignalProcessMessage,
  GetForkCountRequestMessage,
  GetKernelMemoryPagesRequestMessage,
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
} from "./kernel-protocol-shared";
import type {
  SignalProcessMessage,
  GetForkCountRequestMessage,
  GetKernelMemoryPagesRequestMessage,
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
import type {
  ForkModuleProofMessage,
  HostDiagnosticMessage,
} from "./host-diagnostic";
import type { LazyDownloadEvent } from "./vfs/memory-fs";
import type {
  ClosedLazyAsset,
  ClosedLazyAssetSource,
} from "./vfs/closed-lazy-assets";
import type { MountSpec } from "./vfs/default-mounts";
import type { NodeSessionSeedTree } from "./vfs/default-mounts-node";

export type { HttpRequest, HttpResponse };
export type { HostDiagnostic } from "./host-diagnostic";

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  kernelWasmBytes: ArrayBuffer;
  /**
   * Explicit co-resident fork-module wasm bytes keyed by pointer width. Present
   * only for build-time boots that inject the fork module rather than let the
   * kernel worker resolve it through the binary resolver (which fails under the
   * source-only resolution policy when no source-only binary root is set).
   */
  forkModuleBytesByWidth?: Partial<Record<4 | 8, ArrayBuffer>>;
  /**
   * Explicit co-resident dynamic-linking planner wasm bytes, for the same
   * reason and on the same terms as `forkModuleBytesByWidth`. The planner is
   * width-independent, so there is one buffer rather than one per width.
   */
  dylinkModuleBytes?: ArrayBuffer;
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
   * Bytes of `host/wasm/rootfs.vfs`, read on the main thread and forwarded
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
  /** Optional pre-compiled module for the same bytes. */
  programModule?: WebAssembly.Module;
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

/** Create or replace one regular file through the worker-owned VFS. */
export interface WriteVfsFileMessage {
  type: "write_vfs_file";
  requestId: number;
  path: string;
  data: Uint8Array;
  mode: number;
}

export interface ResolveExecResponseMessage {
  type: "resolve_exec_response";
  requestId: number;
  programBytes: ArrayBuffer | null;
}

/** Send an HTTP request to a server running in the kernel and wait for the
 *  response. Reply arrives as a `response` message whose `result` is an
 *  {@link HttpResponse}, or with `error` set if no listener was found. */
export interface HttpRequestMessage {
  type: "http_request";
  requestId: number;
  /** Port the in-kernel server is listening on. */
  port: number;
  request: HttpRequest;
  /** Optional timeout in ms (default 60_000). */
  timeoutMs?: number;
  /** Optional raw response byte ceiling. */
  maxResponseBytes?: number;
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
  | ReadVfsFileMessage
  | WriteVfsFileMessage
  | GetForkCountRequestMessage
  | GetKernelMemoryPagesRequestMessage
  | GetSpawnScratchCapacityRequestMessage
  | SignalProcessMessage
  | ResolveExecResponseMessage
  | EnumProcsRequestMessage
  | ReadProcMapsRequestMessage
  | SetSyscallTraceMessage
  | DrainSyscallTraceMessage
  | HttpRequestMessage
  | KmsAttachCanvasMessage
  | KmsAttachStatsMessage;

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

/**
 * Posted whenever the kernel forks, execs, or posix_spawns. Mirrors the
 * browser-side ProcEventMessage. Exit events come via the existing
 * ExitMessage; we don't duplicate them here. Spawn events always carry the
 * authoritative parent pid; exec events preserve process identity and do not.
 */
export type ProcEventMessage =
  | { type: "proc_event"; kind: "spawn"; pid: number; ppid: number }
  | { type: "proc_event"; kind: "exec"; pid: number };

export type KernelToMainMessage =
  | ReadyMessage
  | InitErrorMessage
  | KernelFatalMessage
  | ResponseMessage
  | ExitMessage
  | StdoutMessage
  | StderrMessage
  | HostDiagnosticMessage
  | ForkModuleProofMessage
  | PtyOutputMessage
  | ResolveExecRequestMessage
  | ProcEventMessage
  | LazyDownloadMessage;
