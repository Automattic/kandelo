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
 *   8       48B   arguments (6 x i64)
 *   56      8B    return value (i64)
 *   64      4B    errno
 *   72      64KB  data transfer buffer
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
const EINTR_ERRNO = 4;

/** Syscall numbers for sleep/delay */
const SYS_NANOSLEEP = 41;
const SYS_USLEEP = 68;
const SYS_CLOCK_NANOSLEEP = 124;
const SYS_FUTEX = 200;
const SYS_POLL = 60;
const SYS_PPOLL = 251;
const SYS_PSELECT6 = 252;
const SYS_SELECT = 103;
const SYS_EPOLL_PWAIT = 241;
const SYS_EPOLL_CREATE1 = 239;
const SYS_EPOLL_CREATE = 378;
const SYS_EPOLL_CTL = 240;
const SYS_EPOLL_WAIT = 379;
const SYS_RT_SIGTIMEDWAIT = 207;

/** Syscall numbers for signals */
const SYS_KILL = 35;

/** Syscall numbers for fork/exec/clone */
const SYS_EXECVE = 211;
const SYS_EXECVEAT = 386;
const SYS_FORK = 212;
const SYS_VFORK = 213;
const SYS_CLONE = 201;
const SYS_EXIT = 34;
const SYS_EXIT_GROUP = 387;
const SYS_SETPGID = 90;
const SYS_SETSID = 92;
const SYS_WAIT4 = 139;
const SYS_WAITID = 288;
/** SYS_THREAD_CANCEL: host-side wake-up for deferred pthread cancellation.
 * See musl-overlay/src/thread/wasm32posix/pthread_cancel.c for the design. */
const SYS_THREAD_CANCEL = 415;

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

/** Network ioctl request codes */
const SIOCGIFCONF = 0x8912;
const SIOCGIFHWADDR = 0x8927;
const SIOCGIFADDR = 0x8915;

/** Ioctl syscall number */
const SYS_IOCTL = 72;

/** Syscall numbers for memory management */
const SYS_MMAP = 46;
const SYS_MUNMAP = 47;
const SYS_BRK = 48;
const SYS_MREMAP = 126;
const SYS_MSYNC = 278;
const SYS_WRITE = 4;
const SYS_PREAD = 64;
const SYS_PWRITE = 65;

/** mmap flags */
const MAP_SHARED = 0x01;
const MAP_ANONYMOUS = 0x20;

/** Syscall numbers for scatter/gather I/O */
const SYS_WRITEV = 81;
const SYS_READV = 82;
const SYS_PREADV = 295;
const SYS_PWRITEV = 296;

/** fcntl commands that take a struct flock pointer */
const SYS_FCNTL = 10;

/** SysV IPC syscall numbers (only those still intercepted on host) */
const SYS_MSGRCV = 338;
const SYS_MSGSND = 339;
const SYS_SEMOP = 342;
const SYS_SEMCTL = 343;
const SYS_SHMAT = 345;
const SYS_SHMDT = 346;

/** POSIX message queue syscall numbers */
const SYS_MQ_TIMEDSEND = 333;
const SYS_MQ_TIMEDRECEIVE = 334;

const SYS_CLOSE = 2;

/** IPC constants (must match musl) */
const IPC_64 = 0x100;

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

/** Profiling: enabled via WASM_POSIX_PROFILE env var. Zero-cost when disabled. */
const PROFILING = typeof process !== 'undefined' && !!process.env?.WASM_POSIX_PROFILE;

/** Read-like syscalls that may block on pipe/socket data */
const READ_LIKE_SYSCALLS = new Set([3, 56, 63, 64, 82, 138]); // READ, RECV, RECVFROM, PREAD, READV, RECVMSG
/** Write-like syscalls that may produce pipe/socket data */
const WRITE_LIKE_SYSCALLS = new Set([4, 55, 62, 65, 81, 137, 294]); // WRITE, SEND, SENDTO, PWRITE, WRITEV, SENDMSG, SENDFILE
/** Channel layout offsets */
const CH_STATUS = 0;
const CH_SYSCALL = 4;
const CH_ARGS = 8;
const CH_ARG_SIZE = 8;  // each arg is i64 (8 bytes)
const CH_ARGS_COUNT = 6;
const CH_RETURN = 56;
const CH_ERRNO = 64;
const CH_DATA = 72;
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
const CH_SIG_ALT_SP = CH_SIG_BASE + 36;   // u32: alt stack sp (0 = no switch)
const CH_SIG_ALT_SIZE = CH_SIG_BASE + 40;  // u32: alt stack size

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
  384: [                                                                        // ACCEPT4: addr + addrlen (same as accept)
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
  58: [                                                                        // GETSOCKOPT: optval + optlen
    { argIndex: 3, direction: "out", size: { type: "deref", argIndex: 4 } },   //   optval (output, size from *optlen)
    { argIndex: 4, direction: "inout", size: { type: "fixed", size: 4 } },     //   optlen (inout, socklen_t = 4 bytes)
  ],
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

  // (epoll syscalls are now intercepted on the host side — see handleEpollCreate/Ctl/Pwait)

  // Terminal
  70: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: 256 } }], // TCGETATTR
  71: [{ argIndex: 2, direction: "in", size: { type: "fixed", size: 256 } }],  // TCSETATTR
  72: [{ argIndex: 2, direction: "inout", size: { type: "fixed", size: 256 } }], // IOCTL

  // File system
  85: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // TRUNCATE: path
  // statfs64/fstatfs64: musl sends (path, sizeof, buf) / (fd, sizeof, buf)
  // because SYS_statfs64 is aliased to SYS_statfs on our platform
  129: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // STATFS64: path
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 72 } },      //           buf (WasmStatfs = 72 bytes)
  ],
  130: [{ argIndex: 2, direction: "out", size: { type: "fixed", size: 72 } }], // FSTATFS64: buf (WasmStatfs = 72 bytes)

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
    { argIndex: 2, direction: "out", size: { type: "arg", argIndex: 3 } },     //             buf (a3), bufsiz (a4)
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

  // prctl(option, arg2, arg3, arg4, arg5)
  // Always marshal arg2 as a 16-byte inout buffer:
  //   PR_SET_NAME (15): kernel reads thread name from buf
  //   PR_GET_NAME (16): kernel writes thread name to buf
  //   Any other option: kernel ignores buf entirely (sys_prctl returns Ok(()) for
  //   unknown options without touching it), so always-marshalling is wasted-but-safe.
  // Without this, the user's wasm32 buffer pointer was passed unchanged to the
  // kernel's `from_raw_parts_mut(arg2 as *mut u8, 16)` — the kernel would
  // dereference user-space addresses against its own memory, with the failure
  // mode depending on whether the address landed in already-grown kernel pages
  // (silent corruption) or past them (RuntimeError: memory access out of bounds).
  // Triggered by mariadbd's pthread_setname_np during boot.
  223: [{ argIndex: 1, direction: "inout", size: { type: "fixed", size: 16 } }],

  // Timer
  225: [
    { argIndex: 1, direction: "in", size: { type: "fixed", size: ITIMERVAL_SIZE } },   // SETITIMER: new
    { argIndex: 2, direction: "out", size: { type: "fixed", size: ITIMERVAL_SIZE } },  //            old
  ],
  224: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: ITIMERVAL_SIZE } }], // GETITIMER

  // statx
  260: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // STATX: path
    { argIndex: 4, direction: "out", size: { type: "fixed", size: 256 } },     //        statxbuf (a5)
  ],

  // mknod/mknodat
  271: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],          // MKNOD: path
  272: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],          // MKNODAT: path

  // faccessat2/fchmodat2
  382: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],          // FACCESSAT2: path
  383: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],          // FCHMODAT2: path

  // POSIX message queues
  331: [                                                                        // MQ_OPEN: (name, flags, mode, attr)
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               //   name
    { argIndex: 3, direction: "in", size: { type: "fixed", size: 32 } },        //   mq_attr (if O_CREAT && non-null)
  ],
  332: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],          // MQ_UNLINK: name
  333: [                                                                        // MQ_TIMEDSEND: (mqd, msg_ptr, msg_len, priority, timeout)
    { argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } },      //   message data
    { argIndex: 4, direction: "in", size: { type: "fixed", size: 16 } },        //   timespec (optional)
  ],
  334: [                                                                        // MQ_TIMEDRECEIVE: (mqd, msg_ptr, msg_len, prio_ptr, timeout)
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     //   message buffer (out)
    { argIndex: 3, direction: "out", size: { type: "fixed", size: 4 } },        //   priority (out)
    { argIndex: 4, direction: "in", size: { type: "fixed", size: 16 } },        //   timespec (optional)
  ],
  335: [                                                                        // MQ_NOTIFY: (mqd, sigevent)
    { argIndex: 1, direction: "in", size: { type: "fixed", size: 16 } },        //   sigevent (optional)
  ],
  336: [                                                                        // MQ_GETSETATTR: (mqd, new_attr, old_attr)
    { argIndex: 1, direction: "in", size: { type: "fixed", size: 32 } },        //   new mq_attr (optional)
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 32 } },       //   old mq_attr (out)
  ],

  // SysV IPC
  338: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }],  // MSGRCV: msgp ({mtype, mtext})
  339: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],   // MSGSND: msgp ({mtype, mtext})
  340: [{ argIndex: 2, direction: "inout", size: { type: "fixed", size: 96 } }], // MSGCTL: msqid_ds buf
  342: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],   // SEMOP: sembuf[] (nsops * 6)
  347: [{ argIndex: 2, direction: "inout", size: { type: "fixed", size: 88 } }], // SHMCTL: shmid_ds buf
};

// Also need a way to compute poll size: nfds * sizeof(struct pollfd) = nfds * 8
// This is handled as a special case in the size computation.

/** Syscall number → name mapping for logging */
const SYSCALL_NAMES: Record<number, string> = {
  1: "open", 2: "close", 3: "read", 4: "write", 5: "lseek", 6: "fstat",
  7: "dup", 8: "dup2", 9: "pipe", 10: "fcntl", 11: "stat", 12: "lstat",
  13: "mkdir", 14: "rmdir", 15: "unlink", 16: "rename", 17: "link",
  18: "symlink", 19: "readlink", 20: "chmod", 21: "chown", 22: "access",
  23: "getcwd", 24: "chdir", 25: "opendir", 26: "readdir", 27: "closedir",
  28: "getpid", 29: "getppid", 30: "getuid", 31: "geteuid", 32: "getgid",
  33: "getegid", 34: "exit", 35: "kill", 36: "sigaction", 37: "sigprocmask",
  38: "raise", 40: "clock_gettime", 41: "nanosleep", 43: "getenv",
  44: "setenv", 45: "unsetenv", 46: "mmap", 47: "munmap", 48: "brk",
  50: "socket", 51: "bind", 52: "listen", 53: "accept", 54: "connect",
  55: "send", 56: "recv", 57: "shutdown", 58: "getsockopt", 59: "setsockopt",
  60: "poll", 61: "socketpair", 62: "sendto", 63: "recvfrom",
  64: "pread", 65: "pwrite", 68: "usleep", 69: "openat", 70: "tcgetattr",
  71: "tcsetattr", 72: "ioctl", 75: "uname", 77: "dup3", 78: "pipe2",
  81: "writev", 82: "readv", 83: "getrlimit", 84: "setrlimit",
  85: "truncate", 86: "ftruncate", 87: "fsync", 88: "fdatasync",
  89: "getpgrp", 90: "setpgid", 92: "setsid", 93: "fstatat",
  94: "unlinkat", 95: "mkdirat", 96: "renameat", 97: "faccessat",
  98: "fchmodat", 99: "fchownat", 100: "linkat", 101: "symlinkat",
  102: "readlinkat", 107: "fchmod", 108: "getrusage", 109: "realpath",
  110: "sigsuspend", 114: "getsockname", 115: "getpeername",
  119: "_llseek", 120: "getrandom", 121: "flock", 122: "getdents64",
  123: "clock_getres", 124: "clock_nanosleep", 125: "utimensat",
  126: "mremap", 127: "fchdir", 129: "statfs64", 130: "fstatfs64",
  132: "getresuid", 134: "getresgid", 137: "sendmsg", 138: "recvmsg",
  139: "wait4", 140: "getaddrinfo", 200: "futex", 201: "clone",
  205: "rt_sigqueueinfo", 206: "rt_sigpending", 207: "rt_sigtimedwait",
  208: "rt_sigreturn", 209: "sigaltstack", 211: "execve", 212: "fork",
  213: "vfork", 214: "getpgid", 224: "getitimer", 225: "setitimer",
  230: "sched_getparam", 236: "sched_rr_get_interval",
  239: "epoll_create1", 240: "epoll_ctl", 241: "epoll_pwait",
  250: "prlimit64", 251: "ppoll", 252: "pselect6", 260: "statx",
  271: "mknod", 272: "mknodat", 278: "msync", 288: "waitid",
  295: "preadv", 296: "pwritev", 326: "timer_create",
  327: "timer_settime", 328: "timer_gettime", 329: "timer_getoverrun",
  330: "timer_delete", 331: "mq_open", 332: "mq_unlink",
  333: "mq_timedsend", 334: "mq_timedreceive", 335: "mq_notify",
  336: "mq_getsetattr", 337: "msgget", 338: "msgrcv", 339: "msgsnd",
  340: "msgctl", 341: "semget", 342: "semop", 343: "semctl",
  344: "shmget", 345: "shmat", 346: "shmdt", 347: "shmctl",
  378: "epoll_create", 379: "epoll_wait", 382: "faccessat2",
  383: "fchmodat2", 384: "accept4", 386: "execveat", 387: "exit_group",
};

/** Errno number → name mapping for logging */
const ERRNO_NAMES: Record<number, string> = {
  1: "EPERM", 2: "ENOENT", 3: "ESRCH", 4: "EINTR", 5: "EIO",
  6: "ENXIO", 7: "E2BIG", 8: "ENOEXEC", 9: "EBADF", 10: "ECHILD",
  11: "EAGAIN", 12: "ENOMEM", 13: "EACCES", 14: "EFAULT", 16: "EBUSY",
  17: "EEXIST", 19: "ENODEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL",
  28: "ENOSPC", 29: "ESPIPE", 30: "EROFS", 36: "ENAMETOOLONG",
  38: "ENOSYS", 39: "ENOTEMPTY", 61: "ENODATA", 75: "EOVERFLOW",
  88: "ENOTSOCK", 90: "EMSGSIZE", 92: "ENOPROTOOPT", 93: "EPROTONOSUPPORT",
  95: "EOPNOTSUPP", 97: "EAFNOSUPPORT", 98: "EADDRINUSE",
  99: "EADDRNOTAVAIL", 100: "ENETDOWN", 103: "ECONNABORTED",
  104: "ECONNRESET", 106: "EISCONN", 107: "ENOTCONN",
  110: "ETIMEDOUT", 111: "ECONNREFUSED", 115: "EINPROGRESS",
};

/** Info about a registered thread channel. */
interface ChannelInfo {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
  /** Int32Array view for Atomics operations */
  i32View: Int32Array;
  /** @deprecated Kept for compat — no longer used after relistenChannel simplification. */
  consecutiveSyscalls: number;
  /** True while this channel is being handled by handleSyscall or an async
   *  retry/sleep/fork/exec path. Prevents the poller from re-entering a
   *  channel that is already in flight. Only used when usePolling=true. */
  handling?: boolean;
}

/** Info about a registered process. */
interface ProcessRegistration {
  pid: number;
  memory: WebAssembly.Memory;
  channels: ChannelInfo[];
  /** Pointer width: 4 for wasm32, 8 for wasm64. */
  ptrWidth: 4 | 8;
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
   * program path, terminate the old Worker, create a new Worker with the
   * new binary, and call registerProcess with skipKernelCreate.
   * Returns 0 on success, negative errno on error.
   */
  onExec?: (pid: number, path: string, argv: string[], envp: string[]) => Promise<number>;

  /**
   * Called when a process calls clone (thread creation). The callback should
   * spawn a thread Worker sharing the parent's Memory. Returns the TID.
   */
  onClone?: (pid: number, tid: number, fnPtr: number, argPtr: number, stackPtr: number, tlsPtr: number, ctidPtr: number, memory: WebAssembly.Memory) => Promise<number>;

  /**
   * Called when a process exits.
   */
  onExit?: (pid: number, exitStatus: number) => void;

  /**
   * Called when a process calls exit_group (terminate all threads).
   * The callback should forcefully terminate all thread workers for the process.
   * Called BEFORE the process exit is processed.
   */
  onExitGroup?: (pid: number) => void;
}

export class CentralizedKernelWorker {
  private kernel: WasmPosixKernel;
  private kernelInstance: WebAssembly.Instance | null = null;
  private kernelMemory: WebAssembly.Memory | null = null;
  /** ABI version read from the kernel wasm at startup. */
  private kernelAbiVersion: number = 0;
  private processes = new Map<number, ProcessRegistration>();
  private activeChannels: ChannelInfo[] = [];
  private scratchOffset = 0;
  private initialized = false;
  private nextChildPid = 100;

  /**
   * Allocate a fresh pid for a top-level spawn from a host. Skips any pids
   * already in the kernel's process table (forked children, the virtual
   * init at pid 1, etc.). The host is no longer expected to pick pids;
   * this is the single source of truth.
   */
  allocatePid(): number {
    while (this.processes.has(this.nextChildPid)) {
      this.nextChildPid++;
    }
    return this.nextChildPid++;
  }
  /** Maps "pid:channelOffset" to TID for tracking thread channels */
  private channelTids = new Map<string, number>();
  /** Tracks the pid currently being serviced by kernel_handle_channel */
  private currentHandlePid = 0;
  /**
   * Bind the kernel's view of "which thread is executing this syscall" to
   * the calling channel. Must be called immediately before every
   * `kernel_handle_channel` invocation that originates from user code — the
   * kernel consults this to route per-thread signal state (pthread_sigmask,
   * pthread_kill pending, sigsuspend per-thread mask swap). `tid = 0` means
   * "main thread" and is the default for channels without a tracked TID
   * (e.g. the main process worker).
   */
  private bindKernelTidForChannel(channel: ChannelInfo): void {
    const tid = this.channelTids.get(`${channel.pid}:${channel.channelOffset}`) ?? 0;
    const setTid = this.kernelInstance?.exports.kernel_set_current_tid as
      ((tid: number) => void) | undefined;
    if (setTid) setTid(tid);
  }
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
  /** TCP listeners: "pid:fd" → { server, pid, port, connections } */
  private tcpListeners = new Map<string, {
    server: import("net").Server;
    pid: number;
    port: number;
    connections: Set<import("net").Socket>;
  }>();
  /** TCP listener targets: port → list of {pid, fd} for round-robin dispatch.
   *  When multiple processes share a listening socket (e.g., nginx master forks
   *  workers), incoming connections are distributed among them. */
  private tcpListenerTargets = new Map<number, Array<{pid: number, fd: number}>>();
  private tcpListenerRRIndex = new Map<number, number>();
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
  /** Pending poll/ppoll retries — keyed by channelOffset for per-thread tracking */
  private pendingPollRetries = new Map<number, {
    timer: any;  // setImmediate or setTimeout handle
    channel: ChannelInfo;
    pipeIndices: number[];
    /** True if this retry was entered via ppoll with an atomic sigmask swap.
     *  Broad wakes triggered by cross-process pipe events must be deferred
     *  a few ms for these retries so follow-up cross-process signals have
     *  time to land before ppoll observes "pipe ready, no signal" and
     *  restores its mask. See scheduleWakeBlockedRetriesDeferred and
     *  os-test/signal/ppoll-block-sleep-write-raise. */
    needsSignalSafeWake?: boolean;
  }>();
  /** Pending pselect6/select retries — used for signal-driven wakeup and timeout tracking */
  private pendingSelectRetries = new Map<number, {
    timer: any;  // setTimeout or setImmediate handle
    channel: ChannelInfo;
    origArgs: number[];
    deadline: number;  // Date.now() deadline, -1 for infinite
    /** True if this pselect6 retry has an atomic sigmask swap. */
    needsSignalSafeWake?: boolean;
    /** SYS_SELECT (103) or SYS_PSELECT6 (252). Determines retry-dispatch
     *  target when a wake fires; the two have different time-struct shapes. */
    syscallNr?: number;
  }>();
  /** Flag to coalesce cross-process wakeup microtasks */
  private wakeScheduled = false;
  /** Pending pipe/socket readers: pipeIdx → array of waiting channels.
   * When a read-like syscall returns EAGAIN on a pipe/socket fd, the reader
   * is registered here instead of using a blind setImmediate retry.
   * When a write completes to the same pipe, readers are woken immediately. */
  private pendingPipeReaders = new Map<number, Array<{channel: ChannelInfo, pid: number}>>();
  /** Pending pipe/socket writers: sendPipeIdx → array of waiting channels.
   * When a write-like syscall returns EAGAIN on a pipe/socket fd (buffer full),
   * the writer is registered here. When a read drains the pipe, writers wake. */
  private pendingPipeWriters = new Map<number, Array<{channel: ChannelInfo, pid: number}>>();
  /** Socket timeout timers: channel → timer. When a socket read/write
   * blocks and has SO_RCVTIMEO/SO_SNDTIMEO set, a timer is scheduled
   * to complete the syscall with ETIMEDOUT. Cleared when the operation
   * completes before the timeout. */
  private socketTimeoutTimers = new Map<ChannelInfo, ReturnType<typeof setTimeout>>();
  /** Pending futex waits: channelOffset → { futexAddr, futexIndex }.
   * Tracked so SYS_THREAD_CANCEL can force-wake a futex-blocked thread
   * by firing Atomics.notify on the address it is waiting on. The waitAsync
   * Promise in handleFutex then resolves and writes the channel result. */
  private pendingFutexWaits = new Map<number, { channel: ChannelInfo; futexIndex: number }>();
  /** Channel offsets with a cancellation request pending. Set by
   * SYS_THREAD_CANCEL.  Checked at the entry of every blocking syscall
   * path (futex wait, pipe retry, poll retry) so a cancel that arrives
   * before the target actually blocks still terminates the in-flight
   * syscall instead of silently racing past it. Cleared when the cancel
   * has been serviced (target's channel completed with -EINTR / woken). */
  private pendingCancels = new Set<number>();
  /** Profiling data: syscallNr → {count, totalTimeMs, retries} */
  private profileData: Map<number, {count: number; totalTimeMs: number; retries: number}> | null =
    PROFILING ? new Map() : null;
  /** Per-process stdin buffers: pid → { data, offset } */
  private stdinBuffers = new Map<number, { data: Uint8Array; offset: number }>();
  /** Processes with finite stdin (setStdinData). Reads return EOF when buffer exhausted.
   *  Processes NOT in this set get EAGAIN (blocking) when no stdin data is available. */
  private stdinFinite = new Set<number>();
  /** Active TCP connections per process for piggyback flushing */
  private tcpConnections = new Map<number, Array<{
    sendPipeIdx: number;
    scratchOffset: number;
    clientSocket: import("net").Socket;
    recvPipeIdx: number;
    schedulePump: () => void;
  }>>();
  /** Per-process MAP_SHARED file-backed mappings: pid → Map<addr, info> */
  private sharedMappings = new Map<number, Map<number, {
    fd: number;
    fileOffset: number;
    len: number;
  }>>();
  /** Host-side mirror of epoll interest lists: "pid:epfd" → interests.
   *  Maintained by intercepting epoll_ctl results. Used by handleEpollPwait
   *  to convert epoll_pwait to poll without calling kernel_handle_channel
   *  (which crashes in Chrome for epoll_pwait due to a suspected V8 bug). */
  private epollInterests = new Map<string, Array<{ fd: number; events: number; data: bigint }>>();
  private lockTable: SharedLockTable | null = null;
  /** Per-process shared memory mappings: pid → Map<addr, {segId, size}> */
  private shmMappings = new Map<number, Map<number, { segId: number; size: number }>>();

  /** PTY index → pid mapping (for draining output after syscalls) */
  private ptyIndexByPid = new Map<number, number>();
  /** Set of active PTY indices to drain after each syscall */
  private activePtyIndices = new Set<number>();
  /** PTY output callbacks: ptyIdx → callback */
  private ptyOutputCallbacks = new Map<number, (data: Uint8Array) => void>();

  /** Virtual MAC address for this kernel instance (locally administered, unicast) */
  private virtualMacAddress: Uint8Array;

  constructor(
    private config: KernelConfig,
    private io: PlatformIO,
    private callbacks: CentralizedKernelCallbacks = {},
  ) {
    this.kernel = new WasmPosixKernel(config, io, {
      // In centralized mode, callbacks like onKill/onFork are handled
      // differently — the kernel returns EAGAIN and JS handles them.
      onStdin: (maxLen: number): Uint8Array | null => {
        const pid = this.currentHandlePid;
        const buf = this.stdinBuffers.get(pid);
        if (!buf) {
          // No buffer: finite stdin → EOF, otherwise block (EAGAIN)
          return this.stdinFinite.has(pid) ? null : new Uint8Array(0);
        }
        const remaining = buf.data.length - buf.offset;
        if (remaining <= 0) {
          this.stdinBuffers.delete(pid);
          // Buffer exhausted: finite stdin → EOF, otherwise block
          return this.stdinFinite.has(pid) ? null : new Uint8Array(0);
        }
        const n = Math.min(remaining, maxLen);
        const chunk = buf.data.subarray(buf.offset, buf.offset + n);
        buf.offset += n;
        if (buf.offset >= buf.data.length) {
          this.stdinBuffers.delete(pid);
        }
        return chunk;
      },
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
        // addr is currently informational; reserved for future per-iface filtering.
        void addr;
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

    // Generate a random virtual MAC address (locally administered, unicast)
    this.virtualMacAddress = new Uint8Array(6);
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(this.virtualMacAddress);
    } else {
      // Fallback for environments without Web Crypto API
      for (let i = 0; i < 6; i++) {
        this.virtualMacAddress[i] = Math.floor(Math.random() * 256);
      }
    }
    // Set locally administered bit, clear multicast bit
    this.virtualMacAddress[0] = (this.virtualMacAddress[0] & 0xFE) | 0x02;
  }

  /**
   * Initialize the centralized kernel.
   * Loads kernel Wasm, sets mode to centralized (1).
   */
  async init(kernelWasmBytes: BufferSource): Promise<void> {
    await this.kernel.init(kernelWasmBytes);
    this.kernelInstance = this.kernel.getInstance()!;
    this.kernelMemory = this.kernel.getMemory()!;

    // Read the kernel's advertised ABI version once at startup. Every
    // user program spawned against this kernel will have its own
    // `__abi_version` export compared against this value; mismatches
    // are refused before any syscall runs.
    const abiVersionFn =
      this.kernelInstance.exports.__abi_version as (() => number) | undefined;
    if (typeof abiVersionFn !== "function") {
      throw new Error(
        "kernel wasm is missing the __abi_version export — refusing to run. " +
          "Rebuild the kernel (bash build.sh) against the current ABI.",
      );
    }
    this.kernelAbiVersion = abiVersionFn();

    // Set centralized mode (existing call below)
    const setMode = this.kernelInstance.exports.kernel_set_mode as (mode: number) => void;
    setMode(1);

    // Allocate scratch area from the kernel's own heap allocator.
    // IMPORTANT: Do NOT use this.kernelMemory.grow() — the kernel's
    // allocator (dlmalloc) doesn't know about host-grown pages and will
    // reuse them as heap, causing corruption (overlapping writes between
    // scratch data and kernel heap structures like Vec<MappedRegion>).
    const allocScratch = this.kernelInstance.exports.kernel_alloc_scratch as (size: number) => bigint;
    this.scratchOffset = Number(allocScratch(SCRATCH_SIZE));
    if (this.scratchOffset === 0) {
      throw new Error("Failed to allocate kernel scratch buffer");
    }

    // Try to load Node.js net module for TCP bridging
    try {
      const net = await import("net");
      // Verify it's a real module (Vite externalizes it as an empty stub in browsers)
      if (typeof net.createServer === "function") {
        this.netModule = net;
      }
    } catch {
      // Not in Node.js environment — TCP bridging disabled
    }

    // Allocate a separate scratch buffer for TCP data pumping
    this.tcpScratchOffset = Number(allocScratch(65536));
    if (this.tcpScratchOffset === 0) {
      throw new Error("Failed to allocate TCP scratch buffer");
    }

    // Register a SharedLockTable so host_fcntl_lock can handle advisory locks
    // (including OFD locks) within the centralized kernel.
    this.lockTable = SharedLockTable.create();
    this.kernel.registerSharedLockTable(this.lockTable.getBuffer());

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
    options?: { skipKernelCreate?: boolean; argv?: string[]; ptrWidth?: 4 | 8 },
  ): void {
    if (!this.initialized) throw new Error("Kernel not initialized");

    // A fresh registration starts a new "generation" for this pid — even
    // if the same numeric pid was previously reaped (it can't be today
    // since nextChildPid is monotonic, but defensive), the new process
    // hasn't been reaped yet.
    this.hostReaped.delete(pid);

    // Create process in kernel's process table (skip if already created, e.g. by fork)
    if (!options?.skipKernelCreate) {
      const createProcess = this.kernelInstance!.exports.kernel_create_process as (pid: number) => number;
      const result = createProcess(pid);
      if (result < 0) {
        throw new Error(`Failed to create process ${pid}: errno ${-result}`);
      }
    }

    // Set process argv in kernel for /proc/<pid>/cmdline
    if (options?.argv && options.argv.length > 0) {
      const setArgv = this.kernelInstance!.exports.kernel_set_process_argv as
        ((pid: number, dataPtr: bigint, dataLen: number) => number) | undefined;
      if (setArgv) {
        const encoder = new TextEncoder();
        const nullSep = options.argv.join("\0");
        const encoded = encoder.encode(nullSep);
        // Write to kernel scratch area
        const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
        const scratchOffset = this.scratchOffset!;
        kernelMem.set(encoded, scratchOffset);
        setArgv(pid, BigInt(scratchOffset), encoded.length);
      }
    }

    // Cap mmap address space at the channel offset to prevent overlap
    const setMaxAddr = this.kernelInstance!.exports.kernel_set_max_addr as
      ((pid: number, maxAddr: bigint) => number) | undefined;
    if (setMaxAddr && channelOffsets.length > 0) {
      // Use the lowest channel offset as the upper bound for mmap
      const minChannelOffset = Math.min(...channelOffsets);
      setMaxAddr(pid, BigInt(minChannelOffset));
    }

    const channels: ChannelInfo[] = channelOffsets.map((offset) => ({
      pid,
      memory,
      channelOffset: offset,
      i32View: new Int32Array(memory.buffer, offset),
      consecutiveSyscalls: 0,
    }));

    const registration: ProcessRegistration = { pid, memory, channels, ptrWidth: options?.ptrWidth ?? 4 };
    this.processes.set(pid, registration);
    this.activeChannels.push(...channels);

    if (this.usePolling) {
      // Polling mode: start the poller (no per-channel listeners)
      this.startPolling();
    } else {
      // Event-driven mode: start listening on each channel
      for (const channel of channels) {
        this.listenOnChannel(channel);
      }
    }
  }

  /**
   * Provide data that will be returned when the process reads from stdin (fd 0).
   * Data is returned in chunks until exhausted, then EOF is returned.
   * Must be called before the process starts reading stdin.
   */
  setStdinData(pid: number, data: Uint8Array): void {
    this.stdinBuffers.set(pid, { data, offset: 0 });
    this.stdinFinite.add(pid); // EOF after data is consumed
    // Mark stdin as a pipe so terminal echo is disabled and isatty(0) = false
    const kernelSetStdinPipe = this.kernelInstance!.exports.kernel_set_stdin_pipe as
      ((pid: number) => number) | undefined;
    if (kernelSetStdinPipe) {
      kernelSetStdinPipe(pid);
    }
  }

  /**
   * Set stdout/stderr capture callbacks on the underlying kernel instance.
   * Must be called after construction but works at any time.
   */
  setOutputCallbacks(callbacks: {
    onStdout?: (data: Uint8Array) => void;
    onStderr?: (data: Uint8Array) => void;
  }): void {
    this.kernel.mergeCallbacks(callbacks);
  }

  /**
   * Append data to a process's stdin buffer without marking stdin as a pipe.
   * Used for interactive stdin where data arrives incrementally.
   * Wakes any blocked stdin readers after appending.
   */
  appendStdinData(pid: number, data: Uint8Array): void {
    const existing = this.stdinBuffers.get(pid);
    if (existing) {
      // Concatenate with remaining unread data
      const remaining = existing.data.subarray(existing.offset);
      const combined = new Uint8Array(remaining.length + data.length);
      combined.set(remaining);
      combined.set(data, remaining.length);
      this.stdinBuffers.set(pid, { data: combined, offset: 0 });
    } else {
      this.stdinBuffers.set(pid, { data, offset: 0 });
    }
    // Wake any blocked readers for this process
    this.scheduleWakeBlockedRetries();
  }

  // ── PTY management ──

  /**
   * Create a PTY pair and wire fds 0/1/2 of `pid` to the slave side.
   * Returns the PTY index, or throws on failure.
   */
  setupPty(pid: number): number {
    const kernelPtyCreate = this.kernelInstance!.exports.kernel_pty_create as
      ((pid: number) => number) | undefined;
    if (!kernelPtyCreate) throw new Error("Kernel missing kernel_pty_create export");
    const ptyIdx = kernelPtyCreate(pid);
    if (ptyIdx < 0) throw new Error(`kernel_pty_create failed: errno ${-ptyIdx}`);
    this.ptyIndexByPid.set(pid, ptyIdx);
    this.activePtyIndices.add(ptyIdx);
    return ptyIdx;
  }

  /**
   * Write data to a PTY master (host → line discipline → slave).
   * Wakes any process blocked on reading the slave side.
   */
  ptyMasterWrite(ptyIdx: number, data: Uint8Array): void {
    const kernelPtyMasterWrite = this.kernelInstance!.exports.kernel_pty_master_write as
      ((ptyIdx: number, bufPtr: bigint, bufLen: number) => number) | undefined;
    if (!kernelPtyMasterWrite) return;
    const buf = new Uint8Array(this.kernelMemory!.buffer);
    buf.set(data, this.scratchOffset);
    kernelPtyMasterWrite(ptyIdx, BigInt(this.scratchOffset), data.length);
    // Drain echo/output produced by the line discipline
    this.drainPtyOutput(ptyIdx);
    // Wake any process blocked on slave read
    this.scheduleWakeBlockedRetries();
  }

  /**
   * Read all available data from a PTY master (slave output → host).
   * Returns data or null if empty.
   */
  ptyMasterRead(ptyIdx: number): Uint8Array | null {
    const kernelPtyMasterRead = this.kernelInstance!.exports.kernel_pty_master_read as
      ((ptyIdx: number, bufPtr: bigint, bufLen: number) => number) | undefined;
    if (!kernelPtyMasterRead) return null;
    const SCRATCH_READ_SIZE = 4096;
    const n = kernelPtyMasterRead(ptyIdx, BigInt(this.scratchOffset), SCRATCH_READ_SIZE);
    if (n <= 0) return null;
    const buf = new Uint8Array(this.kernelMemory!.buffer);
    return buf.slice(this.scratchOffset, this.scratchOffset + n);
  }

  /**
   * Resize a PTY and send SIGWINCH to the foreground process group.
   */
  ptySetWinsize(ptyIdx: number, rows: number, cols: number): void {
    const kernelPtySetWinsize = this.kernelInstance!.exports.kernel_pty_set_winsize as
      ((ptyIdx: number, rows: number, cols: number) => number) | undefined;
    if (!kernelPtySetWinsize) return;
    kernelPtySetWinsize(ptyIdx, rows, cols);
  }

  /**
   * Register a callback for PTY output data.
   */
  onPtyOutput(ptyIdx: number, callback: (data: Uint8Array) => void): void {
    this.ptyOutputCallbacks.set(ptyIdx, callback);
  }

  /**
   * Drain output from a PTY master and invoke the registered callback.
   */
  private drainPtyOutput(ptyIdx: number): void {
    const callback = this.ptyOutputCallbacks.get(ptyIdx);
    if (!callback) return;
    for (;;) {
      const data = this.ptyMasterRead(ptyIdx);
      if (!data) break;
      callback(data);
    }
  }

  /**
   * Drain all active PTY outputs. Called after each syscall completion
   * to flush any program output produced during the syscall.
   */
  private drainAllPtyOutputs(): void {
    if (this.activePtyIndices.size === 0) return;
    for (const ptyIdx of this.activePtyIndices) {
      this.drainPtyOutput(ptyIdx);
    }
  }

  /**
   * Set the working directory for a process.
   * Must be called after registerProcess and before the process starts.
   */
  setCwd(pid: number, cwd: string): void {
    if (!this.initialized) throw new Error("Kernel not initialized");
    const kernelSetCwd = this.kernelInstance!.exports.kernel_set_cwd as
      ((pid: number, ptr: bigint, len: number) => number) | undefined;
    if (!kernelSetCwd) return; // older kernel without this export
    const encoded = new TextEncoder().encode(cwd);
    // Use the pre-allocated scratch area in kernel memory
    const buf = new Uint8Array(this.kernelMemory!.buffer);
    buf.set(encoded, this.scratchOffset);
    kernelSetCwd(pid, BigInt(this.scratchOffset), encoded.length);
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
    this.cleanupPendingPollRetries(pid);
    // Clean up pending select retries
    const selectEntry = this.pendingSelectRetries.get(pid);
    if (selectEntry?.timer) clearImmediate(selectEntry.timer);
    this.pendingSelectRetries.delete(pid);
    // Clean up pending pipe readers/writers
    this.cleanupPendingPipeReaders(pid);
    this.cleanupPendingPipeWriters(pid);
    // Clean up socket timeout timers for this process
    for (const [ch, timer] of this.socketTimeoutTimers) {
      if (ch.pid === pid) {
        clearTimeout(timer);
        this.socketTimeoutTimers.delete(ch);
      }
    }

    // Clean up epoll interest mirrors for this process
    for (const key of this.epollInterests.keys()) {
      if (key.startsWith(`${pid}:`)) {
        this.epollInterests.delete(key);
      }
    }

    // Release all advisory file locks held by this process.
    // Force-reset the spinlock first: a terminated worker may have been holding it,
    // and Atomics.wait is not allowed on the browser main thread.
    if (this.lockTable) {
      const lockBuf = this.lockTable.getBuffer();
      Atomics.store(new Int32Array(lockBuf), 0, 0); // force-release spinlock
      this.lockTable.removeLocksByPid(pid);
    }

    // Remove from kernel process table
    this.removeFromKernelProcessTable(pid);

    this.processes.delete(pid);
    this.stdinFinite.delete(pid);
    this.stdinBuffers.delete(pid);

    // Stop poller if no more processes
    if (this.usePolling && this.processes.size === 0) {
      this.stopPolling();
    }

    // Clean up PTY state
    const ptyIdx = this.ptyIndexByPid.get(pid);
    if (ptyIdx !== undefined) {
      this.ptyIndexByPid.delete(pid);
      this.activePtyIndices.delete(ptyIdx);
      this.ptyOutputCallbacks.delete(ptyIdx);
    }
  }

  /**
   * Deactivate a process's channels without removing it from the kernel
   * process table. Used for zombie processes that need to remain queryable
   * (getpgid, setpgid) until reaped by wait/waitpid.
   */
  deactivateProcess(pid: number): void {
    this.activeChannels = this.activeChannels.filter((ch) => ch.pid !== pid);
    this.processes.delete(pid);
    this.stdinFinite.delete(pid);
    this.stdinBuffers.delete(pid);
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
    this.cleanupPendingPollRetries(pid);
    // Clean up pending select retries
    const selectEntry = this.pendingSelectRetries.get(pid);
    if (selectEntry?.timer) clearImmediate(selectEntry.timer);
    this.pendingSelectRetries.delete(pid);
    // Clean up TCP listeners for this process
    this.cleanupTcpListeners(pid);
    // Clear the killed-but-not-yet-reaped guard for this pid; if the
    // pid is later reused for a fresh fork+register, the new process
    // gets its own reaping decision.
    this.hostReaped.delete(pid);
  }

  /**
   * Run kernel-side exec setup: close CLOEXEC fds, reset signal handlers.
   * Returns 0 on success, negative errno on failure.
   * Called by onExec callbacks after confirming the target program exists.
   */
  kernelExecSetup(pid: number): number {
    const fn = this.kernelInstance!.exports.kernel_exec_setup as (pid: number) => number;
    return fn(pid);
  }

  /**
   * Remove old channel/registration state for a process about to exec.
   * Does NOT remove from kernel process table (exec keeps the same pid).
   * Does NOT cancel timers (POSIX: timers are preserved across exec).
   */
  prepareProcessForExec(pid: number): void {
    // Remove channels from active list (stops listening on old memory)
    this.activeChannels = this.activeChannels.filter((ch) => ch.pid !== pid);

    // Clean up pending blocking retries (the old program's syscalls are dead)
    this.cleanupPendingPollRetries(pid);
    const selectEntry = this.pendingSelectRetries.get(pid);
    if (selectEntry?.timer) clearImmediate(selectEntry.timer);
    this.pendingSelectRetries.delete(pid);
    this.cleanupPendingPipeReaders(pid);
    this.cleanupPendingPipeWriters(pid);
    for (const [ch, timer] of this.socketTimeoutTimers) {
      if (ch.pid === pid) {
        clearTimeout(timer);
        this.socketTimeoutTimers.delete(ch);
      }
    }

    // Remove process registration (new one will be added by registerProcess)
    this.processes.delete(pid);
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
      consecutiveSyscalls: 0,
    };

    registration.channels.push(channel);
    this.activeChannels.push(channel);

    if (tid !== undefined) {
      this.channelTids.set(`${pid}:${channelOffset}`, tid);
    }

    // Lower the kernel's mmap ceiling to prevent overlap with thread TLS/channel pages.
    // Thread layout: channelOffset (2 pages), gap (1 page), TLS (1 page).
    // The TLS page is at channelOffset - 2*WASM_PAGE_SIZE, which is the lowest address used.
    const setMaxAddr = this.kernelInstance!.exports.kernel_set_max_addr as
      ((pid: number, maxAddr: bigint) => number) | undefined;
    if (setMaxAddr) {
      const tlsPageAddr = channelOffset - 2 * 65536;
      setMaxAddr(pid, BigInt(tlsPageAddr));
    }

    // In polling mode, the poller picks up new channels automatically.
    if (!this.usePolling) {
      this.listenOnChannel(channel);
    }
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
      // Handle the syscall. In browser mode (relistenBatchSize=1), defer via
      // setImmediate so that Atomics.waitAsync microtask resolutions don't
      // create tight chains that starve the event loop. In Node.js (default
      // batchSize=64), handle immediately for throughput.
      if (this.relistenBatchSize <= 1) {
        setImmediate(() => {
          if (this.processes.has(channel.pid)) {
            this.handleSyscall(channel);
          }
        });
      } else {
        this.handleSyscall(channel);
      }
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
      this.relistenChannel(channel);
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

  /** Get pointer width for a process (4=wasm32, 8=wasm64). */
  private getPtrWidth(pid: number): 4 | 8 {
    return this.processes.get(pid)?.ptrWidth ?? 4;
  }

  /** Debug: last N syscalls per pid for crash diagnosis */
  private syscallRing = new Map<number, string[]>();
  dumpLastSyscalls(pid: number): string {
    return (this.syscallRing.get(pid) ?? []).join("\n");
  }

  /** Read a null-terminated C string from process memory */
  private readCString(memory: WebAssembly.Memory, ptr: number, maxLen = 256): string {
    if (ptr === 0) return "(null)";
    const mem = new Uint8Array(memory.buffer);
    let len = 0;
    while (len < maxLen && ptr + len < mem.length && mem[ptr + len] !== 0) len++;
    // TextDecoder.decode() rejects views over SharedArrayBuffer in Chrome;
    // copy into a non-shared scratch first.
    const copy = new Uint8Array(len);
    copy.set(mem.subarray(ptr, ptr + len));
    return new TextDecoder().decode(copy);
  }

  /** Format a syscall for logging, decoding path/string args from process memory */
  private formatSyscallEntry(channel: ChannelInfo, syscallNr: number, args: number[]): string {
    const name = SYSCALL_NAMES[syscallNr] ?? `syscall_${syscallNr}`;
    const pid = channel.pid;
    const tid = this.channelTids.get(`${pid}:${channel.channelOffset}`);
    const tidSuffix = tid !== undefined ? `:t${tid}` : ``;

    // Decode args based on syscall type
    switch (syscallNr) {
      case 1: // open(path, flags, mode)
        return `[${pid}${tidSuffix}] open("${this.readCString(channel.memory, args[0])}", 0x${(args[1] >>> 0).toString(16)}, 0o${(args[2] >>> 0).toString(8)})`;
      case 69: // openat(dirfd, path, flags, mode)
        return `[${pid}${tidSuffix}] openat(${args[0]}, "${this.readCString(channel.memory, args[1])}", 0x${(args[2] >>> 0).toString(16)}, 0o${(args[3] >>> 0).toString(8)})`;
      case 11: // stat(path, buf)
        return `[${pid}${tidSuffix}] stat("${this.readCString(channel.memory, args[0])}")`;
      case 12: // lstat(path, buf)
        return `[${pid}${tidSuffix}] lstat("${this.readCString(channel.memory, args[0])}")`;
      case 93: // fstatat(dirfd, path, buf, flags)
        return `[${pid}${tidSuffix}] fstatat(${args[0]}, "${this.readCString(channel.memory, args[1])}", 0x${(args[3] >>> 0).toString(16)})`;
      case 22: // access(path, mode)
        return `[${pid}${tidSuffix}] access("${this.readCString(channel.memory, args[0])}", ${args[1]})`;
      case 97: // faccessat(dirfd, path, mode, flags)
        return `[${pid}${tidSuffix}] faccessat(${args[0]}, "${this.readCString(channel.memory, args[1])}", ${args[2]})`;
      case 24: // chdir(path)
        return `[${pid}${tidSuffix}] chdir("${this.readCString(channel.memory, args[0])}")`;
      case 25: // opendir(path)
        return `[${pid}${tidSuffix}] opendir("${this.readCString(channel.memory, args[0])}")`;
      case 19: // readlink(path, buf, bufsiz)
        return `[${pid}${tidSuffix}] readlink("${this.readCString(channel.memory, args[0])}", ${args[2]})`;
      case 102: // readlinkat(dirfd, path, buf, bufsiz)
        return `[${pid}${tidSuffix}] readlinkat(${args[0]}, "${this.readCString(channel.memory, args[1])}", ${args[3]})`;
      case 109: // realpath(path, buf, bufsiz)
        return `[${pid}${tidSuffix}] realpath("${this.readCString(channel.memory, args[0])}")`;
      case 3: // read(fd, buf, count)
        return `[${pid}${tidSuffix}] read(${args[0]}, ${args[2]})`;
      case 4: // write(fd, buf, count)
        return `[${pid}${tidSuffix}] write(${args[0]}, ${args[2]})`;
      case 2: // close(fd)
        return `[${pid}${tidSuffix}] close(${args[0]})`;
      case 6: // fstat(fd, buf)
        return `[${pid}${tidSuffix}] fstat(${args[0]})`;
      case 10: // fcntl(fd, cmd, arg)
        return `[${pid}${tidSuffix}] fcntl(${args[0]}, ${args[1]}, ${args[2]})`;
      case 46: // mmap(addr, len, prot, flags, fd, offset)
        return `[${pid}${tidSuffix}] mmap(0x${(args[0] >>> 0).toString(16)}, ${args[1] >>> 0}, ${args[2]}, 0x${(args[3] >>> 0).toString(16)}, ${args[4]}, ${args[5] >>> 0})`;
      case 47: // munmap(addr, len)
        return `[${pid}${tidSuffix}] munmap(0x${(args[0] >>> 0).toString(16)}, ${args[1] >>> 0})`;
      case 48: // brk(addr)
        return `[${pid}${tidSuffix}] brk(0x${(args[0] >>> 0).toString(16)})`;
      case 211: // execve(path, argv, envp)
        return `[${pid}${tidSuffix}] execve("${this.readCString(channel.memory, args[0])}")`;
      case 212: return `[${pid}${tidSuffix}] fork()`;
      case 213: return `[${pid}${tidSuffix}] vfork()`;
      case 201: // clone(flags, stack, ptid, tls, ctid)
        return `[${pid}${tidSuffix}] clone(0x${(args[0] >>> 0).toString(16)})`;
      case 34: return `[${pid}${tidSuffix}] exit(${args[0]})`;
      case 60: // poll(fds, nfds, timeout)
        return `[${pid}${tidSuffix}] poll(${args[1]}, ${args[2]})`;
      case 72: // ioctl(fd, cmd, arg)
        return `[${pid}${tidSuffix}] ioctl(${args[0]}, 0x${(args[1] >>> 0).toString(16)})`;
      default:
        return `[${pid}${tidSuffix}] ${name}(${args.filter((_, i) => i < 3).join(", ")})`;
    }
  }

  /** Format a syscall return value for logging */
  private formatSyscallReturn(syscallNr: number, retVal: number, errVal: number): string {
    if (retVal < 0 || errVal !== 0) {
      const errName = ERRNO_NAMES[errVal] ?? `errno=${errVal}`;
      return ` = ${retVal} (${errName})`;
    }
    // Format return value based on syscall type
    switch (syscallNr) {
      case 46: // mmap
        return ` = 0x${(retVal >>> 0).toString(16)}`;
      case 48: // brk
        return ` = 0x${(retVal >>> 0).toString(16)}`;
      default:
        return ` = ${retVal}`;
    }
  }

  private handleSyscall(channel: ChannelInfo): void {
    try {
      if (PROFILING) {
        const pv = new DataView(channel.memory.buffer, channel.channelOffset);
        const nr = pv.getUint32(CH_SYSCALL, true);
        const start = performance.now();
        this._handleSyscallInner(channel);
        const elapsed = performance.now() - start;
        let entry = this.profileData!.get(nr);
        if (!entry) {
          entry = { count: 0, totalTimeMs: 0, retries: 0 };
          this.profileData!.set(nr, entry);
        }
        entry.count++;
        entry.totalTimeMs += elapsed;
        return;
      }
      this._handleSyscallInner(channel);
    } catch (err) {
      console.error(`[handleSyscall] UNCAUGHT ERROR pid=${channel.pid}:`, err);
      // Complete channel with EIO to unblock the process
      this.completeChannelRaw(channel, -5, 5);
      this.relistenChannel(channel);
    }
  }

  private _handleSyscallInner(channel: ChannelInfo): void {
    const processView = new DataView(channel.memory.buffer, channel.channelOffset);

    // Read syscall number and args from process channel
    const syscallNr = processView.getUint32(CH_SYSCALL, true);
    const origArgs: number[] = [];
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      origArgs.push(Number(processView.getBigInt64(CH_ARGS + i * CH_ARG_SIZE, true)));
    }

    // Track last 30 syscalls per channel for crash diagnostics
    const ringKey = channel.channelOffset;
    let ring = this.syscallRing.get(ringKey);
    if (!ring) { ring = []; this.syscallRing.set(ringKey, ring); }
    ring.push(`  syscall=${syscallNr} args=[${origArgs.join(',')}]`);
    if (ring.length > 30) ring.shift();

    // Syscall logging (enable globally via enableSyscallLog, or filter by
    // process pointer width via syscallLogPtrWidth — useful when a single
    // wasm64 process in a mixed-arch demo needs a focused trace).
    const widthFilter = this.config.syscallLogPtrWidth;
    const matchesWidthFilter = widthFilter !== undefined
      && this.processes.get(channel.pid)?.ptrWidth === widthFilter;
    const logging = !!this.config.enableSyscallLog || matchesWidthFilter;
    let logEntry = "";
    if (logging) {
      logEntry = this.formatSyscallEntry(channel, syscallNr, origArgs);
    }

    // --- Intercept fork/exec/clone/exit before calling kernel ---
    // These syscalls need special async handling that can't go through
    // the blocking host_fork/host_exec imports.

    if (syscallNr === SYS_FORK || syscallNr === SYS_VFORK) {
      if (logging) console.error(logEntry);
      this.handleFork(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_EXECVE) {
      if (logging) console.error(logEntry);
      this.handleExec(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_EXECVEAT) {
      if (logging) console.error(logEntry);
      this.handleExecveat(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_CLONE) {
      if (logging) console.error(logEntry);
      this.handleClone(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_EXIT || syscallNr === SYS_EXIT_GROUP) {
      if (logging) console.error(logEntry);
      this.handleExit(channel, syscallNr, origArgs);
      return;
    }

    if (syscallNr === SYS_WAIT4) {
      if (logging) console.error(logEntry);
      this.handleWaitpid(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_WAITID) {
      if (logging) console.error(logEntry);
      this.handleWaitid(channel, origArgs);
      return;
    }

    // --- Futex: must operate on process memory, not kernel memory ---
    // The kernel's host_futex_wake/wait imports use kernel memory, but in
    // centralized mode the futex address is in process memory. Intercept
    // here and handle directly.
    if (syscallNr === SYS_FUTEX) {
      if (logging) {
        // Futex args: (uaddr, op, val, timeout, uaddr2, val3). Decode the op
        // to make hung-thread investigations readable.
        const FUTEX_OPS: Record<number, string> = {
          0: "WAIT", 1: "WAKE", 2: "FD", 3: "REQUEUE", 4: "CMP_REQUEUE",
          5: "WAKE_OP", 6: "LOCK_PI", 7: "UNLOCK_PI", 8: "TRYLOCK_PI",
          9: "WAIT_BITSET", 10: "WAKE_BITSET", 11: "WAIT_REQUEUE_PI",
          12: "CMP_REQUEUE_PI",
        };
        const FUTEX_PRIVATE_FLAG = 128;
        const FUTEX_CLOCK_REALTIME = 256;
        const op = origArgs[1] >>> 0;
        const cmd = op & ~(FUTEX_PRIVATE_FLAG | FUTEX_CLOCK_REALTIME);
        const opName = FUTEX_OPS[cmd] ?? `op${cmd}`;
        const flags = (op & FUTEX_PRIVATE_FLAG ? "|PRIVATE" : "")
          + (op & FUTEX_CLOCK_REALTIME ? "|REALTIME" : "");
        const tid = this.channelTids.get(`${channel.pid}:${channel.channelOffset}`);
        const tidSuffix = tid !== undefined ? `:t${tid}` : ``;
        console.error(`[${channel.pid}${tidSuffix}] futex(0x${(origArgs[0] >>> 0).toString(16)}, ${opName}${flags}, val=${origArgs[2]})`);
      }
      this.handleFutex(channel, origArgs);
      return;
    }

    // --- pthread_cancel wake-up: handled entirely on host side because
    // the state we must perturb (futex waitAsync, pipe reader registration,
    // poll/select retry timers) lives in TS, not in the kernel wasm. ---
    if (syscallNr === SYS_THREAD_CANCEL) {
      if (logging) console.error(logEntry);
      this.handleThreadCancel(channel, origArgs);
      return;
    }

    // --- Scatter/gather I/O (writev/readv/pwritev/preadv) ---
    // These have nested pointers (iov array → base buffers) that can't be
    // handled by the simple ArgDesc system.
    if (syscallNr === SYS_WRITEV || syscallNr === SYS_PWRITEV) {
      if (logging) console.error(logEntry);
      this.handleWritev(channel, syscallNr, origArgs);
      return;
    }

    if (syscallNr === SYS_READV || syscallNr === SYS_PREADV) {
      if (logging) console.error(logEntry);
      this.handleReadv(channel, syscallNr, origArgs);
      return;
    }

    // --- Large write/pwrite/read/pread: chunk through scratch buffer ---
    // When the data exceeds CH_DATA_SIZE, the ArgDesc path returns a short
    // read/write. Programs like InnoDB that write 1MB+ chunks may exhaust
    // their retry budget. Handle large I/O by looping on the host side.
    if ((syscallNr === SYS_WRITE || syscallNr === SYS_PWRITE) && origArgs[2] > CH_DATA_SIZE) {
      this.handleLargeWrite(channel, syscallNr, origArgs);
      return;
    }
    if ((syscallNr === 3 /* SYS_READ */ || syscallNr === SYS_PREAD) && origArgs[2] > CH_DATA_SIZE) {
      this.handleLargeRead(channel, syscallNr, origArgs);
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

    // --- ioctl: intercept network interface ioctls (SIOCGIFCONF, SIOCGIFHWADDR) ---
    // These require host-side handling because:
    //   SIOCGIFCONF: struct ifconf contains a pointer to a process-memory buffer
    //   SIOCGIFHWADDR: returns the virtual MAC address for this kernel instance
    if (syscallNr === SYS_IOCTL) {
      const request = origArgs[1] >>> 0;
      if (request === SIOCGIFCONF) {
        this.handleIoctlIfconf(channel, origArgs);
        return;
      }
      if (request === SIOCGIFHWADDR) {
        this.handleIoctlIfhwaddr(channel, origArgs);
        return;
      }
      if (request === SIOCGIFADDR) {
        this.handleIoctlIfaddr(channel, origArgs);
        return;
      }
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

    // --- epoll: intercept all epoll syscalls on host side ---
    // kernel_handle_channel crashes in Chrome (V8 shared-memory Wasm bug) for
    // epoll_pwait.  Handle epoll_create1/ctl on the kernel but mirror the
    // interest list, and convert epoll_pwait to poll entirely on the host.
    if (syscallNr === SYS_EPOLL_CREATE1 || syscallNr === SYS_EPOLL_CREATE) {
      this.handleEpollCreate(channel, syscallNr, origArgs);
      return;
    }
    if (syscallNr === SYS_EPOLL_CTL) {
      this.handleEpollCtl(channel, origArgs);
      return;
    }
    if (syscallNr === SYS_EPOLL_PWAIT || syscallNr === SYS_EPOLL_WAIT) {
      this.handleEpollPwait(channel, syscallNr, origArgs);
      return;
    }

    // --- SysV IPC: shmat/shmdt need host-side process memory management ---
    if (syscallNr === SYS_SHMAT) {
      this.handleIpcShmat(channel, origArgs);
      return;
    }
    if (syscallNr === SYS_SHMDT) {
      this.handleIpcShmdt(channel, origArgs);
      return;
    }
    // --- SysV IPC: semctl has cmd-dependent arg types (scalar vs pointer) ---
    if (syscallNr === SYS_SEMCTL) {
      this.handleSemctl(channel, origArgs);
      return;
    }

    // (POSIX mqueue syscalls 331-336 now go through the normal kernel path)

    // --- pselect6: fd_sets (inout) + timeout/sigmask decoding ---
    if (syscallNr === SYS_PSELECT6) {
      this.handlePselect6(channel, origArgs);
      return;
    }

    // --- select(2): same shape as pselect6 but with `struct timeval`
    // (sec, usec) and no sigmask. musl's select.c routes here on wasm64
    // because `__NR_pselect6_time64` isn't defined for that arch (unlike
    // wasm32, which aliases it to __NR_pselect6). Without this intercept,
    // sys_select returns EAGAIN unconditionally in centralized mode and
    // the generic blocking-retry has no select-timeout awareness — every
    // `select(0,0,0,0,&tv)` (= my_sleep) becomes an infinite loop. That
    // surfaced as the wasm64 mariadbd boot hang at
    // wait_for_signal_thread_to_end's kill+my_sleep loop.
    if (syscallNr === SYS_SELECT) {
      this.handleSelect(channel, origArgs);
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
          // Special cases: struct size multipliers and prefixes
          if (syscallNr === SYS_POLL || syscallNr === SYS_PPOLL) size *= 8;   // pollfd = 8 bytes
          if (syscallNr === SYS_MSGSND || syscallNr === SYS_MSGRCV) size += 4; // mtype (long) prefix
          if (syscallNr === SYS_SEMOP) size *= 6;   // struct sembuf = 6 bytes
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
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, BigInt(adjustedArgs[i]), true);
    }

    // Call kernel_handle_channel
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    // DIAGNOSTIC: globalThis.__sysprof aggregates per-(pid,syscall_nr)
    // timing across kernel_handle_channel calls so we can dump a profile
    // afterward (via globalThis.__sysprofDump()). Off by default — flip on
    // from the demo page right before the slow operation, off after.
    // Also tracks wall-clock gap since *this* pid's previous syscall — that
    // gap is the time the pid spent in user wasm code, the actual perf
    // bottleneck when kernel-side handling itself is fast.
    const sysprof = (globalThis as { __sysprof?: boolean }).__sysprof;
    const sysprofStart = sysprof ? performance.now() : 0;
    if (sysprof) {
      type GapRow = { count: number; gapTotalMs: number; gapMaxMs: number };
      const g = globalThis as { __sysprofGap?: Map<number, GapRow>; __sysprofLastSeen?: Map<number, number> };
      if (!g.__sysprofGap) g.__sysprofGap = new Map();
      if (!g.__sysprofLastSeen) g.__sysprofLastSeen = new Map();
      const last = g.__sysprofLastSeen.get(channel.pid);
      if (last !== undefined) {
        const gap = sysprofStart - last;
        let row = g.__sysprofGap.get(channel.pid);
        if (!row) { row = { count: 0, gapTotalMs: 0, gapMaxMs: 0 }; g.__sysprofGap.set(channel.pid, row); }
        row.count++;
        row.gapTotalMs += gap;
        if (gap > row.gapMaxMs) row.gapMaxMs = gap;
      }
      g.__sysprofLastSeen.set(channel.pid, sysprofStart);
    }
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } catch (err) {
      // If the kernel throws (e.g., invalid memory access), complete the
      // channel with -EIO to unblock the process rather than deadlocking.
      if (logging) console.error(logEntry + " = KERNEL THROW");
      console.error(`[handleSyscall] kernel threw for pid=${channel.pid} syscall=${syscallNr} args=[${origArgs}]:`, err);
      this.completeChannelRaw(channel, -5, 5); // -EIO
      this.relistenChannel(channel);
      return;
    } finally {
      this.currentHandlePid = 0;
      if (sysprof) {
        const elapsed = performance.now() - sysprofStart;
        type ProfRow = { count: number; totalMs: number; maxMs: number };
        const g = globalThis as { __sysprofTable?: Map<string, ProfRow> };
        if (!g.__sysprofTable) g.__sysprofTable = new Map();
        const key = `${channel.pid}:${syscallNr}`;
        let row = g.__sysprofTable.get(key);
        if (!row) { row = { count: 0, totalMs: 0, maxMs: 0 }; g.__sysprofTable.set(key, row); }
        row.count++;
        row.totalMs += elapsed;
        if (elapsed > row.maxMs) row.maxMs = elapsed;
        if (elapsed > 50) {
          console.warn(`[sysprof] slow pid=${channel.pid} nr=${syscallNr} ${elapsed.toFixed(1)}ms args=[${origArgs.join(',')}]`);
        }
      }
    }

    // Read return value and errno from kernel scratch
    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // --- Process memory growth for brk/mmap/mremap ---
    // In centralized mode, the kernel's ensure_memory_covers() grows the
    // KERNEL's Wasm memory, not the process's. We must grow the process's
    // WebAssembly.Memory here so the process can access the new addresses.
    if (retVal > 0) {
      this.ensureProcessMemoryCovers(channel.memory, syscallNr, retVal, origArgs);
    }

    // --- DEBUG: detect memory operations in thread region ---
    if (syscallNr === SYS_MMAP && retVal > 0 && (retVal >>> 0) !== 0xffffffff) {
      const mmapAddr = retVal >>> 0;
      const mmapLen = origArgs[1] >>> 0;
      if (mmapAddr + mmapLen > 0x3fdc0000) {
        console.error(`[MMAP ALERT] pid=${channel.pid} mmap returned 0x${mmapAddr.toString(16)} len=${mmapLen} — OVERLAPS THREAD REGION! args=[${origArgs.map(a => '0x' + (a >>> 0).toString(16)).join(',')}]`);
      }
    }
    if (syscallNr === SYS_MREMAP && retVal > 0 && (retVal >>> 0) !== 0xffffffff) {
      const mremapAddr = retVal >>> 0;
      const mremapLen = origArgs[2] >>> 0;
      if (mremapAddr + mremapLen > 0x3fdc0000) {
        console.error(`[MREMAP ALERT] pid=${channel.pid} mremap returned 0x${mremapAddr.toString(16)} len=${mremapLen} — OVERLAPS THREAD REGION!`);
      }
    }
    if (syscallNr === SYS_BRK && retVal > 0x3fdc0000) {
      console.error(`[BRK ALERT] pid=${channel.pid} brk returned 0x${(retVal >>> 0).toString(16)} — IN THREAD REGION!`);
    }

    // --- File-backed mmap: populate mapped region with file data ---
    if (syscallNr === SYS_MMAP && retVal > 0 && (retVal >>> 0) !== 0xffffffff) {
      const mmapFd = origArgs[4];
      const mmapFlags = origArgs[3] >>> 0;
      if (mmapFd >= 0 && (mmapFlags & MAP_ANONYMOUS) === 0) {
        this.populateMmapFromFile(channel, retVal >>> 0, origArgs);
        // Track MAP_SHARED file-backed mappings for msync writeback
        if (mmapFlags & MAP_SHARED) {
          const pageOffset = origArgs[5] >>> 0;
          let pidMap = this.sharedMappings.get(channel.pid);
          if (!pidMap) {
            pidMap = new Map();
            this.sharedMappings.set(channel.pid, pidMap);
          }
          pidMap.set(retVal >>> 0, {
            fd: mmapFd,
            fileOffset: pageOffset * 4096,
            len: origArgs[1] >>> 0,
          });
        }
      }
    }

    // --- msync: flush MAP_SHARED regions back to file ---
    if (syscallNr === SYS_MSYNC && retVal === 0) {
      this.flushSharedMappings(channel, origArgs);
    }

    // --- munmap: clean up shared mapping tracking ---
    if (syscallNr === SYS_MUNMAP && retVal === 0) {
      this.cleanupSharedMappings(channel.pid, origArgs[0] >>> 0, origArgs[1] >>> 0);
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

    // --- POSIX mqueue notification (centralized mode) ---
    // After mq_timedsend, the kernel may have a pending notification (signal
    // to deliver when a message arrives on a previously empty queue).
    if (syscallNr === SYS_MQ_TIMEDSEND && retVal === 0) {
      this.drainMqueueNotification();
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
      if (logging) {
        console.error(logEntry + " = -1 (EAGAIN, will retry)");
      }
      this.handleBlockingRetry(channel, syscallNr, origArgs);
      return;
    }

    // 2. Sleep syscalls: kernel returned success immediately, but we need
    //    to delay the response to simulate the sleep duration.
    if (this.handleSleepDelay(channel, syscallNr, origArgs, retVal, errVal)) {
      return;
    }

    // --- Process group change: re-check deferred waitpid calls ---
    // When a process changes its pgid (setpgid/setsid), a parent blocked in
    // waitpid(-pgid) may no longer have any matching children. Wake it with ECHILD.
    if (errVal === 0 && (syscallNr === SYS_SETPGID || syscallNr === SYS_SETSID)) {
      this.recheckDeferredWaitpids();
    }

    // --- Cross-process signal delivery: wake blocked peers + reap kills ---
    // When a guest calls kill() on another process (or a process group),
    // kernel_kill may invoke deliver_pending_signals on each target. If the
    // default action is Terminate (e.g., SIGTERM with no handler), the target
    // is marked Exited in its Process struct.
    //
    // Two follow-ups are required:
    //   (a) Wake any blocked syscalls on the target (pipe/poll/select) so
    //       their handlers observe the new exit state and complete with the
    //       right errno (handled by scheduleWakeBlockedRetries).
    //   (b) For any process the kernel marked Exited but that is still
    //       blocked in a non-blocking-retry path (most importantly
    //       pendingSleeps), call handleProcessTerminated directly so the
    //       parent's wait4 actually sees the killed child. Without this,
    //       a `kill` of a sleeping child silently reaps the process at the
    //       kernel level but leaves it in parentToChildren forever — the
    //       parent's wait4(-1) then blocks indefinitely.
    if (errVal === 0 && syscallNr === SYS_KILL) {
      this.scheduleWakeBlockedRetries();
      this.reapKilledProcessesAfterSyscall();
    }


    // --- Normal completion ---
    if (logging) {
      console.error(logEntry + this.formatSyscallReturn(syscallNr, retVal, errVal));
    }
    this.completeChannel(channel, syscallNr, origArgs, argDescs, retVal, errVal);
  }

  /**
   * Dequeue one pending Handler signal from the kernel and write delivery
   * info to the process channel. The glue code (channel_syscall.c) reads
   * this after the syscall returns and invokes the handler.
   */
  private dequeueSignalForDelivery(channel: ChannelInfo): void {
    const dequeueSignal = this.kernelInstance!.exports
      .kernel_dequeue_signal as ((pid: number, outPtr: bigint) => number) | undefined;
    if (!dequeueSignal) return;

    // Use the signal area in kernel scratch as the output buffer
    const sigOutOffset = this.scratchOffset + CH_SIG_BASE;
    const sigResult = dequeueSignal(channel.pid, BigInt(sigOutOffset));
    if (sigResult > 0) {
      // Copy 44 bytes of signal delivery info from kernel scratch to process channel
      // Layout: signum(4) + handler(4) + flags(4) + si_value(4) + old_mask(8)
      //       + si_code(4) + si_pid(4) + si_uid(4) + alt_sp(4) + alt_size(4) = 44 bytes
      const kernelMem = this.getKernelMem();
      const processMem = new Uint8Array(channel.memory.buffer);
      processMem.set(
        kernelMem.subarray(sigOutOffset, sigOutOffset + 44),
        channel.channelOffset + CH_SIG_BASE,
      );
    } else {
      // Clear entire signal delivery area in process channel (48 bytes)
      const sigStart = channel.channelOffset + CH_SIG_BASE;
      new Uint8Array(channel.memory.buffer, sigStart, 48).fill(0);
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
          if (syscallNr === SYS_EPOLL_PWAIT) size *= 12;
          if (syscallNr === SYS_MSGSND || syscallNr === SYS_MSGRCV) size += 4; // mtype prefix
          if (syscallNr === SYS_SEMOP) size *= 6;  // struct sembuf = 6 bytes
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
          // Don't copy pure "out" data back when the syscall failed — the
          // kernel scratch was zeroed in the input phase and the kernel
          // didn't produce any output.  Copying zeros back would corrupt
          // the caller's buffer (e.g. readlink overwrites a valid path
          // with zeros when the target isn't a symlink).
          if (desc.direction === "out" && retVal < 0) {
            outOffset += size;
            outOffset = (outOffset + 3) & ~3;
            continue;
          }
          let copySize = size;
          if (desc.direction === "out" && desc.size.type === "arg") {
            // For read/recv-like syscalls, retVal is bytes read — limit copy to actual data
            if (retVal > 0 && retVal < size) {
              copySize = retVal;
              // msgrcv retVal is mtext length, but scratch also has mtype (4B) prefix
              if (syscallNr === SYS_MSGRCV) copySize += 4;
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

    // Clear handling flag (channel is done — poller can pick it up for next syscall)
    channel.handling = false;

    // Write result to process channel
    processView.setBigInt64(CH_RETURN, BigInt(retVal), true);
    processView.setUint32(CH_ERRNO, errVal, true);

    // Cancel any pending socket timeout timer for this channel
    this.clearSocketTimeout(channel);

    // Drain PTY output buffers before notifying the process — slave writes
    // produce data in the PTY output_buf that needs to reach the host (xterm.js).
    this.drainAllPtyOutputs();

    // Flush TCP send pipes before notifying the process — gets PHP's
    // response data to the browser without waiting for the next pump cycle
    this.flushTcpSendPipes(channel.pid);

    // Set status to COMPLETE and notify process
    const i32View = new Int32Array(channel.memory.buffer, channel.channelOffset);
    Atomics.store(i32View, CH_STATUS / 4, CH_COMPLETE);
    Atomics.notify(i32View, CH_STATUS / 4, 1);


    // Drain kernel wakeup events and process targeted wakeups.
    this.drainAndProcessWakeupEvents();

    // Re-listen for next syscall
    this.relistenChannel(channel);
  }

  /**
   * Schedule re-listen on a channel.
   *
   * Uses queueMicrotask for speed (near-zero delay between syscalls).
   * Every Nth call (relistenBatchSize), yields via setImmediate so timer
   * callbacks (setTimeout/setInterval) can fire — prevents event loop
   * starvation while keeping throughput close to Node.js native setImmediate.
   *
   * In the browser (main thread), set relistenBatchSize=1 so every syscall
   * yields via setImmediate. The browser setImmediate polyfill (MessageChannel)
   * batches these efficiently while still allowing rendering frames between
   * batches. Without this, microtask chains from multi-threaded programs
   * (e.g. MariaDB's 5 threads) starve requestAnimationFrame and rendering.
   */
  private relistenCount = 0;
  /** How many syscalls to process via microtask before yielding to the event
   *  loop via setImmediate. Default 64 is optimal for Node.js. Set to 1 in
   *  browser environments where the kernel runs on the main thread. */
  relistenBatchSize = 64;

  /**
   * When true, use a MessageChannel-based poller to check all channels
   * instead of per-channel Atomics.waitAsync listeners.
   *
   * This avoids a V8 bug where Atomics.waitAsync microtask chains from
   * multiple concurrent processes freeze the main thread. The poller
   * uses MessageChannel for ~0ms dispatch (bypassing the browser's 4ms
   * timer clamp on setTimeout/setInterval), with periodic setTimeout
   * yields every 4ms to keep timers and rendering alive.
   *
   * Enable this in browser environments where the kernel runs on the
   * main thread. In Node.js (where setImmediate is native), the default
   * event-driven mode (Atomics.waitAsync) is preferred.
   */
  usePolling = false;
  private pollMC: MessageChannel | null = null;
  private pollScheduled = false;
  private pollLastYield = 0;

  /** Start the channel poller. Called automatically when usePolling=true
   *  and a process is registered. */
  private startPolling(): void {
    if (this.pollMC !== null) return;
    this.pollMC = new MessageChannel();
    this.pollMC.port1.onmessage = () => this.pollTick();
    this.pollLastYield = performance.now();
    this.schedulePoll();
  }

  /** Stop the channel poller. Called when all processes are unregistered. */
  private stopPolling(): void {
    if (this.pollMC !== null) {
      this.pollMC.port1.close();
      this.pollMC = null;
      this.pollScheduled = false;
    }
  }

  /** Schedule the next poll tick. Uses MessageChannel for ~0ms dispatch,
   *  with a setTimeout yield every 4ms to prevent timer starvation. */
  private schedulePoll(): void {
    if (this.pollScheduled || !this.pollMC) return;
    this.pollScheduled = true;
    const now = performance.now();
    if (now - this.pollLastYield >= 4) {
      // Yield to timers/rendering
      this.pollLastYield = now;
      setTimeout(() => {
        this.pollScheduled = false;
        this.pollTick();
      }, 0);
    } else {
      this.pollMC.port2.postMessage(null);
    }
  }

  /** Poll all active channels for PENDING syscalls. */
  private pollTick(): void {
    this.pollScheduled = false;
    if (!this.pollMC || this.activeChannels.length === 0) return;

    // Snapshot to handle mutations during iteration (addChannel/removeChannel)
    const channels = this.activeChannels.slice();
    for (const channel of channels) {
      if (channel.handling) continue;
      // Re-create view in case memory was grown
      const i32View = new Int32Array(channel.memory.buffer, channel.channelOffset);
      channel.i32View = i32View;
      if (Atomics.load(i32View, 0) === CH_PENDING) {
        channel.handling = true;
        this.handleSyscall(channel);
      }
    }

    this.schedulePoll();
  }

  private relistenChannel(channel: ChannelInfo): void {
    // Clear handling flag so the poller can pick up this channel again
    channel.handling = false;
    if (!this.processes.has(channel.pid)) return;
    // In polling mode, don't re-listen — the poller will pick up the next syscall
    if (this.usePolling) return;
    this.relistenCount++;
    const useImmediate = this.relistenCount >= this.relistenBatchSize;
    if (useImmediate) {
      this.relistenCount = 0;
      setImmediate(() => this.listenOnChannel(channel));
    } else {
      queueMicrotask(() => this.listenOnChannel(channel));
    }
  }

  /**
   * Complete a channel with just return value and errno (no scatter/gather).
   * Used for thread exit where we need to unblock the worker.
   */
  private completeChannelRaw(channel: ChannelInfo, retVal: number, errVal: number): void {
    // Clear handling flag (channel is done — poller can pick it up for next syscall)
    channel.handling = false;

    const processView = new DataView(channel.memory.buffer, channel.channelOffset);
    processView.setBigInt64(CH_RETURN, BigInt(retVal), true);
    processView.setUint32(CH_ERRNO, errVal, true);

    // Cancel any pending socket timeout timer for this channel
    this.clearSocketTimeout(channel);

    // Clear any one-shot pthread cancel flag: it was meant for the
    // syscall we're completing now. Leaving it armed would let the next
    // blocking entry spuriously EINTR even if no further cancel arrived.
    this.pendingCancels.delete(channel.channelOffset);

    const i32View = new Int32Array(channel.memory.buffer, channel.channelOffset);
    Atomics.store(i32View, CH_STATUS / 4, CH_COMPLETE);
    Atomics.notify(i32View, CH_STATUS / 4, 1);
  }

  /**
   * Handle EAGAIN retry for blocking syscalls.
   * The process stays blocked while we retry asynchronously.
   */
  private resolvePollPipeIndices(pid: number, origArgs: number[], syscallNr: number): number[] {
    // Prefer kernel_get_fd_pipe_idx which handles both pipes AND sockets.
    // Fall back to kernel_get_socket_recv_pipe for older kernels.
    const getFdPipeIdx = this.kernelInstance!.exports.kernel_get_fd_pipe_idx as
      ((pid: number, fd: number) => number) | undefined;
    const getRecvPipe = getFdPipeIdx ?? (this.kernelInstance!.exports.kernel_get_socket_recv_pipe as
      ((pid: number, fd: number) => number) | undefined);
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

  private resolveEpollPipeIndices(pid: number): number[] {
    const getRecvPipe = this.kernelInstance!.exports.kernel_get_socket_recv_pipe as
      ((pid: number, fd: number) => number) | undefined;
    if (!getRecvPipe) return [];

    const key = `${pid}:`;
    const indices: number[] = [];
    for (const [k, interests] of this.epollInterests) {
      if (!k.startsWith(key)) continue;
      for (const interest of interests) {
        const pipeIdx = getRecvPipe(pid, interest.fd);
        if (pipeIdx >= 0) {
          indices.push(pipeIdx);
        }
      }
    }
    return indices;
  }

  private wakeBlockedPoll(pid: number, pipeIdx: number): void {
    for (const [key, entry] of this.pendingPollRetries) {
      if (entry.channel.pid !== pid) continue;
      if (!entry.pipeIndices.includes(pipeIdx)) continue;

      // Cancel the scheduled retry and fire immediately
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      this.pendingPollRetries.delete(key);
      if (this.processes.has(pid)) {
        this.retrySyscall(entry.channel);
      }
    }
  }

  /**
   * Public wake helper for host-side pipe writes (TCP bridges, HTTP
   * bridges, etc.). Call this AFTER directly writing into a pipe via
   * `kernel_pipe_write` or `kernel_inject_connection`.
   *
   * In order:
   *   1. Wake any process blocked in read/recv on this pipe
   *      (`pendingPipeReaders`).
   *   2. Wake any process blocked in poll/ppoll/pselect6 whose
   *      `pipeIndices` includes this pipe (`pendingPollRetries`).
   *      Pass `pidFilter` to restrict the wake to a single owning
   *      pid — used by the Node TCP bridge when dispatching an
   *      inbound connection to a specific listener.
   *   3. Schedule a broad wake (`scheduleWakeBlockedRetries`) for
   *      everything else.
   *
   * Without step 2, blocked pollers wait for the fallback timer in
   * `handleBlockingRetry` to fire, which is the bug behind PR fixing
   * the WordPress LAMP demo's slow install.php (see commit history).
   */
  public notifyPipeReadable(pipeIdx: number, pidFilter?: number): void {
    // 1. Blocked readers
    const readers = this.pendingPipeReaders.get(pipeIdx);
    if (readers && readers.length > 0) {
      this.pendingPipeReaders.delete(pipeIdx);
      for (const reader of readers) {
        if (this.processes.has(reader.pid)) {
          this.retrySyscall(reader.channel);
        }
      }
    }
    // 2. Blocked pollers watching this pipe
    for (const [key, entry] of this.pendingPollRetries) {
      if (pidFilter !== undefined && entry.channel.pid !== pidFilter) continue;
      if (!entry.pipeIndices.includes(pipeIdx)) continue;
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.pendingPollRetries.delete(key);
      if (this.processes.has(entry.channel.pid)) {
        this.retrySyscall(entry.channel);
      }
    }
    // 3. Broad wake for any other pending retries
    this.scheduleWakeBlockedRetries();
  }

  /**
   * Public wake helper for host-side pipe reads (response pump in
   * the TCP/HTTP bridges). Call this AFTER directly reading data
   * from a pipe so any process blocked writing because the pipe was
   * full can resume, plus a broad wake.
   */
  public notifyPipeWritable(pipeIdx: number): void {
    const writers = this.pendingPipeWriters.get(pipeIdx);
    if (writers && writers.length > 0) {
      this.pendingPipeWriters.delete(pipeIdx);
      for (const writer of writers) {
        if (this.processes.has(writer.pid)) {
          this.retrySyscall(writer.channel);
        }
      }
    }
    this.scheduleWakeBlockedRetries();
  }

  /** Cancel all pending poll retries for a given pid (used during cleanup) */
  private cleanupPendingPollRetries(pid: number): void {
    for (const [key, entry] of this.pendingPollRetries) {
      if (entry.channel.pid === pid) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingPollRetries.delete(key);
      }
    }
  }

  /**
   * Drain kernel wakeup events and process targeted pipe wakeups.
   * Called after each syscall completion. The kernel pushes events from
   * PipeBuffer operations (read/write/close). Each event identifies a pipe
   * and whether it became readable or writable.
   */
  private drainAndProcessWakeupEvents(): void {
    const drainFn = this.kernelInstance!.exports.kernel_drain_wakeup_events as
      ((outPtr: bigint, outLen: number, maxEvents: number) => number) | undefined;
    if (!drainFn) return;

    const MAX_EVENTS = 256;
    const BYTES_PER_EVENT = 5;
    const bufSize = MAX_EVENTS * BYTES_PER_EVENT;

    const count = drainFn(BigInt(this.scratchOffset), bufSize, MAX_EVENTS);
    if (count === 0) return;

    const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
    const WAKE_READABLE = 1;
    const WAKE_WRITABLE = 2;
    let needBroadWake = false;

    for (let i = 0; i < count; i++) {
      const off = this.scratchOffset + i * BYTES_PER_EVENT;
      const pipeIdx = kernelMem[off] | (kernelMem[off + 1] << 8) |
                      (kernelMem[off + 2] << 16) | (kernelMem[off + 3] << 24);
      const wakeType = kernelMem[off + 4];

      if (wakeType & WAKE_READABLE) {
        // Pipe became readable — wake pending readers on this pipe
        const readers = this.pendingPipeReaders.get(pipeIdx);
        if (readers && readers.length > 0) {
          this.pendingPipeReaders.delete(pipeIdx);
          for (const reader of readers) {
            if (this.processes.has(reader.pid)) {
              this.retrySyscall(reader.channel);
            }
          }
        }
      }

      if (wakeType & WAKE_WRITABLE) {
        // Pipe became writable — wake pending writers on this pipe
        const writers = this.pendingPipeWriters.get(pipeIdx);
        if (writers && writers.length > 0) {
          this.pendingPipeWriters.delete(pipeIdx);
          for (const writer of writers) {
            if (this.processes.has(writer.pid)) {
              this.retrySyscall(writer.channel);
            }
          }
        }
      }

      needBroadWake = true;
    }

    // If any pipe state changed, also wake poll/select retries.
    //
    // If any of those retries is a signal-mask-swapping ppoll/pselect6,
    // defer the wake a few ms. A pipe write from process X is often
    // immediately followed by a cross-process signal (kill) from X —
    // e.g. "write to pipe, then kill parent" — where the writer expects
    // a blocked ppoll in the reader to observe BOTH events atomically.
    // On a real kernel that works because X's two syscalls execute
    // before the scheduler runs the reader. In our retry-based
    // centralized kernel, the pipe wakeup can fire a ppoll retry BEFORE
    // X's follow-up kill is even sent by X's worker (Atomics.notify →
    // uv_async round-trip takes 1–5ms). If the retry fires first, ppoll
    // returns POLLIN and restores its sigmask; the late signal is then
    // blocked and the handler never fires. See
    // os-test/signal/ppoll-block-sleep-write-raise.
    //
    // Deferring the broad wake a few ms gives X's follow-up syscalls
    // time to land. Kill-triggered wakes (line ~2050) always use the
    // immediate setImmediate path — by the time kill has been processed
    // the signal is already queued, so there's no race. Pipe
    // reader/writer wakes above run synchronously (not via this
    // deferred path), so plain read/write throughput is unaffected. We
    // only pay the delay when a pipe event happens to wake a ppoll or
    // pselect6 caller.
    if (needBroadWake) {
      if (this.anyPendingRetryNeedsSignalSafeWake()) {
        this.scheduleWakeBlockedRetriesDeferred();
      } else {
        this.scheduleWakeBlockedRetries();
      }
    }
  }

  private anyPendingRetryNeedsSignalSafeWake(): boolean {
    for (const entry of this.pendingPollRetries.values()) {
      if (entry.needsSignalSafeWake) return true;
    }
    for (const entry of this.pendingSelectRetries.values()) {
      if (entry.needsSignalSafeWake) return true;
    }
    return false;
  }

  /** Same as scheduleWakeBlockedRetries but delays by a few ms to allow
   *  follow-up cross-process syscalls from the event source to land. */
  private scheduleWakeBlockedRetriesDeferred(): void {
    if (this.wakeScheduled) return;
    if (this.pendingPollRetries.size === 0 && this.pendingSelectRetries.size === 0 && this.pendingPipeReaders.size === 0 && this.pendingPipeWriters.size === 0) return;
    this.wakeScheduled = true;
    setTimeout(() => {
      this.wakeScheduled = false;
      this.wakeAllBlockedRetries();
    }, 10);
  }

  /**
   * Schedule a microtask to wake all blocked poll/pselect6 retries.
   * Coalesced via wakeScheduled flag — multiple calls within the same
   * microtask batch result in only one wake cycle. This catches cross-process
   * pipe writes, socket connections, and other state changes that unblock
   * another process's pending poll/select.
   */
  private scheduleWakeBlockedRetries(): void {
    if (this.wakeScheduled) return;
    if (this.pendingPollRetries.size === 0 && this.pendingSelectRetries.size === 0 && this.pendingPipeReaders.size === 0 && this.pendingPipeWriters.size === 0) return;
    this.wakeScheduled = true;
    // Use setImmediate (not queueMicrotask) so that timer callbacks
    // (setTimeout/setInterval) can interleave.  In browsers, microtask
    // chains from queueMicrotask starve all macrotasks, breaking progress
    // updates and timeouts.  setImmediate goes through the polyfill which
    // yields to the timer queue periodically.
    setImmediate(() => {
      this.wakeScheduled = false;
      this.wakeAllBlockedRetries();
    });
  }

  /**
   * Wake all blocked poll/pselect6 retries by cancelling their setImmediate
   * timers and immediately re-executing the syscalls.
   */
  private wakeAllBlockedRetries(): void {
    // Snapshot and clear — retries may re-add themselves if still not ready
    const pollEntries = Array.from(this.pendingPollRetries.entries());
    const selectEntries = Array.from(this.pendingSelectRetries.entries());
    this.pendingPollRetries.clear();
    this.pendingSelectRetries.clear();

    for (const [_key, entry] of pollEntries) {
      if (!this.processes.has(entry.channel.pid)) continue;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      this.retrySyscall(entry.channel);
    }

    for (const [pid, entry] of selectEntries) {
      if (!this.processes.has(pid)) continue;
      // Cancel both setTimeout and setImmediate handles (one will be a no-op)
      clearTimeout(entry.timer);
      clearImmediate(entry.timer);
      // Re-dispatch to the right handler — SYS_SELECT and SYS_PSELECT6 have
      // different time-struct shapes (timeval vs timespec).
      if (entry.syscallNr === SYS_SELECT) {
        this.handleSelect(entry.channel, entry.origArgs);
      } else {
        this.handlePselect6(entry.channel, entry.origArgs);
      }
    }

    // Also wake all pending pipe readers — a cross-process write may have
    // made data available on pipes that readers are waiting on.
    if (this.pendingPipeReaders.size > 0) {
      const pipeEntries = Array.from(this.pendingPipeReaders.entries());
      this.pendingPipeReaders.clear();
      for (const [, readers] of pipeEntries) {
        for (const reader of readers) {
          if (this.processes.has(reader.pid)) {
            this.retrySyscall(reader.channel);
          }
        }
      }
    }

    // Also wake all pending pipe writers — a cross-process read may have
    // drained pipe buffer space that writers are waiting on.
    if (this.pendingPipeWriters.size > 0) {
      const writerEntries = Array.from(this.pendingPipeWriters.entries());
      this.pendingPipeWriters.clear();
      for (const [, writers] of writerEntries) {
        for (const writer of writers) {
          if (this.processes.has(writer.pid)) {
            this.retrySyscall(writer.channel);
          }
        }
      }
    }
  }

  /**
   * Remove a process's entries from pendingPipeReaders.
   * Called during process cleanup.
   */
  private cleanupPendingPipeReaders(pid: number): void {
    for (const [pipeIdx, readers] of this.pendingPipeReaders) {
      const filtered = readers.filter(r => r.pid !== pid);
      if (filtered.length === 0) {
        this.pendingPipeReaders.delete(pipeIdx);
      } else {
        this.pendingPipeReaders.set(pipeIdx, filtered);
      }
    }
  }

  private cleanupPendingPipeWriters(pid: number): void {
    for (const [pipeIdx, writers] of this.pendingPipeWriters) {
      const filtered = writers.filter(w => w.pid !== pid);
      if (filtered.length === 0) {
        this.pendingPipeWriters.delete(pipeIdx);
      } else {
        this.pendingPipeWriters.set(pipeIdx, filtered);
      }
    }
  }

  /**
   * Cancel a pending socket timeout timer for a channel.
   */
  private clearSocketTimeout(channel: ChannelInfo): void {
    const timer = this.socketTimeoutTimers.get(channel);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.socketTimeoutTimers.delete(channel);
    }
  }

  /**
   * Remove a channel from pending pipe readers (all pipes).
   * Called when a socket timeout fires to clean up the reader registration.
   */
  private removePendingPipeReader(channel: ChannelInfo): void {
    for (const [pipeIdx, readers] of this.pendingPipeReaders) {
      const filtered = readers.filter(r => r.channel !== channel);
      if (filtered.length === 0) {
        this.pendingPipeReaders.delete(pipeIdx);
      } else if (filtered.length !== readers.length) {
        this.pendingPipeReaders.set(pipeIdx, filtered);
      }
    }
  }

  /**
   * Remove a channel from pending pipe writers (all pipes).
   */
  private removePendingPipeWriter(channel: ChannelInfo): void {
    for (const [pipeIdx, writers] of this.pendingPipeWriters) {
      const filtered = writers.filter(w => w.channel !== channel);
      if (filtered.length === 0) {
        this.pendingPipeWriters.delete(pipeIdx);
      } else if (filtered.length !== writers.length) {
        this.pendingPipeWriters.set(pipeIdx, filtered);
      }
    }
  }

  /**
   * SYS_THREAD_CANCEL — wake a thread that is blocked in a cancellation-point
   * syscall so its glue (__syscall_cp) can observe the pending cancel flag
   * and run pthread_exit(PTHREAD_CANCELED).
   *
   * The guest pthread_cancel() overlay has already atomically set
   * target->cancel = 1 in shared memory before calling this syscall — see
   * musl-overlay/src/thread/wasm32posix/pthread_cancel.c for the full flow.
   *
   * This handler's sole job is to force the target out of its Atomics.wait32
   * on CH_STATUS (if blocked). Strategy depends on what the target is
   * waiting on:
   *
   *   - futex wait: fire Atomics.notify on the futex address. handleFutex's
   *     waitAsync Promise resolves, writes (0, 0) to the channel, target
   *     wakes. Return-value 0 is benign — the post-syscall __testcancel()
   *     in glue picks up self->cancel and exits before the caller re-checks
   *     its predicate.
   *   - pipe read/write blocked on pendingPipeReaders/Writers: remove the
   *     registration and complete the channel with -EINTR.
   *   - poll/select scheduled with a retry timer: clear the timer and
   *     complete with -EINTR.
   *   - otherwise (not blocked, or already completed): no-op. The target
   *     will observe self->cancel on its next cancel-point entry.
   *
   * The caller's own syscall always succeeds with 0.
   */
  private handleThreadCancel(channel: ChannelInfo, origArgs: number[]): void {
    const targetTid = origArgs[0];
    const registration = this.processes.get(channel.pid);

    // Always complete the caller's syscall first so pthread_cancel returns.
    this.completeChannelRaw(channel, 0, 0);
    this.relistenChannel(channel);

    if (!registration) return;

    // Resolve target channel: main thread has tid == pid; other threads are
    // tracked in channelTids by their clone-assigned tid.
    let target: ChannelInfo | undefined;
    for (const ch of registration.channels) {
      const mappedTid = this.channelTids.get(`${channel.pid}:${ch.channelOffset}`);
      const effectiveTid = mappedTid !== undefined ? mappedTid : channel.pid;
      if (effectiveTid === targetTid) {
        target = ch;
        break;
      }
    }
    if (!target) return;

    // Arm the cancel flag: blocking syscall entry points check this and
    // short-circuit with -EINTR. Also consulted by the generic syscall
    // dispatcher in _handleSyscallInner for cases where the target had
    // already pushed a syscall onto the channel but the host hadn't yet
    // started the blocking wait when the cancel arrived.
    this.pendingCancels.add(target.channelOffset);

    // If the target has already parked in a tracked blocking wait, wake
    // it so its natural completion path runs and the guest sees the
    // cancel in __syscall_cp_check. Doing the wake via the same mechanism
    // the wait uses (Atomics.notify on the futex addr, cancelling the
    // retry timer, etc.) avoids racing against the handler's own
    // completion path — we never write the channel directly here.

    // 1) Futex wait — Atomics.notify wakes the in-flight waitAsync, which
    //    calls complete() and completeChannelRaw naturally.
    const futexEntry = this.pendingFutexWaits.get(target.channelOffset);
    if (futexEntry) {
      const tgtMemView = new Int32Array(target.memory.buffer);
      Atomics.notify(tgtMemView, futexEntry.futexIndex, 1);
      return;
    }

    // 2) Poll/ppoll retry timer — cancelling the timer and kicking a
    //    retry lets handleBlockingRetry see pendingCancels and complete
    //    with -EINTR the same way an unblocked syscall entry would.
    const pollEntry = this.pendingPollRetries.get(target.channelOffset);
    if (pollEntry) {
      if (pollEntry.timer !== null) clearTimeout(pollEntry.timer);
      this.pendingPollRetries.delete(target.channelOffset);
      this.completeChannelRaw(target, -EINTR_ERRNO, EINTR_ERRNO);
      this.relistenChannel(target);
      return;
    }

    // 3) Pselect6 retry timer (keyed by pid).
    const selEntry = this.pendingSelectRetries.get(target.pid);
    if (selEntry && selEntry.channel === target) {
      clearTimeout(selEntry.timer);
      clearImmediate(selEntry.timer);
      this.pendingSelectRetries.delete(target.pid);
      this.completeChannelRaw(target, -EINTR_ERRNO, EINTR_ERRNO);
      this.relistenChannel(target);
      return;
    }

    // 4) Pipe/socket reader/writer registration — unregister and wake.
    let wokePipe = false;
    for (const [pipeIdx, readers] of this.pendingPipeReaders) {
      const filtered = readers.filter(r => r.channel !== target);
      if (filtered.length !== readers.length) {
        if (filtered.length === 0) this.pendingPipeReaders.delete(pipeIdx);
        else this.pendingPipeReaders.set(pipeIdx, filtered);
        wokePipe = true;
      }
    }
    for (const [pipeIdx, writers] of this.pendingPipeWriters) {
      const filtered = writers.filter(w => w.channel !== target);
      if (filtered.length !== writers.length) {
        if (filtered.length === 0) this.pendingPipeWriters.delete(pipeIdx);
        else this.pendingPipeWriters.set(pipeIdx, filtered);
        wokePipe = true;
      }
    }
    if (wokePipe) {
      this.clearSocketTimeout(target);
      this.completeChannelRaw(target, -EINTR_ERRNO, EINTR_ERRNO);
      this.relistenChannel(target);
      return;
    }

    // 5) No tracked blocking state — the target either hasn't reached the
    //    blocking entry yet, or its handler is synchronous and will pick
    //    up pendingCancels the next time it enters a blocking operation.
    //    Do NOT write the channel here: the in-flight handleSyscall owns
    //    it and would race with our completeChannelRaw.
  }

  /**
   * Dump syscall profiling data to stderr. Call from your serve script:
   *   process.on('SIGINT', () => { kernelWorker.dumpProfile(); process.exit(); });
   *
   * Only produces output when WASM_POSIX_PROFILE=1 env var is set.
   */
  dumpProfile(): void {
    if (!this.profileData) {
      console.error('[profile] Profiling not enabled. Set WASM_POSIX_PROFILE=1');
      return;
    }

    const entries = Array.from(this.profileData.entries())
      .sort((a, b) => b[1].totalTimeMs - a[1].totalTimeMs);

    let totalCalls = 0;
    let totalTime = 0;
    let totalRetries = 0;

    console.error('\n=== Syscall Profile ===');
    console.error(`${'Syscall'.padEnd(8)} ${'Count'.padStart(10)} ${'Time(ms)'.padStart(12)} ${'Avg(ms)'.padStart(10)} ${'Retries'.padStart(10)}`);
    console.error('-'.repeat(52));

    for (const [nr, data] of entries) {
      totalCalls += data.count;
      totalTime += data.totalTimeMs;
      totalRetries += data.retries;
      console.error(
        `${String(nr).padEnd(8)} ${String(data.count).padStart(10)} ${data.totalTimeMs.toFixed(2).padStart(12)} ${(data.totalTimeMs / data.count).toFixed(3).padStart(10)} ${String(data.retries).padStart(10)}`
      );
    }

    console.error('-'.repeat(52));
    console.error(
      `${'TOTAL'.padEnd(8)} ${String(totalCalls).padStart(10)} ${totalTime.toFixed(2).padStart(12)} ${(totalTime / (totalCalls || 1)).toFixed(3).padStart(10)} ${String(totalRetries).padStart(10)}`
    );
    console.error(`Pending pipe readers: ${this.pendingPipeReaders.size}, writers: ${this.pendingPipeWriters.size}`);
    console.error('=== End Profile ===\n');
  }

  private flushTcpSendPipes(pid: number): void {
    const conns = this.tcpConnections.get(pid);
    if (!conns || conns.length === 0) return;

    const pipeRead = this.kernelInstance!.exports.kernel_pipe_read as
      (pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number) => number;
    const mem = this.getKernelMem();

    // Injected-connection pipes live in the global pipe table; pid=0
    // tells kernel_pipe_read to use it directly. See kernel_inject_connection.
    for (const conn of conns) {
      // Drain all available data from the send pipe (not just one chunk)
      for (;;) {
        const readN = pipeRead(0, conn.sendPipeIdx, BigInt(conn.scratchOffset), 65536);
        if (readN <= 0) break;
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
          // Already changed — use setImmediate (not queueMicrotask) to avoid
          // microtask chains that starve the browser event loop.
          setImmediate(() => this.retrySyscall(channel));
        }
        return;
      }
    }

    // Poll with timeout: the kernel did a non-blocking check and returned EAGAIN.
    // We retry after a short delay. If poll has timeout=0 (EAGAIN means no events),
    // we should return 0 immediately instead of retrying.
    if (syscallNr === SYS_POLL || syscallNr === SYS_PPOLL) {
      let timeoutMs = -1;
      // PPOLL with a non-null sigmask pointer swaps the signal mask for the
      // duration of the wait. Broad wakes from cross-process pipe writes
      // need a short grace period for such callers so follow-up signals
      // from the writer land before ppoll returns with fds ready.
      const needsSignalSafeWake = syscallNr === SYS_PPOLL && origArgs[3] !== 0;
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

      // For finite timeout, track the deadline so we return 0 (timeout) when it
      // expires instead of retrying forever. The nfds=0 case (pure sleep) is
      // optimized to skip retries entirely — just wait for the deadline.
      const nfds = origArgs[1]; // poll(fds, nfds, ...) / ppoll(fds, nfds, ...)
      if (timeoutMs > 0 && nfds === 0) {
        // Pure sleep: no fds to poll, just wait for timeout
        const timer = setTimeout(() => {
          this.pendingPollRetries.delete(channel.channelOffset);
          if (this.processes.has(channel.pid)) {
            this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], 0, 0);
          }
        }, timeoutMs);
        this.pendingPollRetries.set(channel.channelOffset, { timer, channel, pipeIndices, needsSignalSafeWake });
        return;
      }

      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : -1;
      const retryFn = () => {
        this.pendingPollRetries.delete(channel.channelOffset);
        if (!this.processes.has(channel.pid)) return;
        // Check deadline for finite timeout
        if (deadline > 0 && Date.now() >= deadline) {
          this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], 0, 0);
          return;
        }
        this.retrySyscall(channel);
      };
      // With pipe indices, rely on wakeBlockedPoll for instant wakeup;
      // use moderate fallback for cases where the targeted wake misses
      // (e.g., listener socket backlogs which lack pipe indices for
      // wakeBlockedPoll). Without pipe indices, use short retry.
      // The intended wakeup path is event-driven:
      // drainAndProcessWakeupEvents → scheduleWakeBlockedRetries
      // (setImmediate) retries the poll when any of its watched pipes
      // changes state. The timer is a fallback. Empirically the
      // 200 ms safety net was sleeping past wakeups in the browser
      // worker (WordPress install.php measured 28 s with 200 ms,
      // 1.9 s with 10 ms — a 14× difference far in excess of what
      // 5 fallback fires can explain, suggesting setImmediate-based
      // broad wakes occasionally lose against the timer in the
      // browser's MessageChannel polyfill). 10 ms matches the default
      // for read-like / write-like blocking retries (lines ~3320,
      // ~3827, ~3953). Listener-socket cases without pipe indices
      // continue to use 50 ms.
      const retryMs = pipeIndices.length > 0
        ? (deadline > 0 ? Math.min(deadline - Date.now(), 10) : 10)
        : (deadline > 0 ? Math.min(deadline - Date.now(), 50) : 50);
      const timer = setTimeout(retryFn, Math.max(retryMs, 1));
      this.pendingPollRetries.set(channel.channelOffset, { timer, channel, pipeIndices, needsSignalSafeWake });
      return;
    }

    // (epoll_pwait is now handled entirely on the host side by handleEpollPwait)

    // sigtimedwait: kernel returned EAGAIN because no signal is pending.
    // Instead of retrying (signal won't arrive in single-process mode),
    // delay for the requested timeout then complete with -1/EAGAIN.
    if (syscallNr === SYS_RT_SIGTIMEDWAIT) {
      const timeoutPtr = origArgs[2]; // pointer to timespec in process memory
      if (timeoutPtr === 0) {
        // NULL timeout = wait indefinitely. Use long retry interval since
        // signals arrive via kernel_kill, not organically. In the browser,
        // short retries starve the event loop when multiple threads are active
        // (e.g. MariaDB's signal handler thread). 500ms is adequate because
        // cross-process signals are rare, and immediate delivery for kill()
        // works via scheduleWakeBlockedRetries.
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.retrySyscall(channel);
          }
        }, 500);
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

    // Non-blocking FD check: if the FD has O_NONBLOCK set, return EAGAIN
    // immediately instead of retrying. This is critical for programs like
    // nginx that use non-blocking I/O and expect EAGAIN returned promptly.
    // Covers read/write, accept, accept4, and connect syscalls.
    if (READ_LIKE_SYSCALLS.has(syscallNr) || WRITE_LIKE_SYSCALLS.has(syscallNr)
        || syscallNr === 53 /* ACCEPT */ || syscallNr === 384 /* ACCEPT4 */
        || syscallNr === 54 /* CONNECT */) {
      const fd = origArgs[0];
      const isFdNonblock = this.kernelInstance!.exports.kernel_is_fd_nonblock as
        ((pid: number, fd: number) => number) | undefined;
      if (isFdNonblock) {
        const nb = isFdNonblock(channel.pid, fd);
        if (nb === 1) {
          this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], -1, EAGAIN);
          return;
        }
      }
    }

    // Non-blocking mqueue check: mq_timedsend/mq_timedreceive return EAGAIN
    // from the kernel in both blocking and non-blocking modes (the kernel
    // has no way to actually block). For non-blocking descriptors we must
    // return EAGAIN to the caller; otherwise the default retry loop spins
    // forever waiting for state that will never change (e.g., the final
    // mq_receive in os-test/basic/mqueue/mq_receive.c after mq_setattr sets
    // O_NONBLOCK on an empty queue).
    if (syscallNr === SYS_MQ_TIMEDSEND || syscallNr === SYS_MQ_TIMEDRECEIVE) {
      const mqd = origArgs[0];
      const isFdNonblock = this.kernelInstance!.exports.kernel_is_fd_nonblock as
        ((pid: number, fd: number) => number) | undefined;
      if (isFdNonblock && isFdNonblock(channel.pid, mqd) === 1) {
        this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], -1, EAGAIN);
        return;
      }
    }

    // Socket timeout check: if a read/write-like syscall blocks on a socket
    // with SO_RCVTIMEO or SO_SNDTIMEO set, schedule a timer for ETIMEDOUT.
    if (READ_LIKE_SYSCALLS.has(syscallNr) || WRITE_LIKE_SYSCALLS.has(syscallNr)) {
      const fd = origArgs[0];
      const getTimeout = this.kernelInstance!.exports.kernel_get_socket_timeout_ms as
        ((pid: number, fd: number, isRecv: number) => bigint) | undefined;
      if (getTimeout && !this.socketTimeoutTimers.has(channel)) {
        const isRecv = READ_LIKE_SYSCALLS.has(syscallNr) ? 1 : 0;
        const timeoutMs = Number(getTimeout(channel.pid, fd, isRecv));
        if (timeoutMs > 0) {
          const timer = setTimeout(() => {
            this.socketTimeoutTimers.delete(channel);
            // Remove from pending pipe readers if registered
            this.removePendingPipeReader(channel);
            if (this.processes.has(channel.pid)) {
              this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], -1, ETIMEDOUT);
            }
          }, timeoutMs);
          this.socketTimeoutTimers.set(channel, timer);
        }
      }
    }

    // Event-driven pipe/socket wakeup: if this is a read-like syscall on a
    // pipe/socket fd, register the reader so a matching write can wake it
    // immediately instead of polling via setImmediate.
    if (READ_LIKE_SYSCALLS.has(syscallNr)) {
      const fd = origArgs[0];
      const getFdPipeIdx = this.kernelInstance!.exports.kernel_get_fd_pipe_idx as
        ((pid: number, fd: number) => number) | undefined;
      if (getFdPipeIdx) {
        const pipeIdx = getFdPipeIdx(channel.pid, fd);
        if (pipeIdx >= 0) {
          let readers = this.pendingPipeReaders.get(pipeIdx);
          if (!readers) {
            readers = [];
            this.pendingPipeReaders.set(pipeIdx, readers);
          }
          // Avoid duplicate registrations for the same channel
          if (!readers.some(r => r.channel === channel)) {
            readers.push({ channel, pid: channel.pid });
          }
          if (PROFILING) {
            const entry = this.profileData!.get(syscallNr);
            if (entry) entry.retries++;
          }
          return;
        }
      }
    }

    // Event-driven pipe/socket wakeup for writes: if a write-like syscall
    // blocks because the pipe/socket send buffer is full, register the writer
    // so a matching read (draining the pipe) can wake it immediately.
    if (WRITE_LIKE_SYSCALLS.has(syscallNr)) {
      const fd = origArgs[0];
      const getSendPipeIdx = this.kernelInstance!.exports.kernel_get_fd_send_pipe_idx as
        ((pid: number, fd: number) => number) | undefined;
      if (getSendPipeIdx) {
        const pipeIdx = getSendPipeIdx(channel.pid, fd);
        if (pipeIdx >= 0) {
          let writers = this.pendingPipeWriters.get(pipeIdx);
          if (!writers) {
            writers = [];
            this.pendingPipeWriters.set(pipeIdx, writers);
          }
          if (!writers.some(w => w.channel === channel)) {
            writers.push({ channel, pid: channel.pid });
          }
          if (PROFILING) {
            const entry = this.profileData!.get(syscallNr);
            if (entry) entry.retries++;
          }
          return;
        }
      }
    }

    // Event-driven wakeup for accept/accept4: register the listening socket's
    // pipe index so injectConnection → scheduleWakeBlockedRetries wakes the
    // accept immediately instead of waiting for the fallback timer.
    if (syscallNr === 53 /* ACCEPT */ || syscallNr === 384 /* ACCEPT4 */) {
      const fd = origArgs[0];
      const getFdPipeIdx = this.kernelInstance!.exports.kernel_get_fd_pipe_idx as
        ((pid: number, fd: number) => number) | undefined;
      if (getFdPipeIdx) {
        const pipeIdx = getFdPipeIdx(channel.pid, fd);
        if (pipeIdx >= 0) {
          let readers = this.pendingPipeReaders.get(pipeIdx);
          if (!readers) {
            readers = [];
            this.pendingPipeReaders.set(pipeIdx, readers);
          }
          if (!readers.some(r => r.channel === channel)) {
            readers.push({ channel, pid: channel.pid });
          }
          if (PROFILING) {
            const entry = this.profileData!.get(syscallNr);
            if (entry) entry.retries++;
          }
          return;
        }
      }
    }

    if (PROFILING) {
      const entry = this.profileData!.get(syscallNr);
      if (entry) entry.retries++;
    }

    // Default: retry via setTimeout to avoid starving other processes.
    // Register in pendingPollRetries so wakeAllBlockedRetries can cancel
    // the timer and retry immediately when state changes.
    const retryFn = () => {
      this.pendingPollRetries.delete(channel.channelOffset);
      if (this.processes.has(channel.pid)) {
        this.retrySyscall(channel);
      }
    };
    const timer = setTimeout(retryFn, 10);
    this.pendingPollRetries.set(channel.channelOffset, { timer, channel, pipeIndices: [] });
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
    kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(origArgs[0]), true); // fd
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(origArgs[1]), true); // cmd
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(flockPtr !== 0 ? dataStart : 0), true); // flock_ptr in kernel memory
    for (let i = 3; i < CH_ARGS_COUNT; i++) {
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, BigInt(origArgs[i]), true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
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
  /**
   * select(2) — args (nfds, readfds, writefds, exceptfds, *timeval).
   *
   * Differs from pselect6 only in the time struct: select takes
   * `struct timeval { long sec; long usec; }` and has no sigmask. musl
   * routes here on wasm64 because `__NR_pselect6_time64` isn't defined for
   * that arch (unlike wasm32, which aliases it to __NR_pselect6 and lands
   * on pselect6 instead).
   *
   * We decode timeval → ms, drive the kernel with sys_select directly, and
   * mirror handlePselect6's EAGAIN/timeout bookkeeping. The hot path in our
   * own code is `select(0, NULL, NULL, NULL, &tv)` (mysys/my_sleep.c) — the
   * pure-sleep case, fast-path'd to a setTimeout.
   */
  private handleSelect(channel: ChannelInfo, origArgs: number[]): void {
    const FD_SET_SIZE = 128;
    const nfds = origArgs[0];
    const readPtr = origArgs[1];
    const writePtr = origArgs[2];
    const exceptPtr = origArgs[3];
    const tvPtr = origArgs[4];

    let timeoutMs = -1; // -1 = infinite (NULL timeval)
    if (tvPtr !== 0) {
      const ptrWidth = this.getPtrWidth(channel.pid);
      const pv = new DataView(channel.memory.buffer, tvPtr);
      let sec: number, usec: number;
      if (ptrWidth === 8) {
        sec = Number(pv.getBigInt64(0, true));
        usec = Number(pv.getBigInt64(8, true));
      } else {
        sec = pv.getInt32(0, true);
        usec = pv.getInt32(4, true);
      }
      timeoutMs = sec * 1000 + Math.floor(usec / 1000);
      if (timeoutMs < 0) timeoutMs = 0;
    }

    // Pure-sleep fast path: select(0, NULL, NULL, NULL, &tv) is `my_sleep`.
    // The kernel can't tell us anything new — there are no fds to poll —
    // so we just wait the timeout and return 0. Tracked in
    // pendingSelectRetries so a cross-process kill can break us out early
    // (handleKill -> scheduleWakeBlockedRetries -> wakeAllBlockedRetries
    // already iterates pendingSelectRetries entries).
    if (nfds === 0 && readPtr === 0 && writePtr === 0 && exceptPtr === 0) {
      if (timeoutMs === 0) {
        this.completeChannel(channel, SYS_SELECT, origArgs, undefined, 0, 0);
        return;
      }
      const finite = timeoutMs > 0;
      const timer = finite
        ? setTimeout(() => {
            this.pendingSelectRetries.delete(channel.pid);
            if (this.processes.has(channel.pid)) {
              this.completeChannel(channel, SYS_SELECT, origArgs, undefined, 0, 0);
            }
          }, timeoutMs)
        : (null as any);
      this.pendingSelectRetries.set(channel.pid, {
        timer,
        channel,
        origArgs,
        deadline: finite ? Date.now() + timeoutMs : -1,
        needsSignalSafeWake: false,
        syscallNr: SYS_SELECT,
      });
      return;
    }

    // General case: dispatch to the kernel's sys_select with timeout_ms in
    // arg5. fd_sets are copied via the standard pre-existing scratch flow
    // (kernel_select reads readfds_ptr/writefds_ptr/exceptfds_ptr into
    // process memory directly, so we copy them in just like handlePselect6).
    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;

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

    kernelView.setUint32(CH_SYSCALL, SYS_SELECT, true);
    kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(nfds), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(readPtr !== 0 ? dataStart : 0), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(writePtr !== 0 ? dataStart + FD_SET_SIZE : 0), true);
    kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(exceptPtr !== 0 ? dataStart + 2 * FD_SET_SIZE : 0), true);
    kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(timeoutMs), true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // Copy fd_sets back from kernel → process on success
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

    this.dequeueSignalForDelivery(channel);

    // EAGAIN retry for blocking select. Mirrors handlePselect6.
    if (retVal === -1 && errVal === EAGAIN) {
      if (timeoutMs === 0) {
        this.completeChannel(channel, SYS_SELECT, origArgs, undefined, 0, 0);
        return;
      }
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : -1;
      const retryFn = () => {
        this.pendingSelectRetries.delete(channel.pid);
        if (!this.processes.has(channel.pid)) return;
        if (deadline > 0 && Date.now() >= deadline) {
          this.completeChannel(channel, SYS_SELECT, origArgs, undefined, 0, 0);
          return;
        }
        this.handleSelect(channel, origArgs);
      };
      const finite = timeoutMs > 0;
      const remainingMs = finite ? Math.max(deadline - Date.now(), 1) : 50;
      const timer = setTimeout(retryFn, Math.min(remainingMs, 50));
      this.pendingSelectRetries.set(channel.pid, {
        timer, channel, origArgs, deadline, needsSignalSafeWake: false,
        syscallNr: SYS_SELECT,
      });
      return;
    }

    this.completeChannel(channel, SYS_SELECT, origArgs, undefined, retVal, errVal);
  }

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
    // On wasm32: {u32 mask_ptr, u32 size} = 8 bytes
    // On wasm64: {u64 mask_ptr, u64 size} = 16 bytes
    //
    // POSIX pselect6 semantics: arg6 points at `{const sigset_t *ss, size_t
    // ss_len}`. If `ss == NULL`, the syscall must NOT swap the signal mask
    // (callers like glibc's `select(2)` wrapper pass a non-NULL outer struct
    // with `ss=NULL` to use the unified syscall path without requesting a
    // mask swap). We mirror that here by treating "inner mask NULL" the same
    // as "outer struct NULL": don't pass a mask-pointer to the kernel, so
    // sys_pselect6 leaves `mask=None` and skips the temp-mask path. Without
    // this, mariadbd's `select()` from main blew its sigmask away to 0 every
    // call, letting the next kill(getpid, SIGTERM) fire the main-thread
    // handler before the dedicated `signal_hand` thread could `sigwait` it
    // — `wait_for_signal_thread_to_end` then spun forever.
    const maskOffset = dataStart + 3 * FD_SET_SIZE;
    let kernelMaskPtr = 0; // 0 = no mask swap
    if (maskDataPtr !== 0) {
      const pw = this.getPtrWidth(channel.pid);
      const mdv = new DataView(channel.memory.buffer, maskDataPtr);
      const maskPtr = pw === 8
        ? Number(mdv.getBigUint64(0, true))
        : mdv.getUint32(0, true);
      if (maskPtr !== 0) {
        kernelMem.set(processMem.subarray(maskPtr, maskPtr + 8), maskOffset);
        kernelMaskPtr = maskOffset;
      }
    }

    // Write args: (nfds, readfds_kernel_ptr, writefds_kernel_ptr,
    //              exceptfds_kernel_ptr, timeout_ms, mask_kernel_ptr)
    kernelView.setUint32(CH_SYSCALL, SYS_PSELECT6, true);
    kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(nfds), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(readPtr !== 0 ? dataStart : 0), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(writePtr !== 0 ? dataStart + FD_SET_SIZE : 0), true);
    kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(exceptPtr !== 0 ? dataStart + 2 * FD_SET_SIZE : 0), true);
    kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(timeoutMs), true);
    kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(kernelMaskPtr), true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // pselect6 debug logging disabled

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

      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : -1;
      // pselect6 with a non-null sigmask pointer has the same late-signal
      // race as ppoll. See scheduleWakeBlockedRetriesDeferred.
      const needsSignalSafeWake = maskDataPtr !== 0;

      // nfds=0: pure sleep/sigsuspend-like behavior.
      // With finite timeout: sleep for that duration.
      // With infinite timeout: block until signal (wakeAllBlockedRetries).
      if (nfds === 0) {
        if (timeoutMs > 0) {
          const timer = setTimeout(() => {
            this.pendingSelectRetries.delete(channel.pid);
            if (this.processes.has(channel.pid)) {
              this.completeChannel(channel, SYS_PSELECT6, origArgs, undefined, 0, 0);
            }
          }, timeoutMs);
          this.pendingSelectRetries.set(channel.pid, { timer, channel, origArgs, deadline, needsSignalSafeWake });
        } else {
          // Infinite timeout with nfds=0: wait for signal delivery.
          // No timer — wakeAllBlockedRetries will trigger the retry.
          this.pendingSelectRetries.set(channel.pid, { timer: null as any, channel, origArgs, deadline: -1, needsSignalSafeWake });
        }
        return;
      }

      // For finite timeout with actual fds, track the deadline
      const retryFn = () => {
        this.pendingSelectRetries.delete(channel.pid);
        if (!this.processes.has(channel.pid)) return;
        if (deadline > 0 && Date.now() >= deadline) {
          this.completeChannel(channel, SYS_PSELECT6, origArgs, undefined, 0, 0);
          return;
        }
        this.handlePselect6(channel, origArgs);
      };
      const timer = setImmediate(retryFn);
      this.pendingSelectRetries.set(channel.pid, { timer, channel, origArgs, deadline, needsSignalSafeWake });
      return;
    }

    this.completeChannel(channel, SYS_PSELECT6, origArgs, undefined, retVal, errVal);
  }

  // ---- epoll host-side implementation ----
  // kernel_handle_channel crashes in Chrome for epoll_pwait (suspected V8
  // shared-memory Wasm bug).  We handle all epoll syscalls on the host:
  //   epoll_create1/create → still call kernel (works fine), mirror result
  //   epoll_ctl → still call kernel (works fine), mirror interest list
  //   epoll_pwait → convert to poll entirely on host, no kernel_handle_channel

  /**
   * Handle epoll_create1 / epoll_create: let the kernel create the fd,
   * then initialise an empty interest list on the host side.
   */
  private handleEpollCreate(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const flags = origArgs[0];

    // For SYS_EPOLL_CREATE, kernel expects flags=0 (size arg ignored)
    const actualFlags = syscallNr === SYS_EPOLL_CREATE ? 0 : flags;

    kernelView.setUint32(CH_SYSCALL, syscallNr, true);
    kernelView.setBigInt64(CH_ARGS, BigInt(actualFlags), true);
    for (let i = 1; i < CH_ARGS_COUNT; i++) {
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // If successful, initialise the host-side interest mirror
    if (retVal >= 0) {
      const key = `${channel.pid}:${retVal}`;
      this.epollInterests.set(key, []);
    }

    this.completeChannel(channel, syscallNr, origArgs, undefined, retVal, errVal);
  }

  /**
   * Handle epoll_ctl: let the kernel modify its interest list, then mirror
   * the change on the host side.
   */
  private handleEpollCtl(channel: ChannelInfo, origArgs: number[]): void {
    const epfd = origArgs[0];
    const op = origArgs[1];
    const fd = origArgs[2];
    const eventPtr = origArgs[3]; // pointer in process memory

    // Read epoll_event from process memory: { events: u32, data: u64 } = 12 bytes
    let events = 0;
    let data = 0n;
    if (eventPtr !== 0) {
      const pv = new DataView(channel.memory.buffer, eventPtr);
      events = pv.getUint32(0, true);
      data = pv.getBigUint64(4, true);
    }

    // Call kernel — copy event struct to scratch
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const kernelMem = this.getKernelMem();
    const dataStart = this.scratchOffset + CH_DATA;

    // Copy 12-byte epoll_event to kernel scratch
    if (eventPtr !== 0) {
      const processMem = new Uint8Array(channel.memory.buffer);
      kernelMem.set(processMem.subarray(eventPtr, eventPtr + 12), dataStart);
    }

    kernelView.setUint32(CH_SYSCALL, SYS_EPOLL_CTL, true);
    kernelView.setBigInt64(CH_ARGS, BigInt(epfd), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(op), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(fd), true);
    kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(eventPtr !== 0 ? dataStart : 0), true);
    kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(0), true);
    kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(0), true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // Mirror the change on the host side if the kernel succeeded
    if (retVal === 0) {
      const EPOLL_CTL_ADD = 1;
      const EPOLL_CTL_DEL = 2;
      const EPOLL_CTL_MOD = 3;

      const key = `${channel.pid}:${epfd}`;
      let interests = this.epollInterests.get(key);
      if (!interests) {
        interests = [];
        this.epollInterests.set(key, interests);
      }

      if (op === EPOLL_CTL_ADD) {
        interests.push({ fd, events, data });
      } else if (op === EPOLL_CTL_DEL) {
        const idx = interests.findIndex(e => e.fd === fd);
        if (idx >= 0) interests.splice(idx, 1);
      } else if (op === EPOLL_CTL_MOD) {
        const entry = interests.find(e => e.fd === fd);
        if (entry) {
          entry.events = events;
          entry.data = data;
        }
      }
    }

    this.completeChannel(channel, SYS_EPOLL_CTL, origArgs, undefined, retVal, errVal);
  }

  /**
   * Handle epoll_pwait / epoll_wait entirely on the host side.
   * Converts the epoll interest list to a poll syscall, calls
   * kernel_handle_channel with SYS_POLL, then maps results back
   * to epoll_event format and writes to process memory.
   */
  private handleEpollPwait(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const epfd = origArgs[0];
    const eventsPtr = origArgs[1]; // output pointer in process memory
    const maxevents = origArgs[2];
    const timeoutMs = origArgs[3];
    // origArgs[4] = sigmask ptr (process-space), origArgs[5] = sigset size

    if (maxevents <= 0) {
      this.completeChannelRaw(channel, -22, 22); // -EINVAL
      this.relistenChannel(channel);
      return;
    }

    const key = `${channel.pid}:${epfd}`;
    const interests = this.epollInterests.get(key);
    if (!interests) {
      this.completeChannelRaw(channel, -9, 9); // -EBADF
      this.relistenChannel(channel);
      return;
    }

    if (interests.length === 0) {
      // No interests registered — return 0 immediately for timeout=0,
      // or block (EAGAIN) for non-zero timeout.
      if (timeoutMs === 0) {
        this.completeChannelRaw(channel, 0, 0);
        this.relistenChannel(channel);
        return;
      }
      // For non-zero timeout with no interests, retry with delay to avoid starvation
      const retryFn = () => {
        this.pendingPollRetries.delete(channel.channelOffset);
        if (this.processes.has(channel.pid)) {
          this.handleEpollPwait(channel, syscallNr, origArgs);
        }
      };
      const timer = setTimeout(retryFn, 10);
      this.pendingPollRetries.set(channel.channelOffset, { timer, channel, pipeIndices: [] });
      return;
    }

    // EPOLL event flags → poll event flags
    const EPOLLIN = 0x001;
    const EPOLLOUT = 0x004;
    const EPOLLERR = 0x008;
    const EPOLLHUP = 0x010;
    const POLLIN = 0x001;
    const POLLOUT = 0x004;
    const POLLERR = 0x008;
    const POLLHUP = 0x010;

    // Build pollfds in kernel scratch data area
    // struct pollfd = { fd: i32, events: i16, revents: i16 } = 8 bytes
    const nfds = interests.length;
    const pollfdSize = nfds * 8;

    if (pollfdSize > CH_DATA_SIZE) {
      // Too many fds — unlikely but handle gracefully
      this.completeChannelRaw(channel, -22, 22); // -EINVAL
      this.relistenChannel(channel);
      return;
    }

    const kernelMem = this.getKernelMem();
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;

    // Write pollfds to kernel scratch
    for (let i = 0; i < nfds; i++) {
      const interest = interests[i];
      const off = dataStart + i * 8;
      let pollEvents = 0;
      if (interest.events & EPOLLIN) pollEvents |= POLLIN;
      if (interest.events & EPOLLOUT) pollEvents |= POLLOUT;
      new DataView(this.kernelMemory!.buffer).setInt32(off, interest.fd, true);
      new DataView(this.kernelMemory!.buffer).setInt16(off + 4, pollEvents, true);
      new DataView(this.kernelMemory!.buffer).setInt16(off + 6, 0, true); // revents=0
    }

    // Call kernel with SYS_POLL: (fds_ptr, nfds, timeout_ms=0)
    // Always use timeout=0 — we manage blocking/retry on the host side
    kernelView.setUint32(CH_SYSCALL, SYS_POLL, true);
    kernelView.setBigInt64(CH_ARGS, BigInt(dataStart), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(nfds), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(0), true); // timeout=0 for non-blocking poll
    for (let i = 3; i < CH_ARGS_COUNT; i++) {
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // Handle signal delivery
    this.dequeueSignalForDelivery(channel);

    // If poll returned error (not EAGAIN), propagate it
    if (retVal < 0 && errVal !== EAGAIN) {
      this.completeChannelRaw(channel, retVal, errVal);
      this.relistenChannel(channel);
      return;
    }

    // Count ready events and map back to epoll_event format
    let readyCount = 0;
    if (retVal > 0) {
      const processView = new DataView(channel.memory.buffer);
      for (let i = 0; i < nfds && readyCount < maxevents; i++) {
        const off = dataStart + i * 8;
        const revents = new DataView(this.kernelMemory!.buffer).getInt16(off + 6, true);
        if (revents !== 0) {
          // Map poll revents back to epoll events
          let epEvents = 0;
          if (revents & POLLIN) epEvents |= EPOLLIN;
          if (revents & POLLOUT) epEvents |= EPOLLOUT;
          if (revents & POLLERR) epEvents |= EPOLLERR;
          if (revents & POLLHUP) epEvents |= EPOLLHUP;

          // Write epoll_event to process memory: { events: u32, data: u64 } = 12 bytes
          const evOff = eventsPtr + readyCount * 12;
          processView.setUint32(evOff, epEvents, true);
          processView.setBigUint64(evOff + 4, interests[i].data, true);
          readyCount++;
        }
      }
    }

    // If we got events, return them
    if (readyCount > 0) {
      this.completeChannelRaw(channel, readyCount, 0);
      this.relistenChannel(channel);
      return;
    }

    // No events ready — handle timeout
    if (timeoutMs === 0) {
      // Non-blocking: return 0 events
      this.completeChannelRaw(channel, 0, 0);
      this.relistenChannel(channel);
      return;
    }

    // Blocking: retry via setTimeout to avoid starving other processes.
    // Pipe-based wakeup (via wakeAllBlockedRetries) provides instant wakeup
    // when data arrives; setTimeout is only a fallback.
    const pipeIndices = this.resolveEpollPipeIndices(channel.pid);

    const retryFn = () => {
      this.pendingPollRetries.delete(channel.channelOffset);
      if (this.processes.has(channel.pid)) {
        this.handleEpollPwait(channel, syscallNr, origArgs);
      }
    };
    const timer = setTimeout(retryFn, 10);
    this.pendingPollRetries.set(channel.channelOffset, { timer, channel, pipeIndices });
  }

  // ---- Network interface ioctl host-side handlers ----
  // The kernel has a single virtual network interface ("eth0") with a random
  // MAC address generated per kernel instance.

  /**
   * Handle SIOCGIFCONF: enumerate network interfaces.
   * struct ifconf { int ifc_len; union { char *ifc_buf; struct ifreq *ifc_req; }; }
   * The ifc_buf pointer is in process memory, so the kernel can't write to it
   * directly — we handle the entire ioctl on the host side.
   */
  private handleIoctlIfconf(channel: ChannelInfo, origArgs: number[]): void {
    const processView = new DataView(channel.memory.buffer);
    const processMem = new Uint8Array(channel.memory.buffer);
    const pw = this.getPtrWidth(channel.pid);

    // Read struct ifconf from process memory at arg[2]
    // struct ifconf { int ifc_len; union { char *ifc_buf; struct ifreq *ifc_req; }; }
    // wasm32: ifc_len at +0 (4B), ifc_buf at +4 (4B) — total 8 bytes
    // wasm64: ifc_len at +0 (4B), [4B padding], ifc_buf at +8 (8B) — total 16 bytes
    const ifconfPtr = origArgs[2];
    const ifcLen = processView.getInt32(ifconfPtr, true);
    let ifcBuf: number;
    if (pw === 8) {
      ifcBuf = Number(processView.getBigUint64(ifconfPtr + 8, true));
    } else {
      ifcBuf = processView.getUint32(ifconfPtr + 4, true);
    }

    // sizeof(struct ifreq) = 32 (16 name + 16 sockaddr union, no pointers — same on both)
    const SIZEOF_IFREQ = 32;

    if (ifcLen >= SIZEOF_IFREQ && ifcBuf !== 0) {
      // Write one ifreq entry for "eth0" into process memory at ifc_buf
      const nameBytes = new TextEncoder().encode("eth0");
      processMem.set(nameBytes, ifcBuf);
      processMem.fill(0, ifcBuf + nameBytes.length, ifcBuf + 16); // pad ifr_name

      // ifr_addr: AF_INET (2) with 127.0.0.1 — just needs to be a valid sockaddr
      processMem.fill(0, ifcBuf + 16, ifcBuf + SIZEOF_IFREQ);
      processView.setUint16(ifcBuf + 16, 2, true); // AF_INET
      processMem[ifcBuf + 20] = 127; // sin_addr = 127.0.0.1
      processMem[ifcBuf + 21] = 0;
      processMem[ifcBuf + 22] = 0;
      processMem[ifcBuf + 23] = 1;

      // Update ifc_len to actual bytes written
      processView.setInt32(ifconfPtr, SIZEOF_IFREQ, true);
    } else {
      // No space or null buffer
      processView.setInt32(ifconfPtr, 0, true);
    }

    this.completeChannelRaw(channel, 0, 0);
    this.relistenChannel(channel);
  }

  /**
   * Handle SIOCGIFHWADDR: get hardware (MAC) address for an interface.
   * struct ifreq at arg[2]: ifr_name[16] + ifr_hwaddr (struct sockaddr, 16 bytes)
   * Returns the virtual MAC in ifr_hwaddr.sa_data[0..5].
   */
  private handleIoctlIfhwaddr(channel: ChannelInfo, origArgs: number[]): void {
    const processView = new DataView(channel.memory.buffer);
    const processMem = new Uint8Array(channel.memory.buffer);
    const ifreqPtr = origArgs[2];

    // Write ifr_hwaddr at offset 16 from ifreq start:
    //   sa_family = ARPHRD_ETHER (1)
    //   sa_data[0..5] = MAC address
    processMem.fill(0, ifreqPtr + 16, ifreqPtr + 32);          // clear sockaddr
    processView.setUint16(ifreqPtr + 16, 1, true);             // ARPHRD_ETHER
    processMem.set(this.virtualMacAddress, ifreqPtr + 18);      // MAC address

    this.completeChannelRaw(channel, 0, 0);
    this.relistenChannel(channel);
  }

  /**
   * Handle SIOCGIFADDR: get interface address.
   * struct ifreq at arg[2]: ifr_name[16] + ifr_addr (struct sockaddr, 16 bytes)
   * Returns 127.0.0.1 for the virtual interface.
   */
  private handleIoctlIfaddr(channel: ChannelInfo, origArgs: number[]): void {
    const processView = new DataView(channel.memory.buffer);
    const processMem = new Uint8Array(channel.memory.buffer);
    const ifreqPtr = origArgs[2];

    // Write ifr_addr at offset 16: AF_INET + 127.0.0.1
    processMem.fill(0, ifreqPtr + 16, ifreqPtr + 32);
    processView.setUint16(ifreqPtr + 16, 2, true);  // AF_INET
    processMem[ifreqPtr + 20] = 127;                 // sin_addr = 127.0.0.1
    processMem[ifreqPtr + 21] = 0;
    processMem[ifreqPtr + 22] = 0;
    processMem[ifreqPtr + 23] = 1;

    this.completeChannelRaw(channel, 0, 0);
    this.relistenChannel(channel);
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

    // iovec struct: { void* iov_base, size_t iov_len }
    // wasm32: 8 bytes per entry (4+4), wasm64: 16 bytes per entry (8+8)
    const pw = this.getPtrWidth(channel.pid);
    const iovEntrySize = pw === 8 ? 16 : 8;

    // Read iov entries from process memory
    interface IovEntry { base: number; len: number }
    const entries: IovEntry[] = [];
    let totalData = 0;
    for (let i = 0; i < iovcnt; i++) {
      let base: number, len: number;
      if (pw === 8) {
        base = Number(processView.getBigUint64(iovPtr + i * iovEntrySize, true));
        len = Number(processView.getBigUint64(iovPtr + i * iovEntrySize + 8, true));
      } else {
        base = processView.getUint32(iovPtr + i * iovEntrySize, true);
        len = processView.getUint32(iovPtr + i * iovEntrySize + 4, true);
      }
      entries.push({ base, len });
      totalData += len;
    }

    // Max data that fits in scratch: CH_DATA_SIZE minus space for iov entries
    const iovSize = iovcnt * 8;
    const maxDataPerCall = CH_DATA_SIZE - iovSize;

    if (totalData <= maxDataPerCall) {
      // Fast path: all data fits in one kernel call
      let dataOff = iovSize;

      for (let i = 0; i < iovcnt; i++) {
        const kernelBase = dataStart + dataOff;

        if (entries[i].len > 0) {
          kernelMem.set(processMem.subarray(entries[i].base, entries[i].base + entries[i].len), kernelBase);
        }

        const iovAddr = dataStart + i * 8;
        new DataView(kernelMem.buffer).setUint32(iovAddr, kernelBase, true);
        new DataView(kernelMem.buffer).setUint32(iovAddr + 4, entries[i].len, true);

        dataOff += entries[i].len;
        dataOff = (dataOff + 3) & ~3; // align
      }

      kernelView.setUint32(CH_SYSCALL, syscallNr, true);
      kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(iovcnt), true);
      if (syscallNr === SYS_PWRITEV) {
        kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(origArgs[3]), true);
        kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(origArgs[4]), true);
      }

      const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
        (offset: bigint, pid: number) => number;
      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(BigInt(this.scratchOffset), channel.pid);
      } finally {
        this.currentHandlePid = 0;
      }

      const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
      const errVal = kernelView.getUint32(CH_ERRNO, true);

      if (retVal === -1 && errVal === EAGAIN) {
        this.handleBlockingRetry(channel, syscallNr, origArgs);
        return;
      }

      this.completeChannel(channel, syscallNr, origArgs, undefined, retVal, errVal);
    } else {
      // Slow path: total data exceeds scratch buffer. Issue individual SYS_WRITEV
      // calls with one iov entry each, chunked to fit in CH_DATA_SIZE.
      const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
        (offset: bigint, pid: number) => number;
      const isPwritev = syscallNr === SYS_PWRITEV;
      let fileOffset = isPwritev
        ? (origArgs[3] | 0) + (origArgs[4] | 0) * 0x100000000
        : 0;
      let totalWritten = 0;
      let gotEagain = false;
      const maxChunk = CH_DATA_SIZE - 8; // space for 1 iov entry (8B) + data

      for (const entry of entries) {
        if (entry.len === 0) continue;
        let entryWritten = 0;

        while (entryWritten < entry.len) {
          const chunkLen = Math.min(entry.len - entryWritten, maxChunk);
          const kernelBuf = dataStart + 8; // single iov entry at dataStart, data after

          // Copy data from process to kernel scratch
          kernelMem.set(
            processMem.subarray(entry.base + entryWritten, entry.base + entryWritten + chunkLen),
            kernelBuf,
          );

          // Set up single iov entry
          new DataView(kernelMem.buffer).setUint32(dataStart, kernelBuf, true);
          new DataView(kernelMem.buffer).setUint32(dataStart + 4, chunkLen, true);

          if (isPwritev) {
            kernelView.setUint32(CH_SYSCALL, SYS_PWRITEV, true);
            kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
            kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
            kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(1), true);
            kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(fileOffset & 0xFFFFFFFF), true);
            kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(Math.floor(fileOffset / 0x100000000)), true);
          } else {
            kernelView.setUint32(CH_SYSCALL, SYS_WRITEV, true);
            kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
            kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
            kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(1), true);
          }

          this.currentHandlePid = channel.pid;
          this.bindKernelTidForChannel(channel);
          try {
            handleChannel(BigInt(this.scratchOffset), channel.pid);
          } finally {
            this.currentHandlePid = 0;
          }

          const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
          const errVal = kernelView.getUint32(CH_ERRNO, true);

          if (retVal === -1) {
            if (errVal === EAGAIN && totalWritten === 0) {
              gotEagain = true;
            }
            break;
          }

          entryWritten += retVal;
          totalWritten += retVal;
          if (isPwritev) fileOffset += retVal;

          if (retVal < chunkLen) break; // short write (e.g. pipe full)
        }

        if (gotEagain || entryWritten < entry.len) break;
      }

      if (gotEagain) {
        this.handleBlockingRetry(channel, syscallNr, origArgs);
        return;
      }

      this.completeChannelRaw(channel, totalWritten, 0);
      this.relistenChannel(channel);
    }
  }

  /**
   * Handle large write/pwrite where the data exceeds CH_DATA_SIZE.
   * Loops through CH_DATA_SIZE chunks, issuing individual kernel calls.
   */
  private handleLargeWrite(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const fd = origArgs[0];
    const bufPtr = origArgs[1];
    const totalLen = origArgs[2];
    const isPwrite = syscallNr === SYS_PWRITE;
    // pwrite offset is a single i64 arg (arg index 3)
    let fileOffset = isPwrite ? origArgs[3] : 0;

    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;

    let totalWritten = 0;

    while (totalWritten < totalLen) {
      const chunkLen = Math.min(totalLen - totalWritten, CH_DATA_SIZE);

      // Copy chunk from process memory to kernel scratch
      kernelMem.set(
        processMem.subarray(bufPtr + totalWritten, bufPtr + totalWritten + chunkLen),
        dataStart,
      );

      // Set up syscall in kernel scratch
      kernelView.setUint32(CH_SYSCALL, syscallNr, true);
      kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(chunkLen), true);
      if (isPwrite) {
        kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(fileOffset), true);
      }

      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(BigInt(this.scratchOffset), channel.pid);
      } catch (err) {
        console.error(`[handleLargeWrite] kernel threw for pid=${channel.pid}:`, err);
        if (totalWritten > 0) {
          this.completeChannelRaw(channel, totalWritten, 0);
        } else {
          this.completeChannelRaw(channel, -5, 5); // -EIO
        }
        this.relistenChannel(channel);
        return;
      } finally {
        this.currentHandlePid = 0;
      }

      const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
      const errVal = kernelView.getUint32(CH_ERRNO, true);

      if (retVal === -1 && errVal === EAGAIN) {
        if (totalWritten > 0) {
          this.completeChannelRaw(channel, totalWritten, 0);
          this.relistenChannel(channel);
          return;
        }
        this.handleBlockingRetry(channel, syscallNr, origArgs);
        return;
      }

      if (errVal !== 0 || retVal <= 0) {
        if (totalWritten > 0) {
          this.completeChannelRaw(channel, totalWritten, 0);
        } else {
          this.completeChannelRaw(channel, retVal, errVal);
        }
        this.relistenChannel(channel);
        return;
      }

      totalWritten += retVal;
      if (isPwrite) fileOffset += retVal;

      // Short write from kernel — return what we have
      if (retVal < chunkLen) break;
    }

    this.dequeueSignalForDelivery(channel);
    this.completeChannelRaw(channel, totalWritten, 0);
    this.relistenChannel(channel);
  }

  /**
   * Handle large read/pread where the buffer exceeds CH_DATA_SIZE.
   * Loops through CH_DATA_SIZE chunks, copying data back to process memory.
   */
  private handleLargeRead(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const fd = origArgs[0];
    const bufPtr = origArgs[1];
    const totalLen = origArgs[2];
    const isPread = syscallNr === SYS_PREAD;
    let fileOffset = isPread ? origArgs[3] : 0;

    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const dataStart = this.scratchOffset + CH_DATA;
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;

    let totalRead = 0;

    while (totalRead < totalLen) {
      const chunkLen = Math.min(totalLen - totalRead, CH_DATA_SIZE);

      // Zero the scratch data area for the read output
      kernelMem.fill(0, dataStart, dataStart + chunkLen);

      // Set up syscall in kernel scratch
      kernelView.setUint32(CH_SYSCALL, syscallNr, true);
      kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(chunkLen), true);
      if (isPread) {
        kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(fileOffset), true);
      }

      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(BigInt(this.scratchOffset), channel.pid);
      } catch (err) {
        console.error(`[handleLargeRead] kernel threw for pid=${channel.pid}:`, err);
        if (totalRead > 0) {
          this.completeChannelRaw(channel, totalRead, 0);
        } else {
          this.completeChannelRaw(channel, -5, 5); // -EIO
        }
        this.relistenChannel(channel);
        return;
      } finally {
        this.currentHandlePid = 0;
      }

      const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
      const errVal = kernelView.getUint32(CH_ERRNO, true);

      if (retVal === -1 && errVal === EAGAIN) {
        if (totalRead > 0) {
          this.completeChannelRaw(channel, totalRead, 0);
          this.relistenChannel(channel);
          return;
        }
        this.handleBlockingRetry(channel, syscallNr, origArgs);
        return;
      }

      if (errVal !== 0 || retVal <= 0) {
        if (totalRead > 0) {
          this.completeChannelRaw(channel, totalRead, 0);
        } else {
          this.completeChannelRaw(channel, retVal, errVal);
        }
        this.relistenChannel(channel);
        return;
      }

      // Copy read data from kernel scratch to process memory
      processMem.set(
        kernelMem.subarray(dataStart, dataStart + retVal),
        bufPtr + totalRead,
      );

      totalRead += retVal;
      if (isPread) fileOffset += retVal;

      // Short read (EOF or partial) — return what we have
      if (retVal < chunkLen) break;
    }

    this.dequeueSignalForDelivery(channel);
    this.completeChannelRaw(channel, totalRead, 0);
    this.relistenChannel(channel);
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

    // iovec struct: wasm32 = 8B per entry, wasm64 = 16B per entry
    const pw = this.getPtrWidth(channel.pid);
    const iovEntrySize = pw === 8 ? 16 : 8;

    // Read iov entries from process memory
    interface IovEntry { base: number; len: number }
    const entries: IovEntry[] = [];
    let totalData = 0;
    for (let i = 0; i < iovcnt; i++) {
      let base: number, len: number;
      if (pw === 8) {
        base = Number(processView.getBigUint64(iovPtr + i * iovEntrySize, true));
        len = Number(processView.getBigUint64(iovPtr + i * iovEntrySize + 8, true));
      } else {
        base = processView.getUint32(iovPtr + i * iovEntrySize, true);
        len = processView.getUint32(iovPtr + i * iovEntrySize + 4, true);
      }
      entries.push({ base, len });
      totalData += len;
    }

    // Max data that fits in scratch: CH_DATA_SIZE minus space for one iov entry (8 bytes)
    const maxDataPerCall = CH_DATA_SIZE - 8;

    if (totalData <= maxDataPerCall && iovcnt <= Math.floor(CH_DATA_SIZE / 8)) {
      // Fast path: everything fits in one kernel call
      const iovSize = iovcnt * 8;
      let dataOff = iovSize;
      const kernelEntries: { base: number; kernelBase: number; len: number }[] = [];

      for (let i = 0; i < iovcnt; i++) {
        const kernelBase = dataStart + dataOff;
        kernelEntries.push({ base: entries[i].base, kernelBase, len: entries[i].len });

        if (entries[i].len > 0) {
          kernelMem.fill(0, kernelBase, kernelBase + entries[i].len);
        }

        const iovAddr = dataStart + i * 8;
        new DataView(kernelMem.buffer).setUint32(iovAddr, kernelBase, true);
        new DataView(kernelMem.buffer).setUint32(iovAddr + 4, entries[i].len, true);

        dataOff += entries[i].len;
        dataOff = (dataOff + 3) & ~3;
      }

      kernelView.setUint32(CH_SYSCALL, syscallNr, true);
      kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(iovcnt), true);
      if (syscallNr === SYS_PREADV) {
        kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(origArgs[3]), true);
        kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(origArgs[4]), true);
      }

      const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
        (offset: bigint, pid: number) => number;
      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(BigInt(this.scratchOffset), channel.pid);
      } finally {
        this.currentHandlePid = 0;
      }

      const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
      const errVal = kernelView.getUint32(CH_ERRNO, true);

      if (retVal === -1 && errVal === EAGAIN) {
        this.handleBlockingRetry(channel, syscallNr, origArgs);
        return;
      }

      if (retVal > 0) {
        let remaining = retVal;
        for (const entry of kernelEntries) {
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
    } else {
      // Slow path: total data exceeds scratch buffer. Issue one SYS_READ per iov entry,
      // chunked to fit in CH_DATA_SIZE. Use pread to maintain file offset for preadv.
      const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
        (offset: bigint, pid: number) => number;
      const isPreadv = syscallNr === SYS_PREADV;
      let fileOffset = isPreadv
        ? (origArgs[3] | 0) + (origArgs[4] | 0) * 0x100000000
        : 0;
      let totalRead = 0;
      let lastErr = 0;
      let gotEagain = false;

      for (const entry of entries) {
        if (entry.len === 0) continue;
        let entryRead = 0;

        while (entryRead < entry.len) {
          const chunkLen = Math.min(entry.len - entryRead, maxDataPerCall);
          const kernelBuf = dataStart + 8; // single iov entry at dataStart, data after

          // Set up single iov entry
          new DataView(kernelMem.buffer).setUint32(dataStart, kernelBuf, true);
          new DataView(kernelMem.buffer).setUint32(dataStart + 4, chunkLen, true);
          kernelMem.fill(0, kernelBuf, kernelBuf + chunkLen);

          if (isPreadv) {
            // Use preadv with 1 iov
            kernelView.setUint32(CH_SYSCALL, SYS_PREADV, true);
            kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
            kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
            kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(1), true);
            kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(fileOffset & 0xFFFFFFFF), true);
            kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(Math.floor(fileOffset / 0x100000000)), true);
          } else {
            // Use readv with 1 iov
            kernelView.setUint32(CH_SYSCALL, SYS_READV, true);
            kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
            kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
            kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(1), true);
          }

          this.currentHandlePid = channel.pid;
          this.bindKernelTidForChannel(channel);
          try {
            handleChannel(BigInt(this.scratchOffset), channel.pid);
          } finally {
            this.currentHandlePid = 0;
          }

          const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
          const errVal = kernelView.getUint32(CH_ERRNO, true);

          if (retVal === -1) {
            if (errVal === EAGAIN && totalRead === 0) {
              gotEagain = true;
              break;
            }
            lastErr = errVal;
            break;
          }

          if (retVal === 0) break; // EOF

          // Copy data to process memory
          processMem.set(
            kernelMem.subarray(kernelBuf, kernelBuf + retVal),
            entry.base + entryRead,
          );

          entryRead += retVal;
          totalRead += retVal;
          if (isPreadv) fileOffset += retVal;

          if (retVal < chunkLen) break; // short read
        }

        if (gotEagain || lastErr) break;
      }

      if (gotEagain) {
        this.handleBlockingRetry(channel, syscallNr, origArgs);
        return;
      }

      const finalRet = totalRead > 0 ? totalRead : (lastErr ? -1 : 0);
      const finalErr = totalRead > 0 ? 0 : lastErr;
      this.completeChannel(channel, syscallNr, origArgs, undefined, finalRet, finalErr);
    }
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
    const pw = this.getPtrWidth(channel.pid);

    // Parse msghdr from process memory (ptrWidth-aware).
    // wasm32 layout (28B): name(4), namelen(4), iov(4), iovlen(4), control(4), controllen(4), flags(4)
    // wasm64 layout (48B): name(8), namelen(4), pad(4), iov(8), iovlen(4), pad(4), control(8), controllen(4), flags(4)
    let namePtr: number, nameLen: number, iovPtr: number, iovCnt: number;
    let controlPtr: number, controlLen: number;
    if (pw === 8) {
      namePtr = Number(processView.getBigUint64(msgPtr, true));
      nameLen = processView.getUint32(msgPtr + 8, true);
      iovPtr = Number(processView.getBigUint64(msgPtr + 16, true));
      iovCnt = processView.getUint32(msgPtr + 24, true);
      controlPtr = Number(processView.getBigUint64(msgPtr + 32, true));
      controlLen = processView.getUint32(msgPtr + 40, true);
    } else {
      namePtr = processView.getUint32(msgPtr, true);
      nameLen = processView.getUint32(msgPtr + 4, true);
      iovPtr = processView.getUint32(msgPtr + 8, true);
      iovCnt = processView.getUint32(msgPtr + 12, true);
      controlPtr = processView.getUint32(msgPtr + 16, true);
      controlLen = processView.getUint32(msgPtr + 20, true);
    }

    // Build kernel-side msghdr in wasm32 (28B) format (kernel uses explicit u32 parsing)
    const kMsgPtr = dataStart;
    const kv = new DataView(kernelMem.buffer);
    kv.setUint32(kMsgPtr, namePtr, true);
    kv.setUint32(kMsgPtr + 4, nameLen, true);
    kv.setUint32(kMsgPtr + 8, iovPtr, true);  // will be updated below
    kv.setUint32(kMsgPtr + 12, iovCnt, true);
    kv.setUint32(kMsgPtr + 16, controlPtr, true);  // will be updated below
    kv.setUint32(kMsgPtr + 20, controlLen, true);
    kv.setUint32(kMsgPtr + 24, 0, true);  // msg_flags

    let dataOff = 28; // after kernel-format msghdr

    // Copy msg_name to kernel scratch
    if (namePtr !== 0 && nameLen > 0 && dataOff + nameLen <= CH_DATA_SIZE) {
      const kNamePtr = dataStart + dataOff;
      kernelMem.set(processMem.subarray(namePtr, namePtr + nameLen), kNamePtr);
      kv.setUint32(kMsgPtr, kNamePtr, true); // update msg_name ptr
      dataOff += nameLen;
      dataOff = (dataOff + 3) & ~3;
    }

    // Copy msg_control (ancillary data, e.g. SCM_RIGHTS) to kernel scratch
    if (controlPtr !== 0 && controlLen > 0 && dataOff + controlLen <= CH_DATA_SIZE) {
      const kCtrlPtr = dataStart + dataOff;
      kernelMem.set(processMem.subarray(controlPtr, controlPtr + controlLen), kCtrlPtr);
      kv.setUint32(kMsgPtr + 16, kCtrlPtr, true); // update msg_control ptr
      dataOff += controlLen;
      dataOff = (dataOff + 3) & ~3;
    }

    // Copy iov array and iov data to kernel scratch
    const iovEntrySize = pw === 8 ? 16 : 8;
    if (iovCnt > 0 && iovPtr !== 0) {
      const kIovSize = iovCnt * 8; // kernel-side iov is always 8 bytes per entry (u32 base + u32 len)
      const kIovPtr = dataStart + dataOff;
      dataOff += kIovSize;
      dataOff = (dataOff + 3) & ~3;

      kv.setUint32(kMsgPtr + 8, kIovPtr, true); // update msg_iov ptr

      // Copy each iov buffer data
      for (let i = 0; i < iovCnt; i++) {
        let base: number, len: number;
        if (pw === 8) {
          base = Number(processView.getBigUint64(iovPtr + i * iovEntrySize, true));
          len = Number(processView.getBigUint64(iovPtr + i * iovEntrySize + 8, true));
        } else {
          base = processView.getUint32(iovPtr + i * 8, true);
          len = processView.getUint32(iovPtr + i * 8 + 4, true);
        }
        // Write kernel-format iov entry (always u32 base + u32 len)
        kv.setUint32(kIovPtr + i * 8, 0, true); // will be updated if data copied
        kv.setUint32(kIovPtr + i * 8 + 4, len, true);

        if (len > 0 && dataOff + len <= CH_DATA_SIZE) {
          const kBufPtr = dataStart + dataOff;
          kernelMem.set(processMem.subarray(base, base + len), kBufPtr);
          kv.setUint32(kIovPtr + i * 8, kBufPtr, true);
          dataOff += len;
          dataOff = (dataOff + 3) & ~3;
        }
      }
    }

    // Call kernel
    kernelView.setUint32(CH_SYSCALL, 137, true); // SYS_SENDMSG
    kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(kMsgPtr), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(flags), true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    if (retVal === -1 && errVal === EAGAIN) {
      this.handleBlockingRetry(channel, 137, origArgs);
      return;
    }

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
    const pw = this.getPtrWidth(channel.pid);

    // Parse msghdr from process memory (ptrWidth-aware)
    let namePtr: number, nameLen: number, iovPtr: number, iovCnt: number;
    let controlPtr: number, controlLen: number;
    if (pw === 8) {
      namePtr = Number(processView.getBigUint64(msgPtr, true));
      nameLen = processView.getUint32(msgPtr + 8, true);
      iovPtr = Number(processView.getBigUint64(msgPtr + 16, true));
      iovCnt = processView.getUint32(msgPtr + 24, true);
      controlPtr = Number(processView.getBigUint64(msgPtr + 32, true));
      controlLen = processView.getUint32(msgPtr + 40, true);
    } else {
      namePtr = processView.getUint32(msgPtr, true);
      nameLen = processView.getUint32(msgPtr + 4, true);
      iovPtr = processView.getUint32(msgPtr + 8, true);
      iovCnt = processView.getUint32(msgPtr + 12, true);
      controlPtr = processView.getUint32(msgPtr + 16, true);
      controlLen = processView.getUint32(msgPtr + 20, true);
    }

    // Build kernel-side msghdr in wasm32 (28B) format
    const kMsgPtr = dataStart;
    const kv = new DataView(kernelMem.buffer);
    kv.setUint32(kMsgPtr, namePtr, true);
    kv.setUint32(kMsgPtr + 4, nameLen, true);
    kv.setUint32(kMsgPtr + 8, iovPtr, true);
    kv.setUint32(kMsgPtr + 12, iovCnt, true);
    kv.setUint32(kMsgPtr + 16, controlPtr, true);
    kv.setUint32(kMsgPtr + 20, controlLen, true);
    kv.setUint32(kMsgPtr + 24, 0, true);

    let dataOff = 28;

    // Set up msg_name output buffer
    let kNamePtr = 0;
    if (namePtr !== 0 && nameLen > 0 && dataOff + nameLen <= CH_DATA_SIZE) {
      kNamePtr = dataStart + dataOff;
      kernelMem.fill(0, kNamePtr, kNamePtr + nameLen);
      kv.setUint32(kMsgPtr, kNamePtr, true);
      dataOff += nameLen;
      dataOff = (dataOff + 3) & ~3;
    }

    // Set up msg_control output buffer for ancillary data (SCM_RIGHTS)
    let kCtrlPtr = 0;
    if (controlPtr !== 0 && controlLen > 0 && dataOff + controlLen <= CH_DATA_SIZE) {
      kCtrlPtr = dataStart + dataOff;
      kernelMem.fill(0, kCtrlPtr, kCtrlPtr + controlLen);
      kv.setUint32(kMsgPtr + 16, kCtrlPtr, true);
      dataOff += controlLen;
      dataOff = (dataOff + 3) & ~3;
    }

    // Set up iov array and output buffers
    interface IovEntry { base: number; len: number; kernelBase: number }
    const entries: IovEntry[] = [];
    const iovEntrySize = pw === 8 ? 16 : 8;

    if (iovCnt > 0 && iovPtr !== 0) {
      const kIovSize = iovCnt * 8; // kernel-side iov always 8B per entry
      const kIovPtr = dataStart + dataOff;
      dataOff += kIovSize;
      dataOff = (dataOff + 3) & ~3;

      kv.setUint32(kMsgPtr + 8, kIovPtr, true);

      for (let i = 0; i < iovCnt; i++) {
        let base: number, len: number;
        if (pw === 8) {
          base = Number(processView.getBigUint64(iovPtr + i * iovEntrySize, true));
          len = Number(processView.getBigUint64(iovPtr + i * iovEntrySize + 8, true));
        } else {
          base = processView.getUint32(iovPtr + i * 8, true);
          len = processView.getUint32(iovPtr + i * 8 + 4, true);
        }
        if (len > 0 && dataOff + len <= CH_DATA_SIZE) {
          const kBufPtr = dataStart + dataOff;
          kernelMem.fill(0, kBufPtr, kBufPtr + len);
          kv.setUint32(kIovPtr + i * 8, kBufPtr, true);
          kv.setUint32(kIovPtr + i * 8 + 4, len, true);
          entries.push({ base, len, kernelBase: kBufPtr });
          dataOff += len;
          dataOff = (dataOff + 3) & ~3;
        } else {
          kv.setUint32(kIovPtr + i * 8, 0, true);
          kv.setUint32(kIovPtr + i * 8 + 4, len, true);
        }
      }
    }

    // Call kernel
    kernelView.setUint32(CH_SYSCALL, 138, true); // SYS_RECVMSG
    kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(kMsgPtr), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(flags), true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
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

    // Copy msg_control (ancillary data) back to process memory
    if (kCtrlPtr !== 0 && controlPtr !== 0) {
      const actualControlLen = kv.getUint32(kMsgPtr + 20, true);
      if (actualControlLen > 0 && actualControlLen <= controlLen) {
        processMem.set(
          kernelMem.subarray(kCtrlPtr, kCtrlPtr + actualControlLen),
          controlPtr,
        );
      }
    }

    // Copy updated msghdr fields back to process memory (ptrWidth-aware)
    const kNamelenVal = kv.getUint32(kMsgPtr + 4, true);
    const kControllenVal = kv.getUint32(kMsgPtr + 20, true);
    const kMsgflags = kv.getUint32(kMsgPtr + 24, true);
    if (pw === 8) {
      processView.setUint32(msgPtr + 8, kNamelenVal, true);   // msg_namelen
      processView.setUint32(msgPtr + 40, kControllenVal, true); // msg_controllen
      processView.setUint32(msgPtr + 44, kMsgflags, true);     // msg_flags
    } else {
      processView.setUint32(msgPtr + 4, kNamelenVal, true);   // msg_namelen
      processView.setUint32(msgPtr + 20, kControllenVal, true); // msg_controllen
      processView.setUint32(msgPtr + 24, kMsgflags, true);     // msg_flags
    }

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
    if (!this.callbacks.onFork) {
      // No fork handler — return -ENOSYS
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, -1, 38);
      return;
    }

    const parentPid = channel.pid;
    // Skip pids that are already registered (e.g., pid 3 is nginx master)
    while (this.processes.has(this.nextChildPid)) {
      this.nextChildPid++;
    }
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

    // Clear fork_child flag immediately. With asyncify fork, the child resumes
    // from the fork point and never checks this flag. Without clearing it, a
    // nested fork() from the child would hit the isForkChild check above and
    // return 0 instead of creating a grandchild.
    const clearForkChild = this.kernelInstance!.exports.kernel_clear_fork_child as
      ((pid: number) => number) | undefined;
    if (clearForkChild) clearForkChild(childPid);

    // Clear the child's blocked signal mask. With asyncify fork, musl's
    // __restore_sigs after fork() runs in the child, but we clear it here
    // too for safety. Without asyncify, the child re-executes _start and
    // never gets __restore_sigs.
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

      // Inherit TCP listener targets: if parent listens on a port, register
      // the child as an additional target (fork children share listening sockets)
      for (const [port, targets] of this.tcpListenerTargets) {
        const parentTarget = targets.find(t => t.pid === parentPid);
        if (parentTarget && !targets.some(t => t.pid === childPid)) {
          targets.push({ pid: childPid, fd: parentTarget.fd });
        }
      }

      // Inherit epoll interest lists from parent
      for (const [key, interests] of this.epollInterests) {
        if (key.startsWith(`${parentPid}:`)) {
          const epfd = key.slice(key.indexOf(':') + 1);
          this.epollInterests.set(`${childPid}:${epfd}`, interests.map(e => ({ ...e })));
        }
      }

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
   * Read a null-terminated string from process memory at the given pointer.
   */
  private readCStringFromProcess(mem: Uint8Array, ptr: number, maxLen = 4096): string {
    if (ptr === 0) return "";
    let len = 0;
    while (ptr + len < mem.length && mem[ptr + len] !== 0 && len < maxLen) {
      len++;
    }
    // .slice() copies from SharedArrayBuffer into a regular ArrayBuffer
    // because TextDecoder.decode() doesn't accept SharedArrayBuffer views.
    return new TextDecoder().decode(mem.slice(ptr, ptr + len));
  }

  /**
   * Read a null-terminated array of string pointers from process memory.
   * Each element is a 32-bit pointer to a null-terminated string.
   */
  private readStringArrayFromProcess(mem: Uint8Array, arrayPtr: number, ptrWidth: 4 | 8 = 4): string[] {
    if (arrayPtr === 0) return [];
    const result: string[] = [];
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    for (let i = 0; i < 1024; i++) {
      let strPtr: number;
      if (ptrWidth === 8) {
        strPtr = Number(view.getBigUint64(arrayPtr + i * 8, true));
      } else {
        strPtr = view.getUint32(arrayPtr + i * 4, true);
      }
      if (strPtr === 0) break;
      result.push(this.readCStringFromProcess(mem, strPtr));
    }
    return result;
  }

  /**
   * Handle SYS_EXECVE: read path, argv, and envp from process memory,
   * then call the onExec callback to load the new program.
   */
  private handleExec(channel: ChannelInfo, origArgs: number[]): void {
    const processMem = new Uint8Array(channel.memory.buffer);

    // Read path (arg 0), argv (arg 1), envp (arg 2) from process memory
    const pw = this.getPtrWidth(channel.pid);
    let path = this.readCStringFromProcess(processMem, origArgs[0]);
    const argv = this.readStringArrayFromProcess(processMem, origArgs[1], pw);
    const envp = this.readStringArrayFromProcess(processMem, origArgs[2], pw);

    // Resolve relative exec paths against process CWD (not initial KERNEL_CWD).
    // Critical for posix_spawn with chdir file actions where child CWD != parent CWD.
    if (path && !path.startsWith("/")) {
      path = this.resolveExecPathAgainstCwd(channel.pid, path);
    }

    if (!this.callbacks.onExec) {
      this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, 38); // ENOSYS
      return;
    }

    // Call the async exec handler FIRST — onExec returns ENOENT early if the
    // program doesn't exist, allowing posix_spawnp/execvpe PATH search to retry.
    // kernel_exec_setup and prepareProcessForExec are deferred until after
    // onExec confirms the program exists (returns 0).
    this.callbacks.onExec(channel.pid, path, argv, envp).then((result) => {
      if (result < 0) {
        // Exec failed (e.g. ENOENT) — process is still alive.
        // Complete the channel so the calling process can handle the error
        // (e.g., __execvpe tries the next PATH entry).
        this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, (-result) >>> 0);
      }
      // On success (result === 0), execve doesn't return — the Worker has been
      // reinitialized with the new program via registerProcess. The old channel
      // is dead (prepareProcessForExec removed it in onExec).
    }).catch((err) => {
      console.error(`[kernel] exec error for pid ${channel.pid}:`, err);
      this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, 5); // EIO
    });
  }

  /**
   * Resolve a relative exec path against the process's kernel CWD.
   * Returns absolute path if CWD can be queried, otherwise returns path unchanged.
   */
  private resolveExecPathAgainstCwd(pid: number, path: string): string {
    const getCwd = this.kernelInstance!.exports.kernel_get_cwd as
      ((pid: number, bufPtr: bigint, bufLen: number) => number) | undefined;
    if (!getCwd) return path;
    const cwdLen = getCwd(pid, BigInt(this.scratchOffset), 4096);
    if (cwdLen <= 0) return path;
    const kernelBuf = new Uint8Array(this.kernelMemory!.buffer);
    const cwd = new TextDecoder().decode(kernelBuf.slice(this.scratchOffset, this.scratchOffset + cwdLen));
    const joined = cwd.endsWith("/") ? cwd + path : cwd + "/" + path;
    // Normalize . and .. components (e.g. /data/spawn/./prog → /data/spawn/prog)
    const parts = joined.split("/");
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === ".." && normalized.length > 0) { normalized.pop(); continue; }
      normalized.push(part);
    }
    return "/" + normalized.join("/");
  }

  /**
   * Handle SYS_EXECVEAT: execveat(dirfd, path, argv, envp, flags).
   * Used by fexecve which calls execveat(fd, "", argv, envp, AT_EMPTY_PATH).
   * Resolves the fd path via kernel_get_fd_path, then delegates to exec flow.
   */
  private handleExecveat(channel: ChannelInfo, origArgs: number[]): void {
    const AT_EMPTY_PATH = 0x1000;
    const dirfd = origArgs[0];
    const flags = origArgs[4];

    const processMem = new Uint8Array(channel.memory.buffer);

    // Read path from process memory
    const pw = this.getPtrWidth(channel.pid);
    const pathStr = this.readCStringFromProcess(processMem, origArgs[1]);
    const argv = this.readStringArrayFromProcess(processMem, origArgs[2], pw);
    const envp = this.readStringArrayFromProcess(processMem, origArgs[3], pw);

    let execPath: string;

    if ((flags & AT_EMPTY_PATH) !== 0 && pathStr === "") {
      // fexecve path: resolve fd to file path via kernel
      const getFdPath = this.kernelInstance!.exports.kernel_get_fd_path as
        ((pid: number, fd: number, bufPtr: bigint, bufLen: number) => number) | undefined;
      if (!getFdPath) {
        this.completeChannel(channel, SYS_EXECVEAT, origArgs, undefined, -1, 38); // ENOSYS
        return;
      }
      const result = getFdPath(channel.pid, dirfd, BigInt(this.scratchOffset), 4096);
      if (result <= 0) {
        const errno = result < 0 ? (-result) >>> 0 : 2; // ENOENT
        this.completeChannel(channel, SYS_EXECVEAT, origArgs, undefined, -1, errno);
        return;
      }
      const kernelBuf = new Uint8Array(this.kernelMemory!.buffer);
      execPath = new TextDecoder().decode(kernelBuf.slice(this.scratchOffset, this.scratchOffset + result));
    } else if (pathStr.startsWith("/")) {
      execPath = pathStr;
    } else {
      // Relative path — let kernel resolve against dirfd/CWD.
      // For simplicity, resolve against process CWD here.
      // The kernel's sys_execveat already resolves this, but since we intercept
      // host-side, we need to do it ourselves.
      const getCwd = this.kernelInstance!.exports.kernel_get_cwd as
        ((pid: number, bufPtr: number, bufLen: number) => number) | undefined;
      if (getCwd) {
        const cwdLen = getCwd(channel.pid, this.scratchOffset, 4096);
        if (cwdLen > 0) {
          const kernelBuf = new Uint8Array(this.kernelMemory!.buffer);
          const cwd = new TextDecoder().decode(kernelBuf.slice(this.scratchOffset, this.scratchOffset + cwdLen));
          execPath = cwd.endsWith("/") ? cwd + pathStr : cwd + "/" + pathStr;
        } else {
          execPath = pathStr;
        }
      } else {
        execPath = pathStr;
      }
    }

    if (!this.callbacks.onExec) {
      this.completeChannel(channel, SYS_EXECVEAT, origArgs, undefined, -1, 38); // ENOSYS
      return;
    }

    this.callbacks.onExec(channel.pid, execPath, argv, envp).then((result) => {
      if (result < 0) {
        this.completeChannel(channel, SYS_EXECVEAT, origArgs, undefined, -1, (-result) >>> 0);
      }
    }).catch((err) => {
      console.error(`[kernel] execveat error for pid ${channel.pid}:`, err);
      this.completeChannel(channel, SYS_EXECVEAT, origArgs, undefined, -1, 5); // EIO
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
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, BigInt(origArgs[i]), true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
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
    // These are always written as u32 by the glue (even on wasm64, table indices are i32)
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

    // Run the kernel's exit path so it closes all FDs (including pipe
    // write ends). kernel_exit calls sys_exit then traps — catch the trap.
    {
      const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
      kernelView.setUint32(CH_SYSCALL, syscallNr, true);
      kernelView.setBigInt64(CH_ARGS, BigInt(exitStatus), true);
      const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
        (offset: bigint, pid: number) => number;
      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(BigInt(this.scratchOffset), channel.pid);
      } catch {
        // Expected: kernel_exit traps with unreachable after closing FDs
      } finally {
        this.currentHandlePid = 0;
      }
    }

    // Main thread exit or exit_group: record exit status for waitpid,
    // queue SIGCHLD to parent, then notify the host callback.
    const exitingPid = channel.pid;
    // Idempotency: this guard is shared with handleProcessTerminated so a
    // SYS_KILL that races a clean SYS_EXIT from the same process doesn't
    // produce two SIGCHLDs / two parent wake-ups. Cleared by
    // deactivateProcess and registerProcess.
    if (this.hostReaped.has(exitingPid)) {
      // Already reaped via the kill path — still complete the channel so
      // the worker can finish tearing down, but skip the parent-wakeup work.
      this.completeChannelRaw(channel, 0, 0);
      this.scheduleWakeBlockedRetries();
      if (this.callbacks.onExit) this.callbacks.onExit(exitingPid, exitStatus);
      return;
    }
    this.hostReaped.add(exitingPid);
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
      // Check if parent has SA_NOCLDWAIT set (or SIGCHLD set to SIG_IGN).
      // If so, auto-reap the child — don't store as zombie, and per POSIX,
      // don't send SIGCHLD.
      const hasNoCldWait = this.kernelInstance!.exports
        .kernel_has_sa_nocldwait as ((pid: number) => number) | undefined;
      const autoReap = hasNoCldWait ? hasNoCldWait(parentPid) === 1 : false;

      if (!autoReap) {
        this.exitedChildren.set(exitingPid, waitStatus);

        // Queue SIGCHLD on parent process in the kernel.
        // kernel_kill handles cross-process signal delivery in centralized mode.
        this.sendSignalToProcess(parentPid, SIGCHLD);

        // Wake any parent blocked in waitpid
        this.wakeWaitingParent(parentPid, exitingPid, waitStatus);
      } else {
        // Auto-reap: clean up child tracking without leaving a zombie.
        // SIGCHLD is suppressed per POSIX when SA_NOCLDWAIT is set.
        this.childToParent.delete(exitingPid);
      }
    }

    // Complete the channel so the worker unblocks from Atomics.wait().
    // Without this, the worker stays blocked and Node.js aborts when
    // trying to terminate worker threads during process.exit().
    this.completeChannelRaw(channel, 0, 0);

    // Wake any processes blocked on pipe reads/polls — the exiting process's
    // FDs were closed by the kernel (sys_exit), so pipes with no remaining
    // writers should now return EOF to readers.
    this.scheduleWakeBlockedRetries();

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
    // Idempotency guard — both handleExit and reapKilledProcessesAfterSyscall
    // can route here for the same pid; do the parent-wakeup work exactly
    // once per generation. Cleared by deactivateProcess + registerProcess
    // so a recycled pid (currently impossible with monotonic nextChildPid,
    // but defensive) starts fresh.
    if (this.hostReaped.has(exitingPid)) return;
    this.hostReaped.add(exitingPid);
    const parentPid = this.childToParent.get(exitingPid);
    if (parentPid !== undefined) {
      const hasNoCldWait = this.kernelInstance!.exports
        .kernel_has_sa_nocldwait as ((pid: number) => number) | undefined;
      const autoReap = hasNoCldWait ? hasNoCldWait(parentPid) === 1 : false;

      if (!autoReap) {
        this.exitedChildren.set(exitingPid, waitStatus);
        this.sendSignalToProcess(parentPid, SIGCHLD);
        this.wakeWaitingParent(parentPid, exitingPid, waitStatus);
      } else {
        this.childToParent.delete(exitingPid);
      }
    }

    // Clean up per-process state
    this.sharedMappings.delete(exitingPid);

    // Do NOT complete the channel — the worker is blocked on Atomics.wait
    // and waking it would cause the C code to continue executing.
    // onExit will terminate the worker.
    if (this.callbacks.onExit) {
      const exitCode = waitStatus > 0xff ? (waitStatus >> 8) & 0xff : 128 + (waitStatus & 0x7f);
      this.callbacks.onExit(exitingPid, exitCode);
    }
  }

  /**
   * After SYS_KILL completes, scan for processes the kernel just marked
   * Exited that the host hasn't reaped. Without this, a `kill` of a
   * sleeping child (or any process not blocked in poll/select/pipe — those
   * are handled by scheduleWakeBlockedRetries) silently reaps the process
   * at the kernel level but leaves it in parentToChildren — wait4(-1)
   * then blocks forever.
   *
   * The kernel sets exit_status to 128 + signum for default Terminate
   * actions. Anything < 0 means the process is still alive.
   */
  private reapKilledProcessesAfterSyscall(): void {
    const getExitStatus = this.kernelInstance!.exports
      .kernel_get_process_exit_status as ((pid: number) => number) | undefined;
    if (!getExitStatus) return;

    // Snapshot the registered pids so we can mutate this.processes safely
    // inside the loop (handleProcessTerminated calls onExit which can
    // remove entries).
    const pids = Array.from(this.processes.keys());
    for (const pid of pids) {
      const status = getExitStatus(pid);
      if (status < 0) continue;             // still alive
      if (this.hostReaped.has(pid)) continue; // already reaped this generation

      const sigKilled = status >= 128 ? status - 128 : 0;
      const waitStatus = sigKilled > 0
        ? (sigKilled & 0x7f)
        : ((status & 0xff) << 8);

      // Cancel any pending blocking-syscall timers — the process is gone.
      const ps = this.pendingSleeps.get(pid);
      if (ps) { clearTimeout(ps.timer); this.pendingSleeps.delete(pid); }

      const proc = this.processes.get(pid);
      const ch = proc?.channels[0];
      // handleProcessTerminated re-checks hostReaped and adds the pid
      // itself, so passing through here is idempotent if two reap
      // events fire close together.
      if (ch) this.handleProcessTerminated(ch, waitStatus);
    }
  }
  /** Track pids the host has already reaped (prevents double-reaping
   *  when reapKilledProcessesAfterSyscall is called multiple times for
   *  the same already-Exited process). Cleared when the pid is
   *  re-allocated by a fresh fork+register. */
  private hostReaped = new Set<number>();

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
    // Waitpid is handled host-side (never goes through kernel_handle_channel),
    // so we must check for pending signals here. Without this, cross-process
    // signals (e.g., kill from child to parent) are lost — the signal is queued
    // in the kernel but never dequeued for the blocked parent.
    this.dequeueSignalForDelivery(channel);
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
      this.dequeueSignalForDelivery(waiter.channel);
      this.completeChannel(waiter.channel, SYS_WAITID, waiter.origArgs, undefined, 0, 0);
    } else {
      // wait4: write wstatus, consume zombie
      this.consumeExitedChild(parentPid, childPid);
      this.writeWaitStatus(waiter.channel, waiter.origArgs[1], waitStatus);
      this.completeWaitpid(waiter.channel, waiter.origArgs, childPid, 0);
    }
  }

  /**
   * Re-check deferred waitpid/waitid calls after a process group change.
   * When a child changes its pgid (setpgid/setsid), a parent waiting on
   * waitpid(-pgid) may no longer have matching children → return ECHILD.
   */
  private recheckDeferredWaitpids(): void {
    // Iterate backwards to safely splice while iterating
    for (let i = this.waitingForChild.length - 1; i >= 0; i--) {
      const waiter = this.waitingForChild[i];
      // Only re-check waiters targeting a specific process group (pid < -1 or pid == 0)
      if (waiter.pid > 0 || waiter.pid === -1) continue;

      if (!this.hasMatchingLivingChild(waiter.parentPid, waiter.pid) &&
          !this.findExitedChild(waiter.parentPid, waiter.pid)) {
        // No more matching children — wake with ECHILD
        this.waitingForChild.splice(i, 1);
        if (waiter.syscallNr === SYS_WAITID) {
          this.completeChannel(waiter.channel, SYS_WAITID, waiter.origArgs, undefined, -1, 10);
        } else {
          this.completeWaitpid(waiter.channel, waiter.origArgs, -1, 10); // ECHILD = 10
        }
      }
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
      // Match children in the specified process group.
      // id=0 means caller's own process group.
      const targetPgid = id === 0 ? this.getProcessPgid(parentPid) : id;
      for (const childPid of children) {
        if (this.exitedChildren.has(childPid) && this.getProcessPgid(childPid) === targetPgid) {
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

    // Check for living children matching the target
    let hasLivingChild = false;
    if (idtype === P_PID) {
      hasLivingChild = children.has(id) && !this.exitedChildren.has(id);
    } else if (idtype === P_PGID) {
      const targetPgid = id === 0 ? this.getProcessPgid(parentPid) : id;
      for (const childPid of children) {
        if (!this.exitedChildren.has(childPid) && this.getProcessPgid(childPid) === targetPgid) {
          hasLivingChild = true;
          break;
        }
      }
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

    // Blocking wait: defer until a child exits.
    // Convert idtype/id to waitpid-style pid for childMatchesWaitTarget():
    //   P_PID  → positive pid
    //   P_ALL  → -1 (any child)
    //   P_PGID → 0 (caller's pgid) or -pgid (specific group)
    let waitPid: number;
    if (idtype === P_PID) {
      waitPid = id;
    } else if (idtype === P_PGID) {
      waitPid = id === 0 ? 0 : -id;
    } else {
      waitPid = -1;
    }
    this.waitingForChild.push({
      parentPid,
      channel,
      origArgs,
      pid: waitPid,
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
      // Pre-empt cancel: if SYS_THREAD_CANCEL arrived before we got here
      // the channel status was PENDING but no futex wait had been set up
      // yet, so handleThreadCancel had nothing to notify.  Completing the
      // syscall with EINTR lets the guest's post-__testcancel() pick up
      // the flag and exit. The deferred-cancel guest overlay treats this
      // return value like any other EINTR and checks self->cancel.
      if (this.pendingCancels.has(channel.channelOffset)) {
        this.pendingCancels.delete(channel.channelOffset);
        this.completeChannelRaw(channel, -EINTR_ERRNO, EINTR_ERRNO);
        this.relistenChannel(channel);
        return;
      }
      // Compare value at addr with expected
      const currentVal = Atomics.load(i32View, index);
      if (currentVal !== val) {
        // Value already changed — return -EAGAIN (Linux convention)
        this.completeChannelRaw(channel, -EAGAIN, EAGAIN);
        this.relistenChannel(channel);
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
          this.relistenChannel(channel);
          return;
        }
        timeoutMs = tv_sec * 1000 + Math.ceil(tv_nsec / 1_000_000);
        if (timeoutMs <= 0) timeoutMs = 1; // minimum 1ms
        // Cap to avoid Node.js TimeoutOverflowWarning (max safe is 2^31-1 ms ≈ 24.8 days).
        // Without this, huge timeouts from 32-bit LONG_MAX deadlines get clipped to 1ms
        // by Node.js, causing tight retry loops.
        if (timeoutMs > 2147483647) timeoutMs = 2147483647;
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
          this.pendingFutexWaits.delete(channel.channelOffset);
          if (!this.processes.has(channel.pid)) return;
          this.completeChannelRaw(channel, retVal, errVal);
          channel.consecutiveSyscalls = 0; // genuinely blocked — reset
          this.relistenChannel(channel);
        };

        // Track the wait so SYS_THREAD_CANCEL can force-wake this channel
        // by firing Atomics.notify on the futex address. The waitAsync
        // Promise resolves naturally and complete() runs above.
        this.pendingFutexWaits.set(channel.channelOffset, { channel, futexIndex: index });

        waitResult.value.then(() => {
          complete(0, 0);
        });

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
        this.relistenChannel(channel);
      }
      return;
    }

    if (baseOp === FUTEX_WAKE || baseOp === FUTEX_WAKE_BITSET) {
      const woken = Atomics.notify(i32View, index, val);
      this.completeChannelRaw(channel, woken, 0);
      this.relistenChannel(channel);
      return;
    }

    if (baseOp === FUTEX_REQUEUE || baseOp === FUTEX_CMP_REQUEUE) {
      // Wake val waiters on uaddr, can't truly requeue with Atomics,
      // so wake val + val2 on uaddr.
      const val2 = origArgs[3]; // timeout param repurposed as val2
      const woken = Atomics.notify(i32View, index, val + val2);
      this.completeChannelRaw(channel, woken, 0);
      this.relistenChannel(channel);
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
      this.relistenChannel(channel);
      return;
    }

    // Unknown futex op — return -ENOSYS
    this.completeChannelRaw(channel, -38, 38);
    this.relistenChannel(channel);
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
    kernelView.setBigInt64(CH_ARGS, BigInt(targetPid), true);       // arg0 = pid
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(signum), true);      // arg1 = sig
    for (let i = 2; i < CH_ARGS_COUNT; i++) {
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }

    const handleChannel = this.kernelInstance.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    this.currentHandlePid = targetPid;
    // Host-originated signal (SIGCHLD, SIGALRM, timer, etc.) is always a
    // "shared" delivery — it lands on the process's pending queue, not a
    // specific thread's. Force tid=0 so the kernel doesn't consult any
    // per-thread state left over from a prior dispatch.
    const setTid = this.kernelInstance.exports.kernel_set_current_tid as
      ((tid: number) => void) | undefined;
    if (setTid) setTid(0);
    try {
      handleChannel(BigInt(this.scratchOffset), targetPid);
    } catch (err) {
      // Non-fatal — signal delivery is best-effort from the host side
      console.error(`[sendSignalToProcess] kernel threw for pid=${targetPid} sig=${signum}: ${err}`);
    } finally {
      this.currentHandlePid = 0;
    }

    // Check if the signal is deliverable (not blocked by the process)
    const isBlocked = (this.kernelInstance!.exports.kernel_is_signal_blocked as
      (pid: number, signum: number) => number)(targetPid, signum);
    if (isBlocked) return;

    // Signal is deliverable — wake any blocking syscall for this process

    // 1. Pending sleep (nanosleep, usleep, clock_nanosleep)
    const pendingSleep = this.pendingSleeps.get(targetPid);
    if (pendingSleep) {
      clearTimeout(pendingSleep.timer);
      this.pendingSleeps.delete(targetPid);
      this.completeSleepWithSignalCheck(
        pendingSleep.channel, pendingSleep.syscallNr, pendingSleep.origArgs,
        pendingSleep.retVal, pendingSleep.errVal,
      );
    }

    // 2. Pending ppoll/poll retry — wake ALL threads for this pid
    for (const [key, pollEntry] of this.pendingPollRetries) {
      if (pollEntry.channel.pid !== targetPid) continue;
      if (pollEntry.timer) clearTimeout(pollEntry.timer);
      this.pendingPollRetries.delete(key);
      if (this.processes.has(targetPid)) {
        this.retrySyscall(pollEntry.channel);
      }
    }

    // 3. Pending pselect6 retry
    const selectEntry = this.pendingSelectRetries.get(targetPid);
    if (selectEntry) {
      clearImmediate(selectEntry.timer);
      this.pendingSelectRetries.delete(targetPid);
      if (this.processes.has(targetPid)) {
        this.handlePselect6(selectEntry.channel, selectEntry.origArgs);
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

    // MAP_FAILED is -1 (all bits set). For wasm64 processes retVal could be
    // a large positive number when interpreted as unsigned, but the kernel
    // returns -1 (sign-extended) which JS sees as -1.  Use a simple < 0
    // check instead of comparing to a fixed 32-bit constant.
    if (syscallNr === SYS_BRK) {
      // retVal is the new program break address
      if (retVal >= 0) endAddr = retVal;
    } else if (syscallNr === SYS_MMAP) {
      // retVal is the mapped address, origArgs[1] is the length
      if (retVal >= 0) {
        mmapAddr = retVal;
        mmapLen = origArgs[1];
        endAddr = mmapAddr + mmapLen;
      }
    } else if (syscallNr === SYS_MREMAP) {
      // retVal is the new address, origArgs[2] is the new length
      if (retVal >= 0) {
        mmapAddr = retVal;
        mmapLen = origArgs[2];
        endAddr = mmapAddr + mmapLen;
      }
    }

    const currentBytes = processMemory.buffer.byteLength;

    if (endAddr > 0 && endAddr > currentBytes) {
      const neededPages = Math.ceil((endAddr - currentBytes) / 65536);
      processMemory.grow(neededPages);
      // Memory.grow detaches any TypedArray bound to the previous SAB.
      // Any cached framebuffer view on this pid is now invalid; the
      // renderer must rebuild it on the next frame from the new
      // Memory.buffer. Idempotent for pids without a binding.
      this.kernel.framebuffers.rebindMemory(this.currentHandlePid);
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

  /**
   * Populate a file-backed mmap region by reading from the file fd via pread.
   * Called after the kernel allocates the anonymous region and the host zeroes it.
   * Reads in CH_DATA_SIZE chunks using the kernel's pread handler.
   */
  private populateMmapFromFile(
    channel: ChannelInfo,
    mmapAddr: number,
    origArgs: number[],
  ): void {
    const fd = origArgs[4];
    const mapLen = origArgs[1];
    // musl sends page offset (off / 4096) as arg[5]
    const pageOffset = origArgs[5];
    let fileOffset = pageOffset * 4096;

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
    const dataStart = this.scratchOffset + CH_DATA;

    let written = 0;
    while (written < mapLen) {
      const chunkSize = Math.min(CH_DATA_SIZE, mapLen - written);

      // Set up pread syscall in kernel scratch:
      // SYS_PREAD (64): (fd, buf_ptr, count, offset_lo, offset_hi)
      kernelView.setUint32(CH_SYSCALL, SYS_PREAD, true);
      kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(fd), true);        // fd
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);  // buf_ptr (kernel memory)
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(chunkSize), true);  // count
      kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(fileOffset & 0xffffffff), true);  // offset_lo
      kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(Math.floor(fileOffset / 0x100000000) | 0), true); // offset_hi
      kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(0), true);

      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(BigInt(this.scratchOffset), channel.pid);
      } catch {
        break; // pread failed, leave rest as zeros
      }
      this.currentHandlePid = 0;

      const bytesRead = Number(kernelView.getBigInt64(CH_RETURN, true));
      if (bytesRead <= 0) break; // EOF or error

      // Copy from kernel scratch data area to process memory
      const processMem = new Uint8Array(channel.memory.buffer);
      processMem.set(
        kernelMem.subarray(dataStart, dataStart + bytesRead),
        mmapAddr + written,
      );

      written += bytesRead;
      fileOffset += bytesRead;

      if (bytesRead < chunkSize) break; // short read = EOF
    }
  }

  /**
   * Flush MAP_SHARED regions that overlap the msync range back to the file.
   * Reads from process memory and writes to the file via pwrite.
   */
  private flushSharedMappings(
    channel: ChannelInfo,
    origArgs: number[],
  ): void {
    const syncAddr = origArgs[0] >>> 0;
    const syncLen = origArgs[1] >>> 0;
    const pidMap = this.sharedMappings.get(channel.pid);
    if (!pidMap || pidMap.size === 0) return;

    const syncEnd = syncAddr + syncLen;

    for (const [mapAddr, mapping] of pidMap) {
      const mapEnd = mapAddr + mapping.len;
      // Check overlap
      if (mapAddr >= syncEnd || mapEnd <= syncAddr) continue;

      // Compute overlap region
      const flushStart = Math.max(syncAddr, mapAddr);
      const flushEnd = Math.min(syncEnd, mapEnd);
      const flushLen = flushEnd - flushStart;
      if (flushLen <= 0) continue;

      // File offset for the flush region
      const fileOffsetBase = mapping.fileOffset + (flushStart - mapAddr);

      // Read from process memory and write to file via pwrite
      this.pwriteFromProcessMemory(
        channel, mapping.fd, flushStart, flushLen, fileOffsetBase,
      );
    }
  }

  /**
   * Write data from process memory to a file via kernel pwrite syscalls.
   */
  private pwriteFromProcessMemory(
    channel: ChannelInfo,
    fd: number,
    processAddr: number,
    len: number,
    fileOffset: number,
  ): void {
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: bigint, pid: number) => number;
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
    const dataStart = this.scratchOffset + CH_DATA;

    let written = 0;
    while (written < len) {
      const chunkSize = Math.min(CH_DATA_SIZE, len - written);

      // Copy chunk from process memory to kernel scratch data area
      const processMem = new Uint8Array(channel.memory.buffer);
      kernelMem.set(
        processMem.subarray(processAddr + written, processAddr + written + chunkSize),
        dataStart,
      );

      // Set up pwrite syscall in kernel scratch:
      // SYS_PWRITE (65): (fd, buf_ptr, count, offset_lo, offset_hi)
      const curOffset = fileOffset + written;
      kernelView.setUint32(CH_SYSCALL, SYS_PWRITE, true);
      kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(fd), true);
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(dataStart), true);
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(chunkSize), true);
      kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(curOffset & 0xffffffff), true);
      kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(Math.floor(curOffset / 0x100000000) | 0), true);
      kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(0), true);

      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(BigInt(this.scratchOffset), channel.pid);
      } catch {
        break;
      }
      this.currentHandlePid = 0;

      const bytesWritten = Number(kernelView.getBigInt64(CH_RETURN, true));
      if (bytesWritten <= 0) break;

      written += bytesWritten;
      if (bytesWritten < chunkSize) break;
    }
  }

  /**
   * Remove shared mapping entries that overlap the munmap range.
   */
  private cleanupSharedMappings(pid: number, addr: number, len: number): void {
    const pidMap = this.sharedMappings.get(pid);
    if (!pidMap) return;

    const unmapEnd = addr + len;
    for (const [mapAddr, mapping] of pidMap) {
      const mapEnd = mapAddr + mapping.len;
      // Remove if fully contained in unmap range
      if (mapAddr >= addr && mapEnd <= unmapEnd) {
        pidMap.delete(mapAddr);
      }
    }

    if (pidMap.size === 0) {
      this.sharedMappings.delete(pid);
    }
  }

  /** Set the next child PID to allocate. */
  setNextChildPid(pid: number): void {
    this.nextChildPid = pid;
  }

  /**
   * Set the mmap address space ceiling for a process.
   * Must be called before the process worker starts to prevent mmap
   * from allocating in the thread channel/TLS region.
   */
  setMaxAddr(pid: number, maxAddr: number): void {
    const setMaxAddrFn = this.kernelInstance!.exports.kernel_set_max_addr as
      ((pid: number, maxAddr: bigint) => number) | undefined;
    if (setMaxAddrFn) {
      setMaxAddrFn(pid, BigInt(maxAddr));
    }
  }

  /**
   * Set the program's initial brk to its `__heap_base` value. Must be
   * called between `registerProcess` and the moment the new process worker
   * issues its first syscall — otherwise the kernel falls back to its
   * built-in `INITIAL_BRK` constant, which can land inside the program's
   * stack region for binaries with a large data section (e.g. mariadbd).
   *
   * Accepts `bigint` (preferred — what `extractHeapBase` returns) or
   * `number`. The kernel runs in wasm64 so the export takes a `usize`,
   * which is `bigint` on the JS side.
   */
  setBrkBase(pid: number, addr: bigint | number): void {
    const setBrkBaseFn = this.kernelInstance!.exports.kernel_set_brk_base as
      ((pid: number, addr: bigint) => number) | undefined;
    if (setBrkBaseFn) {
      setBrkBaseFn(pid, typeof addr === "bigint" ? addr : BigInt(addr));
    }
  }

  /** Get the underlying kernel instance for direct access. */
  getKernel(): WasmPosixKernel {
    return this.kernel;
  }

  /**
   * Live `/dev/fb0` mappings reported by the kernel, indexed by pid.
   * Renderers (canvas in browser, no-op in Node) read from this on
   * each frame; the kernel populates it via the `host_bind_framebuffer`
   * import.
   */
  get framebuffers() {
    return this.kernel.framebuffers;
  }

  /**
   * Return the wasm `Memory` for `pid` (or `undefined` if no such
   * process is registered). Renderers use this to build typed-array
   * views over the bound framebuffer region.
   */
  getProcessMemory(pid: number): WebAssembly.Memory | undefined {
    return this.processes.get(pid)?.memory;
  }

  /** Get the kernel Wasm instance. */
  getKernelInstance(): WebAssembly.Instance | null {
    return this.kernelInstance;
  }

  /**
   * ABI version the kernel advertised at startup via its
   * `__abi_version` export. Worker processes compare against this
   * and refuse to run programs built against an incompatible ABI.
   */
  getKernelAbiVersion(): number {
    return this.kernelAbiVersion;
  }

  // ---------------------------------------------------------------------------
  // TCP bridge — injects real TCP connections into kernel pipe-buffer sockets
  // ---------------------------------------------------------------------------

  /**
   * Start a TCP server for a listening socket, bridging real TCP connections
   * into the kernel's pipe-buffer-backed accept path.
   */
  private startTcpListener(pid: number, fd: number, port: number): void {
    const key = `${pid}:${fd}`;
    // Avoid duplicate listeners on the same pid:fd
    if (this.tcpListeners.has(key)) return;

    // Register this pid:fd as a target for this port (needed for both
    // Node.js TCP bridging and browser service worker bridging via
    // pickListenerTarget + injectConnection)
    if (!this.tcpListenerTargets.has(port)) {
      this.tcpListenerTargets.set(port, []);
      this.tcpListenerRRIndex.set(port, 0);
    }
    const targets = this.tcpListenerTargets.get(port)!;
    if (!targets.some(t => t.pid === pid && t.fd === fd)) {
      targets.push({ pid, fd });
    }

    if (!this.netModule) return; // Not in Node.js environment — no real TCP server

    // If another process already has a TCP server on this port, share it
    for (const [, listener] of this.tcpListeners) {
      if (listener.port === port) {
        this.tcpListeners.set(key, listener);
        return;
      }
    }

    const net = this.netModule;

    const connections = new Set<import("net").Socket>();
    const server = net.createServer((clientSocket) => {
      // Pick target via round-robin among registered processes for this port
      const target = this.pickListenerTarget(port);
      if (target) {
        this.handleIncomingTcpConnection(target.pid, target.fd, clientSocket, connections);
      } else {
        clientSocket.destroy();
      }
    });

    server.listen(port, "0.0.0.0", () => {
      // Server is ready
    });

    server.on("error", (err) => {
      console.error(`TCP listener error on port ${port}:`, err);
    });

    this.tcpListeners.set(key, { server, pid, port, connections });
  }

  /**
   * Pick the next listener target for a port via round-robin.
   * Only considers processes that are still registered.
   */
  private pickListenerTarget(port: number): {pid: number, fd: number} | null {
    const targets = this.tcpListenerTargets.get(port);
    if (!targets || targets.length === 0) return null;

    // Filter out dead processes
    const alive = targets.filter(t => this.processes.has(t.pid));
    if (alive.length === 0) return null;

    // Update targets list to remove dead processes
    if (alive.length !== targets.length) {
      this.tcpListenerTargets.set(port, alive);
    }

    // If there are fork children among targets, prefer them over the original
    // listener (the master doesn't accept connections, workers do).
    let candidates = alive;
    if (alive.length > 1) {
      const children = alive.filter(t => this.childToParent.has(t.pid));
      if (children.length > 0) {
        candidates = children;
      }
    }

    const idx = (this.tcpListenerRRIndex.get(port) ?? 0) % candidates.length;
    this.tcpListenerRRIndex.set(port, idx + 1);
    return candidates[idx]!;
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

    // Wake any blocked poll/accept anywhere — the listener's shared
    // accept queue now has a new entry, and any worker sharing the
    // listener can pick it up. Broad wake covers all of them.
    this.scheduleWakeBlockedRetries();

    const sendPipeIdx = recvPipeIdx + 1;

    // The injected pipes live in the global pipe table (see
    // kernel_inject_connection in crates/kernel/src/wasm_api.rs). Pass
    // pid=0 to the kernel pipe APIs as a sentinel meaning "use the
    // global pipe table" — needed because any process sharing the
    // listener can accept this connection, so the pipes can't live in
    // a single process's per-pid pipe table.
    const GLOBAL_PIPE_PID = 0;
    const pipeWrite = this.kernelInstance!.exports.kernel_pipe_write as
      (pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number) => number;
    const pipeRead = this.kernelInstance!.exports.kernel_pipe_read as
      (pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number) => number;
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
        const written = pipeWrite(GLOBAL_PIPE_PID, recvPipeIdx, BigInt(scratchOffset), toWrite);
        if (written <= 0) break; // Pipe full, retry next pump
        if (written >= chunk.length) {
          inboundQueue.shift();
        } else {
          inboundQueue[0] = chunk.subarray(written) as Buffer;
        }
      }
      if (clientEnded && inboundQueue.length === 0) {
        pipeCloseWrite(GLOBAL_PIPE_PID, recvPipeIdx);
      }
    };

    // Read send pipe → TCP socket (drains all available data)
    const drainOutbound = () => {
      const mem = this.getKernelMem();
      let totalRead = 0;
      // Loop to drain the entire pipe, not just one 65KB chunk.
      // Responses larger than 65KB (e.g. 662KB site-editor.php) need
      // multiple reads to fully transfer.
      for (;;) {
        const readN = pipeRead(GLOBAL_PIPE_PID, sendPipeIdx, BigInt(scratchOffset), 65536);
        if (readN <= 0) break;
        totalRead += readN;
        const outData = Buffer.from(mem.slice(scratchOffset, scratchOffset + readN));
        if (!clientSocket.destroyed) {
          clientSocket.write(outData);
        }
      }
      return totalRead;
    };

    const schedulePump = (delayMs = 0) => {
      if (pumpPending || cleaned) return;
      pumpPending = true;
      if (delayMs > 0) {
        setTimeout(pump, delayMs);
      } else {
        setImmediate(pump);
      }
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
      const writeOpen = pipeIsWriteOpen(GLOBAL_PIPE_PID, sendPipeIdx);
      if (writeOpen === 0 && readN === 0) {
        if (!clientSocket.destroyed) {
          clientSocket.end();
        }
        cleanup();
        return;
      }

      // Always reschedule while connection is alive. After fork(), the child
      // process writes response data to the same pipe, but flushTcpSendPipes
      // is keyed by pid and won't find the parent's connections. Without
      // continuous pumping, response data gets stranded in the pipe.
      // Use setImmediate for both active and idle — the 2ms idle delay adds
      // significant latency when fork children write to the send pipe (since
      // flushTcpSendPipes is keyed by parent pid and won't find child writes).
      schedulePump();
    };

    // Incoming TCP data → write directly to recv pipe, queue overflow
    clientSocket.on("data", (chunk: Buffer) => {
      inboundQueue.push(chunk);
      if (!this.processes.has(pid)) { cleanup(); return; }
      drainInbound();
      // Wake readers + pollers watching this recv pipe + broad wake.
      // The pid filter limits the targeted poll wake to this listener
      // pid (the recvPipeIdx is per-connection so any matching poller
      // is necessarily owned by this pid; the filter is defensive).
      this.notifyPipeReadable(recvPipeIdx, pid);
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
      // Close the host's ends of both pipes:
      //   recvPipe: host is the writer → close write end
      //   sendPipe: host is the reader → close read end
      pipeCloseWrite(GLOBAL_PIPE_PID, recvPipeIdx);
      pipeCloseRead(GLOBAL_PIPE_PID, sendPipeIdx);
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
    // Remove this pid from listener targets
    for (const [port, targets] of this.tcpListenerTargets) {
      const filtered = targets.filter(t => t.pid !== pid);
      if (filtered.length === 0) {
        this.tcpListenerTargets.delete(port);
        this.tcpListenerRRIndex.delete(port);
      } else {
        this.tcpListenerTargets.set(port, filtered);
      }
    }

    for (const [key, entry] of this.tcpListeners) {
      if (entry.pid === pid) {
        // Only close the server if no other processes share this port
        const hasOtherTargets = this.tcpListenerTargets.has(entry.port);
        if (!hasOtherTargets) {
          entry.server.close();
          for (const conn of entry.connections) {
            conn.destroy();
          }
          entry.connections.clear();
        }
        this.tcpListeners.delete(key);
      }
    }
    this.tcpConnections.delete(pid);
    this.shmMappings.delete(pid);
  }

  // =========================================================================
  // SysV IPC handlers — shmat/shmdt/semctl need host-side interception
  //
  // Most IPC syscalls now go through the kernel via SYSCALL_ARGS marshalling.
  // shmat/shmdt are intercepted because they require process memory management
  // (mmap address allocation, data transfer between kernel and process memory).
  // semctl is intercepted because arg[3] is cmd-dependent (scalar vs pointer).
  // =========================================================================

  /** semctl: cmd-dependent arg handling — can't use SYSCALL_ARGS since arg[3]
   *  is a scalar for some commands and a pointer for others. */
  private handleSemctl(channel: ChannelInfo, origArgs: number[]): void {
    const [semid, semnum, rawCmd, arg] = origArgs;
    const cmd = rawCmd & ~IPC_64;
    const IPC_STAT = 2;
    const GETALL = 13;
    const SETALL = 17;

    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: bigint, pid: number) => number;
    const kernelMem = this.getKernelMem();
    const dataStart = this.scratchOffset + CH_DATA;

    if (cmd === IPC_STAT && arg !== 0) {
      // arg is an output pointer to semid_ds (72 bytes)
      kernelView.setUint32(CH_SYSCALL, SYS_SEMCTL, true);
      kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(semid), true);
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(semnum), true);
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(rawCmd), true);
      kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(dataStart), true); // redirect to scratch
      kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(0), true);
      kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(0), true);
      kernelMem.fill(0, dataStart, dataStart + 72);

      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try { handleChannel(BigInt(this.scratchOffset), channel.pid); } finally { this.currentHandlePid = 0; }

      const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
      if (retVal >= 0) {
        // Copy 72-byte struct back to process memory
        const processMem = new Uint8Array(channel.memory.buffer);
        processMem.set(kernelMem.subarray(dataStart, dataStart + 72), arg);
      }
      this.completeChannelRaw(channel, retVal, retVal < 0 ? -retVal : 0);
      this.relistenChannel(channel);
      return;
    }

    if (cmd === GETALL && arg !== 0) {
      // arg is an output pointer to u16[nsems] — allocate generous space
      const maxBytes = 1024; // up to 512 semaphores
      kernelView.setUint32(CH_SYSCALL, SYS_SEMCTL, true);
      kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(semid), true);
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(semnum), true);
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(rawCmd), true);
      kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(dataStart), true);
      kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(0), true);
      kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(0), true);
      kernelMem.fill(0, dataStart, dataStart + maxBytes);

      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try { handleChannel(BigInt(this.scratchOffset), channel.pid); } finally { this.currentHandlePid = 0; }

      const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
      if (retVal >= 0) {
        // Copy written data back — kernel wrote u16[] to scratch
        const processMem = new Uint8Array(channel.memory.buffer);
        processMem.set(kernelMem.subarray(dataStart, dataStart + maxBytes), arg);
      }
      this.completeChannelRaw(channel, retVal, retVal < 0 ? -retVal : 0);
      this.relistenChannel(channel);
      return;
    }

    if (cmd === SETALL && arg !== 0) {
      // arg is an input pointer to u16[nsems] — copy generous amount to scratch
      const maxBytes = 1024;
      const processMem = new Uint8Array(channel.memory.buffer);
      kernelMem.set(processMem.subarray(arg, arg + maxBytes), dataStart);

      kernelView.setUint32(CH_SYSCALL, SYS_SEMCTL, true);
      kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(semid), true);
      kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(semnum), true);
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(rawCmd), true);
      kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(dataStart), true);
      kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(0), true);
      kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(0), true);

      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try { handleChannel(BigInt(this.scratchOffset), channel.pid); } finally { this.currentHandlePid = 0; }

      const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
      this.completeChannelRaw(channel, retVal, retVal < 0 ? -retVal : 0);
      this.relistenChannel(channel);
      return;
    }

    // Scalar commands (SETVAL, GETVAL, GETPID, GETNCNT, GETZCNT, IPC_RMID):
    // arg is a scalar value, pass through directly to kernel
    kernelView.setUint32(CH_SYSCALL, SYS_SEMCTL, true);
    kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(semid), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(semnum), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(rawCmd), true);
    kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(arg), true);
    kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(0), true);
    kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(0), true);

    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try { handleChannel(BigInt(this.scratchOffset), channel.pid); } finally { this.currentHandlePid = 0; }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    this.completeChannelRaw(channel, retVal, retVal < 0 ? -retVal : 0);
    this.relistenChannel(channel);
  }

  /** shmat: allocate address via kernel mmap, copy segment data to process memory */
  private handleIpcShmat(channel: ChannelInfo, args: number[]): void {
    const [shmid, _shmaddr, _flags] = args;

    // Set current pid for kernel_ipc_* exports
    const setCurrentPid = this.kernelInstance!.exports.kernel_set_current_pid as ((pid: number) => void) | undefined;
    if (setCurrentPid) setCurrentPid(channel.pid);

    const kernelShmat = this.kernelInstance!.exports.kernel_ipc_shmat as (shmid: number, shmaddr: number, flags: number) => number;
    const sizeOrErr = kernelShmat(shmid, _shmaddr, _flags);
    if (sizeOrErr < 0) {
      this.completeChannelRaw(channel, sizeOrErr, -sizeOrErr);
      this.relistenChannel(channel);
      return;
    }
    const size = sizeOrErr;

    // Synthesize mmap to allocate virtual address space for this pid
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    kernelView.setUint32(CH_SYSCALL, SYS_MMAP, true);
    kernelView.setBigInt64(CH_ARGS + 0 * CH_ARG_SIZE, BigInt(0), true);          // addr hint = NULL
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(size), true);        // length
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(3), true);           // prot = PROT_READ|PROT_WRITE
    kernelView.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, BigInt(0x22), true);       // flags = MAP_PRIVATE|MAP_ANONYMOUS
    kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, BigInt(-1), true);         // fd = -1
    kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, BigInt(0), true);          // offset = 0

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: bigint, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(BigInt(this.scratchOffset), channel.pid);
    } catch (err) {
      console.error(`[handleIpcShmat] mmap failed for pid=${channel.pid}:`, err);
      this.completeChannelRaw(channel, -12, 12); // ENOMEM
      this.relistenChannel(channel);
      return;
    } finally {
      this.currentHandlePid = 0;
    }

    const addr = Number(kernelView.getBigInt64(CH_RETURN, true));
    if (addr < 0) {
      this.completeChannelRaw(channel, -12, 12); // ENOMEM
      this.relistenChannel(channel);
      return;
    }

    // Grow process memory to cover the allocated address
    this.ensureProcessMemoryCovers(channel.memory, SYS_MMAP, addr, [0, size, 3, 0x22, -1, 0]);

    // Transfer segment data from kernel to process memory via read_chunk
    const readChunk = this.kernelInstance!.exports.kernel_ipc_shm_read_chunk as (shmid: number, offset: number, outPtr: bigint, maxLen: number) => number;
    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const chunkSize = CH_DATA_SIZE;
    const chunkPtr = this.scratchOffset + CH_DATA;
    let transferred = 0;
    while (transferred < size) {
      const remaining = size - transferred;
      const toRead = Math.min(remaining, chunkSize);
      const nRead = readChunk(shmid, transferred, BigInt(chunkPtr), toRead);
      if (nRead <= 0) break;
      processMem.set(kernelMem.subarray(chunkPtr, chunkPtr + nRead), (addr >>> 0) + transferred);
      transferred += nRead;
    }

    // Track the mapping for shmdt
    let pidMappings = this.shmMappings.get(channel.pid);
    if (!pidMappings) {
      pidMappings = new Map();
      this.shmMappings.set(channel.pid, pidMappings);
    }
    pidMappings.set(addr >>> 0, { segId: shmid, size });

    this.completeChannelRaw(channel, addr, 0);
    this.relistenChannel(channel);
  }

  /** shmdt: copy process memory back to segment, untrack mapping */
  private handleIpcShmdt(channel: ChannelInfo, args: number[]): void {
    const addr = args[0];
    const pidMappings = this.shmMappings.get(channel.pid);
    if (!pidMappings) {
      this.completeChannelRaw(channel, -22, 22); // EINVAL
      this.relistenChannel(channel);
      return;
    }
    const mapping = pidMappings.get(addr);
    if (!mapping) {
      this.completeChannelRaw(channel, -22, 22); // EINVAL
      this.relistenChannel(channel);
      return;
    }

    // Set current pid for kernel exports
    const setCurrentPid = this.kernelInstance!.exports.kernel_set_current_pid as ((pid: number) => void) | undefined;
    if (setCurrentPid) setCurrentPid(channel.pid);

    // Sync process memory back to kernel segment via write_chunk
    const writeChunk = this.kernelInstance!.exports.kernel_ipc_shm_write_chunk as (shmid: number, offset: number, dataPtr: bigint, dataLen: number) => number;
    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const chunkSize = CH_DATA_SIZE;
    const chunkPtr = this.scratchOffset + CH_DATA;
    let transferred = 0;
    while (transferred < mapping.size) {
      const remaining = mapping.size - transferred;
      const toWrite = Math.min(remaining, chunkSize);
      kernelMem.set(processMem.subarray(addr + transferred, addr + transferred + toWrite), chunkPtr);
      const nWritten = writeChunk(mapping.segId, transferred, BigInt(chunkPtr), toWrite);
      if (nWritten <= 0) break;
      transferred += nWritten;
    }

    // Kernel-side detach bookkeeping
    const kernelShmdt = this.kernelInstance!.exports.kernel_ipc_shmdt as (shmid: number) => number;
    const result = kernelShmdt(mapping.segId);

    pidMappings.delete(addr);

    if (result < 0) {
      this.completeChannelRaw(channel, result, -result);
    } else {
      this.completeChannelRaw(channel, 0, 0);
    }
    this.relistenChannel(channel);
  }

  // =========================================================================
  // POSIX mqueue notification drain
  // =========================================================================

  /**
   * After mq_timedsend, check if the kernel has a pending notification
   * (a signal to deliver when a message arrives on a previously empty queue).
   * The notification is stored in the kernel's MqueueTable and drained here.
   */
  private drainMqueueNotification(): void {
    const drain = this.kernelInstance!.exports
      .kernel_mq_drain_notification as ((outPtr: bigint) => number) | undefined;
    if (!drain) return;

    // Use kernel scratch as output buffer for (pid: u32, signo: u32)
    const outOffset = this.scratchOffset;
    const hasPending = drain(BigInt(outOffset));
    if (hasPending) {
      const dv = new DataView(this.kernelMemory!.buffer, outOffset);
      const pid = dv.getUint32(0, true);
      const signo = dv.getUint32(4, true);
      if (signo > 0) {
        this.sendSignalToProcess(pid, signo);
      }
    }
  }
}
