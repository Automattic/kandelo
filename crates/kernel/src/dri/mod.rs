//! DRI v2 — buffer (GBM) and KMS support for `/dev/dri/*`.
//!
//! v1 of this module covers the buffer-sharing surface only: bo
//! allocation, mmap binding, prime-fd export/import. The multiplexer
//! and KMS card0 surfaces land in later plans (3 and 4) under their
//! own submodules.

pub mod bo;
pub mod master;

pub use bo::{BoId, BoRegistry, BoTier, GbmBo, PrimeCookie, with_registry};

use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};

static VBLANK_SEQ: AtomicU32 = AtomicU32::new(0);

/// Bump the global vblank sequence counter and return the new value.
///
/// Called from `kernel_vblank` (the host's 60 Hz pump) and from kernel
/// unit tests that want to simulate one vblank tick. `WAIT_VBLANK`
/// reads the counter on the next syscall round-trip so user programs
/// observe the new sequence.
pub fn vblank_tick() -> u32 {
    VBLANK_SEQ.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
}

/// Append one 32-byte `DRM_EVENT_FLIP_COMPLETE` record for the given
/// `flip` to `event_ring`, stamped with `seq` and the host's monotonic
/// time. Shared between the per-process drain and any future caller
/// that wants to synthesize a flip-complete event in tests.
fn write_flip_complete_event(
    event_ring: &mut alloc::collections::VecDeque<u8>,
    flip: &crate::ofd::PendingFlip,
    seq: u32,
    tv_sec: u32,
    tv_usec: u32,
) {
    let mut record = [0u8; 32];
    record[0..4].copy_from_slice(&2u32.to_le_bytes()); // DRM_EVENT_FLIP_COMPLETE
    record[4..8].copy_from_slice(&32u32.to_le_bytes());
    record[8..16].copy_from_slice(&flip.user_data.to_le_bytes());
    record[16..20].copy_from_slice(&tv_sec.to_le_bytes());
    record[20..24].copy_from_slice(&tv_usec.to_le_bytes());
    record[24..28].copy_from_slice(&seq.to_le_bytes());
    record[28..32].copy_from_slice(&flip.crtc_id.to_le_bytes());
    event_ring.extend(record.iter());
}

/// Drain every queued page flip on one process's open card0 fds into
/// each fd's `event_ring` as `DRM_EVENT_FLIP_COMPLETE` records.
///
/// Exposed at process granularity so kernel unit tests can drive the
/// drain against a locally-constructed `Process` without going through
/// the global process table.
pub fn drain_pending_flips_for_process(
    proc: &mut crate::process::Process,
    seq: u32,
    tv_sec: u32,
    tv_usec: u32,
) {
    for (_idx, ofd) in proc.ofd_table.iter_mut() {
        let Some(kms) = ofd.kms_mut() else { continue };
        if kms.pending_flips.is_empty() {
            continue;
        }
        // `pending_flips` and `event_ring` share the same `&mut kms`
        // borrow; take the flips first so iterating them doesn't hold
        // a live borrow on the queue while we write the ring.
        let flips = core::mem::take(&mut kms.pending_flips);
        for flip in &flips {
            write_flip_complete_event(&mut kms.event_ring, flip, seq, tv_sec, tv_usec);
        }
    }
}

/// Walk every live process and drain any queued page flips into the
/// per-fd `event_ring`s at vblank cadence. Called from `kernel_vblank`
/// on every host vblank tick (16.67 ms). Pushing the gate down here
/// means `drmModePageFlip → poll → drmHandleEvent` returns at real
/// monitor-refresh rate, not at ioctl rate.
pub fn drain_pending_flips(seq: u32, tv_sec: u32, tv_usec: u32) {
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            drain_pending_flips_for_process(proc, seq, tv_sec, tv_usec);
        }
    });
}

// crtc_id=1 is the only crtc the KMS surface supports today
// (DRM_IOCTL_MODE_SETCRTC and PAGE_FLIP both reject anything else with
// ENOENT). Keep stats in a flat per-crtc statics block rather than a
// map so the lookup is zero-cost from the hot path.
static KMS_CRTC1_COMMITS: AtomicU64 = AtomicU64::new(0);
static KMS_CRTC1_LAST_FLIP_US: AtomicU64 = AtomicU64::new(0);
static KMS_CRTC1_LAST_FRAME_US: AtomicU64 = AtomicU64::new(0);

/// Record a successful DRM_IOCTL_MODE_PAGE_FLIP queue: bump the
/// commit counter, then store the gap since the previous flip so the
/// host can poll a real wasm-side frame rate independent of the
/// 60 Hz vblank pump.
pub fn record_kms_commit(crtc_id: u32, now_us: u64) {
    if crtc_id != 1 { return; }
    let prev = KMS_CRTC1_LAST_FLIP_US.swap(now_us, Ordering::Relaxed);
    if prev != 0 && now_us > prev {
        KMS_CRTC1_LAST_FRAME_US.store(now_us - prev, Ordering::Relaxed);
    }
    KMS_CRTC1_COMMITS.fetch_add(1, Ordering::Relaxed);
}

pub fn kms_commit_count(crtc_id: u32) -> u64 {
    if crtc_id != 1 { return 0; }
    KMS_CRTC1_COMMITS.load(Ordering::Relaxed)
}

pub fn kms_last_frame_us(crtc_id: u32) -> u64 {
    if crtc_id != 1 { return 0; }
    KMS_CRTC1_LAST_FRAME_US.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vblank_tick_increments_by_one() {
        let before = VBLANK_SEQ.load(Ordering::Relaxed);
        assert_eq!(vblank_tick(), before.wrapping_add(1));
        assert_eq!(vblank_tick(), before.wrapping_add(2));
    }

    #[test]
    fn record_kms_commit_bumps_counter_and_tracks_frame_us() {
        let before = kms_commit_count(1);
        record_kms_commit(1, 1_000_000);
        assert_eq!(kms_commit_count(1), before + 1);
        record_kms_commit(1, 1_016_667);
        assert_eq!(kms_commit_count(1), before + 2);
        assert_eq!(kms_last_frame_us(1), 16_667);
    }

    #[test]
    fn record_kms_commit_ignores_other_crtcs() {
        let before = kms_commit_count(1);
        record_kms_commit(2, 9_999);
        assert_eq!(kms_commit_count(1), before);
        assert_eq!(kms_commit_count(2), 0);
    }
}
