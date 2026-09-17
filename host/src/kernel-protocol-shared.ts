/**
 * Message types shared verbatim by the Node and browser kernel protocols.
 *
 * `browser-kernel-protocol.ts` and `node-kernel-protocol.ts` declared these
 * **byte-identically**, twice. Structural declarations with no platform
 * content: the two hosts are peers, so a message either exists for both or is
 * genuinely one host's.
 *
 * # What is deliberately NOT here
 *
 * Types whose bodies differ between the hosts stay in their own files, because
 * the differences are real. `ExitMessage` is the clearest: the browser carries
 * a `generation` field that Node does not, and it is not an oversight —
 * `browser-kernel-host.ts` uses it for `releaseProcessFramebuffer` and
 * framebuffer generation comparison, and Node has no framebuffer. Merging
 * those would either invent a field for one host or drop one from the other.
 *
 * `HttpRequestMessage` is byte-identical apart from inline doc comments and is
 * left alone for now: choosing whose comments survive is a judgement call, not
 * a mechanical merge.
 */
import type { HttpRequest, HttpResponse } from "./networking/in-kernel-http";
import type { LazyDownloadEvent } from "./vfs/memory-fs";

export type { HttpRequest, HttpResponse };

/** Deliver `signum` to `pid`. Responds `true` when the process existed. */
export interface SignalProcessMessage {
  type: "signal_process";
  requestId: number;
  pid: number;
  signum: number;
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

/** Read the kernel Wasm instance's current 64 KiB linear-memory page count. */
export interface GetKernelMemoryPagesRequestMessage {
  type: "get_kernel_memory_pages";
  requestId: number;
}

/** Read the retained capacity of the kernel-owned large-spawn region. */
export interface GetSpawnScratchCapacityRequestMessage {
  type: "get_spawn_scratch_capacity";
  requestId: number;
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

export interface InitErrorMessage {
  type: "init_error";
  error: string;
}

/** The dedicated kernel instance is poisoned and has stopped permanently. */
export interface KernelFatalMessage {
  type: "kernel_fatal";
  error: string;
}

export interface ResponseMessage {
  type: "response";
  requestId: number;
  result: unknown;
  error?: string;
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

export interface LazyDownloadMessage {
  type: "lazy_download";
  event: LazyDownloadEvent;
}

export interface AppendStdinDataMessage {
  type: "append_stdin_data";
  pid: number;
  data: Uint8Array;
}

export interface DestroyMessage {
  type: "destroy";
  requestId: number;
}

/**
 * Serialize the quiescent worker-owned root filesystem.
 *
 * This deliberately captures only the `/` image backend. Scratch and device
 * mounts are boot-scoped and are recreated by the host on the next boot.
 */
export interface ExportRootfsImageMessage {
  type: "export_rootfs_image";
  requestId: number;
}

export interface InjectConnectionMessage {
  type: "inject_connection";
  requestId: number;
  pid: number;
  fd: number;
  peerAddr: [number, number, number, number];
  peerPort: number;
}

export interface PickListenerTargetMessage {
  type: "pick_listener_target";
  requestId: number;
  port: number;
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

export interface PtyResizeMessage {
  type: "pty_resize";
  pid: number;
  rows: number;
  cols: number;
}

export interface PtyWriteMessage {
  type: "pty_write";
  pid: number;
  data: Uint8Array;
}

export interface SetStdinDataMessage {
  type: "set_stdin_data";
  pid: number;
  data: Uint8Array;
}

export interface TerminateProcessMessage {
  type: "terminate_process";
  requestId: number;
  pid: number;
  status: number;
}

export interface WakeBlockedReadersMessage {
  type: "wake_blocked_readers";
  pipeIdx: number;
}

export interface WakeBlockedWritersMessage {
  type: "wake_blocked_writers";
  pipeIdx: number;
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

/** Create or replace one regular file through the worker-owned VFS. */
export interface WriteVfsFileMessage {
  type: "write_vfs_file";
  requestId: number;
  /** Normalized absolute guest path whose parent already exists. */
  path: string;
  data: Uint8Array;
  mode: number;
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
