//! GBM buffer-object registry: a single global `BoRegistry` owns every
//! live bo across processes. Per-process state (the GEM-handle → BoId
//! map) lives on `Process::dri_handles` and is wired in Task A3. The
//! bo registry here is the source of truth for refcount + backing.
//!
//! Cross-process semantics (full picture; v1 wires `CpuShared` only):
//! - `gbm_bo_create` (CREATE_DUMB) bumps a fresh `BoId`, refcount = 1,
//!   inserts the bo, returns a process-local handle pointing at it.
//! - `prime_handle_to_fd` allocates a new `OpenFileKind::PrimeBo`
//!   carrying `(BoId, cookie)`; refcount += 1.
//! - `prime_fd_to_handle` on a PrimeBo OFD bumps refcount and inserts
//!   another process-local handle mapping. The receiver can `mmap`
//!   the bo through this handle just like the creator.
//! - `gem_close` (or implicit close of the last process-local handle
//!   for a bo) decrements refcount. Refcount-to-zero frees the
//!   underlying host SAB.

extern crate alloc;

use alloc::collections::BTreeMap;
use core::cell::UnsafeCell;

/// Global, monotonic bo id. Never reused; freed bos leave a tombstone
/// gap so a leaked prime-fd cookie cannot resurrect a different bo.
pub type BoId = u32;

/// Cookie for prime-fd capability check. A bo's cookie is set at first
/// `prime_handle_to_fd` and stays for the bo's lifetime; an importer
/// that doesn't match it gets `EACCES`.
pub type PrimeCookie = u64;

#[derive(Debug, Clone)]
pub struct GbmBo {
    pub id: BoId,
    pub stride: u32,
    pub size: u64,
    pub refcount: u32,
    pub prime_cookie: Option<PrimeCookie>,
}

pub struct BoRegistry {
    next_id: BoId,
    next_cookie: PrimeCookie,
    map: BTreeMap<BoId, GbmBo>,
}

impl BoRegistry {
    const fn new() -> Self {
        Self {
            next_id: 1,
            next_cookie: 1,
            map: BTreeMap::new(),
        }
    }

    pub fn try_alloc(&mut self, width: u32, height: u32, bpp: u32) -> Option<&mut GbmBo> {
        let id = self.next_id;
        // Stride rounded up to a 4-byte boundary so every row is
        // u32-aligned (matches Mesa's `gbm_bo_get_stride` for the
        // equivalent dumb buffer).
        let bits_per_row = width.checked_mul(bpp)?;
        let bytes_per_row = bits_per_row.checked_add(7)? / 8;
        let stride = bytes_per_row.checked_add(3)? & !3;
        let size = (stride as u64).checked_mul(height as u64)?;
        self.next_id = self.next_id.checked_add(1)?;
        let bo = GbmBo {
            id,
            stride,
            size,
            refcount: 1,
            prime_cookie: None,
        };
        self.map.insert(id, bo);
        Some(self.map.get_mut(&id).unwrap())
    }

    pub fn alloc(&mut self, width: u32, height: u32, bpp: u32) -> &mut GbmBo {
        self.try_alloc(width, height, bpp)
            .expect("GBM bo dimensions must fit in registry arithmetic")
    }

    pub fn get(&self, id: BoId) -> Option<&GbmBo> {
        self.map.get(&id)
    }

    pub fn incref(&mut self, id: BoId) -> Option<u32> {
        let bo = self.map.get_mut(&id)?;
        bo.refcount = bo.refcount.checked_add(1)?;
        Some(bo.refcount)
    }

    /// Returns `Some(new_refcount)`. When `new_refcount` drops to 0,
    /// the caller MUST also call `host_io.gbm_bo_destroy(bo_id)` to
    /// drop the host-side SAB before forgetting the bo.
    pub fn decref(&mut self, id: BoId) -> Option<u32> {
        let bo = self.map.get_mut(&id)?;
        bo.refcount = bo.refcount.saturating_sub(1);
        let rc = bo.refcount;
        if rc == 0 {
            // Tombstone: drop the entry but do not reuse the id.
            self.map.remove(&id);
        }
        Some(rc)
    }

    /// Issues a fresh cookie for the first `PRIME_HANDLE_TO_FD` on
    /// this bo. Idempotent: subsequent exports of the same bo reuse
    /// the existing cookie (Linux-shape).
    pub fn ensure_prime_cookie(&mut self, id: BoId) -> Option<PrimeCookie> {
        let bo = self.map.get_mut(&id)?;
        if let Some(c) = bo.prime_cookie {
            return Some(c);
        }
        let c = self.next_cookie;
        self.next_cookie = self.next_cookie.wrapping_add(1);
        bo.prime_cookie = Some(c);
        Some(c)
    }
}

/// Wrapper for static global storage. Same idiom as
/// `process_table::GLOBAL_PROCESS_TABLE`,
/// `unix_socket::UNIX_SOCKET_REGISTRY`, etc.
struct GlobalBoRegistry(UnsafeCell<BoRegistry>);

/// SAFETY: Access is serialized — the centralized kernel services
/// one syscall at a time from the JS event loop (no concurrent Wasm
/// execution). Tests on host serialize via `TEST_REGISTRY_LOCK`.
unsafe impl Sync for GlobalBoRegistry {}

static REGISTRY: GlobalBoRegistry = GlobalBoRegistry(UnsafeCell::new(BoRegistry::new()));

/// Run `f` with a `&mut BoRegistry` borrowed from the global. The
/// kernel is single-threaded over syscalls; tests serialize via
/// `TEST_REGISTRY_LOCK`.
pub fn with_registry<R>(f: impl FnOnce(&mut BoRegistry) -> R) -> R {
    f(unsafe { &mut *REGISTRY.0.get() })
}

/// Serializes cargo tests that touch the global registry. Same
/// pattern as `audio::TEST_RING_LOCK`. Public-in-test only.
#[cfg(test)]
pub static TEST_REGISTRY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn reset_registry() {
    with_registry(|r| {
        r.map.clear();
        r.next_id = 1;
        r.next_cookie = 1;
    });
}

/// Test-only: the id the registry would assign on the next `alloc`
/// call. Used by syscall-layer tests to identify the most recently
/// allocated bo (the id returned via ioctls is a per-fd handle, not
/// the global BoId).
#[cfg(test)]
pub(crate) fn next_id_for_test() -> BoId {
    with_registry(|r| r.next_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_registry();
        g
    }

    #[test]
    fn alloc_assigns_monotonic_ids() {
        let _g = fresh();
        with_registry(|r| {
            let a = r.alloc(64, 64, 32).id;
            let b = r.alloc(64, 64, 32).id;
            assert!(b > a);
        });
    }

    #[test]
    fn decref_to_zero_removes() {
        let _g = fresh();
        with_registry(|r| {
            let id = r.alloc(64, 64, 32).id;
            assert_eq!(r.decref(id), Some(0));
            assert!(r.get(id).is_none());
        });
    }

    #[test]
    fn incref_then_decref_keeps_alive() {
        let _g = fresh();
        with_registry(|r| {
            let id = r.alloc(64, 64, 32).id;
            r.incref(id);
            assert_eq!(r.decref(id), Some(1));
            assert!(r.get(id).is_some());
            r.decref(id);
        });
    }

    #[test]
    fn prime_cookie_is_idempotent() {
        let _g = fresh();
        with_registry(|r| {
            let id = r.alloc(64, 64, 32).id;
            let c1 = r.ensure_prime_cookie(id).unwrap();
            let c2 = r.ensure_prime_cookie(id).unwrap();
            assert_eq!(c1, c2);
            r.decref(id);
        });
    }

    #[test]
    fn distinct_bos_get_distinct_cookies() {
        let _g = fresh();
        with_registry(|r| {
            let a = r.alloc(64, 64, 32).id;
            let b = r.alloc(64, 64, 32).id;
            let ca = r.ensure_prime_cookie(a).unwrap();
            let cb = r.ensure_prime_cookie(b).unwrap();
            assert_ne!(ca, cb);
            r.decref(a);
            r.decref(b);
        });
    }

    #[test]
    fn stride_rounds_up_to_4_bytes() {
        let _g = fresh();
        with_registry(|r| {
            // 17px wide @ 32bpp → naive 68 bytes; already 4-aligned.
            let bo = r.alloc(17, 1, 32);
            assert_eq!(bo.stride, 68);
            let id = bo.id;
            r.decref(id);
            // 17px @ 8bpp → naive 17 bytes; rounds to 20.
            let bo2 = r.alloc(17, 1, 8);
            assert_eq!(bo2.stride, 20);
            let id2 = bo2.id;
            r.decref(id2);
        });
    }

    #[test]
    fn try_alloc_rejects_overflow_without_consuming_id() {
        let _g = fresh();
        with_registry(|r| {
            let before = r.next_id;
            assert!(r.try_alloc(u32::MAX, 1, 32).is_none());
            assert_eq!(r.next_id, before);
            assert!(r.try_alloc(64, 64, 32).is_some());
            assert_eq!(r.next_id, before + 1);
        });
    }

    #[test]
    fn freed_id_is_not_reused() {
        let _g = fresh();
        with_registry(|r| {
            let a = r.alloc(64, 64, 32).id;
            r.decref(a);
            let b = r.alloc(64, 64, 32).id;
            assert_ne!(a, b, "tombstoned id must not be reused");
        });
    }
}
