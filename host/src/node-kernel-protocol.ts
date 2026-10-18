import type { RemoteSegmentInit } from "./networking/remote-segment-port";
import type { VfsChangeEvent } from "./vfs/types";
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
  AttachRemotePeerMessage,
  RemoteNetworkSnapshotMessage,
  RemoteNetworkHostMessage,
  RemoteNetworkJoinMessage,
  RemoteNetworkLeaveMessage,
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
  AttachRemotePeerMessage,
  RemoteNetworkSnapshotMessage,
  RemoteNetworkHostMessage,
  RemoteNetworkJoinMessage,
  RemoteNetworkLeaveMessage,
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
import type { MachineCheckpoint } from "./migration/checkpoint";
import type { ReplicationLogEntry } from "./replication/log";
import type { ReplicationReplaySpec } from "./replication/worker";
import type { InputEvent } from "./input/input-source";

export type { HttpRequest, HttpResponse };
export type { HostDiagnostic } from "./host-diagnostic";

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  /** Native port ownership passes to this kernel worker during init. */
  remoteNetwork?: RemoteSegmentInit;
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
  /**
   * Boot this machine from a captured checkpoint instead of fresh state.
   *
   * The worker validates the checkpoint before instantiating anything, then
   * adopts its kernel memory and its rootfs bytes. Requires `rootfsImage`:
   * the mount layout is host configuration a checkpoint does not carry, so
   * the caller supplies the same mounts the captured machine ran with.
   */
  restoreCheckpoint?: MachineCheckpoint;
  /**
   * Run this machine on a primary's decisions from its very first instruction.
   *
   * A replica joining a machine that is already running restores that
   * machine's processes, and those processes resume inside this `init`. A
   * `replication_replay_start` sent afterwards therefore arrives after they
   * have read this computer's clock. Passing the replay here installs it
   * between the machine's own setup and the first restored process, so the
   * replica's first reading is the primary's.
   */
  replicationReplay?: ReplicationReplaySpec;
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

/** Read, cancel or release one worker-owned command family. */
export interface OwnedJobMessage {
  type: "read_owned_job" | "cancel_owned_job" | "release_owned_job";
  requestId: number;
  jobId: string;
  offset?: number;
  limit?: number;
}

export interface SpawnMessage {
  type: "spawn";
  requestId: number;
  /** Own this process and its descendants as one cancellable command family. */
  ownedJob?: { id: string; timeoutMs: number };
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

/**
 * Freeze the machine, read it, and resume it. Mirrors the browser host's
 * capture_checkpoint request in browser-kernel-protocol.ts.
 *
 * Response carries a {@link CheckpointCaptureResponse}: a summary when the
 * freeze completed, or the reason it timed out or failed. A process that makes
 * no syscall never reaches its unwind hook, so a timeout is an ordinary
 * outcome and the machine keeps running.
 *
 * With `includeBytes`, a captured response carries the full
 * `MachineCheckpoint` instead of the summary, its kernel, filesystem, and
 * process buffers in the transfer list. Every transferred buffer is a copy
 * the freeze took; the worker keeps only live state.
 */
export interface CaptureCheckpointRequestMessage {
  type: "capture_checkpoint";
  requestId: number;
  unwindTimeoutMs: number;
  vforkTimeoutMs: number;
  includeBytes?: true;
  /**
   * Begin streaming the decision log from the state this capture reads.
   *
   * This is how a replica joins a running machine: it restores the checkpoint
   * and replays from the log's first entry, so the two have to meet at one
   * instant. The recorder starts while the machine is still parked, which no
   * caller on the main thread can arrange for itself.
   */
  beginReplicationStream?: true;
}

/**
 * Start recording the machine's decision log.
 *
 * Only the guest clock is recorded today, because it is the only pulled
 * decision routed through the log. A machine that also reads randomness or
 * external bytes produces a log that is complete for its clock and silent
 * about the rest, so a replay of such a machine will diverge rather than
 * mislead. See `host/src/replication/log.ts`.
 */
export interface ReplicationRecordStartMessage {
  type: "replication_record_start";
  requestId: number;
  /**
   * Publish each decision as it is made, and keep none.
   *
   * A live replica joins at boot and needs the log from sequence 0, so
   * somebody must hold all of it. Streaming moves that holder to the main
   * thread, where the wire is, rather than keeping a second copy here.
   */
  stream?: boolean;
}

/**
 * Stop recording and take the log.
 *
 * Response carries the entries this recorder retained, which is none of them
 * when it was started with `stream`.
 */
export interface ReplicationRecordStopMessage {
  type: "replication_record_stop";
  requestId: number;
}

/** Decisions a streaming recorder made, in the order it made them. */
export interface ReplicationRecordedMessage {
  type: "replication_recorded";
  entries: readonly ReplicationLogEntry[];
}

/**
 * Serve the guest clock from a primary's log instead of from this host's clock.
 *
 * Sent after `init` and before the replayed guest runs, which covers a machine
 * this host booted fresh. A replica that adopted a checkpoint cannot use it:
 * its restored processes resume inside `init` and read the clock before this
 * message could arrive, so it passes `replicationReplay` on {@link InitMessage}
 * instead.
 */
export interface ReplicationReplayStartMessage extends ReplicationReplaySpec {
  type: "replication_replay_start";
  requestId: number;
}

/**
 * Stop replaying and report how far the replica got.
 *
 * The response is `{ consumed, total }`. Two replicas that consumed different
 * amounts of one log ran different machines, which is the divergence this
 * measures.
 */
export interface ReplicationReplayStopMessage {
  type: "replication_replay_stop";
  requestId: number;
}

/**
 * Say the primary's log grew, so the replica applies what needs no guest.
 *
 * A keystroke or a resize has no guest request to answer: a guest that is not
 * reading the clock would never pull it out of the queue, and the queue is
 * shared memory the kernel worker only looks at when asked. Fire-and-forget —
 * the entries themselves travel on the queue, not here.
 */
export interface ReplicationReplayDrainMessage {
  type: "replication_replay_drain";
}

/**
 * What a replica took from the log it was replaying.
 *
 * `total` is what the replica had been given, which for a live replay is what
 * the primary had recorded by the time it stopped rather than the whole of a
 * finished recording.
 */
export interface ReplicationReplayProgress {
  readonly consumed: number;
  readonly total: number;
  /**
   * Clock reads served the machine-latest reading because their process's
   * own next reading was not coming. See
   * `ReplicationLogReader.borrowedClockReadings`.
   */
  readonly borrowedClockReadings: number;
  /**
   * Accepts taken by whichever worker asked because the primary never said
   * which one won. See `ReplicationLogReader.borrowedAcceptSelections`.
   */
  readonly borrowedAcceptSelections: number;
  /**
   * Clock reads served their process's own next reading of the asked clock,
   * out of the recorded order. See
   * `ReplicationLogReader.scannedAheadClockReadings`.
   */
  readonly scannedAheadClockReadings: number;
}

export type MainToKernelMessage =
  | InitMessage
  | AttachRemotePeerMessage
  | RemoteNetworkSnapshotMessage
  | RemoteNetworkHostMessage
  | RemoteNetworkJoinMessage
  | RemoteNetworkLeaveMessage
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
  | OwnedJobMessage
  | GetForkCountRequestMessage
  | GetKernelMemoryPagesRequestMessage
  | GetWasmModuleCacheStatsRequestMessage
  | GetSpawnScratchCapacityRequestMessage
  | SignalProcessMessage
  | ResolveExecResponseMessage
  | EnumProcsRequestMessage
  | ReadProcMapsRequestMessage
  | CaptureCheckpointRequestMessage
  | SetSyscallTraceMessage
  | DrainSyscallTraceMessage
  | ReplicationRecordStartMessage
  | ReplicationRecordStopMessage
  | ReplicationReplayStartMessage
  | ReplicationReplayStopMessage
  | ReplicationReplayDrainMessage
  | WatchVfsChangesMessage
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
  | DestroyProgressMessage
  | VfsChangeMessage
  | ReplicationRecordedMessage;

export interface WatchVfsChangesMessage {
  type: "watch_vfs_changes"; prefix: string; enabled: boolean;
}

export interface VfsChangeMessage { type: "vfs_change"; event: VfsChangeEvent; }
