//! Native musl layouts selected by the calling process's data model.
//!
//! One kernel Wasm instance may serve both wasm32 and wasm64 processes.  These
//! layouts therefore must never be selected from the kernel Wasm's own target
//! width.  The host carries the process pointer width in the private sixth
//! channel argument for syscalls whose native structures differ.

/// wasm32 process pointers and C `long` values are four bytes.
pub const WASM32_POINTER_WIDTH: u32 = 4;
/// wasm64 process pointers and C `long` values are eight bytes.
pub const WASM64_POINTER_WIDTH: u32 = 8;

/// Return a target-dependent value for a supported process pointer width.
pub const fn select(pointer_width: u32, wasm32: u32, wasm64: u32) -> Option<u32> {
    match pointer_width {
        WASM32_POINTER_WIDTH => Some(wasm32),
        WASM64_POINTER_WIDTH => Some(wasm64),
        _ => None,
    }
}

/// Caller-native musl `struct iovec`.
///
/// This is deliberately distinct from the kernel-scratch [`KernelIovecWire`]
/// record. A single wasm32 kernel can serve wasm32 and wasm64 callers, so the
/// host must decode the caller-native table before constructing the fixed
/// kernel wire.
///
/// [`KernelIovecWire`]: crate::KernelIovecWire
pub mod iovec {
    pub const WASM32_SIZE: u32 = 8;
    pub const WASM32_BASE_OFFSET: u32 = 0;
    pub const WASM32_LEN_OFFSET: u32 = 4;

    pub const WASM64_SIZE: u32 = 16;
    pub const WASM64_BASE_OFFSET: u32 = 0;
    pub const WASM64_LEN_OFFSET: u32 = 8;
}

/// Caller-native musl `struct msghdr`.
///
/// musl keeps `msg_iovlen` and `msg_controllen` 32-bit on wasm64 and places
/// explicit little-endian padding after each field. These offsets therefore
/// cannot be derived from pointer width alone at a TypeScript call site.
pub mod msghdr {
    pub const WASM32_SIZE: u32 = 28;
    pub const WASM32_NAME_OFFSET: u32 = 0;
    pub const WASM32_NAMELEN_OFFSET: u32 = 4;
    pub const WASM32_IOV_OFFSET: u32 = 8;
    pub const WASM32_IOVLEN_OFFSET: u32 = 12;
    pub const WASM32_CONTROL_OFFSET: u32 = 16;
    pub const WASM32_CONTROLLEN_OFFSET: u32 = 20;
    pub const WASM32_FLAGS_OFFSET: u32 = 24;

    pub const WASM64_SIZE: u32 = 56;
    pub const WASM64_NAME_OFFSET: u32 = 0;
    pub const WASM64_NAMELEN_OFFSET: u32 = 8;
    pub const WASM64_IOV_OFFSET: u32 = 16;
    pub const WASM64_IOVLEN_OFFSET: u32 = 24;
    pub const WASM64_CONTROL_OFFSET: u32 = 32;
    pub const WASM64_CONTROLLEN_OFFSET: u32 = 40;
    pub const WASM64_FLAGS_OFFSET: u32 = 48;
}

/// Caller-native musl `struct cmsghdr` and CMSG record alignment.
///
/// The wasm64 header has a four-byte pad after `cmsg_len`, and successive
/// records are aligned to eight bytes. Kernel scratch instead uses the fixed
/// [`KernelCmsghdrWire`] layout, so host translation must use these generated
/// values in both directions.
///
/// [`KernelCmsghdrWire`]: crate::KernelCmsghdrWire
pub mod cmsghdr {
    pub const WASM32_SIZE: u32 = 12;
    pub const WASM32_ALIGN: u32 = 4;
    pub const WASM32_LEN_OFFSET: u32 = 0;
    pub const WASM32_LEVEL_OFFSET: u32 = 4;
    pub const WASM32_TYPE_OFFSET: u32 = 8;
    pub const WASM32_DATA_OFFSET: u32 = 12;

    pub const WASM64_SIZE: u32 = 16;
    pub const WASM64_ALIGN: u32 = 8;
    pub const WASM64_LEN_OFFSET: u32 = 0;
    pub const WASM64_LEVEL_OFFSET: u32 = 8;
    pub const WASM64_TYPE_OFFSET: u32 = 12;
    pub const WASM64_DATA_OFFSET: u32 = 16;
}

/// Caller-native multicast `group_req` and `group_source_req`.
///
/// The embedded `sockaddr_storage` fields are four-byte aligned on wasm32 and
/// eight-byte aligned on wasm64. Option-buffer length and padding contents are
/// not a data-model discriminator; the host carries the caller width in the
/// channel's private sixth argument.
pub mod multicast_group_request {
    pub const WASM32_GROUP_REQ_SIZE: u32 = 132;
    pub const WASM32_GROUP_OFFSET: u32 = 4;
    pub const WASM32_GROUP_SOURCE_REQ_SIZE: u32 = 260;
    pub const WASM32_SOURCE_OFFSET: u32 = 132;

    pub const WASM64_GROUP_REQ_SIZE: u32 = 136;
    pub const WASM64_GROUP_OFFSET: u32 = 8;
    pub const WASM64_GROUP_SOURCE_REQ_SIZE: u32 = 264;
    pub const WASM64_SOURCE_OFFSET: u32 = 136;
}

/// `stack_t` / `struct sigaltstack`.
pub mod sigaltstack {
    pub const WASM32_SIZE: u32 = 12;
    pub const WASM32_SP_OFFSET: u32 = 0;
    pub const WASM32_FLAGS_OFFSET: u32 = 4;
    pub const WASM32_STACK_SIZE_OFFSET: u32 = 8;

    pub const WASM64_SIZE: u32 = 24;
    pub const WASM64_SP_OFFSET: u32 = 0;
    pub const WASM64_FLAGS_OFFSET: u32 = 8;
    pub const WASM64_STACK_SIZE_OFFSET: u32 = 16;
}

/// Kernel-facing `setitimer`/`getitimer` record.
///
/// wasm32 musl deliberately translates its public 32-byte time64
/// `struct itimerval` to the kernel's historical four-`long` time32 record.
/// wasm64 has no translation and sends its native four-i64 record directly.
pub mod itimerval {
    pub const WASM32_SIZE: u32 = 16;
    pub const WASM64_SIZE: u32 = 32;

    pub const INTERVAL_SEC_INDEX: u32 = 0;
    pub const INTERVAL_USEC_INDEX: u32 = 1;
    pub const VALUE_SEC_INDEX: u32 = 2;
    pub const VALUE_USEC_INDEX: u32 = 3;
}

/// Native POSIX message-queue attributes.
pub mod mq_attr {
    pub const WASM32_SIZE: u32 = 32;
    pub const WASM32_FLAGS_OFFSET: u32 = 0;
    pub const WASM32_MAXMSG_OFFSET: u32 = 4;
    pub const WASM32_MSGSIZE_OFFSET: u32 = 8;
    pub const WASM32_CURMSGS_OFFSET: u32 = 12;

    pub const WASM64_SIZE: u32 = 64;
    pub const WASM64_FLAGS_OFFSET: u32 = 0;
    pub const WASM64_MAXMSG_OFFSET: u32 = 8;
    pub const WASM64_MSGSIZE_OFFSET: u32 = 16;
    pub const WASM64_CURMSGS_OFFSET: u32 = 24;
}

/// Native `struct sigevent` used by `mq_notify` and `timer_create`.
pub mod sigevent {
    pub const WASM32_SIZE: u32 = 64;
    pub const WASM32_VALUE_OFFSET: u32 = 0;
    pub const WASM32_VALUE_SIZE: u32 = 4;
    pub const WASM32_SIGNO_OFFSET: u32 = 4;
    pub const WASM32_NOTIFY_OFFSET: u32 = 8;
    pub const WASM32_PAYLOAD_OFFSET: u32 = 12;

    pub const WASM64_SIZE: u32 = 64;
    pub const WASM64_VALUE_OFFSET: u32 = 0;
    pub const WASM64_VALUE_SIZE: u32 = 8;
    pub const WASM64_SIGNO_OFFSET: u32 = 8;
    pub const WASM64_NOTIFY_OFFSET: u32 = 12;
    pub const WASM64_PAYLOAD_OFFSET: u32 = 16;
}

/// Native musl `struct statfs`.
pub mod statfs {
    pub const WASM32_SIZE: u32 = 88;
    pub const WASM32_TYPE_OFFSET: u32 = 0;
    pub const WASM32_BSIZE_OFFSET: u32 = 4;
    pub const WASM32_BLOCKS_OFFSET: u32 = 8;
    pub const WASM32_BFREE_OFFSET: u32 = 16;
    pub const WASM32_BAVAIL_OFFSET: u32 = 24;
    pub const WASM32_FILES_OFFSET: u32 = 32;
    pub const WASM32_FFREE_OFFSET: u32 = 40;
    pub const WASM32_FSID_OFFSET: u32 = 48;
    pub const WASM32_NAMELEN_OFFSET: u32 = 56;
    pub const WASM32_FRSIZE_OFFSET: u32 = 60;
    pub const WASM32_FLAGS_OFFSET: u32 = 64;
    pub const WASM32_SPARE_OFFSET: u32 = 68;

    pub const WASM64_SIZE: u32 = 120;
    pub const WASM64_TYPE_OFFSET: u32 = 0;
    pub const WASM64_BSIZE_OFFSET: u32 = 8;
    pub const WASM64_BLOCKS_OFFSET: u32 = 16;
    pub const WASM64_BFREE_OFFSET: u32 = 24;
    pub const WASM64_BAVAIL_OFFSET: u32 = 32;
    pub const WASM64_FILES_OFFSET: u32 = 40;
    pub const WASM64_FFREE_OFFSET: u32 = 48;
    pub const WASM64_FSID_OFFSET: u32 = 56;
    pub const WASM64_NAMELEN_OFFSET: u32 = 64;
    pub const WASM64_FRSIZE_OFFSET: u32 = 72;
    pub const WASM64_FLAGS_OFFSET: u32 = 80;
    pub const WASM64_SPARE_OFFSET: u32 = 88;
}

/// Native Linux-compatible `struct sysinfo`.
pub mod sysinfo {
    pub const WASM32_SIZE: u32 = 312;
    pub const WASM32_UPTIME_OFFSET: u32 = 0;
    pub const WASM32_LOADS_OFFSET: u32 = 4;
    pub const WASM32_TOTALRAM_OFFSET: u32 = 16;
    pub const WASM32_FREERAM_OFFSET: u32 = 20;
    pub const WASM32_SHAREDRAM_OFFSET: u32 = 24;
    pub const WASM32_BUFFERRAM_OFFSET: u32 = 28;
    pub const WASM32_TOTALSWAP_OFFSET: u32 = 32;
    pub const WASM32_FREESWAP_OFFSET: u32 = 36;
    pub const WASM32_PROCS_OFFSET: u32 = 40;
    pub const WASM32_TOTALHIGH_OFFSET: u32 = 44;
    pub const WASM32_FREEHIGH_OFFSET: u32 = 48;
    pub const WASM32_MEM_UNIT_OFFSET: u32 = 52;
    pub const WASM32_RESERVED_OFFSET: u32 = 56;

    pub const WASM64_SIZE: u32 = 368;
    pub const WASM64_UPTIME_OFFSET: u32 = 0;
    pub const WASM64_LOADS_OFFSET: u32 = 8;
    pub const WASM64_TOTALRAM_OFFSET: u32 = 32;
    pub const WASM64_FREERAM_OFFSET: u32 = 40;
    pub const WASM64_SHAREDRAM_OFFSET: u32 = 48;
    pub const WASM64_BUFFERRAM_OFFSET: u32 = 56;
    pub const WASM64_TOTALSWAP_OFFSET: u32 = 64;
    pub const WASM64_FREESWAP_OFFSET: u32 = 72;
    pub const WASM64_PROCS_OFFSET: u32 = 80;
    pub const WASM64_TOTALHIGH_OFFSET: u32 = 88;
    pub const WASM64_FREEHIGH_OFFSET: u32 = 96;
    pub const WASM64_MEM_UNIT_OFFSET: u32 = 104;
    pub const WASM64_RESERVED_OFFSET: u32 = 108;
}

/// Caller-native `siginfo_t` used by signal queue, wait, and delivery paths.
///
/// Both targets reserve 128 bytes, but LP64 alignment moves the common
/// pid/uid/value-or-status fields. The full record size is part of every copy
/// contract so no caller bytes outside `siginfo_t` enter kernel scratch and no
/// host write can replace bytes beyond the caller-owned object.
pub mod rt_sigqueueinfo {
    pub const SIGNO_OFFSET: u32 = 0;
    pub const ERRNO_OFFSET: u32 = 4;
    pub const CODE_OFFSET: u32 = 8;

    pub const WASM32_SIZE: u32 = 128;
    pub const WASM32_PID_OFFSET: u32 = 12;
    pub const WASM32_UID_OFFSET: u32 = 16;
    pub const WASM32_VALUE_OFFSET: u32 = 20;
    pub const WASM32_VALUE_SIZE: u32 = 4;

    pub const WASM64_SIZE: u32 = 128;
    pub const WASM64_PID_OFFSET: u32 = 16;
    pub const WASM64_UID_OFFSET: u32 = 20;
    pub const WASM64_VALUE_OFFSET: u32 = 24;
    pub const WASM64_VALUE_SIZE: u32 = 8;
}

/// Native musl `struct kstat` used by stat/fstat/lstat/fstatat syscalls.
///
/// This is deliberately separate from the kernel's 96-byte [`crate::WasmStat`]
/// host-import record. The guest record carries WasmStat's rdev and appends
/// the otherwise-zero block-size and block-count fields; every byte is
/// initialized before the host copies it back to process memory.
pub mod stat {
    pub const SIZE: u32 = 112;
    pub const DEV_OFFSET: u32 = 0;
    pub const INO_OFFSET: u32 = 8;
    pub const MODE_OFFSET: u32 = 16;
    pub const NLINK_OFFSET: u32 = 20;
    pub const UID_OFFSET: u32 = 24;
    pub const GID_OFFSET: u32 = 28;
    pub const SIZE_OFFSET: u32 = 32;
    pub const ATIME_SEC_OFFSET: u32 = 40;
    pub const ATIME_NSEC_OFFSET: u32 = 48;
    pub const MTIME_SEC_OFFSET: u32 = 56;
    pub const MTIME_NSEC_OFFSET: u32 = 64;
    pub const CTIME_SEC_OFFSET: u32 = 72;
    pub const CTIME_NSEC_OFFSET: u32 = 80;
    pub const RDEV_OFFSET: u32 = 88;
    pub const BLKSIZE_OFFSET: u32 = 96;
    pub const BLOCKS_OFFSET: u32 = 104;
}

/// Native POSIX `struct sched_param`.
///
/// Kandelo exposes the POSIX sporadic-server fields even though its current
/// SCHED_OTHER implementation returns an all-zero record. `timespec` is
/// 16 bytes on both declared targets, so the complete structure is 48 bytes.
pub mod sched_param {
    pub const SIZE: u32 = 48;
    pub const PRIORITY_OFFSET: u32 = 0;
    pub const SS_MAX_REPL_OFFSET: u32 = 4;
    pub const SS_REPL_PERIOD_SEC_OFFSET: u32 = 8;
    pub const SS_REPL_PERIOD_NSEC_OFFSET: u32 = 16;
    pub const SS_INIT_BUDGET_SEC_OFFSET: u32 = 24;
    pub const SS_INIT_BUDGET_NSEC_OFFSET: u32 = 32;
    pub const SS_LOW_PRIORITY_OFFSET: u32 = 40;
}
