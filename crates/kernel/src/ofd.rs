extern crate alloc;

use alloc::boxed::Box;
use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use wasm_posix_shared::flags::{O_APPEND, O_NONBLOCK};

// ── Global host handle refcount table ──
//
// Tracks how many processes share each host file handle (host_handle >= 0).
// Handles NOT in this table have an implicit refcount of 1 (single owner).
//
// - fork_process: increments for each inherited host_handle >= 0
// - sys_close: decrements; only calls host_close when the count reaches 0
//
// This prevents fork children from invalidating host file handles that the
// parent (or other children) still use.

struct HostHandleRefs(UnsafeCell<Option<BTreeMap<i64, u32>>>);
unsafe impl Sync for HostHandleRefs {}

static HOST_HANDLE_REFS: HostHandleRefs = HostHandleRefs(UnsafeCell::new(None));

fn get_host_handle_refs() -> &'static mut BTreeMap<i64, u32> {
    let opt = unsafe { &mut *HOST_HANDLE_REFS.0.get() };
    opt.get_or_insert_with(BTreeMap::new)
}

/// Register that a host handle is now shared by one more process (fork).
/// If the handle is being forked for the first time, sets count to 2
/// (parent + child). Otherwise increments by 1.
pub fn host_handle_fork_ref(h: i64) {
    let refs = get_host_handle_refs();
    let count = refs.entry(h).or_insert(1); // 1 = the parent already has it
    *count += 1; // +1 for the child
}

/// Decrement the cross-process refcount for a host handle.
/// Returns `true` if the handle should be closed (refcount reached 0 or
/// the handle was never shared).
pub fn host_handle_close_ref(h: i64) -> bool {
    let refs = get_host_handle_refs();
    if let Some(count) = refs.get_mut(&h) {
        *count -= 1;
        if *count == 0 {
            refs.remove(&h);
            return true;
        }
        return false;
    }
    // Not in the table → single owner, safe to close
    true
}

#[cfg(test)]
pub fn host_handle_ref_count(h: i64) -> u32 {
    get_host_handle_refs().get(&h).copied().unwrap_or(0)
}

/// The set of flags that F_SETFL is allowed to modify (POSIX semantics).
const SETFL_MODIFIABLE: u32 = O_APPEND | O_NONBLOCK;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    Regular,
    Directory,
    Pipe,
    CharDevice,
    Socket,
    EventFd,
    Epoll,
    TimerFd,
    SignalFd,
    MemFd,
    PtyMaster,
    PtySlave,
}

/// Live cmdbuf mapping for a process's GLES2 fd.
///
/// Populated by the GLIO_INIT path and the cmdbuf mmap path. The
/// `submit_seq` counter is bumped by every successful `GLIO_SUBMIT`
/// and is used for host-side debug-ring correlation.
#[derive(Clone, Copy, Debug)]
pub struct CmdbufBinding {
    /// Offset within the process's wasm `Memory`.
    pub addr: usize,
    /// Length in bytes.
    pub len: usize,
    /// Monotonic `GLIO_SUBMIT` counter — used for host-side debug ring
    /// correlation; never read by user space.
    pub submit_seq: u64,
}

/// Per-fd GL state for `/dev/dri/renderD128` handles, hung off
/// [`DriFdState`] below. Each fresh `open()` of renderD128 yields a
/// new `GlState`; `dup` / fork-inherit shares one.
#[derive(Clone, Debug, Default)]
pub struct GlState {
    pub initialized: bool,
    pub context_id: Option<u32>,
    pub surface_id: Option<u32>,
    pub current: bool,
    pub cmdbuf: Option<CmdbufBinding>,
}

/// State for a prime-fd OFD: capability cookie binding fd → bo.
///
/// Set when a `DRM_IOCTL_PRIME_HANDLE_TO_FD` allocates a new
/// `/dev/dri/renderD128`-derived fd. Subsequent
/// `PRIME_FD_TO_HANDLE` on this OFD verifies the cookie matches
/// the bo's recorded `prime_cookie` and bumps the bo's refcount.
#[derive(Clone, Debug)]
pub struct PrimeBoState {
    pub bo_id: crate::dri::BoId,
    pub cookie: crate::dri::PrimeCookie,
}

/// Per-fd state for `/dev/dri/renderD128` opens.
///
/// Multiple fds pointing at the same OFD (`dup`, fork-inherit) share
/// the same `DriFdState`; a fresh `open()` yields a new OFD with
/// `DriFdState::default()`. This matches Linux per-fd handle
/// namespacing.
#[derive(Clone, Debug)]
pub struct DriFdState {
    /// GEM-handle → global `BoId` map for this fd.
    pub handles: BTreeMap<u32, crate::dri::BoId>,
    /// Next handle id to issue on this fd. Linux numbers from 1.
    pub next_handle: u32,
    /// GL session state for this fd's renderD128 handle. `None`
    /// until `GLIO_INIT` succeeds; `Some` until `GLIO_TERMINATE` /
    /// last close / exec.
    pub gl: Option<GlState>,
}

impl Default for DriFdState {
    fn default() -> Self {
        DriFdState {
            handles: BTreeMap::new(),
            next_handle: 1,
            gl: None,
        }
    }
}

/// A KMS framebuffer object — i.e. one slot in the per-fd `fbs` map,
/// keyed by the `fb_id` MODE_ADDFB2 returned.
#[derive(Clone, Copy, Debug)]
pub struct KmsFb {
    pub bo_id: crate::dri::BoId,
    pub width: u32,
    pub height: u32,
    pub pixel_format: u32,
    pub stride: u32,
}

/// A page-flip queued by `DRM_IOCTL_MODE_PAGE_FLIP` and not yet
/// drained as a `DRM_EVENT_FLIP_COMPLETE` to the caller.
#[derive(Clone, Copy, Debug)]
pub struct PendingFlip {
    pub crtc_id: u32,
    pub fb_id: u32,
    pub user_data: u64,
}

/// Per-fd KMS state for `/dev/dri/card0` opens.
#[derive(Clone, Debug, Default)]
pub struct KmsFdState {
    pub holds_master: bool,
    pub fbs: BTreeMap<u32, KmsFb>,
    pub next_fb_id: u32,
    pub pending_flips: Vec<PendingFlip>,
    pub event_ring: VecDeque<u8>,
}

/// DRI sidecar on [`OpenFileDesc::dri_state`]. A card0 OFD needs both
/// a GEM-handle namespace (for `MODE_ADDFB2` lookups against
/// `PRIME_FD_TO_HANDLE`-imported bos) and a KMS scope, so the three
/// DRI fd kinds share a single sum type.
#[derive(Clone, Debug)]
pub enum DriOfdState {
    /// fd allocated by `DRM_IOCTL_PRIME_HANDLE_TO_FD`.
    PrimeBo(PrimeBoState),
    /// fd from `open("/dev/dri/renderD128")`.
    RenderNode(DriFdState),
    /// fd from `open("/dev/dri/card0")`.
    Card { dri: DriFdState, kms: KmsFdState },
}

#[derive(Clone)]
pub struct OpenFileDesc {
    pub file_type: FileType,
    pub status_flags: u32,
    pub host_handle: i64,
    pub offset: i64,
    pub ref_count: u32,
    pub owner_pid: u32,
    pub path: Vec<u8>, // resolved absolute path
    /// Host directory handle for getdents64 iteration (lazily opened).
    /// -1 means not yet opened, -2 means exhausted (EOF).
    pub dir_host_handle: i64,
    /// Synthetic "." / ".." state for getdents64: 0 = emit ".", 1 = emit "..", 2 = host entries
    pub dir_synth_state: u8,
    /// Cumulative entry count across getdents64 calls — used as d_off cookie for seekdir.
    pub dir_entry_offset: i64,
    /// DRI sidecar; see [`DriOfdState`]. Boxed so non-DRI OFDs pay
    /// only one pointer slot.
    pub dri_state: Option<Box<DriOfdState>>,
}

impl OpenFileDesc {
    /// Access the `DriFdState` for renderD128- or card0-backed OFDs.
    /// Returns `None` for prime-bo OFDs and non-DRI fds.
    pub fn dri(&self) -> Option<&DriFdState> {
        match self.dri_state.as_deref()? {
            DriOfdState::RenderNode(d) | DriOfdState::Card { dri: d, .. } => Some(d),
            DriOfdState::PrimeBo(_) => None,
        }
    }

    pub fn dri_mut(&mut self) -> Option<&mut DriFdState> {
        match self.dri_state.as_deref_mut()? {
            DriOfdState::RenderNode(d) | DriOfdState::Card { dri: d, .. } => Some(d),
            DriOfdState::PrimeBo(_) => None,
        }
    }

    pub fn prime_bo(&self) -> Option<&PrimeBoState> {
        match self.dri_state.as_deref()? {
            DriOfdState::PrimeBo(p) => Some(p),
            _ => None,
        }
    }

    /// Extract the prime-bo state and clear `dri_state` so close /
    /// crash cleanup can't double-release.
    pub fn take_prime_bo(&mut self) -> Option<PrimeBoState> {
        if !matches!(self.dri_state.as_deref(), Some(DriOfdState::PrimeBo(_))) {
            return None;
        }
        match *self.dri_state.take().unwrap() {
            DriOfdState::PrimeBo(p) => Some(p),
            _ => unreachable!(),
        }
    }

    pub fn kms(&self) -> Option<&KmsFdState> {
        match self.dri_state.as_deref()? {
            DriOfdState::Card { kms, .. } => Some(kms),
            _ => None,
        }
    }

    pub fn kms_mut(&mut self) -> Option<&mut KmsFdState> {
        match self.dri_state.as_deref_mut()? {
            DriOfdState::Card { kms, .. } => Some(kms),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct OfdTable {
    entries: Vec<Option<OpenFileDesc>>,
}

impl OfdTable {
    pub fn new() -> Self {
        OfdTable {
            entries: Vec::new(),
        }
    }

    /// Create a new open file description. Returns the OFD index.
    /// Reuses freed slots when available.
    pub fn create(
        &mut self,
        file_type: FileType,
        status_flags: u32,
        host_handle: i64,
        path: Vec<u8>,
    ) -> usize {
        let ofd = OpenFileDesc {
            file_type,
            status_flags,
            host_handle,
            offset: 0,
            ref_count: 1,
            owner_pid: 0,
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
            dir_entry_offset: 0,
            dri_state: None,
        };

        // Search for a free (None) slot to reuse.
        for i in 0..self.entries.len() {
            if self.entries[i].is_none() {
                self.entries[i] = Some(ofd);
                return i;
            }
        }

        // No free slot; append.
        let idx = self.entries.len();
        self.entries.push(Some(ofd));
        idx
    }

    /// Get a reference to the OFD at `idx`, or `None` if the slot is empty or out of range.
    pub fn get(&self, idx: usize) -> Option<&OpenFileDesc> {
        self.entries.get(idx).and_then(|slot| slot.as_ref())
    }

    /// Get a mutable reference to the OFD at `idx`, or `None` if the slot is empty or out of range.
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut OpenFileDesc> {
        self.entries.get_mut(idx).and_then(|slot| slot.as_mut())
    }

    /// Increment the reference count for the OFD at `idx`.
    pub fn inc_ref(&mut self, idx: usize) {
        if let Some(ofd) = self.get_mut(idx) {
            ofd.ref_count += 1;
        }
    }

    /// Decrement the reference count for the OFD at `idx`.
    /// Returns `true` if the OFD was freed (ref_count reached 0).
    pub fn dec_ref(&mut self, idx: usize) -> bool {
        let should_free = if let Some(ofd) = self.entries.get_mut(idx).and_then(|s| s.as_mut()) {
            ofd.ref_count -= 1;
            ofd.ref_count == 0
        } else {
            return false;
        };

        if should_free {
            self.entries[idx] = None;
            true
        } else {
            false
        }
    }

    /// Iterate over all open file descriptions with their indices.
    pub fn iter(&self) -> impl Iterator<Item = (usize, &OpenFileDesc)> + '_ {
        self.entries
            .iter()
            .enumerate()
            .filter_map(|(i, e)| e.as_ref().map(|ofd| (i, ofd)))
    }

    /// Mutably iterate over all open file descriptions with their
    /// indices. Used by close-on-exec, signal delivery, and DRI
    /// per-fd cleanup.
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (usize, &mut OpenFileDesc)> + '_ {
        self.entries
            .iter_mut()
            .enumerate()
            .filter_map(|(i, e)| e.as_mut().map(|ofd| (i, ofd)))
    }

    /// Reconstruct an OfdTable from raw entries. Used by fork deserialization.
    pub fn from_raw(entries: Vec<Option<OpenFileDesc>>) -> Self {
        OfdTable { entries }
    }

    /// Update status flags with F_SETFL semantics.
    ///
    /// Per POSIX, only `O_APPEND` and `O_NONBLOCK` are modifiable via F_SETFL.
    /// The access mode (O_RDONLY/O_WRONLY/O_RDWR) and all other flags are preserved.
    pub fn set_status_flags(&mut self, idx: usize, new_flags: u32) {
        if let Some(ofd) = self.get_mut(idx) {
            // Preserve everything except the modifiable bits.
            let preserved = ofd.status_flags & !SETFL_MODIFIABLE;
            // Take only the modifiable bits from new_flags.
            let updated = new_flags & SETFL_MODIFIABLE;
            ofd.status_flags = preserved | updated;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::flags::*;

    #[test]
    fn test_create_ofd() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR | O_APPEND, 42, b"/test".to_vec());
        assert_eq!(idx, 0);

        let ofd = table.get(idx).expect("OFD should exist at index 0");
        assert_eq!(ofd.file_type, FileType::Regular);
        assert_eq!(ofd.status_flags, O_RDWR | O_APPEND);
        assert_eq!(ofd.host_handle, 42);
        assert_eq!(ofd.offset, 0);
        assert_eq!(ofd.ref_count, 1);
        assert_eq!(ofd.path, b"/test");
    }

    #[test]
    fn test_ref_counting() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDONLY, 10, Vec::new());

        // Initially ref_count = 1
        assert_eq!(table.get(idx).unwrap().ref_count, 1);

        // inc_ref -> 2
        table.inc_ref(idx);
        assert_eq!(table.get(idx).unwrap().ref_count, 2);

        // dec_ref -> 1, not freed
        let freed = table.dec_ref(idx);
        assert!(!freed);
        assert_eq!(table.get(idx).unwrap().ref_count, 1);

        // dec_ref -> 0, freed
        let freed = table.dec_ref(idx);
        assert!(freed);
        assert!(
            table.get(idx).is_none(),
            "OFD should be freed when ref_count hits 0"
        );
    }

    #[test]
    fn test_set_status_flags_preserves_access_mode() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR | O_APPEND, 5, Vec::new());

        // Verify initial state: access mode is O_RDWR, O_APPEND is set
        let ofd = table.get(idx).unwrap();
        assert_eq!(ofd.status_flags & O_ACCMODE, O_RDWR);
        assert_ne!(ofd.status_flags & O_APPEND, 0);

        // set_status_flags with O_NONBLOCK (no O_APPEND, different access mode bits)
        // Per POSIX F_SETFL: access mode must be preserved, only O_APPEND/O_NONBLOCK modifiable
        table.set_status_flags(idx, O_NONBLOCK);

        let ofd = table.get(idx).unwrap();
        // Access mode should still be O_RDWR
        assert_eq!(ofd.status_flags & O_ACCMODE, O_RDWR);
        // O_APPEND should be removed (caller did not include it)
        assert_eq!(ofd.status_flags & O_APPEND, 0);
        // O_NONBLOCK should be added
        assert_ne!(ofd.status_flags & O_NONBLOCK, 0);
    }

    #[test]
    fn test_slot_reuse() {
        let mut table = OfdTable::new();
        let idx0 = table.create(FileType::Regular, O_RDONLY, 1, Vec::new());
        assert_eq!(idx0, 0);

        // Free slot 0
        let freed = table.dec_ref(idx0);
        assert!(freed);

        // Create again; should reuse slot 0
        let idx_reused = table.create(FileType::Pipe, O_RDWR, 2, Vec::new());
        assert_eq!(idx_reused, 0);
        let ofd = table.get(idx_reused).unwrap();
        assert_eq!(ofd.file_type, FileType::Pipe);
        assert_eq!(ofd.host_handle, 2);
    }

    #[test]
    fn test_multiple_ofds() {
        let mut table = OfdTable::new();
        let idx0 = table.create(FileType::Regular, O_RDONLY, 10, Vec::new());
        let idx1 = table.create(FileType::Pipe, O_RDWR, 20, Vec::new());
        let idx2 = table.create(FileType::Socket, O_RDWR | O_NONBLOCK, 30, Vec::new());

        assert_eq!(idx0, 0);
        assert_eq!(idx1, 1);
        assert_eq!(idx2, 2);

        assert_eq!(table.get(0).unwrap().host_handle, 10);
        assert_eq!(table.get(1).unwrap().host_handle, 20);
        assert_eq!(table.get(2).unwrap().host_handle, 30);
    }

    #[test]
    fn test_iter_returns_open_ofds() {
        let mut table = OfdTable::new();
        let idx0 = table.create(FileType::Regular, O_RDONLY, 10, Vec::new());
        let idx1 = table.create(FileType::Pipe, O_RDWR, 20, Vec::new());

        let ofds: Vec<(usize, &OpenFileDesc)> = table.iter().collect();
        assert_eq!(ofds.len(), 2);
        assert_eq!(ofds[0].0, idx0);
        assert_eq!(ofds[0].1.host_handle, 10);
        assert_eq!(ofds[1].0, idx1);
        assert_eq!(ofds[1].1.host_handle, 20);
    }

    #[test]
    fn test_iter_skips_freed_slots() {
        let mut table = OfdTable::new();
        table.create(FileType::Regular, O_RDONLY, 10, Vec::new());
        table.create(FileType::Pipe, O_RDWR, 20, Vec::new());
        table.dec_ref(0); // free slot 0

        let ofds: Vec<(usize, &OpenFileDesc)> = table.iter().collect();
        assert_eq!(ofds.len(), 1);
        assert_eq!(ofds[0].0, 1);
    }

    #[test]
    fn test_from_raw_roundtrip() {
        let mut table = OfdTable::new();
        table.create(FileType::Regular, O_RDONLY, 10, b"/a".to_vec());
        table.create(FileType::Socket, O_RDWR, 30, b"/b".to_vec());

        // Build raw entries from iteration
        let max_idx = table.iter().map(|(i, _)| i).max().unwrap_or(0);
        let mut raw: Vec<Option<OpenFileDesc>> = (0..=max_idx).map(|_| None).collect();
        for (i, ofd) in table.iter() {
            raw[i] = Some(OpenFileDesc {
                file_type: ofd.file_type,
                status_flags: ofd.status_flags,
                host_handle: ofd.host_handle,
                offset: ofd.offset,
                ref_count: ofd.ref_count,
                owner_pid: ofd.owner_pid,
                path: ofd.path.clone(),
                dir_host_handle: -1,
                dir_synth_state: 0,
                dir_entry_offset: 0,
                dri_state: None,
            });
        }

        let rebuilt = OfdTable::from_raw(raw);
        assert_eq!(rebuilt.get(0).unwrap().host_handle, 10);
        assert_eq!(rebuilt.get(1).unwrap().host_handle, 30);
    }

    #[test]
    fn ofd_default_has_no_dri_state() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::CharDevice, O_RDONLY, -8, b"/dev/dri/renderD128".to_vec());
        let ofd = table.get(idx).unwrap();
        assert!(ofd.dri_state.is_none());
        assert!(ofd.dri().is_none());
        assert!(ofd.kms().is_none());
        assert!(ofd.prime_bo().is_none());
    }

    #[test]
    fn dri_accessors_route_by_variant() {
        let mut table = OfdTable::new();
        let render = table.create(FileType::CharDevice, O_RDWR, -8, b"/dev/dri/renderD128".to_vec());
        let card = table.create(FileType::CharDevice, O_RDWR, -9, b"/dev/dri/card0".to_vec());
        let prime = table.create(FileType::Regular, O_RDWR, -100, b"<prime>".to_vec());

        table.get_mut(render).unwrap().dri_state =
            Some(Box::new(DriOfdState::RenderNode(DriFdState::default())));
        table.get_mut(card).unwrap().dri_state = Some(Box::new(DriOfdState::Card {
            dri: DriFdState::default(),
            kms: KmsFdState::default(),
        }));
        table.get_mut(prime).unwrap().dri_state =
            Some(Box::new(DriOfdState::PrimeBo(PrimeBoState {
                bo_id: 7,
                cookie: 0xdead_beef,
            })));

        // render node: dri() yes, kms() no, prime_bo() no
        let ro = table.get(render).unwrap();
        assert!(ro.dri().is_some());
        assert_eq!(ro.dri().unwrap().next_handle, 1);
        assert!(ro.kms().is_none());
        assert!(ro.prime_bo().is_none());

        // card: dri() yes, kms() yes, prime_bo() no
        let co = table.get(card).unwrap();
        assert!(co.dri().is_some());
        assert!(co.kms().is_some());
        assert!(!co.kms().unwrap().holds_master);
        assert!(co.prime_bo().is_none());

        // prime-bo: dri() no, kms() no, prime_bo() yes
        let po = table.get(prime).unwrap();
        assert!(po.dri().is_none());
        assert!(po.kms().is_none());
        let p = po.prime_bo().unwrap();
        assert_eq!(p.bo_id, 7);
        assert_eq!(p.cookie, 0xdead_beef);
    }

    #[test]
    fn dri_mut_lets_you_register_a_handle() {
        let mut table = OfdTable::new();
        let render = table.create(FileType::CharDevice, O_RDWR, -8, b"/dev/dri/renderD128".to_vec());
        table.get_mut(render).unwrap().dri_state =
            Some(Box::new(DriOfdState::RenderNode(DriFdState::default())));

        let dri = table.get_mut(render).unwrap().dri_mut().unwrap();
        let h = dri.next_handle;
        dri.handles.insert(h, 42);
        dri.next_handle += 1;

        let dri_again = table.get(render).unwrap().dri().unwrap();
        assert_eq!(dri_again.handles.get(&1).copied(), Some(42));
        assert_eq!(dri_again.next_handle, 2);
    }

    #[test]
    fn take_prime_bo_clears_state() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR, -100, b"<prime>".to_vec());
        table.get_mut(idx).unwrap().dri_state =
            Some(Box::new(DriOfdState::PrimeBo(PrimeBoState {
                bo_id: 5,
                cookie: 0xcafe_1234,
            })));

        let taken = table.get_mut(idx).unwrap().take_prime_bo().unwrap();
        assert_eq!(taken.bo_id, 5);
        assert!(table.get(idx).unwrap().dri_state.is_none());

        // Idempotent: second take returns None.
        assert!(table.get_mut(idx).unwrap().take_prime_bo().is_none());
    }

    #[test]
    fn take_prime_bo_is_none_for_non_prime() {
        let mut table = OfdTable::new();
        let render = table.create(FileType::CharDevice, O_RDWR, -8, b"/dev/dri/renderD128".to_vec());
        table.get_mut(render).unwrap().dri_state =
            Some(Box::new(DriOfdState::RenderNode(DriFdState::default())));
        assert!(table.get_mut(render).unwrap().take_prime_bo().is_none());
        // dri_state must NOT have been cleared.
        assert!(table.get(render).unwrap().dri_state.is_some());
    }

    #[test]
    fn iter_mut_visits_every_live_ofd() {
        let mut table = OfdTable::new();
        table.create(FileType::Regular, O_RDONLY, 1, Vec::new());
        table.create(FileType::Regular, O_RDONLY, 2, Vec::new());
        table.create(FileType::Regular, O_RDONLY, 3, Vec::new());
        table.dec_ref(1); // free middle slot

        let mut visited = Vec::new();
        for (i, ofd) in table.iter_mut() {
            ofd.offset = (i as i64) * 100;
            visited.push((i, ofd.host_handle));
        }
        assert_eq!(visited, vec![(0, 1), (2, 3)]);
        assert_eq!(table.get(0).unwrap().offset, 0);
        assert_eq!(table.get(2).unwrap().offset, 200);
    }
}
