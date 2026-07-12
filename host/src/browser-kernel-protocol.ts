/**
 * Message protocol for main thread ↔ kernel worker communication.
 *
 * The kernel worker hosts the CentralizedKernelWorker and all process
 * lifecycle. The main thread is a thin UI proxy that sends messages here.
 */
import type {
  HttpRequest,
  HttpResponse,
} from "./networking/in-kernel-http";
import type { LazyDownloadEvent } from "./vfs/memory-fs";

export type { HttpRequest, HttpResponse };

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  kernelWasmBytes: ArrayBuffer;
  /**
   * Pre-built VFS image bytes from MemoryFileSystem.saveImage(). The worker
   * constructs and OWNS its own memfs via MemoryFileSystem.fromImage() — no
   * VFS SAB is shared with the main thread. Demos that need `/etc/{passwd,
   * group,hosts,services}` bake it into the image (see
   * apps/browser-demos/lib/kernel-owned-boot.ts::overlayEtcFromRootfs).
   */
  vfsImage: Uint8Array;
  /** Base URL for relative lazy file/archive URLs stored in vfsImage. */
  lazyUrlBase?: string;
  shmSab: SharedArrayBuffer;
  workerEntryUrl: string;
  bridgePort?: MessagePort;
  config: {
    maxWorkers: number;
    maxMemoryPages: number;
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
  };
}

export interface SpawnMessage {
  type: "spawn";
  requestId: number;
  /**
   * Optional. When omitted, the worker allocates a fresh pid via the
   * kernel's allocator (which skips reserved pids like the virtual init).
   * The assigned pid is returned in the response. The pid field exists for
   * legacy callers (PtyTerminal.spawn, system-init) that still pre-pick;
   * new code should leave it undefined.
   */
  pid?: number;
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

export interface TerminateProcessMessage {
  type: "terminate_process";
  requestId: number;
  pid: number;
  status: number;
}

export interface ReadVfsFileMessage {
  type: "read_vfs_file";
  requestId: number;
  path: string;
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

export interface InjectConnectionMessage {
  type: "inject_connection";
  requestId: number;
  pid: number;
  fd: number;
  peerAddr: [number, number, number, number];
  peerPort: number;
}

export interface PipeReadMessage {
  type: "pipe_read";
  requestId: number;
  pid: number;
  pipeIdx: number;
}

export interface PipeWriteMessage {
  type: "pipe_write";
  requestId: number;
  pid: number;
  pipeIdx: number;
  data: Uint8Array;
}

export interface PipeCloseReadMessage {
  type: "pipe_close_read";
  pid: number;
  pipeIdx: number;
}

export interface PipeCloseWriteMessage {
  type: "pipe_close_write";
  pid: number;
  pipeIdx: number;
}

export interface PipeIsWriteOpenMessage {
  type: "pipe_is_write_open";
  requestId: number;
  pid: number;
  pipeIdx: number;
}

export interface WakeBlockedReadersMessage {
  type: "wake_blocked_readers";
  pipeIdx: number;
}

export interface WakeBlockedWritersMessage {
  type: "wake_blocked_writers";
  pipeIdx: number;
}

export interface IsStdinConsumedMessage {
  type: "is_stdin_consumed";
  requestId: number;
  pid: number;
}

export interface PickListenerTargetMessage {
  type: "pick_listener_target";
  requestId: number;
  port: number;
}

export interface DestroyMessage {
  type: "destroy";
  requestId: number;
}

export interface RegisterPtyOutputMessage {
  type: "register_pty_output";
  pid: number;
}

export interface RegisterLazyFilesMessage {
  type: "register_lazy_files";
  requestId?: number;
  entries: Array<{ ino: number; path: string; url: string; size: number }>;
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

export interface RegisterLazyArchivesMessage {
  type: "register_lazy_archives";
  requestId?: number;
  entries: Array<{
    url: string;
    mountPrefix: string;
    materialized: boolean;
    entries: Array<{
      vfsPath: string;
      ino: number;
      size: number;
      isSymlink: boolean;
      deleted: boolean;
    }>;
  }>;
}

/** Read kernel-side per-process fork counter. Mirrors the Node host's
 * `get_fork_count` request in node-kernel-protocol.ts. The kernel-worker
 * forwards to `kernel_get_fork_count` and posts a `response` whose
 * `result` is a `bigint`. Used by the spawn regression tests to assert
 * SYS_SPAWN didn't fall back to fork. */
export interface GetForkCountRequestMessage {
  type: "get_fork_count";
  requestId: number;
  pid: number;
}

/** Snapshot the kernel's process table. The kernel-worker forwards to
 * `CentralizedKernelWorker.enumProcs()`; the response carries `ProcessSnapshot[]`.
 * Used by Kandelo's Inspector → Procs tab. */
export interface EnumProcsRequestMessage {
  type: "enum_procs";
  requestId: number;
}

/** Read `/proc/[pid]/maps` for a foreign process via the host. The kernel-
 * worker forwards to `CentralizedKernelWorker.readProcMaps(pid)`; response
 * carries a string (Linux smaps-ish text) or `null` if the pid is gone. */
export interface ReadProcMapsRequestMessage {
  type: "read_proc_maps";
  requestId: number;
  pid: number;
}

/** Enable / disable the syscall trace ring buffer. Off by default — flip
 * on when a subscriber attaches, off when the last one detaches. */
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
 *  {@link HttpResponse}. */
export interface HttpRequestMessage {
  type: "http_request";
  requestId: number;
  port: number;
  request: HttpRequest;
  timeoutMs?: number;
}

/** Register an `OffscreenCanvas` as the scanout target for a KMS CRTC.
 *  The kernel-worker's vblank pump blits the CRTC's bound framebuffer
 *  into this canvas at 60 Hz. The canvas MUST be transferred (the
 *  `transfer` array contains it) — the browser would otherwise refuse
 *  to hand off control. Optional `stats` SAB receives blit/page-flip
 *  telemetry. */
export interface KmsAttachCanvasMessage {
  type: "kms_attach_canvas";
  crtcId: number;
  canvas: OffscreenCanvas;
  stats?: SharedArrayBuffer;
  opts?: { mode?: "auto" | "2d" | "webgl2" };
}

/** Register a stats SAB for a CRTC without binding a scanout canvas. The
 *  vblank pump still writes kernel-side `commit_count` / `last_frame_us`
 *  into slots 5/6. Used by GL-rendered demos that present via WebGL
 *  rather than the 2D blit path. */
export interface KmsAttachStatsMessage {
  type: "kms_attach_stats";
  crtcId: number;
  stats: SharedArrayBuffer;
}

export type MainToKernelMessage =
  | InitMessage
  | SpawnMessage
  | TerminateProcessMessage
  | ReadVfsFileMessage
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
  | PickListenerTargetMessage
  | DestroyMessage
  | RegisterPtyOutputMessage
  | RegisterLazyFilesMessage
  | RegisterLazyArchivesMessage
  | GetForkCountRequestMessage
  | MouseInjectMessage
  | AudioDrainMessage
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

export interface InitErrorMessage {
  type: "init_error";
  error: string;
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
}

/**
 * Fired when a process's WebAssembly.Memory is replaced (memory.grow,
 * exec). The main-thread renderer must invalidate any cached view; the
 * `memory` reference is the new (post-grow) Memory.
 */
export interface FbRebindMemoryMessage {
  type: "fb_rebind_memory";
  pid: number;
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
  offset: number;
  bytes: Uint8Array;
}

/**
 * Posted whenever the kernel forks, execs, or spawns. The main thread
 * uses this to refresh Inspector-style views without polling. `kind ===
 * "exit"` is delivered via the existing ExitMessage instead; we don't
 * duplicate it here. Spawn events always carry the authoritative parent pid;
 * exec events preserve process identity and do not.
 */
export type ProcEventMessage =
  | { type: "proc_event"; kind: "spawn"; pid: number; ppid: number }
  | { type: "proc_event"; kind: "exec"; pid: number };

/**
 * Number of service-worker preview requests currently being served through
 * the transferred HTTP bridge.
 */
export interface HttpBridgePendingMessage {
  type: "http_bridge_pending";
  count: number;
}

export interface LazyDownloadMessage {
  type: "lazy_download";
  event: LazyDownloadEvent;
}

export type KernelToMainMessage =
  | ReadyMessage
  | InitErrorMessage
  | ResponseMessage
  | ExitMessage
  | StdoutMessage
  | StderrMessage
  | PtyOutputMessage
  | ListenTcpMessage
  | FbBindMessage
  | FbUnbindMessage
  | FbRebindMemoryMessage
  | FbWriteMessage
  | ProcEventMessage
  | HttpBridgePendingMessage
  | LazyDownloadMessage;
