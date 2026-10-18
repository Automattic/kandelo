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
 * Message protocol for main thread ↔ kernel worker communication.
 *
 * The kernel worker hosts the CentralizedKernelWorker and all process
 * lifecycle. The main thread is a thin UI proxy that sends messages here.
 */
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";
import type { LazyDownloadEvent } from "./vfs/lazy-download-event";
import type { HostDiagnostic, HostDiagnosticMessage } from "./host-diagnostic";
import type { ClosedLazyAsset } from "./vfs/closed-lazy-assets";
import type { PcmTransportDescriptor } from "./audio/pcm-transport";
import type { MountSpec } from "./vfs/default-mounts";
import type { MachineCheckpoint } from "./migration/checkpoint";
import type { ReplicationLogEntry } from "./replication/log";
import type { ReplicationReplaySpec } from "./replication/worker";
import type { InputEvent } from "./input/input-source";
import {
  type BrowserCorsProxyConfig,
  validateBrowserCorsProxyConfig,
} from "./networking/browser-cors-proxy";

export type { HttpRequest, HttpResponse };
export type { HostDiagnostic } from "./host-diagnostic";

export function initializeBrowserCorsProxyForWorker<TLazyFetcher, TTlsBackend>(
  value: BrowserCorsProxyConfig | undefined,
  consumers: {
    useLazyFetcher: boolean;
    createLazyFetcher: (config: BrowserCorsProxyConfig) => TLazyFetcher;
    createTlsBackend: (options: {
      corsProxy?: BrowserCorsProxyConfig;
      onCorsProxyDiagnostic: (message: string) => void;
    }) => TTlsBackend;
    reportHostDiagnostic: (diagnostic: HostDiagnostic, level: "warn") => void;
  },
): {
  corsProxy: BrowserCorsProxyConfig | undefined;
  lazyFetcher: TLazyFetcher | undefined;
  tlsBackend: TTlsBackend;
} {
  const corsProxy = validateBrowserCorsProxyConfig(value);
  const lazyFetcher =
    corsProxy !== undefined && consumers.useLazyFetcher
      ? consumers.createLazyFetcher(corsProxy)
      : undefined;
  const tlsBackend = consumers.createTlsBackend({
    corsProxy,
    onCorsProxyDiagnostic: (message) => {
      consumers.reportHostDiagnostic(
        {
          pid: 0,
          source: "browser CORS proxy",
          message,
        },
        "warn",
      );
    },
  });
  return { corsProxy, lazyFetcher, tlsBackend };
}

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  /** Native port ownership passes to this kernel worker during init. */
  remoteNetwork?: RemoteSegmentInit;
  kernelWasmBytes: ArrayBuffer;
  /**
   * Decoded VFS image bytes (a `KandeloImageFs.saveImage()` result, or a
   * zstd-decoded `.vfs.zst`). The kernel worker hands them to the kernel,
   * which parses the image and owns `/`; an imported image's seal is checked
   * by the verified image-mount resolver first. No VFS buffer is shared with
   * the main thread. Demos that need `/etc/{passwd,group,hosts,services}` bake
   * them into the image.
   */
  vfsImage: Uint8Array;
  /** Exact image/scratch mount contract. Absent preserves the host default. */
  rootfsMountSpec?: MountSpec[];
  /**
   * Boot this machine from a captured checkpoint instead of fresh state.
   *
   * The worker validates the checkpoint before instantiating anything, then
   * adopts its kernel memory and its rootfs bytes. `vfsImage` is still
   * required: the mount layout is host configuration a checkpoint does not
   * carry, so the caller supplies the same mounts the captured machine ran
   * with.
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
  /** Base URL for relative lazy file/archive URLs stored in vfsImage. */
  lazyUrlBase?: string;
  /**
   * Where this deployment serves addresses the image records, for a
   * deployment that serves those bytes somewhere other than where the image
   * names them (hashed production asset names, or an image-owned scheme such
   * as the shell image's `kandelo-lazy:`). Consulted before `lazyUrlBase`.
   *
   * The image's address is canonical and nothing rewrites it; this is
   * transport policy, so it travels as data. A table rather than a resolver,
   * because the deployment knows every asset it serves without asking the
   * image what it contains. An address the table does not carry is resolved
   * against `lazyUrlBase`, or fetched as written.
   */
  lazyUrlMap?: Readonly<Record<string, string>>;
  /** Exhaustive exact-byte lazy transport for this image; no network fallback. */
  closedLazyAssets?: ClosedLazyAsset[];
  workerEntryUrl: string;
  bridgePort?: MessagePort;
  config: {
    maxWorkers: number;
    maxMemoryPages: number;
    /** Ceiling for the kernel's own wasm address space, in 64 KiB pages. */
    kernelMaxPages: number;
    /** Identifier of the runtime memory profile these budgets came from. */
    memoryProfileId: string;
    /**
     * Sampled live-allocation admission budget. Unmediated memory.grow can
     * cross it until the next allocation observes current byte lengths.
     */
    maxProcessMemoryBytes: number;
    /** Host default pthread slots for process-wasm declarations of -1. */
    defaultThreadSlots?: number;
    env: string[];
    /** Forwarded to KernelConfig.enableSyscallLog — log every syscall. */
    enableSyscallLog?: boolean;
    /** Forwarded to KernelConfig.syscallLogPtrWidth — only log for processes
     *  of the given pointer width. */
    syscallLogPtrWidth?: 4 | 8;
    /** Forwarded to TlsNetworkBackendOptions.dnsAliases. */
    dnsAliases?: Record<string, string>;
    /** Routes guest HTTP(S) and external lazy VFS downloads through a browser
     *  proxy when the page is not controlled by Kandelo's service worker. */
    corsProxy?: BrowserCorsProxyConfig;
  };
}

export interface OwnedJobMessage {
  type: "read_owned_job" | "cancel_owned_job" | "release_owned_job";
  requestId: number;
  jobId: string;
  offset?: number;
  limit?: number;
}

export interface SpawnMessage {
  ownedJob?: { id: string; timeoutMs: number };
  type: "spawn";
  requestId: number;
  programPath?: string;
  programBytes?: ArrayBuffer;
  argv: string[];
  env: string[];
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
  maxPages?: number;
}

export interface VfsFileSnapshot {
  data: Uint8Array;
  mode: number;
}

export interface ReadVfsFileMessage {
  type: "read_vfs_file";
  requestId: number;
  path: string;
  /** Return the file's permission bits with its bytes for lossless restore. */
  includeMode?: boolean;
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

export interface UnlinkVfsFileMessage {
  type: "unlink_vfs_file";
  requestId: number;
  path: string;
}

export interface IsStdinConsumedMessage {
  type: "is_stdin_consumed";
  requestId: number;
  pid: number;
}

export interface RegisterPtyOutputMessage {
  type: "register_pty_output";
  pid: number;
}

/**
 * Main-thread → kernel-worker mouse injection. The main thread captures
 * canvas mouse events and forwards them here; the worker calls
 * `CentralizedKernelWorker.injectMouseEvent` which appends a 3-byte PS/2
 * frame to the kernel queue and wakes any blocked reader of
 * `/dev/input/mice`.
 */
export interface MouseInjectMessage {
  type: "mouse_inject";
  dx: number;
  dy: number;
  buttons: number;
}

/**
 * Main-thread → kernel-worker evdev injection. The main thread's
 * `BrowserInputSource` translates DOM events to evdev records and
 * forwards them here; the worker calls
 * `CentralizedKernelWorker.injectInputEvent` which routes the record
 * through the kernel's fan-out (`kernel_input_event` → `push_event`)
 * to `/dev/input/event{0,1}` and wakes any blocked reader.
 */
export interface InputEventInjectMessage {
  type: "input_event_inject";
  device: 0 | 1;
  ev_type: number;
  code: number;
  value: number;
}

/**
 * Main-thread → kernel-worker batched evdev injection. One `SYN_REPORT`
 * frame's worth of records crosses in a single message so the worker runs
 * one kernel entry and one pending-reader wake scan for the whole frame
 * instead of one per record. `attachInputSource` produces these via
 * `batchBySynReport`; `injectInputEvent` remains for single-record paths.
 */
export interface InputEventBatchInjectMessage {
  type: "input_event_batch_inject";
  records: InputEvent[];
}

/**
 * Main-thread → kernel-worker canvas-dims update. Tells the kernel
 * the current host canvas dimensions so EVIOCGABS on
 * `/dev/input/event1` reports the right `ABS_X.maximum` /
 * `ABS_Y.maximum`. Sent at boot once the canvas exists; resend on
 * canvas resize.
 */
export interface SetInputCanvasDimsMessage {
  type: "set_input_canvas_dims";
  width: number;
  height: number;
}

/**
 * Main-thread → kernel-worker audio drain request. The main thread's
 * AudioContext scheduler ticks every ~50 ms, asks the kernel ring for
 * up to `maxBytes` of PCM samples, and feeds them to a chained
 * `AudioBufferSourceNode`. The worker responds with the bytes plus the
 * configured (rate, channels) so the main thread can size its
 * AudioBuffer correctly.
 */
export interface AudioDrainMessage {
  type: "audio_drain";
  requestId: number;
  maxBytes: number;
}

/**
 * Confirms that BrowserKernel dropped its own structured-clone Memory wrapper
 * and framebuffer-registry views for one exact execution generation. Callers
 * can retain a wrapper returned by getProcessMemory(), so this is not a
 * JavaScript-realm-wide garbage-collection claim.
 */
export interface FbReleaseGenerationAckMessage {
  type: "fb_release_generation_ack";
  requestId: number;
}

/** Report the display size (device pixels) of a CRTC's canvas element.
 *  Consumed by the vblank pump's `webgl2-scanout` presenter, which sizes
 *  the drawing buffer to match and GPU-scales the scanout texture into
 *  it. Typically fed from a main-thread ResizeObserver. */
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
 * Freeze the machine, read it, and resume it. Mirrors the Node host's
 * capture_checkpoint request in node-kernel-protocol.ts.
 *
 * Response carries a `CheckpointCaptureResponse`: a summary when the freeze
 * completed, or the reason it timed out or failed. A process that makes no
 * syscall never reaches its unwind hook, so a timeout is an ordinary outcome
 * and the machine keeps running.
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
 * The guest clock and pointer movement are recorded today. Randomness and
 * external bytes are not routed through the log yet, so a machine that reads
 * either produces a log that is complete for what it holds and silent about
 * the rest. See `host/src/replication/log.ts`.
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
 * Serve the machine's decisions from a primary's log instead of from this host.
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
 * The response is a {@link ReplicationReplayProgress}. Two replicas that
 * consumed different amounts of one log ran different machines, which is the
 * divergence this measures.
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
 * A request line this replaying machine was asked for and has no replay of.
 *
 * The page asked its replica for a resource the primary's log does not carry
 * — the primary's browser served it from cache, or served it before this
 * replica joined. The primary can still make that request, so the miss is
 * reported to the main thread, where the wire to the primary is, instead of
 * waiting out the deadline into a 502.
 */
export interface ReplicationHttpMissMessage {
  type: "replication_http_miss";
  /** The request line, `"METHOD target"`, as the replay store keys it. */
  key: string;
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
  | OwnedJobMessage
  | SpawnMessage
  | TerminateProcessMessage
  | ReadVfsFileMessage
  | ReadVfsDirMessage
  | StatVfsPathMessage
  | WriteVfsFileMessage
  | UnlinkVfsFileMessage
  | ExportRootfsImageMessage
  | ClipboardOfferMessage
  | ClipboardGuestWaitMessage
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
  | IsStdinConsumedMessage
  | SignalProcessMessage
  | PickListenerTargetMessage
  | DestroyMessage
  | RegisterPtyOutputMessage
  | GetForkCountRequestMessage
  | GetKernelMemoryPagesRequestMessage
  | GetWasmModuleCacheStatsRequestMessage
  | GetSpawnScratchCapacityRequestMessage
  | MouseInjectMessage
  | InputEventInjectMessage
  | InputEventBatchInjectMessage
  | SetInputCanvasDimsMessage
  | AudioDrainMessage
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
  | FbReleaseGenerationAckMessage
  | KmsSetDisplaySizeMessage;

// ── Kernel Worker → Main Thread ──

export interface ReadyMessage {
  type: "ready";
  /** Versioned PCM-only shared transport claimed by the kernel worker. */
  pcmTransport?: PcmTransportDescriptor;
}

export interface ExitMessage {
  type: "exit";
  pid: number;
  /** Host-only execution identity. PIDs persist across exec. */
  generation: number;
  status: number;
}

export interface ListenTcpMessage {
  type: "listen_tcp";
  pid: number;
  fd: number;
  port: number;
}

/**
 * Forwarded /dev/fb0 binding. Fired when a process mmaps the
 * framebuffer; the main thread builds a typed-array view over
 * `memory.buffer` at `[addr, addr+len)` and presents it on a canvas.
 *
 * `memory` is the process's WebAssembly.Memory — a SharedArrayBuffer
 * shared with the kernel worker. Sending the Memory across postMessage
 * is fine; both threads see the same SAB.
 */
export interface FbBindMessage {
  type: "fb_bind";
  pid: number;
  /** Host-only execution identity. PIDs persist across exec. */
  generation: number;
  addr: number;
  len: number;
  w: number;
  h: number;
  stride: number;
  fmt: "BGRA32";
  memory: WebAssembly.Memory;
}

export interface FbUnbindMessage {
  type: "fb_unbind";
  pid: number;
  /** The exact execution generation whose binding was removed. */
  generation: number;
}

/**
 * Fired when a process's WebAssembly.Memory is replaced (memory.grow,
 * exec). The main-thread renderer must invalidate any cached view; the
 * `memory` reference is the new (post-grow) Memory.
 */
export interface FbRebindMemoryMessage {
  type: "fb_rebind_memory";
  pid: number;
  /** The exact execution generation whose Memory grew. */
  generation: number;
  memory: WebAssembly.Memory;
}

/**
 * Forwarded write-based pixel push. Used by software (e.g. fbDOOM)
 * that does `write(fd_fb, …)` rather than mmap. Bytes are copied out
 * of kernel scratch in the worker — `bytes` here is a transferable
 * Uint8Array (non-shared); the main thread copies it into the
 * registry's per-pid hostBuffer.
 */
export interface FbWriteMessage {
  type: "fb_write";
  pid: number;
  /** The exact execution generation that produced these pixels. */
  generation: number;
  offset: number;
  bytes: Uint8Array;
}

/**
 * A process-generation teardown fence. The main thread first drops its
 * structured-clone Memory wrapper and cached framebuffer views, then replies
 * with FbReleaseGenerationAckMessage. The kernel worker does not classify a
 * framebuffer-exposed generation as exactly retired before this round trip.
 */
export interface FbReleaseGenerationMessage {
  type: "fb_release_generation";
  requestId: number;
  pid: number;
  generation: number;
}

/**
 * Clears the short-lived terminal-generation tombstone after the kernel worker
 * receives the release ACK. Exact-generation quiescence plus message ordering
 * guarantee that no bind from this or an older generation can still arrive
 * after this marker.
 */
export interface FbForgetGenerationMessage {
  type: "fb_forget_generation";
  pid: number;
  generation: number;
}

/**
 * Number of service-worker preview requests currently being served through
 * the transferred HTTP bridge.
 */
export interface HttpBridgePendingMessage {
  type: "http_bridge_pending";
  count: number;
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

/** A path under a watched prefix changed in the worker-owned VFS. */
export interface VfsChangeMessage {
  type: "vfs_change";
  event: VfsChangeEvent;
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
  | ListenTcpMessage
  | FbBindMessage
  | FbUnbindMessage
  | FbRebindMemoryMessage
  | FbWriteMessage
  | FbReleaseGenerationMessage
  | FbForgetGenerationMessage
  | ProcEventMessage
  | HttpBridgePendingMessage
  | LazyDownloadMessage
  | DestroyProgressMessage
  | VfsChangeMessage
  | ReplicationRecordedMessage
  | ReplicationHttpMissMessage;

export interface WatchVfsChangesMessage {
  type: "watch_vfs_changes"; prefix: string; enabled: boolean;
}
