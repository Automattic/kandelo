//! DRI v2 — buffer (GBM) and KMS support for `/dev/dri/*`.
//!
//! v1 of this module covers the buffer-sharing surface only: bo
//! allocation, mmap binding, prime-fd export/import. The multiplexer
//! and KMS card0 surfaces land in later plans (3 and 4) under their
//! own submodules.

pub mod atomic;
pub mod bo;
pub mod cursor;
pub mod edid;
pub mod ioctl_kms;
pub mod kms;
pub mod master;
pub mod modes;

pub use bo::{BoId, BoRegistry, BoTier, GbmBo, PrimeCookie, with_registry};

use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// The one CRTC's vblank counter. 64-bit like Linux's `drm_vblank_count`,
/// so a 32-bit `DRM_IOCTL_WAIT_VBLANK` sequence widens against it.
static VBLANK_SEQ: AtomicU64 = AtomicU64::new(0);
/// CLOCK_MONOTONIC time of the vblank `VBLANK_SEQ` names, packed as
/// `(tv_sec << 32) | tv_usec`; 0 until the first vblank or CRTC enable.
static VBLANK_STAMP: AtomicU64 = AtomicU64::new(0);
/// A vblank tick queued a DRM event or released a `WAIT_VBLANK` waiter, so
/// the host must retry parked callers (see `take_vblank_wake`).
static VBLANK_WAKE: AtomicBool = AtomicBool::new(false);

fn pack_stamp(tv_sec: u32, tv_usec: u32) -> u64 {
    (u64::from(tv_sec) << 32) | u64::from(tv_usec)
}

/// Count one host vblank (the host's present pump, the same cadence that
/// retires page flips) and record its monotonic time.
pub fn vblank_tick(tv_sec: u32, tv_usec: u32) -> u64 {
    let seq = VBLANK_SEQ.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    VBLANK_STAMP.store(pack_stamp(tv_sec, tv_usec), Ordering::Relaxed);
    seq
}

pub fn vblank_count() -> u64 {
    VBLANK_SEQ.load(Ordering::Relaxed)
}

/// `drm_vblank_count_and_time`: the current count and the time of that
/// vblank.
pub fn vblank_count_and_time() -> (u64, u32, u32) {
    let stamp = VBLANK_STAMP.load(Ordering::Relaxed);
    (vblank_count(), (stamp >> 32) as u32, stamp as u32)
}

/// Enabling the CRTC before the pump's first tick still gives the current
/// count a real timestamp, as Linux's `drm_vblank_enable` records one.
pub fn stamp_vblank_if_unset(tv_sec: u32, tv_usec: u32) {
    let _ = VBLANK_STAMP.compare_exchange(
        0, pack_stamp(tv_sec, tv_usec), Ordering::Relaxed, Ordering::Relaxed);
}

/// `widen_32_to_64` from `drm_vblank.c`: the 64-bit sequence nearest `near`
/// whose low 32 bits are `narrow`.
pub fn widen_32_to_64(narrow: u32, near: u64) -> u64 {
    near.wrapping_add(narrow.wrapping_sub(near as u32) as i32 as i64 as u64)
}

/// `vblank_passed` from `drm_vblank.c`.
pub fn vblank_passed(seq: u64, target: u64) -> bool {
    seq.wrapping_sub(target) <= (1 << 23)
}

/// Take (and clear) the "retry parked DRM callers" notification.
pub fn take_vblank_wake() -> bool {
    VBLANK_WAKE.swap(false, Ordering::Relaxed)
}

/// Append one 32-byte `struct drm_event_vblank` (a `DRM_EVENT_VBLANK` or
/// `DRM_EVENT_FLIP_COMPLETE`) stamped with `seq` and its vblank time.
fn write_vblank_event(
    event_ring: &mut alloc::collections::VecDeque<u8>,
    ev_type: u32,
    user_data: u64,
    crtc_id: u32,
    seq: u32,
    tv_sec: u32,
    tv_usec: u32,
) {
    let mut record = [0u8; 32];
    record[0..4].copy_from_slice(&ev_type.to_le_bytes());
    record[4..8].copy_from_slice(&32u32.to_le_bytes());
    record[8..16].copy_from_slice(&user_data.to_le_bytes());
    record[16..20].copy_from_slice(&tv_sec.to_le_bytes());
    record[20..24].copy_from_slice(&tv_usec.to_le_bytes());
    record[24..28].copy_from_slice(&seq.to_le_bytes());
    record[28..32].copy_from_slice(&crtc_id.to_le_bytes());
    event_ring.extend(record.iter());
}

/// Queue a `DRM_EVENT_VBLANK` for an already-passed target, as
/// `drm_queue_vblank_event` sends it at once.
pub fn queue_vblank_event_now(
    kms: &mut crate::ofd::KmsFdState,
    user_data: u64,
    crtc_id: u32,
) -> u32 {
    let (seq, tv_sec, tv_usec) = vblank_count_and_time();
    write_vblank_event(&mut kms.event_ring, wasm_posix_shared::dri::DRM_EVENT_VBLANK,
        user_data, crtc_id, seq as u32, tv_sec, tv_usec);
    seq as u32
}

/// Queue the `DRM_EVENT_FLIP_COMPLETE` of a commit that completed at once
/// (its CRTC is dark after it), stamped with the current count and time,
/// as the helpers send a disabled CRTC's event without waiting.
pub fn queue_flip_event_now(kms: &mut crate::ofd::KmsFdState, user_data: u64, crtc_id: u32) {
    let (seq, tv_sec, tv_usec) = vblank_count_and_time();
    write_vblank_event(&mut kms.event_ring, wasm_posix_shared::dri::DRM_EVENT_FLIP_COMPLETE,
        user_data, crtc_id, seq as u32, tv_sec, tv_usec);
}

/// Retire everything one vblank completes on one process's card0 files:
/// every pending page flip (a `DRM_EVENT_FLIP_COMPLETE` only for flips
/// that asked for one), every `DRM_VBLANK_EVENT` whose target has passed,
/// and report whether any parked `WAIT_VBLANK` caller can now finish.
///
/// Exposed at process granularity so kernel unit tests can drive the
/// drain against a locally-constructed `Process` without going through
/// the global process table. A file shared by several processes is
/// visited once per holder; the second visit finds nothing left to retire.
pub fn retire_vblank_for_process(
    proc: &mut crate::process::Process,
    seq: u64,
    tv_sec: u32,
    tv_usec: u32,
) -> bool {
    use wasm_posix_shared::dri::{DRM_EVENT_FLIP_COMPLETE, DRM_EVENT_VBLANK};
    let mut wake = false;
    for (_idx, ofd) in proc.ofd_table.iter_mut() {
        let id = ofd.ofd_id;
        let Some(mut kms) = ofd.kms_mut() else { continue };
        let kms = &mut *kms;
        let before = kms.event_ring.len();
        // Drain in place: a compositor queues one flip per frame, so the
        // vector keeps its capacity instead of reallocating every vblank.
        for flip in kms.pending_flips.drain(..) {
            write_vblank_event(&mut kms.event_ring, DRM_EVENT_FLIP_COMPLETE,
                flip.user_data, flip.crtc_id, seq as u32, tv_sec, tv_usec);
        }
        let mut waiting = alloc::vec::Vec::new();
        let off = kms::vblank_off_generation();
        for event in core::mem::take(&mut kms.pending_vblank_events) {
            // drm_crtc_vblank_off sends queued events prematurely.
            if vblank_passed(seq, event.target) || event.off_generation != off {
                write_vblank_event(&mut kms.event_ring, DRM_EVENT_VBLANK,
                    event.user_data, event.crtc_id, seq as u32, tv_sec, tv_usec);
            } else {
                waiting.push(event);
            }
        }
        kms.pending_vblank_events = waiting;
        if kms.event_ring.len() != before {
            wake = true;
            crate::epoll::notify(crate::epoll::Source::Description(id), 0x41);
        }
        wake |= kms.vblank_waits.iter()
            .any(|wait| vblank_passed(seq, wait.target) || wait.off_generation != off);
    }
    wake
}

/// One host vblank: advance the counter, complete the CRTC's pending flip,
/// and retire every card0 file's flips, vblank events and waiters. Called
/// from `kernel_vblank` on each tick of the host's present pump, so
/// `drmModePageFlip → poll → drmHandleEvent` and `drmWaitVBlank` both run
/// at the real refresh cadence on every host.
pub fn retire_vblank(tv_sec: u32, tv_usec: u32) -> u64 {
    let mut seq = 0;
    crate::process_table::with_processes(|procs| {
        seq = retire_vblank_over(procs, tv_sec, tv_usec);
    });
    seq
}

/// [`retire_vblank`] over an explicit set of processes (kernel unit tests
/// drive locally constructed processes through the same path).
pub fn retire_vblank_over<'a>(
    procs: impl IntoIterator<Item = &'a mut crate::process::Process>,
    tv_sec: u32,
    tv_usec: u32,
) -> u64 {
    let seq = vblank_tick(tv_sec, tv_usec);
    // A completed commit releases callers parked on it: blocking atomic
    // commits waiting for their own flip or for the previous one.
    let mut wake = kms::complete_pending_flip();
    for proc in procs {
        wake |= retire_vblank_for_process(proc, seq, tv_sec, tv_usec);
    }
    if wake {
        VBLANK_WAKE.store(true, Ordering::Relaxed);
    }
    seq
}

/// A handler signal interrupts `tid`'s parked `WAIT_VBLANK` (the host
/// completes it with EINTR); forget its resolved target so a later call is
/// never mistaken for the interrupted one.
pub fn forget_vblank_waits(proc: &mut crate::process::Process, tid: u32) {
    let pid = proc.pid;
    for (_idx, ofd) in proc.ofd_table.iter_mut() {
        if let Some(mut kms) = ofd.kms_mut() {
            kms.vblank_waits.retain(|wait| wait.pid != pid || wait.tid != tid);
        }
    }
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
    fn vblank_tick_increments_by_one_and_records_its_time() {
        // Every test that ticks the device counter holds the KMS lock.
        let _kms = master::lock_for_test();
        let before = VBLANK_SEQ.load(Ordering::Relaxed);
        assert_eq!(vblank_tick(5, 6), before.wrapping_add(1));
        assert_eq!(vblank_tick(7, 8), before.wrapping_add(2));
        let (_, sec, usec) = vblank_count_and_time();
        assert!(vblank_count() >= before + 2);
        // Other tests may tick concurrently; the stamp is one of theirs or ours.
        assert!(sec != 0 || usec != 0);
    }

    #[test]
    fn sequence_widening_and_passing_follow_drm_vblank() {
        assert_eq!(widen_32_to_64(5, 3), 5);
        assert_eq!(widen_32_to_64(u32::MAX, 1u64 << 32), (1u64 << 32) - 1);
        assert_eq!(widen_32_to_64(1, (1u64 << 32) - 2), (1u64 << 32) + 1);
        assert!(vblank_passed(10, 10));
        assert!(vblank_passed(11, 10));
        assert!(!vblank_passed(9, 10));
        assert!(!vblank_passed(10 + (1 << 23) + 1, 10));
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
