//! The machine's processor count.
//!
//! Every Kandelo process and thread runs in its own host Worker, and the host
//! schedules those Workers on its own CPUs, so guest code executes in
//! parallel up to the host's available parallelism. (Syscalls do not: they
//! are all served by the one kernel worker. See `docs/architecture.md`,
//! "Processors".) The host reports that parallelism once at boot, before any
//! guest runs, and the kernel answers `sysconf(_SC_NPROCESSORS_CONF)`,
//! `sysconf(_SC_NPROCESSORS_ONLN)` and the `sched_getaffinity` mask musl
//! derives both from with the same value.
//!
//! The count is fixed for the life of the kernel: no host can add or remove
//! a CPU from a running Worker pool, so "configured" and "online" are the
//! same number. A kernel the host never configures reports one processor,
//! which is always true.

use core::sync::atomic::{AtomicU32, Ordering};
use wasm_posix_shared::{Errno, SCHED_AFFINITY_MASK_SIZE};

/// Most processors the kernel can describe.
///
/// WHY 32: the CPU-affinity mask is one four-byte kernel word on both wasm32
/// and wasm64 (`SCHED_AFFINITY_MASK_SIZE`), and widening it is an ABI change.
/// A host with more CPUs reports this many, as a Linux kernel built with a
/// smaller `NR_CPUS` does.
pub const MAX_PROCESSORS: u32 = SCHED_AFFINITY_MASK_SIZE * 8;

/// The count the host reported; zero until it does. One value, so the count
/// and the reduction the boot log names can never disagree.
static HOST_REPORTED: AtomicU32 = AtomicU32::new(0);

/// The count to record for a host that reports `available` processors.
///
/// Zero is refused rather than rounded up: a host that cannot say how many
/// processors it has must not claim to have configured the count.
pub fn effective_count(available: u32) -> Result<u32, Errno> {
    if available == 0 {
        return Err(Errno::EINVAL);
    }
    Ok(available.min(MAX_PROCESSORS))
}

/// Record the host's processor count. Returns the count the kernel reports,
/// which is smaller than `available` when the host exceeds [`MAX_PROCESSORS`];
/// the boot record in the kernel log names that reduction
/// (`rootfs::record_root_image_loaded`).
///
/// The count is set once per kernel, at boot: `EBUSY` refuses a second call,
/// so the value programs size their parallelism from cannot change under
/// them.
pub fn configure(available: u32) -> Result<u32, Errno> {
    let count = effective_count(available)?;
    HOST_REPORTED
        .compare_exchange(0, available, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| Errno::EBUSY)?;
    Ok(count)
}

/// Number of processors configured and online: one until the host says.
pub fn count() -> u32 {
    effective_count(HOST_REPORTED.load(Ordering::SeqCst)).unwrap_or(1)
}

/// The count the host reported, when it is more than the kernel can name.
pub fn host_count_beyond_max() -> Option<u32> {
    let reported = HOST_REPORTED.load(Ordering::SeqCst);
    (reported > MAX_PROCESSORS).then_some(reported)
}

/// The raw CPU-affinity mask for `count` processors: CPUs `0..count`, as the
/// little-endian kernel word Linux's `sched_getaffinity` writes.
pub fn affinity_mask(count: u32) -> [u8; SCHED_AFFINITY_MASK_SIZE as usize] {
    let bits = if count >= MAX_PROCESSORS {
        u32::MAX
    } else {
        (1u32 << count) - 1
    };
    bits.to_le_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_count_refuses_zero_and_caps_at_the_mask_width() {
        assert_eq!(effective_count(0), Err(Errno::EINVAL));
        assert_eq!(effective_count(1), Ok(1));
        assert_eq!(effective_count(14), Ok(14));
        assert_eq!(effective_count(32), Ok(32));
        assert_eq!(effective_count(33), Ok(32));
        assert_eq!(effective_count(u32::MAX), Ok(32));
    }

    // The only test that configures the process-global count; others read
    // `count()` or accept both states (the boot-record test in `rootfs`).
    #[test]
    fn configure_sets_the_count_once() {
        assert_eq!(configure(0), Err(Errno::EINVAL));
        assert_eq!(host_count_beyond_max(), None);
        assert_eq!(configure(40), Ok(MAX_PROCESSORS));
        assert_eq!(count(), MAX_PROCESSORS);
        assert_eq!(host_count_beyond_max(), Some(40));
        assert_eq!(configure(4), Err(Errno::EBUSY));
        assert_eq!(count(), MAX_PROCESSORS);
        assert_eq!(host_count_beyond_max(), Some(40));
    }

    #[test]
    fn affinity_mask_sets_one_bit_per_processor() {
        assert_eq!(affinity_mask(1), [1, 0, 0, 0]);
        assert_eq!(affinity_mask(4), [0x0f, 0, 0, 0]);
        assert_eq!(affinity_mask(14), [0xff, 0x3f, 0, 0]);
        assert_eq!(affinity_mask(32), [0xff; 4]);
        for count in 1..=MAX_PROCESSORS {
            let ones: u32 = affinity_mask(count).iter().map(|b| b.count_ones()).sum();
            assert_eq!(ones, count);
        }
    }
}
