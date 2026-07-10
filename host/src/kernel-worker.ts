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

import { WasmPosixKernel, type KernelPointer } from "./kernel";
import { SharedLockTable } from "./shared-lock-table";
import {
  buildRawHttpRequest,
  parseRawHttpResponse,
  type HttpRequest,
  type HttpResponse,
  type SendHttpRequestOptions,
} from "./networking/in-kernel-http";
import {
  ABI_KERNEL_EXPORT,
  ABI_SYSCALL_NAMES,
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_IDLE,
  CHANNEL_STATUS_PENDING,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_DATA,
  CH_DATA_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_BASE,
  CH_SIG_FLAGS,
  CH_SIG_HANDLER,
  CH_SIG_OLD_MASK,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  HOST_INTERCEPTED_SYSCALLS,
  PROCESS_MEMORY_PAGES_PER_THREAD_SLOT,
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  SYSCALL_ARGS,
  type SyscallArgDesc,
} from "./generated/abi";
import { validateKernelHostAdapterManifest } from "./host-adapter-manifest";
import { WASM_PAGE_SIZE } from "./constants";
import {
  FORK_SAVE_BUFFER_SIZE,
  PROCESS_MMAP_BASE,
  growMemoryToCover,
} from "./process-memory";

import type { KernelConfig, NetworkAddress, PlatformIO, TcpConnectionPeer, UdpDatagram } from "./types";

function concatChunksLocal(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Channel status values */
const CH_IDLE = CHANNEL_STATUS_IDLE;
const CH_PENDING = CHANNEL_STATUS_PENDING;
const CH_COMPLETE = CHANNEL_STATUS_COMPLETE;

/**
 * Size of the wpk_fork save buffer. Each channel reserves
 * `[channelOffset - FORK_BUF_SIZE, channelOffset)` for the unwind frames and
 * saved globals that the instrumented module writes during fork(). Must match
 * the constant in `worker-main.ts` and the onFork handlers in
 * node-kernel-worker-entry.ts / browser-kernel-worker-entry.ts.
 */
const FORK_BUF_SIZE = FORK_SAVE_BUFFER_SIZE;

/** Errno values */
const EAGAIN = 11;
const ETIMEDOUT = 110;
const EINTR_ERRNO = 4;

/** Syscall numbers for sleep/delay */
const SYS_NANOSLEEP = ABI_SYSCALLS.Nanosleep;
const SYS_USLEEP = ABI_SYSCALLS.Usleep;
const SYS_CLOCK_NANOSLEEP = ABI_SYSCALLS.ClockNanosleep;
const SYS_FUTEX = ABI_SYSCALLS.Futex;
const SYS_POLL = ABI_SYSCALLS.Poll;
const SYS_PPOLL = ABI_SYSCALLS.Ppoll;
const SYS_PSELECT6 = ABI_SYSCALLS.Pselect6;
const SYS_SELECT = ABI_SYSCALLS.Select;
const SYS_EPOLL_PWAIT = ABI_SYSCALLS.EpollPwait;
const SYS_EPOLL_CREATE1 = ABI_SYSCALLS.EpollCreate1;
const SYS_EPOLL_CREATE = ABI_SYSCALLS.EpollCreate;
const SYS_EPOLL_CTL = ABI_SYSCALLS.EpollCtl;
const SYS_EPOLL_WAIT = ABI_SYSCALLS.EpollWait;
const SYS_RT_SIGTIMEDWAIT = ABI_SYSCALLS.RtSigtimedwait;

/**
 * Grace period for signal-mask-swapping ppoll/pselect wakeups after a pipe
 * event. This gives the writer's immediately-following signal syscall a
 * chance to reach the kernel before ppoll restores its mask.
 */
const SIGNAL_SAFE_POLL_WAKE_DELAY_MS = 50;

/** Syscall numbers for signals */
const SYS_KILL = ABI_SYSCALLS.Kill;

/** Syscall numbers for fork/exec/clone */
const SYS_EXECVE = HOST_INTERCEPTED_SYSCALLS.SYS_EXECVE;
const SYS_EXECVEAT = HOST_INTERCEPTED_SYSCALLS.SYS_EXECVEAT;
const SYS_FORK = HOST_INTERCEPTED_SYSCALLS.SYS_FORK;
const SYS_VFORK = HOST_INTERCEPTED_SYSCALLS.SYS_VFORK;
const SYS_SPAWN = HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN;
const SYS_CLONE = ABI_SYSCALLS.Clone;
const SYS_EXIT = ABI_SYSCALLS.Exit;
const SYS_EXIT_GROUP = ABI_SYSCALLS.ExitGroup;
const SYS_SETPGID = ABI_SYSCALLS.Setpgid;
const SYS_SETSID = ABI_SYSCALLS.Setsid;
const SYS_WAIT4 = ABI_SYSCALLS.Wait4;
const SYS_WAITID = ABI_SYSCALLS.Waitid;
/** SYS_THREAD_CANCEL: host-side wake-up for deferred pthread cancellation.
 * See libc/musl-overlay/src/thread/wasm32posix/pthread_cancel.c for the design. */
const SYS_THREAD_CANCEL = ABI_SYSCALLS.ThreadCancel;

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
/** SIGKILL — used only as the host-teardown "exit now" marker handed to the
 *  guest glue (see killAllBlockedForTeardown). SIGKILL is never delivered to
 *  the guest in normal operation, so the glue treats it unambiguously.
 *  [JSC-TERMINATE-ATOMICS-WAIT-LEAK] — part of the workaround; see
 *  docs/jsc-terminate-atomics-wait-workaround.md. */
const SIGKILL = 9;

/** Network ioctl request codes */
const SIOCGIFCONF = 0x8912;
const SIOCGIFHWADDR = 0x8927;
const SIOCGIFADDR = 0x8915;

/** Ioctl syscall number */
const SYS_IOCTL = ABI_SYSCALLS.Ioctl;

/** Syscall numbers for memory management */
const SYS_MMAP = ABI_SYSCALLS.Mmap;
const SYS_MUNMAP = ABI_SYSCALLS.Munmap;
const SYS_BRK = ABI_SYSCALLS.Brk;
const SYS_MREMAP = ABI_SYSCALLS.Mremap;
const SYS_MSYNC = ABI_SYSCALLS.Msync;
const SYS_WRITE = ABI_SYSCALLS.Write;
const SYS_READ = ABI_SYSCALLS.Read;
const SYS_PREAD = ABI_SYSCALLS.Pread;
const SYS_PWRITE = ABI_SYSCALLS.Pwrite;
const SYS_SEND = ABI_SYSCALLS.Send;
const SYS_RECV = ABI_SYSCALLS.Recv;
const SYS_SENDTO = ABI_SYSCALLS.Sendto;
const SYS_RECVFROM = ABI_SYSCALLS.Recvfrom;
const SYS_SENDMSG = ABI_SYSCALLS.Sendmsg;
const SYS_RECVMSG = ABI_SYSCALLS.Recvmsg;
const SYS_ACCEPT = ABI_SYSCALLS.Accept;
const SYS_ACCEPT4 = ABI_SYSCALLS.Accept4;
const SYS_CONNECT = ABI_SYSCALLS.Connect;

const MSG_DONTWAIT = 0x0040;

/** mmap flags */
const MAP_SHARED = 0x01;
const MAP_ANONYMOUS = 0x20;

/** Syscall numbers for scatter/gather I/O */
const SYS_WRITEV = ABI_SYSCALLS.Writev;
const SYS_READV = ABI_SYSCALLS.Readv;
const SYS_PREADV = ABI_SYSCALLS.Preadv;
const SYS_PWRITEV = ABI_SYSCALLS.Pwritev;

/** fcntl commands that take a struct flock pointer */
const SYS_FCNTL = ABI_SYSCALLS.Fcntl;

/** SysV IPC syscall numbers (only those still intercepted on host) */
const SYS_SEMCTL = ABI_SYSCALLS.Semctl;
const SYS_SHMAT = ABI_SYSCALLS.Shmat;
const SYS_SHMDT = ABI_SYSCALLS.Shmdt;

/** POSIX message queue syscall numbers */
const SYS_MQ_TIMEDSEND = ABI_SYSCALLS.MqTimedsend;
const SYS_MQ_TIMEDRECEIVE = ABI_SYSCALLS.MqTimedreceive;

const SYS_CLOSE = ABI_SYSCALLS.Close;

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
const READ_LIKE_SYSCALLS = new Set<number>([
  ABI_SYSCALLS.Read,
  ABI_SYSCALLS.Recv,
  ABI_SYSCALLS.Recvfrom,
  ABI_SYSCALLS.Pread,
  ABI_SYSCALLS.Readv,
  ABI_SYSCALLS.Recvmsg,
]);
/** Write-like syscalls that may produce pipe/socket data */
const WRITE_LIKE_SYSCALLS = new Set<number>([
  ABI_SYSCALLS.Write,
  ABI_SYSCALLS.Send,
  ABI_SYSCALLS.Sendto,
  ABI_SYSCALLS.Pwrite,
  ABI_SYSCALLS.Writev,
  ABI_SYSCALLS.Sendmsg,
  ABI_SYSCALLS.Sendfile,
]);

function syscallHasMsgDontwait(syscallNr: number, args: number[]): boolean {
  let flags: number | undefined;
  switch (syscallNr) {
    case SYS_SEND:
    case SYS_RECV:
    case SYS_SENDTO:
    case SYS_RECVFROM:
      flags = args[3];
      break;
    case SYS_SENDMSG:
    case SYS_RECVMSG:
      flags = args[2];
      break;
    default:
      return false;
  }
  return flags !== undefined && (flags & MSG_DONTWAIT) !== 0;
}
// Signal delivery area — last 48 bytes of data buffer.
// Written by kernel_dequeue_signal, read by glue channel_syscall.c.
const CH_SIG_SI_VALUE = CH_SIG_BASE + 12;  // i32: si_value.sival_int
const CH_SIG_SI_CODE = CH_SIG_BASE + 24;   // i32: si_code
const CH_SIG_SI_PID = CH_SIG_BASE + 28;    // u32: si_pid
const CH_SIG_SI_UID = CH_SIG_BASE + 32;    // u32: si_uid
const CH_SIG_ALT_SP = CH_SIG_BASE + 36;   // u32: alt stack sp (0 = no switch)
const CH_SIG_ALT_SIZE = CH_SIG_BASE + 40;  // u32: alt stack size

/** Scratch area layout in kernel Memory for kernel_handle_channel.
 * Same as channel layout but used as the kernel-side buffer. */
const SCRATCH_SIZE = CH_TOTAL_SIZE;

/**
 * One captured syscall, surfaced by the opt-in trace ring buffer
 * (enableSyscallTrace + drainSyscallTrace). Used by Kandelo Inspector →
 * Syscalls and any tooling that wants a live `strace`-equivalent.
 */
export interface SyscallTraceEvent {
  /** Monotonic time in milliseconds since the kernel-worker booted. */
  t: number;
  pid: number;
  /** Linux syscall number from `shared::Syscall`. */
  nr: number;
  /** Raw arg values as the wasm program saw them. 6 entries, undefined slots are 0. */
  args: [number, number, number, number, number, number];
  /** Human-readable syscall entry, including decoded pointer arguments when available. */
  decoded?: string;
}

/**
 * A snapshot of one process from the kernel's table. Mirrors the binary
 * record kernel_enum_procs writes — see crates/kernel/src/wasm_api.rs
 * (kernel_enum_procs) for the authoritative wire format.
 */
export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  /** Effective user/group IDs for ps-style USER display. */
  uid: number;
  gid: number;
  /** Sum of mmap-region sizes for this process, in bytes. */
  vsizeBytes: number;
  /** Current WebAssembly.Memory buffer size for this process, in bytes. */
  memoryBytes?: number;
  /** 'R' (running) | 'Z' (zombie); future: 'S','D','T','I'. */
  state: "R" | "Z" | "S" | "D" | "T" | "I";
  /** Basename of argv[0], or "[kernel]" for an empty argv. */
  comm: string;
  /** Space-separated argv (we decode the kernel's null-separated bytes). */
  cmdline: string;
}

function parseProcSnapshots(mem: Uint8Array): ProcessSnapshot[] {
  if (mem.byteLength < 4) return [];
  const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
  const count = dv.getUint32(0, true);
  let off = 4;
  const out: ProcessSnapshot[] = [];
  const dec = new TextDecoder("utf-8", { fatal: false });
  for (let i = 0; i < count; i++) {
    if (off + 36 > mem.byteLength) break;
    const pid = dv.getUint32(off, true); off += 4;
    const ppid = dv.getUint32(off, true); off += 4;
    const uid = dv.getUint32(off, true); off += 4;
    const gid = dv.getUint32(off, true); off += 4;
    const vsizeBytes = Number(dv.getBigUint64(off, true)); off += 8;
    const state = String.fromCharCode(dv.getUint32(off, true)) as ProcessSnapshot["state"]; off += 4;
    const commLen = dv.getUint32(off, true); off += 4;
    const cmdLen = dv.getUint32(off, true); off += 4;
    if (off + commLen + cmdLen > mem.byteLength) break;
    const comm = dec.decode(mem.subarray(off, off + commLen));
    off += commLen;
    const cmdRaw = mem.subarray(off, off + cmdLen);
    off += cmdLen;
    // /proc/<pid>/cmdline is null-separated; convert to space-separated.
    const cmdline = dec.decode(cmdRaw).replace(/\0/g, " ").trimEnd();
    out.push({ pid, ppid, uid, gid, vsizeBytes, state, comm, cmdline: cmdline || `[${comm}]` });
  }
  return out;
}

/**
 * Decode just the argv and envp strings out of a SYS_SPAWN blob. The kernel
 * does the authoritative parsing (file actions, attrs); this minimal
 * decoder exists because `onSpawn` needs `string[]` for the worker-launch
 * path.
 *
 * Wire format mirrors `crates/kernel/src/spawn.rs::parse_blob` — see
 * `docs/plans/2026-05-04-non-forking-posix-spawn-design.md` Section 1.
 *
 * Throws on malformed input. Callers should treat the throw as EINVAL.
 */
function decodeSpawnBlobStrings(blob: Uint8Array): { argv: string[]; envp: string[] } {
  const HEADER_LEN = 40;
  const ACTION_RECORD_LEN = 28;
  if (blob.byteLength < HEADER_LEN) {
    throw new Error("blob too short for header");
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const argc      = view.getUint32(0, true);
  const envc      = view.getUint32(4, true);
  const nActions  = view.getUint32(8, true);

  // Cap counts to mirror the kernel parser's adversarial-input cap.
  if (argc > 4096 || envc > 4096 || nActions > 1024) {
    throw new Error("blob count exceeds limit");
  }

  const argvOffsetsAt = HEADER_LEN;
  const envpOffsetsAt = argvOffsetsAt + argc * 4;
  const actionsAt     = envpOffsetsAt + envc * 4;
  const stringsAt     = actionsAt + nActions * ACTION_RECORD_LEN;

  if (stringsAt > blob.byteLength) {
    throw new Error("blob truncated before strings region");
  }
  const stringsLen = blob.byteLength - stringsAt;
  const decoder = new TextDecoder();

  const decodeAt = (off: number): string => {
    if (off > stringsLen) throw new Error("string offset OOB");
    let end = off;
    while (end < stringsLen && blob[stringsAt + end] !== 0) end++;
    return decoder.decode(blob.slice(stringsAt + off, stringsAt + end));
  };

  const argv: string[] = [];
  for (let i = 0; i < argc; i++) {
    argv.push(decodeAt(view.getUint32(argvOffsetsAt + i * 4, true)));
  }
  const envp: string[] = [];
  for (let i = 0; i < envc; i++) {
    envp.push(decodeAt(view.getUint32(envpOffsetsAt + i * 4, true)));
  }
  return { argv, envp };
}

/** Syscall number → name mapping for logging */
export const SYSCALL_NAMES: Record<number, string> = ABI_SYSCALL_NAMES;

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
  /**
   * True when the host registered a compact/dynamic process layout with an
   * explicit address-space ceiling. Legacy high-address thread channels lower
   * max_addr as channels are added; dynamic pthread control slots must not.
   */
  explicitMaxAddr: boolean;
}

interface RegisterProcessOptions {
  skipKernelCreate?: boolean;
  argv?: string[];
  ptrWidth?: 4 | 8;
  /** Required for new kernel Process creation; ignored when skipKernelCreate is true. */
  stdio?: RegisterProcessStdio;
  /** Initial program break after any host-owned low control pages. */
  brkBase?: number;
  /** Lower bound for automatic mmap allocation. */
  mmapBase?: number;
  /** mmap ceiling in process address space; defaults to legacy channel cap. */
  maxAddr?: number;
  /** brk ceiling below host-owned control pages. */
  brkLimit?: number;
}

type RegisterProcessStdioKind = "pipe" | "terminal";

interface RegisterProcessStdio {
  stdin: RegisterProcessStdioKind;
  stdout: RegisterProcessStdioKind;
  stderr: RegisterProcessStdioKind;
}

export const CAPTURED_STDIO: RegisterProcessStdio = {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
};

export const TERMINAL_STDIO: RegisterProcessStdio = {
  stdin: "terminal",
  stdout: "terminal",
  stderr: "terminal",
};

function encodeStdioKind(kind: RegisterProcessStdioKind): number {
  switch (kind) {
    case "pipe": return 0;
    case "terminal": return 1;
  }
}

type WaitPollResult =
  | { kind: "exited"; childPid: number; waitStatus: number }
  | { kind: "running" }
  | { kind: "error"; errno: number };

/**
 * Context describing a fork() initiated from a non-main thread. Set on
 * `onFork`'s optional `threadFork` arg by `handleFork` when it detects
 * the syscall arrived on a channel registered via clone() (tid > 0).
 *
 * - `fnPtr` / `argPtr`: the pthread_create entry point + userdata that
 *   the kernel-worker stored when the thread was registered through
 *   `addChannel`. The child Worker uses these to enter the thread
 *   function directly (skipping `_start`).
 * - `forkBufAddr`: the wpk_fork buffer address corresponding to the
 *   *thread's* channel — i.e. `thread_channelOffset - FORK_BUF_SIZE`.
 *   In the child's memory copy this offset holds the saved frames and globals
 *   the parent thread wrote during its wpk_fork unwind.
 * - `slotStart`/`slotLen`: the dynamic pthread control reservation that
 *   contains the caller's TLS, fork-save buffer, and channel. Fork children
 *   retain this one slot and discard all other parent pthread reservations.
 */
export interface ForkFromThreadContext {
  fnPtr: number;
  argPtr: number;
  forkBufAddr: number;
  slotStart: number;
  slotLen: number;
}

export interface ResolvedSpawnProgram {
  programBytes: ArrayBuffer;
  argv: string[];
}

export interface SpawnResolveError {
  errno: number;
}

export type SpawnProgramResolution = ArrayBuffer | ResolvedSpawnProgram | SpawnResolveError;

function isSpawnResolveError(
  resolution: SpawnProgramResolution,
): resolution is SpawnResolveError {
  return !(resolution instanceof ArrayBuffer) &&
    "errno" in resolution &&
    typeof resolution.errno === "number";
}

/** Callbacks for fork/exec/exit handling. */
export interface CentralizedKernelCallbacks {
  /**
   * Called when a process forks. The kernel has already cloned the Process
   * in its ProcessTable. The callback should spawn a child Worker with
   * a copy of the parent's Memory and register it with the kernel.
   * Returns the channel offsets allocated for the child.
   *
   * `threadFork` is set when the parent issued the fork() syscall from a
   * thread spawned via pthread_create (i.e. on a channel registered
   * through `addChannel(pid, offset, tid, fnPtr, argPtr)` with tid > 0).
   * The host must:
   *   - use the thread's `forkBufAddr` (not the main channel's) for the
   *     child's rewind so the saved frames + saved __tls_base /
   *     __stack_pointer match what the parent thread populated, and
   *   - have the child Worker enter the thread function (`fnPtr`/`argPtr`)
   *     directly instead of `_start` — _start is not in the thread's
   *     fork-path call chain and rewinding through it would never reach
   *     the saved fork() call site.
   *
   * If `threadFork` is omitted the callback handles the fork as a
   * fork-from-main-thread (the existing path).
   */
  onFork?: (
    parentPid: number,
    childPid: number,
    parentMemory: WebAssembly.Memory,
    threadFork?: ForkFromThreadContext,
  ) => Promise<number[]>;

  /**
   * Called when a process calls execve. The callback should resolve the
   * program path, terminate the old Worker, create a new Worker with the
   * new binary, and call registerProcess with skipKernelCreate.
   * Returns 0 on success, negative errno on error.
   */
  onExec?: (pid: number, path: string, argv: string[], envp: string[]) => Promise<number>;

  /**
   * Pre-flight resolution step for SYS_SPAWN. Returns the program bytes
   * for `path` (or `{ programBytes, argv }` when resolution rewrites argv,
   * e.g. a shebang script), `{ errno }` for a located but unlaunchable
   * program, or `null` for ENOENT. **Must NOT have side effects** —
   * `handleSpawn` calls this BEFORE `kernel_spawn_process` so that file
   * actions never run on a doomed PATH-iteration. POSIX requires
   * file_actions to run "exactly once," and `posix_spawnp`'s PATH-walk
   * issues one `posix_spawn` per candidate; without this preflight the
   * kernel applies file_actions on every failed iteration (sortix
   * `basic/spawn/posix_spawnp` exercises an `addopen(O_EXCL)` "once"
   * file that would conflict on iteration 2).
   *
   * Required if `onSpawn` is set; together they form the spawn surface.
   */
  onResolveSpawn?: (path: string, argv: string[]) => Promise<SpawnProgramResolution | null>;

  /**
   * Launch a worker for the spawned child with already-resolved bytes
   * and argv (from `onResolveSpawn`). The kernel has constructed the child Process
   * descriptor under `childPid` and applied file actions + attrs by the
   * time this is called. The callback instantiates a fresh Worker and
   * registers it via `registerProcess({ skipKernelCreate: true })`.
   *
   * Returns 0 on success, negative errno on failure. On non-zero return
   * the kernel descriptor is rolled back via `kernel_remove_process`.
   *
   * Distinct from `onExec` (which replaces the calling worker) and
   * `onFork` (which clones the parent's Memory): `onSpawn` always
   * creates a fresh Memory and runs the new program from `_start`.
   */
  onSpawn?: (childPid: number, programBytes: ArrayBuffer, argv: string[], envp: string[]) => Promise<number>;

  /**
   * Called when a process calls clone (thread creation). The callback should
   * spawn a thread Worker sharing the parent's Memory. Returns the TID.
   */
  onClone?: (pid: number, tid: number, fnPtr: number, argPtr: number, stackPtr: number, tlsPtr: number, ctidPtr: number, memory: WebAssembly.Memory) => Promise<number>;

  /**
   * Called after a pthread channel reaches SYS_EXIT and the kernel worker has
   * performed the musl clear-TID wake used by pthread joiners. Return true when
   * the host will terminate the backing Worker, so the syscall channel should
   * not be completed back into guest code.
   */
  onThreadExit?: (pid: number, tid: number, channelOffset: number) => boolean;

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
  /**
   * Maps a pthread syscall mailbox to its kernel/libc thread id.
   *
   * Each pthread gets a distinct `channelOffset` range inside the process
   * WebAssembly.Memory/SharedArrayBuffer. That offset identifies the host-side
   * transport mailbox; it is enough for the host to find the pending syscall,
   * but it is not the POSIX thread identity the Rust kernel exposes to musl.
   * Before entering `kernel_handle_channel`, the host uses this map to bind the
   * selected mailbox to the current TID so gettid, set_tid_address, per-thread
   * signal masks, directed signals, and thread cleanup apply to the right
   * pthread.
   */
  private channelTids = new Map<string, number>();
  /**
   * Per-thread-channel fork context: the pthread_create entry point and
   * userdata that were stored when the channel was registered through
   * `addChannel`. `handleFork` reads this when it detects a fork()
   * arriving on a thread channel so it can route the child's rewind
   * back through the thread function instead of `_start`. Keyed by
   * `pid:channelOffset` like `channelTids`; entries are cleared by
   * `removeChannel` and the thread-exit path.
   */
  private threadForkContexts = new Map<string, { fnPtr: number; argPtr: number }>();
  /** Tracks the pid currently being serviced by kernel_handle_channel */
  private currentHandlePid = 0;
  /**
   * Bind the kernel's view of "which thread is executing this syscall" to the
   * already-selected channel. The channel offset is the transport identity; TID
   * is the guest-visible pthread identity used by the kernel/libc ABI.
   *
   * This ambient current-TID value is correct while this host serializes calls
   * into one kernel instance. If kernel dispatch ever becomes concurrent or
   * reentrant for the same instance, this must move into the syscall header or
   * become an explicit `kernel_handle_channel` argument.
   *
   * `tid = 0` means "main thread" and is the default for channels without a
   * tracked TID, such as the main process worker.
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
  /** UDP virtual-network endpoint bindings: "pid:sockIdx" */
  private udpBindings = new Set<string>();
  /** Separate scratch buffer for TCP data pumping */
  private tcpScratchOffset = 0;
  /** Node.js net module (loaded dynamically for browser compatibility) */
  private netModule: typeof import("net") | null = null;
  /** Deferred waitpid/waitid completions. Child matching/reap state is Rust-owned. */
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
    acceptIndices?: number[];
    /** True if this retry was entered via ppoll with an atomic sigmask swap.
     *  Broad wakes triggered by cross-process pipe events must be deferred
     *  a few ms for these retries so follow-up cross-process signals have
     *  time to land before ppoll observes "pipe ready, no signal" and
     *  restores its mask. See scheduleWakeBlockedRetriesDeferred and
     *  tests/sortix/os-test/signal/ppoll-block-sleep-write-raise. */
    needsSignalSafeWake?: boolean;
    /** Date.now() deadline for finite-timeout poll/ppoll retries, or -1. */
    deadline?: number;
  }>();
  /** Pending pselect6/select retries — keyed by channelOffset for per-thread tracking */
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
  private virtualMacAddress: Uint8Array<ArrayBuffer>;

  /** KMS presenter: OffscreenCanvas per CRTC for the vblank pump to blit
   *  the bound framebuffer into. Populated via `attachKmsCanvas`. */
  private kmsCanvases = new Map<number, OffscreenCanvas>();
  private kmsContexts = new Map<number, OffscreenCanvasRenderingContext2D>();
  /** Which context type each CRTC's canvas has been claimed for. Set
   *  by `attachKmsCanvas` when the embedder declares the mode up-front
   *  (`"2d"` for legacy CPU-blit demos, `"webgl2"` for libdrm/libgbm/EGL
   *  apps like modeset.c). Auto-mode leaves this unset so the pump
   *  never touches the canvas — `host_gl_create_context` later flips
   *  it to `"webgl2"` via `markKmsCanvasGlOwned` once the GL session
   *  claims the canvas. Once set, the value is sticky: an OffscreenCanvas
   *  can only ever hold one context type for its lifetime. */
  private kmsContextMode = new Map<number, "2d" | "webgl2">();
  /** KMS stats SAB per CRTC. Slots [0..4] populated by the pump (frame
   *  count, timestamp, width, height, blit µs); slots [5,6] populated
   *  from kernel-side `kernel_kms_commit_count` / `kernel_kms_last_frame_us`. */
  private kmsStatsViews = new Map<number, Int32Array>();
  /** Cached per-CRTC `Uint8ClampedArray` for `putImageData` so the pump
   *  doesn't allocate 8 MB/frame at 1080p. Resized on bo geometry change.
   *  Backed by a plain `ArrayBuffer` so `new ImageData(scratch, …)`
   *  accepts it (an `ImageDataArray` rejects SAB-backed views). */
  private kmsScratchBytes = new Map<number, Uint8ClampedArray<ArrayBuffer>>();
  private vblankTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: KernelConfig,
    private io: PlatformIO,
    private callbacks: CentralizedKernelCallbacks = {},
  ) {
    this.kernel = new WasmPosixKernel(config, io, {
      // Process-lifecycle callbacks are handled by the kernel worker: the
      // kernel returns EAGAIN and JS performs the host-side action.
      getProcessMemory: (pid: number): WebAssembly.Memory | undefined => {
        return this.processes.get(pid)?.memory;
      },
      // KMS scanout canvas lookup for the GL bridge's auto-attach
      // path. `host_gl_create_context` calls this when a DRM-master
      // pid has no canvas bound yet; the kernel-worker's KMS registry
      // is the single source of truth for `crtc_id → OffscreenCanvas`.
      getKmsCanvas: (crtcId: number) => this.kmsCanvases.get(crtcId),
      markKmsCanvasGlOwned: (crtcId: number) => {
        this.kmsContextMode.set(crtcId, "webgl2");
      },
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
        this.startTcpListener(pid, fd, port, addr);
        return 0;
      },
      onUdpBind: (handle: number, addr: [number, number, number, number], port: number): number => {
        const pid = this.currentHandlePid;
        if (pid === 0 || !this.io.network?.bindUdp) return 0;
        const key = `${pid}:${handle}`;
        const result = this.io.network.bindUdp(
          key,
          new Uint8Array(addr),
          port,
          {
            receive: (datagram) => this.injectUdpDatagram(pid, datagram),
          },
        );
        if (result === 0) this.udpBindings.add(key);
        return result === 0 ? 0 : -result;
      },
      onUdpUnbind: (handle: number): number => {
        const pid = this.currentHandlePid;
        if (pid === 0 || !this.io.network?.unbindUdp) return 0;
        const key = `${pid}:${handle}`;
        this.io.network.unbindUdp(key);
        this.udpBindings.delete(key);
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
   * Initialize the kernel.
   * Loads kernel Wasm and validates the host adapter ABI.
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
      this.kernelInstance.exports[ABI_KERNEL_EXPORT] as
        | (() => number)
        | undefined;
    if (typeof abiVersionFn !== "function") {
      throw new Error(
        `kernel wasm is missing the ${ABI_KERNEL_EXPORT} export — refusing to run. ` +
          "Rebuild the kernel (bash build.sh) against the current ABI.",
      );
    }
    this.kernelAbiVersion = abiVersionFn();
    validateKernelHostAdapterManifest(this.kernelInstance, this.kernelMemory);

    // Allocate scratch area from the kernel's own heap allocator.
    // IMPORTANT: Do NOT use this.kernelMemory.grow() — the kernel's
    // allocator (dlmalloc) doesn't know about host-grown pages and will
    // reuse them as heap, causing corruption (overlapping writes between
    // scratch data and kernel heap structures like Vec<MappedRegion>).
    const allocScratch = this.kernelInstance.exports.kernel_alloc_scratch as
      (size: number) => KernelPointer;
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
    // (including OFD locks) within the kernel.
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
    options?: RegisterProcessOptions,
  ): void {
    if (!this.initialized) throw new Error("Kernel not initialized");

    // A fresh registration starts a new "generation" for this pid — even
    // if the same numeric pid was previously reaped (it can't be today
    // since nextChildPid is monotonic, but defensive), the new process
    // hasn't been reaped yet.
    this.hostReaped.delete(pid);

    // Create process in kernel's process table (skip if already created, e.g. by fork)
    if (!options?.skipKernelCreate) {
      const stdio = options?.stdio;
      if (!stdio) {
        throw new Error("registerProcess requires explicit stdio when creating a kernel process");
      }
      const createProcess = this.kernelInstance!.exports.kernel_create_process_with_stdio as
        ((pid: number, stdinKind: number, stdoutKind: number, stderrKind: number) => number) | undefined;
      if (!createProcess) {
        throw new Error("Kernel missing kernel_create_process_with_stdio export");
      }
      const result = createProcess(
        pid,
        encodeStdioKind(stdio.stdin),
        encodeStdioKind(stdio.stdout),
        encodeStdioKind(stdio.stderr),
      );
      if (result < 0) {
        throw new Error(`Failed to create process ${pid}: errno ${-result}`);
      }
    }

    if (options?.brkBase !== undefined) {
      if (!this.setBrkBase(pid, options.brkBase)) {
        throw new Error(
          "Kernel export kernel_set_brk_base is required for compact process memory layout",
        );
      }
    }

    // Set process argv in kernel for /proc/<pid>/cmdline
    if (options?.argv && options.argv.length > 0) {
      const setArgv = this.kernelInstance!.exports.kernel_set_process_argv as
        ((pid: number, dataPtr: KernelPointer, dataLen: number) => number) | undefined;
      if (setArgv) {
        const encoder = new TextEncoder();
        const nullSep = options.argv.join("\0");
        const encoded = encoder.encode(nullSep);
        // Write to kernel scratch area
        const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
        const scratchOffset = this.scratchOffset!;
        kernelMem.set(encoded, scratchOffset);
        setArgv(pid, this.toKernelPtr(scratchOffset), encoded.length);
      }
    }

    // Cap mmap address space. New hosts pass the process memory maximum here
    // because syscall channels live below PROCESS_MMAP_BASE in a reserved
    // control arena. Legacy callers without maxAddr still cap at the lowest
    // channel offset, preserving the old high-channel layout behavior.
    const setMaxAddr = this.kernelInstance!.exports.kernel_set_max_addr as
      ((pid: number, maxAddr: KernelPointer) => number) | undefined;
    if (setMaxAddr) {
      const maxAddr = options?.maxAddr ?? (
        channelOffsets.length > 0 ? Math.min(...channelOffsets) : undefined
      );
      if (maxAddr !== undefined) {
        setMaxAddr(pid, this.toKernelPtr(maxAddr));
      }
    }

    if (options?.mmapBase !== undefined) {
      if (!this.setMmapBase(pid, options.mmapBase)) {
        throw new Error(
          "Kernel export kernel_set_mmap_base is required for compact process memory layout",
        );
      }
    }

    if (options?.brkLimit !== undefined) {
      if (!this.setBrkLimit(pid, options.brkLimit)) {
        throw new Error(
          "Kernel export kernel_set_brk_limit is required for legacy low-control layout",
        );
      }
    }

    const channels: ChannelInfo[] = channelOffsets.map((offset) => ({
      pid,
      memory,
      channelOffset: offset,
      i32View: new Int32Array(memory.buffer, offset),
      consecutiveSyscalls: 0,
    }));

    const registration: ProcessRegistration = {
      pid,
      memory,
      channels,
      ptrWidth: options?.ptrWidth ?? 4,
      explicitMaxAddr: options?.maxAddr !== undefined,
    };
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
      ((ptyIdx: number, bufPtr: KernelPointer, bufLen: number) => number) | undefined;
    if (!kernelPtyMasterWrite) return;
    const buf = new Uint8Array(this.kernelMemory!.buffer);
    buf.set(data, this.scratchOffset);
    kernelPtyMasterWrite(ptyIdx, this.toKernelPtr(this.scratchOffset), data.length);
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
      ((ptyIdx: number, bufPtr: KernelPointer, bufLen: number) => number) | undefined;
    if (!kernelPtyMasterRead) return null;
    const SCRATCH_READ_SIZE = 4096;
    const n = kernelPtyMasterRead(ptyIdx, this.toKernelPtr(this.scratchOffset), SCRATCH_READ_SIZE);
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
    this.scheduleWakeBlockedRetries();

    // A process parked in a host-side setTimeout-backed nanosleep won't notice
    // the SIGWINCH the kernel just raised — the timer just runs to completion.
    // Speculatively dequeue a Handler signal for each blocked pid; if one was
    // pending we complete the sleep with EINTR so the glue can dispatch it.
    // Skipped pids (no signal queued) keep their original sleep deadline.
    const EINTR = 4;
    for (const [pid, entry] of Array.from(this.pendingSleeps.entries())) {
      if (!this.processes.has(pid)) continue;
      this.dequeueSignalForDelivery(entry.channel);
      const view = new DataView(entry.channel.memory.buffer, entry.channel.channelOffset);
      if (view.getUint32(CH_SIG_SIGNUM, true) > 0) {
        clearTimeout(entry.timer);
        this.pendingSleeps.delete(pid);
        this.completeChannel(
          entry.channel, entry.syscallNr, entry.origArgs,
          SYSCALL_ARGS[entry.syscallNr], -1, EINTR,
        );
      }
    }
  }

  /**
   * Register a callback for PTY output data.
   */
  onPtyOutput(ptyIdx: number, callback: (data: Uint8Array) => void): void {
    this.ptyOutputCallbacks.set(ptyIdx, callback);
    this.drainPtyOutput(ptyIdx);
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
      ((pid: number, ptr: KernelPointer, len: number) => number) | undefined;
    if (!kernelSetCwd) return; // older kernel without this export
    const encoded = new TextEncoder().encode(cwd);
    // Use the pre-allocated scratch area in kernel memory
    const buf = new Uint8Array(this.kernelMemory!.buffer);
    buf.set(encoded, this.scratchOffset);
    kernelSetCwd(pid, this.toKernelPtr(this.scratchOffset), encoded.length);
  }

  /**
   * Set a freshly-created process's initial real/effective uid and gid.
   * Must be called after registerProcess and before the process starts.
   */
  setCredentials(pid: number, ids: { uid?: number; gid?: number }): void {
    if (!this.initialized) throw new Error("Kernel not initialized");
    if (ids.uid == null && ids.gid == null) return;

    const unchanged = 0xffffffff;
    const direct = this.kernelInstance!.exports.kernel_set_process_credentials as
      ((pid: number, uid: number, gid: number) => number) | undefined;
    if (direct) {
      const result = direct(
        pid,
        ids.uid ?? unchanged,
        ids.gid ?? unchanged,
      );
      if (result < 0) {
        throw new Error(`setCredentials failed for pid ${pid}: errno ${-result}`);
      }
      return;
    }

    // Compatibility with kernel.wasm builds from before the direct
    // per-pid export existed: select the new process, then use the normal
    // syscall exports while it is still root. gid must be applied first,
    // because setting uid to a non-root value drops privilege.
    const setCurrentPid = this.kernelInstance!.exports.kernel_set_current_pid as
      ((pid: number) => void) | undefined;
    const setgid = this.kernelInstance!.exports.kernel_setgid as
      ((gid: number) => number) | undefined;
    const setuid = this.kernelInstance!.exports.kernel_setuid as
      ((uid: number) => number) | undefined;
    if (!setCurrentPid || !setgid || !setuid) return;

    try {
      setCurrentPid(pid);
      if (ids.gid != null) {
        const result = setgid(ids.gid);
        if (result < 0) throw new Error(`setgid failed for pid ${pid}: errno ${-result}`);
      }
      if (ids.uid != null) {
        const result = setuid(ids.uid);
        if (result < 0) throw new Error(`setuid failed for pid ${pid}: errno ${-result}`);
      }
    } finally {
      setCurrentPid(0);
    }
  }

  /**
   * Snapshot the kernel's process table. Returns one ProcessSnapshot per
   * live process. Used by Inspector → Procs (Kandelo UI) and any host that
   * wants a `ps`-equivalent without spawning a user-mode reader.
   *
   * Reads from the kernel's scratch buffer. If the buffer overflows on a
   * very large process table, returns an empty array — host can wrap with
   * a retry on a larger scratch alloc.
   *
   * Returns an empty array if the kernel hasn't initialized yet or doesn't
   * expose the export (older kernels).
   */
  // ── Syscall trace (opt-in live ring buffer) ────────────────────────────
  //
  // Off by default — zero cost when no subscriber. enableSyscallTrace()
  // flips a flag; _handleSyscallInner pushes to this.syscallTraceRing
  // when it's on. drainSyscallTrace() returns + clears the buffer; main
  // thread polls every ~250ms via a worker→main request/response cycle.

  private syscallTraceEnabled = false;
  private syscallTraceRing: SyscallTraceEvent[] = [];
  /** Cap the ring so a forgotten subscriber can't blow memory. */
  private syscallTraceCap = 4096;

  enableSyscallTrace(): void {
    this.syscallTraceEnabled = true;
  }

  disableSyscallTrace(): void {
    this.syscallTraceEnabled = false;
    this.syscallTraceRing.length = 0;
  }

  drainSyscallTrace(): SyscallTraceEvent[] {
    if (this.syscallTraceRing.length === 0) return [];
    const out = this.syscallTraceRing;
    this.syscallTraceRing = [];
    return out;
  }

  enumProcs(): ProcessSnapshot[] {
    if (!this.initialized) return [];
    const enumProcs = this.kernelInstance!.exports.kernel_enum_procs as
      ((ptr: KernelPointer, len: number) => number) | undefined;
    if (!enumProcs) return [];
    const n = enumProcs(this.toKernelPtr(this.scratchOffset), SCRATCH_SIZE);
    if (n <= 0) return [];
    // The kernel memory is a SharedArrayBuffer; TextDecoder refuses
    // shared views. Copy to a regular ArrayBuffer before parsing.
    const shared = new Uint8Array(this.kernelMemory!.buffer, this.scratchOffset, n);
    const owned = new Uint8Array(n);
    owned.set(shared);
    const snapshots = parseProcSnapshots(owned);
    for (const snapshot of snapshots) {
      const registration = this.processes.get(snapshot.pid);
      if (registration) {
        snapshot.memoryBytes = registration.memory.buffer.byteLength;
      }
    }
    return snapshots;
  }

  /**
   * Read `/proc/[pid]/maps` for a foreign process. Returns the raw Linux-
   * style text (one line per mapped region) or `null` if the pid doesn't
   * exist. Empty string if the process has no mappings.
   */
  readProcMaps(pid: number): string | null {
    if (!this.initialized) return null;
    const readMaps = this.kernelInstance!.exports.kernel_read_proc_maps as
      ((pid: number, ptr: KernelPointer, len: number) => number) | undefined;
    if (!readMaps) return null;
    const n = readMaps(pid, this.toKernelPtr(this.scratchOffset), SCRATCH_SIZE);
    if (n < 0) return null;          // -ESRCH or similar
    if (n === 0) return "";
    // SharedArrayBuffer view → TextDecoder doesn't accept shared views.
    // Copy out before decoding.
    const shared = new Uint8Array(this.kernelMemory!.buffer, this.scratchOffset, n);
    const owned = new Uint8Array(n);
    owned.set(shared);
    return new TextDecoder("utf-8", { fatal: false }).decode(owned);
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

    // Clean up network listeners/endpoints for this process
    this.cleanupUdpBindings(pid);
    this.cleanupTcpListeners(pid);

    // Clean up pending poll retries
    this.cleanupPendingPollRetries(pid);
    // Clean up pending select retries
    this.cleanupPendingSelectRetries(pid);
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

    this.releaseAdvisoryLocksForPid(pid);

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
  /**
   * Remove a pid from the wasm kernel's ProcessTable entirely. Used by
   * the worker-entry's crash path: when a worker dies via a wasm trap
   * (signature mismatch, OOM, etc.) the kernel never saw a SYS_EXIT, so
   * its ProcessTable still has the pid in state=Running. After this
   * runs, kernel_enum_procs no longer reports it and a parent's
   * waitpid() returns ECHILD — accurate for "the process really is gone."
   *
   * Don't call this for normal exits — the kernel marks those Exited
   * (zombie) so the parent can still reap.
   */
  removeProcessFromKernelTable(pid: number): void {
    if (!this.initialized) return;
    const removeProcess = this.kernelInstance?.exports.kernel_remove_process as
      ((pid: number) => number) | undefined;
    if (!removeProcess) return;
    removeProcess(pid);
  }

  private releaseAdvisoryLocksForPid(pid: number): void {
    if (!this.lockTable) return;

    // Force-reset the spinlock first: a terminated worker may have been
    // holding it, and Atomics.wait is not allowed on the browser main thread.
    const lockBuf = this.lockTable.getBuffer();
    Atomics.store(new Int32Array(lockBuf), 0, 0);
    this.lockTable.removeLocksByPid(pid);
  }

  deactivateProcess(pid: number): void {
    this.activeChannels = this.activeChannels.filter((ch) => ch.pid !== pid);
    this.processes.delete(pid);
    this.stdinFinite.delete(pid);
    this.stdinBuffers.delete(pid);
    this.releaseAdvisoryLocksForPid(pid);
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
    this.cleanupPendingSelectRetries(pid);
    // Clean up network listeners/endpoints for this process
    this.cleanupUdpBindings(pid);
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
    this.cleanupPendingSelectRetries(pid);
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
   * so handleExit can identify thread exits. `threadFnPtr` / `threadArgPtr`
   * are stored when the thread was created via clone() so `handleFork` can
   * route a fork() from this thread back through its entry point.
   */
  addChannel(
    pid: number,
    channelOffset: number,
    tid?: number,
    threadFnPtr?: number,
    threadArgPtr?: number,
  ): void {
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
    if (threadFnPtr !== undefined && threadArgPtr !== undefined) {
      this.threadForkContexts.set(`${pid}:${channelOffset}`, {
        fnPtr: threadFnPtr,
        argPtr: threadArgPtr,
      });
    }

    // Lower the kernel's mmap ceiling only for legacy high-address thread
    // control pages. Compact process memories reserve thread pages before the
    // process's mmap base when the process is registered.
    const setMaxAddr = this.kernelInstance!.exports.kernel_set_max_addr as
      ((pid: number, maxAddr: KernelPointer) => number) | undefined;
    if (setMaxAddr && !registration.explicitMaxAddr) {
      const tlsPageAddr = channelOffset - 2 * WASM_PAGE_SIZE;
      if (tlsPageAddr >= PROCESS_MMAP_BASE) {
        setMaxAddr(pid, this.toKernelPtr(tlsPageAddr));
      }
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
    this.threadForkContexts.delete(`${pid}:${channelOffset}`);
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

  toKernelPtr(value: number | bigint): KernelPointer {
    return this.kernel.toKernelPtr(value);
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

  private readBytesPreview(memory: WebAssembly.Memory, ptr: number, len: number, maxLen = 160): string {
    if (ptr === 0 || len <= 0) return "";
    const mem = new Uint8Array(memory.buffer);
    const capped = Math.max(0, Math.min(len, maxLen, mem.length - ptr));
    if (capped <= 0) return "";
    const copy = new Uint8Array(capped);
    copy.set(mem.subarray(ptr, ptr + capped));
    return new TextDecoder("utf-8", { fatal: false }).decode(copy);
  }

  private formatPollFds(memory: WebAssembly.Memory, ptr: number, nfds: number): string {
    if (ptr === 0 || nfds <= 0) return "";
    const view = new DataView(memory.buffer);
    const entries: string[] = [];
    const capped = Math.min(nfds, 8);
    for (let i = 0; i < capped; i++) {
      const off = ptr + i * 8;
      if (off + 8 > view.byteLength) break;
      const fd = view.getInt32(off, true);
      const events = view.getInt16(off + 4, true);
      const revents = view.getInt16(off + 6, true);
      entries.push(`{fd:${fd},events:0x${(events & 0xffff).toString(16)},revents:0x${(revents & 0xffff).toString(16)}}`);
    }
    if (nfds > capped) entries.push("...");
    return entries.join(",");
  }

  /** Format a syscall for logging, decoding path/string args from process memory */
  private formatSyscallEntry(channel: ChannelInfo, syscallNr: number, args: number[]): string {
    const name = SYSCALL_NAMES[syscallNr] ?? `syscall_${syscallNr}`;
    const pid = channel.pid;
    const tid = this.channelTids.get(`${pid}:${channel.channelOffset}`);
    const tidSuffix = tid !== undefined ? `:t${tid}` : ``;

    // Decode args based on syscall type
    switch (syscallNr) {
      case ABI_SYSCALLS.Open: // open(path, flags, mode)
        return `[${pid}${tidSuffix}] open("${this.readCString(channel.memory, args[0])}", 0x${(args[1] >>> 0).toString(16)}, 0o${(args[2] >>> 0).toString(8)})`;
      case ABI_SYSCALLS.Openat: // openat(dirfd, path, flags, mode)
        return `[${pid}${tidSuffix}] openat(${args[0]}, "${this.readCString(channel.memory, args[1])}", 0x${(args[2] >>> 0).toString(16)}, 0o${(args[3] >>> 0).toString(8)})`;
      case ABI_SYSCALLS.Stat: // stat(path, buf)
        return `[${pid}${tidSuffix}] stat("${this.readCString(channel.memory, args[0])}")`;
      case ABI_SYSCALLS.Lstat: // lstat(path, buf)
        return `[${pid}${tidSuffix}] lstat("${this.readCString(channel.memory, args[0])}")`;
      case ABI_SYSCALLS.Fstatat: // fstatat(dirfd, path, buf, flags)
        return `[${pid}${tidSuffix}] fstatat(${args[0]}, "${this.readCString(channel.memory, args[1])}", 0x${(args[3] >>> 0).toString(16)})`;
      case ABI_SYSCALLS.Access: // access(path, mode)
        return `[${pid}${tidSuffix}] access("${this.readCString(channel.memory, args[0])}", ${args[1]})`;
      case ABI_SYSCALLS.Faccessat: // faccessat(dirfd, path, mode, flags)
        return `[${pid}${tidSuffix}] faccessat(${args[0]}, "${this.readCString(channel.memory, args[1])}", ${args[2]})`;
      case ABI_SYSCALLS.Chdir: // chdir(path)
        return `[${pid}${tidSuffix}] chdir("${this.readCString(channel.memory, args[0])}")`;
      case ABI_SYSCALLS.Opendir: // opendir(path)
        return `[${pid}${tidSuffix}] opendir("${this.readCString(channel.memory, args[0])}")`;
      case ABI_SYSCALLS.Readlink: // readlink(path, buf, bufsiz)
        return `[${pid}${tidSuffix}] readlink("${this.readCString(channel.memory, args[0])}", ${args[2]})`;
      case ABI_SYSCALLS.Readlinkat: // readlinkat(dirfd, path, buf, bufsiz)
        return `[${pid}${tidSuffix}] readlinkat(${args[0]}, "${this.readCString(channel.memory, args[1])}", ${args[3]})`;
      case ABI_SYSCALLS.Realpath: // realpath(path, buf, bufsiz)
        return `[${pid}${tidSuffix}] realpath("${this.readCString(channel.memory, args[0])}")`;
      case ABI_SYSCALLS.Read: // read(fd, buf, count)
        return `[${pid}${tidSuffix}] read(${args[0]}, ${args[2]})`;
      case ABI_SYSCALLS.Write: // write(fd, buf, count)
        return `[${pid}${tidSuffix}] write(${args[0]}, ${args[2]}, ${JSON.stringify(this.readBytesPreview(channel.memory, args[1], args[2]))})`;
      case ABI_SYSCALLS.Close: // close(fd)
        return `[${pid}${tidSuffix}] close(${args[0]})`;
      case ABI_SYSCALLS.Fstat: // fstat(fd, buf)
        return `[${pid}${tidSuffix}] fstat(${args[0]})`;
      case ABI_SYSCALLS.Fcntl: // fcntl(fd, cmd, arg)
        return `[${pid}${tidSuffix}] fcntl(${args[0]}, ${args[1]}, ${args[2]})`;
      case ABI_SYSCALLS.Mmap: // mmap(addr, len, prot, flags, fd, offset)
        return `[${pid}${tidSuffix}] mmap(0x${(args[0] >>> 0).toString(16)}, ${args[1] >>> 0}, ${args[2]}, 0x${(args[3] >>> 0).toString(16)}, ${args[4]}, ${args[5] >>> 0})`;
      case ABI_SYSCALLS.Munmap: // munmap(addr, len)
        return `[${pid}${tidSuffix}] munmap(0x${(args[0] >>> 0).toString(16)}, ${args[1] >>> 0})`;
      case ABI_SYSCALLS.Brk: // brk(addr)
        return `[${pid}${tidSuffix}] brk(0x${(args[0] >>> 0).toString(16)})`;
      case HOST_INTERCEPTED_SYSCALLS.SYS_EXECVE: // execve(path, argv, envp)
        return `[${pid}${tidSuffix}] execve("${this.readCString(channel.memory, args[0])}")`;
      case HOST_INTERCEPTED_SYSCALLS.SYS_FORK: return `[${pid}${tidSuffix}] fork()`;
      case HOST_INTERCEPTED_SYSCALLS.SYS_VFORK: return `[${pid}${tidSuffix}] vfork()`;
      case ABI_SYSCALLS.Clone: // clone(flags, stack, ptid, tls, ctid)
        return `[${pid}${tidSuffix}] clone(0x${(args[0] >>> 0).toString(16)})`;
      case ABI_SYSCALLS.Exit: return `[${pid}${tidSuffix}] exit(${args[0]})`;
      case ABI_SYSCALLS.Poll: // poll(fds, nfds, timeout)
        return `[${pid}${tidSuffix}] poll(${args[1]}, ${args[2]}, [${this.formatPollFds(channel.memory, args[0], args[1])}])`;
      case ABI_SYSCALLS.Ioctl: // ioctl(fd, cmd, arg)
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
      case ABI_SYSCALLS.Mmap: // mmap
        return ` = 0x${(retVal >>> 0).toString(16)}`;
      case ABI_SYSCALLS.Brk: // brk
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
    const ringKey = channel.pid;
    let ring = this.syscallRing.get(ringKey);
    if (!ring) { ring = []; this.syscallRing.set(ringKey, ring); }
    ring.push(`  ${this.formatSyscallEntry(channel, syscallNr, origArgs)}`);
    if (ring.length > 30) ring.shift();

    // Opt-in live trace ring. enableSyscallTrace() flips the flag; the
    // host polls via drainSyscallTrace(). Zero cost when off.
    if (this.syscallTraceEnabled) {
      if (this.syscallTraceRing.length >= this.syscallTraceCap) {
        // Drop the oldest entry; a forgotten subscriber shouldn't blow memory.
        this.syscallTraceRing.shift();
      }
      this.syscallTraceRing.push({
        t: performance.now(),
        pid: channel.pid,
        nr: syscallNr,
        args: [
          origArgs[0] ?? 0, origArgs[1] ?? 0, origArgs[2] ?? 0,
          origArgs[3] ?? 0, origArgs[4] ?? 0, origArgs[5] ?? 0,
        ],
        decoded: this.formatSyscallEntry(channel, syscallNr, origArgs),
      });
    }

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

    if (syscallNr === SYS_SPAWN) {
      if (logging) console.error(logEntry);
      this.handleSpawn(channel, origArgs);
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
    // The kernel's host_futex_wake/wait imports use kernel memory, but futex
    // addresses are in process memory. Intercept here and handle directly.
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
    if ((syscallNr === SYS_READ || syscallNr === SYS_PREAD) && origArgs[2] > CH_DATA_SIZE) {
      this.handleLargeRead(channel, syscallNr, origArgs);
      return;
    }

    // --- sendmsg/recvmsg: decompose msghdr from process memory ---
    if (syscallNr === SYS_SENDMSG) {
      this.handleSendmsg(channel, origArgs);
      return;
    }
    if (syscallNr === SYS_RECVMSG) {
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
    // sys_select returns EAGAIN when it needs host-managed waiting, and the
    // generic blocking-retry has no select-timeout awareness — every
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
          size =
            origArgs[desc.size.argIndex] * (desc.size.multiplier ?? 1)
            + (desc.size.add ?? 0);
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
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: KernelPointer, pid: number) => number;
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
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
    // The kernel's ensure_memory_covers() grows the KERNEL's Wasm memory, not
    // the process's. We must grow the process's
    // WebAssembly.Memory here so the process can access the new addresses.
    if (retVal > 0) {
      this.ensureProcessMemoryCovers(channel.pid, channel.memory, syscallNr, retVal, origArgs);
    }

    // --- DEBUG: detect memory operations in legacy high control pages ---
    const highControlFloor = this.highControlFloorForProcess(channel.pid);
    if (syscallNr === SYS_MMAP && retVal > 0 && (retVal >>> 0) !== 0xffffffff) {
      const mmapAddr = retVal >>> 0;
      const mmapLen = origArgs[1] >>> 0;
      if (highControlFloor !== null && mmapAddr + mmapLen > highControlFloor) {
        console.error(`[MMAP ALERT] pid=${channel.pid} mmap returned 0x${mmapAddr.toString(16)} len=${mmapLen} — OVERLAPS THREAD REGION! args=[${origArgs.map(a => '0x' + (a >>> 0).toString(16)).join(',')}]`);
      }
    }
    if (syscallNr === SYS_MREMAP && retVal > 0 && (retVal >>> 0) !== 0xffffffff) {
      const mremapAddr = retVal >>> 0;
      const mremapLen = origArgs[2] >>> 0;
      if (highControlFloor !== null && mremapAddr + mremapLen > highControlFloor) {
        console.error(`[MREMAP ALERT] pid=${channel.pid} mremap returned 0x${mremapAddr.toString(16)} len=${mremapLen} — OVERLAPS THREAD REGION!`);
      }
    }
    if (highControlFloor !== null && syscallNr === SYS_BRK && retVal > highControlFloor) {
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
      // DRI bo mmap prime: the kernel's sys_mmap on /dev/dri/{render,card}
      // already called `host_gbm_bo_bind` to record metadata, but the
      // actual SAB→Memory copy is deferred until here so the
      // anonymous-mmap zero-fill is in place first. This is what
      // delivers the parent's writes to a child across PRIME
      // export → fork → PRIME import. No-op for non-DRI mmaps.
      const mmapAddr = retVal >>> 0;
      const boId = this.kernel.bos.findBindingByAddr(channel.pid, mmapAddr);
      if (boId !== undefined) {
        this.kernel.bos.primeBindFromSab(channel.pid, boId, channel.memory);
      }
    }

    // --- msync: flush MAP_SHARED regions back to file ---
    if (syscallNr === SYS_MSYNC && retVal === 0) {
      this.flushSharedMappings(channel, origArgs);
    }

    // --- munmap: flush + clean up shared mapping tracking ---
    if (syscallNr === SYS_MUNMAP && retVal === 0) {
      this.flushSharedMappings(channel, origArgs);
      this.cleanupSharedMappings(channel.pid, origArgs[0] >>> 0, origArgs[1] >>> 0);
    }

    // --- Signal-death check ---
    // If deliver_pending_signals marked this process as Exited (e.g., abort()
    // raises SIGABRT with default action Terminate), don't complete the channel.
    // Instead, record signal-death wait status and terminate the worker.
    const getExitStatus = this.kernelInstance!.exports
      .kernel_get_process_exit_status as ((pid: number) => number) | undefined;
    if (getExitStatus) {
      const exitStatus = getExitStatus(channel.pid);
      if (exitStatus >= 128) {
        this.handleProcessTerminated(channel);
        return;
      }
    }

    // --- POSIX mqueue notification ---
    // After mq_timedsend, the kernel may have a pending notification (signal
    // to deliver when a message arrives on a previously empty queue).
    if (syscallNr === SYS_MQ_TIMEDSEND && retVal === 0) {
      this.drainMqueueNotification();
    }

    // --- Signal delivery ---
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
    //       a `kill` of a sleeping child can leave the parent blocked even
    //       though Rust has marked the child as an Exited zombie.
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
      .kernel_dequeue_signal as ((pid: number, outPtr: KernelPointer) => number) | undefined;
    if (!dequeueSignal) return;

    // Use the signal area in kernel scratch as the output buffer
    const sigOutOffset = this.scratchOffset + CH_SIG_BASE;
    const sigResult = dequeueSignal(channel.pid, this.toKernelPtr(sigOutOffset));
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
    argDescs: SyscallArgDesc[] | undefined,
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
          size =
            origArgs[desc.size.argIndex] * (desc.size.multiplier ?? 1)
            + (desc.size.add ?? 0);
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
            const copyRetvalAdd = desc.copyRetvalAdd ?? 0;
            if (retVal > 0 && retVal + copyRetvalAdd < size) {
              copySize = retVal + copyRetvalAdd;
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
   * Host-teardown reclamation.
   *
   * [JSC-TERMINATE-ATOMICS-WAIT-LEAK] — WORKAROUND, remove when the engine bug
   * is fixed; see docs/jsc-terminate-atomics-wait-workaround.md.
   *
   * On JSC (Safari, and Bun via `bun`'s JavaScriptCore), `Worker.terminate()`
   * cannot kill (or free the memory of) a worker parked in `Atomics.wait` on
   * its syscall channel — which is where every idle/blocked process worker sits
   * (accept, read, poll, select, sleep, futex, the channel round-trip).
   * Terminating them directly leaks their threads + committed working set, so
   * each image switch accumulates a whole machine and the tab OOMs. V8 (Chrome,
   * Node) interrupts the wait on terminate and reclaims, so this is a no-op cost
   * there and is invoked unconditionally by both host entries for parity.
   *
   * For every worker currently parked at CH_PENDING we complete its syscall
   * with EINTR AND queue a SIGKILL into the channel signal slot. The glue's
   * `__deliver_pending_signal` (run right after the syscall returns) sees
   * SIGKILL and calls the `kernel_exit` import directly (NOT musl `_exit()`,
   * which would re-park the worker in the SYS_exit spin loop) → the `unreachable`
   * trap that worker-main catches → the worker posts `{exit}` and returns to its
   * JS event loop, where the host's `terminate()` (or the `{exit}` handler) can
   * finally reclaim it.
   *
   * SIGKILL is never delivered to the guest in normal operation (it is
   * uncatchable — the kernel enforces the default terminate action itself), so
   * the glue treats a queued SIGKILL unambiguously as "exit now".
   */
  killAllBlockedForTeardown(): Set<number> {
    // Drop all pending-retry bookkeeping first so nothing tries to re-arm a
    // syscall behind the teardown. The actual wake is driven off the channels'
    // CH_STATUS below, not off these maps — a worker parked on accept(),
    // epoll_pwait(), a socket read, or a futex may not appear in any of these
    // maps, but it is always sitting at CH_PENDING on its channel.
    for (const e of this.pendingPollRetries.values()) if (e.timer) clearTimeout(e.timer);
    for (const e of this.pendingSelectRetries.values()) if (e.timer) clearTimeout(e.timer);
    for (const e of this.pendingSleeps.values()) clearTimeout(e.timer);
    this.pendingPipeReaders.clear();
    this.pendingPipeWriters.clear();
    this.pendingPollRetries.clear();
    this.pendingSelectRetries.clear();
    this.pendingSleeps.clear();
    this.pendingFutexWaits.clear();

    // Wake every channel (process main threads + pthreads) that is parked in
    // Atomics.wait — i.e. status CH_PENDING — completing its syscall with
    // -EINTR and queueing SIGKILL so the guest glue runs its cooperative exit.
    // Returns the set of pids we actually woke so the caller can drain only for
    // those (a not-woken straggler never posts {exit} and must be terminated
    // directly, not waited on).
    const woken = new Set<number>();
    const getExitStatus = this.kernelInstance?.exports
      .kernel_get_process_exit_status as ((pid: number) => number) | undefined;
    for (const registration of this.processes.values()) {
      // Skip processes that have already exited (kernel state == Exited, i.e.
      // status != -1). A sibling thread may have called exit_group and set the
      // process's real exit status while this thread is still parked; forcing
      // our own kernel_exit on that parked thread would clobber that status
      // (e.g. a pthread exit(0) turning into 137). Only genuinely-live processes
      // need waking; already-exited stragglers are reaped/terminated normally.
      if (getExitStatus && getExitStatus(registration.pid) !== -1) continue;
      for (const channel of registration.channels) {
        let status: number;
        try {
          const i32 = new Int32Array(channel.memory.buffer, channel.channelOffset);
          status = Atomics.load(i32, CH_STATUS / 4);
        } catch { continue; }
        if (status !== CH_PENDING) continue;
        try {
          this.wakeChannelForTeardownExit(channel);
          woken.add(channel.pid);
        } catch (err) {
          console.error(`[killAllBlockedForTeardown] wake failed for pid=${channel.pid} off=${channel.channelOffset}: ${err}`);
        }
      }
    }
    return woken;
  }

  /** Complete a blocked channel with EINTR and queue SIGKILL so the guest glue
   *  runs its cooperative exit. See {@link killAllBlockedForTeardown}.
   *  [JSC-TERMINATE-ATOMICS-WAIT-LEAK] — see
   *  docs/jsc-terminate-atomics-wait-workaround.md. */
  private wakeChannelForTeardownExit(channel: ChannelInfo): void {
    const pv = new DataView(channel.memory.buffer, channel.channelOffset);
    // Queue SIGKILL for the glue's post-syscall __deliver_pending_signal. The
    // syscall handlers may have called dequeueSignalForDelivery, but SIGKILL
    // is never a queued Handler signal, so this slot is ours to set. Zero the
    // handler slot too: SIGKILL is uncatchable, so it must never dispatch a
    // userspace handler — the glue keys off signum==9 and exits before reading
    // the handler, but clearing it keeps this write self-consistent.
    pv.setUint32(CH_SIG_SIGNUM, SIGKILL, true);
    pv.setUint32(CH_SIG_HANDLER, 0, true);
    // Read the still-pending syscall request and complete it with -EINTR.
    const syscallNr = pv.getUint32(CH_SYSCALL, true);
    const origArgs: number[] = [];
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      origArgs.push(Number(pv.getBigInt64(CH_ARGS + i * CH_ARG_SIZE, true)));
    }
    this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], -1, EINTR_ERRNO);
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
  private resolvePollReadinessIndices(
    pid: number,
    origArgs: number[],
  ): { pipeIndices: number[]; acceptIndices: number[] } {
    // Prefer kernel_get_fd_pipe_idx which handles both pipes AND sockets.
    // Fall back to kernel_get_socket_recv_pipe for older kernels.
    const getFdPipeIdx = this.kernelInstance!.exports.kernel_get_fd_pipe_idx as
      ((pid: number, fd: number) => number) | undefined;
    const getRecvPipe = getFdPipeIdx ?? (this.kernelInstance!.exports.kernel_get_socket_recv_pipe as
      ((pid: number, fd: number) => number) | undefined);
    const getAcceptWakeIdx = this.kernelInstance!.exports.kernel_get_fd_accept_wake_idx as
      ((pid: number, fd: number) => number) | undefined;
    if (!getRecvPipe && !getAcceptWakeIdx) return { pipeIndices: [], acceptIndices: [] };

    const fdsPtr = origArgs[0];
    const nfds = origArgs[1];
    if (fdsPtr === 0 || nfds === 0) return { pipeIndices: [], acceptIndices: [] };

    // Find the channel for this pid to read process memory
    const channel = this.activeChannels.find(c => c.pid === pid);
    if (!channel) return { pipeIndices: [], acceptIndices: [] };

    const indices: number[] = [];
    const acceptIndices: number[] = [];
    const processMem = new DataView(channel.memory.buffer);
    const POLLIN = 0x001;
    // struct pollfd: fd(4) + events(2) + revents(2) = 8 bytes
    for (let i = 0; i < nfds; i++) {
      const fd = processMem.getInt32(fdsPtr + i * 8, true);
      if (fd < 0) continue;
      const events = processMem.getInt16(fdsPtr + i * 8 + 4, true);
      if (getRecvPipe) {
        const pipeIdx = getRecvPipe(pid, fd);
        if (pipeIdx >= 0) {
          indices.push(pipeIdx);
        }
      }
      if (getAcceptWakeIdx && (events & POLLIN) !== 0) {
        const acceptIdx = getAcceptWakeIdx(pid, fd);
        if (acceptIdx >= 0) {
          acceptIndices.push(acceptIdx);
        }
      }
    }
    return { pipeIndices: indices, acceptIndices };
  }

  private resolveEpollReadinessIndices(pid: number): { pipeIndices: number[]; acceptIndices: number[] } {
    const getRecvPipe = this.kernelInstance!.exports.kernel_get_socket_recv_pipe as
      ((pid: number, fd: number) => number) | undefined;
    const getAcceptWakeIdx = this.kernelInstance!.exports.kernel_get_fd_accept_wake_idx as
      ((pid: number, fd: number) => number) | undefined;
    if (!getRecvPipe && !getAcceptWakeIdx) return { pipeIndices: [], acceptIndices: [] };

    const key = `${pid}:`;
    const indices: number[] = [];
    const acceptIndices: number[] = [];
    const EPOLLIN = 0x001;
    for (const [k, interests] of this.epollInterests) {
      if (!k.startsWith(key)) continue;
      for (const interest of interests) {
        if (getRecvPipe) {
          const pipeIdx = getRecvPipe(pid, interest.fd);
          if (pipeIdx >= 0) {
            indices.push(pipeIdx);
          }
        }
        if (getAcceptWakeIdx && (interest.events & EPOLLIN) !== 0) {
          const acceptIdx = getAcceptWakeIdx(pid, interest.fd);
          if (acceptIdx >= 0) {
            acceptIndices.push(acceptIdx);
          }
        }
      }
    }
    return { pipeIndices: indices, acceptIndices };
  }

  private wakeBlockedAccept(acceptIdx: number): void {
    const matches = Array.from(this.pendingPollRetries.entries()).filter(
      ([, e]) => e.acceptIndices?.includes(acceptIdx),
    );
    for (const [key, entry] of matches) {
      if (this.pendingPollRetries.get(key) !== entry) continue;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      this.pendingPollRetries.delete(key);
      if (this.processes.has(entry.channel.pid)) {
        this.retrySyscall(entry.channel);
      }
    }
  }

  private wakeBlockedPoll(pid: number, pipeIdx: number): void {
    // retrySyscall runs handleSyscall synchronously, which can re-insert
    // the same key via pendingPollRetries.set when the kernel returns
    // EAGAIN. JS Map iterators are not snapshots — re-inserted entries
    // appear at the new tail and the iterator yields them, livelocking
    // wakeBlockedPoll-hit / poll / poll-register inside one tick. Mirror
    // wakeAllBlockedRetries' snapshot-and-skip-if-replaced pattern.
    const matches = Array.from(this.pendingPollRetries.entries()).filter(
      ([, e]) => e.channel.pid === pid && e.pipeIndices.includes(pipeIdx),
    );
    for (const [key, entry] of matches) {
      if (this.pendingPollRetries.get(key) !== entry) continue;
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

  /** Cancel all pending select/pselect retries for a given pid. */
  private cleanupPendingSelectRetries(pid: number): void {
    for (const [key, entry] of this.pendingSelectRetries) {
      if (entry.channel.pid === pid) {
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
          clearImmediate(entry.timer);
        }
        this.pendingSelectRetries.delete(key);
      }
    }
  }

  /**
   * Drain kernel wakeup events and process targeted pipe/listener wakeups.
   * Called after each syscall completion. The kernel pushes events from
   * PipeBuffer operations and listener backlog changes.
   */
  private drainAndProcessWakeupEvents(): void {
    const drainFn = this.kernelInstance!.exports.kernel_drain_wakeup_events as
      ((outPtr: KernelPointer, outLen: number, maxEvents: number) => number) | undefined;
    if (!drainFn) return;

    const MAX_EVENTS = 256;
    const BYTES_PER_EVENT = 5;
    const bufSize = MAX_EVENTS * BYTES_PER_EVENT;

    const count = drainFn(this.toKernelPtr(this.scratchOffset), bufSize, MAX_EVENTS);
    if (count === 0) return;

    const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
    const WAKE_READABLE = 1;
    const WAKE_WRITABLE = 2;
    const WAKE_ACCEPT = 4;
    let needBroadWake = false;

    for (let i = 0; i < count; i++) {
      const off = this.scratchOffset + i * BYTES_PER_EVENT;
      const wakeIdx = kernelMem[off] | (kernelMem[off + 1] << 8) |
                      (kernelMem[off + 2] << 16) | (kernelMem[off + 3] << 24);
      const wakeType = kernelMem[off + 4];

      if (wakeType & WAKE_READABLE) {
        // Pipe became readable — wake pending readers on this pipe
        const readers = this.pendingPipeReaders.get(wakeIdx);
        if (readers && readers.length > 0) {
          this.pendingPipeReaders.delete(wakeIdx);
          for (const reader of readers) {
            if (this.processes.has(reader.pid)) {
              this.retrySyscall(reader.channel);
            }
          }
        }
      }

      if (wakeType & WAKE_WRITABLE) {
        // Pipe became writable — wake pending writers on this pipe
        const writers = this.pendingPipeWriters.get(wakeIdx);
        if (writers && writers.length > 0) {
          this.pendingPipeWriters.delete(wakeIdx);
          for (const writer of writers) {
            if (this.processes.has(writer.pid)) {
              this.retrySyscall(writer.channel);
            }
          }
        }
      }

      if (wakeType & WAKE_ACCEPT) {
        this.wakeBlockedAccept(wakeIdx);
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
    // shared kernel, the pipe wakeup can fire a ppoll retry BEFORE
    // X's follow-up kill is even sent by X's worker (Atomics.notify →
    // uv_async round-trip takes 1–5ms). If the retry fires first, ppoll
    // returns POLLIN and restores its sigmask; the late signal is then
    // blocked and the handler never fires. See
    // tests/sortix/os-test/signal/ppoll-block-sleep-write-raise.
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
    if (this.pendingPollRetries.size === 0 && this.pendingSelectRetries.size === 0 && this.pendingPipeReaders.size === 0 && this.pendingPipeWriters.size === 0) return;
    this.postponeSignalSafePollRetries(SIGNAL_SAFE_POLL_WAKE_DELAY_MS);
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    setTimeout(() => {
      this.wakeScheduled = false;
      this.wakeAllBlockedRetries();
    }, SIGNAL_SAFE_POLL_WAKE_DELAY_MS);
  }

  private postponeSignalSafePollRetries(delayMs: number): void {
    const now = Date.now();
    for (const [key, entry] of this.pendingPollRetries) {
      if (!entry.needsSignalSafeWake) continue;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }

      const remainingMs = entry.deadline && entry.deadline > 0
        ? Math.max(1, entry.deadline - now)
        : delayMs;
      const retryMs = Math.max(1, Math.min(delayMs, remainingMs));
      entry.timer = setTimeout(() => {
        this.pendingPollRetries.delete(key);
        if (this.processes.has(entry.channel.pid)) {
          this.retrySyscall(entry.channel);
        }
      }, retryMs);
    }
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

    for (const [, entry] of selectEntries) {
      if (!this.processes.has(entry.channel.pid)) continue;
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
   * libc/musl-overlay/src/thread/wasm32posix/pthread_cancel.c for the full flow.
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

    // 3) Select/pselect retry timer.
    const selEntry = this.pendingSelectRetries.get(target.channelOffset);
    if (selEntry && selEntry.channel === target) {
      clearTimeout(selEntry.timer);
      clearImmediate(selEntry.timer);
      this.pendingSelectRetries.delete(target.channelOffset);
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
      (pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number) => number;
    const mem = this.getKernelMem();

    // Injected-connection pipes live in the global pipe table; pid=0
    // tells kernel_pipe_read to use it directly. See kernel_inject_connection.
    for (const conn of conns) {
      // Drain all available data from the send pipe (not just one chunk)
      for (;;) {
        const readN = pipeRead(0, conn.sendPipeIdx, this.toKernelPtr(conn.scratchOffset), 65536);
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

      // Resolve which pipe/listener readiness tokens the polled fds map to.
      const { pipeIndices, acceptIndices } =
        this.resolvePollReadinessIndices(channel.pid, origArgs);

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
        this.pendingPollRetries.set(channel.channelOffset, {
          timer,
          channel,
          pipeIndices,
          acceptIndices,
          needsSignalSafeWake,
          deadline: Date.now() + timeoutMs,
        });
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
      // With pipe/listener readiness tokens, rely on targeted wakeups for
      // instant retry. The timer is only a safety net.
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
      // for read-like / write-like blocking retries.
      const hasTargetedWake = pipeIndices.length > 0 || acceptIndices.length > 0;
      const retryMs = hasTargetedWake
        ? (deadline > 0 ? Math.min(deadline - Date.now(), 10) : 10)
        : (deadline > 0 ? Math.min(deadline - Date.now(), 50) : 50);
      const timer = setTimeout(retryFn, Math.max(retryMs, 1));
      this.pendingPollRetries.set(channel.channelOffset, {
        timer,
        channel,
        pipeIndices,
        acceptIndices,
        needsSignalSafeWake,
        deadline,
      });
      return;
    }

    // (epoll_pwait is now handled entirely on the host side by handleEpollPwait)

    // sigtimedwait: kernel returned EAGAIN because no signal is pending.
    // Instead of busy-retrying, delay for the requested timeout then complete
    // with -1/EAGAIN.
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
    // Also honor MSG_DONTWAIT on socket send/recv syscalls; unlike O_NONBLOCK,
    // it lives only in the syscall arguments and should not enter the retry path.
    if (syscallHasMsgDontwait(syscallNr, origArgs)) {
      this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], -1, EAGAIN);
      return;
    }

    // Covers read/write, accept, accept4, and connect syscalls.
    if (READ_LIKE_SYSCALLS.has(syscallNr) || WRITE_LIKE_SYSCALLS.has(syscallNr)
        || syscallNr === SYS_ACCEPT || syscallNr === SYS_ACCEPT4
        || syscallNr === SYS_CONNECT) {
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
    // mq_receive in tests/sortix/os-test/basic/mqueue/mq_receive.c after mq_setattr sets
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
    // accept-readiness token so local connect/injected connection wakes the
    // accept immediately instead of waiting for the fallback timer.
    if (syscallNr === SYS_ACCEPT || syscallNr === SYS_ACCEPT4) {
      const fd = origArgs[0];
      const getAcceptWakeIdx = this.kernelInstance!.exports.kernel_get_fd_accept_wake_idx as
        ((pid: number, fd: number) => number) | undefined;
      if (getAcceptWakeIdx) {
        const acceptIdx = getAcceptWakeIdx(channel.pid, fd);
        if (acceptIdx >= 0) {
          const retryFn = () => {
            this.pendingPollRetries.delete(channel.channelOffset);
            if (this.processes.has(channel.pid)) {
              this.retrySyscall(channel);
            }
          };
          const timer = setTimeout(retryFn, 10);
          this.pendingPollRetries.set(channel.channelOffset, {
            timer,
            channel,
            pipeIndices: [],
            acceptIndices: [acceptIdx],
          });
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
      if (exitStatus >= 128) {
        this.handleProcessTerminated(channel);
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
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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

    const cmd = origArgs[1];
    if (
      retVal === -1 &&
      errVal === EAGAIN &&
      (cmd === F_SETLKW || cmd === F_SETLKW64 || cmd === F_OFD_SETLKW)
    ) {
      this.handleBlockingRetry(channel, SYS_FCNTL, origArgs);
      return;
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
            this.pendingSelectRetries.delete(channel.channelOffset);
            if (this.processes.has(channel.pid)) {
              this.completeChannel(channel, SYS_SELECT, origArgs, undefined, 0, 0);
            }
          }, timeoutMs)
        : (null as any);
      this.pendingSelectRetries.set(channel.channelOffset, {
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
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
        this.pendingSelectRetries.delete(channel.channelOffset);
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
      this.pendingSelectRetries.set(channel.channelOffset, {
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
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
            this.pendingSelectRetries.delete(channel.channelOffset);
            if (this.processes.has(channel.pid)) {
              this.completeChannel(channel, SYS_PSELECT6, origArgs, undefined, 0, 0);
            }
          }, timeoutMs);
          this.pendingSelectRetries.set(channel.channelOffset, {
            timer, channel, origArgs, deadline, needsSignalSafeWake, syscallNr: SYS_PSELECT6,
          });
        } else {
          // Infinite timeout with nfds=0: wait for signal delivery.
          // No timer — wakeAllBlockedRetries will trigger the retry.
          this.pendingSelectRetries.set(channel.channelOffset, {
            timer: null as any, channel, origArgs, deadline: -1,
            needsSignalSafeWake, syscallNr: SYS_PSELECT6,
          });
        }
        return;
      }

      // For finite timeout with actual fds, track the deadline
      const retryFn = () => {
        this.pendingSelectRetries.delete(channel.channelOffset);
        if (!this.processes.has(channel.pid)) return;
        if (deadline > 0 && Date.now() >= deadline) {
          this.completeChannel(channel, SYS_PSELECT6, origArgs, undefined, 0, 0);
          return;
        }
        this.handlePselect6(channel, origArgs);
      };
      const timer = setImmediate(retryFn);
      this.pendingSelectRetries.set(channel.channelOffset, {
        timer, channel, origArgs, deadline, needsSignalSafeWake, syscallNr: SYS_PSELECT6,
      });
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
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
    const { pipeIndices, acceptIndices } = this.resolveEpollReadinessIndices(channel.pid);

    const retryFn = () => {
      this.pendingPollRetries.delete(channel.channelOffset);
      if (this.processes.has(channel.pid)) {
        this.handleEpollPwait(channel, syscallNr, origArgs);
      }
    };
    const timer = setTimeout(retryFn, 10);
    this.pendingPollRetries.set(channel.channelOffset, {
      timer,
      channel,
      pipeIndices,
      acceptIndices,
    });
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
        (offset: KernelPointer, pid: number) => number;
      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
        (offset: KernelPointer, pid: number) => number;
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
            handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
      (offset: KernelPointer, pid: number) => number;

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
        handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
      (offset: KernelPointer, pid: number) => number;

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
        handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
        (offset: KernelPointer, pid: number) => number;
      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
        (offset: KernelPointer, pid: number) => number;
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
            handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
    kernelView.setUint32(CH_SYSCALL, SYS_SENDMSG, true);
    kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(kMsgPtr), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(flags), true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    if (retVal === -1 && errVal === EAGAIN) {
      this.handleBlockingRetry(channel, SYS_SENDMSG, origArgs);
      return;
    }

    this.completeChannel(channel, SYS_SENDMSG, origArgs, undefined, retVal, errVal);
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
    kernelView.setUint32(CH_SYSCALL, SYS_RECVMSG, true);
    kernelView.setBigInt64(CH_ARGS, BigInt(fd), true);
    kernelView.setBigInt64(CH_ARGS + 1 * CH_ARG_SIZE, BigInt(kMsgPtr), true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(flags), true);

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
    } finally {
      this.currentHandlePid = 0;
    }

    const retVal = Number(kernelView.getBigInt64(CH_RETURN, true));
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    if (retVal === -1 && errVal === EAGAIN) {
      this.handleBlockingRetry(channel, SYS_RECVMSG, origArgs);
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

    this.completeChannel(channel, SYS_RECVMSG, origArgs, undefined, retVal, errVal);
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

    // Clear fork_child flag immediately. With wpk_fork instrumentation, the
    // child resumes from the fork point and never checks this flag. Without
    // clearing it, a nested fork() from the child would hit the isForkChild
    // check above and return 0 instead of creating a grandchild.
    const clearForkChild = this.kernelInstance!.exports.kernel_clear_fork_child as
      ((pid: number) => number) | undefined;
    if (clearForkChild) clearForkChild(childPid);

    // Clear the child's blocked signal mask. With wpk_fork instrumentation,
    // musl's __restore_sigs after fork() runs in the child, but we clear it
    // here too for safety. Without fork instrumentation, the child re-executes
    // _start and never gets __restore_sigs.
    const resetSignalMask = this.kernelInstance!.exports.kernel_reset_signal_mask as
      ((pid: number) => number) | undefined;
    if (resetSignalMask) resetSignalMask(childPid);

    // If the syscall arrived on a thread channel (registered via clone()
    // with tid > 0), the wpk_fork save buffer is at THIS channel's offset
    // and the unwind frames are rooted in the pthread entry function, not
    // _start. Pass that context to onFork so the child Worker can rewind
    // correctly.
    const threadKey = `${parentPid}:${channel.channelOffset}`;
    const threadCtx = this.threadForkContexts.get(threadKey);
    const callerSlotStart =
      channel.channelOffset - PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE * WASM_PAGE_SIZE;
    const callerSlotLen = PROCESS_MEMORY_PAGES_PER_THREAD_SLOT * WASM_PAGE_SIZE;
    const threadFork: ForkFromThreadContext | undefined = threadCtx
      ? {
          fnPtr: threadCtx.fnPtr,
          argPtr: threadCtx.argPtr,
          forkBufAddr: channel.channelOffset - FORK_BUF_SIZE,
          slotStart: callerSlotStart,
          slotLen: callerSlotLen,
        }
      : undefined;

    if (threadFork) {
      try {
        this.reserveHostRegionAt(childPid, threadFork.slotStart, threadFork.slotLen);
      } catch (err) {
        this.removeFromKernelProcessTable(childPid);
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[kernel-worker] fork child slot reservation failed: ${message}`);
        this.completeChannel(channel, SYS_FORK, _origArgs, undefined, -1, 12);
        return;
      }
    }

    // Call the async fork handler to spawn child Worker
    this.callbacks.onFork(parentPid, childPid, channel.memory, threadFork).then((childChannelOffsets) => {
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
   * Handle SYS_SPAWN: read the blob and `path` from caller memory, copy
   * the blob to kernel scratch, ask the kernel to allocate a child pid +
   * build the child Process descriptor, then call `onSpawn` to launch a
   * fresh worker for that pid.
   *
   * Channel arg layout (per docs/plans/2026-05-04-non-forking-posix-spawn-design.md):
   *   arg0 = path_ptr (caller memory; PATH-resolved)
   *   arg1 = path_len
   *   arg2 = blob_ptr (caller memory)
   *   arg3 = blob_len
   *   arg4 = pid_out_ptr (caller writes child pid here on success)
   *   arg5 = 0 (reserved)
   *
   * Returns 0 on success / -errno on failure via the channel; the child
   * pid is delivered through `pid_out_ptr` rather than the return value
   * so callers can distinguish "kernel error" (negative) from "got a
   * child" (zero, then read pid_out).
   *
   * If `onSpawn` returns non-zero or rejects, the kernel-side child
   * descriptor is rolled back via `kernel_remove_process` so the spawn
   * attempt leaves no trace.
   */
  private handleSpawn(channel: ChannelInfo, origArgs: number[]): void {
    const parentPid = channel.pid;
    const pathPtr = origArgs[0];
    const pathLen = origArgs[1];
    const blobPtr = origArgs[2];
    const blobLen = origArgs[3];
    const pidOutPtr = origArgs[4];

    if (!this.callbacks.onSpawn || !this.callbacks.onResolveSpawn) {
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 38); // ENOSYS
      return;
    }

    // ── Read path + blob from caller memory ──
    const processMem = new Uint8Array(channel.memory.buffer);
    let path = "";
    if (pathPtr !== 0 && pathLen > 0) {
      path = new TextDecoder().decode(processMem.slice(pathPtr, pathPtr + pathLen));
      // Strip trailing NUL if the user copied a C string with the terminator.
      if (path.endsWith("\0")) path = path.slice(0, -1);
    }
    const rawPath = path;
    if (path && !path.startsWith("/")) {
      path = this.resolveExecPathAgainstCwd(parentPid, path);
    }

    if (blobLen <= 0 || (blobPtr === 0 && blobLen > 0)) {
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 22); // EINVAL
      return;
    }
    // .slice copies into a regular ArrayBuffer (TextDecoder rejects SAB views).
    const blobBytes = processMem.slice(blobPtr, blobPtr + blobLen);

    // ── Decode argv + envp host-side ──
    // The kernel parses the blob too, but onSpawn needs string[] for the
    // worker launch path. We don't redo action/attr parsing here; the
    // kernel is the authoritative parser for that surface.
    let argv: string[];
    let envp: string[];
    try {
      const decoded = decodeSpawnBlobStrings(blobBytes);
      argv = decoded.argv;
      envp = decoded.envp;
    } catch (_e) {
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 22); // EINVAL
      return;
    }

    // ── PRE-FLIGHT: resolve program bytes BEFORE calling the kernel ──
    // POSIX requires file_actions to run "exactly once." `posix_spawnp`'s
    // PATH search emits one `posix_spawn` per candidate; if we let the
    // kernel apply file_actions on each iteration, the side effects
    // (e.g. `addopen(O_EXCL)`) accumulate and the second iteration sees
    // its own state from the first. Resolve bytes via the host's
    // side-effect-free preflight first; only call the kernel if the
    // program actually exists.
    const resolveSpawnProgram = async (): Promise<SpawnProgramResolution | null> => {
      const resolved = await this.callbacks.onResolveSpawn!(path, argv);
      if (resolved || rawPath === path || !rawPath || rawPath.startsWith("/")) {
        return resolved;
      }

      // SYS_SPAWN is also used by posix_spawnp-style PATH probes. Those
      // callers may hand us a relative executable name that exists only in
      // the host execPrograms map, not in the kernel VFS at CWD/name.
      // Keep the CWD-resolved path as the primary POSIX exec target, but
      // fall back to the original token for host-side program maps.
      return this.callbacks.onResolveSpawn!(rawPath, argv);
    };

    resolveSpawnProgram().then((resolved) => {
      if (!resolved) {
        this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 2); // ENOENT
        return;
      }
      if (isSpawnResolveError(resolved)) {
        this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, resolved.errno >>> 0);
        return;
      }
      const programBytes = resolved instanceof ArrayBuffer ? resolved : resolved.programBytes;
      const launchArgv = resolved instanceof ArrayBuffer ? argv : resolved.argv;
      this.handleSpawnAfterResolve(
        channel, origArgs, parentPid, pidOutPtr, blobBytes, blobLen, launchArgv, envp, programBytes,
      );
    }).catch((err) => {
      console.error(`[kernel] spawn resolve error for parent ${parentPid}:`, err);
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 5); // EIO
    });
  }

  /**
   * Continuation of `handleSpawn` after `onResolveSpawn` has returned
   * actual program bytes. Now safe to ask the kernel to build the child
   * (which will apply file_actions exactly once).
   */
  private handleSpawnAfterResolve(
    channel: ChannelInfo,
    origArgs: number[],
    parentPid: number,
    pidOutPtr: number,
    blobBytes: Uint8Array,
    blobLen: number,
    argv: string[],
    envp: string[],
    programBytes: ArrayBuffer,
  ): void {
    // ── Copy blob to kernel scratch ──
    const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
    if (blobLen > kernelMem.byteLength - this.scratchOffset) {
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 22); // EINVAL
      return;
    }
    kernelMem.set(blobBytes, this.scratchOffset);

    // ── Ask the kernel to build the child descriptor ──
    const kernelSpawn = this.kernelInstance!.exports.kernel_spawn_process as
      (parentPid: number, blobPtr: KernelPointer, blobLen: KernelPointer) => number;
    const result = kernelSpawn(
      parentPid,
      this.toKernelPtr(this.scratchOffset),
      this.toKernelPtr(blobLen),
    );
    if (result < 0) {
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, (-result) >>> 0);
      return;
    }
    const childPid = result >>> 0;

    // Bump host-side nextChildPid watermark so a subsequent fork() in the
    // parent can't collide with the kernel's allocation.
    if (childPid >= this.nextChildPid) this.nextChildPid = childPid + 1;

    // ── Launch the worker async (with already-resolved bytes) ──
    this.callbacks.onSpawn!(childPid, programBytes, argv, envp).then((rc) => {
      if (rc < 0) {
        const removeProcess = this.kernelInstance!.exports.kernel_remove_process as
          (pid: number) => number;
        removeProcess(childPid);
        this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, (-rc) >>> 0);
        return;
      }
      // Write the child pid through pid_out_ptr in caller memory.
      if (pidOutPtr !== 0) {
        new DataView(channel.memory.buffer).setInt32(pidOutPtr, childPid, true);
      }
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, 0, 0);
    }).catch((err) => {
      console.error(`[kernel] spawn error for parent ${parentPid}:`, err);
      const removeProcess = this.kernelInstance!.exports.kernel_remove_process as
        (pid: number) => number;
      removeProcess(childPid);
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 5); // EIO
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
      ((pid: number, bufPtr: KernelPointer, bufLen: number) => number) | undefined;
    if (!getCwd) return path;
    const cwdLen = getCwd(pid, this.toKernelPtr(this.scratchOffset), 4096);
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
        ((pid: number, fd: number, bufPtr: KernelPointer, bufLen: number) => number) | undefined;
      if (!getFdPath) {
        this.completeChannel(channel, SYS_EXECVEAT, origArgs, undefined, -1, 38); // ENOSYS
        return;
      }
      const result = getFdPath(channel.pid, dirfd, this.toKernelPtr(this.scratchOffset), 4096);
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
    // The channel syscall path dispatches SYS_CLONE with Linux syscall
    // convention:
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
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
    // The host writes this because ptid_ptr is in process memory, not kernel
    // memory.
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

    // Register the clear-TID pointer before starting the host Worker. A very
    // short-lived pthread can reach SYS_EXIT before onClone resolves.
    if (ctidPtr !== 0) {
      this.threadCtidPtrs.set(`${channel.pid}:${tid}`, ctidPtr);
    }

    this.callbacks.onClone(
      channel.pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, channel.memory,
    ).then((assignedTid) => {
      if (!this.processes.has(channel.pid)) {
        if (ctidPtr !== 0) {
          this.threadCtidPtrs.delete(`${channel.pid}:${tid}`);
        }
        return;
      }
      if (assignedTid !== tid && ctidPtr !== 0) {
        this.threadCtidPtrs.delete(`${channel.pid}:${tid}`);
        this.threadCtidPtrs.set(`${channel.pid}:${assignedTid}`, ctidPtr);
      }
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, assignedTid, 0);
    }).catch((err) => {
      if (ctidPtr !== 0) {
        this.threadCtidPtrs.delete(`${channel.pid}:${tid}`);
      }
      console.error(`[kernel-worker] onClone failed: ${err}`);
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, -1, 12); // ENOMEM
    });
  }

  /**
   * Handle SYS_EXIT/SYS_EXIT_GROUP: notify the kernel and clean up.
   *
   * For SYS_EXIT from a non-main channel (thread exit): notify kernel,
   * remove channel, and let the host terminate the backing Worker. If an
   * older host entry has no thread-exit callback, fall back to completing the
   * channel for compatibility.
   * For SYS_EXIT from main channel or SYS_EXIT_GROUP: current behavior.
   */
  private handleExit(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const exitStatus = origArgs[0];
    const registration = this.processes.get(channel.pid);

    // Check if this is a thread exit (non-main channel + SYS_EXIT)
    const isMainChannel = registration && registration.channels.length > 0 &&
      registration.channels[0].channelOffset === channel.channelOffset;

    if (syscallNr === SYS_EXIT && !isMainChannel) {
      // Thread exit: finalize kernel-side thread state, ask the host to tear
      // down the backing thread Worker (browser + Node both wire onThreadExit),
      // then complete the channel.
      const tidKey = `${channel.pid}:${channel.channelOffset}`;
      const tid = this.channelTids.get(tidKey) ?? 0;
      if (tid > 0) this.finalizeThreadExit(channel.pid, tid, channel.channelOffset);
      if (tid > 0) {
        this.callbacks.onThreadExit?.(channel.pid, tid, channel.channelOffset);
      }
      // Complete — never merely abandon — the channel on thread exit. This
      // flips the status word off CH_PENDING so the exiting guest's in-wasm
      // memory.atomic.wait32() on this status word returns and its waiter is
      // removed *before* the thread's slot and channel offset are freed and
      // reused by a later clone(). Abandoning (leaving status=PENDING with the
      // guest still parked) lets that waiter outlive the slot: #830 replaced
      // the cooperative worker-shutdown handshake with an immediate
      // terminate(), so the dying Worker's agent is not guaranteed gone before
      // reuse. The guest wake protocol notifies exactly one waiter
      // (memory.atomic.notify(status, 1)); a stale parked waiter from the prior
      // thread then steals the reused thread's first-syscall notify, the
      // kernel's Atomics.waitAsync never fires, and the new thread wedges
      // forever. Observed as: MariaDB's connection-handler thread (cloned when
      // it accepts php-fpm's DB connection) never runs its first syscall, so
      // the WordPress-over-MariaDB demo never gets a MySQL greeting and hangs.
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
        (offset: KernelPointer, pid: number) => number;
      this.currentHandlePid = channel.pid;
      this.bindKernelTidForChannel(channel);
      try {
        handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
    this.notifyParentOfExitedProcess(exitingPid);

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
   * syscall retry. Rust already owns the Exited state and wait status; the
   * host only wakes the parent waiter and terminates the Worker.
   */
  private handleProcessTerminated(channel: ChannelInfo): void {
    const exitingPid = channel.pid;
    // Idempotency guard — both handleExit and reapKilledProcessesAfterSyscall
    // can route here for the same pid; do the parent-wakeup work exactly
    // once per generation. Cleared by deactivateProcess + registerProcess
    // so a recycled pid (currently impossible with monotonic nextChildPid,
    // but defensive) starts fresh.
    if (this.hostReaped.has(exitingPid)) return;
    this.hostReaped.add(exitingPid);
    this.notifyParentOfExitedProcess(exitingPid);

    // Clean up per-process state
    this.sharedMappings.delete(exitingPid);

    // Do NOT complete the channel — the worker is blocked on Atomics.wait
    // and waking it would cause the C code to continue executing.
    // onExit will terminate the worker.
    if (this.callbacks.onExit) {
      const getExitStatus = this.kernelInstance!.exports
        .kernel_get_process_exit_status as ((pid: number) => number) | undefined;
      const exitStatus = getExitStatus ? getExitStatus(exitingPid) : -1;
      this.callbacks.onExit(exitingPid, exitStatus >= 128 ? exitStatus : -1);
    }
  }

  /**
   * Notify the kernel that a host worker for `pid` died asynchronously
   * (uncaught wasm trap, instantiation failure, externally terminated
   * Worker) WITHOUT going through the normal SYS_EXIT_GROUP path.
   *
   * Without this, an OOB/instantiation crash leaves the kernel
   * believing the process is still alive: any concurrent waitpid in
   * the parent then blocks until host destroy. P-06 / K-03 exposed
   * this — the child's wasm trapped during _start, the worker
   * reported it via `{type:"error"}`, the host posted `stderr` +
   * deactivated the process locally, but the kernel never marked the
   * pid as a zombie or woke the parent.
   *
   * Marks the process as signal-terminated in Rust using `signum` (default
   * `SIGSEGV` = 11), queues `SIGCHLD` on the parent, and wakes any parked
   * `waitpid` / `waitid`.
   *
   * Idempotent via `hostReaped`: if the kernel already saw a clean
   * SYS_EXIT for this pid, this is a no-op (the kernel's exit
   * status wins). Host-side cleanup (channel removal, timer
   * cancellation) is still the caller's responsibility — call
   * `deactivateProcess` after this if the pid is going away.
   */
  notifyHostProcessCrashed(pid: number, signum: number = 11 /* SIGSEGV */): void {
    if (this.hostReaped.has(pid)) return;
    const markSignaled = this.kernelInstance!.exports.kernel_mark_process_signaled as
      ((pid: number, signum: number) => number) | undefined;
    if (markSignaled && markSignaled(pid, signum) < 0) return;
    this.hostReaped.add(pid);
    this.notifyParentOfExitedProcess(pid);
    this.sharedMappings.delete(pid);
  }

  /**
   * After SYS_KILL completes, scan for processes the kernel just marked
   * Exited that the host hasn't reaped. Without this, a `kill` of a
   * sleeping child (or any process not blocked in poll/select/pipe — those
   * are handled by scheduleWakeBlockedRetries) silently reaps the process
   * at the kernel level but can leave the host-side blocked wait queue
   * asleep — wait4(-1) then blocks forever.
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
      if (status < 128) continue;           // still alive, or normally exiting via SYS_EXIT
      if (this.hostReaped.has(pid)) continue; // already reaped this generation

      // Cancel any pending blocking-syscall timers — the process is gone.
      const ps = this.pendingSleeps.get(pid);
      if (ps) { clearTimeout(ps.timer); this.pendingSleeps.delete(pid); }

      const proc = this.processes.get(pid);
      const ch = proc?.channels[0];
      // handleProcessTerminated re-checks hostReaped and adds the pid
      // itself, so passing through here is idempotent if two reap
      // events fire close together.
      if (ch) this.handleProcessTerminated(ch);
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

    const poll = this.pollWaitableChild(parentPid, targetPid);
    if (poll.kind === "error") {
      this.completeWaitpid(channel, origArgs, -1, poll.errno);
      return;
    }
    if (poll.kind === "exited") {
      this.consumeExitedChild(parentPid, poll.childPid);
      this.writeWaitStatus(channel, wstatusPtr, poll.waitStatus);
      this.completeWaitpid(channel, origArgs, poll.childPid, 0);
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

  private pollWaitableChild(parentPid: number, targetPid: number): WaitPollResult {
    const waitPoll = this.kernelInstance!.exports.kernel_wait4_poll as
      (parentPid: number, targetPid: number, statusPtr: KernelPointer) => number;
    const result = waitPoll(parentPid, targetPid, this.toKernelPtr(this.scratchOffset!));
    if (result > 0) {
      const waitStatus = new DataView(this.kernelMemory!.buffer)
        .getInt32(this.scratchOffset!, true);
      return { kind: "exited", childPid: result, waitStatus };
    }
    if (result === 0) return { kind: "running" };
    return { kind: "error", errno: (-result) >>> 0 };
  }

  private getParentPid(pid: number): number | undefined {
    const getParentPid = this.kernelInstance!.exports.kernel_get_parent_pid as
      (pid: number) => number;
    const result = getParentPid(pid);
    return result > 0 ? result : undefined;
  }

  private consumeExitedChild(parentPid: number, childPid: number): void {
    const reapChild = this.kernelInstance!.exports.kernel_reap_exited_child as
      (parentPid: number, childPid: number) => number;
    reapChild(parentPid, childPid);
  }

  private notifyParentOfExitedProcess(pid: number): void {
    const parentPid = this.getParentPid(pid);
    if (parentPid === undefined) return;

    const hasNoCldWait = this.kernelInstance!.exports
      .kernel_has_sa_nocldwait as ((pid: number) => number) | undefined;
    const autoReap = hasNoCldWait ? hasNoCldWait(parentPid) === 1 : false;
    if (autoReap) {
      this.consumeExitedChild(parentPid, pid);
      return;
    }

    this.sendSignalToProcess(parentPid, SIGCHLD);
    this.wakeWaitingParent(parentPid);
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
  private wakeWaitingParent(parentPid: number): void {
    let idx = -1;
    let poll: WaitPollResult | undefined;
    for (let i = 0; i < this.waitingForChild.length; i++) {
      const waiter = this.waitingForChild[i];
      if (waiter.parentPid !== parentPid) continue;
      const waiterPoll = this.pollWaitableChild(waiter.parentPid, waiter.pid);
      if (waiterPoll.kind !== "exited") continue;
      idx = i;
      poll = waiterPoll;
      break;
    }
    if (idx === -1 || poll?.kind !== "exited") return;

    const waiter = this.waitingForChild[idx];
    this.waitingForChild.splice(idx, 1);

    if (waiter.syscallNr === SYS_WAITID) {
      // waitid: write siginfo_t, optionally consume zombie
      this.writeSignalInfo(waiter.channel, waiter.origArgs[2], poll.childPid, poll.waitStatus);
      if (!(waiter.options & WNOWAIT)) {
        this.consumeExitedChild(parentPid, poll.childPid);
      }
      this.dequeueSignalForDelivery(waiter.channel);
      this.completeChannel(waiter.channel, SYS_WAITID, waiter.origArgs, undefined, 0, 0);
    } else {
      // wait4: write wstatus, consume zombie
      this.consumeExitedChild(parentPid, poll.childPid);
      this.writeWaitStatus(waiter.channel, waiter.origArgs[1], poll.waitStatus);
      this.completeWaitpid(waiter.channel, waiter.origArgs, poll.childPid, 0);
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

      const poll = this.pollWaitableChild(waiter.parentPid, waiter.pid);
      if (poll.kind === "error") {
        // No more matching children — wake with ECHILD
        this.waitingForChild.splice(i, 1);
        if (waiter.syscallNr === SYS_WAITID) {
          this.completeChannel(waiter.channel, SYS_WAITID, waiter.origArgs, undefined, -1, poll.errno);
        } else {
          this.completeWaitpid(waiter.channel, waiter.origArgs, -1, poll.errno);
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
    const waitPid = this.waitidToWaitPid(idtype, id);

    const poll = this.pollWaitableChild(parentPid, waitPid);
    if (poll.kind === "error") {
      this.completeChannel(channel, SYS_WAITID, origArgs, undefined, -1, poll.errno);
      return;
    }
    if (poll.kind === "exited") {
      this.writeSignalInfo(channel, siginfoPtr, poll.childPid, poll.waitStatus);
      if (!(options & WNOWAIT)) {
        this.consumeExitedChild(parentPid, poll.childPid);
      }
      this.completeChannel(channel, SYS_WAITID, origArgs, undefined, 0, 0);
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
    this.waitingForChild.push({
      parentPid,
      channel,
      origArgs,
      pid: waitPid,
      options,
      syscallNr: SYS_WAITID,
    });
  }

  private waitidToWaitPid(idtype: number, id: number): number {
    if (idtype === P_PID) return id;
    if (idtype === P_PGID) return id === 0 ? 0 : -id;
    return -1;
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
   * The kernel's host_futex_wake/wait imports operate on kernel memory, but
   * futex addresses are in process memory. We bypass the kernel entirely and
   * implement the futex ops here.
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
   * Complete kernel-side cleanup for a thread whose worker has stopped.
   * Normal pthread exit reaches this from SYS_EXIT. Crash paths use the same
   * cleanup so pthread_join waiters do not stay blocked on CLONE_CHILD_CLEARTID.
   *
   * Both identifiers matter: `channelOffset` removes the host mailbox/fork
   * context, while `tid` addresses the kernel/libc thread state and clear-TID
   * futex word used by joiners.
   */
  finalizeThreadExit(pid: number, tid: number, channelOffset: number): void {
    const tidKey = `${pid}:${channelOffset}`;
    this.channelTids.delete(tidKey);
    this.threadForkContexts.delete(tidKey);

    const ctidKey = `${pid}:${tid}`;
    const ctidPtr = this.threadCtidPtrs.get(ctidKey);
    if (ctidPtr && ctidPtr !== 0) {
      this.threadCtidPtrs.delete(ctidKey);
      const channel = this.activeChannels.find(
        (ch) => ch.pid === pid && ch.channelOffset === channelOffset,
      );
      const memory = channel?.memory ?? this.processes.get(pid)?.memory;
      if (memory) {
        const procView = new DataView(memory.buffer);
        procView.setInt32(ctidPtr, 0, true);
        const i32View = new Int32Array(memory.buffer);
        Atomics.notify(i32View, ctidPtr >>> 2, 1);
      }
    }

    this.notifyThreadExit(pid, tid);
    this.removeChannel(pid, channelOffset);
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
      (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = targetPid;
    // Host-originated signal (SIGCHLD, SIGALRM, timer, etc.) is always a
    // "shared" delivery — it lands on the process's pending queue, not a
    // specific thread's. Force tid=0 so the kernel doesn't consult any
    // per-thread state left over from a prior dispatch.
    const setTid = this.kernelInstance.exports.kernel_set_current_tid as
      ((tid: number) => void) | undefined;
    if (setTid) setTid(0);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), targetPid);
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

    // 3. Pending select/pselect6 retries
    for (const [key, selectEntry] of this.pendingSelectRetries) {
      if (selectEntry.channel.pid !== targetPid) continue;
      clearTimeout(selectEntry.timer);
      clearImmediate(selectEntry.timer);
      this.pendingSelectRetries.delete(key);
      if (!this.processes.has(targetPid)) continue;
      if (selectEntry.syscallNr === SYS_SELECT) {
        this.handleSelect(selectEntry.channel, selectEntry.origArgs);
      } else {
        this.handlePselect6(selectEntry.channel, selectEntry.origArgs);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Process memory management
  //
  // The kernel's ensure_memory_covers() grows the KERNEL's Wasm memory
  // (memory index 0 in the kernel module). But the
  // process runs in a different WebAssembly.Memory. After brk/mmap/mremap
  // syscalls, we must grow the process's memory to cover the returned
  // addresses — otherwise the process gets "memory access out of bounds".
  // -----------------------------------------------------------------------

  private ensureProcessMemoryCovers(
    pid: number,
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
      const ptrWidth = this.processes.get(pid)?.ptrWidth ?? 4;
      growMemoryToCover(processMemory, endAddr, ptrWidth);
      // Memory.grow detaches any TypedArray bound to the previous SAB.
      // Any cached framebuffer view on this pid is now invalid; the
      // renderer must rebuild it on the next frame from the new
      // Memory.buffer. Idempotent for pids without a binding.
      this.kernel.framebuffers.rebindMemory(pid);
    }

    // Zero the mmap'd region. Anonymous mmap must return zeroed pages (like
    // Linux). The kernel allocates whole pages, so zero the full page-aligned
    // region, not just the requested length. On Linux, bytes beyond the
    // requested length up to the page boundary are also zeroed. Without this,
    // reused addresses contain stale data from previous allocations,
    // corrupting musl's malloc metadata (infinite loops / heap corruption).
    //
    // For mremap, the existing prefix [old_addr, old_addr + old_len) MUST be
    // preserved (mremap is content-preserving — that's the contract mallocng's
    // realloc relies on). Only zero the *new tail* [old_len, new_len) when the
    // mapping grew in place (retVal === old_addr); the move case is handled
    // by the memcpy below, which copies the prefix from the old buffer.
    if (mmapLen > 0) {
      const PAGE_SIZE = 65536; // Wasm page size
      const alignedLen = Math.ceil(mmapLen / PAGE_SIZE) * PAGE_SIZE;
      const newBytes = processMemory.buffer.byteLength;
      let zeroStart = mmapAddr;
      const zeroEnd = Math.min(mmapAddr + alignedLen, newBytes);
      if (syscallNr === SYS_MREMAP) {
        const oldAddr = origArgs[0] >>> 0;
        const oldLen = origArgs[1] >>> 0;
        if (mmapAddr === oldAddr && oldLen > 0) {
          // In-place grow: prefix [oldAddr, oldAddr + oldLen) must remain
          // untouched. Only the new tail [oldAddr + oldLen, ...) needs to be
          // zeroed. Page-align the start so we don't tear partial-page bytes
          // either way.
          const oldEndPageAligned = Math.ceil((oldAddr + oldLen) / PAGE_SIZE) * PAGE_SIZE;
          zeroStart = Math.max(zeroStart, oldEndPageAligned);
        }
        // Move case (mmapAddr !== oldAddr): the new region's prefix gets
        // overwritten by the memcpy below; zeroing first is harmless and
        // matches anonymous-mmap semantics for any tail bytes the memcpy
        // doesn't touch.
      }
      if (zeroStart < zeroEnd) {
        new Uint8Array(processMemory.buffer, zeroStart, zeroEnd - zeroStart).fill(0);
      }
    }

    // For a *moving* mremap, restore the user's bytes from old_addr → new_addr.
    // The kernel runs in its own Wasm linear memory, so it can't memcpy across
    // the process's address space; mallocng's realloc and any other libc
    // caller relies on mremap being content-preserving (Linux remaps physical
    // pages — same effect, different mechanism). Without this copy, every
    // mallocng allocation that crosses MMAP_THRESHOLD (131,052 bytes) on
    // grow loses its prefix because mmap_anonymous returns a zeroed region.
    //
    // Runs after the zero-fill above, so the prefix is overwritten back to
    // its original bytes; the tail (new_len > old_len) stays zeroed, matching
    // anonymous-mmap semantics. The kernel's munmap of old_addr is metadata
    // only — the underlying bytes are still in the process memory and safe
    // to read here.
    if (
      syscallNr === SYS_MREMAP &&
      retVal >= 0 &&
      retVal !== origArgs[0] &&
      origArgs[0] !== 0 &&
      origArgs[1] > 0
    ) {
      const oldAddr = origArgs[0] >>> 0;
      const oldLen = origArgs[1] >>> 0;
      const newAddr = retVal >>> 0;
      const newLen = origArgs[2] >>> 0;
      const copyLen = Math.min(oldLen, newLen);
      if (copyLen > 0) {
        const buf = processMemory.buffer;
        const totalBytes = buf.byteLength;
        if (oldAddr + copyLen <= totalBytes && newAddr + copyLen <= totalBytes) {
          const src = new Uint8Array(buf, oldAddr, copyLen);
          new Uint8Array(buf, newAddr, copyLen).set(src);
        }
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
      (offset: KernelPointer, pid: number) => number;
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
        handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
      (offset: KernelPointer, pid: number) => number;
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
        handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
      ((pid: number, maxAddr: KernelPointer) => number) | undefined;
    if (setMaxAddrFn) {
      setMaxAddrFn(pid, this.toKernelPtr(maxAddr));
    }
  }

  /**
   * Set the program-break ceiling for a process. Hosts use this to reserve
   * low in-memory control pages for syscall channels and pthread TLS without
   * letting brk grow into them.
   */
  setBrkLimit(pid: number, brkLimit: number): boolean {
    const setBrkLimitFn = this.kernelInstance!.exports.kernel_set_brk_limit as
      ((pid: number, brkLimit: KernelPointer) => number) | undefined;
    if (!setBrkLimitFn) {
      return false;
    }
    return setBrkLimitFn(pid, this.toKernelPtr(brkLimit)) >= 0;
  }

  /**
   * Set the automatic mmap lower bound for a process. Compact process layouts
   * set this to the first guest-managed byte after the host control prefix.
   */
  setMmapBase(pid: number, mmapBase: number): boolean {
    const setMmapBaseFn = this.kernelInstance!.exports.kernel_set_mmap_base as
      ((pid: number, mmapBase: KernelPointer) => number) | undefined;
    if (!setMmapBaseFn) {
      return false;
    }
    return setMmapBaseFn(pid, this.toKernelPtr(mmapBase)) >= 0;
  }

  reserveHostRegion(pid: number, len: number): number {
    const reserveHostRegionFn = this.kernelInstance!.exports.kernel_reserve_host_region as
      ((pid: number, len: KernelPointer) => KernelPointer) | undefined;
    if (!reserveHostRegionFn) {
      throw new Error(
        "Kernel export kernel_reserve_host_region is required for dynamic pthread control slots",
      );
    }
    const addr = reserveHostRegionFn(pid, this.toKernelPtr(len));
    const n = typeof addr === "bigint" ? Number(addr) : addr;
    if (!Number.isSafeInteger(n) || n < 0 || (n >>> 0) === 0xffffffff) {
      throw new Error(`failed to reserve ${len} bytes of pthread control memory for pid=${pid}`);
    }
    return n;
  }

  reserveHostRegionAt(pid: number, addr: number, len: number): number {
    const reserveHostRegionAtFn = this.kernelInstance!.exports.kernel_reserve_host_region_at as
      ((pid: number, addr: KernelPointer, len: KernelPointer) => KernelPointer) | undefined;
    if (!reserveHostRegionAtFn) {
      throw new Error(
        "Kernel export kernel_reserve_host_region_at is required for fork-from-pthread control slots",
      );
    }
    const reserved = reserveHostRegionAtFn(
      pid,
      this.toKernelPtr(addr),
      this.toKernelPtr(len),
    );
    const n = typeof reserved === "bigint" ? Number(reserved) : reserved;
    if (!Number.isSafeInteger(n) || n < 0 || (n >>> 0) === 0xffffffff || n !== addr) {
      throw new Error(
        `failed to reserve pthread control memory at 0x${addr.toString(16)} ` +
          `for pid=${pid}`,
      );
    }
    return n;
  }

  private highControlFloorForProcess(pid: number): number | null {
    const registration = this.processes.get(pid);
    if (!registration) return null;
    if (registration.explicitMaxAddr) return null;
    let floor: number | null = null;
    for (const ch of registration.channels) {
      const tlsPageAddr = ch.channelOffset - 2 * WASM_PAGE_SIZE;
      if (tlsPageAddr >= PROCESS_MMAP_BASE) {
        floor = floor === null ? tlsPageAddr : Math.min(floor, tlsPageAddr);
      }
    }
    return floor;
  }

  /**
   * Set the program's initial brk. Compact process layouts pass the first
   * guest-managed byte after the host control slab; legacy callers may pass
   * the program's `__heap_base` directly. Must run before the new process
   * worker can issue its first syscall.
   *
   * Accepts `bigint` (preferred — what `extractHeapBase` returns) or
   * `number`. The kernel export takes a `usize`, whose JS representation
   * depends on the kernel wasm pointer width.
   */
  setBrkBase(pid: number, addr: bigint | number): boolean {
    const setBrkBaseFn = this.kernelInstance!.exports.kernel_set_brk_base as
      ((pid: number, addr: KernelPointer) => number) | undefined;
    if (!setBrkBaseFn) {
      return false;
    }
    return setBrkBaseFn(pid, this.toKernelPtr(addr)) >= 0;
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
   * Per-process fork counter (parent side, incremented inside
   * `kernel_fork_process` on success). Used by the spawn regression tests
   * to assert that a SYS_SPAWN call did NOT fall back to the fork path.
   *
   * Returns `u64::MAX` (as `bigint`) if the pid does not exist; callers
   * should compare against an explicit before-value rather than treating
   * "no process" as "0 forks".
   */
  getForkCount(pid: number): bigint {
    const fn = this.kernelInstance?.exports.kernel_get_fork_count as
      ((pid: number) => bigint) | undefined;
    if (!fn) return BigInt(0);
    return fn(pid);
  }

  /**
   * Push a mouse event into the kernel's `/dev/input/mice` queue. The
   * kernel buffers a 3-byte PS/2 frame; any process blocked in
   * `read()` or `poll()` on the device is woken on the next retry tick.
   */
  injectMouseEvent(dx: number, dy: number, buttons: number): void {
    this.kernel.injectMouseEvent(dx, dy, buttons);
    this.scheduleWakeBlockedRetries();
  }

  /**
   * Drain up to `out.byteLength` bytes of PCM audio buffered in
   * `/dev/dsp` into `out`. Returns the number of bytes copied, always
   * a multiple of the active frame size (2 bytes mono / 4 bytes
   * stereo).
   *
   * The host typically drives this from an `AudioWorkletNode` or
   * `AudioBufferSourceNode` scheduler that pulls samples at the rate
   * an `AudioContext` reports. The kernel ring drops oldest frames on
   * overflow rather than blocking, so falling behind a few RAFs costs
   * audio but never wedges DOOM.
   */
  drainAudio(out: Uint8Array): number {
    return this.kernel.drainAudio(out);
  }

  /** Sample rate (Hz) the program last configured on `/dev/dsp`. */
  audioSampleRate(): number {
    return this.kernel.audioSampleRate();
  }

  /** Channel count the program last configured on `/dev/dsp`. */
  audioChannels(): number {
    return this.kernel.audioChannels();
  }

  /** Bytes buffered in the `/dev/dsp` ring waiting to be drained. */
  audioPending(): number {
    return this.kernel.audioPending();
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
  private startTcpListener(
    pid: number,
    fd: number,
    port: number,
    addr: [number, number, number, number] = [0, 0, 0, 0],
  ): void {
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

    if (this.io.network?.listenTcp) {
      const result = this.io.network.listenTcp(
        key,
        new Uint8Array(addr),
        port,
        {
          accept: (peer, _local, remote) =>
            this.handleIncomingVirtualTcpConnection(pid, fd, peer, remote),
        },
      );
      if (result !== 0) {
        console.warn(`virtual TCP listener registration failed on port ${port}: errno ${result}`);
      }
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
   *
   * Public so external callers (the in-kernel HTTP request bridge) can
   * resolve a port to a {pid, fd} before injecting a connection.
   */
  pickListenerTarget(port: number): {pid: number, fd: number} | null {
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
      const children = alive.filter(t => this.getParentPid(t.pid) !== undefined);
      if (children.length > 0) {
        candidates = children;
      }
    }

    const idx = (this.tcpListenerRRIndex.get(port) ?? 0) % candidates.length;
    this.tcpListenerRRIndex.set(port, idx + 1);
    return candidates[idx]!;
  }

  // ---------------------------------------------------------------------------
  // External HTTP request bridge (host → in-kernel server, no real TCP)
  // ---------------------------------------------------------------------------

  /**
   * Send an HTTP/1.1 request to a server running inside the kernel and
   * resolve with the parsed response. Bypasses real TCP — uses
   * `kernel_inject_connection` + `kernel_pipe_*` directly.
   *
   * Used by both the browser service-worker bridge and the Node host's
   * `fetchInKernel` API (see
   * docs/plans/2026-04-30-external-kernel-http-request-interface.md).
   */
  async sendHttpRequest(
    port: number,
    request: HttpRequest,
    opts: SendHttpRequestOptions = {},
  ): Promise<HttpResponse> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const label = opts.debugLabel ?? `${request.method} ${request.url}`;

    const target = this.pickListenerTarget(port);
    if (!target) {
      throw new Error(`No in-kernel listener for port ${port}`);
    }

    const exports = this.kernelInstance!.exports;
    const injectConnection = exports.kernel_inject_connection as (
      pid: number, fd: number, a: number, b: number, c: number, d: number, port: number,
    ) => number;
    const pipeWrite = exports.kernel_pipe_write as (
      pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number,
    ) => number;
    const pipeRead = exports.kernel_pipe_read as (
      pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number,
    ) => number;
    const pipeIsWriteOpen = exports.kernel_pipe_is_write_open as (
      pid: number, pipeIdx: number,
    ) => number;
    const pipeCloseWrite = exports.kernel_pipe_close_write as (
      pid: number, pipeIdx: number,
    ) => number;
    const pipeCloseRead = exports.kernel_pipe_close_read as (
      pid: number, pipeIdx: number,
    ) => number;

    // Synthetic remote — picked from the ephemeral range so the kernel
    // doesn't think two simultaneous external calls share a 4-tuple.
    const remotePort = 1024 + Math.floor(Math.random() * 60_000);
    const recvPipeIdx = injectConnection(
      target.pid, target.fd,
      127, 0, 0, 1,
      remotePort,
    );
    if (recvPipeIdx < 0) {
      throw new Error(
        `[in-kernel-http ${label}] kernel_inject_connection failed (${recvPipeIdx})`,
      );
    }
    const sendPipeIdx = recvPipeIdx + 1;
    const GLOBAL_PIPE_PID = 0;

    // Wake any pending poll on the target so accept() fires immediately.
    // Without this we'd wait for the next 5s poll fallback timer.
    this.wakeTargetPollNow(target.pid);
    this.scheduleWakeBlockedRetries();

    // Write the request bytes through the TCP scratch buffer.
    const rawRequest = buildRawHttpRequest(request);
    const written = this.writePipeChunked(pipeWrite, GLOBAL_PIPE_PID, recvPipeIdx, rawRequest);
    if (written < rawRequest.length) {
      // Partial write here would mean the recv pipe filled up before the
      // server even started reading. Treat as a hard error for the prototype.
      pipeCloseWrite(GLOBAL_PIPE_PID, recvPipeIdx);
      pipeCloseRead(GLOBAL_PIPE_PID, sendPipeIdx);
      throw new Error(
        `[in-kernel-http ${label}] partial write ${written}/${rawRequest.length}`,
      );
    }

    // Wake any reader/poller already blocked on the recv pipe.
    this.notifyPipeReadable(recvPipeIdx);

    // Pump the response.
    const response = await this.pumpHttpResponse(
      GLOBAL_PIPE_PID,
      sendPipeIdx,
      recvPipeIdx,
      pipeRead,
      pipeIsWriteOpen,
      pipeCloseRead,
      pipeCloseWrite,
      timeoutMs,
      label,
    );
    const retryBudget = opts.emptyResponseRetries ?? 1;
    if (
      retryBudget > 0 &&
      (request.method === "GET" || request.method === "HEAD") &&
      response.status === 200 &&
      Object.keys(response.headers).length === 0 &&
      response.body.length === 0
    ) {
      return await this.sendHttpRequest(port, request, {
        ...opts,
        emptyResponseRetries: retryBudget - 1,
      });
    }
    return response;
  }

  /**
   * Synchronously cancel any pending poll/ppoll waiting on the given pid
   * so the in-kernel server's accept loop fires this tick. Used by
   * sendHttpRequest right after injecting a connection.
   */
  private wakeTargetPollNow(pid: number): void {
    for (const [key, entry] of this.pendingPollRetries) {
      if (entry.channel.pid !== pid) continue;
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.pendingPollRetries.delete(key);
      if (this.processes.has(pid)) this.retrySyscall(entry.channel);
      break;
    }
  }

  /**
   * Write `data` through the TCP scratch buffer, looping until either the
   * pipe stops accepting or we've written everything. Returns total bytes
   * written.
   */
  private writePipeChunked(
    pipeWrite: (pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number) => number,
    pid: number,
    pipeIdx: number,
    data: Uint8Array,
  ): number {
    const scratchOffset = this.tcpScratchOffset;
    const PAGE = 65536;
    let written = 0;
    while (written < data.length) {
      const chunk = Math.min(data.length - written, PAGE);
      // Re-acquire view each iteration — memory.grow can detach the buffer.
      const mem = this.getKernelMem();
      mem.set(data.subarray(written, written + chunk), scratchOffset);
      const n = pipeWrite(pid, pipeIdx, this.toKernelPtr(scratchOffset), chunk);
      if (n <= 0) break;
      written += n;
    }
    return written;
  }

  /**
   * Pump response bytes out of `sendPipeIdx` until the server closes its
   * write end. Resolves with the parsed response, or with status 504 on
   * timeout. Closes both pipe ends before resolving.
   */
  private pumpHttpResponse(
    pid: number,
    sendPipeIdx: number,
    recvPipeIdx: number,
    pipeRead: (pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number) => number,
    pipeIsWriteOpen: (pid: number, pipeIdx: number) => number,
    pipeCloseRead: (pid: number, pipeIdx: number) => number,
    pipeCloseWrite: (pid: number, pipeIdx: number) => number,
    timeoutMs: number,
    label: string,
  ): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve) => {
      const chunks: Uint8Array[] = [];
      const start = Date.now();
      let sawWriteOpen = false;
      const scratchOffset = this.tcpScratchOffset;
      const PAGE = 65536;

      const finish = (response: HttpResponse) => {
        pipeCloseRead(pid, sendPipeIdx);
        pipeCloseWrite(pid, recvPipeIdx);
        this.notifyPipeReadable(recvPipeIdx);
        this.scheduleWakeBlockedRetries();
        resolve(response);
      };

      const tick = () => {
        if (Date.now() - start > timeoutMs) {
          finish({ status: 504, headers: {}, body: new Uint8Array(0) });
          return;
        }

        // Drain whatever is currently in the pipe.
        let gotData = false;
        for (;;) {
          const n = pipeRead(pid, sendPipeIdx, this.toKernelPtr(scratchOffset), PAGE);
          if (n <= 0) break;
          gotData = true;
          const mem = this.getKernelMem();
          chunks.push(mem.slice(scratchOffset, scratchOffset + n));
        }

        if (gotData) {
          // Wake any writer blocked filling this pipe (we just freed buffer).
          this.notifyPipeWritable(sendPipeIdx);
        }

        const writeOpen = pipeIsWriteOpen(pid, sendPipeIdx) === 1;
        if (writeOpen && !sawWriteOpen) sawWriteOpen = true;

        if (sawWriteOpen && !writeOpen && !gotData) {
          // Server closed its end and we drained all bytes.
          const raw = concatChunksLocal(chunks);
          finish(parseRawHttpResponse(raw));
          return;
        }

        // Re-arm. Tight when bytes were flowing, slower poll otherwise.
        setTimeout(tick, gotData ? 0 : 2);
      };

      tick();
    });
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
    // pid=0 to the legacy kernel pipe APIs as a compatibility sentinel.
    // The APIs now always resolve pipe indexes through the global pipe table,
    // which lets any process sharing the listener accept this connection.
    const GLOBAL_PIPE_PID = 0;
    const pipeWrite = this.kernelInstance!.exports.kernel_pipe_write as
      (pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number) => number;
    const pipeRead = this.kernelInstance!.exports.kernel_pipe_read as
      (pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number) => number;
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
        const written = pipeWrite(GLOBAL_PIPE_PID, recvPipeIdx, this.toKernelPtr(scratchOffset), toWrite);
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
        const readN = pipeRead(GLOBAL_PIPE_PID, sendPipeIdx, this.toKernelPtr(scratchOffset), 65536);
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
   * Handle an incoming virtual-network TCP connection by injecting it into the
   * kernel's normal AF_INET accept path and pumping bytes between the virtual
   * stream peer and the accepted socket's global pipe pair.
   */
  private handleIncomingVirtualTcpConnection(
    pid: number,
    listenerFd: number,
    peer: TcpConnectionPeer,
    remote: NetworkAddress,
  ): number {
    if (!this.kernelInstance) return 107; // ENOTCONN

    const injectConnection = this.kernelInstance.exports.kernel_inject_connection as
      (pid: number, listenerFd: number, a: number, b: number, c: number, d: number, port: number) => number;
    const recvPipeIdx = injectConnection(
      pid,
      listenerFd,
      remote.addr[0] ?? 0,
      remote.addr[1] ?? 0,
      remote.addr[2] ?? 0,
      remote.addr[3] ?? 0,
      remote.port,
    );
    if (recvPipeIdx < 0) return -recvPipeIdx;

    const sendPipeIdx = recvPipeIdx + 1;
    const GLOBAL_PIPE_PID = 0;
    const pipeWrite = this.kernelInstance.exports.kernel_pipe_write as
      (pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number) => number;
    const pipeRead = this.kernelInstance.exports.kernel_pipe_read as
      (pid: number, pipeIdx: number, bufPtr: KernelPointer, bufLen: number) => number;
    const pipeCloseWrite = this.kernelInstance.exports.kernel_pipe_close_write as
      (pid: number, pipeIdx: number) => number;
    const pipeCloseRead = this.kernelInstance.exports.kernel_pipe_close_read as
      (pid: number, pipeIdx: number) => number;
    const pipeIsWriteOpen = this.kernelInstance.exports.kernel_pipe_is_write_open as
      (pid: number, pipeIdx: number) => number;

    let cleaned = false;
    let pumpPending = false;
    const scratchOffset = this.tcpScratchOffset;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      pipeCloseWrite(GLOBAL_PIPE_PID, recvPipeIdx);
      pipeCloseRead(GLOBAL_PIPE_PID, sendPipeIdx);
      peer.close();
      this.notifyPipeReadable(recvPipeIdx, pid);
      this.notifyPipeWritable(sendPipeIdx);
      this.scheduleWakeBlockedRetries();
    };

    const drainInbound = () => {
      for (;;) {
        let data: Uint8Array;
        try {
          data = peer.recv(65536, 0);
        } catch (e: any) {
          if (e?.errno === 11) return;
          cleanup();
          return;
        }
        if (data.length === 0) {
          pipeCloseWrite(GLOBAL_PIPE_PID, recvPipeIdx);
          this.notifyPipeReadable(recvPipeIdx, pid);
          return;
        }
        const written = this.writePipeChunked(pipeWrite, GLOBAL_PIPE_PID, recvPipeIdx, data);
        if (written < data.length) {
          // The pipe is full. A later pump tick will retry once the guest reads.
          return;
        }
        this.notifyPipeReadable(recvPipeIdx, pid);
      }
    };

    const drainOutbound = () => {
      const mem = this.getKernelMem();
      for (;;) {
        const n = pipeRead(GLOBAL_PIPE_PID, sendPipeIdx, this.toKernelPtr(scratchOffset), 65536);
        if (n <= 0) break;
        try {
          peer.send(mem.slice(scratchOffset, scratchOffset + n), 0);
        } catch {
          cleanup();
          return;
        }
        this.notifyPipeWritable(sendPipeIdx);
      }
    };

    const pump = () => {
      pumpPending = false;
      if (cleaned) {
        return;
      }
      if (!this.processes.has(pid)) {
        drainOutbound();
        peer.shutdown(1);
        cleanup();
        return;
      }
      drainInbound();
      drainOutbound();
      if (pipeIsWriteOpen(GLOBAL_PIPE_PID, sendPipeIdx) === 0) {
        peer.shutdown(1);
        cleanup();
        return;
      }
      schedulePump(2);
    };

    const schedulePump = (delayMs = 0) => {
      if (pumpPending || cleaned) return;
      pumpPending = true;
      setTimeout(pump, delayMs);
    };

    this.scheduleWakeBlockedRetries();
    schedulePump();
    return 0;
  }

  /**
   * Inject a routed virtual-network UDP datagram into the kernel's normal
   * SOCK_DGRAM receive queue for the destination process.
   */
  private injectUdpDatagram(pid: number, datagram: UdpDatagram): number {
    if (!this.kernelInstance || !this.processes.has(pid)) return 113; // EHOSTUNREACH
    if (datagram.data.length > 65536) return 90; // EMSGSIZE

    const injectDatagram = this.kernelInstance.exports.kernel_inject_datagram as
      ((pid: number,
        dstA: number, dstB: number, dstC: number, dstD: number, dstPort: number,
        srcA: number, srcB: number, srcC: number, srcD: number, srcPort: number,
        dataPtr: KernelPointer, dataLen: number) => number) | undefined;
    if (!injectDatagram) return 38; // ENOSYS

    const scratchOffset = this.tcpScratchOffset;
    const mem = this.getKernelMem();
    mem.set(datagram.data, scratchOffset);
    const result = injectDatagram(
      pid,
      datagram.dstAddr[0] ?? 0,
      datagram.dstAddr[1] ?? 0,
      datagram.dstAddr[2] ?? 0,
      datagram.dstAddr[3] ?? 0,
      datagram.dstPort,
      datagram.srcAddr[0] ?? 0,
      datagram.srcAddr[1] ?? 0,
      datagram.srcAddr[2] ?? 0,
      datagram.srcAddr[3] ?? 0,
      datagram.srcPort,
      this.toKernelPtr(scratchOffset),
      datagram.data.length,
    );
    if (result < 0) return -result;
    this.scheduleWakeBlockedRetries();
    return 0;
  }

  private cleanupUdpBindings(pid: number): void {
    if (!this.io.network?.unbindUdp) return;
    const prefix = `${pid}:`;
    for (const key of Array.from(this.udpBindings)) {
      if (!key.startsWith(prefix)) continue;
      this.io.network.unbindUdp(key);
      this.udpBindings.delete(key);
    }
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
        this.io.network?.closeTcpListener?.(key);
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
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: KernelPointer, pid: number) => number;
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
      try { handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid); } finally { this.currentHandlePid = 0; }

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
      try { handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid); } finally { this.currentHandlePid = 0; }

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
      try { handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid); } finally { this.currentHandlePid = 0; }

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
    try { handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid); } finally { this.currentHandlePid = 0; }

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

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: KernelPointer, pid: number) => number;
    this.currentHandlePid = channel.pid;
    this.bindKernelTidForChannel(channel);
    try {
      handleChannel(this.toKernelPtr(this.scratchOffset), channel.pid);
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
    this.ensureProcessMemoryCovers(channel.pid, channel.memory, SYS_MMAP, addr, [0, size, 3, 0x22, -1, 0]);

    // Transfer segment data from kernel to process memory via read_chunk
    const readChunk = this.kernelInstance!.exports.kernel_ipc_shm_read_chunk as
      (shmid: number, offset: number, outPtr: KernelPointer, maxLen: number) => number;
    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const chunkSize = CH_DATA_SIZE;
    const chunkPtr = this.scratchOffset + CH_DATA;
    let transferred = 0;
    while (transferred < size) {
      const remaining = size - transferred;
      const toRead = Math.min(remaining, chunkSize);
      const nRead = readChunk(shmid, transferred, this.toKernelPtr(chunkPtr), toRead);
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
    const writeChunk = this.kernelInstance!.exports.kernel_ipc_shm_write_chunk as
      (shmid: number, offset: number, dataPtr: KernelPointer, dataLen: number) => number;
    const processMem = new Uint8Array(channel.memory.buffer);
    const kernelMem = this.getKernelMem();
    const chunkSize = CH_DATA_SIZE;
    const chunkPtr = this.scratchOffset + CH_DATA;
    let transferred = 0;
    while (transferred < mapping.size) {
      const remaining = mapping.size - transferred;
      const toWrite = Math.min(remaining, chunkSize);
      kernelMem.set(processMem.subarray(addr + transferred, addr + transferred + toWrite), chunkPtr);
      const nWritten = writeChunk(mapping.segId, transferred, this.toKernelPtr(chunkPtr), toWrite);
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
      .kernel_mq_drain_notification as ((outPtr: KernelPointer) => number) | undefined;
    if (!drain) return;

    // Use kernel scratch as output buffer for (pid: u32, signo: u32)
    const outOffset = this.scratchOffset;
    const hasPending = drain(this.toKernelPtr(outOffset));
    if (hasPending) {
      const dv = new DataView(this.kernelMemory!.buffer, outOffset);
      const pid = dv.getUint32(0, true);
      const signo = dv.getUint32(4, true);
      if (signo > 0) {
        this.sendSignalToProcess(pid, signo);
      }
    }
  }

  // ---- DRI/KMS presenter wiring ------------------------------------------

  /** Live `/dev/dri/renderD128` GBM bos. Pixel storage for a bound bo
   *  lives in the owning process's wasm Memory at the binding range;
   *  consumers read pixels by projecting `[addr, addr+len)` onto the
   *  SAB returned by `getProcessMemory(pid)`. */
  get bos() {
    return this.kernel.bos;
  }

  get gl() {
    return this.kernel.gl;
  }

  get kms() {
    return this.kernel.kms;
  }

  /** Register an `OffscreenCanvas` (and optional stats SAB) as the
   *  scanout target for a CRTC. Starts the vblank pump on first
   *  attach.
   *
   *  `opts.mode` selects how the canvas is painted:
   *  - `"auto"` (default): the pump never grabs a 2D context. If the
   *    DRM-master pid later calls `eglCreateContext`, the GL bridge's
   *    auto-attach path claims the canvas for WebGL2 and the user
   *    program paints directly. Slots 5/6 (commit count, last µs)
   *    still tick from kernel-side PAGE_FLIP state.
   *  - `"2d"`: legacy CPU-blit path. The pump eagerly grabs 2D here
   *    and copies the kernel's scanout BO into the canvas each frame.
   *    Used by demos that render into the FB via memcpy rather than GL.
   *  - `"webgl2"`: marks the canvas as GL-owned up front. Pump never
   *    blits. Same effect as auto + a later `markKmsCanvasGlOwned`,
   *    but spares the GL bridge from racing the pump's 2D acquisition. */
  attachKmsCanvas(
    crtc_id: number,
    canvas: OffscreenCanvas,
    statsSab?: SharedArrayBuffer,
    opts?: { mode?: "auto" | "2d" | "webgl2" },
  ): void {
    this.kmsCanvases.set(crtc_id, canvas);
    if (statsSab) this.kmsStatsViews.set(crtc_id, new Int32Array(statsSab));
    const mode = opts?.mode ?? "auto";
    if (mode === "2d") {
      // Eagerly acquire 2D so the first tickVblank can blit without a
      // round-trip. If acquisition fails (some other path already
      // claimed the canvas), the pump will skip the blit branch and
      // slots 0/1/4 stay 0 — better than throwing.
      const ctx = canvas.getContext("2d");
      if (ctx) {
        this.kmsContexts.set(crtc_id, ctx);
        this.kmsContextMode.set(crtc_id, "2d");
      }
    } else if (mode === "webgl2") {
      this.kmsContextMode.set(crtc_id, "webgl2");
    }
    this.startVblankPump();
  }

  /** Attach a stats SAB for a CRTC without registering a scanout canvas.
   *  Slots 5/6 (kernel commit count + last-frame µs) are populated by
   *  the vblank pump regardless of whether the same crtc owns a blit
   *  target. Used by demos that render through the GL bridge while
   *  still driving real `drmModePageFlip` ioctls. */
  attachKmsStats(crtc_id: number, statsSab: SharedArrayBuffer): void {
    this.kmsStatsViews.set(crtc_id, new Int32Array(statsSab));
    this.startVblankPump();
  }

  private startVblankPump(): void {
    if (this.vblankTimer) return;
    this.vblankTimer = setInterval(() => this.tickVblank(), 1000 / 60);
    // Node only: prevent the pump from blocking process exit.
    (this.vblankTimer as { unref?: () => void }).unref?.();
  }

  private tickVblank(): void {
    const vblankFn = this.kernelInstance?.exports.kernel_vblank as
      (() => void) | undefined;
    vblankFn?.();
    // 2D-blit path. Runs only for CRTCs the embedder explicitly opted
    // into `mode: "2d"`. The pump never touches the canvas in "auto"
    // or "webgl2" mode — touching it with `getContext("2d")` would
    // claim the canvas for life and break the later WebGL2 attach
    // (an OffscreenCanvas can only hold one context type ever).
    for (const [crtc_id, canvas] of this.kmsCanvases) {
      if (this.kmsContextMode.get(crtc_id) !== "2d") continue;
      const fb = this.kernel.kms.currentFb(crtc_id);
      if (!fb) continue;
      const pixels = this.kernel.kms.scanoutBytes(crtc_id);
      if (!pixels) continue;
      const ctx = this.kmsContexts.get(crtc_id);
      if (!ctx) continue;
      if (canvas.width !== fb.width || canvas.height !== fb.height) {
        canvas.width = fb.width;
        canvas.height = fb.height;
      }
      // bo bytes are opaque RGBA8888 — one memcpy into a cached
      // Uint8ClampedArray is all the pump owes the canvas.
      const blitStart = performance.now();
      const need = fb.width * fb.height * 4;
      let scratch = this.kmsScratchBytes.get(crtc_id);
      if (!scratch || scratch.byteLength !== need) {
        scratch = new Uint8ClampedArray(new ArrayBuffer(need)) as Uint8ClampedArray<ArrayBuffer>;
        this.kmsScratchBytes.set(crtc_id, scratch);
      }
      scratch.set(pixels);
      ctx.putImageData(new ImageData(scratch, fb.width, fb.height), 0, 0);
      const blitUs = ((performance.now() - blitStart) * 1000) | 0;
      const stats = this.kmsStatsViews.get(crtc_id);
      if (stats) {
        Atomics.add(stats, 0, 1);
        Atomics.store(stats, 1, performance.now() | 0);
        Atomics.store(stats, 4, blitUs);
      }
    }

    // Slots 2/3 (scanout width/height) and 5/6 (kernel-side PAGE_FLIP
    // commit count, last frame µs) are populated for every CRTC with
    // a stats SAB, regardless of the canvas-owner mode. Slots 2/3
    // sourced from the kernel's current FB so embedders (e.g. the
    // Modeset React pane) can detect "scanout active" without
    // depending on the 2D-blit path. Slots 5/6 reflect kernel-side
    // ioctls — independent of the 60 Hz blit loop above.
    if (this.kmsStatsViews.size > 0) {
      const exports = this.kernelInstance?.exports as
        | { kernel_kms_commit_count?: (id: number) => bigint;
            kernel_kms_last_frame_us?: (id: number) => bigint }
        | undefined;
      for (const [crtc_id, stats] of this.kmsStatsViews) {
        const fb = this.kernel.kms.currentFb(crtc_id);
        if (fb) {
          Atomics.store(stats, 2, fb.width);
          Atomics.store(stats, 3, fb.height);
        }
        if (stats.length < 7) continue;
        const commits = exports?.kernel_kms_commit_count?.(crtc_id) ?? 0n;
        const lastUs = exports?.kernel_kms_last_frame_us?.(crtc_id) ?? 0n;
        Atomics.store(stats, 5, Number(commits & 0x7fffffffn));
        Atomics.store(stats, 6, Number(lastUs & 0x7fffffffn));
      }
    }
  }
}
