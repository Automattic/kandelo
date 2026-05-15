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
  /** Pre-compiled WebAssembly module (avoids recompilation in web workers) */
  programModule?: WebAssembly.Module;
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
  /** If true, this is a fork child created via asyncify — do rewind instead of normal _start */
  isForkChild?: boolean;
  /** Address of asyncify data buffer in memory (used for fork child rewind) */
  asyncifyBufAddr?: number;
  /**
   * Entry-point overrides for fork-from-non-main-thread children.
   *
   * When the parent process calls fork() from a thread spawned via
   * pthread_create, the asyncify unwind frames trace the *thread
   * function's* call chain (rooted at `forkChildThreadFnPtr`), not
   * `_start`'s. The child Worker must therefore call the thread
   * function directly — `_start` is not in that call chain, so
   * rewinding through it would never reach the fork() call site.
   *
   * Set together with `isForkChild`. `forkChildThreadFnPtr` is the
   * indirect-function-table index that pthread_create stored;
   * `forkChildThreadArgPtr` is the userdata arg. The kernel-worker's
   * per-thread fork context propagates them from the parent thread
   * worker's clone init data through `handleFork`.
   */
  forkChildThreadFnPtr?: number;
  forkChildThreadArgPtr?: number;
  /** Pointer width: 4 for wasm32, 8 for wasm64. Defaults to 4. */
  ptrWidth?: 4 | 8;
  /**
   * Kernel's advertised ABI version (read from its `__abi_version`
   * export at kernel startup). Worker compares against the program's
   * own `__abi_version` export and refuses mismatches.
   */
  kernelAbiVersion?: number;
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
  /** Pointer width: 4 for wasm32, 8 for wasm64. Defaults to 4. */
  ptrWidth?: 4 | 8;
  /** See [`CentralizedWorkerInitMessage#kernelAbiVersion`]. */
  kernelAbiVersion?: number;
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
