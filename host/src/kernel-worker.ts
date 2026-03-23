/**
 * CentralizedKernelWorker — Manages a single kernel Wasm instance that
 * services syscalls from multiple process workers via channel IPC.
 *
 * Architecture:
 *   - One kernel Wasm instance with its own Memory
 *   - Multiple process workers, each with their own shared Memory
 *   - Each thread (including main thread) in each process has a channel
 *     region in the process's Memory
 *   - JS event loop polls channels via Atomics.waitAsync
 *   - On syscall: copy args from process Memory → kernel scratch,
 *     call kernel_handle_channel, copy result back, notify process
 *
 * Channel layout in process Memory (matches wasm_posix_shared::channel):
 *   Offset  Size  Field
 *   0       4B    status (IDLE=0, PENDING=1, COMPLETE=2, ERROR=3)
 *   4       4B    syscall number
 *   8       24B   arguments (6 x i32)
 *   32      4B    return value
 *   36      4B    errno
 *   40      64KB  data transfer buffer
 */

import { WasmPosixKernel } from "./kernel";
import type { KernelConfig, PlatformIO } from "./types";

/** Channel status values */
const CH_IDLE = 0;
const CH_PENDING = 1;
const CH_COMPLETE = 2;

/** Errno values */
const EAGAIN = 11;
const ETIMEDOUT = 110;

/** Syscall numbers for sleep/delay */
const SYS_NANOSLEEP = 41;
const SYS_USLEEP = 68;
const SYS_CLOCK_NANOSLEEP = 124;
const SYS_FUTEX = 200;
const SYS_POLL = 60;

/** Syscall numbers for fork/exec/clone */
const SYS_EXECVE = 211;
const SYS_FORK = 212;
const SYS_VFORK = 213;
const SYS_CLONE = 201;
const SYS_EXIT = 34;
const SYS_EXIT_GROUP = 34;  // same as SYS_EXIT on wasm32posix (__NR_exit_group = __NR_exit)

/** Syscall numbers for memory management */
const SYS_MMAP = 46;
const SYS_BRK = 48;
const SYS_MREMAP = 126;

/** Syscall numbers for scatter/gather I/O */
const SYS_WRITEV = 81;
const SYS_READV = 82;
const SYS_PREADV = 295;
const SYS_PWRITEV = 296;

/** fcntl commands that take a struct flock pointer */
const SYS_FCNTL = 10;
const F_GETLK = 5;
const F_SETLK = 6;
const F_SETLKW = 7;
const F_GETLK64 = 12;
const F_SETLK64 = 13;
const F_SETLKW64 = 14;

/** Retry interval for EAGAIN polling (ms) */
const EAGAIN_RETRY_MS = 1;

/** Channel layout offsets */
const CH_STATUS = 0;
const CH_SYSCALL = 4;
const CH_ARGS = 8;
const CH_ARGS_COUNT = 6;
const CH_RETURN = 32;
const CH_ERRNO = 36;
const CH_DATA = 40;
const CH_DATA_SIZE = 65536;
const CH_TOTAL_SIZE = CH_DATA + CH_DATA_SIZE;

// Signal delivery area — last 32 bytes of data buffer.
// Written by kernel_dequeue_signal, read by glue channel_syscall.c.
const CH_SIG_BASE = CH_DATA + CH_DATA_SIZE - 32;
const CH_SIG_SIGNUM = CH_SIG_BASE;         // u32: signal number (0 = none)
const CH_SIG_HANDLER = CH_SIG_BASE + 4;    // u32: function table index
const CH_SIG_FLAGS = CH_SIG_BASE + 8;      // u32: sa_flags
const CH_SIG_OLD_MASK = CH_SIG_BASE + 16;  // u64: saved blocked mask

/** Scratch area layout in kernel Memory for kernel_handle_channel.
 * Same as channel layout but used as the kernel-side buffer. */
const SCRATCH_SIZE = CH_TOTAL_SIZE;

/** Struct sizes for output data copying */
const WASM_STAT_SIZE = 88;
const TIMESPEC_SIZE = 16; // { i64 tv_sec, i32 tv_nsec, i32 pad } on wasm32
const ITIMERVAL_SIZE = 32; // 2 x struct timeval { i64 tv_sec, i64 tv_usec }
const RLIMIT_SIZE = 16;   // 2 x i64 on wasm32
const STACK_T_SIZE = 12;  // stack_t: { void* ss_sp, int ss_flags, size_t ss_size } on wasm32

// -----------------------------------------------------------------------
// Arg descriptor system for pointer redirection
//
// For each syscall that has pointer arguments, we describe which args
// are pointers, their direction (in/out/inout), and how to determine
// the data size (null-terminated string, fixed size, or specified by
// another arg).
// -----------------------------------------------------------------------

type SizeSpec =
  | { type: "cstring" }           // null-terminated string
  | { type: "arg"; argIndex: number } // size given by another arg
  | { type: "fixed"; size: number };  // fixed-size struct

interface ArgDesc {
  argIndex: number;
  direction: "in" | "out" | "inout";
  size: SizeSpec;
}

/** Per-syscall pointer arg descriptors.
 * Only syscalls with pointer args need entries here. */
const SYSCALL_ARGS: Record<number, ArgDesc[]> = {
  // File operations
  1:  [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],     // OPEN: path
  3:  [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // READ: buf
  4:  [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // WRITE: buf
  6:  [{ argIndex: 1, direction: "out", size: { type: "fixed", size: WASM_STAT_SIZE } }], // FSTAT: stat_buf
  64: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // PREAD: buf
  65: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // PWRITE: buf

  // _llseek
  119: [{ argIndex: 3, direction: "out", size: { type: "fixed", size: 8 } }],  // _LLSEEK: result_ptr (off_t)

  // FD operations
  9:  [{ argIndex: 0, direction: "out", size: { type: "fixed", size: 8 } }],   // PIPE: 2 x i32
  78: [{ argIndex: 0, direction: "out", size: { type: "fixed", size: 8 } }],   // PIPE2: 2 x i32

  // Stat
  11: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // STAT: path
    { argIndex: 1, direction: "out", size: { type: "fixed", size: WASM_STAT_SIZE } },
  ],
  12: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // LSTAT: path
    { argIndex: 1, direction: "out", size: { type: "fixed", size: WASM_STAT_SIZE } },
  ],
  93: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // FSTATAT: path
    { argIndex: 2, direction: "out", size: { type: "fixed", size: WASM_STAT_SIZE } },
  ],

  // Directory operations
  13: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // MKDIR: path
  14: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // RMDIR: path
  15: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // UNLINK: path
  16: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // RENAME: old
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               //         new
  ],
  17: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // LINK: old
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               //       new
  ],
  18: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // SYMLINK: target
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               //          linkpath
  ],
  19: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // READLINK: path
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     //           buf
  ],
  20: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // CHMOD: path
  21: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // CHOWN: path
  22: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // ACCESS: path
  23: [{ argIndex: 0, direction: "out", size: { type: "arg", argIndex: 1 } }], // GETCWD: buf
  24: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // CHDIR: path
  25: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // OPENDIR: path
  26: [
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 16 } },      // READDIR: dirent
    { argIndex: 2, direction: "out", size: { type: "arg", argIndex: 3 } },     //          name_buf
  ],
  122: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // GETDENTS64: buf

  // Signals
  36: [
    { argIndex: 1, direction: "in", size: { type: "fixed", size: 16 } },       // SIGACTION: act
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 16 } },      //            oldact
  ],
  37: [
    { argIndex: 1, direction: "in", size: { type: "fixed", size: 8 } },       // SIGPROCMASK: set
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 8 } },      //              oldset
  ],
  110: [{ argIndex: 0, direction: "in", size: { type: "fixed", size: 8 } }],  // SIGSUSPEND: mask

  // Time
  40: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_GETTIME
  41: [{ argIndex: 0, direction: "in", size: { type: "fixed", size: TIMESPEC_SIZE } }],  // NANOSLEEP
  123: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_GETRES
  124: [{ argIndex: 2, direction: "in", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_NANOSLEEP

  // UTIMENSAT: (dirfd, path, times, flags)
  125: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },
    { argIndex: 2, direction: "in", size: { type: "fixed", size: TIMESPEC_SIZE * 2 } },
  ],

  250: [
    { argIndex: 2, direction: "in", size: { type: "fixed", size: 16 } },      // PRLIMIT64: new_rlim
    { argIndex: 3, direction: "out", size: { type: "fixed", size: 16 } },     //            old_rlim
  ],

  // Environment
  43: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // GETENV: name
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     //         buf
  ],
  44: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // SETENV: name
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               //         value
  ],
  45: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // UNSETENV: name

  75: [{ argIndex: 0, direction: "out", size: { type: "arg", argIndex: 1 } }], // UNAME: buf
  120: [{ argIndex: 0, direction: "out", size: { type: "arg", argIndex: 1 } }], // GETRANDOM: buf
  109: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // REALPATH: path
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     //           buf
  ],

  // Scheduling
  230: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: 36 } }],  // SCHED_GETPARAM: param (36-byte struct)
  236: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: 16 } }],  // SCHED_RR_GET_INTERVAL: timespec (16 bytes)

  // Signals
  206: [{ argIndex: 0, direction: "out", size: { type: "fixed", size: 8 } }],   // RT_SIGPENDING: set
  207: [                                                                         // RT_SIGTIMEDWAIT: (mask, info, timeout)
    { argIndex: 0, direction: "in", size: { type: "fixed", size: 8 } },          //   mask (sigset_t, 8 bytes)
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 128 } },       //   info (siginfo_t, 128 bytes)
    { argIndex: 2, direction: "in", size: { type: "fixed", size: 16 } },         //   timeout (timespec, 16 bytes)
  ],
  209: [                                                                        // SIGALTSTACK: ss + oss
    { argIndex: 0, direction: "in", size: { type: "fixed", size: STACK_T_SIZE } },   // ss (input)
    { argIndex: 1, direction: "out", size: { type: "fixed", size: STACK_T_SIZE } },  // oss (output)
  ],

  // Sockets
  51: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // BIND: addr
  53: [                                                                         // ACCEPT: addr + addrlen
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },
    { argIndex: 2, direction: "inout", size: { type: "fixed", size: 4 } },
  ],
  54: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // CONNECT: addr
  59: [{ argIndex: 3, direction: "in", size: { type: "arg", argIndex: 4 } }],  // SETSOCKOPT: optval
  114: [                                                                        // GETSOCKNAME: addr + addrlen
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     //   addr (output, size from addrlen)
    { argIndex: 2, direction: "inout", size: { type: "fixed", size: 4 } },     //   addrlen (inout, socklen_t = 4 bytes)
  ],
  115: [                                                                        // GETPEERNAME: addr + addrlen
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },
    { argIndex: 2, direction: "inout", size: { type: "fixed", size: 4 } },
  ],
  55: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // SEND: buf
  56: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // RECV: buf
  58: [{ argIndex: 3, direction: "out", size: { type: "fixed", size: 4 } }],   // GETSOCKOPT: val
  61: [{ argIndex: 3, direction: "out", size: { type: "fixed", size: 8 } }],   // SOCKETPAIR: sv

  140: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // GETADDRINFO: name
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 256 } },     //              result_buf
  ],
  137: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }], // SENDMSG: msg
  138: [{ argIndex: 1, direction: "inout", size: { type: "arg", argIndex: 2 } }], // RECVMSG: msg
  62: [
    { argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } },      // SENDTO: buf
    { argIndex: 4, direction: "in", size: { type: "arg", argIndex: 5 } },      //         dest_addr
  ],
  63: [
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     // RECVFROM: buf
    { argIndex: 4, direction: "out", size: { type: "arg", argIndex: 5 } },     //           src_addr
  ],

  // Poll/select
  60: [{ argIndex: 0, direction: "inout", size: { type: "arg", argIndex: 1 } }], // POLL: fds (nfds * 8)

  // Terminal
  70: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: 256 } }], // TCGETATTR
  71: [{ argIndex: 2, direction: "in", size: { type: "fixed", size: 256 } }],  // TCSETATTR
  72: [{ argIndex: 2, direction: "inout", size: { type: "fixed", size: 256 } }], // IOCTL

  // File system
  85: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // TRUNCATE: path
  129: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // STATFS: path
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 72 } },      //         buf (WasmStatfs = 72 bytes)
  ],
  130: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: 72 } }], // FSTATFS: buf (WasmStatfs = 72 bytes)

  // *at variants
  69: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // OPENAT: path
  94: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // UNLINKAT: path
  95: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // MKDIRAT: path
  96: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // RENAMEAT: oldpath
    { argIndex: 3, direction: "in", size: { type: "cstring" } },               //           newpath
  ],
  97: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // FACCESSAT: path
  98: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // FCHMODAT: path
  99: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // FCHOWNAT: path
  100: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // LINKAT: oldpath
    { argIndex: 3, direction: "in", size: { type: "cstring" } },               //         newpath
  ],
  101: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // SYMLINKAT: target
    { argIndex: 2, direction: "in", size: { type: "cstring" } },               //            linkpath
  ],
  102: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // READLINKAT: path
    { argIndex: 3, direction: "out", size: { type: "arg", argIndex: 4 } },     //             buf
  ],

  // Resource limits
  83: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: RLIMIT_SIZE } }],  // GETRLIMIT
  84: [{ argIndex: 1, direction: "in", size: { type: "fixed", size: RLIMIT_SIZE } }],   // SETRLIMIT

  108: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // GETRUSAGE: buf
  132: [
    { argIndex: 0, direction: "out", size: { type: "fixed", size: 4 } },       // GETRESUID
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 4 } },
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 4 } },
  ],
  134: [
    { argIndex: 0, direction: "out", size: { type: "fixed", size: 4 } },       // GETRESGID
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 4 } },
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 4 } },
  ],

  // Wait
  139: [
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 4 } },       // WAIT4: wstatus
    { argIndex: 3, direction: "out", size: { type: "fixed", size: 32 } },      //        rusage
  ],

  // Exec
  211: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],          // EXECVE: path

  // Timer
  225: [
    { argIndex: 1, direction: "in", size: { type: "fixed", size: ITIMERVAL_SIZE } },   // SETITIMER: new
    { argIndex: 2, direction: "out", size: { type: "fixed", size: ITIMERVAL_SIZE } },  //            old
  ],
  224: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: ITIMERVAL_SIZE } }], // GETITIMER

  // statx
  260: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // STATX: path
    { argIndex: 3, direction: "out", size: { type: "fixed", size: 256 } },     //        statxbuf
  ],
};

// Also need a way to compute poll size: nfds * sizeof(struct pollfd) = nfds * 8
// This is handled as a special case in the size computation.

/** Info about a registered thread channel. */
interface ChannelInfo {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
  /** Int32Array view for Atomics operations */
  i32View: Int32Array;
}

/** Info about a registered process. */
interface ProcessRegistration {
  pid: number;
  memory: WebAssembly.Memory;
  channels: ChannelInfo[];
}

/** Callbacks for fork/exec/exit handling in centralized mode. */
export interface CentralizedKernelCallbacks {
  /**
   * Called when a process forks. The kernel has already cloned the Process
   * in its ProcessTable. The callback should spawn a child Worker with
   * a copy of the parent's Memory and register it with the kernel.
   * Returns the channel offsets allocated for the child.
   */
  onFork?: (parentPid: number, childPid: number, parentMemory: WebAssembly.Memory) => Promise<number[]>;

  /**
   * Called when a process calls execve. The callback should resolve the
   * program path and reinitialize the Worker with the new binary.
   * Returns 0 on success, negative errno on error.
   */
  onExec?: (pid: number, path: string) => Promise<number>;

  /**
   * Called when a process calls clone (thread creation). The callback should
   * spawn a thread Worker sharing the parent's Memory. Returns the TID.
   */
  onClone?: (pid: number, tid: number, fnPtr: number, argPtr: number, stackPtr: number, tlsPtr: number, ctidPtr: number, memory: WebAssembly.Memory) => Promise<number>;

  /**
   * Called when a process exits.
   */
  onExit?: (pid: number, exitStatus: number) => void;
}

export class CentralizedKernelWorker {
  private kernel: WasmPosixKernel;
  private kernelInstance: WebAssembly.Instance | null = null;
  private kernelMemory: WebAssembly.Memory | null = null;
  private processes = new Map<number, ProcessRegistration>();
  private activeChannels: ChannelInfo[] = [];
  private scratchOffset = 0;
  private initialized = false;
  private nextChildPid = 100;
  /** Maps "pid:channelOffset" to TID for tracking thread channels */
  private channelTids = new Map<string, number>();
  /** Maps "pid:tid" to ctidPtr for CLONE_CHILD_CLEARTID on thread exit */
  private threadCtidPtrs = new Map<string, number>();

  constructor(
    private config: KernelConfig,
    private io: PlatformIO,
    private callbacks: CentralizedKernelCallbacks = {},
  ) {
    this.kernel = new WasmPosixKernel(config, io, {
      // In centralized mode, callbacks like onKill/onFork are handled
      // differently — the kernel returns EAGAIN and JS handles them.
      // For now, provide no-op callbacks.
    });
  }

  /**
   * Initialize the centralized kernel.
   * Loads kernel Wasm, sets mode to centralized (1).
   */
  async init(kernelWasmBytes: BufferSource): Promise<void> {
    await this.kernel.init(kernelWasmBytes);
    this.kernelInstance = this.kernel.getInstance()!;
    this.kernelMemory = this.kernel.getMemory()!;

    // Set centralized mode
    const setMode = this.kernelInstance.exports.kernel_set_mode as (mode: number) => void;
    setMode(1);

    // Allocate scratch area in kernel memory by growing it.
    // We can't use the existing memory — kernel globals (KERNEL_MODE,
    // PROCESS_TABLE, etc.) live in the upper region and would be
    // overwritten. Growing the memory gives us fresh pages that don't
    // overlap with anything.
    const prevPages = this.kernelMemory.grow(2); // 2 pages = 128KB > SCRATCH_SIZE
    this.scratchOffset = prevPages * 65536;
    // Ensure scratch area is zeroed
    new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, SCRATCH_SIZE).fill(0);

    this.initialized = true;
  }

  /**
   * Register a process and its thread channels with the kernel.
   * Each channel is a region in the process's shared Memory.
   */
  registerProcess(
    pid: number,
    memory: WebAssembly.Memory,
    channelOffsets: number[],
    options?: { skipKernelCreate?: boolean },
  ): void {
    if (!this.initialized) throw new Error("Kernel not initialized");

    // Create process in kernel's process table (skip if already created, e.g. by fork)
    if (!options?.skipKernelCreate) {
      const createProcess = this.kernelInstance!.exports.kernel_create_process as (pid: number) => number;
      const result = createProcess(pid);
      if (result < 0) {
        throw new Error(`Failed to create process ${pid}: errno ${-result}`);
      }
    }

    const channels: ChannelInfo[] = channelOffsets.map((offset) => ({
      pid,
      memory,
      channelOffset: offset,
      i32View: new Int32Array(memory.buffer, offset),
    }));

    const registration: ProcessRegistration = { pid, memory, channels };
    this.processes.set(pid, registration);
    this.activeChannels.push(...channels);

    // Start listening on each channel
    for (const channel of channels) {
      this.listenOnChannel(channel);
    }
  }

  /**
   * Unregister a process. Stops listening on its channels and removes
   * it from the kernel's process table.
   */
  unregisterProcess(pid: number): void {
    const registration = this.processes.get(pid);
    if (!registration) return;

    // Remove channels from active list
    this.activeChannels = this.activeChannels.filter((ch) => ch.pid !== pid);

    // Remove from kernel process table
    const removeProcess = this.kernelInstance!.exports.kernel_remove_process as (pid: number) => number;
    removeProcess(pid);

    this.processes.delete(pid);
  }

  /**
   * Add a new channel (e.g. for a thread) to an existing process registration.
   * Uses the process's existing memory. If tid is provided, tracks the mapping
   * so handleExit can identify thread exits.
   */
  addChannel(pid: number, channelOffset: number, tid?: number): void {
    const registration = this.processes.get(pid);
    if (!registration) throw new Error(`Process ${pid} not registered`);

    const channel: ChannelInfo = {
      pid,
      memory: registration.memory,
      channelOffset,
      i32View: new Int32Array(registration.memory.buffer, channelOffset),
    };

    registration.channels.push(channel);
    this.activeChannels.push(channel);

    if (tid !== undefined) {
      this.channelTids.set(`${pid}:${channelOffset}`, tid);
    }

    this.listenOnChannel(channel);
  }

  /**
   * Remove a channel from a process registration (e.g. when a thread exits).
   */
  removeChannel(pid: number, channelOffset: number): void {
    const registration = this.processes.get(pid);
    if (!registration) return;

    registration.channels = registration.channels.filter(
      (ch) => ch.channelOffset !== channelOffset,
    );
    this.activeChannels = this.activeChannels.filter(
      (ch) => !(ch.pid === pid && ch.channelOffset === channelOffset),
    );
    this.channelTids.delete(`${pid}:${channelOffset}`);
  }

  /**
   * Listen for a syscall on a channel using Atomics.waitAsync.
   * When the process sets status to PENDING, we handle the syscall.
   */
  private listenOnChannel(channel: ChannelInfo): void {
    // Re-create Int32Array view in case memory was grown
    const i32View = new Int32Array(channel.memory.buffer, channel.channelOffset);
    channel.i32View = i32View;

    const statusIndex = CH_STATUS / 4;

    // Check if already pending (process might have sent before we started listening)
    const currentStatus = Atomics.load(i32View, statusIndex);
    if (currentStatus === CH_PENDING) {
      // Handle immediately
      this.handleSyscall(channel);
      return;
    }

    // Wait for status to change from its current value.
    // After a syscall completes, the process resets status COMPLETE→IDLE,
    // then on its next syscall sets IDLE→PENDING. We need to handle all
    // transitions, not just IDLE→PENDING.
    const waitResult = Atomics.waitAsync(i32View, statusIndex, currentStatus);

    if (waitResult.async) {
      waitResult.value.then(() => {
        // Check if still registered
        if (!this.processes.has(channel.pid)) return;
        // Status changed — re-enter to check new value
        this.listenOnChannel(channel);
      });
    } else {
      // Synchronous result — status already changed from what we expected
      // Re-check on next tick to avoid stack overflow from tight loops
      queueMicrotask(() => this.listenOnChannel(channel));
    }
  }

  /**
   * Handle a pending syscall from a process channel.
   *
   * 1. Read syscall number + args from process Memory
   * 2. For each pointer arg: copy data from process Memory to kernel scratch
   * 3. Write adjusted args to kernel scratch channel header
   * 4. Call kernel_handle_channel(scratchOffset, pid)
   * 5. For each output pointer arg: copy data from kernel scratch to process Memory
   * 6. Write return value + errno to process channel
   * 7. Set status to COMPLETE and notify process
   * 8. Re-listen for next syscall
   */
  private handleSyscall(channel: ChannelInfo): void {
    const processView = new DataView(channel.memory.buffer, channel.channelOffset);

    // Read syscall number and args from process channel
    const syscallNr = processView.getUint32(CH_SYSCALL, true);
    const origArgs: number[] = [];
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      origArgs.push(processView.getInt32(CH_ARGS + i * 4, true));
    }


    // --- Intercept fork/exec/clone/exit before calling kernel ---
    // These syscalls need special async handling that can't go through
    // the blocking host_fork/host_exec imports.

    if (syscallNr === SYS_FORK || syscallNr === SYS_VFORK) {
      this.handleFork(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_EXECVE) {
      this.handleExec(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_CLONE) {
      this.handleClone(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_EXIT || syscallNr === SYS_EXIT_GROUP) {
      this.handleExit(channel, syscallNr, origArgs);
      return;
    }

    // --- Futex: must operate on process memory, not kernel memory ---
    // The kernel's host_futex_wake/wait imports use kernel memory, but in
    // centralized mode the futex address is in process memory. Intercept
    // here and handle directly.
    if (syscallNr === SYS_FUTEX) {
      this.handleFutex(channel, origArgs);
      return;
    }

    // --- Scatter/gather I/O (writev/readv/pwritev/preadv) ---
    // These have nested pointers (iov array → base buffers) that can't be
    // handled by the simple ArgDesc system.
    if (syscallNr === SYS_WRITEV || syscallNr === SYS_PWRITEV) {
      this.handleWritev(channel, syscallNr, origArgs);
      return;
    }

    if (syscallNr === SYS_READV || syscallNr === SYS_PREADV) {
      this.handleReadv(channel, syscallNr, origArgs);
      return;
    }

    // --- fcntl with struct flock pointer ---
    // When cmd is a lock operation, arg3 is a pointer to struct flock (32 bytes).
    // Handle as inout so the kernel can read/write the flock struct.
    if (syscallNr === SYS_FCNTL) {
      const cmd = origArgs[1];
      if (cmd === F_GETLK || cmd === F_SETLK || cmd === F_SETLKW ||
          cmd === F_GETLK64 || cmd === F_SETLK64 || cmd === F_SETLKW64) {
        this.handleFcntlLock(channel, origArgs);
        return;
      }
    }

    // --- Normal syscall path ---
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);

    // Copy raw args to kernel scratch header (will be adjusted below)
    const adjustedArgs = [...origArgs];

    // Process pointer args: copy data between process and kernel memory
    const argDescs = SYSCALL_ARGS[syscallNr];
    let dataOffset = 0; // Offset within scratch data area for allocations

    if (argDescs) {
      // Re-create typed views (memory may have grown)
      const processMem = new Uint8Array(channel.memory.buffer);
      const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
      const dataStart = this.scratchOffset + CH_DATA;

      for (const desc of argDescs) {
        const ptr = origArgs[desc.argIndex];
        if (ptr === 0) continue; // null pointer, skip

        // Compute size of data to copy
        let size: number;
        if (desc.size.type === "cstring") {
          // Read null-terminated string length from process memory
          let len = 0;
          while (processMem[ptr + len] !== 0 && len < CH_DATA_SIZE - dataOffset - 1) {
            len++;
          }
          size = len + 1; // include null terminator
        } else if (desc.size.type === "arg") {
          size = origArgs[desc.size.argIndex];
          // Special case for poll: nfds * sizeof(struct pollfd)
          if (syscallNr === 60) size *= 8;
        } else {
          size = desc.size.size;
        }

        if (size <= 0 || dataOffset + size > CH_DATA_SIZE) continue;

        const kernelPtr = dataStart + dataOffset;

        // Copy input data from process to kernel
        if (desc.direction === "in" || desc.direction === "inout") {
          kernelMem.set(processMem.subarray(ptr, ptr + size), kernelPtr);
        } else {
          // Output-only: zero the kernel scratch area
          kernelMem.fill(0, kernelPtr, kernelPtr + size);
        }

        // Update arg to point to kernel memory
        adjustedArgs[desc.argIndex] = kernelPtr;

        dataOffset += size;
        // Align to 4 bytes for next allocation
        dataOffset = (dataOffset + 3) & ~3;
      }
    }

    // Write adjusted args to kernel scratch
    kernelView.setUint32(CH_SYSCALL, syscallNr, true);
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      kernelView.setInt32(CH_ARGS + i * 4, adjustedArgs[i], true);
    }

    // Call kernel_handle_channel
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: number, pid: number) => number;
    try {
      handleChannel(this.scratchOffset, channel.pid);
    } catch (err) {
      // If the kernel throws (e.g., invalid memory access), complete the
      // channel with -EIO to unblock the process rather than deadlocking.
      console.error(`[handleSyscall] kernel threw for pid=${channel.pid} syscall=${syscallNr}: ${err}`);
      this.completeChannelRaw(channel, -5, 5); // -EIO
      if (this.processes.has(channel.pid)) {
        queueMicrotask(() => this.listenOnChannel(channel));
      }
      return;
    }

    // Read return value and errno from kernel scratch
    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // --- Process memory growth for brk/mmap/mremap ---
    // In centralized mode, the kernel's ensure_memory_covers() grows the
    // KERNEL's Wasm memory, not the process's. We must grow the process's
    // WebAssembly.Memory here so the process can access the new addresses.
    if (retVal > 0) {
      this.ensureProcessMemoryCovers(channel.memory, syscallNr, retVal, origArgs);
    }

    // --- Signal delivery (centralized mode) ---
    // After each syscall, check if the kernel has a pending Handler signal.
    // If so, dequeue it and write delivery info to the process channel.
    // The glue code (channel_syscall.c) will invoke the handler after waking.
    this.dequeueSignalForDelivery(channel);

    // --- Blocking syscall handling ---

    // 1. EAGAIN: kernel returned EAGAIN for a blocking syscall.
    //    Schedule async retry — the process stays blocked on Atomics.wait.
    if (retVal === -1 && errVal === EAGAIN) {
      this.handleBlockingRetry(channel, syscallNr, origArgs);
      return;
    }

    // 2. Sleep syscalls: kernel returned success immediately, but we need
    //    to delay the response to simulate the sleep duration.
    if (this.handleSleepDelay(channel, syscallNr, origArgs, retVal, errVal)) {
      return;
    }

    // --- Normal completion ---
    this.completeChannel(channel, syscallNr, origArgs, argDescs, retVal, errVal);
  }

  /**
   * Dequeue one pending Handler signal from the kernel and write delivery
   * info to the process channel. The glue code (channel_syscall.c) reads
   * this after the syscall returns and invokes the handler.
   */
  private dequeueSignalForDelivery(channel: ChannelInfo): void {
    const dequeueSignal = this.kernelInstance!.exports
      .kernel_dequeue_signal as ((pid: number, outPtr: number) => number) | undefined;
    if (!dequeueSignal) return;

    // Use the signal area in kernel scratch as the output buffer
    const sigOutOffset = this.scratchOffset + CH_SIG_BASE;
    const sigResult = dequeueSignal(channel.pid, sigOutOffset);
    if (sigResult > 0) {
      // Copy 24 bytes of signal delivery info from kernel scratch to process channel
      const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
      const processMem = new Uint8Array(channel.memory.buffer);
      processMem.set(
        kernelMem.subarray(sigOutOffset, sigOutOffset + 24),
        channel.channelOffset + CH_SIG_BASE,
      );
    } else {
      // Clear signal delivery area in process channel
      const processView = new DataView(channel.memory.buffer, channel.channelOffset);
      processView.setUint32(CH_SIG_SIGNUM, 0, true);
    }
  }

  /**
   * Complete a syscall by copying output data and notifying the process.
   */
  private completeChannel(
    channel: ChannelInfo,
    syscallNr: number,
    origArgs: number[],
    argDescs: ArgDesc[] | undefined,
    retVal: number,
    errVal: number,
  ): void {
    const processView = new DataView(channel.memory.buffer, channel.channelOffset);

    // Copy output data from kernel scratch back to process memory
    if (argDescs) {
      const processMem = new Uint8Array(channel.memory.buffer);
      const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
      const dataStart = this.scratchOffset + CH_DATA;
      let outOffset = 0;

      for (const desc of argDescs) {
        const origPtr = origArgs[desc.argIndex];
        if (origPtr === 0) continue;

        // Recompute size (same logic as prepareInputData)
        let size: number;
        if (desc.size.type === "cstring") {
          let len = 0;
          while (processMem[origPtr + len] !== 0 && len < CH_DATA_SIZE - outOffset - 1) {
            len++;
          }
          size = len + 1;
        } else if (desc.size.type === "arg") {
          size = origArgs[desc.size.argIndex];
          if (syscallNr === SYS_POLL) size *= 8;
        } else {
          size = desc.size.size;
        }

        if (size <= 0 || outOffset + size > CH_DATA_SIZE) continue;

        const kernelPtr = dataStart + outOffset;

        // Copy output data from kernel to process
        if (desc.direction === "out" || desc.direction === "inout") {
          let copySize = size;
          if (desc.direction === "out" && desc.size.type === "arg") {
            if (retVal > 0 && retVal < size) {
              copySize = retVal;
            }
          }
          processMem.set(
            kernelMem.subarray(kernelPtr, kernelPtr + copySize),
            origPtr,
          );
        }

        outOffset += size;
        outOffset = (outOffset + 3) & ~3;
      }
    }

    // Write result to process channel
    processView.setInt32(CH_RETURN, retVal, true);
    processView.setUint32(CH_ERRNO, errVal, true);

    // Set status to COMPLETE and notify process
    const i32View = new Int32Array(channel.memory.buffer, channel.channelOffset);
    Atomics.store(i32View, CH_STATUS / 4, CH_COMPLETE);
    Atomics.notify(i32View, CH_STATUS / 4, 1);

    // Re-listen for next syscall
    if (this.processes.has(channel.pid)) {
      queueMicrotask(() => this.listenOnChannel(channel));
    }
  }

  /**
   * Complete a channel with just return value and errno (no scatter/gather).
   * Used for thread exit where we need to unblock the worker.
   */
  private completeChannelRaw(channel: ChannelInfo, retVal: number, errVal: number): void {
    const processView = new DataView(channel.memory.buffer, channel.channelOffset);
    processView.setInt32(CH_RETURN, retVal, true);
    processView.setUint32(CH_ERRNO, errVal, true);

    const i32View = new Int32Array(channel.memory.buffer, channel.channelOffset);
    Atomics.store(i32View, CH_STATUS / 4, CH_COMPLETE);
    Atomics.notify(i32View, CH_STATUS / 4, 1);
    // Don't re-listen — channel is being removed
  }

  /**
   * Handle EAGAIN retry for blocking syscalls.
   * The process stays blocked while we retry asynchronously.
   */
  private handleBlockingRetry(
    channel: ChannelInfo,
    syscallNr: number,
    origArgs: number[],
  ): void {
    if (!this.processes.has(channel.pid)) return;

    // Futex wait: use Atomics.waitAsync on the target address in process memory
    if (syscallNr === SYS_FUTEX) {
      const futexOp = origArgs[1] & 0x7f; // mask out FUTEX_PRIVATE_FLAG
      if (futexOp === 0) { // FUTEX_WAIT
        const addr = origArgs[0]; // address in process memory
        const expectedVal = origArgs[2];
        const i32View = new Int32Array(channel.memory.buffer);
        const index = addr >>> 2; // convert byte offset to i32 index

        // Check if value already changed
        const currentVal = Atomics.load(i32View, index);
        if (currentVal !== expectedVal) {
          // Value changed, retry syscall immediately — kernel should succeed
          this.retrySyscall(channel);
          return;
        }

        // Wait for value to change
        const waitResult = Atomics.waitAsync(i32View, index, expectedVal);
        if (waitResult.async) {
          waitResult.value.then(() => {
            if (this.processes.has(channel.pid)) {
              this.retrySyscall(channel);
            }
          });
        } else {
          // Already changed
          queueMicrotask(() => this.retrySyscall(channel));
        }
        return;
      }
    }

    // Poll with timeout: the kernel did a non-blocking check and returned EAGAIN.
    // We retry after a short delay. If poll has timeout=0 (EAGAIN means no events),
    // we should return 0 immediately instead of retrying.
    if (syscallNr === SYS_POLL) {
      const timeout = origArgs[2]; // timeout in ms
      if (timeout === 0) {
        // Non-blocking poll — return 0 (no events)
        this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], 0, 0);
        return;
      }
      // For timeout > 0, retry after min(timeout, retry_interval)
      const retryMs = timeout > 0 ? Math.min(timeout, EAGAIN_RETRY_MS) : EAGAIN_RETRY_MS;
      setTimeout(() => {
        if (this.processes.has(channel.pid)) {
          this.retrySyscall(channel);
        }
      }, retryMs);
      return;
    }

    // Default: retry after short delay (pipe read/write, socket operations, etc.)
    setTimeout(() => {
      if (this.processes.has(channel.pid)) {
        this.retrySyscall(channel);
      }
    }, EAGAIN_RETRY_MS);
  }

  /**
   * Retry a syscall by re-invoking handleSyscall with the original
   * args still in the process channel.
   */
  private retrySyscall(channel: ChannelInfo): void {
    // The process channel still has the original args (we never wrote a response).
    // Just re-handle it.
    this.handleSyscall(channel);
  }

  /**
   * Handle sleep syscalls where the kernel returns success immediately
   * but we need to delay the channel response.
   * Returns true if this is a sleep syscall that was handled.
   */
  private handleSleepDelay(
    channel: ChannelInfo,
    syscallNr: number,
    origArgs: number[],
    retVal: number,
    errVal: number,
  ): boolean {
    if (syscallNr === SYS_NANOSLEEP && retVal >= 0) {
      // nanosleep: a1 = pointer to timespec {sec, nsec} in kernel scratch
      const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
      const sec = kernelView.getUint32(CH_DATA, true);
      const nsec = kernelView.getUint32(CH_DATA + 4, true);
      const delayMs = sec * 1000 + Math.floor(nsec / 1_000_000);

      if (delayMs > 0) {
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], retVal, errVal);
          }
        }, delayMs);
        return true;
      }
    }

    if (syscallNr === SYS_USLEEP && retVal >= 0) {
      // usleep: a1 = microseconds
      const usec = origArgs[0] >>> 0;
      const delayMs = Math.max(1, Math.floor(usec / 1000));

      if (delayMs > 0) {
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], retVal, errVal);
          }
        }, delayMs);
        return true;
      }
    }

    if (syscallNr === SYS_CLOCK_NANOSLEEP && retVal >= 0) {
      // clock_nanosleep: a3 = pointer to timespec in kernel scratch
      const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
      // The timespec was copied to scratch data at a specific offset.
      // We need to find where it was placed. Since it's arg index 2 (the 3rd arg),
      // and it's the only pointer arg for this syscall, it should be at CH_DATA.
      const sec = kernelView.getUint32(CH_DATA, true);
      const nsec = kernelView.getUint32(CH_DATA + 4, true);
      const delayMs = sec * 1000 + Math.floor(nsec / 1_000_000);

      if (delayMs > 0) {
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], retVal, errVal);
          }
        }, delayMs);
        return true;
      }
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Scatter/gather I/O handling (writev/readv/pwritev/preadv)
  //
  // These syscalls use struct iovec arrays with nested pointers:
  //   struct iovec { void *iov_base; size_t iov_len; }  (8 bytes on wasm32)
  // Both the iov array AND each iov_base buffer must be in kernel memory.
  // -----------------------------------------------------------------------

  /**
   * Handle writev/pwritev: copy iov array and all data buffers from
   * process memory into kernel scratch, then call kernel_handle_channel.
   */
  /**
   * Handle fcntl lock operations (F_GETLK, F_SETLK, F_SETLKW).
   * Arg3 is a pointer to struct flock (32 bytes) which needs copy in/out.
   */
  private handleFcntlLock(channel: ChannelInfo, origArgs: number[]): void {
    const FLOCK_SIZE = 32;
    const flockPtr = origArgs[2];

    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;

    // Copy flock struct from process → kernel scratch
    if (flockPtr !== 0) {
      kernelMem.set(processMem.subarray(flockPtr, flockPtr + FLOCK_SIZE), dataStart);
    }

    // Write syscall header to kernel scratch
    kernelView.setUint32(CH_SYSCALL, SYS_FCNTL, true);
    kernelView.setInt32(CH_ARGS + 0, origArgs[0], true); // fd
    kernelView.setInt32(CH_ARGS + 4, origArgs[1], true); // cmd
    kernelView.setInt32(CH_ARGS + 8, flockPtr !== 0 ? dataStart : 0, true); // flock_ptr in kernel memory
    for (let i = 3; i < CH_ARGS_COUNT; i++) {
      kernelView.setInt32(CH_ARGS + i * 4, origArgs[i], true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    handleChannel(this.scratchOffset, channel.pid);

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // Copy flock struct back from kernel → process (F_GETLK writes to it)
    if (flockPtr !== 0 && retVal >= 0) {
      const freshProcessMem = new Uint8Array(channel.memory.buffer);
      freshProcessMem.set(kernelMem.subarray(dataStart, dataStart + FLOCK_SIZE), flockPtr);
    }

    this.completeChannel(channel, SYS_FCNTL, origArgs, undefined, retVal, errVal);
  }

  private handleWritev(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const fd = origArgs[0];
    const iovPtr = origArgs[1];
    const iovcnt = origArgs[2];

    const processMem = new Uint8Array(channel.memory.buffer);
    const processView = new DataView(channel.memory.buffer);
    const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;

    // Layout in scratch data area:
    //   [0..iovcnt*8]     new iov array with kernel-space base pointers
    //   [iovcnt*8..]      concatenated data buffers
    const iovSize = iovcnt * 8;
    let dataOff = iovSize;

    for (let i = 0; i < iovcnt; i++) {
      const base = processView.getUint32(iovPtr + i * 8, true);
      const len = processView.getUint32(iovPtr + i * 8 + 4, true);

      const kernelBase = dataStart + dataOff;

      // Copy data buffer from process to kernel
      if (len > 0 && dataOff + len <= CH_DATA_SIZE) {
        kernelMem.set(processMem.subarray(base, base + len), kernelBase);
      }

      // Write adjusted iov entry
      const iovAddr = dataStart + i * 8;
      new DataView(kernelMem.buffer).setUint32(iovAddr, kernelBase, true);
      new DataView(kernelMem.buffer).setUint32(iovAddr + 4, len, true);

      dataOff += len;
      dataOff = (dataOff + 3) & ~3; // align
    }

    // Write args to kernel scratch
    kernelView.setUint32(CH_SYSCALL, syscallNr, true);
    kernelView.setInt32(CH_ARGS, fd, true);
    kernelView.setInt32(CH_ARGS + 4, dataStart, true); // adjusted iov ptr
    kernelView.setInt32(CH_ARGS + 8, iovcnt, true);
    if (syscallNr === SYS_PWRITEV) {
      kernelView.setInt32(CH_ARGS + 12, origArgs[3], true); // off_lo
      kernelView.setInt32(CH_ARGS + 16, origArgs[4], true); // off_hi
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    handleChannel(this.scratchOffset, channel.pid);

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    if (retVal === -1 && errVal === EAGAIN) {
      this.handleBlockingRetry(channel, syscallNr, origArgs);
      return;
    }

    this.completeChannel(channel, syscallNr, origArgs, undefined, retVal, errVal);
  }

  /**
   * Handle readv/preadv: set up iov array in kernel scratch, call
   * kernel_handle_channel, then copy read data back to process memory.
   */
  private handleReadv(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const fd = origArgs[0];
    const iovPtr = origArgs[1];
    const iovcnt = origArgs[2];

    const processMem = new Uint8Array(channel.memory.buffer);
    const processView = new DataView(channel.memory.buffer);
    const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;

    // Read iov entries from process memory and build kernel-side copies
    const iovSize = iovcnt * 8;
    let dataOff = iovSize;

    interface IovEntry { base: number; len: number; kernelBase: number }
    const entries: IovEntry[] = [];

    for (let i = 0; i < iovcnt; i++) {
      const base = processView.getUint32(iovPtr + i * 8, true);
      const len = processView.getUint32(iovPtr + i * 8 + 4, true);
      const kernelBase = dataStart + dataOff;

      entries.push({ base, len, kernelBase });

      // Zero the kernel output buffer
      if (len > 0 && dataOff + len <= CH_DATA_SIZE) {
        kernelMem.fill(0, kernelBase, kernelBase + len);
      }

      // Write adjusted iov entry
      const iovAddr = dataStart + i * 8;
      new DataView(kernelMem.buffer).setUint32(iovAddr, kernelBase, true);
      new DataView(kernelMem.buffer).setUint32(iovAddr + 4, len, true);

      dataOff += len;
      dataOff = (dataOff + 3) & ~3;
    }

    // Write args
    kernelView.setUint32(CH_SYSCALL, syscallNr, true);
    kernelView.setInt32(CH_ARGS, fd, true);
    kernelView.setInt32(CH_ARGS + 4, dataStart, true);
    kernelView.setInt32(CH_ARGS + 8, iovcnt, true);
    if (syscallNr === SYS_PREADV) {
      kernelView.setInt32(CH_ARGS + 12, origArgs[3], true);
      kernelView.setInt32(CH_ARGS + 16, origArgs[4], true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    handleChannel(this.scratchOffset, channel.pid);

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    if (retVal === -1 && errVal === EAGAIN) {
      this.handleBlockingRetry(channel, syscallNr, origArgs);
      return;
    }

    // Copy read data from kernel scratch back to process memory
    if (retVal > 0) {
      let remaining = retVal;
      for (const entry of entries) {
        if (remaining <= 0) break;
        const copyLen = Math.min(entry.len, remaining);
        processMem.set(
          kernelMem.subarray(entry.kernelBase, entry.kernelBase + copyLen),
          entry.base,
        );
        remaining -= copyLen;
      }
    }

    this.completeChannel(channel, syscallNr, origArgs, undefined, retVal, errVal);
  }

  // -----------------------------------------------------------------------
  // Fork/exec/clone/exit handling
  // -----------------------------------------------------------------------

  /**
   * Handle SYS_FORK/SYS_VFORK: clone the Process in the kernel's ProcessTable,
   * then call the onFork callback to spawn the child Worker.
   */
  private handleFork(channel: ChannelInfo, _origArgs: number[]): void {
    if (!this.callbacks.onFork) {
      // No fork handler — return -ENOSYS
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, -1, 38);
      return;
    }

    const parentPid = channel.pid;
    const childPid = this.nextChildPid++;

    // Clone the Process in the kernel's ProcessTable
    const kernelForkProcess = this.kernelInstance!.exports.kernel_fork_process as
      (parentPid: number, childPid: number) => number;
    const forkResult = kernelForkProcess(parentPid, childPid);
    if (forkResult < 0) {
      // Fork failed in kernel (e.g., ESRCH, ENOMEM)
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, -1, (-forkResult) >>> 0);
      return;
    }

    // Call the async fork handler to spawn child Worker
    this.callbacks.onFork(parentPid, childPid, channel.memory).then((childChannelOffsets) => {
      if (!this.processes.has(parentPid)) return;

      // Register the child's channels with the kernel worker.
      // The callback should have already created the child's Memory as a copy
      // of the parent's. We need the child's Memory reference.
      // For now, the onFork callback handles registration externally.
      // We just need to complete the parent's channel with the child PID.

      // Complete parent's channel with child PID
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, childPid, 0);
    }).catch(() => {
      // Fork failed — remove child from kernel ProcessTable
      const removeProcess = this.kernelInstance!.exports.kernel_remove_process as
        (pid: number) => number;
      removeProcess(childPid);

      // Return -ENOMEM to parent
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, -1, 12);
    });
  }

  /**
   * Handle SYS_EXECVE: read the path from process memory, call the onExec
   * callback to resolve and load the new program.
   */
  private handleExec(channel: ChannelInfo, origArgs: number[]): void {
    // Read path from process memory (arg 0 is a pointer to null-terminated string)
    const pathPtr = origArgs[0];
    const processMem = new Uint8Array(channel.memory.buffer);
    let pathLen = 0;
    while (processMem[pathPtr + pathLen] !== 0 && pathLen < 4096) {
      pathLen++;
    }
    const path = new TextDecoder().decode(processMem.subarray(pathPtr, pathPtr + pathLen));

    if (!this.callbacks.onExec) {
      // No exec handler — return -ENOSYS
      this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, 38);
      return;
    }

    // Handle exec-related process cleanup in kernel (close CLOEXEC, reset signals)
    const kernelExecSetup = this.kernelInstance!.exports.kernel_exec_setup as
      (pid: number) => number;
    const setupResult = kernelExecSetup(channel.pid);
    if (setupResult < 0) {
      this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, (-setupResult) >>> 0);
      return;
    }

    // Call the async exec handler
    this.callbacks.onExec(channel.pid, path).then((result) => {
      if (!this.processes.has(channel.pid)) return;

      if (result < 0) {
        // Exec failed
        this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, (-result) >>> 0);
      }
      // On success, execve doesn't return — the Worker gets reinitialized
      // with the new program. The channel will be re-registered when the
      // new program starts. Don't complete the channel.
    }).catch(() => {
      this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, 2); // ENOENT
    });
  }

  /**
   * Handle SYS_CLONE: thread creation. Call the onClone callback to spawn
   * a thread Worker sharing the parent's Memory.
   */
  private handleClone(channel: ChannelInfo, origArgs: number[]): void {
    // Channel args from musl's __clone override which calls kernel_clone directly:
    //   kernel_clone(fn_ptr, stack_ptr, flags, arg, ptid_ptr, tls_ptr, ctid_ptr)
    // But in centralized mode, __clone goes through channel_syscall which
    // dispatches SYS_CLONE with Linux syscall convention:
    //   a1=flags, a2=stack, a3=ptid, a4=tls, a5=ctid
    // The kernel dispatch remaps: kernel_clone(0, a2, a1, 0, a3, a4, a5)
    //
    // However, programs using the musl overlay's __clone call kernel_clone
    // directly as a Wasm import, which means they DON'T go through
    // channel_syscall. They use the kernel.kernel_clone import provided
    // by buildThreadKernelStubs or the host kernel. So origArgs here
    // come from the channel in Linux syscall convention:
    //   origArgs[0]=flags, [1]=stack, [2]=ptid, [3]=tls, [4]=ctid

    if (!this.callbacks.onClone) {
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, -1, 38);
      return;
    }

    // Route through kernel_handle_channel — the kernel allocates a TID and
    // stores ThreadInfo. The dispatch table remaps args correctly.
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    kernelView.setUint32(CH_SYSCALL, SYS_CLONE, true);
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      kernelView.setInt32(CH_ARGS + i * 4, origArgs[i], true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    handleChannel(this.scratchOffset, channel.pid);

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    if (retVal < 0) {
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, retVal, errVal);
      return;
    }

    const tid = retVal;

    // CLONE_PARENT_SETTID: write TID to ptid_ptr in process memory.
    // The kernel skips this in centralized mode since ptid_ptr is in
    // process memory, not kernel memory.
    const CLONE_PARENT_SETTID = 0x00100000;
    const flags = origArgs[0];
    const ptidPtr = origArgs[2];
    if (flags & CLONE_PARENT_SETTID && ptidPtr !== 0) {
      const procView = new DataView(channel.memory.buffer);
      procView.setInt32(ptidPtr, tid, true);
    }

    // Read fnPtr and argPtr from the channel's CH_DATA area (written by kernel_clone stub)
    const processView = new DataView(channel.memory.buffer, channel.channelOffset);
    const fnPtr = processView.getUint32(CH_DATA, true);
    const argPtr = processView.getUint32(CH_DATA + 4, true);
    const stackPtr = origArgs[1];
    const tlsPtr = origArgs[3];
    const ctidPtr = origArgs[4];

    this.callbacks.onClone(
      channel.pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, channel.memory,
    ).then((assignedTid) => {
      if (!this.processes.has(channel.pid)) return;
      // Store ctidPtr for CLONE_CHILD_CLEARTID on thread exit
      if (ctidPtr !== 0) {
        this.threadCtidPtrs.set(`${channel.pid}:${assignedTid}`, ctidPtr);
      }
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, assignedTid, 0);
    }).catch((err) => {
      console.error(`[kernel-worker] onClone failed: ${err}`);
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, -1, 12); // ENOMEM
    });
  }

  /**
   * Handle SYS_EXIT/SYS_EXIT_GROUP: notify the kernel and clean up.
   *
   * For SYS_EXIT from a non-main channel (thread exit): notify kernel,
   * remove channel, complete channel to unblock thread worker.
   * For SYS_EXIT from main channel or SYS_EXIT_GROUP: current behavior.
   */
  private handleExit(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const exitStatus = origArgs[0];
    const registration = this.processes.get(channel.pid);

    // Check if this is a thread exit (non-main channel + SYS_EXIT)
    const isMainChannel = registration && registration.channels.length > 0 &&
      registration.channels[0].channelOffset === channel.channelOffset;

    if (syscallNr === SYS_EXIT && !isMainChannel) {
      // Thread exit: find TID, notify kernel, remove channel, complete to unblock
      const tidKey = `${channel.pid}:${channel.channelOffset}`;
      const tid = this.channelTids.get(tidKey) ?? 0;
      if (tid > 0) {
        this.channelTids.delete(tidKey);
      }

      // CLONE_CHILD_CLEARTID: write 0 to ctidPtr and futex-wake it.
      // This is normally done by the Linux kernel on thread exit; we must
      // do it here because the thread worker never returns from __pthread_exit
      // (it loops on SYS_EXIT).
      if (tid > 0) {
        const ctidKey = `${channel.pid}:${tid}`;
        const ctidPtr = this.threadCtidPtrs.get(ctidKey);
        if (ctidPtr && ctidPtr !== 0) {
          this.threadCtidPtrs.delete(ctidKey);
          const procView = new DataView(channel.memory.buffer);
          procView.setInt32(ctidPtr, 0, true);
          const i32View = new Int32Array(channel.memory.buffer);
          Atomics.notify(i32View, ctidPtr >>> 2, 1);
        }
      }

      if (tid > 0) {
        this.notifyThreadExit(channel.pid, tid);
      }
      this.removeChannel(channel.pid, channel.channelOffset);
      // Complete channel to unblock the thread worker so it can exit cleanly
      this.completeChannelRaw(channel, 0, 0);
      return;
    }

    // Main thread exit or exit_group: don't complete channel, let host terminate worker
    if (this.callbacks.onExit) {
      this.callbacks.onExit(channel.pid, exitStatus);
    }
  }

  /**
   * Handle SYS_FUTEX directly on process memory.
   *
   * In centralized mode, the kernel's host_futex_wake/wait imports operate on
   * kernel memory, but futex addresses are in process memory. We bypass the
   * kernel entirely and implement the futex ops here.
   *
   * FUTEX_WAIT: compare-and-block. If the value at addr matches expected,
   * use Atomics.waitAsync to wait for a change, then return 0. If it doesn't
   * match, return -EAGAIN.
   *
   * FUTEX_WAKE: wake up to `val` waiters on addr. Returns number woken.
   */
  private handleFutex(channel: ChannelInfo, origArgs: number[]): void {
    const addr = origArgs[0];     // uaddr (byte offset in process memory)
    const op = origArgs[1];       // futex op (may include PRIVATE flag)
    const val = origArgs[2];      // value (expected for WAIT, count for WAKE)

    const FUTEX_PRIVATE_FLAG = 128;
    const FUTEX_CLOCK_REALTIME = 256;
    const baseOp = op & ~(FUTEX_PRIVATE_FLAG | FUTEX_CLOCK_REALTIME);

    const FUTEX_WAIT = 0;
    const FUTEX_WAKE = 1;
    const FUTEX_REQUEUE = 3;
    const FUTEX_CMP_REQUEUE = 4;
    const FUTEX_WAKE_OP = 5;
    const FUTEX_WAIT_BITSET = 9;
    const FUTEX_WAKE_BITSET = 10;

    const i32View = new Int32Array(channel.memory.buffer);
    const index = addr >>> 2;

    if (baseOp === FUTEX_WAIT || baseOp === FUTEX_WAIT_BITSET) {
      // Compare value at addr with expected
      const currentVal = Atomics.load(i32View, index);
      if (currentVal !== val) {
        // Value already changed — return -EAGAIN (Linux convention)
        this.completeChannelRaw(channel, -EAGAIN, EAGAIN);
        // Re-listen
        if (this.processes.has(channel.pid)) {
          queueMicrotask(() => this.listenOnChannel(channel));
        }
        return;
      }

      // Read timeout from origArgs[3] (pointer to struct timespec in process memory).
      // Layout: { int64 tv_sec; int64 tv_nsec } — 16 bytes, relative timeout.
      let timeoutMs: number | undefined;
      const timeoutPtr = origArgs[3];
      if (timeoutPtr !== 0) {
        const dataView = new DataView(channel.memory.buffer);
        const tv_sec = Number(dataView.getBigInt64(timeoutPtr, true));
        const tv_nsec = Number(dataView.getBigInt64(timeoutPtr + 8, true));
        if (tv_sec < 0 || (tv_sec === 0 && tv_nsec <= 0)) {
          // Already expired
          this.completeChannelRaw(channel, -ETIMEDOUT, ETIMEDOUT);
          if (this.processes.has(channel.pid)) {
            queueMicrotask(() => this.listenOnChannel(channel));
          }
          return;
        }
        timeoutMs = tv_sec * 1000 + Math.ceil(tv_nsec / 1_000_000);
        if (timeoutMs <= 0) timeoutMs = 1; // minimum 1ms
      }

      // Value matches — wait asynchronously for it to change
      const waitResult = Atomics.waitAsync(i32View, index, val);
      if (waitResult.async) {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const complete = (retVal: number, errVal: number) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (!this.processes.has(channel.pid)) return;
          this.completeChannelRaw(channel, retVal, errVal);
          if (this.processes.has(channel.pid)) {
            queueMicrotask(() => this.listenOnChannel(channel));
          }
        };

        waitResult.value.then(() => complete(0, 0));

        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            // Wake ourselves to break out of the Atomics.waitAsync
            Atomics.notify(i32View, index, 1);
            complete(-ETIMEDOUT, ETIMEDOUT);
          }, timeoutMs);
        }
      } else {
        // Already changed — return 0
        this.completeChannelRaw(channel, 0, 0);
        if (this.processes.has(channel.pid)) {
          queueMicrotask(() => this.listenOnChannel(channel));
        }
      }
      return;
    }

    if (baseOp === FUTEX_WAKE || baseOp === FUTEX_WAKE_BITSET) {
      const woken = Atomics.notify(i32View, index, val);
      this.completeChannelRaw(channel, woken, 0);
      if (this.processes.has(channel.pid)) {
        queueMicrotask(() => this.listenOnChannel(channel));
      }
      return;
    }

    if (baseOp === FUTEX_REQUEUE || baseOp === FUTEX_CMP_REQUEUE) {
      // Wake val waiters on uaddr, can't truly requeue with Atomics,
      // so wake val + val2 on uaddr.
      const val2 = origArgs[3]; // timeout param repurposed as val2
      const woken = Atomics.notify(i32View, index, val + val2);
      this.completeChannelRaw(channel, woken, 0);
      if (this.processes.has(channel.pid)) {
        queueMicrotask(() => this.listenOnChannel(channel));
      }
      return;
    }

    if (baseOp === FUTEX_WAKE_OP) {
      // Wake val waiters on uaddr, then conditionally wake val2 on uaddr2.
      // Simplified: just wake both.
      const val2 = origArgs[3];
      const uaddr2 = origArgs[4];
      const index2 = uaddr2 >>> 2;
      let woken = Atomics.notify(i32View, index, val);
      woken += Atomics.notify(i32View, index2, val2);
      this.completeChannelRaw(channel, woken, 0);
      if (this.processes.has(channel.pid)) {
        queueMicrotask(() => this.listenOnChannel(channel));
      }
      return;
    }

    // Unknown futex op — return -ENOSYS
    this.completeChannelRaw(channel, -38, 38);
    if (this.processes.has(channel.pid)) {
      queueMicrotask(() => this.listenOnChannel(channel));
    }
  }

  /**
   * Notify the kernel that a thread has exited.
   * Removes thread state from the process's thread table.
   */
  notifyThreadExit(pid: number, tid: number): void {
    if (!this.kernelInstance) return;
    const threadExit = this.kernelInstance.exports.kernel_thread_exit as
      ((pid: number, tid: number) => number) | undefined;
    if (threadExit) {
      threadExit(pid, tid);
    }
  }

  // -----------------------------------------------------------------------
  // Process memory management
  //
  // In centralized mode, the kernel's ensure_memory_covers() grows the
  // KERNEL's Wasm memory (memory index 0 in the kernel module). But the
  // process runs in a different WebAssembly.Memory. After brk/mmap/mremap
  // syscalls, we must grow the process's memory to cover the returned
  // addresses — otherwise the process gets "memory access out of bounds".
  // -----------------------------------------------------------------------

  private ensureProcessMemoryCovers(
    processMemory: WebAssembly.Memory,
    syscallNr: number,
    retVal: number,
    origArgs: number[],
  ): void {
    let endAddr = 0;

    if (syscallNr === SYS_BRK) {
      // retVal is the new program break address
      endAddr = retVal >>> 0;
    } else if (syscallNr === SYS_MMAP) {
      // retVal is the mapped address, origArgs[1] is the length
      const MAP_FAILED = 0xffffffff;
      if ((retVal >>> 0) !== MAP_FAILED) {
        endAddr = (retVal >>> 0) + (origArgs[1] >>> 0);
      }
    } else if (syscallNr === SYS_MREMAP) {
      // retVal is the new address, origArgs[2] is the new length
      const MAP_FAILED = 0xffffffff;
      if ((retVal >>> 0) !== MAP_FAILED) {
        endAddr = (retVal >>> 0) + (origArgs[2] >>> 0);
      }
    }

    if (endAddr > 0) {
      const currentBytes = processMemory.buffer.byteLength;
      if (endAddr > currentBytes) {
        const neededPages = Math.ceil((endAddr - currentBytes) / 65536);
        processMemory.grow(neededPages);
      }
    }
  }

  /** Set the next child PID to allocate. */
  setNextChildPid(pid: number): void {
    this.nextChildPid = pid;
  }

  /** Get the underlying kernel instance for direct access. */
  getKernel(): WasmPosixKernel {
    return this.kernel;
  }

  /** Get the kernel Wasm instance. */
  getKernelInstance(): WebAssembly.Instance | null {
    return this.kernelInstance;
  }
}
