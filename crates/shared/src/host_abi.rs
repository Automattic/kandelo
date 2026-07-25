//! Host adapter ABI metadata.
//!
//! These tables describe how the JavaScript host adapter copies pointer
//! arguments between process memory and the kernel scratch channel before
//! calling `kernel_handle_channel`. The host still owns the memory copies and
//! platform scheduling; Rust owns the ABI-sensitive syscall argument shapes.

use core::mem::size_of;

use crate::abi::extended_syscalls as extra_syscalls;
use crate::process_layout;
use crate::{SCHED_AFFINITY_MASK_SIZE, Syscall, WASM_RUSAGE_WIRE_SIZE, WasmTimespec};

/// Private channel argument used to carry the calling process's pointer width.
///
/// WHY: one kernel Wasm instance may serve wasm32 and wasm64 processes, so its
/// own compilation target cannot select a caller-native structure layout.
pub const PROCESS_POINTER_WIDTH_ARG_INDEX: u8 = 5;

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
    /// Fixed native structure size selected from the calling process's data
    /// model.  Encountering this form also makes the host write the process
    /// pointer width to [`PROCESS_POINTER_WIDTH_ARG_INDEX`].
    ProcessLayout {
        wasm32_size: u32,
        wasm64_size: u32,
    },
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

macro_rules! process_layout {
    ($wasm32_size:expr, $wasm64_size:expr) => {
        SyscallArgSize::ProcessLayout {
            wasm32_size: $wasm32_size,
            wasm64_size: $wasm64_size,
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
        }
    };
    ($arg_index:expr, $direction:ident, $size:expr, nullable) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            nullable: true,
            required: false,
        }
    };
    ($arg_index:expr, $direction:ident, $size:expr, required) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            nullable: false,
            required: true,
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

const WASM_TIMESPEC_SIZE: u32 = size_of::<WasmTimespec>() as u32;

const RLIMIT_SIZE: u32 = 16;

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
        [desc!(
            1,
            Out,
            fixed!(process_layout::stat::SIZE),
            required
        )]
    ),
    entry!(Syscall::Pipe as u32, [desc!(0, Out, fixed!(8))]),
    entry!(
        Syscall::Stat as u32,
        [
            desc!(0, In, cstring!()),
            desc!(
                1,
                Out,
                fixed!(process_layout::stat::SIZE),
                required
            ),
        ]
    ),
    entry!(
        Syscall::Lstat as u32,
        [
            desc!(0, In, cstring!()),
            desc!(
                1,
                Out,
                fixed!(process_layout::stat::SIZE),
                required
            ),
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
    entry!(
        Syscall::Tcgetattr as u32,
        [desc!(1, Out, fixed!(crate::ioctl_contract::TERMIOS_SIZE), required)]
    ),
    entry!(
        Syscall::Tcsetattr as u32,
        [desc!(2, In, fixed!(crate::ioctl_contract::TERMIOS_SIZE), required)]
    ),
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
            desc!(
                2,
                Out,
                fixed!(process_layout::stat::SIZE),
                required
            ),
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
            desc!(
                2,
                Out,
                process_layout!(
                    process_layout::statfs::WASM32_SIZE,
                    process_layout::statfs::WASM64_SIZE
                ),
                required
            ),
        ]
    ),
    entry!(
        Syscall::Fstatfs as u32,
        [desc!(
            2,
            Out,
            process_layout!(
                process_layout::statfs::WASM32_SIZE,
                process_layout::statfs::WASM64_SIZE
            ),
            required
        )]
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
    entry!(
        Syscall::Setgroups as u32,
        [desc!(1, In, arg!(0, mul 4), required)]
    ),
    entry!(
        Syscall::Wait4 as u32,
        [
            desc!(1, Out, fixed!(4)),
            desc!(3, Out, fixed!(WASM_RUSAGE_WIRE_SIZE)),
        ]
    ),
    entry!(
        Syscall::Getaddrinfo as u32,
        [
            desc!(0, In, cstring!()),
            // WHY: musl's lookup_name.c supplies exactly one four-byte IPv4
            // result. A larger copy-out contract overwrites caller-owned bytes
            // even though the kernel produces only this meaningful address.
            desc!(1, Out, fixed!(4)),
        ]
    ),
    entry!(
        extra_syscalls::SYS_RT_SIGQUEUEINFO,
        [desc!(
            2,
            In,
            process_layout!(
                process_layout::rt_sigqueueinfo::WASM32_SIZE,
                process_layout::rt_sigqueueinfo::WASM64_SIZE
            ),
            required
        )]
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
            desc!(
                0,
                In,
                process_layout!(
                    process_layout::sigaltstack::WASM32_SIZE,
                    process_layout::sigaltstack::WASM64_SIZE
                )
            ),
            desc!(
                1,
                Out,
                process_layout!(
                    process_layout::sigaltstack::WASM32_SIZE,
                    process_layout::sigaltstack::WASM64_SIZE
                )
            ),
        ]
    ),
    entry!(
        crate::abi::host_intercepted::SYS_EXECVE,
        [desc!(0, In, cstring!())]
    ),
    entry!(extra_syscalls::SYS_PRCTL, [desc!(1, InOut, fixed!(16))]),
    entry!(
        extra_syscalls::SYS_GETITIMER,
        [desc!(
            1,
            Out,
            process_layout!(
                process_layout::itimerval::WASM32_SIZE,
                process_layout::itimerval::WASM64_SIZE
            ),
            required
        )]
    ),
    entry!(
        extra_syscalls::SYS_SETITIMER,
        [
            desc!(
                1,
                In,
                process_layout!(
                    process_layout::itimerval::WASM32_SIZE,
                    process_layout::itimerval::WASM64_SIZE
                ),
                required
            ),
            desc!(
                2,
                Out,
                process_layout!(
                    process_layout::itimerval::WASM32_SIZE,
                    process_layout::itimerval::WASM64_SIZE
                )
            ),
        ]
    ),
    entry!(
        extra_syscalls::SYS_SCHED_GETPARAM,
        [desc!(
            1,
            Out,
            fixed!(process_layout::sched_param::SIZE),
            required
        )]
    ),
    entry!(
        extra_syscalls::SYS_SCHED_SETPARAM,
        [desc!(
            1,
            In,
            fixed!(process_layout::sched_param::SIZE),
            required
        )]
    ),
    entry!(
        extra_syscalls::SYS_SCHED_SETSCHEDULER,
        [desc!(
            2,
            In,
            fixed!(process_layout::sched_param::SIZE),
            required
        )]
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
        extra_syscalls::SYS_TIMERFD_SETTIME,
        [
            desc!(2, In, fixed!(32), required),
            desc!(3, Out, fixed!(32), nullable),
        ]
    ),
    entry!(
        extra_syscalls::SYS_TIMERFD_GETTIME,
        [desc!(1, Out, fixed!(32), required)]
    ),
    entry!(
        extra_syscalls::SYS_SIGNALFD4,
        [desc!(1, In, fixed!(8), required)]
    ),
    entry!(
        extra_syscalls::SYS_PRLIMIT64,
        [desc!(2, In, fixed!(16)), desc!(3, Out, fixed!(16)),]
    ),
    entry!(extra_syscalls::SYS_PPOLL, [desc!(0, InOut, arg!(1, mul 8))]),
    entry!(
        extra_syscalls::SYS_MEMFD_CREATE,
        [desc!(0, In, cstring!(), required)]
    ),
    entry!(
        extra_syscalls::SYS_STATX,
        [desc!(1, In, cstring!()), desc!(4, Out, fixed!(256)),]
    ),
    entry!(
        extra_syscalls::SYS_SYSINFO,
        [desc!(
            0,
            Out,
            process_layout!(
                process_layout::sysinfo::WASM32_SIZE,
                process_layout::sysinfo::WASM64_SIZE
            ),
            required
        )]
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
    entry!(
        extra_syscalls::SYS_COPY_FILE_RANGE,
        [
            desc!(1, InOut, fixed!(8), nullable),
            desc!(3, InOut, fixed!(8), nullable),
        ]
    ),
    entry!(
        extra_syscalls::SYS_SPLICE,
        [
            desc!(1, InOut, fixed!(8), nullable),
            desc!(3, InOut, fixed!(8), nullable),
        ]
    ),
    entry!(
        extra_syscalls::SYS_SENDFILE,
        [desc!(2, InOut, fixed!(8), nullable)]
    ),
    entry!(extra_syscalls::SYS_LCHOWN, [desc!(0, In, cstring!())]),
    entry!(
        extra_syscalls::SYS_RENAMEAT2,
        [desc!(1, In, cstring!()), desc!(3, In, cstring!()),]
    ),
    entry!(
        extra_syscalls::SYS_GETCPU,
        [
            desc!(0, Out, fixed!(4), nullable),
            desc!(1, Out, fixed!(4), nullable),
        ]
    ),
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
        [
            desc!(0, In, cstring!()),
            desc!(
                3,
                In,
                process_layout!(
                    process_layout::mq_attr::WASM32_SIZE,
                    process_layout::mq_attr::WASM64_SIZE
                )
            ),
        ]
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
    entry!(
        extra_syscalls::SYS_MQ_NOTIFY,
        [desc!(
            1,
            In,
            process_layout!(
                process_layout::sigevent::WASM32_SIZE,
                process_layout::sigevent::WASM64_SIZE
            )
        )]
    ),
    entry!(
        extra_syscalls::SYS_MQ_GETSETATTR,
        [
            desc!(
                1,
                In,
                process_layout!(
                    process_layout::mq_attr::WASM32_SIZE,
                    process_layout::mq_attr::WASM64_SIZE
                )
            ),
            desc!(
                2,
                Out,
                process_layout!(
                    process_layout::mq_attr::WASM32_SIZE,
                    process_layout::mq_attr::WASM64_SIZE
                )
            ),
        ]
    ),
    entry!(extra_syscalls::SYS_SEMOP, [desc!(1, In, arg!(2, mul 6))]),
    entry!(
        extra_syscalls::SYS_SIGNALFD,
        [desc!(1, In, fixed!(8), required)]
    ),
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

        assert!(
            SYSCALL_ARG_DESCRIPTORS
                .iter()
                .all(|entry| entry.syscall_number != extra_syscalls::SYS_MSGRCV
                    && entry.syscall_number != extra_syscalls::SYS_MSGSND),
            "native-long SysV messages must use the width-aware host handler"
        );

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

        let getaddrinfo = find(Syscall::Getaddrinfo as u32).args;
        assert_eq!(getaddrinfo[1].arg_index, 1);
        assert_eq!(getaddrinfo[1].direction, SyscallArgDirection::Out);
        assert_eq!(
            getaddrinfo[1].size,
            SyscallArgSize::Fixed { size: 4 },
            "musl gives SYS_getaddrinfo exactly one four-byte IPv4 result"
        );

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

        let timerfd_settime =
            find(extra_syscalls::SYS_TIMERFD_SETTIME).args;
        assert_eq!(timerfd_settime[0].arg_index, 2);
        assert_eq!(timerfd_settime[0].direction, SyscallArgDirection::In);
        assert_eq!(
            timerfd_settime[0].size,
            SyscallArgSize::Fixed { size: 32 }
        );
        assert!(timerfd_settime[0].required);
        assert_eq!(timerfd_settime[1].arg_index, 3);
        assert_eq!(timerfd_settime[1].direction, SyscallArgDirection::Out);
        assert_eq!(
            timerfd_settime[1].size,
            SyscallArgSize::Fixed { size: 32 }
        );
        assert!(timerfd_settime[1].nullable);

        let timerfd_gettime =
            find(extra_syscalls::SYS_TIMERFD_GETTIME).args[0];
        assert_eq!(timerfd_gettime.arg_index, 1);
        assert_eq!(timerfd_gettime.direction, SyscallArgDirection::Out);
        assert_eq!(
            timerfd_gettime.size,
            SyscallArgSize::Fixed { size: 32 }
        );
        assert!(timerfd_gettime.required);

        for syscall in [
            extra_syscalls::SYS_SIGNALFD4,
            extra_syscalls::SYS_SIGNALFD,
        ] {
            let mask = find(syscall).args[0];
            assert_eq!(mask.arg_index, 1);
            assert_eq!(mask.direction, SyscallArgDirection::In);
            assert_eq!(mask.size, SyscallArgSize::Fixed { size: 8 });
            assert!(mask.required);
        }

        let memfd_name = find(extra_syscalls::SYS_MEMFD_CREATE).args[0];
        assert_eq!(memfd_name.arg_index, 0);
        assert_eq!(memfd_name.direction, SyscallArgDirection::In);
        assert_eq!(memfd_name.size, SyscallArgSize::CString);
        assert!(memfd_name.required);

        for syscall in [
            extra_syscalls::SYS_COPY_FILE_RANGE,
            extra_syscalls::SYS_SPLICE,
        ] {
            let offsets = find(syscall).args;
            assert_eq!(offsets.len(), 2);
            for (offset, arg_index) in offsets.iter().zip([1, 3]) {
                assert_eq!(offset.arg_index, arg_index);
                assert_eq!(offset.direction, SyscallArgDirection::InOut);
                assert_eq!(offset.size, SyscallArgSize::Fixed { size: 8 });
                assert!(offset.nullable);
            }
        }

        let sendfile_offset = find(extra_syscalls::SYS_SENDFILE).args[0];
        assert_eq!(sendfile_offset.arg_index, 2);
        assert_eq!(
            sendfile_offset.direction,
            SyscallArgDirection::InOut
        );
        assert_eq!(
            sendfile_offset.size,
            SyscallArgSize::Fixed { size: 8 }
        );
        assert!(sendfile_offset.nullable);

        let renameat2 = find(extra_syscalls::SYS_RENAMEAT2).args;
        assert_eq!(renameat2.len(), 2);
        for (path, arg_index) in renameat2.iter().zip([1, 3]) {
            assert_eq!(path.arg_index, arg_index);
            assert_eq!(path.direction, SyscallArgDirection::In);
            assert_eq!(path.size, SyscallArgSize::CString);
            assert!(!path.nullable);
        }

        let getcpu = find(extra_syscalls::SYS_GETCPU).args;
        assert_eq!(getcpu.len(), 2);
        for (output, arg_index) in getcpu.iter().zip([0, 1]) {
            assert_eq!(output.arg_index, arg_index);
            assert_eq!(output.direction, SyscallArgDirection::Out);
            assert_eq!(output.size, SyscallArgSize::Fixed { size: 4 });
            assert!(output.nullable);
        }

        let setgroups = find(Syscall::Setgroups as u32).args[0];
        assert_eq!(setgroups.arg_index, 1);
        assert_eq!(setgroups.direction, SyscallArgDirection::In);
        assert_eq!(
            setgroups.size,
            SyscallArgSize::Arg {
                arg_index: 0,
                multiplier: 4,
                add: 0,
            }
        );
        assert!(setgroups.required);

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
    fn process_native_layouts_carry_both_widths_and_width_slot() {
        assert_eq!(PROCESS_POINTER_WIDTH_ARG_INDEX, 5);

        fn assert_layout(
            syscall: u32,
            arg_index: u8,
            direction: SyscallArgDirection,
            wasm32_size: u32,
            wasm64_size: u32,
        ) {
            let arg = find(syscall)
                .args
                .iter()
                .find(|arg| arg.arg_index == arg_index)
                .expect("missing process-layout argument");
            assert_eq!(arg.direction, direction);
            assert_eq!(
                arg.size,
                SyscallArgSize::ProcessLayout {
                    wasm32_size,
                    wasm64_size,
                }
            );
        }

        assert_layout(
            Syscall::Statfs as u32,
            2,
            SyscallArgDirection::Out,
            process_layout::statfs::WASM32_SIZE,
            process_layout::statfs::WASM64_SIZE,
        );
        assert_layout(
            Syscall::Fstatfs as u32,
            2,
            SyscallArgDirection::Out,
            process_layout::statfs::WASM32_SIZE,
            process_layout::statfs::WASM64_SIZE,
        );
        for (arg_index, direction) in [
            (0, SyscallArgDirection::In),
            (1, SyscallArgDirection::Out),
        ] {
            assert_layout(
                extra_syscalls::SYS_SIGALTSTACK,
                arg_index,
                direction,
                process_layout::sigaltstack::WASM32_SIZE,
                process_layout::sigaltstack::WASM64_SIZE,
            );
        }
        assert_layout(
            extra_syscalls::SYS_GETITIMER,
            1,
            SyscallArgDirection::Out,
            process_layout::itimerval::WASM32_SIZE,
            process_layout::itimerval::WASM64_SIZE,
        );
        for (arg_index, direction) in [
            (1, SyscallArgDirection::In),
            (2, SyscallArgDirection::Out),
        ] {
            assert_layout(
                extra_syscalls::SYS_SETITIMER,
                arg_index,
                direction,
                process_layout::itimerval::WASM32_SIZE,
                process_layout::itimerval::WASM64_SIZE,
            );
        }
        for (syscall, arg_index) in [
            (Syscall::Statfs as u32, 2),
            (Syscall::Fstatfs as u32, 2),
            (extra_syscalls::SYS_GETITIMER, 1),
            (extra_syscalls::SYS_SETITIMER, 1),
        ] {
            assert!(
                find(syscall)
                    .args
                    .iter()
                    .find(|arg| arg.arg_index == arg_index)
                    .expect("missing required process-layout argument")
                    .required
            );
        }
        assert_layout(
            extra_syscalls::SYS_SYSINFO,
            0,
            SyscallArgDirection::Out,
            process_layout::sysinfo::WASM32_SIZE,
            process_layout::sysinfo::WASM64_SIZE,
        );
        assert_layout(
            extra_syscalls::SYS_MQ_OPEN,
            3,
            SyscallArgDirection::In,
            process_layout::mq_attr::WASM32_SIZE,
            process_layout::mq_attr::WASM64_SIZE,
        );
        assert_layout(
            extra_syscalls::SYS_MQ_NOTIFY,
            1,
            SyscallArgDirection::In,
            process_layout::sigevent::WASM32_SIZE,
            process_layout::sigevent::WASM64_SIZE,
        );
        for (arg_index, direction) in [
            (1, SyscallArgDirection::In),
            (2, SyscallArgDirection::Out),
        ] {
            assert_layout(
                extra_syscalls::SYS_MQ_GETSETATTR,
                arg_index,
                direction,
                process_layout::mq_attr::WASM32_SIZE,
                process_layout::mq_attr::WASM64_SIZE,
            );
        }
    }

    #[test]
    fn fixed_native_records_use_complete_required_buffers() {
        for (syscall, arg_index) in [
            (Syscall::Fstat as u32, 1),
            (Syscall::Stat as u32, 1),
            (Syscall::Lstat as u32, 1),
            (Syscall::Fstatat as u32, 2),
        ] {
            let stat = find(syscall)
                .args
                .iter()
                .find(|arg| arg.arg_index == arg_index)
                .expect("missing stat output");
            assert_eq!(stat.direction, SyscallArgDirection::Out);
            assert_eq!(
                stat.size,
                SyscallArgSize::Fixed {
                    size: process_layout::stat::SIZE,
                }
            );
            assert!(stat.required);
        }

        let queued = find(extra_syscalls::SYS_RT_SIGQUEUEINFO).args[0];
        assert_eq!(queued.arg_index, 2);
        assert_eq!(queued.direction, SyscallArgDirection::In);
        assert_eq!(
            queued.size,
            SyscallArgSize::ProcessLayout {
                wasm32_size: process_layout::rt_sigqueueinfo::WASM32_SIZE,
                wasm64_size: process_layout::rt_sigqueueinfo::WASM64_SIZE,
            }
        );
        assert!(queued.required);

        for (syscall, arg_index, direction) in [
            (
                extra_syscalls::SYS_SCHED_GETPARAM,
                1,
                SyscallArgDirection::Out,
            ),
            (
                extra_syscalls::SYS_SCHED_SETPARAM,
                1,
                SyscallArgDirection::In,
            ),
            (
                extra_syscalls::SYS_SCHED_SETSCHEDULER,
                2,
                SyscallArgDirection::In,
            ),
        ] {
            let param = find(syscall).args[0];
            assert_eq!(param.arg_index, arg_index);
            assert_eq!(param.direction, direction);
            assert_eq!(
                param.size,
                SyscallArgSize::Fixed {
                    size: process_layout::sched_param::SIZE,
                }
            );
            assert!(param.required);
        }
    }

    #[test]
    fn nested_pointer_syscalls_stay_out_of_simple_descriptors() {
        for syscall in [
            Syscall::Writev as u32,
            Syscall::Readv as u32,
            extra_syscalls::SYS_PREADV,
            extra_syscalls::SYS_PWRITEV,
            extra_syscalls::SYS_PREADV2,
            extra_syscalls::SYS_PWRITEV2,
            Syscall::Sendmsg as u32,
            Syscall::Recvmsg as u32,
            Syscall::Getgroups as u32,
            extra_syscalls::SYS_MSGRCV,
            extra_syscalls::SYS_MSGSND,
        ] {
            assert!(
                maybe_find(syscall).is_none(),
                "nested iovec syscall {syscall} needs its reviewed host handler"
            );
        }
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
