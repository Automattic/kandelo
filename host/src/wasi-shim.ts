/**
 * WASI Preview 1 compatibility shim.
 *
 * Translates wasi_snapshot_preview1 imports into channel-based syscalls
 * that the existing kernel understands. This allows pre-built WASI binaries
 * to run on the wasm-posix-kernel without recompilation.
 *
 * Only supports WASI modules that import memory (--import-memory).
 *
 * This module is dynamically imported by `worker-main.ts` only when
 * `isWasiModule()` (in `./wasi-detect.ts`) returns true. Workers that
 * load a native channel-syscall binary never pay this file's parse
 * + JIT cost. Don't add eager imports of it from the worker
 * bootstrap path.
 */

// --- Channel layout (must match crates/shared/src/lib.rs + glue/channel_syscall.c) ---
const CH_STATUS = 0;
const CH_SYSCALL = 4;
const CH_ARGS = 8;
const CH_ARG_SIZE = 8;  // each arg is i64 (8 bytes)
const CH_RETURN = 56;
const CH_ERRNO = 64;
const CH_DATA = 72;
const CH_DATA_SIZE = 65536;

// Channel status values
const CH_IDLE = 0;
const CH_PENDING = 1;

// --- Syscall numbers (from musl/arch/wasm32posix/bits/syscall.h.in) ---
const SYS_CLOSE = 2;
const SYS_READ = 3;
const SYS_WRITE = 4;
const SYS_LSEEK = 5;
const SYS_FSTAT = 6;
const SYS_FCNTL = 10;
const SYS_GETPID = 28;
const SYS_EXIT = 34;
const SYS_KILL = 35;
const SYS_CLOCK_GETTIME = 40;
const SYS_POLL = 60;
const SYS_SENDTO = 62;
const SYS_RECVFROM = 63;
const SYS_PREAD = 64;
const SYS_PWRITE = 65;
const SYS_OPENAT = 69;
const SYS_FTRUNCATE = 79;
const SYS_FSYNC = 80;
const SYS_WRITEV = 81;
const SYS_READV = 82;
const SYS_FDATASYNC = 86;
const SYS_FSTATAT = 93;
const SYS_UNLINKAT = 94;
const SYS_MKDIRAT = 95;
const SYS_RENAMEAT = 96;
const SYS_LINKAT = 100;
const SYS_SYMLINKAT = 101;
const SYS_READLINKAT = 102;
const SYS_GETRANDOM = 120;
const SYS_GETDENTS64 = 122;
const SYS_CLOCK_GETRES = 123;
const SYS_UTIMENSAT = 125;
const SYS_SCHED_YIELD = 229;
const SYS_FALLOCATE = 308;
const SYS_DUP2 = 8;
const SYS_SHUTDOWN = 57;

// --- POSIX flags (from crates/shared/src/lib.rs) ---
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;
const O_NONBLOCK = 0o4000;
const O_DIRECTORY = 0o200000;
const O_NOFOLLOW = 0o400000;

const AT_FDCWD = -100;
const AT_SYMLINK_NOFOLLOW = 0x100;
const AT_REMOVEDIR = 0x200;

const F_GETFL = 3;
const F_SETFL = 4;

// SEEK constants (POSIX)
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

// S_IFMT mode bits
const S_IFDIR = 0o040000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFREG = 0o100000;
const S_IFIFO = 0o010000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;
const S_IFMT = 0o170000;

// Stat struct size written by kernel
const WASM_STAT_SIZE = 88;

// --- WASI errno values ---
const WASI_ESUCCESS = 0;
const WASI_E2BIG = 1;
const WASI_EACCES = 2;
const WASI_EADDRINUSE = 3;
const WASI_EADDRNOTAVAIL = 4;
const WASI_EAFNOSUPPORT = 5;
const WASI_EAGAIN = 6;
const WASI_EALREADY = 7;
const WASI_EBADF = 8;
const WASI_EBADMSG = 9;
const WASI_EBUSY = 10;
const WASI_ECANCELED = 11;
const WASI_ECHILD = 12;
const WASI_ECONNABORTED = 13;
const WASI_ECONNREFUSED = 14;
const WASI_ECONNRESET = 15;
const WASI_EDEADLK = 16;
const WASI_EDESTADDRREQ = 17;
const WASI_EDOM = 18;
const WASI_EDQUOT = 19;
const WASI_EEXIST = 20;
const WASI_EFAULT = 21;
const WASI_EFBIG = 22;
const WASI_EHOSTUNREACH = 23;
const WASI_EIDRM = 24;
const WASI_EILSEQ = 25;
const WASI_EINPROGRESS = 26;
const WASI_EINTR = 27;
const WASI_EINVAL = 28;
const WASI_EIO = 29;
const WASI_EISCONN = 30;
const WASI_EISDIR = 31;
const WASI_ELOOP = 32;
const WASI_EMFILE = 33;
const WASI_EMLINK = 34;
const WASI_EMSGSIZE = 35;
const WASI_EMULTIHOP = 36;
const WASI_ENAMETOOLONG = 37;
const WASI_ENETDOWN = 38;
const WASI_ENETRESET = 39;
const WASI_ENETUNREACH = 40;
const WASI_ENFILE = 41;
const WASI_ENOBUFS = 42;
const WASI_ENODEV = 43;
const WASI_ENOENT = 44;
const WASI_ENOEXEC = 45;
const WASI_ENOLCK = 46;
const WASI_ENOLINK = 47;
const WASI_ENOMEM = 48;
const WASI_ENOMSG = 49;
const WASI_ENOPROTOOPT = 50;
const WASI_ENOSPC = 51;
const WASI_ENOSYS = 52;
const WASI_ENOTCONN = 53;
const WASI_ENOTDIR = 54;
const WASI_ENOTEMPTY = 55;
const WASI_ENOTRECOVERABLE = 56;
const WASI_ENOTSOCK = 57;
const WASI_ENOTSUP = 58;
const WASI_ENOTTY = 59;
const WASI_ENXIO = 60;
const WASI_EOVERFLOW = 61;
const WASI_EOWNERDEAD = 62;
const WASI_EPERM = 63;
const WASI_EPIPE = 64;
const WASI_EPROTO = 65;
const WASI_EPROTONOSUPPORT = 66;
const WASI_EPROTOTYPE = 67;
const WASI_ERANGE = 68;
const WASI_EROFS = 69;
const WASI_ESPIPE = 70;
const WASI_ESRCH = 71;
const WASI_ESTALE = 72;
const WASI_ETIMEDOUT = 73;
const WASI_ETXTBSY = 74;
const WASI_EXDEV = 75;
const WASI_ENOTCAPABLE = 76;

// Linux (musl) errno → WASI errno
const linuxToWasi: Map<number, number> = new Map([
  [0, WASI_ESUCCESS],
  [1, WASI_EPERM],        // EPERM
  [2, WASI_ENOENT],       // ENOENT
  [3, WASI_ESRCH],        // ESRCH
  [4, WASI_EINTR],        // EINTR
  [5, WASI_EIO],          // EIO
  [6, WASI_ENXIO],        // ENXIO
  [7, WASI_E2BIG],        // E2BIG
  [8, WASI_ENOEXEC],      // ENOEXEC
  [9, WASI_EBADF],        // EBADF
  [10, WASI_ECHILD],      // ECHILD
  [11, WASI_EAGAIN],      // EAGAIN / EWOULDBLOCK
  [12, WASI_ENOMEM],      // ENOMEM
  [13, WASI_EACCES],      // EACCES
  [14, WASI_EFAULT],      // EFAULT
  [16, WASI_EBUSY],       // EBUSY
  [17, WASI_EEXIST],      // EEXIST
  [18, WASI_EXDEV],       // EXDEV
  [19, WASI_ENODEV],      // ENODEV
  [20, WASI_ENOTDIR],     // ENOTDIR
  [21, WASI_EISDIR],      // EISDIR
  [22, WASI_EINVAL],      // EINVAL
  [23, WASI_ENFILE],      // ENFILE
  [24, WASI_EMFILE],      // EMFILE
  [25, WASI_ENOTTY],      // ENOTTY
  [26, WASI_ETXTBSY],     // ETXTBSY
  [27, WASI_EFBIG],       // EFBIG
  [28, WASI_ENOSPC],      // ENOSPC
  [29, WASI_ESPIPE],      // ESPIPE
  [30, WASI_EROFS],       // EROFS
  [31, WASI_EMLINK],      // EMLINK
  [32, WASI_EPIPE],       // EPIPE
  [33, WASI_EDOM],        // EDOM
  [34, WASI_ERANGE],      // ERANGE
  [35, WASI_EDEADLK],     // EDEADLK
  [36, WASI_ENAMETOOLONG], // ENAMETOOLONG
  [37, WASI_ENOLCK],      // ENOLCK
  [38, WASI_ENOSYS],      // ENOSYS
  [39, WASI_ENOTEMPTY],   // ENOTEMPTY
  [40, WASI_ELOOP],       // ELOOP
  [42, WASI_ENOMSG],      // ENOMSG
  [43, WASI_EIDRM],       // EIDRM
  [60, WASI_ENOTSUP],     // ENOSTR → ENOTSUP (no WASI equivalent)
  [61, WASI_ENOTSUP],     // ENODATA → ENOTSUP (no WASI equivalent)
  [62, WASI_ETIMEDOUT],   // ETIME → ETIMEDOUT (no WASI equivalent)
  [67, WASI_ENOLINK],     // ENOLINK
  [71, WASI_EPROTO],      // EPROTO
  [72, WASI_EMULTIHOP],   // EMULTIHOP
  [74, WASI_EBADMSG],     // EBADMSG
  [75, WASI_EOVERFLOW],   // EOVERFLOW
  [84, WASI_EILSEQ],      // EILSEQ
  [88, WASI_ENOTSOCK],    // ENOTSOCK
  [89, WASI_EDESTADDRREQ], // EDESTADDRREQ
  [90, WASI_EMSGSIZE],    // EMSGSIZE
  [91, WASI_EPROTOTYPE],  // EPROTOTYPE
  [92, WASI_ENOPROTOOPT], // ENOPROTOOPT
  [93, WASI_EPROTONOSUPPORT], // EPROTONOSUPPORT
  [95, WASI_ENOTSUP],     // EOPNOTSUPP
  [97, WASI_EAFNOSUPPORT], // EAFNOSUPPORT
  [98, WASI_EADDRINUSE],  // EADDRINUSE
  [99, WASI_EADDRNOTAVAIL], // EADDRNOTAVAIL
  [100, WASI_ENETDOWN],   // ENETDOWN
  [101, WASI_ENETUNREACH], // ENETUNREACH
  [102, WASI_ENETRESET],  // ENETRESET
  [103, WASI_ECONNABORTED], // ECONNABORTED
  [104, WASI_ECONNRESET], // ECONNRESET
  [105, WASI_ENOBUFS],    // ENOBUFS
  [106, WASI_EISCONN],    // EISCONN
  [107, WASI_ENOTCONN],   // ENOTCONN
  [110, WASI_ETIMEDOUT],  // ETIMEDOUT
  [111, WASI_ECONNREFUSED], // ECONNREFUSED
  [113, WASI_EHOSTUNREACH], // EHOSTUNREACH
  [114, WASI_EALREADY],   // EALREADY
  [115, WASI_EINPROGRESS], // EINPROGRESS
  [116, WASI_ESTALE],     // ESTALE
  [122, WASI_EDQUOT],     // EDQUOT
  [125, WASI_ECANCELED],  // ECANCELED
  [130, WASI_EOWNERDEAD], // EOWNERDEAD
  [131, WASI_ENOTRECOVERABLE], // ENOTRECOVERABLE
]);

// WASI filetype enum values
const WASI_FILETYPE_UNKNOWN = 0;
const WASI_FILETYPE_BLOCK_DEVICE = 1;
const WASI_FILETYPE_CHARACTER_DEVICE = 2;
const WASI_FILETYPE_DIRECTORY = 3;
const WASI_FILETYPE_REGULAR_FILE = 4;
const WASI_FILETYPE_SOCKET_DGRAM = 5;
const WASI_FILETYPE_SOCKET_STREAM = 6;
const WASI_FILETYPE_SYMBOLIC_LINK = 7;

// WASI clock IDs
const WASI_CLOCK_REALTIME = 0;
const WASI_CLOCK_MONOTONIC = 1;
const WASI_CLOCK_PROCESS_CPUTIME = 2;
const WASI_CLOCK_THREAD_CPUTIME = 3;

// Linux CLOCK_* IDs (happen to match WASI for 0-3)
const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;
const CLOCK_PROCESS_CPUTIME_ID = 2;
const CLOCK_THREAD_CPUTIME_ID = 3;

// WASI whence values — DIFFERENT from POSIX!
const WASI_WHENCE_SET = 0;
const WASI_WHENCE_CUR = 1;
const WASI_WHENCE_END = 2;

// WASI oflags
const WASI_O_CREAT = 1;
const WASI_O_DIRECTORY = 2;
const WASI_O_EXCL = 4;
const WASI_O_TRUNC = 8;

// WASI fdflags
const WASI_FDFLAG_APPEND = 1;
const WASI_FDFLAG_DSYNC = 2;
const WASI_FDFLAG_NONBLOCK = 4;
const WASI_FDFLAG_RSYNC = 8;
const WASI_FDFLAG_SYNC = 16;

// WASI lookupflags
const WASI_LOOKUP_SYMLINK_FOLLOW = 1;

// WASI subscription/event tag types (for poll_oneoff)
const WASI_EVENTTYPE_CLOCK = 0;
const WASI_EVENTTYPE_FD_READ = 1;
const WASI_EVENTTYPE_FD_WRITE = 2;

// WASI rights (we grant all rights)
const WASI_RIGHTS_ALL = BigInt("0x1FFFFFFF");

// WASI prestat type
const WASI_PREOPENTYPE_DIR = 0;

// Poll events
const POLLIN = 1;
const POLLOUT = 4;
const POLLERR = 8;
const POLLHUP = 16;

function translateLinuxErrno(linuxErrno: number): number {
  return linuxToWasi.get(linuxErrno) ?? WASI_EIO;
}

function modeToFiletype(mode: number): number {
  switch (mode & S_IFMT) {
    case S_IFBLK: return WASI_FILETYPE_BLOCK_DEVICE;
    case S_IFCHR: return WASI_FILETYPE_CHARACTER_DEVICE;
    case S_IFDIR: return WASI_FILETYPE_DIRECTORY;
    case S_IFREG: return WASI_FILETYPE_REGULAR_FILE;
    case S_IFLNK: return WASI_FILETYPE_SYMBOLIC_LINK;
    case S_IFSOCK: return WASI_FILETYPE_SOCKET_STREAM;
    case S_IFIFO: return WASI_FILETYPE_CHARACTER_DEVICE; // FIFO → char device (closest)
    default: return WASI_FILETYPE_UNKNOWN;
  }
}

function wasiWhenceToPosix(wasiWhence: number): number {
  // WASI and POSIX happen to use the same numbering for whence
  switch (wasiWhence) {
    case WASI_WHENCE_SET: return SEEK_SET;
    case WASI_WHENCE_CUR: return SEEK_CUR;
    case WASI_WHENCE_END: return SEEK_END;
    default: return SEEK_SET;
  }
}

function wasiClockToPosix(wasiClock: number): number {
  switch (wasiClock) {
    case WASI_CLOCK_REALTIME: return CLOCK_REALTIME;
    case WASI_CLOCK_MONOTONIC: return CLOCK_MONOTONIC;
    case WASI_CLOCK_PROCESS_CPUTIME: return CLOCK_PROCESS_CPUTIME_ID;
    case WASI_CLOCK_THREAD_CPUTIME: return CLOCK_THREAD_CPUTIME_ID;
    default: return CLOCK_REALTIME;
  }
}

function wasiOflagsToPosix(oflags: number, fdflags: number): number {
  let flags = 0;
  if (oflags & WASI_O_CREAT) flags |= O_CREAT;
  if (oflags & WASI_O_DIRECTORY) flags |= O_DIRECTORY;
  if (oflags & WASI_O_EXCL) flags |= O_EXCL;
  if (oflags & WASI_O_TRUNC) flags |= O_TRUNC;
  if (fdflags & WASI_FDFLAG_APPEND) flags |= O_APPEND;
  if (fdflags & WASI_FDFLAG_NONBLOCK) flags |= O_NONBLOCK;
  return flags;
}

function posixFlagToWasiFdflags(flags: number): number {
  let fdflags = 0;
  if (flags & O_APPEND) fdflags |= WASI_FDFLAG_APPEND;
  if (flags & O_NONBLOCK) fdflags |= WASI_FDFLAG_NONBLOCK;
  return fdflags;
}

/**
 * Exit signal used by proc_exit to abort execution immediately.
 */
class WasiExit extends Error {
  code: number;
  constructor(code: number) {
    super(`WASI exit: ${code}`);
    this.code = code;
  }
}

export { WasiExit };

/**
 * WASI Preview 1 shim that translates WASI calls into channel-based syscalls.
 */
export class WasiShim {
  private memory: WebAssembly.Memory;
  private channelOffset: number;
  private argv: string[];
  private env: string[];
  private preopens: Map<number, string> = new Map();
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(
    memory: WebAssembly.Memory,
    channelOffset: number,
    argv: string[],
    env: string[],
  ) {
    this.memory = memory;
    this.channelOffset = channelOffset;
    this.argv = argv;
    this.env = env;
  }

  /** Open preopened directories via syscall. Call after kernel registration. */
  init(): void {
    // Open "/" as fd 3 (the standard WASI preopened directory)
    const pathBytes = this.encoder.encode("/");
    const dataArea = this.channelOffset + CH_DATA;
    const view = new DataView(this.memory.buffer);

    // Write path to data area
    new Uint8Array(this.memory.buffer, dataArea, pathBytes.length).set(pathBytes);
    view.setUint8(dataArea + pathBytes.length, 0); // null terminate

    const { result, errno } = this.doSyscall(
      SYS_OPENAT,
      AT_FDCWD,
      dataArea,
      O_RDONLY | O_DIRECTORY,
      0,
      0,
      0,
    );

    if (errno === 0 && result >= 0) {
      this.preopens.set(result, "/");
    }
  }

  /** Issue a syscall through the channel and wait for the result. */
  private doSyscall(
    syscallNum: number,
    a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0,
  ): { result: number; errno: number } {
    const base = this.channelOffset;
    const view = new DataView(this.memory.buffer);

    view.setInt32(base + CH_SYSCALL, syscallNum, true);
    view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, BigInt(a0), true);
    view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(a1), true);
    view.setBigInt64(base + CH_ARGS + 2 * CH_ARG_SIZE, BigInt(a2), true);
    view.setBigInt64(base + CH_ARGS + 3 * CH_ARG_SIZE, BigInt(a3), true);
    view.setBigInt64(base + CH_ARGS + 4 * CH_ARG_SIZE, BigInt(a4), true);
    view.setBigInt64(base + CH_ARGS + 5 * CH_ARG_SIZE, BigInt(a5), true);

    const i32 = new Int32Array(this.memory.buffer);
    const statusIdx = base / 4;

    Atomics.store(i32, statusIdx, CH_PENDING);
    Atomics.notify(i32, statusIdx, 1);

    // Block until kernel signals completion
    while (Atomics.wait(i32, statusIdx, CH_PENDING) === "ok") { /* */ }

    const result = Number(view.getBigInt64(base + CH_RETURN, true));
    const errno = view.getUint32(base + CH_ERRNO, true);

    // Reset to idle
    Atomics.store(i32, statusIdx, CH_IDLE);

    return { result, errno };
  }

  /** Get the channel data area address. */
  private get dataArea(): number {
    return this.channelOffset + CH_DATA;
  }

  /** Write a string to the data area and null-terminate it. Returns byte length (without null). */
  private writeStringToData(str: string, offset = 0): number {
    const bytes = this.encoder.encode(str);
    const addr = this.dataArea + offset;
    new Uint8Array(this.memory.buffer, addr, bytes.length + 1).set(bytes);
    new DataView(this.memory.buffer).setUint8(addr + bytes.length, 0);
    return bytes.length;
  }

  /**
   * Resolve a WASI path (relative to a preopened dirfd) to a kernel-ready
   * (dirfd, pathAddr) pair. Writes the path into the data area.
   */
  private resolvePath(
    dirfd: number,
    pathPtr: number,
    pathLen: number,
    dataOffset = 0,
  ): { kernelDirfd: number; pathAddr: number } {
    const pathBytes = new Uint8Array(this.memory.buffer, pathPtr, pathLen);
    const path = this.decoder.decode(pathBytes);
    const preopenPath = this.preopens.get(dirfd);

    let fullPath: string;
    if (preopenPath !== undefined) {
      // Resolve relative to preopened directory
      if (preopenPath === "/") {
        fullPath = path.startsWith("/") ? path : "/" + path;
      } else {
        fullPath = preopenPath + (path.startsWith("/") ? path : "/" + path);
      }
    } else {
      fullPath = path;
    }

    const addr = this.dataArea + dataOffset;
    const encoded = this.encoder.encode(fullPath);
    new Uint8Array(this.memory.buffer, addr, encoded.length + 1).set(encoded);
    new DataView(this.memory.buffer).setUint8(addr + encoded.length, 0);

    return { kernelDirfd: AT_FDCWD, pathAddr: addr };
  }

  /**
   * Read the kernel's WasmStat (88 bytes) from a data area offset and
   * write WASI filestat (64 bytes) to the module's memory.
   */
  private translateStat(statDataOffset: number, filestatPtr: number): void {
    const view = new DataView(this.memory.buffer);
    const base = this.dataArea + statDataOffset;

    // Read kernel WasmStat fields
    const dev = view.getBigUint64(base + 0, true);
    const ino = view.getBigUint64(base + 8, true);
    const mode = view.getUint32(base + 16, true);
    const nlink = view.getUint32(base + 20, true);
    const size = view.getBigInt64(base + 32, true);
    const atimSec = view.getBigInt64(base + 40, true);
    const atimNsec = view.getBigInt64(base + 48, true);
    const mtimSec = view.getBigInt64(base + 56, true);
    const mtimNsec = view.getBigInt64(base + 64, true);
    const ctimSec = view.getBigInt64(base + 72, true);
    const ctimNsec = view.getBigInt64(base + 80, true);

    // Write WASI filestat (64 bytes):
    // dev(u64) ino(u64) filetype(u8) + 7pad nlink(u64) size(u64) atim(u64) mtim(u64) ctim(u64)
    const p = filestatPtr;
    view.setBigUint64(p + 0, dev, true);
    view.setBigUint64(p + 8, ino, true);
    view.setUint8(p + 16, modeToFiletype(mode));
    // 7 bytes padding (17-23) — zero them
    for (let i = 17; i < 24; i++) view.setUint8(p + i, 0);
    view.setBigUint64(p + 24, BigInt(nlink), true);
    view.setBigUint64(p + 32, size < 0n ? 0n : BigInt(size), true);
    // WASI timestamps are in nanoseconds
    view.setBigUint64(p + 40, atimSec * 1000000000n + atimNsec, true);
    view.setBigUint64(p + 48, mtimSec * 1000000000n + mtimNsec, true);
    view.setBigUint64(p + 56, ctimSec * 1000000000n + ctimNsec, true);
  }

  /** Build the wasi_snapshot_preview1 import namespace. */
  getImports(): Record<string, Function> {
    return {
      args_get: this.args_get.bind(this),
      args_sizes_get: this.args_sizes_get.bind(this),
      environ_get: this.environ_get.bind(this),
      environ_sizes_get: this.environ_sizes_get.bind(this),
      fd_prestat_get: this.fd_prestat_get.bind(this),
      fd_prestat_dir_name: this.fd_prestat_dir_name.bind(this),
      fd_close: this.fd_close.bind(this),
      fd_read: this.fd_read.bind(this),
      fd_write: this.fd_write.bind(this),
      fd_pread: this.fd_pread.bind(this),
      fd_pwrite: this.fd_pwrite.bind(this),
      fd_seek: this.fd_seek.bind(this),
      fd_tell: this.fd_tell.bind(this),
      fd_sync: this.fd_sync.bind(this),
      fd_datasync: this.fd_datasync.bind(this),
      fd_fdstat_get: this.fd_fdstat_get.bind(this),
      fd_fdstat_set_flags: this.fd_fdstat_set_flags.bind(this),
      fd_fdstat_set_rights: this.fd_fdstat_set_rights.bind(this),
      fd_filestat_get: this.fd_filestat_get.bind(this),
      fd_filestat_set_size: this.fd_filestat_set_size.bind(this),
      fd_filestat_set_times: this.fd_filestat_set_times.bind(this),
      fd_allocate: this.fd_allocate.bind(this),
      fd_advise: this.fd_advise.bind(this),
      fd_readdir: this.fd_readdir.bind(this),
      fd_renumber: this.fd_renumber.bind(this),
      path_create_directory: this.path_create_directory.bind(this),
      path_unlink_file: this.path_unlink_file.bind(this),
      path_remove_directory: this.path_remove_directory.bind(this),
      path_rename: this.path_rename.bind(this),
      path_symlink: this.path_symlink.bind(this),
      path_readlink: this.path_readlink.bind(this),
      path_link: this.path_link.bind(this),
      path_open: this.path_open.bind(this),
      path_filestat_get: this.path_filestat_get.bind(this),
      path_filestat_set_times: this.path_filestat_set_times.bind(this),
      random_get: this.random_get.bind(this),
      clock_time_get: this.clock_time_get.bind(this),
      clock_res_get: this.clock_res_get.bind(this),
      proc_exit: this.proc_exit.bind(this),
      proc_raise: this.proc_raise.bind(this),
      sched_yield: this.sched_yield.bind(this),
      poll_oneoff: this.poll_oneoff.bind(this),
      sock_recv: this.sock_recv.bind(this),
      sock_send: this.sock_send.bind(this),
      sock_shutdown: this.sock_shutdown.bind(this),
      sock_accept: this.sock_accept.bind(this),
    };
  }

  // ---- Args/Environ (no syscall needed) ----

  args_get(argvPtrs: number, argvBuf: number): number {
    const view = new DataView(this.memory.buffer);
    const mem = new Uint8Array(this.memory.buffer);
    let bufOffset = argvBuf;
    for (let i = 0; i < this.argv.length; i++) {
      view.setUint32(argvPtrs + i * 4, bufOffset, true);
      const encoded = this.encoder.encode(this.argv[i]);
      mem.set(encoded, bufOffset);
      mem[bufOffset + encoded.length] = 0;
      bufOffset += encoded.length + 1;
    }
    return WASI_ESUCCESS;
  }

  args_sizes_get(argcOut: number, argvBufSizeOut: number): number {
    const view = new DataView(this.memory.buffer);
    view.setUint32(argcOut, this.argv.length, true);
    let totalSize = 0;
    for (const arg of this.argv) {
      totalSize += this.encoder.encode(arg).length + 1;
    }
    view.setUint32(argvBufSizeOut, totalSize, true);
    return WASI_ESUCCESS;
  }

  environ_get(environPtrs: number, environBuf: number): number {
    const view = new DataView(this.memory.buffer);
    const mem = new Uint8Array(this.memory.buffer);
    let bufOffset = environBuf;
    for (let i = 0; i < this.env.length; i++) {
      view.setUint32(environPtrs + i * 4, bufOffset, true);
      const encoded = this.encoder.encode(this.env[i]);
      mem.set(encoded, bufOffset);
      mem[bufOffset + encoded.length] = 0;
      bufOffset += encoded.length + 1;
    }
    return WASI_ESUCCESS;
  }

  environ_sizes_get(countOut: number, sizeOut: number): number {
    const view = new DataView(this.memory.buffer);
    view.setUint32(countOut, this.env.length, true);
    let totalSize = 0;
    for (const e of this.env) {
      totalSize += this.encoder.encode(e).length + 1;
    }
    view.setUint32(sizeOut, totalSize, true);
    return WASI_ESUCCESS;
  }

  // ---- Prestat ----

  fd_prestat_get(fd: number, prestatPtr: number): number {
    const path = this.preopens.get(fd);
    if (path === undefined) return WASI_EBADF;
    const view = new DataView(this.memory.buffer);
    view.setUint8(prestatPtr, WASI_PREOPENTYPE_DIR);
    view.setUint32(prestatPtr + 4, this.encoder.encode(path).length, true);
    return WASI_ESUCCESS;
  }

  fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
    const path = this.preopens.get(fd);
    if (path === undefined) return WASI_EBADF;
    const encoded = this.encoder.encode(path);
    const len = Math.min(encoded.length, pathLen);
    new Uint8Array(this.memory.buffer, pathPtr, len).set(encoded.subarray(0, len));
    return WASI_ESUCCESS;
  }

  // ---- FD operations ----

  fd_close(fd: number): number {
    const { errno } = this.doSyscall(SYS_CLOSE, fd);
    if (errno) return translateLinuxErrno(errno);
    this.preopens.delete(fd);
    return WASI_ESUCCESS;
  }

  fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadOut: number): number {
    // Build iovec array in data area for SYS_READV
    // The iovecs point into module memory which the kernel can read via pointer redirection
    const { result, errno } = this.doSyscall(SYS_READV, fd, iovsPtr, iovsLen);
    if (errno) return translateLinuxErrno(errno);
    const view = new DataView(this.memory.buffer);
    view.setUint32(nreadOut, result, true);
    return WASI_ESUCCESS;
  }

  fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenOut: number): number {
    const { result, errno } = this.doSyscall(SYS_WRITEV, fd, iovsPtr, iovsLen);
    if (errno) return translateLinuxErrno(errno);
    const view = new DataView(this.memory.buffer);
    view.setUint32(nwrittenOut, result, true);
    return WASI_ESUCCESS;
  }

  fd_pread(
    fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadOut: number,
  ): number {
    // pread expects a flat buffer, not iovecs. Read into data area then scatter.
    const view = new DataView(this.memory.buffer);
    const mem = new Uint8Array(this.memory.buffer);

    // Calculate total read size from iovecs
    let totalLen = 0;
    for (let i = 0; i < iovsLen; i++) {
      totalLen += view.getUint32(iovsPtr + i * 8 + 4, true);
    }
    totalLen = Math.min(totalLen, CH_DATA_SIZE - 256);

    const { result, errno } = this.doSyscall(
      SYS_PREAD, fd, this.dataArea, totalLen,
      Number(offset & 0xFFFFFFFFn),
      Number((offset >> 32n) & 0xFFFFFFFFn),
    );
    if (errno) return translateLinuxErrno(errno);

    // Scatter data from data area into iovecs
    let remaining = result;
    let srcOff = 0;
    for (let i = 0; i < iovsLen && remaining > 0; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const copyLen = Math.min(bufLen, remaining);
      mem.copyWithin(bufPtr, this.dataArea + srcOff, this.dataArea + srcOff + copyLen);
      srcOff += copyLen;
      remaining -= copyLen;
    }

    view.setUint32(nreadOut, result, true);
    return WASI_ESUCCESS;
  }

  fd_pwrite(
    fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenOut: number,
  ): number {
    const view = new DataView(this.memory.buffer);
    const mem = new Uint8Array(this.memory.buffer);

    // Gather iovec data into data area
    let totalLen = 0;
    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const copyLen = Math.min(bufLen, CH_DATA_SIZE - 256 - totalLen);
      mem.copyWithin(this.dataArea + totalLen, bufPtr, bufPtr + copyLen);
      totalLen += copyLen;
    }

    const { result, errno } = this.doSyscall(
      SYS_PWRITE, fd, this.dataArea, totalLen,
      Number(offset & 0xFFFFFFFFn),
      Number((offset >> 32n) & 0xFFFFFFFFn),
    );
    if (errno) return translateLinuxErrno(errno);

    view.setUint32(nwrittenOut, result, true);
    return WASI_ESUCCESS;
  }

  fd_seek(fd: number, offset: bigint, whence: number, newOffsetOut: number): number {
    const posixWhence = wasiWhenceToPosix(whence);
    // lseek on wasm32: args are fd, offset_lo, offset_hi, whence
    // But our SYS_LSEEK takes (fd, offset_lo, offset_hi, result_ptr, whence)
    // Actually checking the kernel — it uses a simpler 64-bit lseek
    const offsetNum = Number(offset);
    const { result, errno } = this.doSyscall(SYS_LSEEK, fd, offsetNum, posixWhence);
    if (errno) return translateLinuxErrno(errno);
    const view = new DataView(this.memory.buffer);
    view.setBigUint64(newOffsetOut, BigInt(result), true);
    return WASI_ESUCCESS;
  }

  fd_tell(fd: number, offsetOut: number): number {
    const { result, errno } = this.doSyscall(SYS_LSEEK, fd, 0, SEEK_CUR);
    if (errno) return translateLinuxErrno(errno);
    const view = new DataView(this.memory.buffer);
    view.setBigUint64(offsetOut, BigInt(result), true);
    return WASI_ESUCCESS;
  }

  fd_sync(fd: number): number {
    const { errno } = this.doSyscall(SYS_FSYNC, fd);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  fd_datasync(fd: number): number {
    const { errno } = this.doSyscall(SYS_FDATASYNC, fd);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  fd_fdstat_get(fd: number, fdstatPtr: number): number {
    const view = new DataView(this.memory.buffer);

    // Get file type via fstat
    const { errno: statErr } = this.doSyscall(SYS_FSTAT, fd, this.dataArea);
    if (statErr) return translateLinuxErrno(statErr);

    const mode = view.getUint32(this.dataArea + 16, true);
    const filetype = modeToFiletype(mode);

    // Get flags via fcntl
    const { result: flags, errno: fcntlErr } = this.doSyscall(SYS_FCNTL, fd, F_GETFL);
    const fdflags = fcntlErr ? 0 : posixFlagToWasiFdflags(flags);

    // WASI fdstat: filetype(u8) + pad(1) + fdflags(u16) + pad(4) + rights_base(u64) + rights_inheriting(u64) = 24 bytes
    view.setUint8(fdstatPtr, filetype);
    view.setUint8(fdstatPtr + 1, 0);
    view.setUint16(fdstatPtr + 2, fdflags, true);
    view.setUint32(fdstatPtr + 4, 0, true); // padding
    view.setBigUint64(fdstatPtr + 8, WASI_RIGHTS_ALL, true);
    view.setBigUint64(fdstatPtr + 16, WASI_RIGHTS_ALL, true);
    return WASI_ESUCCESS;
  }

  fd_fdstat_set_flags(fd: number, fdflags: number): number {
    let posixFlags = 0;
    if (fdflags & WASI_FDFLAG_APPEND) posixFlags |= O_APPEND;
    if (fdflags & WASI_FDFLAG_NONBLOCK) posixFlags |= O_NONBLOCK;
    const { errno } = this.doSyscall(SYS_FCNTL, fd, F_SETFL, posixFlags);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  fd_fdstat_set_rights(): number {
    return WASI_ESUCCESS; // no-op
  }

  fd_filestat_get(fd: number, filestatPtr: number): number {
    const { errno } = this.doSyscall(SYS_FSTAT, fd, this.dataArea);
    if (errno) return translateLinuxErrno(errno);
    this.translateStat(0, filestatPtr);
    return WASI_ESUCCESS;
  }

  fd_filestat_set_size(fd: number, size: bigint): number {
    const { errno } = this.doSyscall(SYS_FTRUNCATE, fd, Number(size));
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  fd_filestat_set_times(
    fd: number, atim: bigint, mtim: bigint, fstFlags: number,
  ): number {
    // fst_flags: bit 0 = set atim, bit 1 = atim_now, bit 2 = set mtim, bit 3 = mtim_now
    const UTIME_NOW = 0x3FFFFFFF;
    const UTIME_OMIT = 0x3FFFFFFE;

    const view = new DataView(this.memory.buffer);
    const tsAddr = this.dataArea;

    // atime timespec (16 bytes: i64 sec + i64 nsec)
    if (fstFlags & 2) {
      // ATIM_NOW
      view.setBigInt64(tsAddr + 0, 0n, true);
      view.setBigInt64(tsAddr + 8, BigInt(UTIME_NOW), true);
    } else if (fstFlags & 1) {
      // Set ATIM
      view.setBigInt64(tsAddr + 0, atim / 1000000000n, true);
      view.setBigInt64(tsAddr + 8, atim % 1000000000n, true);
    } else {
      view.setBigInt64(tsAddr + 0, 0n, true);
      view.setBigInt64(tsAddr + 8, BigInt(UTIME_OMIT), true);
    }

    // mtime timespec
    if (fstFlags & 8) {
      view.setBigInt64(tsAddr + 16, 0n, true);
      view.setBigInt64(tsAddr + 24, BigInt(UTIME_NOW), true);
    } else if (fstFlags & 4) {
      view.setBigInt64(tsAddr + 16, mtim / 1000000000n, true);
      view.setBigInt64(tsAddr + 24, mtim % 1000000000n, true);
    } else {
      view.setBigInt64(tsAddr + 16, 0n, true);
      view.setBigInt64(tsAddr + 24, BigInt(UTIME_OMIT), true);
    }

    // utimensat(AT_FDCWD, NULL, times, 0) — fd variant uses empty path
    // Actually: use fd directly via utimensat with AT_EMPTY_PATH
    // Our kernel's utimensat: (dirfd, pathname, times, flags)
    // For fd-based: pass fd as dirfd, null path, AT_EMPTY_PATH
    // Simpler: just pass the fd and empty path
    const emptyPathAddr = tsAddr + 32;
    view.setUint8(emptyPathAddr, 0); // empty string
    const { errno } = this.doSyscall(SYS_UTIMENSAT, fd, emptyPathAddr, tsAddr, 0);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  fd_allocate(fd: number, offset: bigint, len: bigint): number {
    const { errno } = this.doSyscall(
      SYS_FALLOCATE, fd, Number(offset), Number(len),
    );
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  fd_advise(): number {
    return WASI_ESUCCESS; // no-op
  }

  fd_readdir(
    fd: number, buf: number, bufLen: number, cookie: bigint, sizeOut: number,
  ): number {
    const view = new DataView(this.memory.buffer);
    const mem = new Uint8Array(this.memory.buffer);

    // Use getdents64 to read directory entries into data area
    const maxRead = Math.min(CH_DATA_SIZE - 256, 32768);
    const { result: bytesRead, errno } = this.doSyscall(
      SYS_GETDENTS64, fd, this.dataArea, maxRead,
    );
    if (errno) return translateLinuxErrno(errno);

    // Parse Linux dirent64 entries and write WASI dirents
    // Linux dirent64: d_ino(8) d_off(8) d_reclen(2) d_type(1) d_name(...)
    // WASI dirent: d_next(8) d_ino(8) d_namlen(4) d_type(1) + 3pad = 24 bytes + name
    let srcOff = 0;
    let dstOff = 0;
    let entryIdx = BigInt(0);

    while (srcOff < bytesRead && dstOff < bufLen) {
      const entBase = this.dataArea + srcOff;
      const dIno = view.getBigUint64(entBase, true);
      const dReclen = view.getUint16(entBase + 16, true);
      const dType = view.getUint8(entBase + 18);

      // Read name (null-terminated starting at offset 19)
      let nameEnd = entBase + 19;
      while (nameEnd < entBase + dReclen && view.getUint8(nameEnd) !== 0) nameEnd++;
      const nameLen = nameEnd - (entBase + 19);

      entryIdx++;
      if (entryIdx <= cookie) {
        srcOff += dReclen;
        continue;
      }

      // Write WASI dirent header (24 bytes)
      const headerSize = 24;
      if (dstOff + headerSize > bufLen) break;

      // Convert Linux d_type to WASI filetype
      let wasiType = WASI_FILETYPE_UNKNOWN;
      switch (dType) {
        case 1: wasiType = WASI_FILETYPE_CHARACTER_DEVICE; break; // DT_CHR (mapped from FIFO, close enough)
        case 2: wasiType = WASI_FILETYPE_CHARACTER_DEVICE; break; // DT_CHR
        case 4: wasiType = WASI_FILETYPE_DIRECTORY; break; // DT_DIR
        case 6: wasiType = WASI_FILETYPE_BLOCK_DEVICE; break; // DT_BLK
        case 8: wasiType = WASI_FILETYPE_REGULAR_FILE; break; // DT_REG
        case 10: wasiType = WASI_FILETYPE_SYMBOLIC_LINK; break; // DT_LNK
        case 12: wasiType = WASI_FILETYPE_SOCKET_STREAM; break; // DT_SOCK
      }

      view.setBigUint64(buf + dstOff, entryIdx, true);
      view.setBigUint64(buf + dstOff + 8, dIno, true);
      view.setUint32(buf + dstOff + 16, nameLen, true);
      view.setUint8(buf + dstOff + 20, wasiType);
      view.setUint8(buf + dstOff + 21, 0);
      view.setUint8(buf + dstOff + 22, 0);
      view.setUint8(buf + dstOff + 23, 0);
      dstOff += headerSize;

      // Write name bytes
      const copyNameLen = Math.min(nameLen, bufLen - dstOff);
      if (copyNameLen > 0) {
        mem.copyWithin(buf + dstOff, entBase + 19, entBase + 19 + copyNameLen);
        dstOff += copyNameLen;
      }

      srcOff += dReclen;
    }

    view.setUint32(sizeOut, dstOff, true);
    return WASI_ESUCCESS;
  }

  fd_renumber(from: number, to: number): number {
    // dup2 + close
    const { errno: dupErr } = this.doSyscall(SYS_DUP2, from, to);
    if (dupErr) return translateLinuxErrno(dupErr);
    if (from !== to) {
      const { errno: closeErr } = this.doSyscall(SYS_CLOSE, from);
      if (closeErr) return translateLinuxErrno(closeErr);
    }
    // Transfer preopen if applicable
    const preopenPath = this.preopens.get(from);
    if (preopenPath !== undefined) {
      this.preopens.delete(from);
      this.preopens.set(to, preopenPath);
    }
    return WASI_ESUCCESS;
  }

  // ---- Path operations ----

  path_create_directory(fd: number, pathPtr: number, pathLen: number): number {
    const { kernelDirfd, pathAddr } = this.resolvePath(fd, pathPtr, pathLen);
    const { errno } = this.doSyscall(SYS_MKDIRAT, kernelDirfd, pathAddr, 0o777);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  path_unlink_file(fd: number, pathPtr: number, pathLen: number): number {
    const { kernelDirfd, pathAddr } = this.resolvePath(fd, pathPtr, pathLen);
    const { errno } = this.doSyscall(SYS_UNLINKAT, kernelDirfd, pathAddr, 0);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  path_remove_directory(fd: number, pathPtr: number, pathLen: number): number {
    const { kernelDirfd, pathAddr } = this.resolvePath(fd, pathPtr, pathLen);
    const { errno } = this.doSyscall(SYS_UNLINKAT, kernelDirfd, pathAddr, AT_REMOVEDIR);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  path_rename(
    oldFd: number, oldPathPtr: number, oldPathLen: number,
    newFd: number, newPathPtr: number, newPathLen: number,
  ): number {
    // Write old path at offset 0, new path at offset 4096
    const { kernelDirfd: oldDirfd, pathAddr: oldAddr } = this.resolvePath(
      oldFd, oldPathPtr, oldPathLen, 0,
    );
    const { kernelDirfd: newDirfd, pathAddr: newAddr } = this.resolvePath(
      newFd, newPathPtr, newPathLen, 4096,
    );
    const { errno } = this.doSyscall(SYS_RENAMEAT, oldDirfd, oldAddr, newDirfd, newAddr);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  path_symlink(
    oldPathPtr: number, oldPathLen: number,
    fd: number, newPathPtr: number, newPathLen: number,
  ): number {
    // symlinkat(target, dirfd, linkpath)
    // Write target at offset 0
    const targetBytes = new Uint8Array(this.memory.buffer, oldPathPtr, oldPathLen);
    const targetAddr = this.dataArea;
    new Uint8Array(this.memory.buffer, targetAddr, oldPathLen + 1).set(targetBytes);
    new DataView(this.memory.buffer).setUint8(targetAddr + oldPathLen, 0);

    const { kernelDirfd, pathAddr } = this.resolvePath(fd, newPathPtr, newPathLen, 4096);
    const { errno } = this.doSyscall(SYS_SYMLINKAT, targetAddr, kernelDirfd, pathAddr);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  path_readlink(
    fd: number, pathPtr: number, pathLen: number,
    buf: number, bufLen: number, sizeOut: number,
  ): number {
    const { kernelDirfd, pathAddr } = this.resolvePath(fd, pathPtr, pathLen);
    // readlinkat writes result to a buffer; use data area offset 4096
    const resultAddr = this.dataArea + 4096;
    const maxLen = Math.min(bufLen, CH_DATA_SIZE - 4096 - 256);
    const { result, errno } = this.doSyscall(
      SYS_READLINKAT, kernelDirfd, pathAddr, resultAddr, maxLen,
    );
    if (errno) return translateLinuxErrno(errno);
    // Copy result to caller's buffer
    new Uint8Array(this.memory.buffer).copyWithin(buf, resultAddr, resultAddr + result);
    new DataView(this.memory.buffer).setUint32(sizeOut, result, true);
    return WASI_ESUCCESS;
  }

  path_link(
    oldFd: number, _oldFlags: number, oldPathPtr: number, oldPathLen: number,
    newFd: number, newPathPtr: number, newPathLen: number,
  ): number {
    const { kernelDirfd: oldDirfd, pathAddr: oldAddr } = this.resolvePath(
      oldFd, oldPathPtr, oldPathLen, 0,
    );
    const { kernelDirfd: newDirfd, pathAddr: newAddr } = this.resolvePath(
      newFd, newPathPtr, newPathLen, 4096,
    );
    const { errno } = this.doSyscall(SYS_LINKAT, oldDirfd, oldAddr, newDirfd, newAddr, 0);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  path_open(
    dirfd: number, _lookupFlags: number,
    pathPtr: number, pathLen: number,
    oflags: number, _rightsBase: bigint, _rightsInheriting: bigint,
    fdflags: number, fdOut: number,
  ): number {
    const { kernelDirfd, pathAddr } = this.resolvePath(dirfd, pathPtr, pathLen);

    let posixFlags = wasiOflagsToPosix(oflags, fdflags);

    // Determine access mode. WASI doesn't have explicit O_RDONLY/O_WRONLY/O_RDWR
    // in oflags — it's determined by rights. For simplicity, open with O_RDWR
    // unless it's a directory (O_RDONLY) or create-only.
    if (oflags & WASI_O_DIRECTORY) {
      posixFlags |= O_RDONLY;
    } else if (posixFlags & (O_CREAT | O_TRUNC)) {
      posixFlags |= O_RDWR;
    } else {
      posixFlags |= O_RDWR;
    }

    const { result, errno } = this.doSyscall(
      SYS_OPENAT, kernelDirfd, pathAddr, posixFlags, 0o666,
    );
    if (errno) {
      // If O_RDWR fails with EISDIR or EACCES, retry with O_RDONLY
      if ((errno === 21 || errno === 13) && !(posixFlags & O_CREAT)) {
        posixFlags = (posixFlags & ~3) | O_RDONLY;
        const retry = this.doSyscall(SYS_OPENAT, kernelDirfd, pathAddr, posixFlags, 0o666);
        if (retry.errno) return translateLinuxErrno(retry.errno);
        new DataView(this.memory.buffer).setUint32(fdOut, retry.result, true);
        return WASI_ESUCCESS;
      }
      return translateLinuxErrno(errno);
    }
    new DataView(this.memory.buffer).setUint32(fdOut, result, true);
    return WASI_ESUCCESS;
  }

  path_filestat_get(
    fd: number, _flags: number, pathPtr: number, pathLen: number, filestatPtr: number,
  ): number {
    const { kernelDirfd, pathAddr } = this.resolvePath(fd, pathPtr, pathLen);
    // fstatat: (dirfd, path, statbuf, flags)
    const statBufOffset = 4096; // use offset in data area for stat buffer
    const { errno } = this.doSyscall(
      SYS_FSTATAT, kernelDirfd, pathAddr, this.dataArea + statBufOffset, 0,
    );
    if (errno) return translateLinuxErrno(errno);
    this.translateStat(statBufOffset, filestatPtr);
    return WASI_ESUCCESS;
  }

  path_filestat_set_times(
    fd: number, _flags: number, pathPtr: number, pathLen: number,
    atim: bigint, mtim: bigint, fstFlags: number,
  ): number {
    const { kernelDirfd, pathAddr } = this.resolvePath(fd, pathPtr, pathLen, 4096);

    const UTIME_NOW = 0x3FFFFFFF;
    const UTIME_OMIT = 0x3FFFFFFE;
    const view = new DataView(this.memory.buffer);
    const tsAddr = this.dataArea;

    if (fstFlags & 2) {
      view.setBigInt64(tsAddr + 0, 0n, true);
      view.setBigInt64(tsAddr + 8, BigInt(UTIME_NOW), true);
    } else if (fstFlags & 1) {
      view.setBigInt64(tsAddr + 0, atim / 1000000000n, true);
      view.setBigInt64(tsAddr + 8, atim % 1000000000n, true);
    } else {
      view.setBigInt64(tsAddr + 0, 0n, true);
      view.setBigInt64(tsAddr + 8, BigInt(UTIME_OMIT), true);
    }

    if (fstFlags & 8) {
      view.setBigInt64(tsAddr + 16, 0n, true);
      view.setBigInt64(tsAddr + 24, BigInt(UTIME_NOW), true);
    } else if (fstFlags & 4) {
      view.setBigInt64(tsAddr + 16, mtim / 1000000000n, true);
      view.setBigInt64(tsAddr + 24, mtim % 1000000000n, true);
    } else {
      view.setBigInt64(tsAddr + 16, 0n, true);
      view.setBigInt64(tsAddr + 24, BigInt(UTIME_OMIT), true);
    }

    const { errno } = this.doSyscall(SYS_UTIMENSAT, kernelDirfd, pathAddr, tsAddr, 0);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  // ---- Random/Clock/Process ----

  random_get(buf: number, bufLen: number): number {
    // getrandom reads into a buffer; for large reads we chunk
    let offset = 0;
    while (offset < bufLen) {
      const chunkSize = Math.min(bufLen - offset, CH_DATA_SIZE - 256);
      const { result, errno } = this.doSyscall(
        SYS_GETRANDOM, this.dataArea, chunkSize, 0,
      );
      if (errno) return translateLinuxErrno(errno);
      new Uint8Array(this.memory.buffer).copyWithin(
        buf + offset, this.dataArea, this.dataArea + result,
      );
      offset += result;
    }
    return WASI_ESUCCESS;
  }

  clock_time_get(clockId: number, _precision: bigint, timeOut: number): number {
    const posixClock = wasiClockToPosix(clockId);
    // clock_gettime writes a timespec (16 bytes: i64 sec + i64 nsec) to buf
    const { errno } = this.doSyscall(SYS_CLOCK_GETTIME, posixClock, this.dataArea);
    if (errno) return translateLinuxErrno(errno);
    const view = new DataView(this.memory.buffer);
    const sec = view.getBigInt64(this.dataArea, true);
    const nsec = view.getBigInt64(this.dataArea + 8, true);
    // WASI time is u64 nanoseconds
    view.setBigUint64(timeOut, BigInt(sec) * 1000000000n + BigInt(nsec), true);
    return WASI_ESUCCESS;
  }

  clock_res_get(clockId: number, resOut: number): number {
    const posixClock = wasiClockToPosix(clockId);
    const { errno } = this.doSyscall(SYS_CLOCK_GETRES, posixClock, this.dataArea);
    if (errno) return translateLinuxErrno(errno);
    const view = new DataView(this.memory.buffer);
    const sec = view.getBigInt64(this.dataArea, true);
    const nsec = view.getBigInt64(this.dataArea + 8, true);
    view.setBigUint64(resOut, BigInt(sec) * 1000000000n + BigInt(nsec), true);
    return WASI_ESUCCESS;
  }

  proc_exit(code: number): void {
    // Send SYS_EXIT via channel, then throw to stop execution
    this.doSyscall(SYS_EXIT, code);
    throw new WasiExit(code);
  }

  proc_raise(sig: number): number {
    // kill(getpid(), sig)
    const { result: pid } = this.doSyscall(SYS_GETPID);
    const { errno } = this.doSyscall(SYS_KILL, pid, sig);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  sched_yield(): number {
    this.doSyscall(SYS_SCHED_YIELD);
    return WASI_ESUCCESS;
  }

  // ---- poll_oneoff ----

  poll_oneoff(
    inPtr: number, outPtr: number, nsubscriptions: number, neventsOut: number,
  ): number {
    const view = new DataView(this.memory.buffer);

    if (nsubscriptions === 0) {
      view.setUint32(neventsOut, 0, true);
      return WASI_ESUCCESS;
    }

    // WASI subscription is 48 bytes:
    //   userdata(u64) + u8 tag + 7pad + union(32 bytes)
    // For clock: union = clockid(u32) + pad(4) + timeout(u64) + precision(u64) + flags(u16) + pad(6)
    // For fd_read/fd_write: union = fd(u32) + pad(28)
    // WASI event is 32 bytes:
    //   userdata(u64) + errno(u16) + type(u8) + pad(5) + fd_readwrite(16 bytes)

    // Check if this is a pure clock subscription (sleep)
    let hasClockSub = false;
    let hasFdSub = false;
    for (let i = 0; i < nsubscriptions; i++) {
      const tag = view.getUint8(inPtr + i * 48 + 8);
      if (tag === WASI_EVENTTYPE_CLOCK) hasClockSub = true;
      else hasFdSub = true;
    }

    if (hasClockSub && !hasFdSub && nsubscriptions === 1) {
      // Pure sleep — use nanosleep via clock_nanosleep or poll with timeout
      const subBase = inPtr;
      const userdata = view.getBigUint64(subBase, true);
      const timeout = view.getBigUint64(subBase + 16 + 8, true);
      const flags = view.getUint16(subBase + 16 + 24, true);

      let timeoutMs: number;
      if (flags & 1) {
        // Absolute time — compute relative
        const { errno } = this.doSyscall(SYS_CLOCK_GETTIME, CLOCK_REALTIME, this.dataArea);
        if (errno) return translateLinuxErrno(errno);
        const nowSec = view.getBigInt64(this.dataArea, true);
        const nowNsec = view.getBigInt64(this.dataArea + 8, true);
        const nowNs = nowSec * 1000000000n + nowNsec;
        const deltaNs = BigInt(timeout) - nowNs;
        timeoutMs = deltaNs > 0n ? Number(deltaNs / 1000000n) : 0;
      } else {
        timeoutMs = Number(timeout / 1000000n);
      }

      // Use poll with no fds and timeout
      if (timeoutMs > 0) {
        this.doSyscall(SYS_POLL, 0, 0, timeoutMs);
      }

      // Write event
      view.setBigUint64(outPtr, userdata, true);
      view.setUint16(outPtr + 8, 0, true); // no error
      view.setUint8(outPtr + 10, WASI_EVENTTYPE_CLOCK);
      // Clear padding
      for (let i = 11; i < 32; i++) view.setUint8(outPtr + i, 0);
      view.setUint32(neventsOut, 1, true);
      return WASI_ESUCCESS;
    }

    // General case: translate to poll()
    // Build pollfd array in data area
    const pollfds: Array<{ fd: number; events: number; idx: number; userdata: bigint; type: number }> = [];
    let clockTimeoutMs = -1;
    let clockUserdata = 0n;

    for (let i = 0; i < nsubscriptions; i++) {
      const subBase = inPtr + i * 48;
      const userdata = view.getBigUint64(subBase, true);
      const tag = view.getUint8(subBase + 8);

      if (tag === WASI_EVENTTYPE_CLOCK) {
        const timeout = view.getBigUint64(subBase + 16 + 8, true);
        const ms = Number(timeout / 1000000n);
        if (clockTimeoutMs < 0 || ms < clockTimeoutMs) {
          clockTimeoutMs = ms;
          clockUserdata = userdata;
        }
      } else {
        const fd = view.getUint32(subBase + 16, true);
        const events = tag === WASI_EVENTTYPE_FD_READ ? POLLIN : POLLOUT;
        pollfds.push({ fd, events, idx: i, userdata, type: tag });
      }
    }

    // Write pollfd structs: fd(i32) + events(i16) + revents(i16) = 8 bytes
    const pollfdAddr = this.dataArea;
    for (let i = 0; i < pollfds.length; i++) {
      view.setInt32(pollfdAddr + i * 8, pollfds[i].fd, true);
      view.setInt16(pollfdAddr + i * 8 + 4, pollfds[i].events, true);
      view.setInt16(pollfdAddr + i * 8 + 6, 0, true);
    }

    const { errno } = this.doSyscall(
      SYS_POLL, pollfdAddr, pollfds.length, clockTimeoutMs >= 0 ? clockTimeoutMs : -1,
    );
    if (errno && errno !== 4 /* EINTR */) return translateLinuxErrno(errno);

    // Read results and write WASI events
    let nevents = 0;
    for (let i = 0; i < pollfds.length; i++) {
      const revents = view.getInt16(pollfdAddr + i * 8 + 6, true);
      if (revents) {
        const evBase = outPtr + nevents * 32;
        view.setBigUint64(evBase, pollfds[i].userdata, true);
        const wasiErr = (revents & POLLERR) ? WASI_EIO : WASI_ESUCCESS;
        view.setUint16(evBase + 8, wasiErr, true);
        view.setUint8(evBase + 10, pollfds[i].type);
        for (let j = 11; j < 32; j++) view.setUint8(evBase + j, 0);
        // fd_readwrite.nbytes — we don't know, report 1
        view.setBigUint64(evBase + 16, 1n, true);
        nevents++;
      }
    }

    // If poll timed out and we had a clock subscription, report it
    if (nevents === 0 && clockTimeoutMs >= 0) {
      const evBase = outPtr;
      view.setBigUint64(evBase, clockUserdata, true);
      view.setUint16(evBase + 8, 0, true);
      view.setUint8(evBase + 10, WASI_EVENTTYPE_CLOCK);
      for (let i = 11; i < 32; i++) view.setUint8(evBase + i, 0);
      nevents = 1;
    }

    view.setUint32(neventsOut, nevents, true);
    return WASI_ESUCCESS;
  }

  // ---- Socket operations ----

  sock_recv(
    fd: number, iovsPtr: number, iovsLen: number,
    _riFlags: number, roDataLenOut: number, roFlagsOut: number,
  ): number {
    const view = new DataView(this.memory.buffer);
    const mem = new Uint8Array(this.memory.buffer);

    // Gather total size from iovecs, read into data area, then scatter
    let totalLen = 0;
    for (let i = 0; i < iovsLen; i++) {
      totalLen += view.getUint32(iovsPtr + i * 8 + 4, true);
    }
    totalLen = Math.min(totalLen, CH_DATA_SIZE - 256);

    const { result, errno } = this.doSyscall(
      SYS_RECVFROM, fd, this.dataArea, totalLen, 0, 0, 0,
    );
    if (errno) return translateLinuxErrno(errno);

    // Scatter into iovecs
    let remaining = result;
    let srcOff = 0;
    for (let i = 0; i < iovsLen && remaining > 0; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const copyLen = Math.min(bufLen, remaining);
      mem.copyWithin(bufPtr, this.dataArea + srcOff, this.dataArea + srcOff + copyLen);
      srcOff += copyLen;
      remaining -= copyLen;
    }

    view.setUint32(roDataLenOut, result, true);
    view.setUint16(roFlagsOut, 0, true);
    return WASI_ESUCCESS;
  }

  sock_send(
    fd: number, iovsPtr: number, iovsLen: number,
    _siFlags: number, nwrittenOut: number,
  ): number {
    const view = new DataView(this.memory.buffer);
    const mem = new Uint8Array(this.memory.buffer);

    // Gather from iovecs into data area
    let totalLen = 0;
    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const copyLen = Math.min(bufLen, CH_DATA_SIZE - 256 - totalLen);
      mem.copyWithin(this.dataArea + totalLen, bufPtr, bufPtr + copyLen);
      totalLen += copyLen;
    }

    const { result, errno } = this.doSyscall(
      SYS_SENDTO, fd, this.dataArea, totalLen, 0, 0, 0,
    );
    if (errno) return translateLinuxErrno(errno);

    view.setUint32(nwrittenOut, result, true);
    return WASI_ESUCCESS;
  }

  sock_shutdown(fd: number, how: number): number {
    // WASI: 0=RD, 1=WR, 2=RDWR. POSIX: SHUT_RD=0, SHUT_WR=1, SHUT_RDWR=2. Same.
    const { errno } = this.doSyscall(SYS_SHUTDOWN, fd, how);
    return errno ? translateLinuxErrno(errno) : WASI_ESUCCESS;
  }

  sock_accept(_fd: number, _flags: number, _fdOut: number): number {
    return WASI_ENOSYS;
  }
}

// `isWasiModule`, `wasiModuleImportsMemory`, and `wasiModuleDefinesMemory`
// moved to `./wasi-detect.ts`. Re-export them here so existing public
// imports of `wasm-posix-kernel/host` keep working — but worker-main.ts
// imports them directly from wasi-detect.ts to avoid pulling this file
// onto the worker bootstrap path.
export {
  isWasiModule,
  wasiModuleImportsMemory,
  wasiModuleDefinesMemory,
} from "./wasi-detect";
