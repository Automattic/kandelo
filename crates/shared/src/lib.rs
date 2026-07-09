#![no_std]

pub mod host_abi;

/// Kernel ABI version.
///
/// This number is baked into every compiled user program (wasm custom section
/// `wasm-posix-abi`) and exported by the kernel as `__abi_version`. The host
/// refuses to launch binaries whose ABI does not match the running kernel.
///
/// **Bump this whenever the binary-level contract between user programs and
/// the kernel changes in a way that breaks backward compatibility.**
///
/// The structural snapshot at `abi/snapshot.json` is the source of truth for
/// what that contract covers — field offsets of marshalled structs, channel
/// header layout, syscall numbers, and kernel export signatures. CI
/// regenerates the snapshot and compares it to the committed copy; any diff
/// requires bumping `ABI_VERSION` in the same commit.
///
/// See `docs/abi-versioning.md` for the full policy.
///
/// 13: process memory layout ABI is Rust-declared; per-pthread slots
///     use explicit TLS/control, fork-save, channel, and spill pages,
///     with a wasm-declared reserved thread-slot count.
/// 15: remove the obsolete `kernel_set_mode` export; the kernel is always
///     the shared point of contact for all programs.
/// 16: SYS_IOCTL host-adapter marshalling now reads `_IOC_SIZE` from
///     bits 16..29 of the request via `SyscallArgSize::IoctlEncoded
///     { arg_index, floor }` (was a flat `Fixed { size: 256 }`), so the
///     channel round-trips the full ioctl payload instead of truncating
///     to 256 B. ALSA `WpkAlsaPcmSwParams` shrunk 136→104, `WpkAlsaXferi`
///     24→12, and the `SNDRV_PCM_IOCTL_{SW_PARAMS, WRITEI_FRAMES}`
///     request constants moved accordingly to match wasm32 musl
///     `unsigned long = 4`. The same `unsigned long = 4` rule applies
///     to the remaining audio structs: `WpkAlsaPcmStatus` keeps its
///     128 B size but its field offsets shift (uframes shrink i64→u32,
///     timespecs become i64 sec + i32 nsec + 4 B pad, two new fields:
///     `driver_tstamp` + `audio_tstamp_accuracy`). `WpkAlsaPcmMmapStatus`
///     shrinks 64→56 (mapped at MMAP_OFFSET_STATUS_NEW =
///     `__snd_pcm_mmap_status64`). `WpkAlsaPcmMmapControl` shrinks
///     64→12 (= `__snd_pcm_mmap_control64`).
pub const ABI_VERSION: u32 = 16;

/// Syscall numbers for the POSIX kernel interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Syscall {
    Open = 1,
    Close = 2,
    Read = 3,
    Write = 4,
    Seek = 5,
    Fstat = 6,
    Dup = 7,
    Dup2 = 8,
    Pipe = 9,
    Fcntl = 10,
    Stat = 11,
    Lstat = 12,
    Mkdir = 13,
    Rmdir = 14,
    Unlink = 15,
    Rename = 16,
    Link = 17,
    Symlink = 18,
    Readlink = 19,
    Chmod = 20,
    Chown = 21,
    Access = 22,
    Getcwd = 23,
    Chdir = 24,
    Opendir = 25,
    Readdir = 26,
    Closedir = 27,
    Getpid = 28,
    Getppid = 29,
    Getuid = 30,
    Geteuid = 31,
    Getgid = 32,
    Getegid = 33,
    Exit = 34,
    Kill = 35,
    Sigaction = 36,
    Sigprocmask = 37,
    Raise = 38,
    Alarm = 39,
    ClockGettime = 40,
    Nanosleep = 41,
    Isatty = 42,
    GetEnv = 43,
    SetEnv = 44,
    UnsetEnv = 45,
    Mmap = 46,
    Munmap = 47,
    Brk = 48,
    Mprotect = 49,
    Socket = 50,
    Bind = 51,
    Listen = 52,
    Accept = 53,
    Connect = 54,
    Send = 55,
    Recv = 56,
    Shutdown = 57,
    Getsockopt = 58,
    Setsockopt = 59,
    Poll = 60,
    Socketpair = 61,
    Sendto = 62,
    Recvfrom = 63,
    Pread = 64,
    Pwrite = 65,
    Time = 66,
    Gettimeofday = 67,
    Usleep = 68,
    Openat = 69,
    Tcgetattr = 70,
    Tcsetattr = 71,
    Ioctl = 72,
    Signal = 73,
    Umask = 74,
    Uname = 75,
    Sysconf = 76,
    Dup3 = 77,
    Pipe2 = 78,
    Ftruncate = 79,
    Fsync = 80,
    Writev = 81,
    Readv = 82,
    Getrlimit = 83,
    Setrlimit = 84,
    Truncate = 85,
    Fdatasync = 86,
    Fchmod = 87,
    Fchown = 88,
    Getpgrp = 89,
    Setpgid = 90,
    Getsid = 91,
    Setsid = 92,
    Fstatat = 93,
    Unlinkat = 94,
    Mkdirat = 95,
    Renameat = 96,
    Faccessat = 97,
    Fchmodat = 98,
    Fchownat = 99,
    Linkat = 100,
    Symlinkat = 101,
    Readlinkat = 102,
    Select = 103,
    Setuid = 104,
    Setgid = 105,
    Seteuid = 106,
    Setegid = 107,
    Getrusage = 108,
    Realpath = 109,
    Sigsuspend = 110,
    Pause = 111,
    Pathconf = 112,
    Fpathconf = 113,
    Getsockname = 114,
    Getpeername = 115,
    Rewinddir = 116,
    Telldir = 117,
    Seekdir = 118,
    Getdents64 = 122,
    ClockGetres = 123,
    ClockNanosleep = 124,
    Utimensat = 125,
    Mremap = 126,
    Fchdir = 127,
    Madvise = 128,
    Statfs = 129,
    Fstatfs = 130,
    Setresuid = 131,
    Getresuid = 132,
    Setresgid = 133,
    Getresgid = 134,
    Getgroups = 135,
    Setgroups = 136,
    Sendmsg = 137,
    Recvmsg = 138,
    Wait4 = 139,
    Getaddrinfo = 140,
}

impl Syscall {
    /// Convert a raw u32 value to a Syscall variant.
    pub fn from_u32(val: u32) -> Option<Syscall> {
        match val {
            1 => Some(Syscall::Open),
            2 => Some(Syscall::Close),
            3 => Some(Syscall::Read),
            4 => Some(Syscall::Write),
            5 => Some(Syscall::Seek),
            6 => Some(Syscall::Fstat),
            7 => Some(Syscall::Dup),
            8 => Some(Syscall::Dup2),
            9 => Some(Syscall::Pipe),
            10 => Some(Syscall::Fcntl),
            11 => Some(Syscall::Stat),
            12 => Some(Syscall::Lstat),
            13 => Some(Syscall::Mkdir),
            14 => Some(Syscall::Rmdir),
            15 => Some(Syscall::Unlink),
            16 => Some(Syscall::Rename),
            17 => Some(Syscall::Link),
            18 => Some(Syscall::Symlink),
            19 => Some(Syscall::Readlink),
            20 => Some(Syscall::Chmod),
            21 => Some(Syscall::Chown),
            22 => Some(Syscall::Access),
            23 => Some(Syscall::Getcwd),
            24 => Some(Syscall::Chdir),
            25 => Some(Syscall::Opendir),
            26 => Some(Syscall::Readdir),
            27 => Some(Syscall::Closedir),
            28 => Some(Syscall::Getpid),
            29 => Some(Syscall::Getppid),
            30 => Some(Syscall::Getuid),
            31 => Some(Syscall::Geteuid),
            32 => Some(Syscall::Getgid),
            33 => Some(Syscall::Getegid),
            34 => Some(Syscall::Exit),
            35 => Some(Syscall::Kill),
            36 => Some(Syscall::Sigaction),
            37 => Some(Syscall::Sigprocmask),
            38 => Some(Syscall::Raise),
            39 => Some(Syscall::Alarm),
            40 => Some(Syscall::ClockGettime),
            41 => Some(Syscall::Nanosleep),
            42 => Some(Syscall::Isatty),
            43 => Some(Syscall::GetEnv),
            44 => Some(Syscall::SetEnv),
            45 => Some(Syscall::UnsetEnv),
            46 => Some(Syscall::Mmap),
            47 => Some(Syscall::Munmap),
            48 => Some(Syscall::Brk),
            49 => Some(Syscall::Mprotect),
            50 => Some(Syscall::Socket),
            51 => Some(Syscall::Bind),
            52 => Some(Syscall::Listen),
            53 => Some(Syscall::Accept),
            54 => Some(Syscall::Connect),
            55 => Some(Syscall::Send),
            56 => Some(Syscall::Recv),
            57 => Some(Syscall::Shutdown),
            58 => Some(Syscall::Getsockopt),
            59 => Some(Syscall::Setsockopt),
            60 => Some(Syscall::Poll),
            61 => Some(Syscall::Socketpair),
            62 => Some(Syscall::Sendto),
            63 => Some(Syscall::Recvfrom),
            64 => Some(Syscall::Pread),
            65 => Some(Syscall::Pwrite),
            66 => Some(Syscall::Time),
            67 => Some(Syscall::Gettimeofday),
            68 => Some(Syscall::Usleep),
            69 => Some(Syscall::Openat),
            70 => Some(Syscall::Tcgetattr),
            71 => Some(Syscall::Tcsetattr),
            72 => Some(Syscall::Ioctl),
            73 => Some(Syscall::Signal),
            74 => Some(Syscall::Umask),
            75 => Some(Syscall::Uname),
            76 => Some(Syscall::Sysconf),
            77 => Some(Syscall::Dup3),
            78 => Some(Syscall::Pipe2),
            79 => Some(Syscall::Ftruncate),
            80 => Some(Syscall::Fsync),
            81 => Some(Syscall::Writev),
            82 => Some(Syscall::Readv),
            83 => Some(Syscall::Getrlimit),
            84 => Some(Syscall::Setrlimit),
            85 => Some(Syscall::Truncate),
            86 => Some(Syscall::Fdatasync),
            87 => Some(Syscall::Fchmod),
            88 => Some(Syscall::Fchown),
            89 => Some(Syscall::Getpgrp),
            90 => Some(Syscall::Setpgid),
            91 => Some(Syscall::Getsid),
            92 => Some(Syscall::Setsid),
            93 => Some(Syscall::Fstatat),
            94 => Some(Syscall::Unlinkat),
            95 => Some(Syscall::Mkdirat),
            96 => Some(Syscall::Renameat),
            97 => Some(Syscall::Faccessat),
            98 => Some(Syscall::Fchmodat),
            99 => Some(Syscall::Fchownat),
            100 => Some(Syscall::Linkat),
            101 => Some(Syscall::Symlinkat),
            102 => Some(Syscall::Readlinkat),
            103 => Some(Syscall::Select),
            104 => Some(Syscall::Setuid),
            105 => Some(Syscall::Setgid),
            106 => Some(Syscall::Seteuid),
            107 => Some(Syscall::Setegid),
            108 => Some(Syscall::Getrusage),
            109 => Some(Syscall::Realpath),
            110 => Some(Syscall::Sigsuspend),
            111 => Some(Syscall::Pause),
            112 => Some(Syscall::Pathconf),
            113 => Some(Syscall::Fpathconf),
            114 => Some(Syscall::Getsockname),
            115 => Some(Syscall::Getpeername),
            116 => Some(Syscall::Rewinddir),
            117 => Some(Syscall::Telldir),
            118 => Some(Syscall::Seekdir),
            122 => Some(Syscall::Getdents64),
            123 => Some(Syscall::ClockGetres),
            124 => Some(Syscall::ClockNanosleep),
            125 => Some(Syscall::Utimensat),
            126 => Some(Syscall::Mremap),
            127 => Some(Syscall::Fchdir),
            128 => Some(Syscall::Madvise),
            129 => Some(Syscall::Statfs),
            130 => Some(Syscall::Fstatfs),
            131 => Some(Syscall::Setresuid),
            132 => Some(Syscall::Getresuid),
            133 => Some(Syscall::Setresgid),
            134 => Some(Syscall::Getresgid),
            135 => Some(Syscall::Getgroups),
            136 => Some(Syscall::Setgroups),
            137 => Some(Syscall::Sendmsg),
            138 => Some(Syscall::Recvmsg),
            139 => Some(Syscall::Wait4),
            140 => Some(Syscall::Getaddrinfo),
            _ => None,
        }
    }
}

/// Status of the shared-memory syscall channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ChannelStatus {
    Idle = 0,
    Pending = 1,
    Complete = 2,
    Error = 3,
}

impl ChannelStatus {
    /// Convert a raw u32 value to a ChannelStatus variant.
    pub fn from_u32(val: u32) -> Option<ChannelStatus> {
        match val {
            0 => Some(ChannelStatus::Idle),
            1 => Some(ChannelStatus::Pending),
            2 => Some(ChannelStatus::Complete),
            3 => Some(ChannelStatus::Error),
            _ => None,
        }
    }
}

/// Standard POSIX errno values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Errno {
    EPERM = 1,
    ENOENT = 2,
    ESRCH = 3,
    EINTR = 4,
    EIO = 5,
    ENXIO = 6,
    E2BIG = 7,
    EBADF = 9,
    ECHILD = 10,
    EAGAIN = 11,
    ENOMEM = 12,
    EACCES = 13,
    EFAULT = 14,
    EBUSY = 16,
    EEXIST = 17,
    EXDEV = 18,
    ENODEV = 19,
    ENOTDIR = 20,
    EISDIR = 21,
    EINVAL = 22,
    ENFILE = 23,
    EMFILE = 24,
    ENOTTY = 25,
    EFBIG = 27,
    ENOSPC = 28,
    ESPIPE = 29,
    EROFS = 30,
    EMLINK = 31,
    EPIPE = 32,
    ERANGE = 34,
    EDEADLK = 35,
    ENAMETOOLONG = 36,
    ENOSYS = 38,
    ENOTEMPTY = 39,
    ELOOP = 40,
    ENOMSG = 42,
    EIDRM = 43,
    ENODATA = 61,
    EOVERFLOW = 75,
    EBADFD = 77,
    ENOTSOCK = 88,
    EDESTADDRREQ = 89,
    EMSGSIZE = 90,
    EPROTOTYPE = 91,
    ENOPROTOOPT = 92,
    EPROTONOSUPPORT = 93,
    EOPNOTSUPP = 95,
    EAFNOSUPPORT = 97,
    EADDRINUSE = 98,
    EADDRNOTAVAIL = 99,
    ENETUNREACH = 101,
    ECONNABORTED = 103,
    ECONNRESET = 104,
    ECONNREFUSED = 111,
    EISCONN = 106,
    ENOTCONN = 107,
    ESHUTDOWN = 108,
    ETIMEDOUT = 110,
    EALREADY = 114,
    EINPROGRESS = 115,
}

impl Errno {
    /// Convert a raw u32 value to an Errno variant.
    pub fn from_u32(val: u32) -> Option<Errno> {
        match val {
            1 => Some(Errno::EPERM),
            2 => Some(Errno::ENOENT),
            3 => Some(Errno::ESRCH),
            4 => Some(Errno::EINTR),
            5 => Some(Errno::EIO),
            6 => Some(Errno::ENXIO),
            7 => Some(Errno::E2BIG),
            9 => Some(Errno::EBADF),
            10 => Some(Errno::ECHILD),
            11 => Some(Errno::EAGAIN),
            12 => Some(Errno::ENOMEM),
            13 => Some(Errno::EACCES),
            14 => Some(Errno::EFAULT),
            16 => Some(Errno::EBUSY),
            17 => Some(Errno::EEXIST),
            18 => Some(Errno::EXDEV),
            19 => Some(Errno::ENODEV),
            20 => Some(Errno::ENOTDIR),
            21 => Some(Errno::EISDIR),
            22 => Some(Errno::EINVAL),
            23 => Some(Errno::ENFILE),
            24 => Some(Errno::EMFILE),
            25 => Some(Errno::ENOTTY),
            27 => Some(Errno::EFBIG),
            28 => Some(Errno::ENOSPC),
            29 => Some(Errno::ESPIPE),
            30 => Some(Errno::EROFS),
            31 => Some(Errno::EMLINK),
            32 => Some(Errno::EPIPE),
            34 => Some(Errno::ERANGE),
            35 => Some(Errno::EDEADLK),
            36 => Some(Errno::ENAMETOOLONG),
            38 => Some(Errno::ENOSYS),
            39 => Some(Errno::ENOTEMPTY),
            40 => Some(Errno::ELOOP),
            42 => Some(Errno::ENOMSG),
            43 => Some(Errno::EIDRM),
            61 => Some(Errno::ENODATA),
            75 => Some(Errno::EOVERFLOW),
            77 => Some(Errno::EBADFD),
            88 => Some(Errno::ENOTSOCK),
            89 => Some(Errno::EDESTADDRREQ),
            90 => Some(Errno::EMSGSIZE),
            91 => Some(Errno::EPROTOTYPE),
            92 => Some(Errno::ENOPROTOOPT),
            93 => Some(Errno::EPROTONOSUPPORT),
            95 => Some(Errno::EOPNOTSUPP),
            97 => Some(Errno::EAFNOSUPPORT),
            98 => Some(Errno::EADDRINUSE),
            99 => Some(Errno::EADDRNOTAVAIL),
            101 => Some(Errno::ENETUNREACH),
            103 => Some(Errno::ECONNABORTED),
            104 => Some(Errno::ECONNRESET),
            106 => Some(Errno::EISCONN),
            111 => Some(Errno::ECONNREFUSED),
            107 => Some(Errno::ENOTCONN),
            108 => Some(Errno::ESHUTDOWN),
            110 => Some(Errno::ETIMEDOUT),
            114 => Some(Errno::EALREADY),
            115 => Some(Errno::EINPROGRESS),
            _ => None,
        }
    }
}

/// File open flags (O_*).
pub mod flags {
    pub const O_RDONLY: u32 = 0;
    pub const O_WRONLY: u32 = 1;
    pub const O_RDWR: u32 = 2;
    pub const O_ACCMODE: u32 = 3;
    pub const O_CREAT: u32 = 0o100;
    pub const O_EXCL: u32 = 0o200;
    pub const O_TRUNC: u32 = 0o1000;
    pub const O_APPEND: u32 = 0o2000;
    pub const O_NONBLOCK: u32 = 0o4000;
    pub const O_ASYNC: u32 = 0o20000;
    pub const O_DIRECTORY: u32 = 0o200000;
    pub const O_NOFOLLOW: u32 = 0o400000;
    pub const O_CLOEXEC: u32 = 0o2000000;
    pub const O_CLOFORK: u32 = 0o40000000;
    pub const AT_FDCWD: i32 = -100;
    pub const AT_SYMLINK_NOFOLLOW: u32 = 0x100;
    pub const AT_REMOVEDIR: u32 = 0x200;
}

/// File descriptor flags (FD_*).
pub mod fd_flags {
    pub const FD_CLOEXEC: u32 = 1;
    pub const FD_CLOFORK: u32 = 2;
}

/// fcntl command constants (F_*).
pub mod fcntl_cmd {
    pub const F_DUPFD: u32 = 0;
    pub const F_GETFD: u32 = 1;
    pub const F_SETFD: u32 = 2;
    pub const F_GETFL: u32 = 3;
    pub const F_SETFL: u32 = 4;
    pub const F_GETLK: u32 = 12;
    pub const F_SETLK: u32 = 13;
    pub const F_SETLKW: u32 = 14;
    pub const F_SETOWN: u32 = 8;
    pub const F_GETOWN: u32 = 9;
    pub const F_DUPFD_CLOEXEC: u32 = 1030;
    pub const F_DUPFD_CLOFORK: u32 = 1028;
    pub const F_OFD_GETLK: u32 = 36;
    pub const F_OFD_SETLK: u32 = 37;
    pub const F_OFD_SETLKW: u32 = 38;
}

/// Lock type constants for advisory record locking.
pub mod lock_type {
    pub const F_RDLCK: u32 = 0;
    pub const F_WRLCK: u32 = 1;
    pub const F_UNLCK: u32 = 2;
}

/// BSD flock() operation constants.
pub mod flock_op {
    pub const LOCK_SH: u32 = 1;
    pub const LOCK_EX: u32 = 2;
    pub const LOCK_UN: u32 = 8;
    pub const LOCK_NB: u32 = 4;
}

/// Memory mapping constants.
pub mod mmap {
    // Protection flags (largely ignored in Wasm, but tracked for compatibility)
    pub const PROT_NONE: u32 = 0;
    pub const PROT_READ: u32 = 1;
    pub const PROT_WRITE: u32 = 2;
    pub const PROT_EXEC: u32 = 4;

    // Map flags
    pub const MAP_SHARED: u32 = 0x01;
    pub const MAP_PRIVATE: u32 = 0x02;
    pub const MAP_FIXED: u32 = 0x10;
    pub const MAP_ANONYMOUS: u32 = 0x20;
    pub const MAP_ANON: u32 = MAP_ANONYMOUS;

    // Return value for failure (usize::MAX — works for both wasm32 and wasm64)
    pub const MAP_FAILED: usize = usize::MAX;
}

/// Socket constants.
pub mod socket {
    pub const AF_UNIX: u32 = 1;
    pub const AF_INET: u32 = 2;
    pub const AF_INET6: u32 = 10;
    pub const SOCK_STREAM: u32 = 1;
    pub const SOCK_DGRAM: u32 = 2;
    pub const SOCK_NONBLOCK: u32 = 0o4000;
    pub const SOCK_CLOEXEC: u32 = 0o2000000;
    pub const SOL_SOCKET: u32 = 1;
    pub const SCM_RIGHTS: u32 = 1;
    pub const SO_REUSEADDR: u32 = 2;
    pub const SO_ERROR: u32 = 4;
    pub const SO_KEEPALIVE: u32 = 9;
    pub const SO_RCVBUF: u32 = 8;
    pub const SO_SNDBUF: u32 = 7;
    pub const SO_TYPE: u32 = 3;
    pub const SO_DOMAIN: u32 = 39;
    pub const SO_ACCEPTCONN: u32 = 30;
    pub const SHUT_RD: u32 = 0;
    pub const SHUT_WR: u32 = 1;
    pub const SHUT_RDWR: u32 = 2;
    pub const SO_BROADCAST: u32 = 6;
    pub const SO_LINGER: u32 = 13;
    // time64 values used by musl on wasm32 (where __LONG_MAX == 0x7fffffff)
    pub const SO_RCVTIMEO: u32 = 66;
    pub const SO_SNDTIMEO: u32 = 67;
    pub const IPPROTO_TCP: u32 = 6;
    pub const TCP_NODELAY: u32 = 1;
    pub const TCP_CORK: u32 = 3;
    pub const TCP_KEEPIDLE: u32 = 4;
    pub const TCP_KEEPINTVL: u32 = 5;
    pub const TCP_KEEPCNT: u32 = 6;
    pub const TCP_DEFER_ACCEPT: u32 = 9;
    pub const TCP_INFO: u32 = 11;
    pub const TCP_QUICKACK: u32 = 12;
    pub const TCP_USER_TIMEOUT: u32 = 18;
    pub const MSG_OOB: u32 = 1;
    pub const MSG_PEEK: u32 = 2;
    pub const MSG_DONTWAIT: u32 = 64;
    pub const MSG_NOSIGNAL: u32 = 0x4000;
}

/// Poll constants.
pub mod poll {
    pub const POLLIN: i16 = 0x0001;
    pub const POLLPRI: i16 = 0x0002;
    pub const POLLOUT: i16 = 0x0004;
    pub const POLLERR: i16 = 0x0008;
    pub const POLLHUP: i16 = 0x0010;
    pub const POLLNVAL: i16 = 0x0020;
}

/// Seek whence constants.
pub mod seek {
    pub const SEEK_SET: u32 = 0;
    pub const SEEK_CUR: u32 = 1;
    pub const SEEK_END: u32 = 2;
}

/// Access mode constants for access()/faccessat().
pub mod access {
    pub const F_OK: u32 = 0;
    pub const R_OK: u32 = 4;
    pub const W_OK: u32 = 2;
    pub const X_OK: u32 = 1;
}

/// Directory entry type constants (DT_*).
pub mod dirent {
    pub const DT_UNKNOWN: u32 = 0;
    pub const DT_FIFO: u32 = 1;
    pub const DT_CHR: u32 = 2;
    pub const DT_DIR: u32 = 4;
    pub const DT_BLK: u32 = 6;
    pub const DT_REG: u32 = 8;
    pub const DT_LNK: u32 = 10;
    pub const DT_SOCK: u32 = 12;
}

/// File mode and type constants (S_*).
pub mod mode {
    // File type mask and values
    pub const S_IFMT: u32 = 0o170000;
    pub const S_IFSOCK: u32 = 0o140000;
    pub const S_IFLNK: u32 = 0o120000;
    pub const S_IFREG: u32 = 0o100000;
    pub const S_IFBLK: u32 = 0o060000;
    pub const S_IFDIR: u32 = 0o040000;
    pub const S_IFCHR: u32 = 0o020000;
    pub const S_IFIFO: u32 = 0o010000;

    // Owner permissions
    pub const S_IRWXU: u32 = 0o700;
    pub const S_IRUSR: u32 = 0o400;
    pub const S_IWUSR: u32 = 0o200;
    pub const S_IXUSR: u32 = 0o100;

    // Group permissions
    pub const S_IRWXG: u32 = 0o070;
    pub const S_IRGRP: u32 = 0o040;
    pub const S_IWGRP: u32 = 0o020;
    pub const S_IXGRP: u32 = 0o010;

    // Other permissions
    pub const S_IRWXO: u32 = 0o007;
    pub const S_IROTH: u32 = 0o004;
    pub const S_IWOTH: u32 = 0o002;
    pub const S_IXOTH: u32 = 0o001;
}

/// Shared-memory channel layout offsets and sizes.
///
/// Channel layout (i64 args for wasm32/wasm64 dual ABI):
///   Offset  Size  Field
///   0       4B    status (i32 atomic — must stay i32 for Atomics.wait32)
///   4       4B    syscall number (i32)
///   8       48B   arguments (6 × i64)
///   56      8B    return value (i64)
///   64      4B    errno (i32)
///   68      4B    reserved/pad
///   72      64KB  data transfer buffer
pub mod channel {
    /// Byte offset of the status field (i32, atomic).
    pub const STATUS_OFFSET: usize = 0;
    /// Byte offset of the syscall number field (i32).
    pub const SYSCALL_OFFSET: usize = 4;
    /// Byte offset of the first argument slot (i64 each, 8 bytes).
    pub const ARGS_OFFSET: usize = 8;
    /// Number of argument slots.
    pub const ARGS_COUNT: usize = 6;
    /// Size of each argument slot in bytes.
    pub const ARG_SIZE: usize = 8;
    /// Byte offset of the return value field (i64).
    pub const RETURN_OFFSET: usize = 56;
    /// Byte offset of the errno field (i32).
    pub const ERRNO_OFFSET: usize = 64;
    /// Byte offset of the data buffer region.
    pub const DATA_OFFSET: usize = 72;
    /// Size of the data buffer.
    pub const DATA_SIZE: usize = 65536;
    /// Total header size before data buffer.
    pub const HEADER_SIZE: usize = 72;
    /// Minimum total size of a channel in bytes (header + 64 KiB data buffer).
    pub const MIN_CHANNEL_SIZE: usize = HEADER_SIZE + DATA_SIZE;

    // Signal delivery area — last 48 bytes of the data buffer.
    // After each syscall, if a signal with a Handler disposition is pending,
    // the kernel writes delivery info here so the glue code can invoke it.
    /// Base offset of signal delivery area.
    pub const SIG_BASE: usize = DATA_OFFSET + DATA_SIZE - 48;
    /// Signal number to deliver (u32). 0 = no signal.
    pub const SIG_SIGNUM: usize = SIG_BASE;
    /// Handler function table index (u32).
    pub const SIG_HANDLER: usize = SIG_BASE + 4;
    /// sa_flags from sigaction (u32).
    pub const SIG_FLAGS: usize = SIG_BASE + 8;
    /// Saved blocked mask before handler (u64, little-endian).
    pub const SIG_OLD_MASK: usize = SIG_BASE + 16;
}

/// Stat structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout that can be
/// shared across the Wasm shared-memory boundary.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct WasmStat {
    pub st_dev: u64,
    pub st_ino: u64,
    pub st_mode: u32,
    pub st_nlink: u32,
    pub st_uid: u32,
    pub st_gid: u32,
    pub st_size: u64,
    pub st_atime_sec: u64,
    pub st_atime_nsec: u32,
    pub st_mtime_sec: u64,
    pub st_mtime_nsec: u32,
    pub st_ctime_sec: u64,
    pub st_ctime_nsec: u32,
    pub _pad: u32,
}

/// Directory entry structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout that can be
/// shared across the Wasm shared-memory boundary.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct WasmDirent {
    pub d_ino: u64,
    pub d_type: u32,
    pub d_namlen: u32,
}

/// flock structure for advisory record locking.
///
/// Matches musl wasm32 layout: `short l_type, short l_whence` (with padding
/// to align off_t fields to 8 bytes), `off_t l_start`, `off_t l_len`,
/// `pid_t l_pid`, plus trailing padding for 8-byte struct alignment.
///
/// Verified offsets: l_type=0, l_whence=2, l_start=8, l_len=16, l_pid=24.
/// Total size: 32 bytes.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct WasmFlock {
    pub l_type: i16,   // F_RDLCK, F_WRLCK, F_UNLCK (short)
    pub l_whence: i16, // SEEK_SET, SEEK_CUR, SEEK_END (short)
    pub _pad1: u32,    // padding to align l_start to 8 bytes
    pub l_start: i64,  // offset (off_t = long long on wasm32)
    pub l_len: i64,    // length (0 = to end of file)
    pub l_pid: u32,    // process ID (pid_t = int)
    pub _pad2: u32,    // trailing padding for struct alignment
}

/// POSIX signal constants.
pub mod signal {
    // Standard POSIX signals
    pub const SIGHUP: u32 = 1;
    pub const SIGINT: u32 = 2;
    pub const SIGQUIT: u32 = 3;
    pub const SIGILL: u32 = 4;
    pub const SIGTRAP: u32 = 5;
    pub const SIGABRT: u32 = 6;
    pub const SIGBUS: u32 = 7;
    pub const SIGFPE: u32 = 8;
    pub const SIGKILL: u32 = 9;
    pub const SIGUSR1: u32 = 10;
    pub const SIGUSR2: u32 = 12;
    pub const SIGPIPE: u32 = 13;
    pub const SIGALRM: u32 = 14;
    pub const SIGTERM: u32 = 15;
    pub const SIGCHLD: u32 = 17;
    pub const SIGCONT: u32 = 18;
    pub const SIGSTOP: u32 = 19;
    pub const SIGTSTP: u32 = 20;
    pub const SIGXCPU: u32 = 24;
    pub const SIGXFSZ: u32 = 25;
    pub const SIGWINCH: u32 = 28;

    // One past the maximum signal number (matches musl _NSIG=65).
    // Valid signals are 1..NSIG-1 (i.e. 1..64 inclusive).
    pub const NSIG: u32 = 65;

    // Signal handler special values
    pub const SIG_DFL: u32 = 0;
    pub const SIG_IGN: u32 = 1;

    // sigprocmask how values
    pub const SIG_BLOCK: u32 = 0;
    pub const SIG_UNBLOCK: u32 = 1;
    pub const SIG_SETMASK: u32 = 2;

    // sigaction sa_flags
    pub const SA_RESTART: u32 = 0x10000000;
    pub const SA_NOCLDSTOP: u32 = 1;
    pub const SA_NOCLDWAIT: u32 = 2;
    pub const SA_SIGINFO: u32 = 4;
    pub const SA_RESTORER: u32 = 0x04000000;

    // Default actions
    pub const SA_DEFAULT_TERM: u32 = 0; // Terminate
    pub const SA_DEFAULT_IGN: u32 = 1; // Ignore
    pub const SA_DEFAULT_CORE: u32 = 2; // Core dump (treated as terminate in Wasm)
    pub const SA_DEFAULT_STOP: u32 = 3; // Stop (not supported in Wasm)
    pub const SA_DEFAULT_CONT: u32 = 4; // Continue (not supported in Wasm)
}

/// Resource limit constants for getrlimit/setrlimit.
pub mod rlimit {
    pub const RLIMIT_CPU: u32 = 0;
    pub const RLIMIT_FSIZE: u32 = 1;
    pub const RLIMIT_DATA: u32 = 2;
    pub const RLIMIT_STACK: u32 = 3;
    pub const RLIMIT_CORE: u32 = 4;
    pub const RLIMIT_NOFILE: u32 = 7;
    pub const RLIMIT_AS: u32 = 9;
    pub const RLIMIT_NPROC: u32 = 6;
    pub const RLIM_NLIMITS: usize = 16;
    pub const RLIM_INFINITY: u64 = u64::MAX;
}

/// getrusage who constants.
pub mod rusage {
    pub const RUSAGE_SELF: i32 = 0;
    pub const RUSAGE_CHILDREN: i32 = -1;
}

/// select() constants.
pub mod select {
    pub const FD_SETSIZE: usize = 1024;
    /// Size of fd_set in bytes (FD_SETSIZE / 8).
    pub const FD_SET_BYTES: usize = FD_SETSIZE / 8;
}

/// Clock ID constants for clock_gettime/clock_settime.
pub mod clock {
    pub const CLOCK_REALTIME: u32 = 0;
    pub const CLOCK_MONOTONIC: u32 = 1;
    pub const CLOCK_PROCESS_CPUTIME_ID: u32 = 2;
    pub const CLOCK_THREAD_CPUTIME_ID: u32 = 3;
}

/// Timespec structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout that can be
/// shared across the Wasm shared-memory boundary.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct WasmTimespec {
    pub tv_sec: i64,
    pub tv_nsec: i64,
}

/// Poll file descriptor structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout that can be
/// shared across the Wasm shared-memory boundary.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WasmPollFd {
    pub fd: i32,
    pub events: i16,
    pub revents: i16,
}

/// Statfs structure for the Wasm POSIX interface.
///
/// Uses `repr(C)` for a stable, predictable memory layout matching
/// musl's struct statfs on 32-bit targets.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WasmStatfs {
    pub f_type: u32,
    pub f_bsize: u32,
    pub f_blocks: u64,
    pub f_bfree: u64,
    pub f_bavail: u64,
    pub f_files: u64,
    pub f_ffree: u64,
    pub f_fsid: u64,
    pub f_namelen: u32,
    pub f_frsize: u32,
    pub f_flags: u32,
    pub _pad: u32,
}

/// Process memory layout ABI metadata.
///
/// Rust owns this declaration so the structural ABI snapshot, generated host
/// bindings, and JavaScript memory allocator all change together. Any value
/// change here changes the process/user-program ABI and requires bumping
/// [`ABI_VERSION`].
pub mod process_memory {
    /// WebAssembly linear memory page size in bytes.
    pub const WASM_PAGE_SIZE: u32 = 65_536;

    /// Host policy default for process maximum memory pages. This is not a
    /// user-program promise, but generated host bindings expose it next to the
    /// layout constants so host defaults are centralized.
    pub const DEFAULT_MAX_PAGES: u32 = 16_384;

    /// Minimum initial page count used when a binary does not import more.
    pub const DEFAULT_INITIAL_PAGES: u32 = 17;

    /// Host default concurrent pthread limit when a program declares
    /// [`THREAD_SLOTS_USE_HOST_DEFAULT`]. This is intentionally an arbitrary
    /// high default to avoid surprising pthread_create failures for most
    /// programs; hosts can tune it through the kernel worker options.
    pub const DEFAULT_THREAD_SLOTS: u32 = 1024;

    /// A process-wasm declaration value meaning "use the host default".
    pub const THREAD_SLOTS_USE_HOST_DEFAULT: i32 = -1;

    /// A process-wasm declaration value meaning "allow no pthreads".
    pub const THREAD_SLOTS_NONE: i32 = 0;

    /// Export name of the process-wasm constant-return function that declares
    /// the requested concurrent pthread limit.
    pub const THREAD_SLOT_DECL_EXPORT: &str = "__wasm_posix_thread_slots";

    /// Legacy kernel MemoryManager::MMAP_BASE. Compact hosts override this
    /// per process but still expose the legacy boundary for compatibility.
    pub const LEGACY_MMAP_BASE: u32 = 0x0400_0000;

    /// Fallback initial brk when a binary does not export `__heap_base`.
    pub const FALLBACK_BRK_BASE: u32 = 0x0100_0000;

    /// Size of one fork save buffer in bytes.
    pub const FORK_SAVE_BUFFER_SIZE: u32 = 16 * 1024;

    /// Main-thread fork-save/scratch page, relative to `controlBasePage`.
    pub const MAIN_FORK_SAVE_PAGE: u32 = 0;

    /// Main-thread syscall channel primary page, relative to
    /// `controlBasePage`.
    pub const MAIN_CHANNEL_PRIMARY_PAGE: u32 = 1;

    /// Main-thread syscall channel spill page, relative to `controlBasePage`.
    pub const MAIN_CHANNEL_SPILL_PAGE: u32 = 2;

    /// TLS/control page, relative to a pthread slot start page.
    pub const THREAD_SLOT_TLS_PAGE: u32 = 0;

    /// Fork-save/scratch page, relative to a pthread slot start page.
    pub const THREAD_SLOT_FORK_SAVE_PAGE: u32 = 1;

    /// Syscall channel primary page, relative to a pthread slot start page.
    pub const THREAD_SLOT_CHANNEL_PRIMARY_PAGE: u32 = 2;

    /// Syscall channel spill page, relative to a pthread slot start page.
    pub const THREAD_SLOT_CHANNEL_SPILL_PAGE: u32 = 3;

    /// Pages reserved for one pthread control slot.
    pub const PAGES_PER_THREAD_SLOT: u32 = 4;
}

/// ABI-surface constants captured by the structural ABI snapshot.
///
/// Any addition, removal, or value change in this module is, by definition,
/// an ABI change and requires bumping [`ABI_VERSION`].
pub mod abi {
    /// Name of the wasm custom section in which user programs embed their
    /// ABI version (single little-endian u32). The kernel host rejects
    /// binaries whose value does not match [`crate::ABI_VERSION`].
    pub const ABI_CUSTOM_SECTION: &str = "wasm-posix-abi";

    /// Name of the wasm global exported by the kernel that carries its
    /// [`crate::ABI_VERSION`] at load time (i32, immutable).
    pub const ABI_KERNEL_EXPORT: &str = "__abi_version";

    /// Globals that each user process instance is expected to expose so
    /// the host can thread channel / TLS state through fork and exec.
    pub const PROCESS_EXPECTED_GLOBALS: &[&str] = &["__channel_base", "__tls_base"];

    /// Patterns (applied as prefix match) for kernel-wasm exports that
    /// are implementation details of the toolchain, not part of the
    /// host/kernel ABI. The snapshot excludes any export whose name
    /// starts with one of these.
    ///
    /// Adding or removing a pattern is itself an ABI-relevant change —
    /// it affects what the snapshot tracks. The check will flag it.
    pub const EXPORT_DENY_PREFIXES: &[&str] = &[
        "__wasm_call_",
        "__wasm_init_",
        "__wasm_apply_",
        "__llvm_",
        // LLD/wasm-ld emits __tls_align / __tls_base / __tls_size as a
        // side-effect of TLS-aware codegen. Whether they appear depends
        // on the toolchain version (newer nightlies optimise them away
        // when no kernel-internal code references them externally), and
        // nothing in the host runtime reads them from the kernel module
        // (host/src/worker-main.ts reads __tls_base only from user-program
        // instances). Filtering them keeps the snapshot stable across
        // toolchain churn.
        "__tls_",
    ];

    /// Exact-name variant of [`EXPORT_DENY_PREFIXES`] — exports we
    /// never track regardless of toolchain tweaks.
    pub const EXPORT_DENY_EXACT: &[&str] = &[
        "__dso_handle",
        "__data_end",
        "__heap_base",
        "__heap_end",
        "__memory_base",
        "__table_base",
        "__global_base",
    ];

    /// Prefix patterns for exports whose *value* is part of the ABI,
    /// not just their type. The snapshot captures the initial value of
    /// matching immutable globals.
    ///
    /// Today this is just `__abi_*`. The convention: anything that
    /// declares "this value is the contract" gets an `__abi_` prefix
    /// and is tracked for value-identity. Everything else is tracked
    /// for existence + type, because its value is linker- or
    /// runtime-determined and would churn without encoding real ABI
    /// changes.
    pub const ABI_VALUE_CAPTURE_PREFIXES: &[&str] = &["__abi_"];

    /// Binary manifest exported by the kernel so host adapters can validate the
    /// boot-time host/kernel contract from Rust-owned metadata.
    #[repr(C)]
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct HostAdapterManifest {
        pub magic: u32,
        pub manifest_version: u16,
        pub manifest_size: u16,
        pub abi_version: u32,
        pub required_host_adapter_version: u32,
        pub required_worker_features: u32,
        pub optional_kernel_features: u32,
        pub channel_header_size: u32,
        pub channel_data_offset: u32,
        pub channel_data_size: u32,
        pub channel_min_size: u32,
    }

    pub const HOST_ADAPTER_MANIFEST_MAGIC: u32 = 0x4d4b_5057; // "WPKM", little-endian.
    pub const HOST_ADAPTER_MANIFEST_VERSION: u16 = 1;
    pub const HOST_ADAPTER_VERSION: u32 = 1;
    pub const HOST_ADAPTER_MANIFEST_SIZE: u16 = core::mem::size_of::<HostAdapterManifest>() as u16;

    pub const HOST_FEATURE_SHARED_ARRAY_BUFFER: u32 = 1 << 0;
    pub const HOST_FEATURE_ATOMICS_WAIT: u32 = 1 << 1;
    pub const HOST_FEATURE_ATOMICS_WAIT_ASYNC: u32 = 1 << 2;

    pub const HOST_ADAPTER_REQUIRED_WORKER_FEATURES: u32 = HOST_FEATURE_SHARED_ARRAY_BUFFER
        | HOST_FEATURE_ATOMICS_WAIT
        | HOST_FEATURE_ATOMICS_WAIT_ASYNC;
    pub const HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES: u32 = 0;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct HostAdapterFeature {
        pub name: &'static str,
        pub bit: u32,
    }

    pub const HOST_ADAPTER_WORKER_FEATURES: &[HostAdapterFeature] = &[
        HostAdapterFeature {
            name: "atomics_wait",
            bit: HOST_FEATURE_ATOMICS_WAIT,
        },
        HostAdapterFeature {
            name: "atomics_wait_async",
            bit: HOST_FEATURE_ATOMICS_WAIT_ASYNC,
        },
        HostAdapterFeature {
            name: "shared_array_buffer",
            bit: HOST_FEATURE_SHARED_ARRAY_BUFFER,
        },
    ];

    pub const HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS: &[&str] = &[
        "__abi_version",
        "kernel_alloc_scratch",
        "kernel_create_process",
        "kernel_get_parent_pid",
        "kernel_handle_channel",
        "kernel_host_adapter_manifest_len",
        "kernel_host_adapter_manifest_ptr",
        "kernel_mark_process_signaled",
        "kernel_reap_exited_child",
        "kernel_remove_process",
        "kernel_wait4_poll",
    ];

    pub const HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS: &[&str] = &[
        "kernel_reserve_host_region",
        "kernel_reserve_host_region_at",
        "kernel_set_cwd",
        "kernel_set_max_addr",
        "kernel_set_mmap_base",
        "kernel_set_process_argv",
    ];

    pub static HOST_ADAPTER_MANIFEST: HostAdapterManifest = HostAdapterManifest {
        magic: HOST_ADAPTER_MANIFEST_MAGIC,
        manifest_version: HOST_ADAPTER_MANIFEST_VERSION,
        manifest_size: HOST_ADAPTER_MANIFEST_SIZE,
        abi_version: crate::ABI_VERSION,
        required_host_adapter_version: HOST_ADAPTER_VERSION,
        required_worker_features: HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
        optional_kernel_features: HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES,
        channel_header_size: crate::channel::HEADER_SIZE as u32,
        channel_data_offset: crate::channel::DATA_OFFSET as u32,
        channel_data_size: crate::channel::DATA_SIZE as u32,
        channel_min_size: crate::channel::MIN_CHANNEL_SIZE as u32,
    };

    /// One named syscall number in the host/kernel ABI metadata.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct AbiSyscallNumber {
        pub name: &'static str,
        pub number: u32,
    }

    /// ABI-visible syscall numbers that are not yet represented in
    /// [`crate::Syscall`].
    ///
    /// These include Linux-like extended calls handled by `wasm_api.rs`, plus
    /// host-adapter control calls that enter through the normal syscall
    /// channel. Fork/exec/spawn calls caught before normal dispatch stay in
    /// [`host_intercepted`] instead.
    pub mod extended_syscalls {
        use super::AbiSyscallNumber;

        pub const SYS_LLSEEK: u32 = 119;
        pub const SYS_GETRANDOM: u32 = 120;
        pub const SYS_FLOCK: u32 = 121;
        pub const SYS_FUTEX: u32 = 200;
        pub const SYS_CLONE: u32 = 201;
        pub const SYS_GETTID: u32 = 202;
        pub const SYS_SET_TID_ADDRESS: u32 = 203;
        pub const SYS_RT_SIGQUEUEINFO: u32 = 205;
        pub const SYS_RT_SIGPENDING: u32 = 206;
        pub const SYS_RT_SIGTIMEDWAIT: u32 = 207;
        pub const SYS_RT_SIGRETURN: u32 = 208;
        pub const SYS_SIGALTSTACK: u32 = 209;
        pub const SYS_GETPGID: u32 = 214;
        pub const SYS_SETREUID: u32 = 215;
        pub const SYS_SETREGID: u32 = 216;
        pub const SYS_PRCTL: u32 = 223;
        pub const SYS_GETITIMER: u32 = 224;
        pub const SYS_SETITIMER: u32 = 225;
        pub const SYS_CLOCK_SETTIME: u32 = 226;
        pub const SYS_SCHED_YIELD: u32 = 229;
        pub const SYS_SCHED_GETPARAM: u32 = 230;
        pub const SYS_SCHED_RR_GET_INTERVAL: u32 = 236;
        pub const SYS_EPOLL_CREATE1: u32 = 239;
        pub const SYS_EPOLL_CTL: u32 = 240;
        pub const SYS_EPOLL_PWAIT: u32 = 241;
        pub const SYS_PRLIMIT64: u32 = 250;
        pub const SYS_PPOLL: u32 = 251;
        pub const SYS_PSELECT6: u32 = 252;
        pub const SYS_STATX: u32 = 260;
        pub const SYS_SET_ROBUST_LIST: u32 = 261;
        pub const SYS_GET_ROBUST_LIST: u32 = 262;
        pub const SYS_MKNOD: u32 = 271;
        pub const SYS_MKNODAT: u32 = 272;
        pub const SYS_MSYNC: u32 = 278;
        pub const SYS_WAITID: u32 = 288;
        pub const SYS_SENDFILE: u32 = 294;
        pub const SYS_PREADV: u32 = 295;
        pub const SYS_PWRITEV: u32 = 296;
        pub const SYS_FALLOCATE: u32 = 308;
        pub const SYS_TIMER_CREATE: u32 = 326;
        pub const SYS_TIMER_SETTIME: u32 = 327;
        pub const SYS_TIMER_GETTIME: u32 = 328;
        pub const SYS_TIMER_GETOVERRUN: u32 = 329;
        pub const SYS_TIMER_DELETE: u32 = 330;
        pub const SYS_MQ_OPEN: u32 = 331;
        pub const SYS_MQ_UNLINK: u32 = 332;
        pub const SYS_MQ_TIMEDSEND: u32 = 333;
        pub const SYS_MQ_TIMEDRECEIVE: u32 = 334;
        pub const SYS_MQ_NOTIFY: u32 = 335;
        pub const SYS_MQ_GETSETATTR: u32 = 336;
        pub const SYS_MSGGET: u32 = 337;
        pub const SYS_MSGRCV: u32 = 338;
        pub const SYS_MSGSND: u32 = 339;
        pub const SYS_MSGCTL: u32 = 340;
        pub const SYS_SEMGET: u32 = 341;
        pub const SYS_SEMOP: u32 = 342;
        pub const SYS_SEMCTL: u32 = 343;
        pub const SYS_SHMGET: u32 = 344;
        pub const SYS_SHMAT: u32 = 345;
        pub const SYS_SHMDT: u32 = 346;
        pub const SYS_SHMCTL: u32 = 347;
        pub const SYS_EPOLL_CREATE: u32 = 378;
        pub const SYS_EPOLL_WAIT: u32 = 379;
        pub const SYS_FACCESSAT2: u32 = 382;
        pub const SYS_FCHMODAT2: u32 = 383;
        pub const SYS_ACCEPT4: u32 = 384;
        pub const SYS_EXIT_GROUP: u32 = 387;
        pub const SYS_THREAD_CANCEL: u32 = 415;

        pub const SYSCALLS: &[AbiSyscallNumber] = &[
            AbiSyscallNumber {
                name: "Llseek",
                number: SYS_LLSEEK,
            },
            AbiSyscallNumber {
                name: "Getrandom",
                number: SYS_GETRANDOM,
            },
            AbiSyscallNumber {
                name: "Flock",
                number: SYS_FLOCK,
            },
            AbiSyscallNumber {
                name: "Futex",
                number: SYS_FUTEX,
            },
            AbiSyscallNumber {
                name: "Clone",
                number: SYS_CLONE,
            },
            AbiSyscallNumber {
                name: "Gettid",
                number: SYS_GETTID,
            },
            AbiSyscallNumber {
                name: "SetTidAddress",
                number: SYS_SET_TID_ADDRESS,
            },
            AbiSyscallNumber {
                name: "RtSigqueueinfo",
                number: SYS_RT_SIGQUEUEINFO,
            },
            AbiSyscallNumber {
                name: "RtSigpending",
                number: SYS_RT_SIGPENDING,
            },
            AbiSyscallNumber {
                name: "RtSigtimedwait",
                number: SYS_RT_SIGTIMEDWAIT,
            },
            AbiSyscallNumber {
                name: "RtSigreturn",
                number: SYS_RT_SIGRETURN,
            },
            AbiSyscallNumber {
                name: "Sigaltstack",
                number: SYS_SIGALTSTACK,
            },
            AbiSyscallNumber {
                name: "Getpgid",
                number: SYS_GETPGID,
            },
            AbiSyscallNumber {
                name: "Setreuid",
                number: SYS_SETREUID,
            },
            AbiSyscallNumber {
                name: "Setregid",
                number: SYS_SETREGID,
            },
            AbiSyscallNumber {
                name: "Prctl",
                number: SYS_PRCTL,
            },
            AbiSyscallNumber {
                name: "Getitimer",
                number: SYS_GETITIMER,
            },
            AbiSyscallNumber {
                name: "Setitimer",
                number: SYS_SETITIMER,
            },
            AbiSyscallNumber {
                name: "ClockSettime",
                number: SYS_CLOCK_SETTIME,
            },
            AbiSyscallNumber {
                name: "SchedYield",
                number: SYS_SCHED_YIELD,
            },
            AbiSyscallNumber {
                name: "SchedGetparam",
                number: SYS_SCHED_GETPARAM,
            },
            AbiSyscallNumber {
                name: "SchedRrGetInterval",
                number: SYS_SCHED_RR_GET_INTERVAL,
            },
            AbiSyscallNumber {
                name: "EpollCreate1",
                number: SYS_EPOLL_CREATE1,
            },
            AbiSyscallNumber {
                name: "EpollCtl",
                number: SYS_EPOLL_CTL,
            },
            AbiSyscallNumber {
                name: "EpollPwait",
                number: SYS_EPOLL_PWAIT,
            },
            AbiSyscallNumber {
                name: "Prlimit64",
                number: SYS_PRLIMIT64,
            },
            AbiSyscallNumber {
                name: "Ppoll",
                number: SYS_PPOLL,
            },
            AbiSyscallNumber {
                name: "Pselect6",
                number: SYS_PSELECT6,
            },
            AbiSyscallNumber {
                name: "Statx",
                number: SYS_STATX,
            },
            AbiSyscallNumber {
                name: "SetRobustList",
                number: SYS_SET_ROBUST_LIST,
            },
            AbiSyscallNumber {
                name: "GetRobustList",
                number: SYS_GET_ROBUST_LIST,
            },
            AbiSyscallNumber {
                name: "Mknod",
                number: SYS_MKNOD,
            },
            AbiSyscallNumber {
                name: "Mknodat",
                number: SYS_MKNODAT,
            },
            AbiSyscallNumber {
                name: "Msync",
                number: SYS_MSYNC,
            },
            AbiSyscallNumber {
                name: "Waitid",
                number: SYS_WAITID,
            },
            AbiSyscallNumber {
                name: "Sendfile",
                number: SYS_SENDFILE,
            },
            AbiSyscallNumber {
                name: "Preadv",
                number: SYS_PREADV,
            },
            AbiSyscallNumber {
                name: "Pwritev",
                number: SYS_PWRITEV,
            },
            AbiSyscallNumber {
                name: "Fallocate",
                number: SYS_FALLOCATE,
            },
            AbiSyscallNumber {
                name: "TimerCreate",
                number: SYS_TIMER_CREATE,
            },
            AbiSyscallNumber {
                name: "TimerSettime",
                number: SYS_TIMER_SETTIME,
            },
            AbiSyscallNumber {
                name: "TimerGettime",
                number: SYS_TIMER_GETTIME,
            },
            AbiSyscallNumber {
                name: "TimerGetoverrun",
                number: SYS_TIMER_GETOVERRUN,
            },
            AbiSyscallNumber {
                name: "TimerDelete",
                number: SYS_TIMER_DELETE,
            },
            AbiSyscallNumber {
                name: "MqOpen",
                number: SYS_MQ_OPEN,
            },
            AbiSyscallNumber {
                name: "MqUnlink",
                number: SYS_MQ_UNLINK,
            },
            AbiSyscallNumber {
                name: "MqTimedsend",
                number: SYS_MQ_TIMEDSEND,
            },
            AbiSyscallNumber {
                name: "MqTimedreceive",
                number: SYS_MQ_TIMEDRECEIVE,
            },
            AbiSyscallNumber {
                name: "MqNotify",
                number: SYS_MQ_NOTIFY,
            },
            AbiSyscallNumber {
                name: "MqGetsetattr",
                number: SYS_MQ_GETSETATTR,
            },
            AbiSyscallNumber {
                name: "Msgget",
                number: SYS_MSGGET,
            },
            AbiSyscallNumber {
                name: "Msgrcv",
                number: SYS_MSGRCV,
            },
            AbiSyscallNumber {
                name: "Msgsnd",
                number: SYS_MSGSND,
            },
            AbiSyscallNumber {
                name: "Msgctl",
                number: SYS_MSGCTL,
            },
            AbiSyscallNumber {
                name: "Semget",
                number: SYS_SEMGET,
            },
            AbiSyscallNumber {
                name: "Semop",
                number: SYS_SEMOP,
            },
            AbiSyscallNumber {
                name: "Semctl",
                number: SYS_SEMCTL,
            },
            AbiSyscallNumber {
                name: "Shmget",
                number: SYS_SHMGET,
            },
            AbiSyscallNumber {
                name: "Shmat",
                number: SYS_SHMAT,
            },
            AbiSyscallNumber {
                name: "Shmdt",
                number: SYS_SHMDT,
            },
            AbiSyscallNumber {
                name: "Shmctl",
                number: SYS_SHMCTL,
            },
            AbiSyscallNumber {
                name: "EpollCreate",
                number: SYS_EPOLL_CREATE,
            },
            AbiSyscallNumber {
                name: "EpollWait",
                number: SYS_EPOLL_WAIT,
            },
            AbiSyscallNumber {
                name: "Faccessat2",
                number: SYS_FACCESSAT2,
            },
            AbiSyscallNumber {
                name: "Fchmodat2",
                number: SYS_FCHMODAT2,
            },
            AbiSyscallNumber {
                name: "Accept4",
                number: SYS_ACCEPT4,
            },
            AbiSyscallNumber {
                name: "ExitGroup",
                number: SYS_EXIT_GROUP,
            },
            AbiSyscallNumber {
                name: "ThreadCancel",
                number: SYS_THREAD_CANCEL,
            },
        ];
    }

    /// Host-intercepted syscall numbers (caught by `host/src/kernel-worker.ts`
    /// before reaching the kernel's syscall dispatcher). The kernel never sees
    /// these on the channel — the host calls the corresponding `kernel_*`
    /// export directly.
    ///
    /// These exist outside the [`crate::Syscall`] enum because that enum is for
    /// kernel-dispatched syscalls only. Adding/removing a value here is an ABI
    /// change and requires bumping [`crate::ABI_VERSION`].
    pub mod host_intercepted {
        /// Non-forking `posix_spawn` (this kernel's invention; no Linux
        /// equivalent). Host calls `kernel_spawn_process`. See
        /// `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`.
        ///
        /// Numbered 500 to sit clear of every Linux syscall numbering
        /// scheme and of our kernel-side dispatch table in `wasm_api.rs`
        /// (highest used: 415). The original plan picked 214 to neighbour
        /// SYS_FORK, but 214 collides with the kernel's existing
        /// SYS_GETPGID handler — host-interception alone wouldn't help
        /// because every legitimate getpgid call would also be caught.
        pub const SYS_SPAWN: u32 = 500;

        /// Documented for completeness — also defined in
        /// `libc/glue/channel_syscall.c` and `host/src/kernel-worker.ts`.
        pub const SYS_EXECVE: u32 = 211;
        pub const SYS_FORK: u32 = 212;
        pub const SYS_VFORK: u32 = 213;
        pub const SYS_EXECVEAT: u32 = 386;
    }

    /// Decide whether a kernel-wasm export name should appear in the
    /// snapshot. Implementation-detail symbols (per
    /// [`EXPORT_DENY_PREFIXES`] / [`EXPORT_DENY_EXACT`]) are filtered
    /// out; everything else is kept.
    pub fn export_is_tracked(name: &str) -> bool {
        if EXPORT_DENY_EXACT.iter().any(|&n| n == name) {
            return false;
        }
        if EXPORT_DENY_PREFIXES.iter().any(|&p| name.starts_with(p)) {
            return false;
        }
        true
    }

    /// Decide whether the initial value of a matching immutable global
    /// should be captured in the snapshot.
    pub fn export_value_is_tracked(name: &str) -> bool {
        ABI_VALUE_CAPTURE_PREFIXES
            .iter()
            .any(|&p| name.starts_with(p))
    }

    #[cfg(test)]
    mod tests {
        use super::{
            HOST_ADAPTER_MANIFEST, HOST_ADAPTER_MANIFEST_MAGIC, HOST_ADAPTER_MANIFEST_SIZE,
            HOST_ADAPTER_MANIFEST_VERSION, HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS,
            HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS, HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
            HOST_ADAPTER_VERSION, HOST_ADAPTER_WORKER_FEATURES, extended_syscalls::SYSCALLS,
        };
        use crate::Syscall;

        #[test]
        fn extended_syscalls_are_sorted_unique_and_do_not_overlap_core_enum() {
            let mut prev = None;
            for syscall in SYSCALLS {
                if let Some(prev) = prev {
                    assert!(
                        prev < syscall.number,
                        "extended syscall metadata must be sorted and unique"
                    );
                }
                assert!(
                    Syscall::from_u32(syscall.number).is_none(),
                    "extended syscall {} overlaps core Syscall enum",
                    syscall.name
                );
                prev = Some(syscall.number);
            }
        }

        #[test]
        fn host_adapter_manifest_matches_channel_and_abi_metadata() {
            assert_eq!(HOST_ADAPTER_MANIFEST.magic, HOST_ADAPTER_MANIFEST_MAGIC);
            assert_eq!(
                HOST_ADAPTER_MANIFEST.manifest_version,
                HOST_ADAPTER_MANIFEST_VERSION
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.manifest_size,
                HOST_ADAPTER_MANIFEST_SIZE
            );
            assert_eq!(HOST_ADAPTER_MANIFEST.abi_version, crate::ABI_VERSION);
            assert_eq!(
                HOST_ADAPTER_MANIFEST.required_host_adapter_version,
                HOST_ADAPTER_VERSION
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.required_worker_features,
                HOST_ADAPTER_REQUIRED_WORKER_FEATURES
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.channel_header_size,
                crate::channel::HEADER_SIZE as u32
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.channel_data_offset,
                crate::channel::DATA_OFFSET as u32
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.channel_data_size,
                crate::channel::DATA_SIZE as u32
            );
            assert_eq!(
                HOST_ADAPTER_MANIFEST.channel_min_size,
                crate::channel::MIN_CHANNEL_SIZE as u32
            );
        }

        #[test]
        fn host_adapter_export_and_feature_lists_are_sorted_unique() {
            assert_sorted_unique(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS);
            assert_sorted_unique(HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS);

            let mut required_worker_features = 0;
            let mut previous_name = "";
            for feature in HOST_ADAPTER_WORKER_FEATURES {
                assert!(previous_name < feature.name, "features must be sorted");
                assert_ne!(feature.bit, 0, "feature bit must be non-zero");
                assert_eq!(
                    feature.bit.count_ones(),
                    1,
                    "feature bit must be a single bit"
                );
                assert_eq!(
                    required_worker_features & feature.bit,
                    0,
                    "feature bits must be unique"
                );
                required_worker_features |= feature.bit;
                previous_name = feature.name;
            }
            assert_eq!(
                required_worker_features,
                HOST_ADAPTER_REQUIRED_WORKER_FEATURES
            );
        }

        fn assert_sorted_unique(items: &[&str]) {
            let mut prev = None;
            for item in items {
                if let Some(prev) = prev {
                    assert!(prev < *item, "items must be sorted and unique");
                }
                prev = Some(*item);
            }
        }
    }
}

/// Linux fbdev ABI constants and marshalled structs.
///
/// These mirror what musl exposes via `<linux/fb.h>` to programs built with
/// `wasm32posix-cc`. Field order, sizes, and offsets must match the Linux
/// ABI exactly: any change here is a binary-level break and requires
/// bumping [`ABI_VERSION`] (see crate root) and updating
/// `abi/snapshot.json` in the same commit.
pub mod fbdev {
    /// `FBIOGET_VSCREENINFO` — read variable screen info.
    pub const FBIOGET_VSCREENINFO: u32 = 0x4600;
    /// `FBIOPUT_VSCREENINFO` — write variable screen info (mode set).
    pub const FBIOPUT_VSCREENINFO: u32 = 0x4601;
    /// `FBIOGET_FSCREENINFO` — read fixed screen info.
    pub const FBIOGET_FSCREENINFO: u32 = 0x4602;
    /// `FBIOPAN_DISPLAY` — pan / present.
    pub const FBIOPAN_DISPLAY: u32 = 0x4606;

    /// `FB_TYPE_PACKED_PIXELS`.
    pub const FB_TYPE_PACKED_PIXELS: u32 = 0;
    /// `FB_VISUAL_TRUECOLOR`.
    pub const FB_VISUAL_TRUECOLOR: u32 = 2;

    /// Linux `struct fb_bitfield` — one channel of pixel layout.
    /// Total: 12 bytes. No padding.
    #[derive(Debug, Clone, Copy, Default)]
    #[repr(C)]
    pub struct FbBitfield {
        pub offset: u32,
        pub length: u32,
        pub msb_right: u32,
    }

    /// Linux `struct fb_var_screeninfo` — variable screen info.
    ///
    /// Total: 160 bytes. Field offsets are part of the ABI.
    #[derive(Debug, Clone, Copy, Default)]
    #[repr(C)]
    pub struct FbVarScreenInfo {
        pub xres: u32,           // 0
        pub yres: u32,           // 4
        pub xres_virtual: u32,   // 8
        pub yres_virtual: u32,   // 12
        pub xoffset: u32,        // 16
        pub yoffset: u32,        // 20
        pub bits_per_pixel: u32, // 24
        pub grayscale: u32,      // 28
        pub red: FbBitfield,     // 32 (12)
        pub green: FbBitfield,   // 44 (12)
        pub blue: FbBitfield,    // 56 (12)
        pub transp: FbBitfield,  // 68 (12)
        pub nonstd: u32,         // 80
        pub activate: u32,       // 84
        pub height: u32,         // 88
        pub width: u32,          // 92
        pub accel_flags: u32,    // 96
        pub pixclock: u32,       // 100
        pub left_margin: u32,    // 104
        pub right_margin: u32,   // 108
        pub upper_margin: u32,   // 112
        pub lower_margin: u32,   // 116
        pub hsync_len: u32,      // 120
        pub vsync_len: u32,      // 124
        pub sync: u32,           // 128
        pub vmode: u32,          // 132
        pub rotate: u32,         // 136
        pub colorspace: u32,     // 140
        pub reserved: [u32; 4],  // 144 (16)
                                 // total: 160
    }

    /// Linux `struct fb_fix_screeninfo` — fixed screen info (32-bit user-space
    /// flavour, total 80 bytes).
    ///
    /// On native Linux this struct uses native pointer width for `smem_start`
    /// and `mmio_start`. fbDOOM only reads `id`, `smem_len`, `line_length`,
    /// `type`, and `visual` — we report 0 for the address-shaped fields,
    /// keeping the struct 32-bit-flavoured to match what musl's
    /// `<linux/fb.h>` exposes to user-space programs built with `wasm32posix-cc`.
    /// The trailing `_pad_to_80` aligns this to the 80-byte size that musl
    /// programs (and the kernel ABI snapshot) expect.
    #[derive(Debug, Clone, Copy, Default)]
    #[repr(C)]
    pub struct FbFixScreenInfo {
        pub id: [u8; 16],         // 0
        pub smem_start: u32,      // 16  (always 0 in our model)
        pub smem_len: u32,        // 20
        pub fb_type: u32,         // 24  (FB_TYPE_PACKED_PIXELS)
        pub type_aux: u32,        // 28
        pub visual: u32,          // 32  (FB_VISUAL_TRUECOLOR)
        pub xpanstep: u16,        // 36
        pub ypanstep: u16,        // 38
        pub ywrapstep: u16,       // 40
        pub _pad: u16,            // 42
        pub line_length: u32,     // 44
        pub mmio_start: u32,      // 48  (always 0)
        pub mmio_len: u32,        // 52
        pub accel: u32,           // 56
        pub capabilities: u16,    // 60
        pub reserved: [u16; 3],   // 62 (6)
        pub _pad_to_80: [u8; 12], // 68 (12) → 80
    }
}

#[cfg(test)]
mod fbdev_tests {
    use super::fbdev::*;
    use core::mem::size_of;

    #[test]
    fn struct_sizes_match_linux_abi() {
        assert_eq!(size_of::<FbBitfield>(), 12);
        assert_eq!(size_of::<FbVarScreenInfo>(), 160);
        assert_eq!(size_of::<FbFixScreenInfo>(), 80);
    }
}

/// OSS (Open Sound System) ABI constants.
///
/// These mirror what glibc / musl expose via `<sys/soundcard.h>` to
/// programs that talk to `/dev/dsp`. We accept the subset fbDOOM (and
/// most real OSS clients) actually emit during init: speed, channel
/// count, format, and a couple of accept-and-acknowledge ops.
///
/// The numeric values are the standard OSS encoding — the same numbers
/// real Linux kernels return — so user-space programs that hard-code
/// these constants (rather than `#include`-ing the header) work
/// unchanged.
pub mod oss {
    // The values below come from the Linux `<sys/soundcard.h>` IOC
    // encoding — the same ones glibc, musl, and any OSS-targeted DOS
    // port hard-code. Matching them exactly lets user programs that
    // skip the header still talk to us.

    /// `SNDCTL_DSP_RESET` — flush + stop. No argument.
    pub const SNDCTL_DSP_RESET: u32 = 0x00005000;
    /// `SNDCTL_DSP_SYNC` — block until output drains. No argument.
    pub const SNDCTL_DSP_SYNC: u32 = 0x00005001;
    /// `SNDCTL_DSP_SPEED` — get/set sample rate. inout: i32 hz.
    pub const SNDCTL_DSP_SPEED: u32 = 0xc0045002;
    /// `SNDCTL_DSP_STEREO` — get/set channel count via boolean. inout: i32 (0=mono, 1=stereo).
    pub const SNDCTL_DSP_STEREO: u32 = 0xc0045003;
    /// `SNDCTL_DSP_GETBLKSIZE` — preferred fragment size. out: i32 bytes.
    pub const SNDCTL_DSP_GETBLKSIZE: u32 = 0xc0045004;
    /// `SNDCTL_DSP_SETFMT` — get/set sample format. inout: i32 AFMT_*.
    pub const SNDCTL_DSP_SETFMT: u32 = 0xc0045005;
    /// `SNDCTL_DSP_CHANNELS` — get/set explicit channel count. inout: i32.
    pub const SNDCTL_DSP_CHANNELS: u32 = 0xc0045006;
    /// `SNDCTL_DSP_GETFMTS` — bitmask of supported formats. out: i32 AFMT_* mask.
    pub const SNDCTL_DSP_GETFMTS: u32 = 0x8004500b;
    /// `SNDCTL_DSP_SETFRAGMENT` — fragment-size hint. inout: i32.
    pub const SNDCTL_DSP_SETFRAGMENT: u32 = 0xc004500a;

    /// `AFMT_S16_LE` — signed 16-bit little-endian. The only format we accept.
    pub const AFMT_S16_LE: u32 = 0x10;
}


/// GLES / EGL ABI: ioctl numbers, opcode tables, and marshalled argument
/// structs for `/dev/dri/renderD128`.
///
/// These are part of the kernel↔user-space ABI: any change to the ioctl
/// numbers, the marshalled struct layouts, or surface-kind tags requires
/// bumping `ABI_VERSION` (see crate root) and updating `abi/snapshot.json`.
///
/// The kernel itself never decodes the cmdbuf opcode (`OP_*`) or sync-query
/// (`QOP_*`) tables — it forwards bytes to `HostIO::gl_submit` /
/// `HostIO::gl_query`. The opcodes are still owned by `shared::gl` because
/// they are the wire contract between Phase B's host TS bridge and Phase
/// C's user-space `libGLESv2` cmdbuf encoder; both sides mirror this
/// table. Adding new opcodes bumps `OP_VERSION`, not `ABI_VERSION`, since
/// the byte layout is unchanged from the kernel's perspective.
pub mod gl {
    /// Cmdbuf mmap length (1 MiB). Single fixed size in v1; see
    /// the design doc §3 "Cmdbuf overflow".
    pub const CMDBUF_LEN: usize = 1 << 20;

    /// Version of the GLES op-table. Bumped independently of `ABI_VERSION`
    /// when the cmdbuf opcode set changes; the libGLESv2 stub records this
    /// at compile time and the kernel refuses GLIO_INIT on mismatch.
    pub const OP_VERSION: u32 = 1;

    // --- ioctl request numbers (DRM 'D' magic, starting at 0x40) -----------

    // GLIO_INIT takes a pointer to a `u32` carrying the client's compile-time
    // `OP_VERSION`. The kernel rejects mismatches with `ENOSYS` so a process
    // built against an older op-table can't talk to a newer kernel (and vice
    // versa) without the divergence being caught at first contact rather than
    // surfacing later as a silent decode error. See A6's GLIO_INIT handler.
    pub const GLIO_INIT:            u32 = 0x40;
    pub const GLIO_TERMINATE:       u32 = 0x41;
    pub const GLIO_CREATE_CONTEXT:  u32 = 0x42;
    pub const GLIO_DESTROY_CONTEXT: u32 = 0x43;
    pub const GLIO_CREATE_SURFACE:  u32 = 0x44;
    pub const GLIO_DESTROY_SURFACE: u32 = 0x45;
    pub const GLIO_MAKE_CURRENT:    u32 = 0x46;
    pub const GLIO_SUBMIT:          u32 = 0x47;
    pub const GLIO_PRESENT:         u32 = 0x48;
    pub const GLIO_QUERY:           u32 = 0x49;

    // --- surface kind tags -------------------------------------------------

    /// `kind` value for the bound canvas surface.
    pub const WPK_SURFACE_DEFAULT: u32 = 1;
    /// `kind` value for an off-screen pbuffer surface (Phase C).
    pub const WPK_SURFACE_PBUFFER: u32 = 2;

    /// Upper bound on `GlQueryInfo.out_buf_len`. The kernel allocates a
    /// scratch buffer of this size before forwarding the query to the
    /// host; capping prevents a malicious wasm process from passing
    /// `0xFFFFFFFE` and OOMing the kernel worker.
    ///
    /// 64 KiB comfortably fits every realistic sync-query output: shader
    /// info logs (typically ~1 KB), program info logs, `glGetString`
    /// results, framebuffer-completeness, and `glReadPixels` of a 64×64
    /// RGBA thumbnail (16 KB). Demos that need to read back a full
    /// framebuffer should do it in tiles.
    pub const MAX_QUERY_OUT_LEN: u32 = 64 * 1024;

    // --- cmdbuf opcodes (mirrored in host/src/webgl/ops.ts) ----------------
    //
    // Layout: TLV `{u16 op, u16 payload_len, payload[payload_len]}` little-
    // endian. Payload formats are documented inline next to the libGLESv2
    // stub call sites in glue/libglesv2_stub.c (Phase C).

    pub const OP_CLEAR:                       u16 = 0x0001;
    pub const OP_CLEAR_COLOR:                 u16 = 0x0002;
    pub const OP_VIEWPORT:                    u16 = 0x0003;
    pub const OP_SCISSOR:                     u16 = 0x0004;
    pub const OP_ENABLE:                      u16 = 0x0005;
    pub const OP_DISABLE:                     u16 = 0x0006;
    pub const OP_BLEND_FUNC:                  u16 = 0x0007;
    pub const OP_DEPTH_FUNC:                  u16 = 0x0008;
    pub const OP_CULL_FACE:                   u16 = 0x0009;
    pub const OP_FRONT_FACE:                  u16 = 0x000A;
    pub const OP_LINE_WIDTH:                  u16 = 0x000B;
    pub const OP_PIXEL_STOREI:                u16 = 0x000C;

    pub const OP_GEN_BUFFERS:                 u16 = 0x0100;
    pub const OP_DELETE_BUFFERS:              u16 = 0x0101;
    pub const OP_BIND_BUFFER:                 u16 = 0x0102;
    pub const OP_BUFFER_DATA:                 u16 = 0x0103;
    pub const OP_BUFFER_SUB_DATA:             u16 = 0x0104;

    pub const OP_GEN_TEXTURES:                u16 = 0x0200;
    pub const OP_DELETE_TEXTURES:             u16 = 0x0201;
    pub const OP_BIND_TEXTURE:                u16 = 0x0202;
    pub const OP_TEX_IMAGE_2D:                u16 = 0x0203;
    pub const OP_TEX_SUB_IMAGE_2D:            u16 = 0x0204;
    pub const OP_TEX_PARAMETERI:              u16 = 0x0205;
    pub const OP_ACTIVE_TEXTURE:              u16 = 0x0206;
    pub const OP_GENERATE_MIPMAP:             u16 = 0x0207;

    pub const OP_CREATE_SHADER:               u16 = 0x0300;
    pub const OP_SHADER_SOURCE:               u16 = 0x0301;
    pub const OP_COMPILE_SHADER:              u16 = 0x0302;
    pub const OP_DELETE_SHADER:               u16 = 0x0303;
    pub const OP_CREATE_PROGRAM:              u16 = 0x0304;
    pub const OP_ATTACH_SHADER:               u16 = 0x0305;
    pub const OP_LINK_PROGRAM:                u16 = 0x0306;
    pub const OP_USE_PROGRAM:                 u16 = 0x0307;
    pub const OP_BIND_ATTRIB_LOCATION:        u16 = 0x0308;
    pub const OP_DELETE_PROGRAM:              u16 = 0x0309;

    pub const OP_UNIFORM1I:                   u16 = 0x0400;
    pub const OP_UNIFORM1F:                   u16 = 0x0401;
    pub const OP_UNIFORM2F:                   u16 = 0x0402;
    pub const OP_UNIFORM3F:                   u16 = 0x0403;
    pub const OP_UNIFORM4F:                   u16 = 0x0404;
    pub const OP_UNIFORM_MATRIX4FV:           u16 = 0x0405;
    /// `glUniform4fv(location, count, value)` — vector form. es2gears uses
    /// this for the directional light position. `OP_UNIFORM4F` (scalar) is a
    /// different signature; both are needed.
    pub const OP_UNIFORM4FV:                  u16 = 0x0406;

    pub const OP_ENABLE_VERTEX_ATTRIB_ARRAY:  u16 = 0x0500;
    pub const OP_DISABLE_VERTEX_ATTRIB_ARRAY: u16 = 0x0501;
    pub const OP_VERTEX_ATTRIB_POINTER:       u16 = 0x0502;
    pub const OP_DRAW_ARRAYS:                 u16 = 0x0503;
    pub const OP_DRAW_ELEMENTS:               u16 = 0x0504;

    pub const OP_GEN_VERTEX_ARRAYS:           u16 = 0x0600;
    pub const OP_DELETE_VERTEX_ARRAYS:        u16 = 0x0601;
    pub const OP_BIND_VERTEX_ARRAY:           u16 = 0x0602;

    pub const OP_GEN_FRAMEBUFFERS:            u16 = 0x0700;
    pub const OP_BIND_FRAMEBUFFER:            u16 = 0x0701;
    pub const OP_FRAMEBUFFER_TEXTURE_2D:      u16 = 0x0702;
    pub const OP_GEN_RENDERBUFFERS:           u16 = 0x0703;
    pub const OP_BIND_RENDERBUFFER:           u16 = 0x0704;
    pub const OP_RENDERBUFFER_STORAGE:        u16 = 0x0705;
    pub const OP_FRAMEBUFFER_RENDERBUFFER:    u16 = 0x0706;

    // --- sync query op tags (used in GlQueryInfo.op) -----------------------

    pub const QOP_GET_ERROR:             u32 = 0x01;
    pub const QOP_GET_STRING:            u32 = 0x02;
    pub const QOP_GET_INTEGERV:          u32 = 0x03;
    pub const QOP_GET_FLOATV:            u32 = 0x04;
    pub const QOP_GET_UNIFORM_LOC:       u32 = 0x05;
    pub const QOP_GET_ATTRIB_LOC:        u32 = 0x06;
    pub const QOP_GET_SHADERIV:          u32 = 0x07;
    pub const QOP_GET_SHADER_INFO_LOG:   u32 = 0x08;
    pub const QOP_GET_PROGRAMIV:         u32 = 0x09;
    pub const QOP_GET_PROGRAM_INFO_LOG:  u32 = 0x0A;
    pub const QOP_READ_PIXELS:           u32 = 0x0B;
    pub const QOP_CHECK_FB_STATUS:       u32 = 0x0C;

    // --- marshalled ioctl argument structs ---------------------------------

    /// Argument to `GLIO_SUBMIT`. Total: 8 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlSubmitInfo {
        /// Byte offset within the cmdbuf at which to start decoding.
        pub offset: u32,
        /// Number of bytes to decode (must end on a TLV boundary).
        pub length: u32,
    }

    /// Argument to `GLIO_CREATE_CONTEXT`. Total: 16 bytes.
    /// Mirrors a tiny subset of EGL config attrs; v1 only consults
    /// `client_version`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlContextAttrs {
        /// EGL client version (2 → GLES 2, 3 → GLES 3).
        pub client_version: u32,
        /// Reserved for `share_context`, debug bit, robustness bit, etc.
        pub reserved: [u32; 3],
    }

    /// Argument to `GLIO_CREATE_SURFACE`. Total: 32 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlSurfaceAttrs {
        /// Surface kind (only `WPK_SURFACE_DEFAULT` in v1).
        pub kind: u32,
        /// Pbuffer width (default-canvas surfaces ignore this).
        pub width: u32,
        /// Pbuffer height (default-canvas surfaces ignore this).
        pub height: u32,
        /// EGL config id (opaque; v1 reports a single config "1").
        pub config_id: u32,
        /// Reserved.
        pub reserved: [u32; 4],
    }

    /// Argument to `GLIO_QUERY`. Total: 24 bytes.
    /// `in_buf_ptr` / `out_buf_ptr` are wasm-process addresses that Phase B
    /// dereferences via the host's typed-array view of process memory. v1
    /// kernel forwards `op` + a kernel-scratch buffer sized by `out_buf_len`
    /// to `HostIO::gl_query` and ignores the pointers.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct GlQueryInfo {
        /// Sync-query op tag. The full table (QOP_*) is owned by the host
        /// bridge in Phase B; the kernel forwards this value unchanged.
        pub op: u32,
        /// Process-relative pointer to the input bytes (Phase B only).
        pub in_buf_ptr: u32,
        /// Length of input in bytes (Phase B only).
        pub in_buf_len: u32,
        /// Process-relative pointer to the output buffer (Phase B only).
        pub out_buf_ptr: u32,
        /// Capacity of the output buffer in bytes. The kernel rejects
        /// values above `MAX_QUERY_OUT_LEN` to bound the scratch
        /// allocation and otherwise forwards.
        pub out_buf_len: u32,
        /// Reserved for a future async-completion handle.
        pub reserved: u32,
    }
}

/// Linux DRM `/dev/dri/*` ABI — ioctl numbers, fourcc constants, and
/// marshalled argument structs.
///
/// Numbers are encoded with `_IOWR('d', nr, struct)` where `'d' = 0x64`.
/// Struct field offsets must match the Linux ABI byte-for-byte; bumping
/// `ABI_VERSION` is not required for *adding* new structs (additive
/// compatibility, see `docs/abi-versioning.md`), but any change to an
/// existing struct's layout requires a snapshot regen and a version bump.
pub mod dri {
    // --- ioctl numbers -----------------------------------------------------
    // Derivation: dir=11 (READ|WRITE), size=struct sizeof, magic='d', nr=…
    // Encoded: (dir << 30) | (size << 16) | (magic << 8) | nr
    // The constants below are the byte-for-byte Linux values; the tests in
    // `dri_tests` re-derive them from `_IOWR!` to catch drift.

    /// `_IOWR('d', 0x00, drm_version)` — driver name / date / desc query.
    /// `struct drm_version` is 36 bytes on wasm32 (ilp32: 3 × `int` + 3 ×
    /// `__kernel_size_t` + 3 × `char *`, all 4-byte). Ioctl number encodes
    /// 36 → `0xc0246400`. Linux x86_64's 60-byte layout is not us.
    pub const DRM_IOCTL_VERSION: u32 = 0xc024_6400;

    /// `_IOWR('d', 0x0c, drm_get_cap)` — feature capability query.
    pub const DRM_IOCTL_GET_CAP: u32 = 0xc010_640c;

    /// `_IOW('d', 0x09, drm_gem_close)` — drop a GEM handle.
    pub const DRM_IOCTL_GEM_CLOSE: u32 = 0x4008_6409;

    /// `_IOWR('d', 0x2d, drm_prime_handle)` — export bo as prime fd.
    pub const DRM_IOCTL_PRIME_HANDLE_TO_FD: u32 = 0xc00c_642d;

    /// `_IOWR('d', 0x2e, drm_prime_handle)` — import prime fd as bo handle.
    pub const DRM_IOCTL_PRIME_FD_TO_HANDLE: u32 = 0xc00c_642e;

    /// `_IOWR('d', 0xb2, drm_mode_create_dumb)` — allocate dumb buffer.
    pub const DRM_IOCTL_MODE_CREATE_DUMB: u32 = 0xc020_64b2;

    /// `_IOWR('d', 0xb3, drm_mode_map_dumb)` — fetch dumb-buffer mmap offset.
    pub const DRM_IOCTL_MODE_MAP_DUMB: u32 = 0xc010_64b3;

    /// `_IOWR('d', 0xb4, drm_mode_destroy_dumb)` — drop dumb buffer.
    pub const DRM_IOCTL_MODE_DESTROY_DUMB: u32 = 0xc004_64b4;

    // --- DRM_GET_CAP keys (clients call to probe features) ----------------

    pub const DRM_CAP_DUMB_BUFFER: u64 = 0x1;
    pub const DRM_CAP_PRIME: u64 = 0x5;
    pub const DRM_PRIME_CAP_IMPORT: u64 = 0x1;
    pub const DRM_PRIME_CAP_EXPORT: u64 = 0x2;

    // --- DRM fourcc pixel formats ----------------------------------------
    // Little-endian fourcc codes from `include/uapi/drm/drm_fourcc.h`.

    /// `fourcc('A','R','2','4')` — 8-8-8-8 alpha + RGB.
    pub const DRM_FORMAT_ARGB8888: u32 = 0x34325241;
    /// `fourcc('X','R','2','4')` — 8-8-8-8 padding + RGB.
    pub const DRM_FORMAT_XRGB8888: u32 = 0x34325258;
    /// `fourcc('R','G','1','6')` — 5-6-5 RGB.
    pub const DRM_FORMAT_RGB565: u32 = 0x36314752;

    // --- marshalled structs ------------------------------------------------

    /// Linux `struct drm_mode_create_dumb` (32 bytes, identical layout on
    /// wasm32 and x86_64 — fixed-width fields only).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCreateDumb {
        pub height: u32,  // 0   in
        pub width: u32,   // 4   in
        pub bpp: u32,     // 8   in    bits-per-pixel (32 for ARGB8888)
        pub flags: u32,   // 12  in    must be 0
        pub handle: u32,  // 16  out   process-local bo handle
        pub pitch: u32,   // 20  out   stride in bytes
        pub size: u64,    // 24  out   total bytes (pitch * height)
                          // total: 32
    }

    /// Linux `struct drm_mode_map_dumb` (16 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeMapDumb {
        pub handle: u32, // 0   in
        pub pad: u32,    // 4   reserved
        pub offset: u64, // 8   out   pass to mmap() as the file offset
                         // total: 16
    }

    /// Linux `struct drm_mode_destroy_dumb` (4 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeDestroyDumb {
        pub handle: u32, // 0
                         // total: 4
    }

    /// Linux `struct drm_gem_close` (8 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGemClose {
        pub handle: u32, // 0
        pub pad: u32,    // 4
                         // total: 8
    }

    /// Linux `struct drm_prime_handle` (12 bytes). Reused both for
    /// HANDLE_TO_FD (handle → fd, flags=O_CLOEXEC|O_RDWR-ish) and
    /// FD_TO_HANDLE (fd → handle).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmPrimeHandle {
        pub handle: u32, // 0   in/out
        pub flags: u32,  // 4   in    O_CLOEXEC/O_RDWR; we accept any, store none
        pub fd: i32,     // 8   in/out   signed (-1 on error sentinel; -EBADF tests)
                         // total: 12
    }

    /// Linux `struct drm_get_cap` (16 bytes).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGetCap {
        pub capability: u64, // 0  in   DRM_CAP_* constant
        pub value: u64,      // 8  out
                             // total: 16
    }

    /// Linux `struct drm_version` — used by `DRM_IOCTL_VERSION`. 36 bytes on
    /// wasm32 (ilp32: 3 × `int` + 3 × `__kernel_size_t` + 3 × `char *`, all
    /// 4-byte). Field order matches `include/uapi/drm/drm.h` — interleaved
    /// `(len, ptr)` triples (not "lens first, then ptrs"). The kernel reads
    /// `*_len` (caller-allocated capacity), writes strings via the three
    /// pointers, and updates `*_len` to bytes actually written. v1 writes
    /// zero-length strings (see Task A5); the field shape is fixed for the
    /// future string-write path.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmVersion {
        pub version_major: i32,       // 0
        pub version_minor: i32,       // 4
        pub version_patchlevel: i32,  // 8
        pub name_len: u32,            // 12   in/out
        pub name_ptr: u32,            // 16   wasm32 user pointer
        pub date_len: u32,            // 20   in/out
        pub date_ptr: u32,            // 24   wasm32 user pointer
        pub desc_len: u32,            // 28   in/out
        pub desc_ptr: u32,            // 32   wasm32 user pointer
                                      // total: 36
    }

    // --- WPK extensions ('d' magic, nrs 0xE0+ — unused by Linux 6.x) ----

    /// `_IOWR('d', 0xE0, WpkDrmGpuBoCreate)` — allocate a GPU-tier bo.
    /// `MODE_CREATE_DUMB` covers CPU-shared bos (LINEAR, mmap'able). This
    /// ioctl covers the GPU tier: the bo's backing is a host `WebGLTexture`,
    /// not a SAB; the bo is unmappable on the CPU side and is intended for
    /// sampling / rendering via the multiplexer.
    pub const DRM_IOCTL_WPK_CREATE_GPU_BO: u32 = 0xc010_64e0;

    /// `_IOWR('d', 0xE1, WpkDrmBindForeignTexture)` — bind a foreign bo as
    /// a `WebGLTexture` in the caller's GL context. The caller must already
    /// hold a local bo handle (via PRIME_FD_TO_HANDLE), and the bo must be
    /// GPU-tier. Used by the compositor to sample client bos and by
    /// `gbm_bo_import` callers that want texture-side access.
    pub const DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE: u32 = 0xc010_64e1;

    /// GPU-bo allocator argument. 16 bytes on wasm32 (4 × u32). `format` and
    /// `usage` are passed through to libgbm's `gbm_bo_create(format, usage)`
    /// from the user side.
    ///
    /// The kernel writes back over the same buffer on return; layout:
    ///
    ///   0..4   width    (echoed back, unchanged)
    ///   4..8   height   (echoed back, unchanged)
    ///   8..12  handle   (out — process-local; was `format` on the way in)
    ///   12..16 stride   (out — bytes; was `usage` on the way in)
    ///
    /// The 16-byte size is preserved (ioctl encoding stays 0xc010_64e0).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmGpuBoCreate {
        pub width: u32,   // 0   in
        pub height: u32,  // 4   in
        pub format: u32,  // 8   in    DRM_FORMAT_* (ARGB8888 etc.)
        pub usage: u32,   // 12  in    GBM_BO_USE_* bitmask
                          // total: 16
    }

    /// `BIND_FOREIGN_TEXTURE` argument. 16 bytes on wasm32 (4 × u32). After
    /// the call, the caller's GL context has a `WebGLTexture` accessible by
    /// `gl_texture_id` until the bo's refcount drops to zero — the bo is
    /// the canonical owner; bo destruction (last `GEM_CLOSE` / OFD
    /// final-close) deletes the underlying `WebGLTexture` and invalidates
    /// every binding to it. There is no separate `UNBIND_FOREIGN_TEXTURE`
    /// ioctl: bind lifetime is tied to the bo lifetime, scoped by the bo
    /// refcount.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmBindForeignTexture {
        pub bo_handle: u32,     // 0   in    caller's local GEM handle
        pub gl_target: u32,     // 4   in    GL_TEXTURE_2D etc.
        pub ctx_id: u32,        // 8   in    caller's GL ctx_id
        pub gl_texture_id: u32, // 12  out   the WebGLTexture id assigned
                                //          (also writable as a sampler binding)
    }

    // --- KMS ioctls ('d' magic, Linux UAPI) -------------------------------

    /// `_IO('d', 0x1e)` — request DRM_MASTER.
    pub const DRM_IOCTL_SET_MASTER: u32 = 0x0000_641e;

    /// `_IO('d', 0x1f)` — release DRM_MASTER.
    pub const DRM_IOCTL_DROP_MASTER: u32 = 0x0000_641f;

    /// `_IOWR('d', 0x3a, drm_wait_vblank)` — block until next vblank.
    pub const DRM_IOCTL_WAIT_VBLANK: u32 = 0xc010_643a;

    /// `_IOWR('d', 0xa0, drm_mode_card_res)` — crtc/connector/encoder counts.
    pub const DRM_IOCTL_MODE_GETRESOURCES: u32 = 0xc040_64a0;

    /// `_IOWR('d', 0xa1, drm_mode_crtc)`.
    pub const DRM_IOCTL_MODE_GETCRTC: u32 = 0xc068_64a1;

    /// `_IOWR('d', 0xa2, drm_mode_crtc)`.
    pub const DRM_IOCTL_MODE_SETCRTC: u32 = 0xc068_64a2;

    /// `_IOWR('d', 0xa6, drm_mode_get_encoder)`.
    pub const DRM_IOCTL_MODE_GETENCODER: u32 = 0xc014_64a6;

    /// `_IOWR('d', 0xa7, drm_mode_get_connector)`.
    pub const DRM_IOCTL_MODE_GETCONNECTOR: u32 = 0xc050_64a7;

    /// `_IOWR('d', 0xae, drm_mode_fb_cmd)` — legacy single-plane add-fb.
    /// SDL2's KMSDRM backend (`KMSDRM_FBFromBO`) still uses this older
    /// API even on modern kernels; ADDFB2 is the preferred path for
    /// new code.
    pub const DRM_IOCTL_MODE_ADDFB: u32 = 0xc01c_64ae;

    /// `_IOWR('d', 0xaf, u32)` — drop fb id.
    pub const DRM_IOCTL_MODE_RMFB: u32 = 0xc004_64af;

    /// `_IOWR('d', 0xb0, drm_mode_crtc_page_flip)` — queue page-flip.
    pub const DRM_IOCTL_MODE_PAGE_FLIP: u32 = 0xc018_64b0;

    /// `_IOWR('d', 0xb8, drm_mode_fb_cmd2)`.
    pub const DRM_IOCTL_MODE_ADDFB2: u32 = 0xc068_64b8;

    // --- KMS enums --------------------------------------------------------

    pub const DRM_MODE_CONNECTOR_VIRTUAL: u32 = 15;
    pub const DRM_MODE_CONNECTED: u32 = 1;
    pub const DRM_MODE_SUBPIXEL_UNKNOWN: u32 = 1;
    pub const DRM_EVENT_VBLANK: u32 = 1;
    pub const DRM_EVENT_FLIP_COMPLETE: u32 = 2;

    // --- KMS marshalled structs -------------------------------------------

    /// `struct drm_mode_card_res`. 64 bytes. The four `*_ptr` fields are
    /// `__u64` upstream for x86_32/x86_64 portability; on wasm32 the user
    /// pointer occupies the low 32 bits, high 32 bits are zero.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCardRes {
        pub fb_id_ptr: u64,         // 0   in
        pub crtc_id_ptr: u64,       // 8   in
        pub connector_id_ptr: u64,  // 16  in
        pub encoder_id_ptr: u64,    // 24  in
        pub count_fbs: u32,         // 32  in/out
        pub count_crtcs: u32,       // 36  in/out
        pub count_connectors: u32,  // 40  in/out
        pub count_encoders: u32,    // 44  in/out
        pub min_width: u32,         // 48  out
        pub max_width: u32,         // 52  out
        pub min_height: u32,        // 56  out
        pub max_height: u32,        // 60  out
                                    // total: 64
    }

    /// `struct drm_mode_modeinfo`. 68 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeModeinfo {
        pub clock: u32,         // 0
        pub hdisplay: u16,      // 4
        pub hsync_start: u16,   // 6
        pub hsync_end: u16,     // 8
        pub htotal: u16,        // 10
        pub hskew: u16,         // 12
        pub vdisplay: u16,      // 14
        pub vsync_start: u16,   // 16
        pub vsync_end: u16,     // 18
        pub vtotal: u16,        // 20
        pub vscan: u16,         // 22
        pub vrefresh: u32,      // 24
        pub flags: u32,         // 28
        pub mode_type: u32,     // 32
        pub name: [u8; 32],     // 36..68
                                // total: 68
    }

    /// `struct drm_mode_crtc`. 104 bytes (embedded modeinfo at offset 36).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetCrtc {
        pub set_connectors_ptr: u64,   // 0    in   (SETCRTC only)
        pub count_connectors: u32,     // 8    in   (SETCRTC only)
        pub crtc_id: u32,              // 12   in/out
        pub fb_id: u32,                // 16   in/out
        pub x: u32,                    // 20   in/out
        pub y: u32,                    // 24   in/out
        pub gamma_size: u32,           // 28   out
        pub mode_valid: u32,           // 32   in/out
        pub mode: WpkDrmModeModeinfo,  // 36..104
                                       // total: 104
    }

    /// `struct drm_mode_get_connector`. 80 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetConnector {
        pub encoders_ptr: u64,         // 0    in
        pub modes_ptr: u64,            // 8    in
        pub props_ptr: u64,            // 16   in
        pub prop_values_ptr: u64,      // 24   in
        pub count_modes: u32,          // 32   in/out
        pub count_props: u32,          // 36   in/out
        pub count_encoders: u32,       // 40   in/out
        pub encoder_id: u32,           // 44   out
        pub connector_id: u32,         // 48   in/out
        pub connector_type: u32,       // 52   out
        pub connector_type_id: u32,    // 56   out
        pub connection: u32,           // 60   out
        pub mm_width: u32,             // 64   out
        pub mm_height: u32,            // 68   out
        pub subpixel: u32,             // 72   out
        pub pad: u32,                  // 76
                                       // total: 80
    }

    /// `struct drm_mode_get_encoder`. 20 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeGetEncoder {
        pub encoder_id: u32,        // 0    in/out
        pub encoder_type: u32,      // 4    out
        pub crtc_id: u32,           // 8    out
        pub possible_crtcs: u32,    // 12   out
        pub possible_clones: u32,   // 16   out
                                    // total: 20
    }

    /// `struct drm_mode_fb_cmd`. 28 bytes — legacy single-plane ADDFB.
    /// `(depth, bpp)` encodes the pixel format the way the original
    /// DRM API did before fourcc became canonical.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeFbCmd {
        pub fb_id: u32,       // 0    out
        pub width: u32,       // 4    in
        pub height: u32,      // 8    in
        pub pitch: u32,       // 12   in
        pub bpp: u32,         // 16   in
        pub depth: u32,       // 20   in
        pub handle: u32,      // 24   in
                              // total: 28
    }

    /// `struct drm_mode_fb_cmd2`. 104 bytes — `[u64; 4] modifier` aligns
    /// to offset 72, leaving 4 bytes of pad after `offsets`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeFbCmd2 {
        pub fb_id: u32,             // 0    out
        pub width: u32,             // 4    in
        pub height: u32,            // 8    in
        pub pixel_format: u32,      // 12   in
        pub flags: u32,             // 16   in
        pub handles: [u32; 4],      // 20   in
        pub pitches: [u32; 4],      // 36   in
        pub offsets: [u32; 4],      // 52   in
        pub modifier: [u64; 4],     // 72..104   in
                                    // total: 104
    }

    /// `struct drm_mode_crtc_page_flip`. 24 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmModeCrtcPageFlip {
        pub crtc_id: u32,    // 0    in
        pub fb_id: u32,      // 4    in
        pub flags: u32,      // 8    in
        pub reserved: u32,   // 12
        pub user_data: u64,  // 16   in
                             // total: 24
    }

    /// `struct drm_event_vblank`. 32 bytes — `drm_event` header (8) +
    /// body (24). Carries `sequence` + `crtc_id` at the tail so libdrm v3's
    /// `page_flip_handler2(fd, sequence, tv_sec, tv_usec, crtc_id,
    /// user_data)` reads correct bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmEventVblank {
        pub ev_type: u32,    // 0
        pub length: u32,     // 4
        pub user_data: u64,  // 8
        pub tv_sec: u32,     // 16
        pub tv_usec: u32,    // 20
        pub sequence: u32,   // 24
        pub crtc_id: u32,    // 28
                             // total: 32
    }

    /// `struct drm_wait_vblank_request`. Union member (input). 16 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmWaitVblankRequest {
        pub req_type: u32,  // 0
        pub sequence: u32,  // 4
        pub signal: u64,    // 8
                            // total: 16
    }

    /// `struct drm_wait_vblank_reply`. Union member (output). 16 bytes.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkDrmWaitVblankReply {
        pub rep_type: u32,  // 0
        pub sequence: u32,  // 4
        pub tv_sec: u32,    // 8
        pub tv_usec: u32,   // 12
                            // total: 16
    }
}

/// evdev — `/dev/input/event*` UAPI exposed to user programs.
///
/// Mirror image of [`dri`] above: the kernel synthesises records and
/// user programs drain them through `read()` / `poll()`. The struct
/// layouts, ioctl numbers, and code points here are Linux-verbatim so
/// libinput / SDL2 / X11 evdev paths can be ported without an
/// abstraction layer.
///
/// **Additive only.** Adding new `EV_*` / `KEY_*` / `EVIOC*` is
/// allowed without bumping [`ABI_VERSION`]; changing the layout of
/// [`input::WpkInputEvent`] or the value of any existing constant is
/// not.
pub mod input {
    // --- Event types (struct input_event.type) ---------------------------

    /// `EV_SYN` = 0. End-of-logical-event sentinel; readers use this
    /// to coalesce a (REL_X, REL_Y) pair into one cursor move.
    pub const EV_SYN: u16 = 0x00;
    /// `EV_KEY` = 1. Press / release / autorepeat. Value is
    /// 0 = release, 1 = press, 2 = repeat.
    pub const EV_KEY: u16 = 0x01;
    /// `EV_REL` = 2. Relative axis (pointer dx/dy/wheel).
    pub const EV_REL: u16 = 0x02;
    /// `EV_ABS` = 3. Absolute axis (pointer position when not locked,
    /// joystick, touch coords).
    pub const EV_ABS: u16 = 0x03;
    /// `EV_MSC` = 4. Misc events (scancode, timestamp). Not produced
    /// in v1.
    pub const EV_MSC: u16 = 0x04;

    // --- SYN codes (struct input_event.code when type == EV_SYN) ---------

    /// `SYN_REPORT` = 0. End-of-frame; readers should treat
    /// everything since the previous `SYN_REPORT` as atomic.
    pub const SYN_REPORT: u16 = 0x00;
    /// `SYN_DROPPED` = 3. Posted when the ring overflowed and the
    /// oldest record was dropped; userspace should resynchronise
    /// (re-query EVIOCG* state).
    pub const SYN_DROPPED: u16 = 0x03;

    // --- KEY_* codes (verbatim from linux/input-event-codes.h) -----------
    //
    // Range 0..248 covers every code Chrome / Firefox / WebKit emit
    // through `KeyboardEvent.code`; values >248 (KEY_BUTTONCONFIG, the
    // KEY_VENDOR range, etc.) are not browser-reachable.

    pub const KEY_RESERVED: u16 = 0;
    pub const KEY_ESC: u16 = 1;
    pub const KEY_1: u16 = 2;
    pub const KEY_2: u16 = 3;
    pub const KEY_3: u16 = 4;
    pub const KEY_4: u16 = 5;
    pub const KEY_5: u16 = 6;
    pub const KEY_6: u16 = 7;
    pub const KEY_7: u16 = 8;
    pub const KEY_8: u16 = 9;
    pub const KEY_9: u16 = 10;
    pub const KEY_0: u16 = 11;
    pub const KEY_MINUS: u16 = 12;
    pub const KEY_EQUAL: u16 = 13;
    pub const KEY_BACKSPACE: u16 = 14;
    pub const KEY_TAB: u16 = 15;
    pub const KEY_Q: u16 = 16;
    pub const KEY_W: u16 = 17;
    pub const KEY_E: u16 = 18;
    pub const KEY_R: u16 = 19;
    pub const KEY_T: u16 = 20;
    pub const KEY_Y: u16 = 21;
    pub const KEY_U: u16 = 22;
    pub const KEY_I: u16 = 23;
    pub const KEY_O: u16 = 24;
    pub const KEY_P: u16 = 25;
    pub const KEY_LEFTBRACE: u16 = 26;
    pub const KEY_RIGHTBRACE: u16 = 27;
    pub const KEY_ENTER: u16 = 28;
    pub const KEY_LEFTCTRL: u16 = 29;
    pub const KEY_A: u16 = 30;
    pub const KEY_S: u16 = 31;
    pub const KEY_D: u16 = 32;
    pub const KEY_F: u16 = 33;
    pub const KEY_G: u16 = 34;
    pub const KEY_H: u16 = 35;
    pub const KEY_J: u16 = 36;
    pub const KEY_K: u16 = 37;
    pub const KEY_L: u16 = 38;
    pub const KEY_SEMICOLON: u16 = 39;
    pub const KEY_APOSTROPHE: u16 = 40;
    pub const KEY_GRAVE: u16 = 41;
    pub const KEY_LEFTSHIFT: u16 = 42;
    pub const KEY_BACKSLASH: u16 = 43;
    pub const KEY_Z: u16 = 44;
    pub const KEY_X: u16 = 45;
    pub const KEY_C: u16 = 46;
    pub const KEY_V: u16 = 47;
    pub const KEY_B: u16 = 48;
    pub const KEY_N: u16 = 49;
    pub const KEY_M: u16 = 50;
    pub const KEY_COMMA: u16 = 51;
    pub const KEY_DOT: u16 = 52;
    pub const KEY_SLASH: u16 = 53;
    pub const KEY_RIGHTSHIFT: u16 = 54;
    pub const KEY_KPASTERISK: u16 = 55;
    pub const KEY_LEFTALT: u16 = 56;
    pub const KEY_SPACE: u16 = 57;
    pub const KEY_CAPSLOCK: u16 = 58;
    pub const KEY_F1: u16 = 59;
    pub const KEY_F2: u16 = 60;
    pub const KEY_F3: u16 = 61;
    pub const KEY_F4: u16 = 62;
    pub const KEY_F5: u16 = 63;
    pub const KEY_F6: u16 = 64;
    pub const KEY_F7: u16 = 65;
    pub const KEY_F8: u16 = 66;
    pub const KEY_F9: u16 = 67;
    pub const KEY_F10: u16 = 68;
    pub const KEY_NUMLOCK: u16 = 69;
    pub const KEY_SCROLLLOCK: u16 = 70;
    pub const KEY_KP7: u16 = 71;
    pub const KEY_KP8: u16 = 72;
    pub const KEY_KP9: u16 = 73;
    pub const KEY_KPMINUS: u16 = 74;
    pub const KEY_KP4: u16 = 75;
    pub const KEY_KP5: u16 = 76;
    pub const KEY_KP6: u16 = 77;
    pub const KEY_KPPLUS: u16 = 78;
    pub const KEY_KP1: u16 = 79;
    pub const KEY_KP2: u16 = 80;
    pub const KEY_KP3: u16 = 81;
    pub const KEY_KP0: u16 = 82;
    pub const KEY_KPDOT: u16 = 83;
    pub const KEY_ZENKAKUHANKAKU: u16 = 85;
    pub const KEY_102ND: u16 = 86;
    pub const KEY_F11: u16 = 87;
    pub const KEY_F12: u16 = 88;
    pub const KEY_RO: u16 = 89;
    pub const KEY_KATAKANA: u16 = 90;
    pub const KEY_HIRAGANA: u16 = 91;
    pub const KEY_HENKAN: u16 = 92;
    pub const KEY_KATAKANAHIRAGANA: u16 = 93;
    pub const KEY_MUHENKAN: u16 = 94;
    pub const KEY_KPJPCOMMA: u16 = 95;
    pub const KEY_KPENTER: u16 = 96;
    pub const KEY_RIGHTCTRL: u16 = 97;
    pub const KEY_KPSLASH: u16 = 98;
    pub const KEY_SYSRQ: u16 = 99;
    pub const KEY_RIGHTALT: u16 = 100;
    pub const KEY_LINEFEED: u16 = 101;
    pub const KEY_HOME: u16 = 102;
    pub const KEY_UP: u16 = 103;
    pub const KEY_PAGEUP: u16 = 104;
    pub const KEY_LEFT: u16 = 105;
    pub const KEY_RIGHT: u16 = 106;
    pub const KEY_END: u16 = 107;
    pub const KEY_DOWN: u16 = 108;
    pub const KEY_PAGEDOWN: u16 = 109;
    pub const KEY_INSERT: u16 = 110;
    pub const KEY_DELETE: u16 = 111;
    pub const KEY_MACRO: u16 = 112;
    pub const KEY_MUTE: u16 = 113;
    pub const KEY_VOLUMEDOWN: u16 = 114;
    pub const KEY_VOLUMEUP: u16 = 115;
    pub const KEY_POWER: u16 = 116;
    pub const KEY_KPEQUAL: u16 = 117;
    pub const KEY_KPPLUSMINUS: u16 = 118;
    pub const KEY_PAUSE: u16 = 119;
    pub const KEY_SCALE: u16 = 120;
    pub const KEY_KPCOMMA: u16 = 121;
    pub const KEY_HANGEUL: u16 = 122;
    pub const KEY_HANJA: u16 = 123;
    pub const KEY_YEN: u16 = 124;
    pub const KEY_LEFTMETA: u16 = 125;
    pub const KEY_RIGHTMETA: u16 = 126;
    pub const KEY_COMPOSE: u16 = 127;
    pub const KEY_STOP: u16 = 128;
    pub const KEY_AGAIN: u16 = 129;
    pub const KEY_PROPS: u16 = 130;
    pub const KEY_UNDO: u16 = 131;
    pub const KEY_FRONT: u16 = 132;
    pub const KEY_COPY: u16 = 133;
    pub const KEY_OPEN: u16 = 134;
    pub const KEY_PASTE: u16 = 135;
    pub const KEY_FIND: u16 = 136;
    pub const KEY_CUT: u16 = 137;
    pub const KEY_HELP: u16 = 138;
    pub const KEY_MENU: u16 = 139;
    pub const KEY_CALC: u16 = 140;
    pub const KEY_SLEEP: u16 = 142;
    pub const KEY_WAKEUP: u16 = 143;
    pub const KEY_PLAYPAUSE: u16 = 164;
    pub const KEY_PREVIOUSSONG: u16 = 165;
    pub const KEY_STOPCD: u16 = 166;
    pub const KEY_NEXTSONG: u16 = 163;
    pub const KEY_EJECTCD: u16 = 161;
    pub const KEY_REFRESH: u16 = 173;
    pub const KEY_F13: u16 = 183;
    pub const KEY_F14: u16 = 184;
    pub const KEY_F15: u16 = 185;
    pub const KEY_F16: u16 = 186;
    pub const KEY_F17: u16 = 187;
    pub const KEY_F18: u16 = 188;
    pub const KEY_F19: u16 = 189;
    pub const KEY_F20: u16 = 190;
    pub const KEY_F21: u16 = 191;
    pub const KEY_F22: u16 = 192;
    pub const KEY_F23: u16 = 193;
    pub const KEY_F24: u16 = 194;
    pub const KEY_PLAYCD: u16 = 200;
    pub const KEY_PAUSECD: u16 = 201;
    pub const KEY_BRIGHTNESSDOWN: u16 = 224;
    pub const KEY_BRIGHTNESSUP: u16 = 225;
    pub const KEY_MICMUTE: u16 = 248;

    // --- BTN_* codes (button class; reuse the EV_KEY event type) ---------

    pub const BTN_LEFT: u16 = 0x110;
    pub const BTN_RIGHT: u16 = 0x111;
    pub const BTN_MIDDLE: u16 = 0x112;
    pub const BTN_SIDE: u16 = 0x113;
    pub const BTN_EXTRA: u16 = 0x114;

    // --- REL_* codes (relative axes; EV_REL records carry these) ---------

    pub const REL_X: u16 = 0x00;
    pub const REL_Y: u16 = 0x01;
    pub const REL_HWHEEL: u16 = 0x06;
    pub const REL_WHEEL: u16 = 0x08;

    // --- ABS_* codes (absolute axes; EV_ABS records carry these) ---------

    pub const ABS_X: u16 = 0x00;
    pub const ABS_Y: u16 = 0x01;

    // --- BUS_* constants (subset) ----------------------------------------

    /// `BUS_VIRTUAL` = 0x06 — closest match for a kernel-synthesised
    /// device (Linux uses this for `uinput`-backed devices).
    pub const BUS_VIRTUAL: u16 = 0x06;

    // --- ioctl numbers ('E' magic, Linux UAPI verbatim) ------------------
    //
    // Encoding: `(dir << 30) | (size << 16) | (magic << 8) | nr`.
    // `_IOR` = dir 2 (kernel writes back to userland buffer),
    // `_IOW` = dir 1 (kernel reads from userland buffer). The
    // `evioc_numbers_match_linux_uapi` test below re-derives each one
    // through `ioc(...)` so a copy-paste typo cannot survive.

    /// `_IOR('E', 0x01, int)` = `0x8004_4501`.
    pub const EVIOCGVERSION: u32 = 0x8004_4501;

    /// `_IOR('E', 0x02, WpkInputId)` = `0x8008_4502`.
    pub const EVIOCGID: u32 = 0x8008_4502;

    /// `_IOC(_IOC_READ, 'E', 0x06, len)` — `EVIOCGNAME(len)` in C.
    /// `len` is caller-supplied; A3 matches on `(dir, magic, nr)`
    /// and recomputes the buffer size from the encoded `size` field
    /// at dispatch time (1 ≤ size ≤ 256).
    pub const EVIOCGNAME_NR: u32 = 0x06;

    /// `EVIOCGBIT(ev_type, len)` — same variable-length shape as
    /// `EVIOCGNAME`. `nr = 0x20 + ev_type`.
    pub const EVIOCGBIT_NR_BASE: u32 = 0x20;

    /// `EVIOCGABS(axis)` — `_IOR('E', 0x40 + axis, WpkInputAbsinfo)`.
    /// `axis` is a small integer (`ABS_X = 0`, `ABS_Y = 1`, …).
    pub const EVIOCGABS_NR_BASE: u32 = 0x40;

    /// `_IOW('E', 0x90, int)` = `0x4004_4590`.
    pub const EVIOCGRAB: u32 = 0x4004_4590;

    // --- marshalled structs ----------------------------------------------

    /// `struct input_event` on wasm32-musl (`time_t = int64_t`,
    /// `suseconds_t = int32_t`, `__u16` + `__u16` + `__s32`).
    /// Total = 24 bytes.
    ///
    /// The explicit `_pad: i32` at byte 12 is **load-bearing**.
    /// `repr(C)` would otherwise place `ev_type` at offset 12 (no
    /// interior padding between the `i32 tv_usec` and the `u16
    /// ev_type`), but C's `struct timeval` substruct is itself 16
    /// bytes on wasm32-musl: the `int64_t tv_sec` forces 8-byte
    /// alignment of the substruct, and the trailing `int32_t
    /// tv_usec` is padded to 16 to satisfy that alignment. So the
    /// C reader expects `ev_type` at offset 16 while the
    /// pad-less Rust writer would put it at offset 12 — silent
    /// corruption on every record. The `input_event_field_offsets`
    /// test below gates the layout; if `ev_type` ever drifts back
    /// to offset 12, restore `_pad`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkInputEvent {
        pub tv_sec: i64,    // 0   CLOCK_MONOTONIC seconds since kernel boot
        pub tv_usec: i32,   // 8   microseconds; matches musl suseconds_t
        pub _pad: i32,      // 12  pad so the trailing union 8-aligns with C
        pub ev_type: u16,   // 16  EV_KEY / EV_REL / EV_ABS / EV_SYN / EV_MSC
        pub code: u16,      // 18  KEY_* / BTN_* / REL_* / ABS_* / SYN_*
        pub value: i32,     // 20  press/release/repeat; delta; absolute pos
                            // total: 24
    }

    /// `struct input_id` — 8 bytes (4 × u16). Returned by `EVIOCGID`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkInputId {
        pub bustype: u16,   // 0   BUS_VIRTUAL = 0x06
        pub vendor: u16,    // 2
        pub product: u16,   // 4   0x0001 = kbd, 0x0002 = ptr
        pub version: u16,   // 6
                            // total: 8
    }

    /// `struct input_absinfo` — 24 bytes (6 × i32). Returned by
    /// `EVIOCGABS(axis)`. Used for `ABS_X` / `ABS_Y` on the pointer
    /// device when pointer lock is not active.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkInputAbsinfo {
        pub value: i32,     // 0   current value
        pub minimum: i32,   // 4
        pub maximum: i32,   // 8   canvas width-1 / height-1
        pub fuzz: i32,      // 12
        pub flat: i32,      // 16
        pub resolution: i32,// 20  1 unit per pixel
                            // total: 24
    }
}

pub mod audio {
    // --- PCM ioctl numbers ('A' magic, Linux UAPI verbatim) --------------

    pub const SNDRV_PCM_IOCTL_PVERSION: u32 = 0x8004_4100;
    pub const SNDRV_PCM_IOCTL_INFO: u32 = 0x8120_4101;
    pub const SNDRV_PCM_IOCTL_HW_REFINE: u32 = 0xc25c_4110;
    pub const SNDRV_PCM_IOCTL_HW_PARAMS: u32 = 0xc25c_4111;
    pub const SNDRV_PCM_IOCTL_HW_FREE: u32 = 0x0000_4112;
    pub const SNDRV_PCM_IOCTL_SW_PARAMS: u32 = 0xc068_4113;
    pub const SNDRV_PCM_IOCTL_STATUS: u32 = 0x8080_4120;
    pub const SNDRV_PCM_IOCTL_HWSYNC: u32 = 0x0000_4122;
    pub const SNDRV_PCM_IOCTL_PREPARE: u32 = 0x0000_4140;
    pub const SNDRV_PCM_IOCTL_START: u32 = 0x0000_4142;
    pub const SNDRV_PCM_IOCTL_DROP: u32 = 0x0000_4143;
    pub const SNDRV_PCM_IOCTL_PAUSE: u32 = 0x4004_4145;
    pub const SNDRV_PCM_IOCTL_WRITEI_FRAMES: u32 = 0x400c_4150;

    // --- PCM state constants ---------------------------------------------

    pub const SNDRV_PCM_STATE_OPEN: u32 = 0;
    pub const SNDRV_PCM_STATE_SETUP: u32 = 1;
    pub const SNDRV_PCM_STATE_PREPARED: u32 = 2;
    pub const SNDRV_PCM_STATE_RUNNING: u32 = 3;
    pub const SNDRV_PCM_STATE_XRUN: u32 = 4;
    pub const SNDRV_PCM_STATE_PAUSED: u32 = 6;

    // --- PCM format constants (S16_LE is v1's only support) --------------

    pub const SNDRV_PCM_FORMAT_S16_LE: u32 = 2;
    pub const SNDRV_PCM_FORMAT_S32_LE: u32 = 10;
    pub const SNDRV_PCM_FORMAT_FLOAT_LE: u32 = 14;

    // --- PCM access constants --------------------------------------------

    pub const SNDRV_PCM_ACCESS_MMAP_INTERLEAVED: u32 = 0;
    pub const SNDRV_PCM_ACCESS_RW_INTERLEAVED: u32 = 3;

    // --- PCM stream direction --------------------------------------------

    pub const SNDRV_PCM_STREAM_PLAYBACK: u32 = 0;
    pub const SNDRV_PCM_STREAM_CAPTURE: u32 = 1;

    // --- MMAP offsets (passed to mmap(pcm_fd, ...) to select a page) ----

    pub const SNDRV_PCM_MMAP_OFFSET_DATA: u64 = 0x0000_0000;
    pub const SNDRV_PCM_MMAP_OFFSET_STATUS: u64 = 0x8000_0000;
    pub const SNDRV_PCM_MMAP_OFFSET_CONTROL: u64 = 0x8100_0000;

    /// `struct snd_interval` — value-range descriptor inside
    /// `snd_pcm_hw_params.intervals[]`. Linux packs four flag bits
    /// (openmin / openmax / integer / empty) into a trailing u32; we
    /// store them as a plain u32 to match Linux's 12-byte UAPI size.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkSndInterval {
        pub min: u32,
        pub max: u32,
        /// Bit 0 = openmin, 1 = openmax, 2 = integer, 3 = empty.
        pub flags: u32,
    }

    /// `struct snd_pcm_hw_params`. Layout-locked against Linux v6.10
    /// `include/uapi/sound/asound.h`; `masks[64]` covers the 3 active +
    /// 5 reserved snd_masks (each is u32[8]), `intervals[21]` covers
    /// the 12 active + 9 reserved snd_intervals.
    ///
    /// `fifo_size` is `snd_pcm_uframes_t = unsigned long` in the Linux
    /// UAPI. On wasm32 (the target this kernel runs on, AND that musl
    /// compiles user-space against), `unsigned long` is 4 bytes — so
    /// the marshalled struct is 604 bytes and the encoded `_IOWR`
    /// sizes for `HW_REFINE` / `HW_PARAMS` end in `0x25c` (= 604),
    /// matching what alsa-lib's `ioctl(fd, SNDRV_PCM_IOCTL_HW_REFINE,
    /// ...)` actually emits when compiled with `wasm32posix-cc`.
    /// Using `u64` here would inflate the size to 608 and the kernel
    /// would reject the wasm32-userland ioctl number with ENOTTY.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct WpkAlsaPcmHwParams {
        pub flags: u32,
        pub masks: [u32; 64],
        pub intervals: [WpkSndInterval; 21],
        pub rmask: u32,
        pub cmask: u32,
        pub info: u32,
        pub msbits: u32,
        pub rate_num: u32,
        pub rate_den: u32,
        pub fifo_size: u32,
        pub reserved: [u8; 64],
    }

    impl Default for WpkAlsaPcmHwParams {
        fn default() -> Self {
            Self {
                flags: 0,
                masks: [0; 64],
                intervals: [WpkSndInterval::default(); 21],
                rmask: 0,
                cmask: 0,
                info: 0,
                msbits: 0,
                rate_num: 0,
                rate_den: 0,
                fifo_size: 0,
                reserved: [0; 64],
            }
        }
    }

    /// `struct snd_pcm_sw_params`. Layout-locked against alsa-lib UAPI
    /// **as compiled for wasm32 musl** (`snd_pcm_uframes_t` =
    /// `unsigned long` = 4 bytes). Linux x86_64 has 8-byte uframes_t
    /// (struct size 136); on wasm32 the same struct collapses to
    /// 104 bytes with no leading `_pad0` because all fields are
    /// 4-byte aligned end-to-end.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct WpkAlsaPcmSwParams {
        pub tstamp_mode: u32,
        pub period_step: u32,
        pub sleep_min: u32,
        pub avail_min: u32,
        pub xfer_align: u32,
        pub start_threshold: u32,
        pub stop_threshold: u32,
        pub silence_threshold: u32,
        pub silence_size: u32,
        pub boundary: u32,
        pub proto: u32,
        pub tstamp_type: u32,
        pub reserved: [u8; 56],
    }

    impl Default for WpkAlsaPcmSwParams {
        fn default() -> Self {
            Self {
                tstamp_mode: 0,
                period_step: 0,
                sleep_min: 0,
                avail_min: 0,
                xfer_align: 0,
                start_threshold: 0,
                stop_threshold: 0,
                silence_threshold: 0,
                silence_size: 0,
                boundary: 0,
                proto: 0,
                tstamp_type: 0,
                reserved: [0; 56],
            }
        }
    }

    /// `struct snd_pcm_status` laid out for wasm32 (musl `unsigned long`
    /// = 4 B → `snd_pcm_uframes_t` = `u32`). Field offsets match the
    /// upstream alsa-lib UAPI when compiled for wasm32 with
    /// `__SND_STRUCT_TIME64` defined (which musl always does on
    /// 32-bit-long targets with 64-bit time_t). Total: 128 B.
    ///
    /// Each `timespec` is encoded as `i64 tv_sec + i32 tv_nsec + 4 B pad`
    /// — `__alignof__(long long) = 8` on wasm32, so the i32 nsec gets a
    /// trailing 4 B alignment slot before the next i64 field.
    ///
    /// All timestamps stamped from `CLOCK_MONOTONIC` so userspace can
    /// correlate audio underruns with vblank + input timestamps.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkAlsaPcmStatus {
        pub state: u32,
        pub _pad1: u32,
        pub trigger_tstamp_sec: i64,
        pub trigger_tstamp_nsec: i32,
        pub _trigger_tstamp_pad: u32,
        pub tstamp_sec: i64,
        pub tstamp_nsec: i32,
        pub _tstamp_pad: u32,
        pub appl_ptr: u32,
        pub hw_ptr: u32,
        pub delay: i32,
        pub avail: u32,
        pub avail_max: u32,
        pub overrange: u32,
        pub suspended_state: u32,
        pub audio_tstamp_data: u32,
        pub audio_tstamp_sec: i64,
        pub audio_tstamp_nsec: i32,
        pub _audio_tstamp_pad: u32,
        pub driver_tstamp_sec: i64,
        pub driver_tstamp_nsec: i32,
        pub _driver_tstamp_pad: u32,
        pub audio_tstamp_accuracy: u32,
        pub _reserved: [u8; 20],
    }

    /// `struct snd_pcm_info`. Returned by `SNDRV_PCM_IOCTL_INFO`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct WpkAlsaPcmInfo {
        pub device: u32,
        pub subdevice: u32,
        pub stream: i32,
        pub card: i32,
        pub id: [u8; 64],
        pub name: [u8; 80],
        pub subname: [u8; 32],
        pub dev_class: u32,
        pub dev_subclass: u32,
        pub subdevices_count: u32,
        pub subdevices_avail: u32,
        pub sync: [u8; 16],
        pub reserved: [u8; 64],
    }

    impl Default for WpkAlsaPcmInfo {
        fn default() -> Self {
            Self {
                device: 0,
                subdevice: 0,
                stream: 0,
                card: 0,
                id: [0; 64],
                name: [0; 80],
                subname: [0; 32],
                dev_class: 0,
                dev_subclass: 0,
                subdevices_count: 0,
                subdevices_avail: 0,
                sync: [0; 16],
                reserved: [0; 64],
            }
        }
    }

    /// `struct __snd_pcm_mmap_status64` laid out for wasm32 (musl,
    /// `__SND_STRUCT_TIME64` defined). Kernel-writes, userspace-reads.
    /// Mapped at `SNDRV_PCM_MMAP_OFFSET_STATUS` (= STATUS_NEW). Field
    /// offsets are load-bearing — userspace reads `hw_ptr` via direct
    /// memory access on the mapped page, not through an ioctl.
    ///
    /// Layout (LE wasm32):
    /// `state @ 0, _pad1 @ 4, hw_ptr (u32) @ 8, _pad_after_hw_ptr @ 12,
    /// tstamp (i64+i32+pad = 16 B) @ 16, suspended_state @ 32, _pad3 @ 36,
    /// audio_tstamp (16 B) @ 40`. Total 56 B.
    #[repr(C)]
    #[derive(Clone, Copy, Default, Debug)]
    pub struct WpkAlsaPcmMmapStatus {
        pub state: u32,
        pub _pad1: u32,
        pub hw_ptr: u32,
        pub _pad_after_hw_ptr: u32,
        pub tstamp_sec: i64,
        pub tstamp_nsec: i32,
        pub _tstamp_pad: u32,
        pub suspended_state: u32,
        pub _pad3: u32,
        pub audio_tstamp_sec: i64,
        pub audio_tstamp_nsec: i32,
        pub _audio_tstamp_pad: u32,
    }

    /// `struct __snd_pcm_mmap_control64` laid out for wasm32.
    /// Userspace-writes, kernel-reads. Mapped at
    /// `SNDRV_PCM_MMAP_OFFSET_CONTROL` (= CONTROL_NEW). Total 12 B.
    /// `_pad_after` is the upstream `__pad_after_uframe` slot at the
    /// tail.
    #[repr(C)]
    #[derive(Clone, Copy, Default, Debug)]
    pub struct WpkAlsaPcmMmapControl {
        pub appl_ptr: u32,
        pub avail_min: u32,
        pub _pad_after: u32,
    }

    /// `struct snd_xferi` — argument to `WRITEI_FRAMES` / `READI_FRAMES`.
    /// Wasm32 layout: `snd_pcm_sframes_t` = `signed long` = 4 B,
    /// `void *` = 4 B, `snd_pcm_uframes_t` = `unsigned long` = 4 B.
    /// Total 12 B (vs 24 B on x86_64).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkAlsaXferi {
        pub result: i32,
        pub buf: u32,
        pub frames: u32,
    }

}

#[cfg(test)]
mod dri_tests {
    use super::dri::*;
    use core::mem::size_of;

    /// `_IOWR(magic, nr, type)` packs (dir, size, magic, nr) into a u32.
    /// Mirrors include/uapi/asm-generic/ioctl.h.
    const fn ioc(dir: u32, magic: u32, nr: u32, size: u32) -> u32 {
        (dir << 30) | (size << 16) | (magic << 8) | nr
    }
    const IOC_READ: u32 = 2;
    const IOC_WRITE: u32 = 1;

    #[test]
    fn struct_sizes_match_linux_abi() {
        assert_eq!(size_of::<WpkDrmModeCreateDumb>(), 32);
        assert_eq!(size_of::<WpkDrmModeMapDumb>(), 16);
        assert_eq!(size_of::<WpkDrmModeDestroyDumb>(), 4);
        assert_eq!(size_of::<WpkDrmGemClose>(), 8);
        assert_eq!(size_of::<WpkDrmPrimeHandle>(), 12);
        assert_eq!(size_of::<WpkDrmGetCap>(), 16);
        assert_eq!(size_of::<WpkDrmVersion>(), 36);
    }

    #[test]
    fn ioctl_numbers_match_linux_uapi() {
        let iowr = IOC_READ | IOC_WRITE;
        assert_eq!(DRM_IOCTL_VERSION,
            ioc(iowr, 'd' as u32, 0x00, size_of::<WpkDrmVersion>() as u32));
        assert_eq!(DRM_IOCTL_GET_CAP,
            ioc(iowr, 'd' as u32, 0x0c, size_of::<WpkDrmGetCap>() as u32));
        assert_eq!(DRM_IOCTL_GEM_CLOSE,
            ioc(IOC_WRITE, 'd' as u32, 0x09, size_of::<WpkDrmGemClose>() as u32));
        assert_eq!(DRM_IOCTL_PRIME_HANDLE_TO_FD,
            ioc(iowr, 'd' as u32, 0x2d, size_of::<WpkDrmPrimeHandle>() as u32));
        assert_eq!(DRM_IOCTL_PRIME_FD_TO_HANDLE,
            ioc(iowr, 'd' as u32, 0x2e, size_of::<WpkDrmPrimeHandle>() as u32));
        assert_eq!(DRM_IOCTL_MODE_CREATE_DUMB,
            ioc(iowr, 'd' as u32, 0xb2, size_of::<WpkDrmModeCreateDumb>() as u32));
        assert_eq!(DRM_IOCTL_MODE_MAP_DUMB,
            ioc(iowr, 'd' as u32, 0xb3, size_of::<WpkDrmModeMapDumb>() as u32));
        assert_eq!(DRM_IOCTL_MODE_DESTROY_DUMB,
            ioc(iowr, 'd' as u32, 0xb4, size_of::<WpkDrmModeDestroyDumb>() as u32));
    }

    #[test]
    fn wpk_extension_sizes_match_wasm32() {
        assert_eq!(size_of::<WpkDrmGpuBoCreate>(), 16);
        assert_eq!(size_of::<WpkDrmBindForeignTexture>(), 16);
    }

    #[test]
    fn wpk_extension_ioctl_numbers() {
        let iowr = IOC_READ | IOC_WRITE;
        assert_eq!(DRM_IOCTL_WPK_CREATE_GPU_BO,
            ioc(iowr, 'd' as u32, 0xE0, size_of::<WpkDrmGpuBoCreate>() as u32));
        assert_eq!(DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE,
            ioc(iowr, 'd' as u32, 0xE1, size_of::<WpkDrmBindForeignTexture>() as u32));
    }

    #[test]
    fn drm_fourcc_constants_match_uapi() {
        const fn fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 {
            (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
        }
        assert_eq!(DRM_FORMAT_ARGB8888, fourcc(b'A', b'R', b'2', b'4'));
        assert_eq!(DRM_FORMAT_XRGB8888, fourcc(b'X', b'R', b'2', b'4'));
        assert_eq!(DRM_FORMAT_RGB565, fourcc(b'R', b'G', b'1', b'6'));
    }

    #[test]
    fn kms_struct_sizes_match_linux_abi() {
        assert_eq!(size_of::<WpkDrmModeCardRes>(), 64);
        assert_eq!(size_of::<WpkDrmModeModeinfo>(), 68);
        assert_eq!(size_of::<WpkDrmModeGetCrtc>(), 104);
        assert_eq!(size_of::<WpkDrmModeGetConnector>(), 80);
        assert_eq!(size_of::<WpkDrmModeGetEncoder>(), 20);
        assert_eq!(size_of::<WpkDrmModeFbCmd>(), 28);
        assert_eq!(size_of::<WpkDrmModeFbCmd2>(), 104);
        assert_eq!(size_of::<WpkDrmModeCrtcPageFlip>(), 24);
        assert_eq!(size_of::<WpkDrmEventVblank>(), 32);
        assert_eq!(size_of::<WpkDrmWaitVblankRequest>(), 16);
        assert_eq!(size_of::<WpkDrmWaitVblankReply>(), 16);
    }

    #[test]
    fn kms_ioctl_numbers_match_linux_uapi() {
        let iowr = IOC_READ | IOC_WRITE;
        assert_eq!(DRM_IOCTL_SET_MASTER,
            ioc(0, 'd' as u32, 0x1e, 0));
        assert_eq!(DRM_IOCTL_DROP_MASTER,
            ioc(0, 'd' as u32, 0x1f, 0));
        assert_eq!(DRM_IOCTL_WAIT_VBLANK,
            ioc(iowr, 'd' as u32, 0x3a, size_of::<WpkDrmWaitVblankRequest>() as u32));
        assert_eq!(DRM_IOCTL_MODE_GETRESOURCES,
            ioc(iowr, 'd' as u32, 0xa0, size_of::<WpkDrmModeCardRes>() as u32));
        assert_eq!(DRM_IOCTL_MODE_GETCRTC,
            ioc(iowr, 'd' as u32, 0xa1, size_of::<WpkDrmModeGetCrtc>() as u32));
        assert_eq!(DRM_IOCTL_MODE_SETCRTC,
            ioc(iowr, 'd' as u32, 0xa2, size_of::<WpkDrmModeGetCrtc>() as u32));
        assert_eq!(DRM_IOCTL_MODE_GETENCODER,
            ioc(iowr, 'd' as u32, 0xa6, size_of::<WpkDrmModeGetEncoder>() as u32));
        assert_eq!(DRM_IOCTL_MODE_GETCONNECTOR,
            ioc(iowr, 'd' as u32, 0xa7, size_of::<WpkDrmModeGetConnector>() as u32));
        assert_eq!(DRM_IOCTL_MODE_ADDFB,
            ioc(iowr, 'd' as u32, 0xae, size_of::<WpkDrmModeFbCmd>() as u32));
        assert_eq!(DRM_IOCTL_MODE_RMFB,
            ioc(iowr, 'd' as u32, 0xaf, 4));
        assert_eq!(DRM_IOCTL_MODE_PAGE_FLIP,
            ioc(iowr, 'd' as u32, 0xb0, size_of::<WpkDrmModeCrtcPageFlip>() as u32));
        assert_eq!(DRM_IOCTL_MODE_ADDFB2,
            ioc(iowr, 'd' as u32, 0xb8, size_of::<WpkDrmModeFbCmd2>() as u32));
    }

    #[test]
    fn kms_enum_constants_match_uapi() {
        assert_eq!(DRM_MODE_CONNECTOR_VIRTUAL, 15);
        assert_eq!(DRM_MODE_CONNECTED, 1);
        assert_eq!(DRM_EVENT_VBLANK, 1);
        assert_eq!(DRM_EVENT_FLIP_COMPLETE, 2);
    }
}

#[cfg(test)]
mod gl_tests {
    use super::gl::*;
    use core::mem::size_of;

    #[test]
    fn struct_sizes_match_abi() {
        assert_eq!(size_of::<GlSubmitInfo>(),    8);
        assert_eq!(size_of::<GlContextAttrs>(), 16);
        assert_eq!(size_of::<GlSurfaceAttrs>(), 32);
        assert_eq!(size_of::<GlQueryInfo>(),    24);
    }

    #[test]
    fn cmdbuf_len_is_one_mib() {
        assert_eq!(CMDBUF_LEN, 1024 * 1024);
    }

    #[test]
    fn opcodes_are_unique() {
        let ops: &[u16] = &[
            OP_CLEAR, OP_CLEAR_COLOR, OP_VIEWPORT, OP_SCISSOR,
            OP_ENABLE, OP_DISABLE, OP_BLEND_FUNC, OP_DEPTH_FUNC,
            OP_CULL_FACE, OP_FRONT_FACE, OP_LINE_WIDTH, OP_PIXEL_STOREI,
            OP_GEN_BUFFERS, OP_DELETE_BUFFERS, OP_BIND_BUFFER,
            OP_BUFFER_DATA, OP_BUFFER_SUB_DATA,
            OP_GEN_TEXTURES, OP_DELETE_TEXTURES, OP_BIND_TEXTURE,
            OP_TEX_IMAGE_2D, OP_TEX_SUB_IMAGE_2D, OP_TEX_PARAMETERI,
            OP_ACTIVE_TEXTURE, OP_GENERATE_MIPMAP,
            OP_CREATE_SHADER, OP_SHADER_SOURCE, OP_COMPILE_SHADER,
            OP_DELETE_SHADER, OP_CREATE_PROGRAM, OP_ATTACH_SHADER,
            OP_LINK_PROGRAM, OP_USE_PROGRAM, OP_BIND_ATTRIB_LOCATION,
            OP_DELETE_PROGRAM,
            OP_UNIFORM1I, OP_UNIFORM1F, OP_UNIFORM2F, OP_UNIFORM3F,
            OP_UNIFORM4F, OP_UNIFORM_MATRIX4FV, OP_UNIFORM4FV,
            OP_ENABLE_VERTEX_ATTRIB_ARRAY, OP_DISABLE_VERTEX_ATTRIB_ARRAY,
            OP_VERTEX_ATTRIB_POINTER, OP_DRAW_ARRAYS, OP_DRAW_ELEMENTS,
            OP_GEN_VERTEX_ARRAYS, OP_DELETE_VERTEX_ARRAYS,
            OP_BIND_VERTEX_ARRAY,
            OP_GEN_FRAMEBUFFERS, OP_BIND_FRAMEBUFFER,
            OP_FRAMEBUFFER_TEXTURE_2D, OP_GEN_RENDERBUFFERS,
            OP_BIND_RENDERBUFFER, OP_RENDERBUFFER_STORAGE,
            OP_FRAMEBUFFER_RENDERBUFFER,
        ];
        for (i, &a) in ops.iter().enumerate() {
            for &b in &ops[i + 1..] {
                assert_ne!(a, b, "duplicate opcode 0x{a:04x}");
            }
        }
    }

    #[test]
    fn query_opcodes_are_unique() {
        let qops: &[u32] = &[
            QOP_GET_ERROR, QOP_GET_STRING, QOP_GET_INTEGERV,
            QOP_GET_FLOATV, QOP_GET_UNIFORM_LOC, QOP_GET_ATTRIB_LOC,
            QOP_GET_SHADERIV, QOP_GET_SHADER_INFO_LOG, QOP_GET_PROGRAMIV,
            QOP_GET_PROGRAM_INFO_LOG, QOP_READ_PIXELS, QOP_CHECK_FB_STATUS,
        ];
        for (i, &a) in qops.iter().enumerate() {
            for &b in &qops[i + 1..] {
                assert_ne!(a, b, "duplicate query opcode 0x{a:02x}");
            }
        }
    }
}

#[cfg(test)]
mod input_tests {
    use super::input::*;
    use core::mem::size_of;

    // Linux's `_IOC` packs (dir, size, magic, nr) into a u32.
    // Mirrors include/uapi/asm-generic/ioctl.h. `IOC_READ = 2`
    // (`_IOR`); `IOC_WRITE = 1` (`_IOW`).
    const fn ioc(dir: u32, magic: u32, nr: u32, size: u32) -> u32 {
        (dir << 30) | (size << 16) | (magic << 8) | nr
    }
    const IOC_READ: u32 = 2;
    const IOC_WRITE: u32 = 1;

    #[test]
    fn input_struct_sizes_match_wasm32_repr_c() {
        assert_eq!(size_of::<WpkInputEvent>(), 24);
        assert_eq!(size_of::<WpkInputId>(), 8);
        assert_eq!(size_of::<WpkInputAbsinfo>(), 24);
    }

    #[test]
    fn input_event_field_offsets() {
        // The 24-byte layout is load-bearing — every reader walks
        // the ring 24 bytes at a time. Lock the offsets explicitly.
        let e = WpkInputEvent::default();
        let base = (&e as *const _) as usize;
        assert_eq!((&e.tv_sec as *const _ as usize) - base, 0);
        assert_eq!((&e.tv_usec as *const _ as usize) - base, 8);
        assert_eq!((&e.ev_type as *const _ as usize) - base, 16);
        assert_eq!((&e.code as *const _ as usize) - base, 18);
        assert_eq!((&e.value as *const _ as usize) - base, 20);
    }

    #[test]
    fn evioc_numbers_match_linux_uapi() {
        assert_eq!(
            EVIOCGVERSION,
            ioc(IOC_READ, 'E' as u32, 0x01, 4)
        );
        assert_eq!(
            EVIOCGID,
            ioc(IOC_READ, 'E' as u32, 0x02, size_of::<WpkInputId>() as u32)
        );
        assert_eq!(
            EVIOCGRAB,
            ioc(IOC_WRITE, 'E' as u32, 0x90, 4)
        );
        // EVIOCGABS(ABS_X) — exercises both the variable nr base
        // and the absinfo struct size.
        assert_eq!(
            ioc(
                IOC_READ,
                'E' as u32,
                EVIOCGABS_NR_BASE + ABS_X as u32,
                size_of::<WpkInputAbsinfo>() as u32
            ),
            0x8018_4540
        );
    }

    #[test]
    fn evioc_nr_bases_match_linux_uapi() {
        // Spot-check the variable-length / per-axis bases used by
        // A3's dispatch; the precise number is only known once the
        // size field is filled in at ioctl time.
        assert_eq!(EVIOCGNAME_NR, 0x06);
        assert_eq!(EVIOCGBIT_NR_BASE, 0x20);
        assert_eq!(EVIOCGABS_NR_BASE, 0x40);
    }
}

#[cfg(test)]
mod audio_tests {
    use super::audio::*;
    use core::mem::size_of;

    const fn ioc(dir: u32, magic: u32, nr: u32, size: u32) -> u32 {
        (dir << 30) | (size << 16) | (magic << 8) | nr
    }
    const IOC_READ: u32 = 2;
    const IOC_WRITE: u32 = 1;
    const IOC_RW: u32 = 3;

    #[test]
    fn audio_struct_sizes_match_wasm32_repr_c() {
        // These numbers lock the wasm32 `repr(C)` layout.
        // HwParams = 604 follows Linux v6.10 sized for wasm32:
        //   4 (flags) + 256 (mask[64]=u32) + 252 (interval[21]=3xu32)
        //   + 6*4 (rmask/cmask/info/msbits/rate_num/rate_den)
        //   + 4 (fifo_size: snd_pcm_uframes_t = unsigned long, 4 B on
        //     wasm32) + 64 (reserved) = 604.
        assert_eq!(size_of::<WpkSndInterval>(), 12);
        assert_eq!(size_of::<WpkAlsaPcmHwParams>(), 604);
        assert_eq!(size_of::<WpkAlsaPcmSwParams>(), 104);
        assert_eq!(size_of::<WpkAlsaPcmStatus>(), 128);
        assert_eq!(size_of::<WpkAlsaPcmInfo>(), 288);
        assert_eq!(size_of::<WpkAlsaPcmMmapStatus>(), 56);
        assert_eq!(size_of::<WpkAlsaPcmMmapControl>(), 12);
        assert_eq!(size_of::<WpkAlsaXferi>(), 12);
    }

    #[test]
    fn audio_pcm_status_field_offsets() {
        let s = WpkAlsaPcmStatus::default();
        let base = (&s as *const _) as usize;
        assert_eq!((&s.state as *const _ as usize) - base, 0);
        assert_eq!((&s.trigger_tstamp_sec as *const _ as usize) - base, 8);
        assert_eq!((&s.tstamp_sec as *const _ as usize) - base, 24);
        assert_eq!((&s.appl_ptr as *const _ as usize) - base, 40);
        assert_eq!((&s.hw_ptr as *const _ as usize) - base, 44);
        assert_eq!((&s.delay as *const _ as usize) - base, 48);
        assert_eq!((&s.avail as *const _ as usize) - base, 52);
        assert_eq!((&s.suspended_state as *const _ as usize) - base, 64);
        assert_eq!((&s.audio_tstamp_sec as *const _ as usize) - base, 72);
        assert_eq!((&s.driver_tstamp_sec as *const _ as usize) - base, 88);
        assert_eq!((&s.audio_tstamp_accuracy as *const _ as usize) - base, 104);
    }

    #[test]
    fn audio_mmap_status_field_offsets() {
        // The mmap_status page is read by userspace via direct memory
        // access — userspace polls hw_ptr without an ioctl round-trip.
        let s = WpkAlsaPcmMmapStatus::default();
        let base = (&s as *const _) as usize;
        assert_eq!((&s.state as *const _ as usize) - base, 0);
        assert_eq!((&s.hw_ptr as *const _ as usize) - base, 8);
        assert_eq!((&s.tstamp_sec as *const _ as usize) - base, 16);
        assert_eq!((&s.suspended_state as *const _ as usize) - base, 32);
        assert_eq!((&s.audio_tstamp_sec as *const _ as usize) - base, 40);
    }

    #[test]
    fn audio_mmap_control_field_offsets() {
        let c = WpkAlsaPcmMmapControl::default();
        let base = (&c as *const _) as usize;
        assert_eq!((&c.appl_ptr as *const _ as usize) - base, 0);
        assert_eq!((&c.avail_min as *const _ as usize) - base, 4);
    }

    #[test]
    fn pcm_ioctl_numbers_match_linux_uapi() {
        assert_eq!(
            SNDRV_PCM_IOCTL_PVERSION,
            ioc(IOC_READ, 'A' as u32, 0x00, 4)
        );
        assert_eq!(
            SNDRV_PCM_IOCTL_HW_PARAMS,
            ioc(IOC_RW, 'A' as u32, 0x11, size_of::<WpkAlsaPcmHwParams>() as u32)
        );
        assert_eq!(
            SNDRV_PCM_IOCTL_SW_PARAMS,
            ioc(IOC_RW, 'A' as u32, 0x13, size_of::<WpkAlsaPcmSwParams>() as u32)
        );
        assert_eq!(
            SNDRV_PCM_IOCTL_STATUS,
            ioc(IOC_READ, 'A' as u32, 0x20, size_of::<WpkAlsaPcmStatus>() as u32)
        );
        assert_eq!(
            SNDRV_PCM_IOCTL_HWSYNC,
            ioc(0, 'A' as u32, 0x22, 0)
        );
        assert_eq!(
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            ioc(IOC_WRITE, 'A' as u32, 0x50, size_of::<WpkAlsaXferi>() as u32)
        );
    }

}
