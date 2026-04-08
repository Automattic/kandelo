#![no_std]

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

    // Return value for failure
    pub const MAP_FAILED: u32 = 0xFFFFFFFF;
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
pub mod channel {
    /// Byte offset of the status field (u32, atomic).
    pub const STATUS_OFFSET: usize = 0;
    /// Byte offset of the syscall number field (u32).
    pub const SYSCALL_OFFSET: usize = 4;
    /// Byte offset of the first argument slot (u32 each).
    pub const ARGS_OFFSET: usize = 8;
    /// Number of argument slots.
    pub const ARGS_COUNT: usize = 6;
    /// Byte offset of the return value field (i32).
    pub const RETURN_OFFSET: usize = 32;
    /// Byte offset of the errno field (u32).
    pub const ERRNO_OFFSET: usize = 36;
    /// Byte offset of the data buffer region.
    pub const DATA_OFFSET: usize = 40;
    /// Size of the data buffer.
    pub const DATA_SIZE: usize = 65536;
    /// Minimum total size of a channel in bytes (header + 64 KiB data buffer).
    pub const MIN_CHANNEL_SIZE: usize = 40 + 65536;

    // Signal delivery area — last 32 bytes of the data buffer.
    // After each syscall, if a signal with a Handler disposition is pending,
    // the kernel writes delivery info here so the glue code can invoke it.
    /// Base offset of signal delivery area.
    pub const SIG_BASE: usize = DATA_OFFSET + DATA_SIZE - 32;
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
    pub l_type: i16,    // F_RDLCK, F_WRLCK, F_UNLCK (short)
    pub l_whence: i16,  // SEEK_SET, SEEK_CUR, SEEK_END (short)
    pub _pad1: u32,     // padding to align l_start to 8 bytes
    pub l_start: i64,   // offset (off_t = long long on wasm32)
    pub l_len: i64,     // length (0 = to end of file)
    pub l_pid: u32,     // process ID (pid_t = int)
    pub _pad2: u32,     // trailing padding for struct alignment
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
    pub const SA_DEFAULT_TERM: u32 = 0;   // Terminate
    pub const SA_DEFAULT_IGN: u32 = 1;    // Ignore
    pub const SA_DEFAULT_CORE: u32 = 2;   // Core dump (treated as terminate in Wasm)
    pub const SA_DEFAULT_STOP: u32 = 3;   // Stop (not supported in Wasm)
    pub const SA_DEFAULT_CONT: u32 = 4;   // Continue (not supported in Wasm)
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
