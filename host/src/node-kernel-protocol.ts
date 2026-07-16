/**
 * Message protocol for Node.js main thread ↔ kernel worker_thread communication.
 *
 * Mirrors browser-kernel-protocol.ts but adapted for Node.js:
 * - No SharedArrayBuffer VFS (Node uses real filesystem via NodePlatformIO)
 * - No worker entry URLs (Node uses NodeWorkerAdapter)
 * - No pipe/inject/bridge operations (TCP bridging is automatic via NodePlatformIO)
 *
 * The `http_request` message is a host-driven HTTP request injected
 * straight into an in-kernel server's accept queue, bypassing real TCP.
 * See docs/plans/2026-04-30-external-kernel-http-request-interface.md.
 */
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";

export type { HttpRequest, HttpResponse };

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  kernelWasmBytes: ArrayBuffer;
  config: {
    maxWorkers: number;
    maxPages?: number;
    /** Host default pthread slots for process-wasm declarations of -1. */
    defaultThreadSlots?: number;
    dataBufferSize?: number;
    useSharedMemory?: boolean;
  };
  /** Virtual path → host filesystem path for exec resolution */
  execPrograms?: Record<string, string>;
  /**
   * Bytes of `host/wasm/rootfs.vfs`, read on the main thread and forwarded
   * to the worker. When present, the worker materialises the default mount
   * spec (rootfs at `/`, scratch dirs at `/tmp` etc.) and constructs a
   * `VirtualPlatformIO`. Absent → worker falls back to `NodePlatformIO`
   * (custom-io / legacy path).
   */
  rootfsImage?: ArrayBuffer;
  extraMounts?: Array<{ mountPoint: string; hostPath: string; readonly?: boolean }>;
  /** Attach a real-TCP backend (TcpNetworkBackend) to the worker's PlatformIO
   *  so wasm programs can dial external hosts via Node `net.Socket`. */
  enableTcpNetwork?: boolean;
}

export interface SpawnMessage {
  type: "spawn";
  requestId: number;
  programBytes: ArrayBuffer;
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

export interface AppendStdinDataMessage {
  type: "append_stdin_data";
  pid: number;
  data: Uint8Array;
}

export interface SetStdinDataMessage {
  type: "set_stdin_data";
  pid: number;
  data: Uint8Array;
}

export interface PtyWriteMessage {
  type: "pty_write";
  pid: number;
  data: Uint8Array;
}

export interface PtyResizeMessage {
  type: "pty_resize";
  pid: number;
  rows: number;
  cols: number;
}

export interface TerminateProcessMessage {
  type: "terminate_process";
  requestId: number;
  pid: number;
  status: number;
}

export interface DestroyMessage {
  type: "destroy";
  requestId: number;
}

/** Request the kernel's per-process fork counter. The kernel-worker entry
 * forwards this to `kernel_get_fork_count` and posts a `response` message
 * with `result` set to a `bigint` (u64 as BigInt). Used by the spawn
 * regression tests to assert SYS_SPAWN doesn't bump the counter. */
export interface GetForkCountRequestMessage {
  type: "get_fork_count";
  requestId: number;
  pid: number;
}

export interface ResolveExecResponseMessage {
  type: "resolve_exec_response";
  requestId: number;
  programBytes: ArrayBuffer | null;
}

/** Snapshot the kernel's process table. Mirrors the browser host's
 * enum_procs request in browser-kernel-protocol.ts.
 * Response carries `ProcessSnapshot[]`. */
export interface EnumProcsRequestMessage {
  type: "enum_procs";
  requestId: number;
}

/** Read `/proc/[pid]/maps` for a foreign process via the host. Response
 * carries a string (Linux maps text) or `null` if the pid is gone. */
export interface ReadProcMapsRequestMessage {
  type: "read_proc_maps";
  requestId: number;
  pid: number;
}

/** Enable / disable the syscall trace ring. Mirrors the browser host. */
export interface SetSyscallTraceMessage {
  type: "set_syscall_trace";
  enabled: boolean;
}

/** Drain pending syscall trace events. Response carries SyscallTraceEvent[]. */
export interface DrainSyscallTraceMessage {
  type: "drain_syscall_trace";
  requestId: number;
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
}

/** Register an `OffscreenCanvas` as the scanout target for a KMS CRTC.
 *  Mirrors the Browser-side handler. Under Node, OffscreenCanvas is only
 *  available when the host wires a polyfill; without one the worker
 *  ignores the canvas and only `attachKmsStats` is meaningful. */
export interface KmsAttachCanvasMessage {
  type: "kms_attach_canvas";
  crtcId: number;
  canvas: OffscreenCanvas;
  stats?: SharedArrayBuffer;
  opts?: { mode?: "auto" | "2d" | "webgl2" | "webgl2-scanout" };
}

/** Register a stats SAB for a CRTC without binding a scanout canvas. */
export interface KmsAttachStatsMessage {
  type: "kms_attach_stats";
  crtcId: number;
  stats: SharedArrayBuffer;
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
 * Main-thread → kernel-worker request to allocate a kernel-memory
 * SAB ring for `pcmId` of `byteLen` bytes and bind it via
 * `kernel_audio_init_sab`. The worker replies via `ResponseMessage`
 * with `{ buffer, byteOffset, byteLength }` so the main-thread
 * AudioDriver can mount an `Int16Array` view at the same offset.
 */
export interface AudioAllocRingRequestMessage {
  type: "audio_alloc_ring";
  requestId: number;
  pcmId: number;
  byteLen: number;
}

/**
 * Main-thread → kernel-worker period tick. Routes to
 * `CentralizedKernelWorker.audioPeriodTick` which calls
 * `kernel_audio_period_tick` and wakes any `POLLOUT` waiter parked on
 * `/dev/snd/pcmC0D<pcmId>p`. Fire-and-forget.
 */
export interface AudioPeriodTickMessage {
  type: "audio_period_tick";
  pcmId: number;
  framesConsumed: number;
}

/**
 * Main-thread → kernel-worker request to read the current
 * `mmap_control.appl_ptr` for any OFD bound to `pcmId`. The browser
 * driver polls this to gate the AudioWorklet's `hwPtr` advance on
 * producer progress. The worker replies via `ResponseMessage` with a
 * `number`. Kept on the Node side for dual-host parity even though
 * `NodeAudioDriver` doesn't currently poll.
 */
export interface AudioGetApplPtrRequestMessage {
  type: "audio_get_appl_ptr";
  requestId: number;
  pcmId: number;
}

/**
 * Read-only probes paired with `audio_get_appl_ptr` for host-side
 * instrumentation; kept on the Node side for dual-host parity even
 * though `NodeAudioDriver` doesn't currently poll them.
 */
export interface AudioGetHwPtrRequestMessage {
  type: "audio_get_hw_ptr";
  requestId: number;
  pcmId: number;
}

export interface AudioGetStateRequestMessage {
  type: "audio_get_state";
  requestId: number;
  pcmId: number;
}

export type MainToKernelMessage =
  | InitMessage
  | SpawnMessage
  | AppendStdinDataMessage
  | SetStdinDataMessage
  | PtyWriteMessage
  | PtyResizeMessage
  | TerminateProcessMessage
  | DestroyMessage
  | GetForkCountRequestMessage
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
  | SetInputCanvasDimsMessage
  | AudioAllocRingRequestMessage
  | AudioPeriodTickMessage
  | AudioGetApplPtrRequestMessage
  | AudioGetHwPtrRequestMessage
  | AudioGetStateRequestMessage;

// ── Kernel Worker → Main Thread ──

export interface ReadyMessage {
  type: "ready";
}

export interface ResponseMessage {
  type: "response";
  requestId: number;
  result: unknown;
  error?: string;
}

export interface ExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface StdoutMessage {
  type: "stdout";
  pid: number;
  data: Uint8Array;
}

export interface StderrMessage {
  type: "stderr";
  pid: number;
  data: Uint8Array;
}

export interface PtyOutputMessage {
  type: "pty_output";
  pid: number;
  data: Uint8Array;
}

export interface ResolveExecRequestMessage {
  type: "resolve_exec";
  requestId: number;
  path: string;
}

/**
 * Posted whenever the kernel forks, execs, or posix_spawns. Mirrors the
 * browser-side ProcEventMessage. Exit events come via the existing
 * ExitMessage; we don't duplicate them here.
 */
export interface ProcEventMessage {
  type: "proc_event";
  kind: "spawn" | "exec";
  pid: number;
  ppid?: number;
}

export type KernelToMainMessage =
  | ReadyMessage
  | ResponseMessage
  | ExitMessage
  | StdoutMessage
  | StderrMessage
  | PtyOutputMessage
  | ResolveExecRequestMessage
  | ProcEventMessage;
