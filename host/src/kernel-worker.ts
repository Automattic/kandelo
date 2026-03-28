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
import { SharedLockTable } from "./shared-lock-table";
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
const SYS_PPOLL = 251;
const SYS_PSELECT6 = 252;
const SYS_RT_SIGTIMEDWAIT = 207;

/** Syscall numbers for signals */
const SYS_KILL = 35;

/** Syscall numbers for fork/exec/clone */
const SYS_EXECVE = 211;
const SYS_FORK = 212;
const SYS_VFORK = 213;
const SYS_CLONE = 201;
const SYS_EXIT = 34;
const SYS_EXIT_GROUP = 34;  // same as SYS_EXIT on wasm32posix (__NR_exit_group = __NR_exit)
const SYS_WAIT4 = 139;
const SYS_WAITID = 288;

/** waitpid options */
const WNOHANG = 1;
const WNOWAIT = 0x1000000;
const WEXITED = 4;

/** waitid idtype */
const P_ALL = 0;
const P_PID = 1;
const P_PGID = 2;

/** CLD_* codes for siginfo_t */
const CLD_EXITED = 1;
const CLD_KILLED = 2;

/** SIGCHLD */
const SIGCHLD = 17;
const SIGALRM = 14;

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
const F_OFD_GETLK = 36;
const F_OFD_SETLK = 37;
const F_OFD_SETLKW = 38;

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

// Signal delivery area — last 48 bytes of data buffer.
// Written by kernel_dequeue_signal, read by glue channel_syscall.c.
const CH_SIG_BASE = CH_DATA + CH_DATA_SIZE - 48;
const CH_SIG_SIGNUM = CH_SIG_BASE;         // u32: signal number (0 = none)
const CH_SIG_HANDLER = CH_SIG_BASE + 4;    // u32: function table index
const CH_SIG_FLAGS = CH_SIG_BASE + 8;      // u32: sa_flags
const CH_SIG_SI_VALUE = CH_SIG_BASE + 12;  // i32: si_value.sival_int
const CH_SIG_OLD_MASK = CH_SIG_BASE + 16;  // u64: saved blocked mask
const CH_SIG_SI_CODE = CH_SIG_BASE + 24;   // i32: si_code
const CH_SIG_SI_PID = CH_SIG_BASE + 28;    // u32: si_pid
const CH_SIG_SI_UID = CH_SIG_BASE + 32;    // u32: si_uid

/** Scratch area layout in kernel Memory for kernel_handle_channel.
 * Same as channel layout but used as the kernel-side buffer. */
const SCRATCH_SIZE = CH_TOTAL_SIZE;

/** Struct sizes for output data copying */
const WASM_STAT_SIZE = 88;
const TIMESPEC_SIZE = 16; // { i64 tv_sec, i32 tv_nsec, i32 pad } on wasm32
const ITIMERVAL_SIZE = 16; // musl time64 path: 4 x long (4 bytes each on wasm32)
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
  | { type: "deref"; argIndex: number } // size from u32 value at pointer arg (e.g. socklen_t*)
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
  205: [{ argIndex: 2, direction: "in", size: { type: "fixed", size: 128 } }], // RT_SIGQUEUEINFO: siginfo_t

  // Time
  40: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_GETTIME
  41: [{ argIndex: 0, direction: "in", size: { type: "fixed", size: TIMESPEC_SIZE } }],  // NANOSLEEP
  123: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_GETRES
  124: [{ argIndex: 2, direction: "in", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_NANOSLEEP

  // POSIX timers
  326: [                                                                                 // TIMER_CREATE: (clock_id, sigevent, *timerid)
    { argIndex: 1, direction: "in", size: { type: "fixed", size: 16 } },                 //   ksigevent (16 bytes)
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 4 } },                 //   timerid (i32)
  ],
  327: [                                                                                 // TIMER_SETTIME: (timerid, flags, new, old)
    { argIndex: 2, direction: "in", size: { type: "fixed", size: 32 } },                 //   new itimerspec (4 x i64 = 32 bytes)
    { argIndex: 3, direction: "out", size: { type: "fixed", size: 32 } },                //   old itimerspec (4 x i64 = 32 bytes)
  ],
  328: [                                                                                 // TIMER_GETTIME: (timerid, curr)
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 32 } },                //   curr itimerspec (4 x i64 = 32 bytes)
  ],

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

  75: [{ argIndex: 0, direction: "out", size: { type: "fixed", size: 390 } }], // UNAME: buf (struct utsname = 6x65)
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
    { argIndex: 1, direction: "out", size: { type: "deref", argIndex: 2 } },
    { argIndex: 2, direction: "inout", size: { type: "fixed", size: 4 } },
  ],
  54: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // CONNECT: addr
  59: [{ argIndex: 3, direction: "in", size: { type: "arg", argIndex: 4 } }],  // SETSOCKOPT: optval
  114: [                                                                        // GETSOCKNAME: addr + addrlen
    { argIndex: 1, direction: "out", size: { type: "deref", argIndex: 2 } },   //   addr (output, size from *addrlen)
    { argIndex: 2, direction: "inout", size: { type: "fixed", size: 4 } },     //   addrlen (inout, socklen_t = 4 bytes)
  ],
  115: [                                                                        // GETPEERNAME: addr + addrlen
    { argIndex: 1, direction: "out", size: { type: "deref", argIndex: 2 } },
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
    { argIndex: 4, direction: "out", size: { type: "deref", argIndex: 5 } },   //           src_addr (size from *addrlen)
    { argIndex: 5, direction: "inout", size: { type: "fixed", size: 4 } },     //           addrlen (inout, socklen_t = 4)
  ],

  // Poll/select
  60: [{ argIndex: 0, direction: "inout", size: { type: "arg", argIndex: 1 } }], // POLL: fds (nfds * 8)
  251: [{ argIndex: 0, direction: "inout", size: { type: "arg", argIndex: 1 } }], // PPOLL: fds (nfds * 8)

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

  108: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: 144 } }], // GETRUSAGE: buf (time64 rusage = 18x8)
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
  /** Tracks the pid currently being serviced by kernel_handle_channel */
  private currentHandlePid = 0;
  /** Alarm timers per process: pid → NodeJS.Timeout */
  private alarmTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** POSIX timers: "pid:timerId" → {timeout, interval?, signo} */
  private posixTimers = new Map<string, { timeout: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>; signo: number }>();
  /** Pending sleep timers per process: pid → {timer, channel, syscallNr, origArgs, retVal, errVal} */
  private pendingSleeps = new Map<number, {
    timer: ReturnType<typeof setTimeout>;
    channel: ChannelInfo;
    syscallNr: number;
    origArgs: number[];
    retVal: number;
    errVal: number;
  }>();
  /** Maps "pid:tid" to ctidPtr for CLONE_CHILD_CLEARTID on thread exit */
  private threadCtidPtrs = new Map<string, number>();
  /** TCP listeners: fd → { server, pid, port, connections } */
  private tcpListeners = new Map<number, {
    server: import("net").Server;
    pid: number;
    port: number;
    connections: Set<import("net").Socket>;
  }>();
  /** Separate scratch buffer for TCP data pumping */
  private tcpScratchOffset = 0;
  /** Node.js net module (loaded dynamically for browser compatibility) */
  private netModule: typeof import("net") | null = null;
  /** Parent-child process tracking for waitpid */
  private childToParent = new Map<number, number>();
  private parentToChildren = new Map<number, Set<number>>();
  /** Exit statuses of children not yet wait()-ed for: childPid → waitStatus */
  private exitedChildren = new Map<number, number>();
  /** Deferred waitpid/waitid completions */
  private waitingForChild: Array<{
    parentPid: number;
    channel: ChannelInfo;
    origArgs: number[];
    pid: number;
    options: number;
    syscallNr: number;
  }> = [];
  /** Cached kernel memory typed array view (invalidated on memory.grow) */
  private cachedKernelMem: Uint8Array | null = null;
  private cachedKernelBuffer: ArrayBuffer | null = null;
  /** Pending poll/ppoll retries — used for event-driven wakeup when pipe data arrives */
  private pendingPollRetries = new Map<number, {
    timer: ReturnType<typeof setImmediate> | null;
    channel: ChannelInfo;
    pipeIndices: number[];
  }>();
  /** Active TCP connections per process for piggyback flushing */
  private tcpConnections = new Map<number, Array<{
    sendPipeIdx: number;
    scratchOffset: number;
    clientSocket: import("net").Socket;
    recvPipeIdx: number;
    schedulePump: () => void;
  }>>();

  constructor(
    private config: KernelConfig,
    private io: PlatformIO,
    private callbacks: CentralizedKernelCallbacks = {},
  ) {
    this.kernel = new WasmPosixKernel(config, io, {
      // In centralized mode, callbacks like onKill/onFork are handled
      // differently — the kernel returns EAGAIN and JS handles them.
      onAlarm: (seconds: number): number => {
        const pid = this.currentHandlePid;
        if (pid === 0) return 0;

        // Cancel any existing alarm for this process
        const existing = this.alarmTimers.get(pid);
        if (existing) {
          clearTimeout(existing);
          this.alarmTimers.delete(pid);
        }

        if (seconds > 0) {
          const timer = setTimeout(() => {
            this.alarmTimers.delete(pid);
            if (this.processes.has(pid)) {
              this.sendSignalToProcess(pid, SIGALRM);
            }
          }, seconds * 1000);
          this.alarmTimers.set(pid, timer);
        }
        return 0;
      },
      onNetListen: (fd: number, port: number, addr: [number, number, number, number]): number => {
        const pid = this.currentHandlePid;
        if (pid === 0) return 0;
        this.startTcpListener(pid, fd, port);
        return 0;
      },
      onPosixTimer: (timerId: number, signo: number, valueMs: number, intervalMs: number): number => {
        const pid = this.currentHandlePid;
        if (pid === 0) return 0;
        const key = `${pid}:${timerId}`;

        // Cancel any existing timer for this slot
        const existing = this.posixTimers.get(key);
        if (existing) {
          clearTimeout(existing.timeout);
          if (existing.interval) clearInterval(existing.interval);
          this.posixTimers.delete(key);
        }

        if (valueMs > 0 || intervalMs > 0) {
          // valueMs > 0 means armed (0 = disarm, kernel ensures >= 1ms for armed timers)
          const delay = Math.max(0, valueMs);
          const timeout = setTimeout(() => {
            if (!this.processes.has(pid)) {
              this.posixTimers.delete(key);
              return;
            }
            this.sendSignalToProcess(pid, signo);

            // Set up repeating interval if needed
            if (intervalMs > 0) {
              const iv = setInterval(() => {
                if (!this.processes.has(pid)) {
                  const entry = this.posixTimers.get(key);
                  if (entry?.interval) clearInterval(entry.interval);
                  this.posixTimers.delete(key);
                  return;
                }
                // Check if signal is already pending (overrun) or new cycle
                const intervalFire = this.kernelInstance!.exports
                  .kernel_posix_timer_interval_fire as ((pid: number, timerId: number) => number) | undefined;
                const alreadyPending = intervalFire ? intervalFire(pid, timerId) : 0;
                if (!alreadyPending) {
                  this.sendSignalToProcess(pid, signo);
                }
              }, intervalMs);
              const entry = this.posixTimers.get(key);
              if (entry) entry.interval = iv;
            } else {
              this.posixTimers.delete(key);
            }
          }, delay);
          this.posixTimers.set(key, { timeout, signo });
        }
        return 0;
      },
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

    // Allocate scratch area from the kernel's own heap allocator.
    // IMPORTANT: Do NOT use this.kernelMemory.grow() — the kernel's
    // allocator (dlmalloc) doesn't know about host-grown pages and will
    // reuse them as heap, causing corruption (overlapping writes between
    // scratch data and kernel heap structures like Vec<MappedRegion>).
    const allocScratch = this.kernelInstance.exports.kernel_alloc_scratch as (size: number) => number;
    this.scratchOffset = allocScratch(SCRATCH_SIZE);
    if (this.scratchOffset === 0) {
      throw new Error("Failed to allocate kernel scratch buffer");
    }

    // Try to load Node.js net module for TCP bridging
    try {
      this.netModule = await import("net");
    } catch {
      // Not in Node.js environment — TCP bridging disabled
    }

    // Allocate a separate scratch buffer for TCP data pumping
    this.tcpScratchOffset = allocScratch(65536);
    if (this.tcpScratchOffset === 0) {
      throw new Error("Failed to allocate TCP scratch buffer");
    }

    // Register a SharedLockTable so host_fcntl_lock can handle advisory locks
    // (including OFD locks) within the centralized kernel.
    const lockTable = SharedLockTable.create();
    this.kernel.registerSharedLockTable(lockTable.getBuffer());

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

    // Clean up TCP listeners for this process
    this.cleanupTcpListeners(pid);

    // Clean up pending poll retries
    const pollEntry = this.pendingPollRetries.get(pid);
    if (pollEntry?.timer) clearImmediate(pollEntry.timer);
    this.pendingPollRetries.delete(pid);

    // Remove from kernel process table
    this.removeFromKernelProcessTable(pid);

    this.processes.delete(pid);
  }

  /**
   * Deactivate a process's channels without removing it from the kernel
   * process table. Used for zombie processes that need to remain queryable
   * (getpgid, setpgid) until reaped by wait/waitpid.
   */
  deactivateProcess(pid: number): void {
    this.activeChannels = this.activeChannels.filter((ch) => ch.pid !== pid);
    this.processes.delete(pid);
    // Cancel any pending alarm timer for this process
    const alarmTimer = this.alarmTimers.get(pid);
    if (alarmTimer) {
      clearTimeout(alarmTimer);
      this.alarmTimers.delete(pid);
    }
    // Cancel any pending posix timers for this process
    for (const [key, entry] of this.posixTimers) {
      if (key.startsWith(`${pid}:`)) {
        clearTimeout(entry.timeout);
        if (entry.interval) clearInterval(entry.interval);
        this.posixTimers.delete(key);
      }
    }
    // Cancel any pending sleep timer for this process
    const sleepTimer = this.pendingSleeps.get(pid);
    if (sleepTimer) {
      clearTimeout(sleepTimer.timer);
      this.pendingSleeps.delete(pid);
    }
    // Clean up pending poll retries
    const pollEntry = this.pendingPollRetries.get(pid);
    if (pollEntry?.timer) clearImmediate(pollEntry.timer);
    this.pendingPollRetries.delete(pid);
    // Clean up TCP listeners for this process
    this.cleanupTcpListeners(pid);
  }

  /**
   * Remove a process from the kernel's PROCESS_TABLE.
   * Called when a zombie is reaped by wait/waitpid.
   */
  removeFromKernelProcessTable(pid: number): void {
    const removeProcess = this.kernelInstance!.exports.kernel_remove_process as (pid: number) => number;
    removeProcess(pid);
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
  private getKernelMem(): Uint8Array {
    const buf = this.kernelMemory!.buffer;
    if (buf !== this.cachedKernelBuffer) {
      this.cachedKernelMem = new Uint8Array(buf);
      this.cachedKernelBuffer = buf;
    }
    return this.cachedKernelMem!;
  }

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

    if (syscallNr === SYS_WAIT4) {
      this.handleWaitpid(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_WAITID) {
      this.handleWaitid(channel, origArgs);
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

    // --- sendmsg/recvmsg: decompose msghdr from process memory ---
    if (syscallNr === 137 /* SYS_SENDMSG */) {
      this.handleSendmsg(channel, origArgs);
      return;
    }
    if (syscallNr === 138 /* SYS_RECVMSG */) {
      this.handleRecvmsg(channel, origArgs);
      return;
    }

    // --- fcntl with struct flock pointer ---
    // When cmd is a lock operation, arg3 is a pointer to struct flock (32 bytes).
    // Handle as inout so the kernel can read/write the flock struct.
    if (syscallNr === SYS_FCNTL) {
      const cmd = origArgs[1];
      if (cmd === F_GETLK || cmd === F_SETLK || cmd === F_SETLKW ||
          cmd === F_GETLK64 || cmd === F_SETLK64 || cmd === F_SETLKW64 ||
          cmd === F_OFD_GETLK || cmd === F_OFD_SETLK || cmd === F_OFD_SETLKW) {
        this.handleFcntlLock(channel, origArgs);
        return;
      }
    }

    // --- pselect6: fd_sets (inout) + timeout/sigmask decoding ---
    if (syscallNr === SYS_PSELECT6) {
      this.handlePselect6(channel, origArgs);
      return;
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
      const kernelMem = this.getKernelMem();
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
          if (syscallNr === SYS_POLL || syscallNr === SYS_PPOLL) size *= 8;
        } else if (desc.size.type === "deref") {
          // Dereference: arg is a pointer to a u32 value (e.g. socklen_t*)
          const derefPtr = origArgs[desc.size.argIndex];
          if (derefPtr === 0) continue;
          size = processMem[derefPtr] | (processMem[derefPtr + 1] << 8)
               | (processMem[derefPtr + 2] << 16) | (processMem[derefPtr + 3] << 24);
        } else {
          size = desc.size.size;
        }

        if (size <= 0) continue;

        // Cap size to fit in the channel data buffer. For read/write-like
        // syscalls where the size comes from another arg, also update that
        // arg so the kernel uses the capped count. The caller (musl libc)
        // will see a short read/write and retry for the remainder.
        if (dataOffset + size > CH_DATA_SIZE) {
          size = CH_DATA_SIZE - dataOffset;
          if (size <= 0) continue;
          if (desc.size.type === "arg") {
            adjustedArgs[desc.size.argIndex] = size;
          }
        }

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

    // ppoll: convert timespec pointer and sigset pointer to scalar values.
    // musl sends: (fds, nfds, timespec_ptr, sigset_ptr, sigset_size)
    // kernel expects: (fds, nfds, timeout_ms, has_mask, mask_lo, mask_hi)
    if (syscallNr === SYS_PPOLL) {
      const tsPtr = origArgs[2];
      if (tsPtr !== 0) {
        // time64: timespec is {int64 sec, int64 nsec} = 16 bytes
        const pv = new DataView(channel.memory.buffer, tsPtr);
        const sec = Number(pv.getBigInt64(0, true));
        const nsec = Number(pv.getBigInt64(8, true));
        adjustedArgs[2] = sec * 1000 + Math.floor(nsec / 1000000);
      } else {
        adjustedArgs[2] = -1; // infinite timeout
      }
      const maskPtr = origArgs[3];
      if (maskPtr !== 0) {
        const pv = new DataView(channel.memory.buffer, maskPtr);
        adjustedArgs[3] = 1; // has_mask = true
        adjustedArgs[4] = pv.getUint32(0, true); // mask_lo
        adjustedArgs[5] = pv.getUint32(4, true); // mask_hi
      } else {
        adjustedArgs[3] = 0; // has_mask = false
        adjustedArgs[4] = 0;
        adjustedArgs[5] = 0;
      }
    }

    // Write adjusted args to kernel scratch
    kernelView.setUint32(CH_SYSCALL, syscallNr, true);
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      kernelView.setInt32(CH_ARGS + i * 4, adjustedArgs[i], true);
    }

    // Call kernel_handle_channel
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: number, pid: number) => number;
    this.currentHandlePid = channel.pid;
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
    } finally {
      this.currentHandlePid = 0;
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

    // --- Signal-death check (centralized mode) ---
    // If deliver_pending_signals marked this process as Exited (e.g., abort()
    // raises SIGABRT with default action Terminate), don't complete the channel.
    // Instead, record signal-death wait status and terminate the worker.
    const getExitStatus = this.kernelInstance!.exports
      .kernel_get_process_exit_status as ((pid: number) => number) | undefined;
    if (getExitStatus) {
      const exitStatus = getExitStatus(channel.pid);
      if (exitStatus >= 0) {
        const signum = exitStatus >= 128 ? exitStatus - 128 : 0;
        const waitStatus = signum > 0 ? (signum & 0x7f) : ((exitStatus & 0xff) << 8);
        this.handleProcessTerminated(channel, waitStatus);
        return;
      }
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
      // Copy 36 bytes of signal delivery info from kernel scratch to process channel
      // Layout: signum(4) + handler(4) + flags(4) + si_value(4) + old_mask(8)
      //       + si_code(4) + si_pid(4) + si_uid(4) = 36 bytes
      const kernelMem = this.getKernelMem();
      const processMem = new Uint8Array(channel.memory.buffer);
      processMem.set(
        kernelMem.subarray(sigOutOffset, sigOutOffset + 36),
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
      const kernelMem = this.getKernelMem();
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
          if (syscallNr === SYS_POLL || syscallNr === SYS_PPOLL) size *= 8;
        } else if (desc.size.type === "deref") {
          const derefPtr = origArgs[desc.size.argIndex];
          if (derefPtr === 0) continue;
          size = processMem[derefPtr] | (processMem[derefPtr + 1] << 8)
               | (processMem[derefPtr + 2] << 16) | (processMem[derefPtr + 3] << 24);
        } else {
          size = desc.size.size;
        }

        if (size <= 0) continue;

        // Cap size to match what was done in handleSyscall's input phase
        if (outOffset + size > CH_DATA_SIZE) {
          size = CH_DATA_SIZE - outOffset;
          if (size <= 0) continue;
        }

        const kernelPtr = dataStart + outOffset;

        // Copy output data from kernel to process
        if (desc.direction === "out" || desc.direction === "inout") {
          let copySize = size;
          if (desc.direction === "out" && desc.size.type === "arg") {
            // For read/recv-like syscalls, retVal is bytes read — limit copy to actual data
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

    // Flush TCP send pipes before notifying the process — gets PHP's
    // response data to the browser without waiting for the next pump cycle
    this.flushTcpSendPipes(channel.pid);

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
  private resolvePollPipeIndices(pid: number, origArgs: number[], syscallNr: number): number[] {
    const getRecvPipe = this.kernelInstance!.exports.kernel_get_socket_recv_pipe as
      ((pid: number, fd: number) => number) | undefined;
    if (!getRecvPipe) return [];

    const fdsPtr = origArgs[0];
    const nfds = origArgs[1];
    if (fdsPtr === 0 || nfds === 0) return [];

    // Find the channel for this pid to read process memory
    const channel = this.activeChannels.find(c => c.pid === pid);
    if (!channel) return [];

    const indices: number[] = [];
    const processMem = new DataView(channel.memory.buffer);
    // struct pollfd: fd(4) + events(2) + revents(2) = 8 bytes
    for (let i = 0; i < nfds; i++) {
      const fd = processMem.getInt32(fdsPtr + i * 8, true);
      if (fd < 0) continue;
      const pipeIdx = getRecvPipe(pid, fd);
      if (pipeIdx >= 0) {
        indices.push(pipeIdx);
      }
    }
    return indices;
  }

  private wakeBlockedPoll(pid: number, pipeIdx: number): void {
    const entry = this.pendingPollRetries.get(pid);
    if (!entry) return;
    if (!entry.pipeIndices.includes(pipeIdx)) return;

    // Cancel the scheduled retry and fire immediately
    if (entry.timer !== null) {
      clearImmediate(entry.timer);
    }
    this.pendingPollRetries.delete(pid);
    if (this.processes.has(pid)) {
      this.retrySyscall(entry.channel);
    }
  }

  private flushTcpSendPipes(pid: number): void {
    const conns = this.tcpConnections.get(pid);
    if (!conns || conns.length === 0) return;

    const pipeRead = this.kernelInstance!.exports.kernel_pipe_read as
      (pid: number, pipeIdx: number, bufPtr: number, bufLen: number) => number;
    const mem = this.getKernelMem();

    for (const conn of conns) {
      const readN = pipeRead(pid, conn.sendPipeIdx, conn.scratchOffset, 65536);
      if (readN > 0) {
        const outData = Buffer.from(mem.slice(conn.scratchOffset, conn.scratchOffset + readN));
        if (!conn.clientSocket.destroyed) {
          conn.clientSocket.write(outData);
        }
      }
      // Schedule pump to detect pipe closure (PHP closing the socket)
      conn.schedulePump();
    }
  }

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
    if (syscallNr === SYS_POLL || syscallNr === SYS_PPOLL) {
      let timeoutMs = -1;
      if (syscallNr === SYS_POLL) {
        timeoutMs = origArgs[2]; // timeout in ms
      } else {
        const tsPtr = origArgs[2];
        if (tsPtr !== 0) {
          const pv = new DataView(channel.memory.buffer, tsPtr);
          const sec = Number(pv.getBigInt64(0, true));
          const nsec = Number(pv.getBigInt64(8, true));
          timeoutMs = sec * 1000 + Math.floor(nsec / 1000000);
        }
      }
      if (timeoutMs === 0) {
        this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], 0, 0);
        return;
      }

      // Resolve which pipe indices the polled fds map to (for event-driven wakeup)
      const pipeIndices = this.resolvePollPipeIndices(channel.pid, origArgs, syscallNr);

      const retryFn = () => {
        this.pendingPollRetries.delete(channel.pid);
        if (this.processes.has(channel.pid)) {
          this.retrySyscall(channel);
        }
      };
      const timer = setImmediate(retryFn);
      this.pendingPollRetries.set(channel.pid, { timer, channel, pipeIndices });
      return;
    }

    // sigtimedwait: kernel returned EAGAIN because no signal is pending.
    // Instead of retrying (signal won't arrive in single-process mode),
    // delay for the requested timeout then complete with -1/EAGAIN.
    if (syscallNr === SYS_RT_SIGTIMEDWAIT) {
      const timeoutPtr = origArgs[2]; // pointer to timespec in process memory
      if (timeoutPtr === 0) {
        // NULL timeout = wait indefinitely. Retry after delay.
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.retrySyscall(channel);
          }
        }, EAGAIN_RETRY_MS);
        return;
      }
      const pv = new DataView(channel.memory.buffer, timeoutPtr);
      // timespec: i64 sec + i64 nsec (time64)
      const sec = Number(pv.getBigInt64(0, true));
      const nsec = Number(pv.getBigInt64(8, true));
      const timeoutMs = sec * 1000 + Math.floor(nsec / 1_000_000);
      const EAGAIN_ERRNO = 11;
      if (timeoutMs <= 0) {
        this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], -1, EAGAIN_ERRNO);
      } else {
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], -1, EAGAIN_ERRNO);
          }
        }, timeoutMs);
      }
      return;
    }

    // Default: retry on next event loop iteration (pipe read/write, socket operations, etc.)
    setImmediate(() => {
      if (this.processes.has(channel.pid)) {
        this.retrySyscall(channel);
      }
    });
  }

  /**
   * Retry a syscall by re-invoking handleSyscall with the original
   * args still in the process channel.
   */
  private retrySyscall(channel: ChannelInfo): void {
    // Check if the process was killed by a signal while blocking.
    // This handles cases like sigsuspend + cross-process SIGABRT where
    // deliver_pending_signals marks the target as Exited.
    const getExitStatus = this.kernelInstance!.exports
      .kernel_get_process_exit_status as ((pid: number) => number) | undefined;
    if (getExitStatus) {
      const exitStatus = getExitStatus(channel.pid);
      if (exitStatus >= 0) {
        // Process was killed by a signal — encode as signal death wait status.
        // Exit status from deliver_pending_signals is 128+signum.
        const signum = exitStatus >= 128 ? exitStatus - 128 : 0;
        const waitStatus = signum > 0 ? (signum & 0x7f) : ((exitStatus & 0xff) << 8);
        this.handleProcessTerminated(channel, waitStatus);
        return;
      }
    }

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
    let delayMs = 0;

    if (syscallNr === SYS_NANOSLEEP && retVal >= 0) {
      const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
      const sec = kernelView.getUint32(CH_DATA, true);
      const nsec = kernelView.getUint32(CH_DATA + 8, true);
      delayMs = sec * 1000 + Math.floor(nsec / 1_000_000);
    } else if (syscallNr === SYS_USLEEP && retVal >= 0) {
      const usec = origArgs[0] >>> 0;
      delayMs = Math.max(1, Math.floor(usec / 1000));
    } else if (syscallNr === SYS_CLOCK_NANOSLEEP && retVal >= 0) {
      const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
      const sec = kernelView.getUint32(CH_DATA, true);
      const nsec = kernelView.getUint32(CH_DATA + 8, true);
      delayMs = sec * 1000 + Math.floor(nsec / 1_000_000);
    }

    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.pendingSleeps.delete(channel.pid);
        if (this.processes.has(channel.pid)) {
          this.completeSleepWithSignalCheck(channel, syscallNr, origArgs, retVal, errVal);
        }
      }, delayMs);
      this.pendingSleeps.set(channel.pid, { timer, channel, syscallNr, origArgs, retVal, errVal });
      return true;
    }

    return false;
  }

  /**
   * Complete a sleep syscall, checking for pending signals first.
   * POSIX: sleep interrupted by signal returns EINTR.
   */
  private completeSleepWithSignalCheck(
    channel: ChannelInfo,
    syscallNr: number,
    origArgs: number[],
    retVal: number,
    errVal: number,
  ): void {
    // Check if a signal became pending during the sleep
    this.dequeueSignalForDelivery(channel);

    // If a signal was dequeued, return EINTR instead of success
    const processView = new DataView(channel.memory.buffer, channel.channelOffset);
    const pendingSig = processView.getUint32(CH_SIG_SIGNUM, true);
    if (pendingSig > 0) {
      // POSIX: nanosleep/usleep interrupted by signal returns -1/EINTR
      const EINTR = 4;
      this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], -1, EINTR);
    } else {
      this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], retVal, errVal);
    }
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
    const kernelMem = this.getKernelMem();
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
    this.currentHandlePid = channel.pid;
    try {
      handleChannel(this.scratchOffset, channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // Copy flock struct back from kernel → process (F_GETLK writes to it)
    if (flockPtr !== 0 && retVal >= 0) {
      const freshProcessMem = new Uint8Array(channel.memory.buffer);
      freshProcessMem.set(kernelMem.subarray(dataStart, dataStart + FLOCK_SIZE), flockPtr);
    }

    this.completeChannel(channel, SYS_FCNTL, origArgs, undefined, retVal, errVal);
  }

  /**
   * Handle pselect6: copy fd_sets (inout), decode timeout/sigmask from
   * process memory, call kernel_handle_channel, copy fd_sets back.
   *
   * Layout in kernel scratch data area:
   *   [0..128]   readfds  (fd_set, 128 bytes)
   *   [128..256] writefds (fd_set, 128 bytes)
   *   [256..384] exceptfds (fd_set, 128 bytes)
   *   [384..392] mask (8 bytes: mask_lo + mask_hi)
   */
  private handlePselect6(channel: ChannelInfo, origArgs: number[]): void {
    const FD_SET_SIZE = 128;
    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;

    const nfds = origArgs[0];
    const readPtr = origArgs[1];
    const writePtr = origArgs[2];
    const exceptPtr = origArgs[3];
    const tsPtr = origArgs[4];
    const maskDataPtr = origArgs[5]; // pointer to {sigset_t *mask, size_t size}

    // Copy fd_sets from process → kernel scratch
    if (readPtr !== 0) {
      kernelMem.set(processMem.subarray(readPtr, readPtr + FD_SET_SIZE), dataStart);
    } else {
      kernelMem.fill(0, dataStart, dataStart + FD_SET_SIZE);
    }
    if (writePtr !== 0) {
      kernelMem.set(processMem.subarray(writePtr, writePtr + FD_SET_SIZE), dataStart + FD_SET_SIZE);
    } else {
      kernelMem.fill(0, dataStart + FD_SET_SIZE, dataStart + 2 * FD_SET_SIZE);
    }
    if (exceptPtr !== 0) {
      kernelMem.set(processMem.subarray(exceptPtr, exceptPtr + FD_SET_SIZE), dataStart + 2 * FD_SET_SIZE);
    } else {
      kernelMem.fill(0, dataStart + 2 * FD_SET_SIZE, dataStart + 3 * FD_SET_SIZE);
    }

    // Decode timeout: timespec {i64 sec, i64 nsec} → ms
    let timeoutMs = -1;
    if (tsPtr !== 0) {
      const pv = new DataView(channel.memory.buffer, tsPtr);
      const sec = Number(pv.getBigInt64(0, true));
      const nsec = Number(pv.getBigInt64(8, true));
      timeoutMs = sec * 1000 + Math.floor(nsec / 1000000);
    }

    // Decode sigmask: pselect6 arg6 → pointer to {sigset_t *mask, size_t size}
    const maskOffset = dataStart + 3 * FD_SET_SIZE;
    if (maskDataPtr !== 0) {
      const mdv = new DataView(channel.memory.buffer, maskDataPtr);
      const maskPtr = mdv.getUint32(0, true);
      if (maskPtr !== 0) {
        kernelMem.set(processMem.subarray(maskPtr, maskPtr + 8), maskOffset);
      } else {
        kernelMem.fill(0, maskOffset, maskOffset + 8);
      }
    } else {
      kernelMem.fill(0, maskOffset, maskOffset + 8);
    }

    // Write args: (nfds, readfds_kernel_ptr, writefds_kernel_ptr,
    //              exceptfds_kernel_ptr, timeout_ms, mask_kernel_ptr)
    kernelView.setUint32(CH_SYSCALL, SYS_PSELECT6, true);
    kernelView.setInt32(CH_ARGS + 0, nfds, true);
    kernelView.setInt32(CH_ARGS + 4, readPtr !== 0 ? dataStart : 0, true);
    kernelView.setInt32(CH_ARGS + 8, writePtr !== 0 ? dataStart + FD_SET_SIZE : 0, true);
    kernelView.setInt32(CH_ARGS + 12, exceptPtr !== 0 ? dataStart + 2 * FD_SET_SIZE : 0, true);
    kernelView.setInt32(CH_ARGS + 16, timeoutMs, true);
    kernelView.setInt32(CH_ARGS + 20, maskDataPtr !== 0 ? maskOffset : 0, true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    this.currentHandlePid = channel.pid;
    try {
      handleChannel(this.scratchOffset, channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // Copy fd_sets back from kernel → process
    if (retVal >= 0) {
      const freshProcessMem = new Uint8Array(channel.memory.buffer);
      if (readPtr !== 0) {
        freshProcessMem.set(kernelMem.subarray(dataStart, dataStart + FD_SET_SIZE), readPtr);
      }
      if (writePtr !== 0) {
        freshProcessMem.set(
          kernelMem.subarray(dataStart + FD_SET_SIZE, dataStart + 2 * FD_SET_SIZE),
          writePtr,
        );
      }
      if (exceptPtr !== 0) {
        freshProcessMem.set(
          kernelMem.subarray(dataStart + 2 * FD_SET_SIZE, dataStart + 3 * FD_SET_SIZE),
          exceptPtr,
        );
      }
    }

    // Handle signal delivery
    this.dequeueSignalForDelivery(channel);

    // Handle EAGAIN retry for blocking select
    if (retVal === -1 && errVal === EAGAIN) {
      if (timeoutMs === 0) {
        this.completeChannel(channel, SYS_PSELECT6, origArgs, undefined, 0, 0);
        return;
      }
      setImmediate(() => {
        if (this.processes.has(channel.pid)) {
          this.handlePselect6(channel, origArgs);
        }
      });
      return;
    }

    this.completeChannel(channel, SYS_PSELECT6, origArgs, undefined, retVal, errVal);
  }

  private handleWritev(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const fd = origArgs[0];
    const iovPtr = origArgs[1];
    const iovcnt = origArgs[2];

    const processMem = new Uint8Array(channel.memory.buffer);
    const processView = new DataView(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
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
    this.currentHandlePid = channel.pid;
    try {
      handleChannel(this.scratchOffset, channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

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
    const kernelMem = this.getKernelMem();
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
    this.currentHandlePid = channel.pid;
    try {
      handleChannel(this.scratchOffset, channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

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

  /**
   * Handle sendmsg: decompose msghdr from process memory, flatten data + addr
   * into kernel scratch, call kernel_sendmsg which dispatches to sendto/send.
   */
  private handleSendmsg(channel: ChannelInfo, origArgs: number[]): void {
    const fd = origArgs[0];
    const msgPtr = origArgs[1];
    const flags = origArgs[2];

    const processMem = new Uint8Array(channel.memory.buffer);
    const processView = new DataView(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;

    // Parse msghdr from process memory (wasm32: 28 bytes)
    // struct msghdr { msg_name(4), msg_namelen(4), msg_iov(4), msg_iovlen(4), ... }
    const namePtr = processView.getUint32(msgPtr, true);
    const nameLen = processView.getUint32(msgPtr + 4, true);
    const iovPtr = processView.getUint32(msgPtr + 8, true);
    const iovCnt = processView.getUint32(msgPtr + 12, true);

    // Copy msghdr to kernel scratch at offset 0
    const kMsgPtr = dataStart;
    kernelMem.set(processMem.subarray(msgPtr, msgPtr + 28), kMsgPtr);

    let dataOff = 28; // after msghdr

    // Copy msg_name to kernel scratch
    if (namePtr !== 0 && nameLen > 0 && dataOff + nameLen <= CH_DATA_SIZE) {
      const kNamePtr = dataStart + dataOff;
      kernelMem.set(processMem.subarray(namePtr, namePtr + nameLen), kNamePtr);
      new DataView(kernelMem.buffer).setUint32(kMsgPtr, kNamePtr, true); // update msg_name ptr
      dataOff += nameLen;
      dataOff = (dataOff + 3) & ~3;
    }

    // Copy iov array and iov[0] data to kernel scratch
    if (iovCnt > 0 && iovPtr !== 0) {
      const iovSize = iovCnt * 8;
      const kIovPtr = dataStart + dataOff;
      kernelMem.set(processMem.subarray(iovPtr, iovPtr + iovSize), kIovPtr);
      new DataView(kernelMem.buffer).setUint32(kMsgPtr + 8, kIovPtr, true); // update msg_iov ptr
      dataOff += iovSize;
      dataOff = (dataOff + 3) & ~3;

      // Copy each iov buffer data
      for (let i = 0; i < iovCnt; i++) {
        const base = processView.getUint32(iovPtr + i * 8, true);
        const len = processView.getUint32(iovPtr + i * 8 + 4, true);
        if (len > 0 && dataOff + len <= CH_DATA_SIZE) {
          const kBufPtr = dataStart + dataOff;
          kernelMem.set(processMem.subarray(base, base + len), kBufPtr);
          // Update iov_base in kernel-side iov entry
          new DataView(kernelMem.buffer).setUint32(kIovPtr + i * 8, kBufPtr, true);
          dataOff += len;
          dataOff = (dataOff + 3) & ~3;
        }
      }
    }

    // Call kernel
    kernelView.setUint32(CH_SYSCALL, 137, true); // SYS_SENDMSG
    kernelView.setInt32(CH_ARGS, fd, true);
    kernelView.setInt32(CH_ARGS + 4, kMsgPtr, true);
    kernelView.setInt32(CH_ARGS + 8, flags, true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    this.currentHandlePid = channel.pid;
    try {
      handleChannel(this.scratchOffset, channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);
    this.completeChannel(channel, 137, origArgs, undefined, retVal, errVal);
  }

  /**
   * Handle recvmsg: decompose msghdr from process memory, set up buffers in
   * kernel scratch, call kernel_recvmsg, copy results back.
   */
  private handleRecvmsg(channel: ChannelInfo, origArgs: number[]): void {
    const fd = origArgs[0];
    const msgPtr = origArgs[1];
    const flags = origArgs[2];

    const processMem = new Uint8Array(channel.memory.buffer);
    const processView = new DataView(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;

    // Parse msghdr from process memory
    const namePtr = processView.getUint32(msgPtr, true);
    const nameLen = processView.getUint32(msgPtr + 4, true);
    const iovPtr = processView.getUint32(msgPtr + 8, true);
    const iovCnt = processView.getUint32(msgPtr + 12, true);

    // Copy msghdr to kernel scratch
    const kMsgPtr = dataStart;
    kernelMem.set(processMem.subarray(msgPtr, msgPtr + 28), kMsgPtr);

    let dataOff = 28;

    // Set up msg_name output buffer
    let kNamePtr = 0;
    if (namePtr !== 0 && nameLen > 0 && dataOff + nameLen <= CH_DATA_SIZE) {
      kNamePtr = dataStart + dataOff;
      kernelMem.fill(0, kNamePtr, kNamePtr + nameLen);
      new DataView(kernelMem.buffer).setUint32(kMsgPtr, kNamePtr, true);
      dataOff += nameLen;
      dataOff = (dataOff + 3) & ~3;
    }

    // Set up iov array and output buffers
    interface IovEntry { base: number; len: number; kernelBase: number }
    const entries: IovEntry[] = [];

    if (iovCnt > 0 && iovPtr !== 0) {
      const iovSize = iovCnt * 8;
      const kIovPtr = dataStart + dataOff;
      kernelMem.set(processMem.subarray(iovPtr, iovPtr + iovSize), kIovPtr);
      new DataView(kernelMem.buffer).setUint32(kMsgPtr + 8, kIovPtr, true);
      dataOff += iovSize;
      dataOff = (dataOff + 3) & ~3;

      for (let i = 0; i < iovCnt; i++) {
        const base = processView.getUint32(iovPtr + i * 8, true);
        const len = processView.getUint32(iovPtr + i * 8 + 4, true);
        if (len > 0 && dataOff + len <= CH_DATA_SIZE) {
          const kBufPtr = dataStart + dataOff;
          kernelMem.fill(0, kBufPtr, kBufPtr + len);
          new DataView(kernelMem.buffer).setUint32(kIovPtr + i * 8, kBufPtr, true);
          entries.push({ base, len, kernelBase: kBufPtr });
          dataOff += len;
          dataOff = (dataOff + 3) & ~3;
        }
      }
    }

    // Call kernel
    kernelView.setUint32(CH_SYSCALL, 138, true); // SYS_RECVMSG
    kernelView.setInt32(CH_ARGS, fd, true);
    kernelView.setInt32(CH_ARGS + 4, kMsgPtr, true);
    kernelView.setInt32(CH_ARGS + 8, flags, true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    this.currentHandlePid = channel.pid;
    try {
      handleChannel(this.scratchOffset, channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    if (retVal === -1 && errVal === EAGAIN) {
      this.handleBlockingRetry(channel, 138, origArgs);
      return;
    }

    // Copy received data back to process memory
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

    // Copy msg_name (source address) back to process memory
    if (kNamePtr !== 0 && namePtr !== 0 && nameLen > 0) {
      processMem.set(kernelMem.subarray(kNamePtr, kNamePtr + nameLen), namePtr);
    }

    // Copy updated msghdr fields back (msg_namelen, msg_controllen, msg_flags)
    const kMsg = kernelMem.subarray(kMsgPtr, kMsgPtr + 28);
    processMem.set(kMsg.subarray(4, 8), msgPtr + 4);   // msg_namelen
    processMem.set(kMsg.subarray(20, 24), msgPtr + 20); // msg_controllen
    processMem.set(kMsg.subarray(24, 28), msgPtr + 24); // msg_flags

    this.completeChannel(channel, 138, origArgs, undefined, retVal, errVal);
  }

  // -----------------------------------------------------------------------
  // Fork/exec/clone/exit handling
  // -----------------------------------------------------------------------

  /**
   * Handle SYS_FORK/SYS_VFORK: clone the Process in the kernel's ProcessTable,
   * then call the onFork callback to spawn the child Worker.
   */
  private handleFork(channel: ChannelInfo, _origArgs: number[]): void {
    // Check if the calling process is a fork child re-running _start.
    // In centralized mode, fork children re-execute from _start and call
    // fork() again. The kernel returns 0 to indicate "you are the child".
    const isForkChild = this.kernelInstance!.exports.kernel_is_fork_child_pid as
      (pid: number) => number;
    if (isForkChild(channel.pid) === 1) {
      const clearForkChild = this.kernelInstance!.exports.kernel_clear_fork_child as
        (pid: number) => number;
      clearForkChild(channel.pid);
      // Return 0 to child (fork() returns 0 in child process)
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, 0, 0);
      return;
    }

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

    // In centralized mode, fork children re-execute _start (Wasm call stack
    // isn't part of linear memory). The child never gets musl's __restore_sigs
    // after fork(), so it would be stuck with the parent's blocked mask (which
    // is "all signals blocked" from musl's fork wrapper). Clear it so the child
    // starts with no signals blocked.
    const resetSignalMask = this.kernelInstance!.exports.kernel_reset_signal_mask as
      ((pid: number) => number) | undefined;
    if (resetSignalMask) resetSignalMask(childPid);

    // Track parent-child relationship for waitpid
    this.childToParent.set(childPid, parentPid);
    let children = this.parentToChildren.get(parentPid);
    if (!children) {
      children = new Set();
      this.parentToChildren.set(parentPid, children);
    }
    children.add(childPid);

    // Call the async fork handler to spawn child Worker
    this.callbacks.onFork(parentPid, childPid, channel.memory).then((childChannelOffsets) => {
      if (!this.processes.has(parentPid)) return;

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
    this.currentHandlePid = channel.pid;
    try {
      handleChannel(this.scratchOffset, channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

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

    // Main thread exit or exit_group: record exit status for waitpid,
    // queue SIGCHLD to parent, then notify the host callback.
    const exitingPid = channel.pid;
    const parentPid = this.childToParent.get(exitingPid);
    if (parentPid !== undefined) {
      // Check if the kernel marked this process as killed by a signal.
      // deliver_pending_signals sets exit_status = 128 + signum for default
      // Terminate/CoreDump actions. We need to encode the wait status
      // differently for signal death vs normal exit.
      const getExitStatus = this.kernelInstance!.exports
        .kernel_get_process_exit_status as ((pid: number) => number) | undefined;
      const kernelExitStatus = getExitStatus ? getExitStatus(exitingPid) : -1;
      let waitStatus: number;
      if (kernelExitStatus >= 128) {
        // Signal death: encode as signal number in low 7 bits
        const signum = kernelExitStatus - 128;
        waitStatus = signum & 0x7f;
      } else {
        // Normal exit: exitStatus << 8 (matches WIFEXITED/WEXITSTATUS macros)
        waitStatus = (exitStatus & 0xff) << 8;
      }
      this.exitedChildren.set(exitingPid, waitStatus);

      // Queue SIGCHLD on parent process in the kernel.
      // kernel_kill handles cross-process signal delivery in centralized mode.
      this.sendSignalToProcess(parentPid, SIGCHLD);

      // Wake any parent blocked in waitpid
      this.wakeWaitingParent(parentPid, exitingPid, waitStatus);
    }

    if (this.callbacks.onExit) {
      this.callbacks.onExit(exitingPid, exitStatus);
    }
  }

  /**
   * Handle a process that was terminated by a signal while blocking on a
   * syscall retry. Records the wait status and notifies the parent.
   */
  private handleProcessTerminated(channel: ChannelInfo, waitStatus: number): void {
    const exitingPid = channel.pid;
    const parentPid = this.childToParent.get(exitingPid);
    if (parentPid !== undefined) {
      this.exitedChildren.set(exitingPid, waitStatus);
      this.sendSignalToProcess(parentPid, SIGCHLD);
      this.wakeWaitingParent(parentPid, exitingPid, waitStatus);
    }

    // Do NOT complete the channel — the worker is blocked on Atomics.wait
    // and waking it would cause the C code to continue executing.
    // onExit will terminate the worker.
    if (this.callbacks.onExit) {
      const exitCode = waitStatus > 0xff ? (waitStatus >> 8) & 0xff : 128 + (waitStatus & 0x7f);
      this.callbacks.onExit(exitingPid, exitCode);
    }
  }

  /**
   * Handle SYS_WAIT4: wait for a child process to exit.
   * Args: [pid, wstatus_ptr, options, rusage_ptr]
   */
  private handleWaitpid(channel: ChannelInfo, origArgs: number[]): void {
    const targetPid = origArgs[0]; // pid argument
    const wstatusPtr = origArgs[1];
    const options = origArgs[2] >>> 0;
    const parentPid = channel.pid;

    const children = this.parentToChildren.get(parentPid);
    if (!children || children.size === 0) {
      // No children at all → ECHILD
      this.completeWaitpid(channel, origArgs, -1, 10); // ECHILD = 10
      return;
    }

    // Find a matching exited child
    const matchedChild = this.findExitedChild(parentPid, targetPid);
    if (matchedChild !== undefined) {
      const waitStatus = this.exitedChildren.get(matchedChild)!;
      this.consumeExitedChild(parentPid, matchedChild);
      this.writeWaitStatus(channel, wstatusPtr, waitStatus);
      this.completeWaitpid(channel, origArgs, matchedChild, 0);
      return;
    }

    // Check if there are living children that could still exit
    const hasLivingChild = this.hasMatchingLivingChild(parentPid, targetPid);
    if (!hasLivingChild) {
      // No matching child exists → ECHILD
      this.completeWaitpid(channel, origArgs, -1, 10);
      return;
    }

    if (options & WNOHANG) {
      // Non-blocking: no child exited yet
      this.completeWaitpid(channel, origArgs, 0, 0);
      return;
    }

    // Blocking wait: defer completion until a child exits
    this.waitingForChild.push({
      parentPid,
      channel,
      origArgs,
      pid: targetPid,
      options,
      syscallNr: SYS_WAIT4,
    });
  }

  /** Get the pgid of a process from the kernel's ProcessTable. */
  private getProcessPgid(pid: number): number {
    const fn_ = this.kernelInstance?.exports.kernel_getpgid_direct as
      ((pid: number) => number) | undefined;
    if (!fn_) return pid; // fallback: pgid = pid
    const result = fn_(pid);
    return result >= 0 ? result : pid;
  }

  /** Check if a child matches the waitpid pid argument. */
  private childMatchesWaitTarget(childPid: number, targetPid: number, parentPid: number): boolean {
    if (targetPid > 0) {
      return childPid === targetPid;
    }
    if (targetPid === -1) {
      return true; // any child
    }
    if (targetPid === 0) {
      // Same process group as caller
      const parentPgid = this.getProcessPgid(parentPid);
      const childPgid = this.getProcessPgid(childPid);
      return childPgid === parentPgid;
    }
    // targetPid < -1: process group |targetPid|
    const targetPgid = -targetPid;
    const childPgid = this.getProcessPgid(childPid);
    return childPgid === targetPgid;
  }

  /** Find an exited child matching the waitpid pid argument. */
  private findExitedChild(parentPid: number, targetPid: number): number | undefined {
    const children = this.parentToChildren.get(parentPid);
    if (!children) return undefined;

    for (const childPid of children) {
      if (this.exitedChildren.has(childPid) && this.childMatchesWaitTarget(childPid, targetPid, parentPid)) {
        return childPid;
      }
    }
    return undefined;
  }

  /** Check if there are living children matching the pid arg. */
  private hasMatchingLivingChild(parentPid: number, targetPid: number): boolean {
    const children = this.parentToChildren.get(parentPid);
    if (!children) return false;

    for (const childPid of children) {
      if (!this.exitedChildren.has(childPid) && this.childMatchesWaitTarget(childPid, targetPid, parentPid)) {
        return true;
      }
    }
    return false;
  }

  /** Remove an exited child from tracking after wait() consumes it. */
  private consumeExitedChild(parentPid: number, childPid: number): void {
    this.exitedChildren.delete(childPid);
    this.childToParent.delete(childPid);
    // Now that the zombie is reaped, remove from kernel process table
    this.removeFromKernelProcessTable(childPid);
    const children = this.parentToChildren.get(parentPid);
    if (children) {
      children.delete(childPid);
      if (children.size === 0) {
        this.parentToChildren.delete(parentPid);
      }
    }
  }

  /** Write wait status to the wstatus pointer in process memory. */
  private writeWaitStatus(channel: ChannelInfo, wstatusPtr: number, waitStatus: number): void {
    if (wstatusPtr !== 0) {
      const procView = new DataView(channel.memory.buffer);
      procView.setInt32(wstatusPtr, waitStatus, true);
    }
  }

  /** Complete a waitpid syscall. */
  private completeWaitpid(channel: ChannelInfo, origArgs: number[], retVal: number, errVal: number): void {
    this.completeChannel(channel, SYS_WAIT4, origArgs, undefined, retVal, errVal);
  }

  /** Wake a parent blocked in waitpid/waitid when a child exits. */
  private wakeWaitingParent(parentPid: number, childPid: number, waitStatus: number): void {
    const idx = this.waitingForChild.findIndex((w) =>
      w.parentPid === parentPid && this.childMatchesWaitTarget(childPid, w.pid, parentPid),
    );
    if (idx === -1) return;

    const waiter = this.waitingForChild[idx];
    this.waitingForChild.splice(idx, 1);

    if (waiter.syscallNr === SYS_WAITID) {
      // waitid: write siginfo_t, optionally consume zombie
      this.writeSignalInfo(waiter.channel, waiter.origArgs[2], childPid, waitStatus);
      if (!(waiter.options & WNOWAIT)) {
        this.consumeExitedChild(parentPid, childPid);
      }
      this.completeChannel(waiter.channel, SYS_WAITID, waiter.origArgs, undefined, 0, 0);
    } else {
      // wait4: write wstatus, consume zombie
      this.consumeExitedChild(parentPid, childPid);
      this.writeWaitStatus(waiter.channel, waiter.origArgs[1], waitStatus);
      this.completeWaitpid(waiter.channel, waiter.origArgs, childPid, 0);
    }
  }

  /**
   * Handle SYS_WAITID: wait for a child process state change.
   * Args: [idtype, id, siginfo_ptr, options, rusage_ptr]
   *
   * Supports P_PID, P_ALL, P_PGID id types and WNOWAIT/WNOHANG/WEXITED flags.
   * Fills siginfo_t in process memory with si_signo, si_code, si_pid, si_uid, si_status.
   */
  private handleWaitid(channel: ChannelInfo, origArgs: number[]): void {
    const idtype = origArgs[0];
    const id = origArgs[1];
    const siginfoPtr = origArgs[2];
    const options = origArgs[3] >>> 0;
    const parentPid = channel.pid;

    const children = this.parentToChildren.get(parentPid);
    if (!children || children.size === 0) {
      this.completeChannel(channel, SYS_WAITID, origArgs, undefined, -1, 10); // ECHILD
      return;
    }

    // Find matching exited child based on idtype
    let matchedChild: number | undefined;
    if (idtype === P_PID) {
      if (children.has(id) && this.exitedChildren.has(id)) {
        matchedChild = id;
      }
    } else if (idtype === P_ALL) {
      for (const childPid of children) {
        if (this.exitedChildren.has(childPid)) {
          matchedChild = childPid;
          break;
        }
      }
    } else if (idtype === P_PGID) {
      // TODO: Match children in the specified process group
      // For now, treat as P_ALL (sufficient for current test coverage)
      for (const childPid of children) {
        if (this.exitedChildren.has(childPid)) {
          matchedChild = childPid;
          break;
        }
      }
    }

    if (matchedChild !== undefined) {
      const waitStatus = this.exitedChildren.get(matchedChild)!;
      this.writeSignalInfo(channel, siginfoPtr, matchedChild, waitStatus);

      if (!(options & WNOWAIT)) {
        // Consume the zombie (reap it)
        this.consumeExitedChild(parentPid, matchedChild);
      }
      this.completeChannel(channel, SYS_WAITID, origArgs, undefined, 0, 0);
      return;
    }

    // Check for living children
    let hasLivingChild = false;
    if (idtype === P_PID) {
      hasLivingChild = children.has(id) && !this.exitedChildren.has(id);
    } else {
      for (const childPid of children) {
        if (!this.exitedChildren.has(childPid)) {
          hasLivingChild = true;
          break;
        }
      }
    }

    if (!hasLivingChild) {
      this.completeChannel(channel, SYS_WAITID, origArgs, undefined, -1, 10); // ECHILD
      return;
    }

    if (options & WNOHANG) {
      // Zero out siginfo to indicate no child changed state yet
      if (siginfoPtr !== 0) {
        const procView = new DataView(channel.memory.buffer);
        procView.setInt32(siginfoPtr, 0, true); // si_signo = 0
        procView.setInt32(siginfoPtr + 12, 0, true); // si_pid = 0
      }
      this.completeChannel(channel, SYS_WAITID, origArgs, undefined, 0, 0);
      return;
    }

    // Blocking wait: defer until a child exits
    this.waitingForChild.push({
      parentPid,
      channel,
      origArgs,
      pid: idtype === P_PID ? id : -1, // -1 for any child
      options,
      syscallNr: SYS_WAITID,
    });
  }

  /**
   * Write siginfo_t fields for waitid into process memory.
   * Layout (wasm32): si_signo(+0), si_errno(+4), si_code(+8),
   * si_pid(+12), si_uid(+16), si_status(+20)
   */
  private writeSignalInfo(channel: ChannelInfo, siginfoPtr: number, childPid: number, waitStatus: number): void {
    if (siginfoPtr === 0) return;
    const procView = new DataView(channel.memory.buffer);
    // Zero out the full 128-byte siginfo_t first
    for (let i = 0; i < 128; i += 4) {
      procView.setInt32(siginfoPtr + i, 0, true);
    }

    const signaled = (waitStatus & 0x7f) !== 0;
    procView.setInt32(siginfoPtr + 0, SIGCHLD, true);  // si_signo
    procView.setInt32(siginfoPtr + 4, 0, true);         // si_errno
    if (signaled) {
      procView.setInt32(siginfoPtr + 8, CLD_KILLED, true); // si_code
    } else {
      procView.setInt32(siginfoPtr + 8, CLD_EXITED, true); // si_code
    }
    procView.setInt32(siginfoPtr + 12, childPid, true);  // si_pid
    procView.setInt32(siginfoPtr + 16, 1000, true);      // si_uid
    if (signaled) {
      procView.setInt32(siginfoPtr + 20, waitStatus & 0x7f, true); // si_status = signal number
    } else {
      procView.setInt32(siginfoPtr + 20, (waitStatus >> 8) & 0xff, true); // si_status = exit code
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

  /**
   * Queue a signal on a target process in the kernel by invoking SYS_KILL
   * through kernel_handle_channel. The signal is queued in the kernel's
   * ProcessTable and will be delivered via dequeueSignalForDelivery on the
   * target process's next syscall completion.
   */
  private sendSignalToProcess(targetPid: number, signum: number): void {
    if (!this.kernelInstance || !this.kernelMemory) return;

    // Verify the target process exists in the kernel
    if (!this.processes.has(targetPid)) return;

    const kernelView = new DataView(this.kernelMemory.buffer, this.scratchOffset);
    // Write SYS_KILL into scratch: kill(targetPid, signum)
    kernelView.setUint32(CH_SYSCALL, SYS_KILL, true);
    kernelView.setInt32(CH_ARGS, targetPid, true);       // arg0 = pid
    kernelView.setInt32(CH_ARGS + 4, signum, true);      // arg1 = sig
    for (let i = 2; i < CH_ARGS_COUNT; i++) {
      kernelView.setInt32(CH_ARGS + i * 4, 0, true);
    }

    const handleChannel = this.kernelInstance.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    this.currentHandlePid = targetPid;
    try {
      handleChannel(this.scratchOffset, targetPid);
    } catch (err) {
      // Non-fatal — signal delivery is best-effort from the host side
      console.error(`[sendSignalToProcess] kernel threw for pid=${targetPid} sig=${signum}: ${err}`);
    } finally {
      this.currentHandlePid = 0;
    }

    // If the target process has a pending sleep, interrupt it — but only if
    // the signal is actually deliverable (not blocked).  When the signal is
    // blocked, the sleep must continue; the signal stays pending and will be
    // checked when the sleep naturally completes or a mask change unblocks it.
    const pendingSleep = this.pendingSleeps.get(targetPid);
    if (pendingSleep) {
      const isBlocked = (this.kernelInstance!.exports.kernel_is_signal_blocked as
        (pid: number, signum: number) => number)(targetPid, signum);
      if (!isBlocked) {
        clearTimeout(pendingSleep.timer);
        this.pendingSleeps.delete(targetPid);
        // Complete the sleep with signal check — will return EINTR
        this.completeSleepWithSignalCheck(
          pendingSleep.channel, pendingSleep.syscallNr, pendingSleep.origArgs,
          pendingSleep.retVal, pendingSleep.errVal,
        );
      }
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
    let mmapAddr = 0;
    let mmapLen = 0;

    if (syscallNr === SYS_BRK) {
      // retVal is the new program break address
      endAddr = retVal >>> 0;
    } else if (syscallNr === SYS_MMAP) {
      // retVal is the mapped address, origArgs[1] is the length
      const MAP_FAILED = 0xffffffff;
      if ((retVal >>> 0) !== MAP_FAILED) {
        mmapAddr = retVal >>> 0;
        mmapLen = origArgs[1] >>> 0;
        endAddr = mmapAddr + mmapLen;
      }
    } else if (syscallNr === SYS_MREMAP) {
      // retVal is the new address, origArgs[2] is the new length
      const MAP_FAILED = 0xffffffff;
      if ((retVal >>> 0) !== MAP_FAILED) {
        mmapAddr = retVal >>> 0;
        mmapLen = origArgs[2] >>> 0;
        endAddr = mmapAddr + mmapLen;
      }
    }

    const currentBytes = processMemory.buffer.byteLength;

    if (endAddr > 0 && endAddr > currentBytes) {
      const neededPages = Math.ceil((endAddr - currentBytes) / 65536);
      processMemory.grow(neededPages);
    }

    // Zero the mmap'd region. Anonymous mmap must return zeroed pages (like
    // Linux). The kernel allocates whole pages, so zero the full page-aligned
    // region, not just the requested length. On Linux, bytes beyond the
    // requested length up to the page boundary are also zeroed. Without this,
    // reused addresses contain stale data from previous allocations,
    // corrupting musl's malloc metadata (infinite loops / heap corruption).
    if (mmapLen > 0) {
      const PAGE_SIZE = 65536; // Wasm page size
      const alignedLen = Math.ceil(mmapLen / PAGE_SIZE) * PAGE_SIZE;
      const newBytes = processMemory.buffer.byteLength;
      const zeroEnd = Math.min(mmapAddr + alignedLen, newBytes);
      if (mmapAddr < zeroEnd) {
        new Uint8Array(processMemory.buffer, mmapAddr, zeroEnd - mmapAddr).fill(0);
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

  // ---------------------------------------------------------------------------
  // TCP bridge — injects real TCP connections into kernel pipe-buffer sockets
  // ---------------------------------------------------------------------------

  /**
   * Start a TCP server for a listening socket, bridging real TCP connections
   * into the kernel's pipe-buffer-backed accept path.
   */
  private startTcpListener(pid: number, fd: number, port: number): void {
    // Avoid duplicate listeners on the same fd
    if (this.tcpListeners.has(fd)) return;

    if (!this.netModule) return; // Not in Node.js environment

    const net = this.netModule;

    const connections = new Set<import("net").Socket>();
    const server = net.createServer((clientSocket) => {
      this.handleIncomingTcpConnection(pid, fd, clientSocket, connections);
    });

    server.listen(port, "0.0.0.0", () => {
      // Server is ready
    });

    server.on("error", (err) => {
      console.error(`TCP listener error on port ${port}:`, err);
    });

    this.tcpListeners.set(fd, { server, pid, port, connections });
  }

  /**
   * Handle an incoming TCP connection: inject it into the kernel's listening
   * socket's backlog and pump data between the real socket and kernel pipes.
   */
  private handleIncomingTcpConnection(
    pid: number,
    listenerFd: number,
    clientSocket: import("net").Socket,
    connections: Set<import("net").Socket>,
  ): void {
    connections.add(clientSocket);

    const remoteAddr = clientSocket.remoteAddress || "127.0.0.1";
    const remotePort = clientSocket.remotePort || 0;

    // Parse IP address
    const parts = remoteAddr.replace("::ffff:", "").split(".").map(Number);
    const addrA = parts[0] || 127;
    const addrB = parts[1] || 0;
    const addrC = parts[2] || 0;
    const addrD = parts[3] || 1;

    // Inject connection into kernel
    const injectConnection = this.kernelInstance!.exports.kernel_inject_connection as
      (pid: number, listenerFd: number, a: number, b: number, c: number, d: number, port: number) => number;
    const recvPipeIdx = injectConnection(pid, listenerFd, addrA, addrB, addrC, addrD, remotePort);
    if (recvPipeIdx < 0) {
      clientSocket.destroy();
      connections.delete(clientSocket);
      return;
    }

    const sendPipeIdx = recvPipeIdx + 1;

    // Get kernel pipe access functions
    const pipeWrite = this.kernelInstance!.exports.kernel_pipe_write as
      (pid: number, pipeIdx: number, bufPtr: number, bufLen: number) => number;
    const pipeRead = this.kernelInstance!.exports.kernel_pipe_read as
      (pid: number, pipeIdx: number, bufPtr: number, bufLen: number) => number;
    const pipeCloseWrite = this.kernelInstance!.exports.kernel_pipe_close_write as
      (pid: number, pipeIdx: number) => number;
    const pipeCloseRead = this.kernelInstance!.exports.kernel_pipe_close_read as
      (pid: number, pipeIdx: number) => number;
    const pipeIsReadOpen = this.kernelInstance!.exports.kernel_pipe_is_read_open as
      (pid: number, pipeIdx: number) => number;

    // Queue for incoming TCP data (written to recv pipe)
    const inboundQueue: Buffer[] = [];
    let clientEnded = false;
    let pumpPending = false;
    let cleaned = false;

    const scratchOffset = this.tcpScratchOffset;

    const pipeIsWriteOpen = this.kernelInstance!.exports.kernel_pipe_is_write_open as
      (pid: number, pipeIdx: number) => number;

    // Drain inbound queue into recv pipe
    const drainInbound = () => {
      const mem = this.getKernelMem();
      while (inboundQueue.length > 0) {
        const chunk = inboundQueue[0]!;
        const toWrite = Math.min(chunk.length, 65536);
        mem.set(chunk.subarray(0, toWrite), scratchOffset);
        const written = pipeWrite(pid, recvPipeIdx, scratchOffset, toWrite);
        if (written <= 0) break; // Pipe full, retry next pump
        if (written >= chunk.length) {
          inboundQueue.shift();
        } else {
          inboundQueue[0] = chunk.subarray(written) as Buffer;
        }
      }
      if (clientEnded && inboundQueue.length === 0) {
        pipeCloseWrite(pid, recvPipeIdx);
      }
    };

    // Read send pipe → TCP socket
    const drainOutbound = () => {
      const mem = this.getKernelMem();
      const readN = pipeRead(pid, sendPipeIdx, scratchOffset, 65536);
      if (readN > 0) {
        const outData = Buffer.from(mem.slice(scratchOffset, scratchOffset + readN));
        if (!clientSocket.destroyed) {
          clientSocket.write(outData);
        }
      }
      return readN;
    };

    const schedulePump = () => {
      if (pumpPending || cleaned) return;
      pumpPending = true;
      setImmediate(pump);
    };

    const pump = () => {
      pumpPending = false;
      if (cleaned || !this.processes.has(pid)) {
        cleanup();
        return;
      }

      drainInbound();
      const readN = drainOutbound();

      // Check if PHP closed its write end of the send pipe
      const writeOpen = pipeIsWriteOpen(pid, sendPipeIdx);
      if (writeOpen === 0 && readN === 0) {
        if (!clientSocket.destroyed) {
          clientSocket.end();
        }
        cleanup();
        return;
      }

      // If there's still queued inbound data (pipe was full), schedule another pump
      if (inboundQueue.length > 0) {
        schedulePump();
      }
    };

    // Incoming TCP data → write directly to recv pipe, queue overflow
    clientSocket.on("data", (chunk: Buffer) => {
      inboundQueue.push(chunk);
      if (!this.processes.has(pid)) { cleanup(); return; }
      drainInbound();
      // Wake any process blocked on poll() watching this recv pipe
      this.wakeBlockedPoll(pid, recvPipeIdx);
      // Schedule pump to handle outbound + close detection
      schedulePump();
    });

    clientSocket.on("end", () => {
      clientEnded = true;
      schedulePump();
    });

    clientSocket.on("error", () => {
      clientEnded = true;
      clientSocket.destroy();
    });

    clientSocket.on("close", () => {
      connections.delete(clientSocket);
    });

    // Register this connection for piggyback flushing
    let conns = this.tcpConnections.get(pid);
    if (!conns) {
      conns = [];
      this.tcpConnections.set(pid, conns);
    }
    const connEntry = { sendPipeIdx, scratchOffset, clientSocket, recvPipeIdx, schedulePump };
    conns.push(connEntry);

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      pipeCloseRead(pid, recvPipeIdx);
      connections.delete(clientSocket);
      // Remove from tcpConnections tracking
      const arr = this.tcpConnections?.get(pid);
      if (arr) {
        const idx = arr.indexOf(connEntry);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) this.tcpConnections?.delete(pid);
      }
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    };
  }

  /**
   * Clean up all TCP listeners and connections for a process.
   */
  private cleanupTcpListeners(pid: number): void {
    for (const [fd, entry] of this.tcpListeners) {
      if (entry.pid === pid) {
        entry.server.close();
        for (const conn of entry.connections) {
          conn.destroy();
        }
        entry.connections.clear();
        this.tcpListeners.delete(fd);
      }
    }
    this.tcpConnections.delete(pid);
  }
}
