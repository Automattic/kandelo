// --- Host → Worker messages ---

export type HostToWorkerMessage =
  | CentralizedWorkerInitMessage
  | CentralizedThreadInitMessage
  | WorkerTerminateMessage
  | DeliverSignalMessage
  | ExecReplyMessage;

export interface DeliverSignalMessage {
  type: "deliver_signal";
  signal: number;
}

/**
 * Init message for centralized-mode Workers.
 * These Workers don't instantiate a kernel — they use channel IPC
 * to communicate with the CentralizedKernelWorker.
 */
export interface CentralizedWorkerInitMessage {
  type: "centralized_init";
  pid: number;
  ppid: number;
  /** User program bytes (compiled with channel_syscall.c — no kernel imports) */
  programBytes: ArrayBuffer;
  /** Shared Memory for this process (also shared with CentralizedKernelWorker) */
  memory: WebAssembly.Memory;
  /** Channel offset within the shared Memory for this thread's syscall channel */
  channelOffset: number;
  /** Optional env vars to set up in the program */
  env?: string[];
  /** Optional argv */
  argv?: string[];
  /** Optional cwd */
  cwd?: string;
}

/**
 * Init message for thread Workers in centralized mode.
 * Threads share the parent process's Memory and run a function pointer.
 */
export interface CentralizedThreadInitMessage {
  type: "centralized_thread_init";
  pid: number;
  tid: number;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  memory: WebAssembly.Memory;
  channelOffset: number;
  fnPtr: number;
  argPtr: number;
  stackPtr: number;
  tlsPtr: number;
  ctidPtr: number;
  /** Pre-allocated address in shared memory for Wasm TLS initialization */
  tlsAllocAddr: number;
}

export interface WorkerTerminateMessage {
  type: "terminate";
}

// --- Worker → Host messages ---

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerExitMessage
  | ThreadExitMessage
  | WorkerErrorMessage
  | ExecRequestMessage
  | ExecCompleteMessage
  | AlarmSetMessage;

export interface WorkerReadyMessage {
  type: "ready";
  pid: number;
}

export interface WorkerExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface ThreadExitMessage {
  type: "thread_exit";
  pid: number;
  tid: number;
}

export interface WorkerErrorMessage {
  type: "error";
  pid: number;
  message: string;
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

export interface ExecReplyMessage {
  type: "exec_reply";
  wasmBytes: ArrayBuffer;
  programBytes?: ArrayBuffer;
}
