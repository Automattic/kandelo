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
pub const ABI_VERSION: u32 = 13;

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

    /// Host default pthread slot reservation when a program declares
    /// [`THREAD_SLOTS_USE_HOST_DEFAULT`].
    pub const DEFAULT_THREAD_SLOTS: u32 = 16;

    /// A process-wasm declaration value meaning "use the host default".
    pub const THREAD_SLOTS_USE_HOST_DEFAULT: i32 = -1;

    /// A process-wasm declaration value meaning "reserve no pthread slots".
    pub const THREAD_SLOTS_NONE: i32 = 0;

    /// Export name of the process-wasm constant-return function that declares
    /// the requested pthread slot reservation.
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
        "kernel_set_mode",
        "kernel_wait4_poll",
    ];

    pub const HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS: &[&str] = &[
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
