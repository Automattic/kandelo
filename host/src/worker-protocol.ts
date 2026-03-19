import type { KernelConfig } from "./types";

// --- Host → Worker messages ---

export type HostToWorkerMessage =
  | WorkerInitMessage
  | WorkerTerminateMessage
  | GetForkStateMessage
  | RegisterPipeMessage
  | ConvertPipeMessage
  | DeliverSignalMessage
  | ExecReplyMessage
  | ThreadInitMessage;

export interface GetForkStateMessage {
  type: "get_fork_state";
}

export interface RegisterPipeMessage {
  type: "register_pipe";
  handle: number;
  buffer: SharedArrayBuffer;
  end: "read" | "write";
}

export interface ConvertPipeMessage {
  type: "convert_pipe";
  ofdIndex: number;
  newHandle: number;
}

export interface DeliverSignalMessage {
  type: "deliver_signal";
  signal: number;
}

export interface WorkerInitMessage {
  type: "init";
  pid: number;
  ppid: number;
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  env?: string[];
  argv?: string[];
  cwd?: string;
  forkState?: ArrayBuffer;
  signalWakeSab?: SharedArrayBuffer;
  lockTableSab?: SharedArrayBuffer;
  forkSab?: SharedArrayBuffer;
  waitpidSab?: SharedArrayBuffer;
  programBytes?: ArrayBuffer;
  mounts?: SerializedMountConfig[];
  /** Asyncify fork resume data — if present, child resumes from fork point. */
  asyncifyResume?: {
    memorySnapshot: ArrayBuffer;
    asyncifyData: ArrayBuffer;
    asyncifyDataAddr: number;
  };
}

export interface WorkerTerminateMessage {
  type: "terminate";
}

// --- Worker → Host messages ---

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerExitMessage
  | WorkerErrorMessage
  | ForkStateMessage
  | KillRequestMessage
  | ExecRequestMessage
  | ExecCompleteMessage
  | AlarmSetMessage
  | ForkRequestMessage
  | WaitpidRequestMessage
  | ThreadExitMessage
  | CloneRequestMessage;

export interface WorkerReadyMessage {
  type: "ready";
  pid: number;
}

export interface WorkerExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface WorkerErrorMessage {
  type: "error";
  pid: number;
  message: string;
}

export interface ForkStateMessage {
  type: "fork_state";
  pid: number;
  data: ArrayBuffer;
}

export interface KillRequestMessage {
  type: "kill_request";
  pid: number;
  signal: number;
  sourcePid: number;
}

export interface ExecRequestMessage {
  type: "exec_request";
  pid: number;
  path: string;
}

export interface ExecCompleteMessage {
  type: "exec_complete";
  pid: number;
}

export interface AlarmSetMessage {
  type: "alarm_set";
  pid: number;
  seconds: number;
}

export interface ForkRequestMessage {
  type: "fork_request";
  pid: number;
  forkSab: SharedArrayBuffer;
  forkState: ArrayBuffer;
  pipeSabs?: { handle: number; sab: SharedArrayBuffer; end: "read" | "write" }[];
  /** Asyncify fork data — enables child to resume from fork point. */
  asyncifyData?: {
    memorySnapshot: ArrayBuffer;
    asyncifyData: ArrayBuffer;
    asyncifyDataAddr: number;
  };
}

export interface WaitpidRequestMessage {
  type: "waitpid_request";
  pid: number;
  targetPid: number;
  options: number;
  waitpidSab: SharedArrayBuffer;
}

export interface ExecReplyMessage {
  type: "exec_reply";
  wasmBytes: ArrayBuffer;
  programBytes?: ArrayBuffer;
}

/** Host → Worker: initialize as a thread (not a process) */
export interface ThreadInitMessage {
  type: "thread_init";
  tid: number;
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  programBytes?: ArrayBuffer;
  fnPtr: number;
  argPtr: number;
  stackPtr: number;
  tlsPtr: number;
  ctidPtr: number;
  signalWakeSab?: SharedArrayBuffer;
  lockTableSab?: SharedArrayBuffer;
  /** The parent's shared WebAssembly.Memory — threads share the same linear memory. */
  memory: WebAssembly.Memory;
}

/** Worker → Host: thread finished */
export interface ThreadExitMessage {
  type: "thread_exit";
  tid: number;
  exitCode: number;
}

/** Worker → Host: clone request from kernel */
export interface CloneRequestMessage {
  type: "clone_request";
  pid: number;
  fnPtr: number;
  argPtr: number;
  stackPtr: number;
  tlsPtr: number;
  ctidPtr: number;
  cloneSab: SharedArrayBuffer;
  /** The parent's shared WebAssembly.Memory for the new thread. */
  memory: WebAssembly.Memory;
}

export interface SerializedMountConfig {
  mountPoint: string;
  type: "host" | "memory";
  rootPath?: string;
  sharedBuffer?: SharedArrayBuffer;
  initialize?: boolean;
}
