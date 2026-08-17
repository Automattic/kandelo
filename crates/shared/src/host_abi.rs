//! Host adapter ABI metadata.
//!
//! These tables describe how the JavaScript host adapter copies pointer
//! arguments between process memory and the kernel scratch channel before
//! calling `kernel_handle_channel`. The host still owns the memory copies and
//! platform scheduling; Rust owns the ABI-sensitive syscall argument shapes.

use core::mem::{offset_of, size_of};

use crate::abi::extended_syscalls as extra_syscalls;
use crate::process_layout;
use crate::{
    kernel_scratch_wire, platform_limits, Syscall, WasmTimespec, SCHED_AFFINITY_MASK_SIZE,
    WASM_RUSAGE_WIRE_SIZE,
};

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
    /// A nul-terminated string in process memory with an explicit complete
    /// scan/copy ceiling, including the NUL.
    CString { max_bytes: u32, too_long_errno: u32 },
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
    ProcessLayout { wasm32_size: u32, wasm64_size: u32 },
}

/// An exceptional source for the number of output bytes copied back to the
/// caller.
///
/// Most `Out` arguments either publish their declared fixed capacity, the
/// syscall return value for `Arg`-sized byte buffers, or a dereferenced length.
/// Protocols whose return value has a different unit must declare the actual
/// byte count explicitly rather than relying on the host's default convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyscallArgCopyOutLength {
    /// Read a little-endian `u32` field from another staged argument.
    U32Field { arg_index: u8, offset: u32 },
    /// Bound a successful syscall return value, then multiply it by a fixed
    /// byte width.
    ///
    /// This covers results such as `getgroups`, whose return value counts
    /// native entries instead of bytes.
    ReturnValue {
        multiplier: u32,
        max_value: u32,
    },
}

/// One pointer argument descriptor for host-side marshalling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyscallArgDesc {
    pub arg_index: u8,
    pub direction: SyscallArgDirection,
    pub size: SyscallArgSize,
    /// Whether a null pointer is a valid request to omit this argument.
    ///
    /// Exactly one of `nullable` and `required` must be true. A zero-length
    /// [`SyscallArgSize::Arg`] still lends no caller bytes and is canonicalized
    /// to an empty kernel-owned region regardless of its raw pointer bits.
    pub nullable: bool,
    /// Whether a positive-sized pointer must be non-null.
    pub required: bool,
    /// Overrides the ordinary copy-back length convention when the syscall
    /// return value is not a byte count.
    pub copy_out_length: Option<SyscallArgCopyOutLength>,
}

impl SyscallArgDesc {
    const fn with_copy_out_u32_field(mut self, arg_index: u8, offset: u32) -> Self {
        self.copy_out_length = Some(SyscallArgCopyOutLength::U32Field {
            arg_index,
            offset,
        });
        self
    }

    const fn with_copy_out_return_value(mut self, multiplier: u32, max_value: u32) -> Self {
        self.copy_out_length = Some(SyscallArgCopyOutLength::ReturnValue {
            multiplier,
            max_value,
        });
        self
    }
}

/// All pointer argument descriptors for one syscall number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyscallArgDescriptor {
    pub syscall_number: u32,
    pub args: &'static [SyscallArgDesc],
}

macro_rules! cstring {
    () => {
        SyscallArgSize::CString {
            max_bytes: platform_limits::PATH_MAX_BYTES as u32,
            too_long_errno: crate::Errno::ENAMETOOLONG as u32,
        }
    };
    ($max_bytes:expr) => {
        SyscallArgSize::CString {
            max_bytes: $max_bytes as u32,
            too_long_errno: crate::Errno::ENAMETOOLONG as u32,
        }
    };
    ($max_bytes:expr, $errno:ident) => {
        SyscallArgSize::CString {
            max_bytes: $max_bytes as u32,
            too_long_errno: crate::Errno::$errno as u32,
        }
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
    ($arg_index:expr, $direction:ident, $size:expr, nullable) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            nullable: true,
            required: false,
            copy_out_length: None,
        }
    };
    ($arg_index:expr, $direction:ident, $size:expr, required) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            nullable: false,
            required: true,
            copy_out_length: None,
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
    entry!(Syscall::Open as u32, [desc!(0, In, cstring!(), required)]),
    entry!(Syscall::Read as u32, [desc!(1, Out, arg!(2), required)]),
    entry!(Syscall::Write as u32, [desc!(1, In, arg!(2), required)]),
    entry!(
        Syscall::Fstat as u32,
        [desc!(1, Out, fixed!(process_layout::stat::SIZE), required)]
    ),
    entry!(Syscall::Pipe as u32, [desc!(0, Out, fixed!(8), required)]),
    entry!(
        Syscall::Stat as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(1, Out, fixed!(process_layout::stat::SIZE), required),
        ]
    ),
    entry!(
        Syscall::Lstat as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(1, Out, fixed!(process_layout::stat::SIZE), required),
        ]
    ),
    entry!(Syscall::Mkdir as u32, [desc!(0, In, cstring!(), required)]),
    entry!(Syscall::Rmdir as u32, [desc!(0, In, cstring!(), required)]),
    entry!(Syscall::Unlink as u32, [desc!(0, In, cstring!(), required)]),
    entry!(
        Syscall::Rename as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(1, In, cstring!(), required),
        ]
    ),
    entry!(
        Syscall::Link as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(1, In, cstring!(), required),
        ]
    ),
    entry!(
        Syscall::Symlink as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(1, In, cstring!(), required),
        ]
    ),
    entry!(
        Syscall::Readlink as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(1, Out, arg!(2), required),
        ]
    ),
    entry!(Syscall::Chmod as u32, [desc!(0, In, cstring!(), required)]),
    entry!(Syscall::Chown as u32, [desc!(0, In, cstring!(), required)]),
    entry!(Syscall::Access as u32, [desc!(0, In, cstring!(), required)]),
    entry!(Syscall::Getcwd as u32, [desc!(0, Out, arg!(1), required)]),
    entry!(Syscall::Chdir as u32, [desc!(0, In, cstring!(), required)]),
    entry!(
        Syscall::Opendir as u32,
        [desc!(0, In, cstring!(), required)]
    ),
    entry!(
        Syscall::Readdir as u32,
        [
            desc!(1, Out, fixed!(16), required),
            desc!(2, Out, arg!(3), required).with_copy_out_u32_field(
                1,
                offset_of!(crate::WasmDirent, d_namlen) as u32,
            ),
        ]
    ),
    entry!(
        Syscall::Sigaction as u32,
        [
            desc!(1, In, fixed!(16), nullable),
            desc!(2, Out, fixed!(16), nullable),
        ]
    ),
    entry!(
        Syscall::Sigprocmask as u32,
        [
            desc!(
                1,
                In,
                fixed!(kernel_scratch_wire::SIGNAL_MASK_BYTES),
                nullable
            ),
            desc!(
                2,
                Out,
                fixed!(kernel_scratch_wire::SIGNAL_MASK_BYTES),
                nullable
            ),
        ]
    ),
    entry!(
        Syscall::ClockGettime as u32,
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE), required)]
    ),
    entry!(
        Syscall::Nanosleep as u32,
        [desc!(0, In, fixed!(WASM_TIMESPEC_SIZE), required)]
    ),
    entry!(
        Syscall::GetEnv as u32,
        [
            desc!(
                0,
                In,
                cstring!(platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES + 1, E2BIG),
                required
            ),
            desc!(1, Out, arg!(2), required),
        ]
    ),
    entry!(
        Syscall::SetEnv as u32,
        [
            desc!(
                0,
                In,
                cstring!(platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES + 1, E2BIG),
                required
            ),
            desc!(
                1,
                In,
                cstring!(platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES + 1, E2BIG),
                required
            ),
        ]
    ),
    entry!(
        Syscall::UnsetEnv as u32,
        [desc!(
            0,
            In,
            cstring!(platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES + 1, E2BIG),
            required
        )]
    ),
    entry!(Syscall::Bind as u32, [desc!(1, In, arg!(2), required)]),
    entry!(
        Syscall::Accept as u32,
        [
            // When the address is null, POSIX makes the length pointer
            // ignored. The host canonicalizes that absent pair to two nulls;
            // a non-null address still requires the length pointer because it
            // defines the staged output capacity.
            desc!(1, Out, deref!(2), nullable),
            desc!(2, InOut, fixed!(4), nullable),
        ]
    ),
    entry!(Syscall::Connect as u32, [desc!(1, In, arg!(2), required)]),
    entry!(Syscall::Send as u32, [desc!(1, In, arg!(2), required)]),
    entry!(Syscall::Recv as u32, [desc!(1, Out, arg!(2), required)]),
    entry!(
        Syscall::Getsockopt as u32,
        [
            desc!(3, Out, deref!(4), required),
            desc!(4, InOut, fixed!(4), required),
        ]
    ),
    entry!(
        Syscall::Setsockopt as u32,
        [desc!(3, In, arg!(4), required)]
    ),
    entry!(
        Syscall::Poll as u32,
        [desc!(0, InOut, arg!(1, mul 8), required)]
    ),
    entry!(
        Syscall::Socketpair as u32,
        [desc!(3, Out, fixed!(8), required)]
    ),
    entry!(
        Syscall::Sendto as u32,
        [
            desc!(1, In, arg!(2), required),
            desc!(4, In, arg!(5), required),
        ]
    ),
    entry!(
        Syscall::Recvfrom as u32,
        [
            desc!(1, Out, arg!(2), required),
            // As with accept(2), a null source-address pointer makes the
            // caller's length pointer ignored; a supplied address requires
            // its length.
            desc!(4, Out, deref!(5), nullable),
            desc!(5, InOut, fixed!(4), nullable),
        ]
    ),
    entry!(Syscall::Pread as u32, [desc!(1, Out, arg!(2), required)]),
    entry!(Syscall::Pwrite as u32, [desc!(1, In, arg!(2), required)]),
    entry!(Syscall::Openat as u32, [desc!(1, In, cstring!(), required)]),
    entry!(
        Syscall::Tcgetattr as u32,
        [desc!(
            1,
            Out,
            fixed!(crate::ioctl_contract::TERMIOS_SIZE),
            required
        )]
    ),
    entry!(
        Syscall::Tcsetattr as u32,
        [desc!(
            2,
            In,
            fixed!(crate::ioctl_contract::TERMIOS_SIZE),
            required
        )]
    ),
    entry!(
        Syscall::Uname as u32,
        [desc!(0, Out, fixed!(390), required)]
    ),
    entry!(Syscall::Pipe2 as u32, [desc!(0, Out, fixed!(8), required)]),
    entry!(
        Syscall::Getrlimit as u32,
        [desc!(1, Out, fixed!(RLIMIT_SIZE), required)]
    ),
    entry!(
        Syscall::Setrlimit as u32,
        [desc!(1, In, fixed!(RLIMIT_SIZE), required)]
    ),
    entry!(
        Syscall::Truncate as u32,
        [desc!(0, In, cstring!(), required)]
    ),
    entry!(
        Syscall::Fstatat as u32,
        [
            desc!(1, In, cstring!(), required),
            desc!(2, Out, fixed!(process_layout::stat::SIZE), required),
        ]
    ),
    entry!(
        Syscall::Unlinkat as u32,
        [desc!(1, In, cstring!(), required)]
    ),
    entry!(
        Syscall::Mkdirat as u32,
        [desc!(1, In, cstring!(), required)]
    ),
    entry!(
        Syscall::Renameat as u32,
        [
            desc!(1, In, cstring!(), required),
            desc!(3, In, cstring!(), required),
        ]
    ),
    entry!(
        Syscall::Faccessat as u32,
        [desc!(1, In, cstring!(), required)]
    ),
    entry!(
        Syscall::Fchmodat as u32,
        [desc!(1, In, cstring!(), required)]
    ),
    entry!(
        Syscall::Fchownat as u32,
        [desc!(1, In, cstring!(), required)]
    ),
    entry!(
        Syscall::Linkat as u32,
        [
            desc!(1, In, cstring!(), required),
            desc!(3, In, cstring!(), required),
        ]
    ),
    entry!(
        Syscall::Symlinkat as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(2, In, cstring!(), required),
        ]
    ),
    entry!(
        Syscall::Readlinkat as u32,
        [
            desc!(1, In, cstring!(), required),
            desc!(2, Out, arg!(3), required),
        ]
    ),
    entry!(
        Syscall::Getrusage as u32,
        [desc!(1, Out, fixed!(WASM_RUSAGE_WIRE_SIZE), required)]
    ),
    entry!(
        Syscall::Realpath as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(1, Out, arg!(2), required),
        ]
    ),
    entry!(
        Syscall::Sigsuspend as u32,
        [desc!(
            0,
            In,
            fixed!(kernel_scratch_wire::SIGNAL_MASK_BYTES),
            required
        )]
    ),
    entry!(
        Syscall::Pathconf as u32,
        [
            desc!(0, In, cstring!(), required),
            desc!(2, Out, fixed!(8), required),
        ]
    ),
    entry!(
        Syscall::Fpathconf as u32,
        [desc!(2, Out, fixed!(8), required)]
    ),
    entry!(
        Syscall::Getsockname as u32,
        [
            desc!(1, Out, deref!(2), required),
            desc!(2, InOut, fixed!(4), required),
        ]
    ),
    entry!(
        Syscall::Getpeername as u32,
        [
            desc!(1, Out, deref!(2), required),
            desc!(2, InOut, fixed!(4), required),
        ]
    ),
    entry!(
        extra_syscalls::SYS_LLSEEK,
        [desc!(3, Out, fixed!(8), required)]
    ),
    entry!(
        extra_syscalls::SYS_GETRANDOM,
        [desc!(0, Out, arg!(1), required)]
    ),
    entry!(
        Syscall::Getdents64 as u32,
        [desc!(1, Out, arg!(2), required)]
    ),
    entry!(
        Syscall::ClockGetres as u32,
        // POSIX and Linux permit querying clock validity without storing its
        // resolution.
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE), nullable)]
    ),
    entry!(
        Syscall::ClockNanosleep as u32,
        [desc!(2, In, fixed!(WASM_TIMESPEC_SIZE), required)]
    ),
    entry!(
        Syscall::Utimensat as u32,
        [
            desc!(1, In, cstring!(), nullable),
            // A null times pointer requests setting both timestamps to now.
            desc!(2, In, fixed!(WASM_TIMESPEC_SIZE * 2), nullable),
        ]
    ),
    entry!(
        Syscall::Statfs as u32,
        [
            desc!(0, In, cstring!(), required),
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
            // Linux writes each result with put_user; unlike getcpu(2), none
            // of these three destinations is optional.
            desc!(0, Out, fixed!(4), required),
            desc!(1, Out, fixed!(4), required),
            desc!(2, Out, fixed!(4), required),
        ]
    ),
    entry!(
        Syscall::Getresgid as u32,
        [
            desc!(0, Out, fixed!(4), required),
            desc!(1, Out, fixed!(4), required),
            desc!(2, Out, fixed!(4), required),
        ]
    ),
    entry!(
        Syscall::Getgroups as u32,
        [desc!(1, Out, arg!(0, mul 4), required)
            .with_copy_out_return_value(4, platform_limits::NGROUPS_MAX as u32)]
    ),
    entry!(
        Syscall::Setgroups as u32,
        [desc!(1, In, arg!(0, mul 4), required)]
    ),
    entry!(
        Syscall::Wait4 as u32,
        [
            desc!(1, Out, fixed!(4), nullable),
            desc!(3, Out, fixed!(WASM_RUSAGE_WIRE_SIZE), nullable),
        ]
    ),
    entry!(
        Syscall::Getaddrinfo as u32,
        [
            desc!(
                0,
                In,
                cstring!(platform_limits::HOST_NAME_MAX_BYTES),
                required
            ),
            // WHY: musl's lookup_name.c supplies exactly one four-byte IPv4
            // result. A larger copy-out contract overwrites caller-owned bytes
            // even though the kernel produces only this meaningful address.
            desc!(1, Out, fixed!(4), required),
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
        [desc!(
            0,
            Out,
            fixed!(kernel_scratch_wire::SIGNAL_MASK_BYTES),
            required
        )]
    ),
    entry!(
        extra_syscalls::SYS_RT_SIGTIMEDWAIT,
        [
            desc!(
                0,
                In,
                fixed!(kernel_scratch_wire::SIGNAL_MASK_BYTES),
                required
            ),
            desc!(
                1,
                Out,
                process_layout!(
                    process_layout::rt_sigqueueinfo::WASM32_SIZE,
                    process_layout::rt_sigqueueinfo::WASM64_SIZE
                ),
                nullable
            ),
            desc!(2, In, fixed!(WASM_TIMESPEC_SIZE), nullable),
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
                ),
                nullable
            ),
            desc!(
                1,
                Out,
                process_layout!(
                    process_layout::sigaltstack::WASM32_SIZE,
                    process_layout::sigaltstack::WASM64_SIZE
                ),
                nullable
            ),
        ]
    ),
    entry!(
        crate::abi::host_intercepted::SYS_EXECVE,
        [desc!(0, In, cstring!(), required)]
    ),
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
                ),
                nullable
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
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE), required)]
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
        [desc!(
            1,
            In,
            fixed!(kernel_scratch_wire::SIGNAL_MASK_BYTES),
            required
        )]
    ),
    entry!(
        extra_syscalls::SYS_PRLIMIT64,
        [
            // prlimit64 is a query, a mutation, or both; each record is
            // independently optional.
            desc!(2, In, fixed!(16), nullable),
            desc!(3, Out, fixed!(16), nullable),
        ]
    ),
    entry!(
        extra_syscalls::SYS_PPOLL,
        [desc!(0, InOut, arg!(1, mul 8), required)]
    ),
    entry!(
        extra_syscalls::SYS_MEMFD_CREATE,
        [desc!(
            0,
            In,
            cstring!(platform_limits::MEMFD_NAME_MAX_BYTES, EINVAL),
            required
        )]
    ),
    entry!(
        extra_syscalls::SYS_STATX,
        [
            desc!(1, In, cstring!(), required),
            desc!(4, Out, fixed!(256), required),
        ]
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
    entry!(
        extra_syscalls::SYS_MKNOD,
        [desc!(0, In, cstring!(), required)]
    ),
    entry!(
        extra_syscalls::SYS_MKNODAT,
        [desc!(1, In, cstring!(), required)]
    ),
    entry!(
        extra_syscalls::SYS_WAITID,
        [
            desc!(
                2,
                Out,
                process_layout!(
                    process_layout::rt_sigqueueinfo::WASM32_SIZE,
                    process_layout::rt_sigqueueinfo::WASM64_SIZE
                ),
                required
            ),
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
    entry!(
        extra_syscalls::SYS_LCHOWN,
        [desc!(0, In, cstring!(), required)]
    ),
    entry!(
        extra_syscalls::SYS_RENAMEAT2,
        [
            desc!(1, In, cstring!(), required),
            desc!(3, In, cstring!(), required),
        ]
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
        [
            // A null sigevent requests the standard SIGALRM notification.
            desc!(
                1,
                In,
                process_layout!(
                    process_layout::sigevent::WASM32_SIZE,
                    process_layout::sigevent::WASM64_SIZE
                ),
                nullable
            ),
            desc!(2, Out, fixed!(4), required),
        ]
    ),
    entry!(
        extra_syscalls::SYS_TIMER_SETTIME,
        [
            desc!(2, In, fixed!(32), required),
            desc!(3, Out, fixed!(32), nullable),
        ]
    ),
    entry!(
        extra_syscalls::SYS_TIMER_GETTIME,
        [desc!(1, Out, fixed!(32), required)]
    ),
    entry!(
        extra_syscalls::SYS_MQ_OPEN,
        [
            desc!(0, In, cstring!(platform_limits::NAME_MAX_BYTES), required),
            desc!(
                3,
                In,
                process_layout!(
                    process_layout::mq_attr::WASM32_SIZE,
                    process_layout::mq_attr::WASM64_SIZE
                ),
                nullable
            ),
        ]
    ),
    entry!(
        extra_syscalls::SYS_MQ_UNLINK,
        [desc!(
            0,
            In,
            cstring!(platform_limits::NAME_MAX_BYTES),
            required
        )]
    ),
    entry!(
        extra_syscalls::SYS_MQ_TIMEDSEND,
        [
            desc!(1, In, arg!(2), required),
            // mq_send(3) reaches this syscall with a null timeout.
            desc!(4, In, fixed!(WASM_TIMESPEC_SIZE), nullable),
        ]
    ),
    entry!(
        extra_syscalls::SYS_MQ_TIMEDRECEIVE,
        [
            desc!(1, Out, arg!(2), required),
            desc!(3, Out, fixed!(4), nullable),
            // mq_receive(3) reaches this syscall with a null timeout.
            desc!(4, In, fixed!(WASM_TIMESPEC_SIZE), nullable),
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
            ),
            nullable
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
                ),
                nullable
            ),
            desc!(
                2,
                Out,
                process_layout!(
                    process_layout::mq_attr::WASM32_SIZE,
                    process_layout::mq_attr::WASM64_SIZE
                ),
                nullable
            ),
        ]
    ),
    entry!(
        extra_syscalls::SYS_SEMOP,
        [desc!(1, In, arg!(2, mul 6), required)]
    ),
    entry!(
        extra_syscalls::SYS_SIGNALFD,
        [desc!(
            1,
            In,
            fixed!(kernel_scratch_wire::SIGNAL_MASK_BYTES),
            required
        )]
    ),
    entry!(
        extra_syscalls::SYS_FACCESSAT2,
        [desc!(1, In, cstring!(), required)]
    ),
    entry!(
        extra_syscalls::SYS_FCHMODAT2,
        [desc!(1, In, cstring!(), required)]
    ),
    entry!(
        extra_syscalls::SYS_ACCEPT4,
        [
            desc!(1, Out, deref!(2), nullable),
            desc!(2, InOut, fixed!(4), nullable),
        ]
    ),
];

#[cfg(test)]
mod tests {
    extern crate std;

    use self::std::vec::Vec;
    use super::*;
    use crate::channel_scalar::{self, ChannelScalarKind};

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
    fn variable_extent_descriptors_have_an_explicit_scalar_domain() {
        for descriptor in SYSCALL_ARG_DESCRIPTORS {
            for pointer in descriptor.args {
                let SyscallArgSize::Arg { arg_index, .. } = pointer.size else {
                    continue;
                };
                let kind =
                    channel_scalar::argument_kind(descriptor.syscall_number, arg_index.into());
                assert!(
                    matches!(
                        kind,
                        ChannelScalarKind::ProcessSize | ChannelScalarKind::U32
                    ),
                    "syscall {} arg {} sizes pointer arg {} but has scalar domain {:?}",
                    descriptor.syscall_number,
                    arg_index,
                    pointer.arg_index,
                    kind,
                );
            }
        }

        for (syscall, index) in [
            (Syscall::Bind as u32, 2),
            (Syscall::Connect as u32, 2),
            (Syscall::Setsockopt as u32, 4),
            (Syscall::Sendto as u32, 5),
        ] {
            assert_eq!(
                channel_scalar::argument_kind(syscall, index),
                ChannelScalarKind::U32,
                "socklen_t extent must stay an unsigned 32-bit scalar"
            );
        }
    }

    #[test]
    fn cstring_bounds_include_the_terminator_without_lowering_content_limits() {
        let metadata_bound = (platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES + 1) as u32;
        for (syscall, argument_indexes) in [
            (Syscall::GetEnv as u32, &[0u8][..]),
            (Syscall::SetEnv as u32, &[0u8, 1][..]),
            (Syscall::UnsetEnv as u32, &[0u8][..]),
        ] {
            for argument_index in argument_indexes {
                let descriptor = find(syscall)
                    .args
                    .iter()
                    .find(|descriptor| descriptor.arg_index == *argument_index)
                    .expect("missing process-metadata string descriptor");
                assert_eq!(
                    descriptor.size,
                    cstring!(metadata_bound, E2BIG),
                    "metadata content cap excludes its required NUL"
                );
            }
        }

        for syscall in [extra_syscalls::SYS_MQ_OPEN, extra_syscalls::SYS_MQ_UNLINK] {
            assert_eq!(
                find(syscall).args[0].size,
                cstring!(platform_limits::NAME_MAX_BYTES),
                "NAME_MAX_BYTES already includes the terminating NUL"
            );
        }
        assert_eq!(
            find(Syscall::Open as u32).args[0].size,
            cstring!(),
            "PATH_MAX is the complete C-string buffer size"
        );
    }

    #[test]
    fn pointer_nullability_is_explicit_and_exhaustive() {
        let mut actual_nullable = Vec::new();
        for entry in SYSCALL_ARG_DESCRIPTORS {
            for arg in entry.args {
                assert_ne!(
                    arg.nullable, arg.required,
                    "syscall {} arg {} must be explicitly nullable or required",
                    entry.syscall_number, arg.arg_index
                );
                match arg.size {
                    SyscallArgSize::Arg { multiplier, .. } => assert_ne!(
                        multiplier, 0,
                        "syscall {} arg {} has a zero size multiplier",
                        entry.syscall_number, arg.arg_index
                    ),
                    SyscallArgSize::Fixed { size } => assert_ne!(
                        size, 0,
                        "syscall {} arg {} has an empty fixed record",
                        entry.syscall_number, arg.arg_index
                    ),
                    SyscallArgSize::ProcessLayout {
                        wasm32_size,
                        wasm64_size,
                    } => {
                        assert_ne!(
                            wasm32_size, 0,
                            "syscall {} arg {} has an empty wasm32 record",
                            entry.syscall_number, arg.arg_index
                        );
                        assert_ne!(
                            wasm64_size, 0,
                            "syscall {} arg {} has an empty wasm64 record",
                            entry.syscall_number, arg.arg_index
                        );
                    }
                    SyscallArgSize::CString { max_bytes, .. } => assert_ne!(
                        max_bytes, 0,
                        "syscall {} arg {} has an empty C-string bound",
                        entry.syscall_number, arg.arg_index
                    ),
                    SyscallArgSize::Deref { .. } => {}
                }
                if arg.nullable {
                    actual_nullable.push((entry.syscall_number, arg.arg_index));
                }
            }
        }

        let mut expected_nullable = std::vec![
            (Syscall::Sigaction as u32, 1),
            (Syscall::Sigaction as u32, 2),
            (Syscall::Sigprocmask as u32, 1),
            (Syscall::Sigprocmask as u32, 2),
            (Syscall::Accept as u32, 1),
            (Syscall::Accept as u32, 2),
            (Syscall::Recvfrom as u32, 4),
            (Syscall::Recvfrom as u32, 5),
            (Syscall::ClockGetres as u32, 1),
            (Syscall::Utimensat as u32, 1),
            (Syscall::Utimensat as u32, 2),
            (Syscall::Wait4 as u32, 1),
            (Syscall::Wait4 as u32, 3),
            (extra_syscalls::SYS_RT_SIGTIMEDWAIT, 1),
            (extra_syscalls::SYS_RT_SIGTIMEDWAIT, 2),
            (extra_syscalls::SYS_SIGALTSTACK, 0),
            (extra_syscalls::SYS_SIGALTSTACK, 1),
            (extra_syscalls::SYS_SETITIMER, 2),
            (extra_syscalls::SYS_TIMERFD_SETTIME, 3),
            (extra_syscalls::SYS_PRLIMIT64, 2),
            (extra_syscalls::SYS_PRLIMIT64, 3),
            (extra_syscalls::SYS_WAITID, 4),
            (extra_syscalls::SYS_COPY_FILE_RANGE, 1),
            (extra_syscalls::SYS_COPY_FILE_RANGE, 3),
            (extra_syscalls::SYS_SPLICE, 1),
            (extra_syscalls::SYS_SPLICE, 3),
            (extra_syscalls::SYS_SENDFILE, 2),
            (extra_syscalls::SYS_GETCPU, 0),
            (extra_syscalls::SYS_GETCPU, 1),
            (extra_syscalls::SYS_TIMER_CREATE, 1),
            (extra_syscalls::SYS_TIMER_SETTIME, 3),
            (extra_syscalls::SYS_MQ_OPEN, 3),
            (extra_syscalls::SYS_MQ_TIMEDSEND, 4),
            (extra_syscalls::SYS_MQ_TIMEDRECEIVE, 3),
            (extra_syscalls::SYS_MQ_TIMEDRECEIVE, 4),
            (extra_syscalls::SYS_MQ_NOTIFY, 1),
            (extra_syscalls::SYS_MQ_GETSETATTR, 1),
            (extra_syscalls::SYS_MQ_GETSETATTR, 2),
            (extra_syscalls::SYS_ACCEPT4, 1),
            (extra_syscalls::SYS_ACCEPT4, 2),
        ];
        actual_nullable.sort_unstable();
        expected_nullable.sort_unstable();
        assert_eq!(
            actual_nullable, expected_nullable,
            "review syscall semantics before changing the explicit nullable set"
        );
    }

    #[test]
    fn option_sensitive_prctl_stays_out_of_generic_pointer_metadata() {
        assert!(
            maybe_find(extra_syscalls::SYS_PRCTL).is_none(),
            "PR_SET_NAME/PR_GET_NAME use a pointer in arg 1, but other prctl options use a scalar"
        );
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
        assert_eq!(lchown.size, cstring!());
        assert!(!lchown.nullable);

        let utimensat_path = find(Syscall::Utimensat as u32).args[0];
        assert_eq!(utimensat_path.size, cstring!());
        assert!(utimensat_path.nullable);

        let pathconf = find(Syscall::Pathconf as u32).args;
        assert_eq!(pathconf[0].size, cstring!());
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

        let sigtimedwait = find(extra_syscalls::SYS_RT_SIGTIMEDWAIT).args;
        assert_eq!(
            sigtimedwait[1].size,
            SyscallArgSize::ProcessLayout {
                wasm32_size: process_layout::rt_sigqueueinfo::WASM32_SIZE,
                wasm64_size: process_layout::rt_sigqueueinfo::WASM64_SIZE,
            }
        );
        assert!(sigtimedwait[1].nullable);

        let waitid = find(extra_syscalls::SYS_WAITID).args;
        assert_eq!(waitid[0].arg_index, 2);
        assert_eq!(waitid[0].direction, SyscallArgDirection::Out);
        assert_eq!(
            waitid[0].size,
            SyscallArgSize::ProcessLayout {
                wasm32_size: process_layout::rt_sigqueueinfo::WASM32_SIZE,
                wasm64_size: process_layout::rt_sigqueueinfo::WASM64_SIZE,
            }
        );
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

        let sched_getaffinity = find(extra_syscalls::SYS_SCHED_GETAFFINITY).args[0];
        assert_eq!(sched_getaffinity.arg_index, 2);
        assert_eq!(sched_getaffinity.direction, SyscallArgDirection::Out);
        assert_eq!(
            sched_getaffinity.size,
            SyscallArgSize::Fixed {
                size: SCHED_AFFINITY_MASK_SIZE,
            }
        );
        assert!(sched_getaffinity.required);

        let timerfd_settime = find(extra_syscalls::SYS_TIMERFD_SETTIME).args;
        assert_eq!(timerfd_settime[0].arg_index, 2);
        assert_eq!(timerfd_settime[0].direction, SyscallArgDirection::In);
        assert_eq!(timerfd_settime[0].size, SyscallArgSize::Fixed { size: 32 });
        assert!(timerfd_settime[0].required);
        assert_eq!(timerfd_settime[1].arg_index, 3);
        assert_eq!(timerfd_settime[1].direction, SyscallArgDirection::Out);
        assert_eq!(timerfd_settime[1].size, SyscallArgSize::Fixed { size: 32 });
        assert!(timerfd_settime[1].nullable);

        let timerfd_gettime = find(extra_syscalls::SYS_TIMERFD_GETTIME).args[0];
        assert_eq!(timerfd_gettime.arg_index, 1);
        assert_eq!(timerfd_gettime.direction, SyscallArgDirection::Out);
        assert_eq!(timerfd_gettime.size, SyscallArgSize::Fixed { size: 32 });
        assert!(timerfd_gettime.required);

        for syscall in [extra_syscalls::SYS_SIGNALFD4, extra_syscalls::SYS_SIGNALFD] {
            let mask = find(syscall).args[0];
            assert_eq!(mask.arg_index, 1);
            assert_eq!(mask.direction, SyscallArgDirection::In);
            assert_eq!(mask.size, SyscallArgSize::Fixed { size: 8 });
            assert!(mask.required);
        }

        let memfd_name = find(extra_syscalls::SYS_MEMFD_CREATE).args[0];
        assert_eq!(memfd_name.arg_index, 0);
        assert_eq!(memfd_name.direction, SyscallArgDirection::In);
        assert_eq!(
            memfd_name.size,
            cstring!(platform_limits::MEMFD_NAME_MAX_BYTES, EINVAL),
        );
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
        assert_eq!(sendfile_offset.direction, SyscallArgDirection::InOut);
        assert_eq!(sendfile_offset.size, SyscallArgSize::Fixed { size: 8 });
        assert!(sendfile_offset.nullable);

        let renameat2 = find(extra_syscalls::SYS_RENAMEAT2).args;
        assert_eq!(renameat2.len(), 2);
        for (path, arg_index) in renameat2.iter().zip([1, 3]) {
            assert_eq!(path.arg_index, arg_index);
            assert_eq!(path.direction, SyscallArgDirection::In);
            assert_eq!(path.size, cstring!());
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

        let getgroups = find(Syscall::Getgroups as u32).args[0];
        assert_eq!(getgroups.arg_index, 1);
        assert_eq!(getgroups.direction, SyscallArgDirection::Out);
        assert_eq!(
            getgroups.size,
            SyscallArgSize::Arg {
                arg_index: 0,
                multiplier: 4,
                add: 0,
            }
        );
        assert_eq!(
            getgroups.copy_out_length,
            Some(SyscallArgCopyOutLength::ReturnValue {
                multiplier: 4,
                max_value: platform_limits::NGROUPS_MAX as u32,
            }),
        );
        assert!(getgroups.required);

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
        for (arg_index, direction) in [(0, SyscallArgDirection::In), (1, SyscallArgDirection::Out)]
        {
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
        for (arg_index, direction) in [(1, SyscallArgDirection::In), (2, SyscallArgDirection::Out)]
        {
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
            extra_syscalls::SYS_TIMER_CREATE,
            1,
            SyscallArgDirection::In,
            process_layout::sigevent::WASM32_SIZE,
            process_layout::sigevent::WASM64_SIZE,
        );
        assert!(find(extra_syscalls::SYS_TIMER_CREATE).args[0].nullable);
        assert_layout(
            extra_syscalls::SYS_MQ_NOTIFY,
            1,
            SyscallArgDirection::In,
            process_layout::sigevent::WASM32_SIZE,
            process_layout::sigevent::WASM64_SIZE,
        );
        for (arg_index, direction) in [(1, SyscallArgDirection::In), (2, SyscallArgDirection::Out)]
        {
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
    fn exceptional_copy_out_lengths_are_bounded_by_staged_records() {
        let readdir = find(Syscall::Readdir as u32);
        let name = readdir
            .args
            .iter()
            .find(|arg| arg.arg_index == 2)
            .expect("missing readdir name output");
        assert_eq!(
            name.copy_out_length,
            Some(SyscallArgCopyOutLength::U32Field {
                arg_index: 1,
                offset: offset_of!(crate::WasmDirent, d_namlen) as u32,
            })
        );

        for entry in SYSCALL_ARG_DESCRIPTORS {
            for desc in entry.args {
                let Some(copy_out_length) = desc.copy_out_length else {
                    continue;
                };
                assert_eq!(
                    desc.direction,
                    SyscallArgDirection::Out,
                    "syscall {} arg {} copy-out override must describe output",
                    entry.syscall_number,
                    desc.arg_index,
                );
                let (arg_index, offset) = match copy_out_length {
                    SyscallArgCopyOutLength::U32Field { arg_index, offset } => {
                        (arg_index, offset)
                    }
                    SyscallArgCopyOutLength::ReturnValue {
                        multiplier,
                        max_value,
                    } => {
                        assert_ne!(multiplier, 0);
                        assert_ne!(max_value, 0);
                        assert!(multiplier.checked_mul(max_value).is_some());
                        continue;
                    }
                };
                assert!(
                    matches!(desc.size, SyscallArgSize::Arg { .. }),
                    "syscall {} arg {} copy-out override needs an explicit caller capacity",
                    entry.syscall_number,
                    desc.arg_index,
                );
                let source = entry
                    .args
                    .iter()
                    .find(|candidate| candidate.arg_index == arg_index)
                    .expect("copy-out length source must be staged");
                let SyscallArgSize::Fixed { size } = source.size else {
                    panic!("copy-out u32 source must have a fixed staged size");
                };
                assert!(
                    offset.checked_add(size_of::<u32>() as u32).is_some_and(|end| end <= size),
                    "copy-out u32 field must fit its staged source",
                );
            }
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
