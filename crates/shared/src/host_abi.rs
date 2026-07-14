//! Host adapter ABI metadata.
//!
//! These tables describe how the JavaScript host adapter copies pointer
//! arguments between process memory and the kernel scratch channel before
//! calling `kernel_handle_channel`. The host still owns the memory copies and
//! platform scheduling; Rust owns the ABI-sensitive syscall argument shapes.

use core::mem::size_of;

use crate::abi::extended_syscalls as extra_syscalls;
use crate::{
    SCHED_AFFINITY_MASK_SIZE, Syscall, WASM_RUSAGE_WIRE_SIZE, WasmStat, WasmStatfs,
    WasmTimespec,
};

/// Direction of a marshalled pointer argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyscallArgDirection {
    In,
    Out,
    InOut,
}

/// How the host computes the byte length for a pointer argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyscallArgSize {
    /// A nul-terminated string in process memory.
    CString,
    /// Byte length comes from another syscall argument.
    Arg {
        arg_index: u8,
        multiplier: u32,
        add: u32,
    },
    /// Byte length is read as a little-endian `u32` through another pointer
    /// argument, e.g. `socklen_t *`.
    Deref { arg_index: u8 },
    /// Fixed byte length.
    Fixed { size: u32 },
    /// Length encoded in an ioctl request argument. Requests from older Unix
    /// ioctl families that do not encode a size use [`ioctl_arg_size`]'s
    /// explicit compatibility table instead of a blanket scratch-buffer size.
    Ioctl { request_arg_index: u8 },
}

/// Decode Kandelo's owned ioctl argument size. `_IOC` requests carry a
/// 14-bit size in bits 16..29. Older terminal/fbdev/custom requests do not;
/// keep those exact sizes here so host and direct-kernel paths agree.
pub const fn ioctl_arg_size(request: u32) -> u32 {
    let encoded = (request >> 16) & 0x3fff;
    if encoded != 0 {
        return encoded;
    }
    match request {
        // Generic fd/terminal requests with legacy Linux encodings.
        0x5421 | 0x5452 | 0x541b | 0x8905 => 4,
        0x5401 | 0x5402 | 0x5403 | 0x5404 => 60,
        0x540f | 0x5410 | 0x5429 => 4,
        0x5413 | 0x5414 => 8,
        0x4b33 => 1,
        0x4b44 | 0x4b45 => 4,

        // Linux fbdev request numbers predate `_IOC` size encoding.
        0x4600 | 0x4601 | 0x4606 => 160,
        0x4602 => 80,

        // Kandelo GL bridge custom requests.
        0x40 => 4,
        0x42 => 16,
        0x44 => 32,
        0x47 => 8,
        0x49 => 24,

        // Commands with no argument, including OSS RESET/SYNC/POST/NONBLOCK,
        // descriptor close-on-exec toggles, and terminal no-op controls.
        _ => 0,
    }
}

/// One pointer argument descriptor for host-side marshalling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyscallArgDesc {
    pub arg_index: u8,
    pub direction: SyscallArgDirection,
    pub size: SyscallArgSize,
    /// Whether a null pointer is a valid request to omit this argument.
    pub nullable: bool,
    /// Whether a non-C-string pointer must be non-null.
    pub required: bool,
    /// Extra bytes to copy back when an output `Arg`-sized buffer's copied
    /// length is based on the syscall return value. `msgrcv` returns only
    /// `mtext` length, but the scratch buffer also includes the leading mtype.
    pub copy_retval_add: u32,
}

/// All pointer argument descriptors for one syscall number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyscallArgDescriptor {
    pub syscall_number: u32,
    pub args: &'static [SyscallArgDesc],
}

macro_rules! cstring {
    () => {
        SyscallArgSize::CString
    };
}

macro_rules! arg {
    ($arg_index:expr) => {
        SyscallArgSize::Arg {
            arg_index: $arg_index,
            multiplier: 1,
            add: 0,
        }
    };
    ($arg_index:expr, mul $multiplier:expr) => {
        SyscallArgSize::Arg {
            arg_index: $arg_index,
            multiplier: $multiplier,
            add: 0,
        }
    };
    ($arg_index:expr, add $add:expr) => {
        SyscallArgSize::Arg {
            arg_index: $arg_index,
            multiplier: 1,
            add: $add,
        }
    };
}

macro_rules! deref {
    ($arg_index:expr) => {
        SyscallArgSize::Deref {
            arg_index: $arg_index,
        }
    };
}

macro_rules! fixed {
    ($size:expr) => {
        SyscallArgSize::Fixed { size: $size }
    };
}

macro_rules! ioctl_size {
    ($request_arg_index:expr) => {
        SyscallArgSize::Ioctl {
            request_arg_index: $request_arg_index,
        }
    };
}

macro_rules! desc {
    ($arg_index:expr, $direction:ident, $size:expr) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            nullable: false,
            required: false,
            copy_retval_add: 0,
        }
    };
    ($arg_index:expr, $direction:ident, $size:expr, nullable) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            nullable: true,
            required: false,
            copy_retval_add: 0,
        }
    };
    ($arg_index:expr, $direction:ident, $size:expr, required) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            nullable: false,
            required: true,
            copy_retval_add: 0,
        }
    };
    ($arg_index:expr, $direction:ident, $size:expr, copy_retval_add $copy_retval_add:expr) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            nullable: false,
            required: false,
            copy_retval_add: $copy_retval_add,
        }
    };
}

macro_rules! entry {
    ($syscall_number:expr, [ $($desc:expr),* $(,)? ]) => {
        SyscallArgDescriptor {
            syscall_number: $syscall_number,
            args: &[$($desc),*],
        }
    };
}

const WASM_STAT_SIZE: u32 = size_of::<WasmStat>() as u32;
const WASM_TIMESPEC_SIZE: u32 = size_of::<WasmTimespec>() as u32;
const WASM_STATFS_SIZE: u32 = size_of::<WasmStatfs>() as u32;

const ITIMERVAL_SIZE: u32 = 16;
const RLIMIT_SIZE: u32 = 16;
const STACK_T_SIZE: u32 = 12;

/// Host-side syscall pointer argument descriptors.
///
/// The values are sorted by syscall number for deterministic codegen and
/// snapshot output.
pub const SYSCALL_ARG_DESCRIPTORS: &[SyscallArgDescriptor] = &[
    entry!(Syscall::Open as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Read as u32, [desc!(1, Out, arg!(2))]),
    entry!(Syscall::Write as u32, [desc!(1, In, arg!(2))]),
    entry!(
        Syscall::Fstat as u32,
        [desc!(1, Out, fixed!(WASM_STAT_SIZE))]
    ),
    entry!(Syscall::Pipe as u32, [desc!(0, Out, fixed!(8))]),
    entry!(
        Syscall::Stat as u32,
        [
            desc!(0, In, cstring!()),
            desc!(1, Out, fixed!(WASM_STAT_SIZE)),
        ]
    ),
    entry!(
        Syscall::Lstat as u32,
        [
            desc!(0, In, cstring!()),
            desc!(1, Out, fixed!(WASM_STAT_SIZE)),
        ]
    ),
    entry!(Syscall::Mkdir as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Rmdir as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Unlink as u32, [desc!(0, In, cstring!())]),
    entry!(
        Syscall::Rename as u32,
        [desc!(0, In, cstring!()), desc!(1, In, cstring!()),]
    ),
    entry!(
        Syscall::Link as u32,
        [desc!(0, In, cstring!()), desc!(1, In, cstring!()),]
    ),
    entry!(
        Syscall::Symlink as u32,
        [desc!(0, In, cstring!()), desc!(1, In, cstring!()),]
    ),
    entry!(
        Syscall::Readlink as u32,
        [desc!(0, In, cstring!()), desc!(1, Out, arg!(2)),]
    ),
    entry!(Syscall::Chmod as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Chown as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Access as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Getcwd as u32, [desc!(0, Out, arg!(1))]),
    entry!(Syscall::Chdir as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Opendir as u32, [desc!(0, In, cstring!())]),
    entry!(
        Syscall::Readdir as u32,
        [desc!(1, Out, fixed!(16)), desc!(2, Out, arg!(3)),]
    ),
    entry!(
        Syscall::Sigaction as u32,
        [desc!(1, In, fixed!(16)), desc!(2, Out, fixed!(16)),]
    ),
    entry!(
        Syscall::Sigprocmask as u32,
        [desc!(1, In, fixed!(8)), desc!(2, Out, fixed!(8)),]
    ),
    entry!(
        Syscall::ClockGettime as u32,
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        Syscall::Nanosleep as u32,
        [desc!(0, In, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        Syscall::GetEnv as u32,
        [desc!(0, In, cstring!()), desc!(1, Out, arg!(2)),]
    ),
    entry!(
        Syscall::SetEnv as u32,
        [desc!(0, In, cstring!()), desc!(1, In, cstring!()),]
    ),
    entry!(Syscall::UnsetEnv as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Bind as u32, [desc!(1, In, arg!(2))]),
    entry!(
        Syscall::Accept as u32,
        [desc!(1, Out, deref!(2)), desc!(2, InOut, fixed!(4)),]
    ),
    entry!(Syscall::Connect as u32, [desc!(1, In, arg!(2))]),
    entry!(Syscall::Send as u32, [desc!(1, In, arg!(2))]),
    entry!(Syscall::Recv as u32, [desc!(1, Out, arg!(2))]),
    entry!(
        Syscall::Getsockopt as u32,
        [desc!(3, Out, deref!(4)), desc!(4, InOut, fixed!(4)),]
    ),
    entry!(Syscall::Setsockopt as u32, [desc!(3, In, arg!(4))]),
    entry!(Syscall::Poll as u32, [desc!(0, InOut, arg!(1, mul 8))]),
    entry!(Syscall::Socketpair as u32, [desc!(3, Out, fixed!(8))]),
    entry!(
        Syscall::Sendto as u32,
        [desc!(1, In, arg!(2)), desc!(4, In, arg!(5)),]
    ),
    entry!(
        Syscall::Recvfrom as u32,
        [
            desc!(1, Out, arg!(2)),
            desc!(4, Out, deref!(5)),
            desc!(5, InOut, fixed!(4)),
        ]
    ),
    entry!(Syscall::Pread as u32, [desc!(1, Out, arg!(2))]),
    entry!(Syscall::Pwrite as u32, [desc!(1, In, arg!(2))]),
    entry!(Syscall::Openat as u32, [desc!(1, In, cstring!())]),
    entry!(Syscall::Tcgetattr as u32, [desc!(1, Out, fixed!(256))]),
    entry!(Syscall::Tcsetattr as u32, [desc!(2, In, fixed!(256))]),
    entry!(Syscall::Ioctl as u32, [desc!(2, InOut, ioctl_size!(1), nullable)]),
    entry!(Syscall::Uname as u32, [desc!(0, Out, fixed!(390))]),
    entry!(Syscall::Pipe2 as u32, [desc!(0, Out, fixed!(8))]),
    entry!(
        Syscall::Getrlimit as u32,
        [desc!(1, Out, fixed!(RLIMIT_SIZE))]
    ),
    entry!(
        Syscall::Setrlimit as u32,
        [desc!(1, In, fixed!(RLIMIT_SIZE))]
    ),
    entry!(Syscall::Truncate as u32, [desc!(0, In, cstring!())]),
    entry!(
        Syscall::Fstatat as u32,
        [
            desc!(1, In, cstring!()),
            desc!(2, Out, fixed!(WASM_STAT_SIZE)),
        ]
    ),
    entry!(Syscall::Unlinkat as u32, [desc!(1, In, cstring!())]),
    entry!(Syscall::Mkdirat as u32, [desc!(1, In, cstring!())]),
    entry!(
        Syscall::Renameat as u32,
        [desc!(1, In, cstring!()), desc!(3, In, cstring!()),]
    ),
    entry!(Syscall::Faccessat as u32, [desc!(1, In, cstring!())]),
    entry!(Syscall::Fchmodat as u32, [desc!(1, In, cstring!())]),
    entry!(Syscall::Fchownat as u32, [desc!(1, In, cstring!())]),
    entry!(
        Syscall::Linkat as u32,
        [desc!(1, In, cstring!()), desc!(3, In, cstring!()),]
    ),
    entry!(
        Syscall::Symlinkat as u32,
        [desc!(0, In, cstring!()), desc!(2, In, cstring!()),]
    ),
    entry!(
        Syscall::Readlinkat as u32,
        [desc!(1, In, cstring!()), desc!(2, Out, arg!(3)),]
    ),
    entry!(
        Syscall::Getrusage as u32,
        [desc!(1, Out, fixed!(WASM_RUSAGE_WIRE_SIZE), required)]
    ),
    entry!(
        Syscall::Realpath as u32,
        [desc!(0, In, cstring!()), desc!(1, Out, arg!(2)),]
    ),
    entry!(Syscall::Sigsuspend as u32, [desc!(0, In, fixed!(8))]),
    entry!(
        Syscall::Pathconf as u32,
        [
            desc!(0, In, cstring!()),
            desc!(2, Out, fixed!(8), required),
        ]
    ),
    entry!(
        Syscall::Fpathconf as u32,
        [desc!(2, Out, fixed!(8), required)]
    ),
    entry!(
        Syscall::Getsockname as u32,
        [desc!(1, Out, deref!(2)), desc!(2, InOut, fixed!(4)),]
    ),
    entry!(
        Syscall::Getpeername as u32,
        [desc!(1, Out, deref!(2)), desc!(2, InOut, fixed!(4)),]
    ),
    entry!(extra_syscalls::SYS_LLSEEK, [desc!(3, Out, fixed!(8))]),
    entry!(extra_syscalls::SYS_GETRANDOM, [desc!(0, Out, arg!(1))]),
    entry!(Syscall::Getdents64 as u32, [desc!(1, Out, arg!(2))]),
    entry!(
        Syscall::ClockGetres as u32,
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        Syscall::ClockNanosleep as u32,
        [desc!(2, In, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        Syscall::Utimensat as u32,
        [
            desc!(1, In, cstring!(), nullable),
            desc!(2, In, fixed!(WASM_TIMESPEC_SIZE * 2)),
        ]
    ),
    entry!(
        Syscall::Statfs as u32,
        [
            desc!(0, In, cstring!()),
            desc!(2, Out, fixed!(WASM_STATFS_SIZE)),
        ]
    ),
    entry!(
        Syscall::Fstatfs as u32,
        [desc!(2, Out, fixed!(WASM_STATFS_SIZE))]
    ),
    entry!(
        Syscall::Getresuid as u32,
        [
            desc!(0, Out, fixed!(4)),
            desc!(1, Out, fixed!(4)),
            desc!(2, Out, fixed!(4)),
        ]
    ),
    entry!(
        Syscall::Getresgid as u32,
        [
            desc!(0, Out, fixed!(4)),
            desc!(1, Out, fixed!(4)),
            desc!(2, Out, fixed!(4)),
        ]
    ),
    entry!(Syscall::Sendmsg as u32, [desc!(1, In, arg!(2))]),
    entry!(Syscall::Recvmsg as u32, [desc!(1, InOut, arg!(2))]),
    entry!(
        Syscall::Wait4 as u32,
        [
            desc!(1, Out, fixed!(4)),
            desc!(3, Out, fixed!(WASM_RUSAGE_WIRE_SIZE)),
        ]
    ),
    entry!(
        Syscall::Getaddrinfo as u32,
        [desc!(0, In, cstring!()), desc!(1, Out, fixed!(256)),]
    ),
    entry!(
        extra_syscalls::SYS_RT_SIGQUEUEINFO,
        [desc!(2, In, fixed!(128))]
    ),
    entry!(
        extra_syscalls::SYS_RT_SIGPENDING,
        [desc!(0, Out, fixed!(8))]
    ),
    entry!(
        extra_syscalls::SYS_RT_SIGTIMEDWAIT,
        [
            desc!(0, In, fixed!(8)),
            desc!(1, Out, fixed!(128)),
            desc!(2, In, fixed!(WASM_TIMESPEC_SIZE)),
        ]
    ),
    entry!(
        extra_syscalls::SYS_SIGALTSTACK,
        [
            desc!(0, In, fixed!(STACK_T_SIZE)),
            desc!(1, Out, fixed!(STACK_T_SIZE)),
        ]
    ),
    entry!(
        crate::abi::host_intercepted::SYS_EXECVE,
        [desc!(0, In, cstring!())]
    ),
    entry!(extra_syscalls::SYS_PRCTL, [desc!(1, InOut, fixed!(16))]),
    entry!(
        extra_syscalls::SYS_GETITIMER,
        [desc!(1, Out, fixed!(ITIMERVAL_SIZE))]
    ),
    entry!(
        extra_syscalls::SYS_SETITIMER,
        [
            desc!(1, In, fixed!(ITIMERVAL_SIZE)),
            desc!(2, Out, fixed!(ITIMERVAL_SIZE)),
        ]
    ),
    entry!(
        extra_syscalls::SYS_SCHED_GETPARAM,
        [desc!(1, Out, fixed!(36))]
    ),
    entry!(
        extra_syscalls::SYS_SCHED_RR_GET_INTERVAL,
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        extra_syscalls::SYS_SCHED_GETAFFINITY,
        [desc!(2, Out, fixed!(SCHED_AFFINITY_MASK_SIZE), required)]
    ),
    entry!(
        extra_syscalls::SYS_PRLIMIT64,
        [desc!(2, In, fixed!(16)), desc!(3, Out, fixed!(16)),]
    ),
    entry!(extra_syscalls::SYS_PPOLL, [desc!(0, InOut, arg!(1, mul 8))]),
    entry!(
        extra_syscalls::SYS_STATX,
        [desc!(1, In, cstring!()), desc!(4, Out, fixed!(256)),]
    ),
    entry!(extra_syscalls::SYS_MKNOD, [desc!(0, In, cstring!())]),
    entry!(extra_syscalls::SYS_MKNODAT, [desc!(1, In, cstring!())]),
    entry!(
        extra_syscalls::SYS_WAITID,
        [
            desc!(2, Out, fixed!(128), required),
            desc!(4, Out, fixed!(WASM_RUSAGE_WIRE_SIZE), nullable),
        ]
    ),
    entry!(extra_syscalls::SYS_LCHOWN, [desc!(0, In, cstring!())]),
    entry!(
        extra_syscalls::SYS_TIMER_CREATE,
        [desc!(1, In, fixed!(16)), desc!(2, Out, fixed!(4)),]
    ),
    entry!(
        extra_syscalls::SYS_TIMER_SETTIME,
        [desc!(2, In, fixed!(32)), desc!(3, Out, fixed!(32)),]
    ),
    entry!(
        extra_syscalls::SYS_TIMER_GETTIME,
        [desc!(1, Out, fixed!(32))]
    ),
    entry!(
        extra_syscalls::SYS_MQ_OPEN,
        [desc!(0, In, cstring!()), desc!(3, In, fixed!(32)),]
    ),
    entry!(extra_syscalls::SYS_MQ_UNLINK, [desc!(0, In, cstring!())]),
    entry!(
        extra_syscalls::SYS_MQ_TIMEDSEND,
        [
            desc!(1, In, arg!(2)),
            desc!(4, In, fixed!(WASM_TIMESPEC_SIZE)),
        ]
    ),
    entry!(
        extra_syscalls::SYS_MQ_TIMEDRECEIVE,
        [
            desc!(1, Out, arg!(2)),
            desc!(3, Out, fixed!(4)),
            desc!(4, In, fixed!(WASM_TIMESPEC_SIZE)),
        ]
    ),
    entry!(extra_syscalls::SYS_MQ_NOTIFY, [desc!(1, In, fixed!(16))]),
    entry!(
        extra_syscalls::SYS_MQ_GETSETATTR,
        [desc!(1, In, fixed!(32)), desc!(2, Out, fixed!(32)),]
    ),
    entry!(
        extra_syscalls::SYS_MSGRCV,
        [desc!(1, Out, arg!(2, add 4), copy_retval_add 4)]
    ),
    entry!(extra_syscalls::SYS_MSGSND, [desc!(1, In, arg!(2, add 4))]),
    entry!(extra_syscalls::SYS_MSGCTL, [desc!(2, InOut, fixed!(96))]),
    entry!(extra_syscalls::SYS_SEMOP, [desc!(1, In, arg!(2, mul 6))]),
    entry!(extra_syscalls::SYS_SHMCTL, [desc!(2, InOut, fixed!(88))]),
    entry!(extra_syscalls::SYS_FACCESSAT2, [desc!(1, In, cstring!())]),
    entry!(extra_syscalls::SYS_FCHMODAT2, [desc!(1, In, cstring!())]),
    entry!(
        extra_syscalls::SYS_ACCEPT4,
        [desc!(1, Out, deref!(2)), desc!(2, InOut, fixed!(4)),]
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syscall_arg_descriptors_are_sorted_and_unique() {
        let mut prev = None;
        for entry in SYSCALL_ARG_DESCRIPTORS {
            if let Some(prev) = prev {
                assert!(
                    prev < entry.syscall_number,
                    "descriptor table must be sorted and unique"
                );
            }
            prev = Some(entry.syscall_number);
        }
    }

    #[test]
    fn high_risk_size_adjustments_are_metadata_owned() {
        let poll = find(Syscall::Poll as u32).args[0].size;
        assert_eq!(
            poll,
            SyscallArgSize::Arg {
                arg_index: 1,
                multiplier: 8,
                add: 0,
            }
        );

        let msgrcv = find(extra_syscalls::SYS_MSGRCV).args[0];
        assert_eq!(
            msgrcv.size,
            SyscallArgSize::Arg {
                arg_index: 2,
                multiplier: 1,
                add: 4,
            }
        );
        assert_eq!(msgrcv.copy_retval_add, 4);

        let lchown = find(extra_syscalls::SYS_LCHOWN).args[0];
        assert_eq!(lchown.arg_index, 0);
        assert_eq!(lchown.direction, SyscallArgDirection::In);
        assert_eq!(lchown.size, SyscallArgSize::CString);
        assert!(!lchown.nullable);

        let utimensat_path = find(Syscall::Utimensat as u32).args[0];
        assert_eq!(utimensat_path.size, SyscallArgSize::CString);
        assert!(utimensat_path.nullable);

        let pathconf = find(Syscall::Pathconf as u32).args;
        assert_eq!(pathconf[0].size, SyscallArgSize::CString);
        assert!(!pathconf[0].nullable);
        assert_eq!(pathconf[1].arg_index, 2);
        assert_eq!(pathconf[1].direction, SyscallArgDirection::Out);
        assert_eq!(pathconf[1].size, SyscallArgSize::Fixed { size: 8 });
        assert!(pathconf[1].required);

        let fpathconf = find(Syscall::Fpathconf as u32).args[0];
        assert_eq!(fpathconf.arg_index, 2);
        assert_eq!(fpathconf.direction, SyscallArgDirection::Out);
        assert_eq!(fpathconf.size, SyscallArgSize::Fixed { size: 8 });
        assert!(fpathconf.required);

        let getrusage = find(Syscall::Getrusage as u32).args[0];
        assert_eq!(
            getrusage.size,
            SyscallArgSize::Fixed {
                size: WASM_RUSAGE_WIRE_SIZE,
            }
        );
        assert!(getrusage.required);

        let wait4 = find(Syscall::Wait4 as u32).args;
        assert_eq!(
            wait4[1].size,
            SyscallArgSize::Fixed {
                size: WASM_RUSAGE_WIRE_SIZE,
            }
        );

        let waitid = find(extra_syscalls::SYS_WAITID).args;
        assert_eq!(waitid[0].arg_index, 2);
        assert_eq!(waitid[0].direction, SyscallArgDirection::Out);
        assert_eq!(waitid[0].size, SyscallArgSize::Fixed { size: 128 });
        assert!(waitid[0].required);
        assert_eq!(waitid[1].arg_index, 4);
        assert_eq!(waitid[1].direction, SyscallArgDirection::Out);
        assert_eq!(
            waitid[1].size,
            SyscallArgSize::Fixed {
                size: WASM_RUSAGE_WIRE_SIZE,
            }
        );
        assert!(waitid[1].nullable);

        let sched_getaffinity =
            find(extra_syscalls::SYS_SCHED_GETAFFINITY).args[0];
        assert_eq!(sched_getaffinity.arg_index, 2);
        assert_eq!(sched_getaffinity.direction, SyscallArgDirection::Out);
        assert_eq!(
            sched_getaffinity.size,
            SyscallArgSize::Fixed {
                size: SCHED_AFFINITY_MASK_SIZE,
            }
        );
        assert!(sched_getaffinity.required);

        let semop = find(extra_syscalls::SYS_SEMOP).args[0].size;
        assert_eq!(
            semop,
            SyscallArgSize::Arg {
                arg_index: 2,
                multiplier: 6,
                add: 0,
            }
        );
    }

    #[test]
    fn nested_pointer_syscalls_stay_out_of_simple_descriptors() {
        assert!(maybe_find(Syscall::Writev as u32).is_none());
        assert!(maybe_find(Syscall::Readv as u32).is_none());
    }

    #[test]
    fn ioctl_descriptor_and_oss_argument_sizes_are_pinned() {
        use crate::oss::*;

        let ioctl = find(Syscall::Ioctl as u32).args[0];
        assert_eq!(ioctl.arg_index, 2);
        assert_eq!(ioctl.direction, SyscallArgDirection::InOut);
        assert_eq!(
            ioctl.size,
            SyscallArgSize::Ioctl {
                request_arg_index: 1,
            }
        );
        assert!(ioctl.nullable, "no-argument ioctls accept a null arg");

        for request in [
            SNDCTL_DSP_RESET,
            SNDCTL_DSP_SYNC,
            SNDCTL_DSP_POST,
            SNDCTL_DSP_NONBLOCK,
        ] {
            assert_eq!(ioctl_arg_size(request), 0);
        }
        for request in [
            SNDCTL_DSP_SPEED,
            SNDCTL_DSP_STEREO,
            SNDCTL_DSP_GETBLKSIZE,
            SNDCTL_DSP_SETBLKSIZE,
            SNDCTL_DSP_SETFMT,
            SNDCTL_DSP_CHANNELS,
            SOUND_PCM_WRITE_FILTER,
            SNDCTL_DSP_SUBDIVIDE,
            SNDCTL_DSP_SETFRAGMENT,
            SNDCTL_DSP_GETFMTS,
            SNDCTL_DSP_GETCAPS,
            SNDCTL_DSP_GETODELAY,
            SOUND_PCM_READ_RATE,
            SOUND_PCM_READ_BITS,
            SOUND_PCM_READ_CHANNELS,
            SOUND_PCM_READ_FILTER,
        ] {
            assert_eq!(ioctl_arg_size(request), 4, "request {request:#x}");
        }
        assert_eq!(ioctl_arg_size(SNDCTL_DSP_GETOSPACE), 16);
        assert_eq!(ioctl_arg_size(SNDCTL_DSP_GETOPTR), 12);
        assert_eq!(ioctl_arg_size(0x540b), 0, "TCFLSH takes an immediate selector");
    }

    fn find(syscall_number: u32) -> &'static SyscallArgDescriptor {
        maybe_find(syscall_number).expect("missing syscall arg descriptor")
    }

    fn maybe_find(syscall_number: u32) -> Option<&'static SyscallArgDescriptor> {
        SYSCALL_ARG_DESCRIPTORS
            .iter()
            .find(|entry| entry.syscall_number == syscall_number)
    }
}
