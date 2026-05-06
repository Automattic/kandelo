/**
 * Message protocol for main thread ↔ kernel worker communication.
 *
 * The kernel worker hosts the CentralizedKernelWorker and all process
 * lifecycle. The main thread is a thin UI proxy that sends messages here.
 */

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  kernelWasmBytes: ArrayBuffer;
  /**
   * Pre-built VFS image bytes from MemoryFileSystem.saveImage(). The worker
   * constructs its own memfs via MemoryFileSystem.fromImage(). When this is
   * present, the kernel owns the FS — no SAB is shared with the main thread,
   * and `kernel.fs` is unavailable.
   */
  vfsImage?: Uint8Array;
  /**
   * @deprecated — legacy path. Kept until all demos migrate to vfsImage.
   * Pre-formatted SharedFS SAB shared with the main thread (so demos can
   * pre-populate via the now-deprecated `kernel.fs` accessor).
   */
  fsSab?: SharedArrayBuffer;
  shmSab: SharedArrayBuffer;
  workerEntryUrl: string;
  bridgePort?: MessagePort;
  config: {
    maxWorkers: number;
    maxMemoryPages: number;
    env: string[];
    /** Forwarded to KernelConfig.enableSyscallLog — log every syscall. */
    enableSyscallLog?: boolean;
    /** Forwarded to KernelConfig.syscallLogPtrWidth — only log for processes
     *  of the given pointer width. */
    syscallLogPtrWidth?: 4 | 8;
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
  pty?: boolean;
  stdin?: Uint8Array;
  maxPages?: number;
}

export interface TerminateProcessMessage {
  type: "terminate_process";
  requestId: number;
  pid: number;
  status: number;
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
  entries: Array<{ ino: number; path: string; url: string; size: number }>;
}

export interface RegisterLazyArchivesMessage {
  type: "register_lazy_archives";
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

export type MainToKernelMessage =
  | InitMessage
  | SpawnMessage
  | TerminateProcessMessage
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
  | RegisterLazyArchivesMessage;

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

export type KernelToMainMessage =
  | ReadyMessage
  | ResponseMessage
  | ExitMessage
  | StdoutMessage
  | StderrMessage
  | PtyOutputMessage
  | ListenTcpMessage
  | FbBindMessage
  | FbUnbindMessage
  | FbRebindMemoryMessage
  | FbWriteMessage;
