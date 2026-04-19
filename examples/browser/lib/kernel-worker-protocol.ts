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
  fsSab: SharedArrayBuffer;
  shmSab: SharedArrayBuffer;
  workerEntryUrl: string;
  bridgePort?: MessagePort;
  config: {
    maxWorkers: number;
    maxMemoryPages: number;
    env: string[];
  };
}

export interface SpawnMessage {
  type: "spawn";
  requestId: number;
  pid: number;
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

export type KernelToMainMessage =
  | ReadyMessage
  | ResponseMessage
  | ExitMessage
  | StdoutMessage
  | StderrMessage
  | PtyOutputMessage
  | ListenTcpMessage;
