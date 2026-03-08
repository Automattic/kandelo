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
    EBADF = 9,
    EAGAIN = 11,
    ENOMEM = 12,
    EACCES = 13,
    EFAULT = 14,
    EEXIST = 17,
    EXDEV = 18,
    ENOTDIR = 20,
    EISDIR = 21,
    EINVAL = 22,
    ENFILE = 23,
    EMFILE = 24,
    ENOSPC = 28,
    ESPIPE = 29,
    EROFS = 30,
    EMLINK = 31,
    EPIPE = 32,
    ERANGE = 34,
    ENAMETOOLONG = 36,
    ENOSYS = 38,
    ENOTEMPTY = 39,
    ELOOP = 40,
    EOVERFLOW = 75,
    ECONNRESET = 104,
    ENOTCONN = 107,
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
            9 => Some(Errno::EBADF),
            11 => Some(Errno::EAGAIN),
            12 => Some(Errno::ENOMEM),
            13 => Some(Errno::EACCES),
            14 => Some(Errno::EFAULT),
            17 => Some(Errno::EEXIST),
            18 => Some(Errno::EXDEV),
            20 => Some(Errno::ENOTDIR),
            21 => Some(Errno::EISDIR),
            22 => Some(Errno::EINVAL),
            23 => Some(Errno::ENFILE),
            24 => Some(Errno::EMFILE),
            28 => Some(Errno::ENOSPC),
            29 => Some(Errno::ESPIPE),
            30 => Some(Errno::EROFS),
            31 => Some(Errno::EMLINK),
            32 => Some(Errno::EPIPE),
            34 => Some(Errno::ERANGE),
            36 => Some(Errno::ENAMETOOLONG),
            38 => Some(Errno::ENOSYS),
            39 => Some(Errno::ENOTEMPTY),
            40 => Some(Errno::ELOOP),
            75 => Some(Errno::EOVERFLOW),
            104 => Some(Errno::ECONNRESET),
            107 => Some(Errno::ENOTCONN),
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
    pub const O_DIRECTORY: u32 = 0o200000;
    pub const O_CLOEXEC: u32 = 0o2000000;
}

/// File descriptor flags (FD_*).
pub mod fd_flags {
    pub const FD_CLOEXEC: u32 = 1;
}

/// fcntl command constants (F_*).
pub mod fcntl_cmd {
    pub const F_DUPFD: u32 = 0;
    pub const F_GETFD: u32 = 1;
    pub const F_SETFD: u32 = 2;
    pub const F_GETFL: u32 = 3;
    pub const F_SETFL: u32 = 4;
    pub const F_DUPFD_CLOEXEC: u32 = 1030;
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
    /// Minimum total size of a channel in bytes (header + 64 KiB data buffer).
    pub const MIN_CHANNEL_SIZE: usize = 40 + 65536;
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
