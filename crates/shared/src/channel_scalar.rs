//! Scalar interpretation for the six i64 syscall-channel argument words.
//!
//! Most kernel-dispatched syscall scalars intentionally use the low signed
//! i32 word. The entries below describe every exception, plus successful
//! results that need a different host interpretation. Keeping the contract in
//! `wasm-posix-shared` lets Rust consume it directly while `xtask dump-abi`
//! generates the TypeScript host maps and musl number assertions.

use crate::{abi::extended_syscalls, Syscall};

/// Interpretation of one physical i64 channel argument word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelScalarKind {
    /// The default low signed 32-bit scalar interpretation.
    I32,
    /// A low unsigned 32-bit scalar.
    U32,
    /// One unsigned scalar that must fit u32 without discarding high bits.
    ExactU32,
    /// One unsigned, guest-pointer-width `size_t` scalar.
    ///
    /// The physical channel word remains i64. Consumers reinterpret its bits
    /// as u64, then reject values that do not fit the active Wasm target.
    ProcessSize,
    /// One unsigned guest process address that remains in process space.
    ///
    /// Transfer descriptors replace caller pointers with kernel allocation
    /// addresses; this kind is reserved for raw process addresses that Rust
    /// still interprets after host planning.
    ProcessAddress,
    /// One complete signed 64-bit scalar.
    I64,
    /// Low unsigned word of one split signed-i64 scalar.
    SplitI64LowU32,
    /// High signed word of one split signed-i64 scalar.
    SplitI64HighI32,
}

impl ChannelScalarKind {
    pub const fn abi_name(self) -> &'static str {
        match self {
            Self::I32 => "i32",
            Self::U32 => "u32",
            Self::ExactU32 => "exact-u32",
            Self::ProcessSize => "process-size",
            Self::ProcessAddress => "process-address",
            Self::I64 => "i64",
            Self::SplitI64LowU32 => "split-i64-low-u32",
            Self::SplitI64HighI32 => "split-i64-high-i32",
        }
    }
}

/// Interpretation of a successful syscall-channel result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelResultKind {
    /// The default signed-i32 syscall result widened into the i64 channel.
    I32,
    /// An exact signed-i64 result that must not pass through JavaScript Number.
    I64,
    /// A process address that the host must validate for the caller's width.
    ProcessAddress,
}

impl ChannelResultKind {
    pub const fn abi_name(self) -> &'static str {
        match self {
            Self::I32 => "i32",
            Self::I64 => "i64",
            Self::ProcessAddress => "process-address",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelScalarArgument {
    pub index: u8,
    pub kind: ChannelScalarKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelScalarSyscall {
    pub syscall_number: u32,
    /// Suffix of the target musl `__NR_*` macro.
    pub musl_name: &'static str,
    pub arguments: &'static [ChannelScalarArgument],
    pub result: ChannelResultKind,
}

const SEEK_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 1,
        kind: ChannelScalarKind::SplitI64LowU32,
    },
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::SplitI64HighI32,
    },
];
const MMAP_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 0,
        kind: ChannelScalarKind::ProcessAddress,
    },
    ChannelScalarArgument {
        index: 1,
        kind: ChannelScalarKind::ProcessSize,
    },
    ChannelScalarArgument {
        index: 5,
        kind: ChannelScalarKind::I64,
    },
];
const PROCESS_ADDRESS_ARGUMENT_0: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 0,
    kind: ChannelScalarKind::ProcessAddress,
}];
const PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 0,
        kind: ChannelScalarKind::ProcessAddress,
    },
    ChannelScalarArgument {
        index: 1,
        kind: ChannelScalarKind::ProcessSize,
    },
];
const PROCESS_SIZE_ARGUMENT_0: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 0,
    kind: ChannelScalarKind::ProcessSize,
}];
const PROCESS_SIZE_ARGUMENT_1: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 1,
    kind: ChannelScalarKind::ProcessSize,
}];
const PROCESS_SIZE_ARGUMENT_2: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 2,
    kind: ChannelScalarKind::ProcessSize,
}];
const PROCESS_SIZE_ARGUMENT_3: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 3,
    kind: ChannelScalarKind::ProcessSize,
}];
const PROCESS_SIZE_ARGUMENT_5: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 5,
    kind: ChannelScalarKind::ProcessSize,
}];
const U32_ARGUMENT_2: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 2,
    kind: ChannelScalarKind::U32,
}];
const U32_ARGUMENT_4: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 4,
    kind: ChannelScalarKind::U32,
}];
const PREAD_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::ProcessSize,
    },
    ChannelScalarArgument {
        index: 3,
        kind: ChannelScalarKind::I64,
    },
];
const PWRITE_ARGUMENTS: &[ChannelScalarArgument] = PREAD_ARGUMENTS;
const FTRUNCATE_ARGUMENTS: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 1,
    kind: ChannelScalarKind::I64,
}];
const TRUNCATE_ARGUMENTS: &[ChannelScalarArgument] = FTRUNCATE_ARGUMENTS;
const LLSEEK_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 1,
        kind: ChannelScalarKind::SplitI64HighI32,
    },
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::SplitI64LowU32,
    },
];
const MREMAP_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 0,
        kind: ChannelScalarKind::ProcessAddress,
    },
    ChannelScalarArgument {
        index: 1,
        kind: ChannelScalarKind::ProcessSize,
    },
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::ProcessSize,
    },
];
const SCHED_AFFINITY_ARGUMENTS: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 1,
    // Linux's raw sched_{get,set}affinity ABI uses unsigned int here even
    // though libc exposes a size_t wrapper. Preserve the raw syscall contract
    // instead of widening it with the guest pointer width.
    kind: ChannelScalarKind::U32,
}];
const SENDTO_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::ProcessSize,
    },
    ChannelScalarArgument {
        index: 5,
        kind: ChannelScalarKind::U32,
    },
];
const PPOLL_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 1,
        kind: ChannelScalarKind::ProcessSize,
    },
    ChannelScalarArgument {
        index: 4,
        kind: ChannelScalarKind::ProcessSize,
    },
];
const READAHEAD_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 1,
        kind: ChannelScalarKind::I64,
    },
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::ProcessSize,
    },
];
const POSITIONED_VECTOR_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 3,
        kind: ChannelScalarKind::SplitI64LowU32,
    },
    ChannelScalarArgument {
        index: 4,
        kind: ChannelScalarKind::SplitI64HighI32,
    },
];
const FALLOCATE_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::I64,
    },
    ChannelScalarArgument {
        index: 3,
        kind: ChannelScalarKind::I64,
    },
];
const MSGRCV_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::ProcessSize,
    },
    ChannelScalarArgument {
        index: 3,
        kind: ChannelScalarKind::I64,
    },
];
const COPY_FILE_RANGE_ARGUMENTS: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 4,
    kind: ChannelScalarKind::ProcessSize,
}];
const SENDFILE_ARGUMENTS: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 3,
    kind: ChannelScalarKind::ProcessSize,
}];
const SIGNAL_ARGUMENTS: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 1,
    kind: ChannelScalarKind::ExactU32,
}];
const GET_ROBUST_LIST_ARGUMENTS: &[ChannelScalarArgument] = &[
    ChannelScalarArgument {
        index: 1,
        kind: ChannelScalarKind::ProcessAddress,
    },
    ChannelScalarArgument {
        index: 2,
        kind: ChannelScalarKind::ProcessAddress,
    },
];
const SIGNALFD_ARGUMENTS: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 2,
    kind: ChannelScalarKind::ProcessSize,
}];
const SHMGET_ARGUMENTS: &[ChannelScalarArgument] = &[ChannelScalarArgument {
    index: 1,
    kind: ChannelScalarKind::ProcessSize,
}];

/// Every syscall whose argument or successful-result interpretation differs
/// from the channel's default signed-i32 contract.
///
/// Keep this sorted by syscall number. The generated C header checks each
/// number against both musl target headers when their glue is compiled.
pub const SYSCALLS: &[ChannelScalarSyscall] = &[
    ChannelScalarSyscall {
        syscall_number: Syscall::Read as u32,
        musl_name: "read",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Write as u32,
        musl_name: "write",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Seek as u32,
        musl_name: "lseek",
        arguments: SEEK_ARGUMENTS,
        result: ChannelResultKind::I64,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Readlink as u32,
        musl_name: "readlink",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Getcwd as u32,
        musl_name: "getcwd",
        arguments: PROCESS_SIZE_ARGUMENT_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Readdir as u32,
        musl_name: "readdir",
        arguments: PROCESS_SIZE_ARGUMENT_3,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::GetEnv as u32,
        musl_name: "getenv",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Mmap as u32,
        musl_name: "mmap",
        arguments: MMAP_ARGUMENTS,
        result: ChannelResultKind::ProcessAddress,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Munmap as u32,
        musl_name: "munmap",
        arguments: PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Brk as u32,
        musl_name: "brk",
        arguments: PROCESS_ADDRESS_ARGUMENT_0,
        result: ChannelResultKind::ProcessAddress,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Mprotect as u32,
        musl_name: "mprotect",
        arguments: PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Bind as u32,
        musl_name: "bind",
        arguments: U32_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Connect as u32,
        musl_name: "connect",
        arguments: U32_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Send as u32,
        musl_name: "send",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Recv as u32,
        musl_name: "recv",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Setsockopt as u32,
        musl_name: "setsockopt",
        arguments: U32_ARGUMENT_4,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Poll as u32,
        musl_name: "poll",
        arguments: PROCESS_SIZE_ARGUMENT_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Sendto as u32,
        musl_name: "sendto",
        arguments: SENDTO_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Recvfrom as u32,
        musl_name: "recvfrom",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Pread as u32,
        musl_name: "pread",
        arguments: PREAD_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Pwrite as u32,
        musl_name: "pwrite",
        arguments: PWRITE_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Time as u32,
        musl_name: "time",
        arguments: &[],
        result: ChannelResultKind::I64,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Signal as u32,
        musl_name: "signal",
        arguments: SIGNAL_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Ftruncate as u32,
        musl_name: "ftruncate",
        arguments: FTRUNCATE_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Truncate as u32,
        musl_name: "truncate",
        arguments: TRUNCATE_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Readlinkat as u32,
        musl_name: "readlinkat",
        arguments: PROCESS_SIZE_ARGUMENT_3,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Realpath as u32,
        musl_name: "realpath",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_LLSEEK,
        musl_name: "_llseek",
        arguments: LLSEEK_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_GETRANDOM,
        musl_name: "getrandom",
        arguments: PROCESS_SIZE_ARGUMENT_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Getdents64 as u32,
        musl_name: "getdents64",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Mremap as u32,
        musl_name: "mremap",
        arguments: MREMAP_ARGUMENTS,
        result: ChannelResultKind::ProcessAddress,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Madvise as u32,
        musl_name: "madvise",
        arguments: PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: Syscall::Setgroups as u32,
        musl_name: "setgroups",
        arguments: PROCESS_SIZE_ARGUMENT_0,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_FUTEX,
        musl_name: "futex",
        arguments: PROCESS_ADDRESS_ARGUMENT_0,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SET_TID_ADDRESS,
        musl_name: "set_tid_address",
        arguments: PROCESS_ADDRESS_ARGUMENT_0,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SCHED_SETAFFINITY,
        musl_name: "sched_setaffinity",
        arguments: SCHED_AFFINITY_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SCHED_GETAFFINITY,
        musl_name: "sched_getaffinity",
        arguments: SCHED_AFFINITY_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_EPOLL_PWAIT,
        musl_name: "epoll_pwait",
        arguments: PROCESS_SIZE_ARGUMENT_5,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SIGNALFD4,
        musl_name: "signalfd4",
        arguments: SIGNALFD_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_PPOLL,
        musl_name: "ppoll",
        arguments: PPOLL_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SET_ROBUST_LIST,
        musl_name: "set_robust_list",
        arguments: PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_GET_ROBUST_LIST,
        musl_name: "get_robust_list",
        arguments: GET_ROBUST_LIST_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_MSYNC,
        musl_name: "msync",
        arguments: PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_MLOCK,
        musl_name: "mlock",
        arguments: PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_MLOCK2,
        musl_name: "mlock2",
        arguments: PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_MUNLOCK,
        musl_name: "munlock",
        arguments: PROCESS_ADDRESS_AND_SIZE_ARGUMENTS_0_1,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_COPY_FILE_RANGE,
        musl_name: "copy_file_range",
        arguments: COPY_FILE_RANGE_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SPLICE,
        musl_name: "splice",
        arguments: COPY_FILE_RANGE_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_READAHEAD,
        musl_name: "readahead",
        arguments: READAHEAD_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SENDFILE,
        musl_name: "sendfile",
        arguments: SENDFILE_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_PREADV,
        musl_name: "preadv",
        arguments: POSITIONED_VECTOR_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_PWRITEV,
        musl_name: "pwritev",
        arguments: POSITIONED_VECTOR_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_PREADV2,
        musl_name: "preadv2",
        arguments: POSITIONED_VECTOR_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_PWRITEV2,
        musl_name: "pwritev2",
        arguments: POSITIONED_VECTOR_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_FALLOCATE,
        musl_name: "fallocate",
        arguments: FALLOCATE_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_MQ_TIMEDSEND,
        musl_name: "mq_timedsend",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_MQ_TIMEDRECEIVE,
        musl_name: "mq_timedreceive",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_MSGRCV,
        musl_name: "msgrcv",
        arguments: MSGRCV_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_MSGSND,
        musl_name: "msgsnd",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SEMOP,
        musl_name: "semop",
        arguments: PROCESS_SIZE_ARGUMENT_2,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SHMGET,
        musl_name: "shmget",
        arguments: SHMGET_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
    ChannelScalarSyscall {
        syscall_number: extended_syscalls::SYS_SIGNALFD,
        musl_name: "signalfd",
        arguments: SIGNALFD_ARGUMENTS,
        result: ChannelResultKind::I32,
    },
];

pub fn syscall_contract(syscall_number: u32) -> Option<&'static ChannelScalarSyscall> {
    SYSCALLS
        .binary_search_by_key(&syscall_number, |contract| contract.syscall_number)
        .ok()
        .map(|index| &SYSCALLS[index])
}

pub fn argument_kind(syscall_number: u32, index: usize) -> ChannelScalarKind {
    let Ok(index) = u8::try_from(index) else {
        return ChannelScalarKind::I32;
    };
    syscall_contract(syscall_number)
        .and_then(|contract| {
            contract
                .arguments
                .iter()
                .find(|argument| argument.index == index)
        })
        .map(|argument| argument.kind)
        .unwrap_or(ChannelScalarKind::I32)
}

pub fn result_kind(syscall_number: u32) -> ChannelResultKind {
    syscall_contract(syscall_number)
        .map(|contract| contract.result)
        .unwrap_or(ChannelResultKind::I32)
}

#[inline]
pub fn i64_argument(syscall_number: u32, args: &[i64; 6], index: usize) -> i64 {
    assert_eq!(
        argument_kind(syscall_number, index),
        ChannelScalarKind::I64,
        "undeclared exact i64 channel scalar for syscall {syscall_number} slot {index}",
    );
    args[index]
}

#[inline]
pub fn u32_argument(syscall_number: u32, args: &[i64; 6], index: usize) -> u32 {
    assert_eq!(
        argument_kind(syscall_number, index),
        ChannelScalarKind::U32,
        "undeclared u32 channel scalar for syscall {syscall_number} slot {index}",
    );
    args[index] as u32
}

#[inline]
pub fn exact_u32_argument(syscall_number: u32, args: &[i64; 6], index: usize) -> Option<u32> {
    assert_eq!(
        argument_kind(syscall_number, index),
        ChannelScalarKind::ExactU32,
        "undeclared exact-u32 channel scalar for syscall {syscall_number} slot {index}",
    );
    u32::try_from(args[index]).ok()
}

pub const fn process_size_for_pointer_bits(raw: u64, pointer_bits: u32) -> Option<u64> {
    match pointer_bits {
        32 => {
            let low = raw as u32;
            let zero_extended = low as u64;
            let sign_extended = (low as i32 as i64) as u64;
            if raw == zero_extended || raw == sign_extended {
                Some(zero_extended)
            } else {
                None
            }
        }
        64 => Some(raw),
        _ => None,
    }
}

/// Maximum successful byte count representable by the channel's signed-i32
/// syscall result domain.
pub const MAX_REPORTABLE_TRANSFER_BYTES: u64 =
    crate::platform_limits::MAX_REPORTABLE_TRANSFER_BYTES as u64;

/// These transfer syscalls permit a short successful operation. Bound the
/// requested work before effects so the returned count can never wrap into an
/// errno-looking i32 afterward.
pub const fn reportable_transfer_count(requested: u64) -> u64 {
    if requested > MAX_REPORTABLE_TRANSFER_BYTES {
        MAX_REPORTABLE_TRANSFER_BYTES
    } else {
        requested
    }
}

#[inline]
pub fn process_size_argument(syscall_number: u32, args: &[i64; 6], index: usize) -> u64 {
    assert_eq!(
        argument_kind(syscall_number, index),
        ChannelScalarKind::ProcessSize,
        "undeclared process-size channel scalar for syscall {syscall_number} slot {index}",
    );
    args[index] as u64
}

#[inline]
pub fn process_address_argument(syscall_number: u32, args: &[i64; 6], index: usize) -> i64 {
    assert_eq!(
        argument_kind(syscall_number, index),
        ChannelScalarKind::ProcessAddress,
        "undeclared process-address channel scalar for syscall {syscall_number} slot {index}",
    );
    args[index]
}

#[inline]
pub fn split_i64_low_argument(syscall_number: u32, args: &[i64; 6], index: usize) -> u32 {
    assert_eq!(
        argument_kind(syscall_number, index),
        ChannelScalarKind::SplitI64LowU32,
        "undeclared low split-i64 channel scalar for syscall {syscall_number} slot {index}",
    );
    args[index] as u32
}

#[inline]
pub fn split_i64_high_argument(syscall_number: u32, args: &[i64; 6], index: usize) -> i32 {
    assert_eq!(
        argument_kind(syscall_number, index),
        ChannelScalarKind::SplitI64HighI32,
        "undeclared high split-i64 channel scalar for syscall {syscall_number} slot {index}",
    );
    args[index] as i32
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;

    fn is_named_abi_syscall(number: u32) -> bool {
        Syscall::from_u32(number).is_some()
            || extended_syscalls::SYSCALLS
                .iter()
                .any(|syscall| syscall.number == number)
    }

    #[test]
    fn contracts_are_sorted_unique_named_and_channel_bounded() {
        let mut previous: Option<&ChannelScalarSyscall> = None;
        for contract in SYSCALLS {
            if let Some(previous) = previous {
                assert!(
                    previous.syscall_number < contract.syscall_number,
                    "channel scalar syscalls must be sorted and unique: \
                     {} ({}) precedes {} ({})",
                    previous.musl_name,
                    previous.syscall_number,
                    contract.musl_name,
                    contract.syscall_number,
                );
            }
            assert!(is_named_abi_syscall(contract.syscall_number));
            assert!(!contract.musl_name.is_empty());

            let mut previous_index = None;
            for argument in contract.arguments {
                if let Some(previous_index) = previous_index {
                    assert!(
                        previous_index < argument.index,
                        "scalar argument slots must be sorted and unique"
                    );
                }
                assert!((argument.index as usize) < crate::channel::ARGS_COUNT);
                assert_ne!(argument.kind, ChannelScalarKind::I32);
                previous_index = Some(argument.index);
            }
            previous = Some(contract);
        }
    }

    #[test]
    fn lookup_defaults_to_the_signed_i32_contract() {
        assert_eq!(
            argument_kind(Syscall::Getpid as u32, 0),
            ChannelScalarKind::I32
        );
        assert_eq!(result_kind(Syscall::Getpid as u32), ChannelResultKind::I32);
        assert_eq!(
            argument_kind(Syscall::Seek as u32, 1),
            ChannelScalarKind::SplitI64LowU32
        );
        assert_eq!(result_kind(Syscall::Seek as u32), ChannelResultKind::I64);
    }

    #[test]
    fn native_width_and_exact_u32_scalars_never_alias_high_bits() {
        let four_gib_plus_page = 0x1_0000_1000u64;
        assert_eq!(process_size_for_pointer_bits(four_gib_plus_page, 32), None);
        assert_eq!(
            process_size_for_pointer_bits(0x0000_0000_8000_0000, 32),
            Some(0x8000_0000)
        );
        assert_eq!(
            process_size_for_pointer_bits(0xffff_ffff_8000_0000, 32),
            Some(0x8000_0000)
        );
        assert_eq!(
            process_size_for_pointer_bits(0xffff_fffe_8000_0000, 32),
            None
        );
        assert_eq!(
            process_size_for_pointer_bits(four_gib_plus_page, 64),
            Some(four_gib_plus_page)
        );
        assert_eq!(
            process_size_for_pointer_bits(1u64 << 63, 64),
            Some(1u64 << 63)
        );
        assert_eq!(process_size_for_pointer_bits(u64::MAX, 64), Some(u64::MAX));

        let mut args = [0i64; 6];
        args[1] = 0x1_0000_0001;
        assert_eq!(exact_u32_argument(Syscall::Signal as u32, &args, 1), None);
        args[1] = u32::MAX as i64;
        assert_eq!(
            exact_u32_argument(Syscall::Signal as u32, &args, 1),
            Some(u32::MAX)
        );
        assert_eq!(
            reportable_transfer_count(MAX_REPORTABLE_TRANSFER_BYTES),
            MAX_REPORTABLE_TRANSFER_BYTES
        );
        assert_eq!(
            reportable_transfer_count(MAX_REPORTABLE_TRANSFER_BYTES + 1),
            MAX_REPORTABLE_TRANSFER_BYTES
        );
    }

    #[test]
    fn typed_readers_fail_closed_for_mismatched_kinds_in_release_too() {
        let args = [0; 6];
        assert!(std::panic::catch_unwind(|| i64_argument(28, &args, 0)).is_err());
        assert!(std::panic::catch_unwind(|| u32_argument(28, &args, 0)).is_err());
        assert!(std::panic::catch_unwind(|| exact_u32_argument(28, &args, 0)).is_err());
        assert!(std::panic::catch_unwind(|| process_size_argument(28, &args, 0)).is_err());
        assert!(std::panic::catch_unwind(|| process_address_argument(28, &args, 0)).is_err());
        assert!(std::panic::catch_unwind(|| split_i64_low_argument(28, &args, 0)).is_err());
        assert!(std::panic::catch_unwind(|| split_i64_high_argument(28, &args, 0)).is_err());
    }
}
