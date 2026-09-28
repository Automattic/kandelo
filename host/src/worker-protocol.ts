import type { ProcessForkMode } from "./generated/abi";

export type ForkMemoryOwnership = "copied" | "borrowed";

// --- Host → Worker messages ---

/**
 * Host-internal channel marker for retiring an exec-discarded process Worker
 * without issuing SYS_EXIT for the persistent process.
 *
 * WHY: both the kernel worker that publishes the marker and worker-main that
 * consumes it must share one token. A duplicated literal would fail as a
 * silent timeout and lose the exact ownership fence for that old generation.
 */
export const EXEC_RETIRE_SIGNAL_CODE = 0x4b455852; // "KEXR"

export type HostToWorkerMessage =
  | CentralizedWorkerInitMessage
  | CentralizedThreadInitMessage
  | WorkerTerminateMessage
  | ExecReplyMessage;

/**
 * Init message for centralized-mode Workers.
 * These Workers don't instantiate a kernel — they use channel IPC
 * to communicate with the CentralizedKernelWorker.
 */
export interface CentralizedWorkerInitMessage {
  type: "centralized_init";
  pid: number;
  /** User program bytes (compiled with channel_syscall.c — no kernel imports) */
  programBytes: ArrayBuffer;
  /** Pre-compiled WebAssembly module (avoids recompilation in web workers) */
  programModule?: WebAssembly.Module;
  /**
   * Phase 6 D5: the pre-compiled `fork-module` matching this process's pointer
   * width. The kernel host resolves and compiles it once and ships it here so
   * the worker instantiates without recompiling. The co-resident module is the
   * UNCONDITIONAL fork reconstructor + capturer, so it is always shipped to a
   * fork-instrumented worker; a fork-instrumented worker that receives no module
   * fails loud.
   */
  forkModuleModule?: WebAssembly.Module;
  /**
   * The pre-compiled co-resident `wasi-module`. The kernel host resolves and
   * compiles it once and ships it here so a worker whose program turns out to
   * be a WASI module instantiates without recompiling. WASI Preview 1 is a
   * wasm32 ABI, so this is absent for a wasm64 worker; a wasm64 WASI guest
   * fails loud rather than silently losing WASI.
   */
  wasiModuleModule?: WebAssembly.Module;
  /**
   * The pre-compiled standalone dynamic-linking planner
   * (`crates/dylink-module`), shipped to EVERY process worker rather than only
   * fork-instrumented ones.
   *
   * `dlopen` is a generic POSIX interface, and the planner is a pure function
   * of module bytes: it imports nothing, owns its own linear memory, and is not
   * pointer-width-specific (the process's pointer width travels in its
   * configuration record), so a wasm64 worker gets it too. Absent when the tree
   * has not built the module yet, which is not fatal until something drives it.
   */
  dylinkModuleModule?: WebAssembly.Module;
  /** Shared Memory for this process (also shared with CentralizedKernelWorker) */
  memory: WebAssembly.Memory;
  /** Channel offset within the shared Memory for this thread's syscall channel */
  channelOffset: number;
  /** Kernel-owned sticky secure-execution state for this exact image. */
  secureExec: boolean;
  /** Optional env vars to set up in the program */
  env?: string[];
  /** Optional argv */
  argv?: string[];
  /** If true, this is a fork child — drive wpk_fork_rewind_begin instead of normal _start */
  isForkChild?: boolean;
  /** Exact ordinary/vfork mode captured by the inherited fork import. */
  forkMode?: ProcessForkMode;
  /**
   * Whether this child owns an independent copy or temporarily borrows its
   * parent's exact Memory. Borrowed ownership is valid only for vfork.
   */
  forkMemoryOwnership?: ForkMemoryOwnership;
  /** Address of the fork save-buffer in memory (used for fork child rewind) */
  forkBufAddr?: number;
  /** Parent process-wide archive/control anchor used read-only by a borrower. */
  forkOwnerControlAddr?: number;
  /** First byte of the child-private activation-prefix region. */
  forkPrivatePrefixAddr?: number;
  /** Exact admitted activation-prefix bytes. */
  forkPrivatePrefixBytes?: number;
  /** First byte of child-private reference/exception codec scratch. */
  forkScratchAddr?: number;
  /** Exact admitted scratch capacity. */
  forkScratchBytes?: number;
  /**
   * First byte of the co-resident fork-module region a COPIED fork child
   * INHERITS from its parent (COW). The parent reserved this region in the
   * shared linear memory at process init (via a first-fit `mmap`), and the
   * child's full memory clone already contains it — the region is also present
   * in the child's inherited kernel mapping table. When set, the child MUST
   * reuse this exact base for its own fork-module instance instead of reserving
   * a fresh region; a fresh reservation would double-map the module (parent's
   * inherited copy + a new one), inflating the child's observable
   * `memory.size` (e.g. a 240-page child growing to ~328) and breaking the
   * fork memory-clone invariant. Only meaningful for `forkMemoryOwnership ===
   * "copied"`; a borrowed (vfork) child reserves its own on-demand region and
   * munmaps it after replay, so it never inherits a durable base.
   */
  forkModuleInheritedBase?: number;
  /** Exact byte length of the inherited fork-module region (paired with the base). */
  forkModuleInheritedBytes?: number;
  /**
   * Entry-point override for fork children created by a non-main thread.
   *
   * A pthread worker that calls fork() unwinds through its pthread entry
   * function, not `_start`. The fork child must therefore enter that function
   * directly before `wpk_fork_rewind_begin` can replay back to the saved fork
   * site.
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
  /**
   * Kernel's ABI-contract digest (32 bytes, read from the kernel wasm's own
   * `kandelo.abi.contract` custom section at startup). The worker compares
   * this against the program's own stamp and refuses a mismatch even when the
   * ABI version NUMBERS coincide. Uint8Array clones fine across postMessage.
   * Absent when the kernel build predates the stamp.
   */
  kernelAbiContractDigest?: Uint8Array;
}

/**
 * Init message for thread Workers.
 * Threads share the parent process's Memory and run a function pointer.
 */
export interface CentralizedThreadInitMessage {
  type: "centralized_thread_init";
  pid: number;
  tid: number;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  memory: WebAssembly.Memory;
  /** Main process channel offset. The thread reads the process-wide dlopen
   * archive head relative to this live shared-memory anchor before fork. */
  processChannelOffset: number;
  channelOffset: number;
  /** Same sticky image marker as the process worker. */
  secureExec: boolean;
  /**
   * Phase 6 D7b: the pre-compiled `fork-module` matching this process's pointer
   * width, forwarded exactly as for the process worker. A fork issued FROM this
   * pthread must unwind/serialize/parent-replay through the module — the parent
   * side of a fork-from-thread — so the pthread worker always receives the same
   * co-resident module the process worker gets.
   */
  forkModuleModule?: WebAssembly.Module;
  /**
   * The pre-compiled co-resident `wasi-module`. The kernel host resolves and
   * compiles it once and ships it here so a worker whose program turns out to
   * be a WASI module instantiates without recompiling. WASI Preview 1 is a
   * wasm32 ABI, so this is absent for a wasm64 worker; a wasm64 WASI guest
   * fails loud rather than silently losing WASI.
   */
  wasiModuleModule?: WebAssembly.Module;
  /**
   * The dynamic-linking planner, forwarded exactly as for the process worker.
   * A `dlopen` issued from a pthread is an ordinary `dlopen`, so the pthread
   * worker receives the same module rather than reaching across to the process
   * worker's copy.
   */
  dylinkModuleModule?: WebAssembly.Module;
  fnPtr: number;
  argPtr: number;
  stackPtr: number;
  tlsPtr: number;
  ctidPtr: number;
  /** Pre-allocated address in shared memory for Wasm TLS initialization. */
  tlsOffset: number;
  /** Pointer width: 4 for wasm32, 8 for wasm64. Defaults to 4. */
  ptrWidth?: 4 | 8;
  /** See [`CentralizedWorkerInitMessage#kernelAbiVersion`]. */
  kernelAbiVersion?: number;
  /** See [`CentralizedWorkerInitMessage#kernelAbiContractDigest`]. */
  kernelAbiContractDigest?: Uint8Array;
}

export interface WorkerTerminateMessage {
  type: "terminate";
}

// --- Worker → Host messages ---

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerExitMessage
  | ThreadExitMessage
  | WorkerMemoryQuiescentMessage
  | WorkerExecRetiredMessage
  | WorkerErrorMessage
  | ExecRequestMessage
  | ExecCompleteMessage
  | AlarmSetMessage
  | VmInterruptTimerMessage
  | ForkModuleRegionMessage;

/**
 * The co-resident fork-module region a process worker placed in its shared
 * linear memory at init. A worker reports its exact base + byte length so the
 * kernel host can hand a COPIED fork child the SAME base to reuse (the child
 * inherits the region via its memory clone; re-reserving would double-map it
 * and inflate `memory.size`). Reported once per process/exec generation, before
 * the guest can fork. Borrowed (vfork) children do not report — they use an
 * on-demand region the kernel reclaims when their image ends.
 */
export interface ForkModuleRegionMessage {
  type: "fork_module_region";
  pid: number;
  /** First byte of the reserved region (== the module's `__memory_base`). */
  base: number;
  /** Total reserved bytes (static/BSS footprint plus the shadow stack). */
  bytes: number;
}

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

/**
 * Process-worker ownership fence emitted only after worker-main has returned
 * and can no longer access its Shared WebAssembly.Memory.
 */
export interface WorkerMemoryQuiescentMessage {
  type: "memory_quiescent";
  pid: number;
  tid?: number;
}

/** Internal acknowledgement that an exec-discarded process Worker unwound. */
export interface WorkerExecRetiredMessage {
  type: "exec_retired";
  pid: number;
  tid?: number;
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

export interface VmInterruptTimerMessage {
  type: "vm_interrupt_timer";
  pid: number;
  timedOutPtr: number;
  vmInterruptPtr: number;
  seconds: number;
}

export interface ExecReplyMessage {
  type: "exec_reply";
  wasmBytes: ArrayBuffer;
  programBytes?: ArrayBuffer;
}
