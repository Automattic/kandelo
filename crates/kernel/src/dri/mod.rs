//! DRI v2 — buffer (GBM) and KMS support for `/dev/dri/*`.
//!
//! v1 of this module covers the buffer-sharing surface only: bo
//! allocation, mmap binding, prime-fd export/import. The multiplexer
//! and KMS card0 surfaces land in later plans (3 and 4) under their
//! own submodules.

pub mod bo;
pub mod master;

pub use bo::{BoId, BoRegistry, GbmBo, PrimeCookie, with_registry};

use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};

static VBLANK_SEQ: AtomicU32 = AtomicU32::new(0);

pub fn vblank_tick() -> u32 {
    VBLANK_SEQ.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
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
