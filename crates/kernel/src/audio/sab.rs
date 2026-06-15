//! Host-provided SharedArrayBuffer registry for ALSA PCM data rings.
//!
//! Each `/dev/snd/pcmC0D0p` opens against a numbered PCM (`pcm_id`).
//! Before any [`crate::audio::pcm_ioctl::handle_alsa_pcm_ioctl`] data
//! call can succeed, the host must hand the kernel a pointer to the
//! SAB-backed ring for that PCM via the `kernel_audio_init_sab` export
//! ([`crate::wasm_api`]).
//!
//! The ring is shared with the AudioWorklet on the host side; the
//! synchronisation protocol is alsa-lib's lock-free
//! producer/consumer (`mmap_status->hw_ptr` consumed by the host,
//! `mmap_control->appl_ptr` produced by userspace via `WRITEI` or by
//! direct mmap writes). This module is just the address book —
//! `(pcm_id) → (base, len)`.
//!
//! v1 ships at most four PCMs (`pcmC0D0p..pcmC0D3p`); the table is a
//! fixed `[Option<SabSlice>; 4]` so registration is O(1) and the
//! kernel never allocates.

use core::cell::UnsafeCell;

use wasm_posix_shared::Errno;

/// Address book entry for one PCM's SAB-backed data ring.
#[derive(Clone, Copy, Debug)]
pub struct SabSlice {
    /// Base byte address into the kernel-visible linear memory window
    /// the host imported for this SAB. The kernel treats it as a raw
    /// `&mut [i16]` view via [`ring_mut_s16`]; cross-process
    /// synchronisation is the caller's responsibility (alsa-lib's
    /// hw_ptr/appl_ptr pair).
    pub base: usize,
    /// Length of the ring in bytes (must be a multiple of
    /// `channels * sizeof(i16)`).
    pub len: usize,
}

const MAX_PCMS: usize = 4;

struct GlobalSabTable(UnsafeCell<[Option<SabSlice>; MAX_PCMS]>);

// SAFETY: the centralized kernel processes one syscall at a time
// from the JS event loop; concurrent mutation is impossible at
// runtime. Cargo tests serialize via [`TEST_SAB_LOCK`].
unsafe impl Sync for GlobalSabTable {}

static SAB_TABLE: GlobalSabTable = GlobalSabTable(UnsafeCell::new([None; MAX_PCMS]));

fn with_table<R>(f: impl FnOnce(&mut [Option<SabSlice>; MAX_PCMS]) -> R) -> R {
    f(unsafe { &mut *SAB_TABLE.0.get() })
}

/// Bind `pcm_id` to a SAB slice. Re-registering an already-bound
/// `pcm_id` returns `EBUSY` — the second `kernel_audio_init_sab`
/// from the host is a no-op rather than a silent re-map.
pub fn register(pcm_id: u32, slice: SabSlice) -> Result<(), Errno> {
    let idx = pcm_id as usize;
    if idx >= MAX_PCMS {
        return Err(Errno::EINVAL);
    }
    with_table(|tbl| {
        if tbl[idx].is_some() {
            return Err(Errno::EBUSY);
        }
        tbl[idx] = Some(slice);
        Ok(())
    })
}

pub fn lookup(pcm_id: u32) -> Option<SabSlice> {
    let idx = pcm_id as usize;
    if idx >= MAX_PCMS {
        return None;
    }
    with_table(|tbl| tbl[idx])
}

/// Kernel-side `&mut [i16]` view of the PCM ring. Unsafe because the
/// host's AudioWorklet mutates the same memory concurrently;
/// callers respect alsa-lib's `hw_ptr` / `appl_ptr` protocol.
///
/// Returns `None` when no SAB has been registered for `pcm_id`.
///
/// # Safety
///
/// The host MUST have called `kernel_audio_init_sab(pcm_id, base, len)`
/// with a `base..base+len` range that is valid for the kernel's
/// lifetime and is the same memory the AudioWorklet draws from.
pub unsafe fn ring_mut_s16(pcm_id: u32) -> Option<&'static mut [i16]> {
    let SabSlice { base, len } = lookup(pcm_id)?;
    Some(unsafe {
        core::slice::from_raw_parts_mut(
            base as *mut i16,
            len / core::mem::size_of::<i16>(),
        )
    })
}

/// Serializes cargo tests that touch the global SAB table. Same
/// pattern as `dri::bo::TEST_REGISTRY_LOCK`. Public-in-test only.
#[cfg(test)]
pub static TEST_SAB_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn reset_table() {
    with_table(|tbl| {
        for slot in tbl.iter_mut() {
            *slot = None;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_SAB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_table();
        g
    }

    #[test]
    fn register_then_lookup_round_trips() {
        let _g = fresh();
        register(2, SabSlice { base: 0x1000, len: 8192 }).expect("register");
        let s = lookup(2).expect("lookup");
        assert_eq!(s.base, 0x1000);
        assert_eq!(s.len, 8192);
    }

    #[test]
    fn lookup_returns_none_when_unregistered() {
        let _g = fresh();
        assert!(lookup(0).is_none());
        assert!(lookup(3).is_none());
    }

    #[test]
    fn register_out_of_range_pcm_id_returns_einval() {
        let _g = fresh();
        let err = register(4, SabSlice { base: 0, len: 0 }).expect_err("oob");
        assert_eq!(err, Errno::EINVAL);
    }

    #[test]
    fn double_register_returns_ebusy() {
        let _g = fresh();
        register(0, SabSlice { base: 0x1000, len: 1024 }).expect("first");
        let err = register(0, SabSlice { base: 0x2000, len: 1024 })
            .expect_err("second must EBUSY");
        assert_eq!(err, Errno::EBUSY);
        // The original entry survives.
        assert_eq!(lookup(0).unwrap().base, 0x1000);
    }

    #[test]
    fn lookup_out_of_range_returns_none() {
        let _g = fresh();
        assert!(lookup(MAX_PCMS as u32).is_none());
        assert!(lookup(u32::MAX).is_none());
    }
}
