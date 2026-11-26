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

use core::cell::UnsafeCell;
use wasm_posix_shared::Errno;

/// Global, monotonic bo id. Never reused; freed bos leave a tombstone
/// gap so a leaked prime-fd cookie cannot resurrect a different bo.
pub type BoId = u32;

/// Cookie for prime-fd capability check. A bo's cookie is set at first
/// `prime_handle_to_fd` and stays for the bo's lifetime; an importer
/// that doesn't match it gets `EACCES`.
pub type PrimeCookie = u64;

/// Storage tier of a bo. `CpuShared` bos (`MODE_CREATE_DUMB`) are backed
/// by a host SAB, LINEAR and CPU-mmap'able. `GpuTexture` bos
/// (`WPK_CREATE_GPU_BO`, PR10) are backed by a host `WebGLTexture` on the
/// shared multiplexer context — unmappable on the CPU side; the compositor
/// samples them and their producer renders into an FBO whose color
/// attachment IS the texture (zero-copy dmabuf semantics).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoTier {
    CpuShared,
    GpuTexture,
}

#[derive(Debug, Clone)]
pub struct GbmBo {
    pub id: BoId,
    pub width: u32,
    pub height: u32,
    pub bpp: u32,
    pub stride: u32,
    pub size: u64,
    pub refcount: u32,
    pub prime_cookie: Option<PrimeCookie>,
    pub tier: BoTier,
    /// The DRM fourcc a GPU-tier bo's texture storage holds (from
    /// `WPK_CREATE_GPU_BO` or an exported image's internal format); 0 for a
    /// CPU-tier bo, whose bytes any format may describe, or an exported
    /// image no DRM format describes.
    pub format: u32,
    /// The buffer's implicit fences (`dma_buf.resv`), set and read through
    /// `DMA_BUF_IOCTL_{IMPORT,EXPORT}_SYNC_FILE` and observed by dma-buf
    /// `poll`. They live and die with the buffer.
    pub reservation: crate::dri::fence::Reservation,
    /// CPU storage affiliation is permanent after its first committed map.
    /// Ordinary mirrored mappings cannot coexist with direct group aliases.
    group_storage: Option<GroupStorage>,
    ordinary_storage: bool,
}

#[derive(Debug, Clone)]
struct GroupStorage {
    object: crate::memory::GroupSharedMapping,
    committed: bool,
}

impl crate::prepared_map::MapMemory for GbmBo {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

pub struct BoRegistry {
    next_id: BoId,
    next_cookie: PrimeCookie,
    map: crate::PreparedMap<BoId, GbmBo>,
}

impl BoRegistry {
    const fn new() -> Self {
        Self {
            next_id: 1,
            next_cookie: 1,
            map: crate::PreparedMap::new(),
        }
    }

    pub fn try_alloc(&mut self, width: u32, height: u32, bpp: u32) -> Result<&mut GbmBo, Errno> {
        self.try_alloc_tier(width, height, bpp, BoTier::CpuShared)
    }

    /// Allocate a GPU-tier bo (`WPK_CREATE_GPU_BO`). The stride/size are
    /// still computed for the LINEAR-equivalent layout so `gbm_bo_get_stride`
    /// returns a sensible value, but the bo carries no CPU-side SAB and
    /// cannot be `mmap`'d — the host backs it with a `WebGLTexture`.
    pub fn try_alloc_gpu(&mut self, width: u32, height: u32, bpp: u32) -> Result<&mut GbmBo, Errno> {
        self.try_alloc_tier(width, height, bpp, BoTier::GpuTexture)
    }

    fn try_alloc_tier(&mut self, width: u32, height: u32, bpp: u32, tier: BoTier) -> Result<&mut GbmBo, Errno> {
        let id = self.next_id;
        // Stride rounded up to a 4-byte boundary so every row is
        // u32-aligned (matches Mesa's `gbm_bo_get_stride` for the
        // equivalent dumb buffer).
        let bits_per_row = width.checked_mul(bpp).ok_or(Errno::EINVAL)?;
        let bytes_per_row = bits_per_row.checked_add(7).ok_or(Errno::EINVAL)? / 8;
        let stride = bytes_per_row.checked_add(3).ok_or(Errno::EINVAL)? & !3;
        let size = (stride as u64).checked_mul(height as u64).ok_or(Errno::EINVAL)?;
        let next_id = self.next_id.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let bo = GbmBo {
            id,
            width,
            height,
            bpp,
            stride,
            size,
            refcount: 1,
            prime_cookie: None,
            tier,
            format: 0,
            reservation: Default::default(),
            group_storage: None,
            ordinary_storage: false,
        };
        let prepared = self.map.prepare_io(id, bo)?;
        self.next_id = next_id;
        self.map.publish_io(prepared);
        Ok(self.map.get_mut(&id).unwrap())
    }

    /// Set the extent and pixel size of a GPU-tier bo whose storage is
    /// decided by the host after allocation (an exported GLES image). The
    /// LINEAR-equivalent stride/size follow the same arithmetic as
    /// allocation.
    pub fn set_gpu_extent(&mut self, id: BoId, width: u32, height: u32, bpp: u32, format: u32) -> Option<()> {
        let bo = self.map.get_mut(&id)?;
        if bo.tier != BoTier::GpuTexture || bpp == 0 { return None; }
        bo.format = format;
        let bytes_per_row = width.checked_mul(bpp)?.checked_add(7)? / 8;
        let stride = bytes_per_row.checked_add(3)? & !3;
        let size = (stride as u64).checked_mul(height as u64)?;
        bo.width = width; bo.height = height; bo.bpp = bpp; bo.stride = stride; bo.size = size;
        Some(())
    }

    #[cfg(test)]
    pub fn alloc(&mut self, width: u32, height: u32, bpp: u32) -> &mut GbmBo {
        self.try_alloc(width, height, bpp)
            .expect("GBM bo dimensions must fit in registry arithmetic")
    }

    pub fn get(&self, id: BoId) -> Option<&GbmBo> {
        self.map.get(&id)
    }

    pub fn get_mut(&mut self, id: BoId) -> Option<&mut GbmBo> {
        self.map.get_mut(&id)
    }

    pub(crate) fn prepare_group_storage(&mut self, bo: BoId, group: u32, id: u64)
        -> Result<crate::memory::GroupSharedMapping, Errno> {
        let bo = self.map.get_mut(&bo).ok_or(Errno::EBADF)?;
        if bo.tier != BoTier::CpuShared || bo.ordinary_storage { return Err(Errno::EOPNOTSUPP); }
        // An abandoned constructor cannot leave an affiliation behind after
        // its last VMA capability disappears (including exec/destroy cleanup).
        if bo.group_storage.as_ref().is_some_and(|s| !s.committed && s.object.only_inode_hold()) {
            bo.group_storage = None;
        }
        if let Some(storage) = &bo.group_storage {
            if storage.object.group() != group { return Err(Errno::EACCES); }
            if !storage.committed { return Err(Errno::EBUSY); }
            return Ok(storage.object.clone());
        }
        let length = usize::try_from(bo.size.checked_add(65535).ok_or(Errno::ENOMEM)? & !65535)
            .map_err(|_| Errno::ENOMEM)?;
        let object = crate::memory::GroupSharedMapping::new(group, id, length)?;
        bo.group_storage = Some(GroupStorage { object: object.clone(), committed: false });
        Ok(object)
    }

    pub(crate) fn commit_group_storage(&mut self, bo: BoId, id: u64) -> Result<(), Errno> {
        let storage = self.map.get_mut(&bo).and_then(|b| b.group_storage.as_mut())
            .filter(|s| s.object.id() == id).ok_or(Errno::ESRCH)?;
        storage.committed = true;
        Ok(())
    }

    pub(crate) fn cancel_group_storage(&mut self, bo: BoId, id: u64) {
        if let Some(bo) = self.map.get_mut(&bo) {
            if bo.group_storage.as_ref().is_some_and(|s| s.object.id() == id && !s.committed) {
                bo.group_storage = None;
            }
        }
    }

    pub(crate) fn ordinary_storage_allowed(&mut self, bo: BoId) -> bool {
        let Some(bo) = self.map.get_mut(&bo) else { return false; };
        if bo.group_storage.as_ref().is_some_and(|s| !s.committed && s.object.only_inode_hold()) {
            bo.group_storage = None;
        }
        bo.group_storage.is_none()
    }

    pub(crate) fn mark_ordinary_storage(&mut self, bo: BoId) {
        self.map.get_mut(&bo).expect("retained mapped BO").ordinary_storage = true;
    }

    pub fn group_storage_alive(&self, group: u32, id: u64) -> bool {
        self.map.values().any(|bo| bo.group_storage.as_ref().is_some_and(|s|
            s.object.group() == group && s.object.id() == id && (s.committed || !s.object.only_inode_hold())))
    }

    pub(crate) fn group_storage(&self, bo: BoId) -> Option<&crate::memory::GroupSharedMapping> {
        self.map.get(&bo)?.group_storage.as_ref().filter(|s| s.committed).map(|s| &s.object)
    }
    pub fn group_storage_binding(&self, bo: BoId) -> Option<crate::memory::GroupSharedMapping> {
        self.group_storage(bo).cloned()
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
pub fn reset_registry() {
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
pub fn next_id_for_test() -> BoId {
    with_registry(|r| r.next_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grouped_cpu_storage_requires_one_committed_affiliation_and_preserves_padding() {
        let mut registry = BoRegistry::new();
        let bo = registry.alloc(4, 4, 32).id;
        let first = registry.prepare_group_storage(bo, 1, 101).unwrap();
        assert_eq!(first.length(), 65536);
        assert_eq!(registry.prepare_group_storage(bo, 1, 102), Err(Errno::EBUSY));
        assert_eq!(registry.prepare_group_storage(bo, 2, 102), Err(Errno::EACCES));
        assert_eq!(registry.commit_group_storage(bo, 100), Err(Errno::ESRCH));
        assert!(!registry.ordinary_storage_allowed(bo));
        registry.commit_group_storage(bo, 101).unwrap();
        let alias = registry.prepare_group_storage(bo, 1, 103).unwrap();
        assert_eq!(first, alias);
        assert_eq!(registry.prepare_group_storage(bo, 2, 104), Err(Errno::EACCES));
        registry.cancel_group_storage(bo, 101);
        assert!(registry.group_storage_alive(1, 101));
        assert_eq!(registry.decref(bo), Some(0));
        assert!(!registry.group_storage_alive(1, 101));
        assert_eq!(alias.id(), 101);
    }

    #[test]
    fn abandoned_grouped_cpu_constructor_can_reaffiliate_but_committed_ordinary_cannot() {
        let mut registry = BoRegistry::new();
        let bo = registry.alloc(4, 4, 32).id;
        let first = registry.prepare_group_storage(bo, 1, 201).unwrap();
        assert!(registry.group_storage_alive(1, 201));
        drop(first);
        assert!(!registry.group_storage_alive(1, 201));
        assert!(registry.ordinary_storage_allowed(bo));
        let next = registry.prepare_group_storage(bo, 2, 202).unwrap();
        assert_eq!((next.group(), next.id()), (2, 202));
        registry.cancel_group_storage(bo, 202);
        assert!(registry.ordinary_storage_allowed(bo));
        registry.mark_ordinary_storage(bo);
        assert_eq!(registry.prepare_group_storage(bo, 2, 203), Err(Errno::EOPNOTSUPP));
        let gpu = registry.try_alloc_gpu(4, 4, 32).unwrap().id;
        assert_eq!(registry.prepare_group_storage(gpu, 2, 204), Err(Errno::EOPNOTSUPP));
    }


    #[test]
    fn registry_admission_preserves_identity_and_releases_metadata() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut registry = BoRegistry::new();
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert!(matches!(registry.try_alloc(8, 8, 32), Err(Errno::ENOMEM)));
            assert!(matches!(registry.try_alloc_gpu(8, 8, 32), Err(Errno::ENOMEM)));
        }
        assert_eq!(registry.next_id, 1);
        assert!(registry.map.is_empty());
        let first = registry.try_alloc(8, 8, 32).unwrap().id;
        let second = registry.try_alloc_gpu(8, 8, 32).unwrap().id;
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        assert!(held > baseline);
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert!(matches!(registry.try_alloc(8, 8, 32), Err(Errno::ENOMEM)));
            assert_eq!(registry.next_id, second + 1);
            assert_eq!(registry.incref(first), Some(2));
            assert_eq!(registry.decref(first), Some(1));
            assert_eq!(registry.decref(first), Some(0));
            assert_eq!(registry.decref(second), Some(0));
        }
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

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
            assert_eq!((bo2.width, bo2.height), (17, 1));
            let id2 = bo2.id;
            r.decref(id2);
        });
    }

    #[test]
    fn try_alloc_rejects_overflow_without_consuming_id() {
        let _g = fresh();
        with_registry(|r| {
            let before = r.next_id;
            assert!(r.try_alloc(u32::MAX, 1, 32).is_err());
            assert_eq!(r.next_id, before);
            assert!(r.try_alloc(64, 64, 32).is_ok());
            assert_eq!(r.next_id, before + 1);
        });
    }

    #[test]
    fn alloc_defaults_to_cpu_tier() {
        let _g = fresh();
        with_registry(|r| {
            let bo = r.alloc(64, 64, 32);
            assert_eq!(bo.tier, BoTier::CpuShared);
            let id = bo.id;
            r.decref(id);
        });
    }

    #[test]
    fn alloc_gpu_marks_gpu_tier_and_keeps_stride() {
        let _g = fresh();
        with_registry(|r| {
            // GPU-tier bos still compute a LINEAR-equivalent stride/size
            // so gbm_bo_get_stride returns a sane value.
            let bo = r.try_alloc_gpu(17, 3, 32).unwrap();
            assert_eq!(bo.tier, BoTier::GpuTexture);
            assert_eq!(bo.stride, 68);
            assert_eq!(bo.size, 68 * 3);
            let id = bo.id;
            r.decref(id);
        });
    }

    #[test]
    fn gpu_and_cpu_bos_share_the_id_space() {
        let _g = fresh();
        with_registry(|r| {
            let a = r.alloc(64, 64, 32).id;
            let b = r.try_alloc_gpu(64, 64, 32).unwrap().id;
            assert!(b > a, "gpu bo draws the next monotonic id");
            r.decref(a);
            r.decref(b);
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
