extern crate alloc;

#[cfg(test)]
use crate::IoBox as Box;
use alloc::collections::VecDeque;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell, UnsafeCell};
use core::sync::atomic::{AtomicU64, Ordering};
use wasm_posix_shared::Errno;
use wasm_posix_shared::flags::{O_ACCMODE, O_APPEND, O_NONBLOCK, O_PATH};

use crate::fd::FdTable;
use crate::io_buffer::IoBuffer;
use crate::io_owner::{IoRc, IoBox};
use crate::metadata_budget::MetadataBytes;
use crate::lock::{FileId, OfdId};
use crate::prepared_map::{PreparedEntry, PreparedMap};

// OFD table slots are process-local and reusable, so they cannot identify an
// open file description across fork or over its lifetime. Keep a separate
// machine-wide, monotonically increasing identity. Zero is reserved as an
// invalid/uninitialized value in serialized process state.
static LAST_OFD_ID: AtomicU64 = AtomicU64::new(0);

/// References held by descriptors queued in SCM_RIGHTS ancillary data.
///
/// Advisory-lock records remain solely in `ProcessTable`; this table is only
/// descriptor-lifetime state.  A high-water `Vec` avoids allocator churn in
/// the Wasm kernel while the sorted OfdId key keeps lookups bounded by the
/// number of simultaneously in-flight descriptions.
struct InFlightOfdRefs(UnsafeCell<Option<IoBuffer<(OfdId, u32)>>>);
unsafe impl Sync for InFlightOfdRefs {}

static IN_FLIGHT_OFD_REFS: InFlightOfdRefs = InFlightOfdRefs(UnsafeCell::new(None));

fn in_flight_ofd_refs() -> &'static mut IoBuffer<(OfdId, u32)> {
    let slot = unsafe { &mut *IN_FLIGHT_OFD_REFS.0.get() };
    slot.get_or_insert_with(IoBuffer::new)
}

fn allocate_ofd_id() -> OfdId {
    let previous = LAST_OFD_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |last| {
            last.checked_add(1)
        })
        .expect("OFD identity space exhausted");
    OfdId(previous + 1)
}

fn observe_ofd_id(id: OfdId) {
    assert_ne!(id.0, 0, "OFD identity zero is reserved");
    LAST_OFD_ID.fetch_max(id.0, Ordering::Relaxed);
}

/// Add one SCM_RIGHTS queue reference for an existing open description.
pub fn retain_in_flight_ofd(id: OfdId) -> Result<(), Errno> {
    retain_queued_reference(in_flight_ofd_refs(), id)
}

fn retain_queued_reference(refs: &mut IoBuffer<(OfdId, u32)>, id: OfdId) -> Result<(), Errno> {
    if id.0 == 0 {
        return Err(Errno::EINVAL);
    }
    match refs.binary_search_by_key(&id, |(candidate, _)| *candidate) {
        Ok(index) => {
            refs[index].1 = refs[index].1.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        }
        Err(index) => {
            if refs.len() == refs.capacity() {
                let capacity = refs.len().checked_add(1).ok_or(Errno::ENOMEM)?
                    .max(refs.capacity().saturating_mul(2));
                refs.reserve_with(capacity, |replacement| {
                    replacement.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)
                })?;
            }
            refs.insert(index, (id, 1));
        }
    }
    Ok(())
}

/// Drop one SCM_RIGHTS queue reference. Returns true when no queued reference
/// for this identity remains.
pub fn release_in_flight_ofd(id: OfdId) -> bool {
    release_queued_reference(in_flight_ofd_refs(), id)
}

fn release_queued_reference(refs: &mut IoBuffer<(OfdId, u32)>, id: OfdId) -> bool {
    let Ok(index) = refs.binary_search_by_key(&id, |(candidate, _)| *candidate) else {
        debug_assert!(false, "released an OfdId without an in-flight reference");
        return false;
    };
    if refs[index].1 > 1 {
        refs[index].1 -= 1;
        false
    } else {
        refs.remove(index);
        if refs.is_empty() {
            *refs = IoBuffer::new_in(refs.budget());
        }
        true
    }
}

pub fn has_in_flight_ofd(id: OfdId) -> bool {
    in_flight_ofd_refs()
        .binary_search_by_key(&id, |(candidate, _)| *candidate)
        .is_ok()
}

pub(crate) struct InheritedOfdRefs {
    counts: IoBuffer<(usize, u32)>,
    pub(crate) descriptor_count: usize,
}

impl InheritedOfdRefs {
    pub(crate) fn prepare(table: &OfdTable, fds: &FdTable, excluded_flags: u32) -> Result<Self, Errno> {
        let descriptor_count = fds.iter().filter(|(_, entry)| entry.fd_flags & excluded_flags == 0).count();
        let mut counts = IoBuffer::allocate(descriptor_count, false, |counts| {
            counts.try_reserve_exact(descriptor_count).map_err(|_| Errno::ENOMEM)
        })?;
        for (_, entry) in fds.iter().filter(|(_, entry)| entry.fd_flags & excluded_flags == 0) {
            let index = entry.ofd_ref.0;
            if table.get(index).is_none() { return Err(Errno::EBADF); }
            counts.push((index, 1u32));
        }
        counts.sort_unstable_by_key(|(index, _)| *index);
        let mut unique = 0;
        for read in 0..counts.len() {
            let (index, count) = counts[read];
            if unique > 0 && counts[unique - 1].0 == index {
                counts[unique - 1].1 = counts[unique - 1].1.checked_add(count).ok_or(Errno::EOVERFLOW)?;
            } else {
                counts[unique] = (index, count);
                unique += 1;
            }
        }
        counts.truncate(unique);
        Ok(Self { counts, descriptor_count })
    }

    pub(crate) fn count(&self, index: usize) -> u32 {
        self.counts.binary_search_by_key(&index, |(candidate, _)| *candidate)
            .map(|position| self.counts[position].1).unwrap_or(0)
    }

    pub(crate) fn len(&self) -> usize { self.counts.len() }
}

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

struct HostHandleRefs(UnsafeCell<PreparedMap<i64, u32>>);
unsafe impl Sync for HostHandleRefs {}

static HOST_HANDLE_REFS: HostHandleRefs = HostHandleRefs(UnsafeCell::new(PreparedMap::new()));

fn get_host_handle_refs() -> &'static mut PreparedMap<i64, u32> {
    unsafe { &mut *HOST_HANDLE_REFS.0.get() }
}

/// Register that a host handle is now shared by one more process (fork).
/// If the handle is being forked for the first time, sets count to 2
/// (parent + child). Otherwise increments by 1.
pub fn host_handle_fork_ref(handle: i64) -> Result<(), Errno> {
    let refs = get_host_handle_refs();
    if let Some(count) = refs.get_mut(&handle) {
        *count = count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        return Ok(());
    }
    let reservation = PreparedEntry::<i64, u32>::reserve_in(&crate::io_buffer::IO_MEMORY, 0)?;
    let entry = PreparedEntry::new_reserved_in(&crate::io_buffer::IO_MEMORY, handle, 2, reservation)?;
    refs.insert_prepared(entry);
    Ok(())
}

pub(crate) struct PreparedHostHandleRefs {
    entries: IoBuffer<(i64, u32, Option<PreparedEntry<i64, u32>>)>,
}

fn inherited_host_handle(ofd: &OpenFileDesc) -> Option<i64> {
    (ofd.host_handle >= 0 && matches!(ofd.file_type,
        FileType::Regular | FileType::Directory | FileType::CharDevice | FileType::Pipe))
        .then_some(ofd.host_handle)
}

impl PreparedHostHandleRefs {
    pub(crate) fn prepare(table: &OfdTable) -> Result<Self, Errno> {
        let count = table.iter().filter_map(|(_, ofd)| inherited_host_handle(ofd)).count();
        let mut entries = IoBuffer::try_with_capacity(count)?;
        for (_, ofd) in table.iter() {
            if let Some(handle) = inherited_host_handle(ofd) { entries.push((handle, 1u32, None)); }
        }
        entries.sort_unstable_by_key(|entry| entry.0);
        let mut unique = 0;
        for read in 0..entries.len() {
            let handle = entries[read].0;
            if unique > 0 && entries[unique - 1].0 == handle {
                entries[unique - 1].1 = entries[unique - 1].1.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            } else {
                entries[unique] = (handle, 1, None);
                unique += 1;
            }
        }
        entries.truncate(unique);
        let refs = get_host_handle_refs();
        for (handle, count, prepared) in &mut entries {
            let current = refs.get(handle).copied();
            *count = current.unwrap_or(1).checked_add(*count).ok_or(Errno::EOVERFLOW)?;
            if current.is_none() {
                let reservation = PreparedEntry::<i64, u32>::reserve_in(&crate::io_buffer::IO_MEMORY, 0)?;
                *prepared = Some(PreparedEntry::new_reserved_in(&crate::io_buffer::IO_MEMORY,
                    *handle, *count, reservation)?);
            }
        }
        Ok(Self { entries })
    }

    pub(crate) fn publish(self) {
        let refs = get_host_handle_refs();
        for (handle, count, prepared) in self.entries {
            if let Some(prepared) = prepared {
                assert!(!refs.contains_key(&handle), "prepared host handle changed before publication");
                refs.insert_prepared(prepared);
            } else {
                *refs.get_mut(&handle).expect("prepared host handle disappeared") = count;
            }
        }
    }
}

/// Decrement the cross-process refcount for a host handle.
/// Returns `true` if the handle should be closed (refcount reached 0 or
/// the handle was never shared).
pub fn host_handle_close_ref(h: i64) -> bool {
    let refs = get_host_handle_refs();
    if let Some(count) = refs.get_mut(&h) {
        *count -= 1;
        if *count == 0 {
            drop(refs.remove_entry(&h));
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
    /// Playback-only PCM stream backing used by the OSS `/dev/dsp` frontend.
    PcmPlayback,
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

/// `host_handle` sentinel for prime-bo fds. Disjoint from every other
/// negative sentinel space by construction, not by call-site convention:
/// the `VirtualDevice` range (-1..=-11, so the fd is never routed to a
/// render or card ioctl path), `PROCFS_DIR_HANDLE` (-150),
/// `DEVFS_DIR_HANDLE` (-160), and procfs buffers (<= -`PROCFS_BUF_BASE`).
/// -200 was the first procfs buffer handle; it was safe only because every
/// procfs dispatch happened to check the file type first.
pub const PRIME_FD_HOST_HANDLE: i64 = -170;
const _: () = assert!(
    PRIME_FD_HOST_HANDLE > -crate::procfs::PROCFS_BUF_BASE
        && PRIME_FD_HOST_HANDLE != crate::procfs::PROCFS_DIR_HANDLE
        && PRIME_FD_HOST_HANDLE != crate::devfs::DEVFS_DIR_HANDLE
);

/// Per-fd state for `/dev/dri/renderD128` opens.
///
/// Multiple fds pointing at the same OFD (`dup`, fork-inherit) share
/// the same `DriFdState`; a fresh `open()` yields a new OFD with
/// `DriFdState::default()`. This matches Linux per-fd handle
/// namespacing.
#[derive(Debug)]
pub struct DriFdState {
    /// GEM-handle → global `BoId` map for this fd.
    pub handles: PreparedMap<u32, crate::dri::BoId>,
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
            handles: PreparedMap::new(),
            next_handle: 1,
            gl: None,
        }
    }
}

impl DriFdState {
    pub(crate) fn try_clone(&self) -> Result<Self, Errno> {
        Ok(Self { handles: self.handles.try_clone_io()?, next_handle: self.next_handle, gl: self.gl.clone() })
    }
}

#[cfg(test)]
impl Clone for DriFdState { fn clone(&self) -> Self { self.try_clone().unwrap() } }

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

impl crate::prepared_map::MapMemory for KmsFb {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
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
#[derive(Debug, Default)]
pub struct KmsFdState {
    pub holds_master: bool,
    /// A visible cursor owns a BO reference independently of GEM handles.
    pub cursor_bo: Option<u32>,
    pub fbs: PreparedMap<u32, KmsFb>,
    pub next_fb_id: u32,
    pub pending_flips: IoBuffer<PendingFlip>,
    pub event_ring: crate::IoDeque<u8>,
}

impl KmsFdState {
    pub(crate) fn prepare_flip(&mut self) -> Result<(), Errno> {
        self.pending_flips.try_reserve(1)?;
        let bytes = self.pending_flips.len().checked_add(1).and_then(|count| count.checked_mul(32)).ok_or(Errno::ENOMEM)?;
        self.event_ring.try_reserve(bytes)
    }

    pub(crate) fn try_clone(&self) -> Result<Self, Errno> {
        let pending_bytes = self.pending_flips.len().checked_mul(32).ok_or(Errno::ENOMEM)?;
        Ok(Self { holds_master: self.holds_master, cursor_bo: self.cursor_bo, fbs: self.fbs.try_clone_io()?, next_fb_id: self.next_fb_id,
            pending_flips: IoBuffer::copy_from(&self.pending_flips)?,
            event_ring: self.event_ring.try_clone_with_headroom(pending_bytes)? })
    }
}

#[cfg(test)]
impl Clone for KmsFdState { fn clone(&self) -> Self { self.try_clone().unwrap() } }

/// DRI sidecar on [`OpenFileDesc::dri_state`]. A card0 OFD needs both
/// a GEM-handle namespace (for `MODE_ADDFB2` lookups against
/// `PRIME_FD_TO_HANDLE`-imported bos) and a KMS scope, so the three
/// DRI fd kinds share a single sum type.
#[derive(Debug)]
pub enum DriOfdState {
    /// fd allocated by `DRM_IOCTL_PRIME_HANDLE_TO_FD`.
    PrimeBo(PrimeBoState),
    /// fd from `open("/dev/dri/renderD128")`.
    RenderNode(DriFdState),
    /// fd from `open("/dev/dri/card0")`.
    Card { dri: DriFdState, kms: KmsFdState },
}

impl DriOfdState {
    pub(crate) fn try_clone(&self) -> Result<Self, Errno> {
        Ok(match self {
            Self::PrimeBo(prime) => Self::PrimeBo(prime.clone()),
            Self::RenderNode(dri) => Self::RenderNode(dri.try_clone()?),
            Self::Card { dri, kms } => Self::Card { dri: dri.try_clone()?, kms: kms.try_clone()? },
        })
    }
}

#[cfg(test)]
impl Clone for DriOfdState { fn clone(&self) -> Self { self.try_clone().unwrap() } }

/// Per-OFD ring cap: 1024 `struct input_event` records (24 KiB).
pub const INPUT_RING_MAX_RECORDS: usize = 1024;
/// Per-OFD ring cap in bytes — `INPUT_RING_MAX_RECORDS * size_of::<WpkInputEvent>()`.
pub const INPUT_RING_MAX_BYTES: usize = INPUT_RING_MAX_RECORDS * 24;

/// Per-fd state for `/dev/input/event{0,1}` opens.
///
/// Disjoint from [`DriOfdState`] — input fds carry no DRI bo state.
/// We keep `input_state` as a separate `Option<Box<…>>` field on the
/// OFD rather than folding it into `DriOfdState` because the two
/// state machines have no shared invariants.
///
/// Linux semantics replicated:
/// * The ring is per-OFD, not per-process. `dup` / fork-inherit share
///   one ring; a fresh `open()` gets a new one.
/// * On overflow, the **oldest** record is discarded to make room for the
///   newest and `dropped` is set (mirrors
///   `drivers/input/evdev.c::evdev_pass_values`, which advances the tail).
///   Keeping the newest guarantees a key release is never the record
///   dropped. The next `read()` synthesises a `SYN_DROPPED` record at the
///   head of the returned buffer and clears `dropped`; userspace is
///   expected to resynchronise by re-querying state via `EVIOCG*`.
/// * `EVIOCGRAB` (exclusive grab) is not supported — the ioctl returns
///   `ENOTTY`. v1 fans every record out to all readers, so there is no
///   exclusivity state to keep here; real grab is deferred to a later
///   change that routes records only to the grabbing OFD.
///
/// The mutable ring state lives behind [`SharedInputRing`] rather than
/// inline so that `dup`, `fork`, and `exec` observe **one** ring for a
/// given OFD identity. Linux backs a shared `struct file` with a single
/// `struct evdev_client`, so a buffered event is delivered once and
/// consumed by whichever sharer reads first; two independent `open()`s
/// each get their own ring and see the stream independently. Only
/// `device` is per-descriptor immutable state safe to copy.
#[derive(Clone, Debug)]
#[cfg_attr(test, derive(Default))]
pub struct InputFdState {
    /// Which device this fd is bound to (0 = kbd, 1 = ptr). Cached
    /// to avoid a second `VirtualDevice` lookup on read / poll.
    pub device: u8,

    /// Mutable ring shared by every descriptor naming this OFD; see
    /// [`SharedInputRing`].
    pub ring: SharedInputRing,
}

/// Mutable evdev ring state for one OFD identity.
///
/// Held behind [`SharedInputRing`]'s `Rc<RefCell<…>>`; do not copy this
/// struct across a descriptor boundary — clone the `SharedInputRing`
/// handle so the ring stays shared.
#[derive(Debug)]
pub struct InputRing {
    /// Ring of 24-byte `WpkInputEvent` records. Bounded at
    /// [`INPUT_RING_MAX_BYTES`].
    pub event_ring: InputEventRing,

    /// Set when an event push found the ring full; cleared on the
    /// next `read()` *after* a `SYN_DROPPED` synthetic record is
    /// delivered at the head of that read's output.
    pub dropped: bool,
    delivered_epoch: u64,
}

pub struct InputEventRing {
    values: VecDeque<u8>,
    _reservation: crate::metadata_budget::MetadataReservation<'static>,
}

impl InputEventRing {
    fn try_new() -> Result<Self, Errno> {
        let mut reservation = crate::io_buffer::reserve_payload(INPUT_RING_MAX_BYTES, false)?;
        let mut values = VecDeque::new();
        values.try_reserve_exact(INPUT_RING_MAX_BYTES).map_err(|_| Errno::ENOMEM)?;
        reservation.resize(values.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        Ok(Self { values, _reservation: reservation })
    }

    pub(crate) fn push_back(&mut self, value: u8) {
        assert!(self.values.len() < INPUT_RING_MAX_BYTES);
        self.values.push_back(value);
    }

    pub(crate) fn pop_front(&mut self) -> Option<u8> { self.values.pop_front() }
}

impl core::ops::Deref for InputEventRing {
    type Target = VecDeque<u8>;
    fn deref(&self) -> &Self::Target { &self.values }
}

impl core::fmt::Debug for InputEventRing {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { self.values.fmt(formatter) }
}

impl InputRing {
    pub(crate) fn try_new() -> Result<Self, Errno> {
        Ok(Self { event_ring: InputEventRing::try_new()?, dropped: false, delivered_epoch: 0 })
    }

    pub(crate) fn begin_delivery(&mut self, epoch: u64) -> bool {
        if self.delivered_epoch == epoch { return false; }
        self.delivered_epoch = epoch;
        true
    }
}

/// Exact-ownership, interior-mutable handle to one OFD's evdev ring.
///
/// Mirrors [`SharedOfdState`]: `dup`, `fork` (via
/// [`OfdTable::link_shared_states_from`]), and any `OpenFileDesc` clone
/// keep one `Rc`, so all descriptors of an OFD identity share a single
/// ring. This is kernel-internal and does not change the guest/host ABI.
#[derive(Clone, Debug)]
pub struct SharedInputRing(IoRc<RefCell<InputRing>>);

#[cfg(test)]
impl Default for SharedInputRing {
    fn default() -> Self {
        Self::try_new().unwrap()
    }
}

impl SharedInputRing {
    pub fn try_new() -> Result<Self, Errno> { Self::try_from_ring(InputRing::try_new()?) }

    pub fn try_from_ring(ring: InputRing) -> Result<Self, Errno> {
        Ok(Self(IoRc::try_new(RefCell::new(ring))?))
    }
    /// Wrap an already-populated ring (used by fork deserialization,
    /// which reconstructs the point-in-time ring contents before the
    /// relink step re-shares the parent's live handle).
    #[cfg(test)]
    pub fn from_ring(ring: InputRing) -> Self {
        Self::try_from_ring(ring).unwrap()
    }

    /// Shared read borrow of the ring.
    pub fn borrow(&self) -> core::cell::Ref<'_, InputRing> {
        self.0.borrow()
    }

    /// Exclusive borrow of the ring for push / drain / flag updates.
    pub fn borrow_mut(&self) -> core::cell::RefMut<'_, InputRing> {
        self.0.borrow_mut()
    }

    /// Stable identity of the underlying ring, used to deliver a fanned-
    /// out event exactly once per shared ring (parent and child that
    /// share an OFD must not each receive their own copy).
    pub fn identity(&self) -> usize {
        self.0.identity()
    }

    #[cfg(test)]
    pub fn ref_count(&self) -> usize {
        self.0.strong_count()
    }
}

#[cfg_attr(test, derive(Clone))]
pub struct OpenFileDesc {
    /// Machine-wide identity of this open file description. Independent
    /// opens receive distinct IDs; dup, fork, and exec preserve an ID.
    pub ofd_id: OfdId,
    /// Stable file-object identity used by advisory locks. Host-backed files
    /// populate this from `host_fstat` on the live handle; kernel objects use
    /// their tagged object identity.
    pub file_id: Option<FileId>,
    pub file_type: FileType,
    /// Mutable state shared by every descriptor naming this OFD.
    ///
    /// Descriptor tables and host directory handles remain process-owned,
    /// but `dup`, `fork`, `vfork`, `posix_spawn`, and `SCM_RIGHTS` must all
    /// observe one offset, one set of file-status flags, and one async owner.
    /// The Wasm kernel serializes access on its dedicated worker, while Rc
    /// gives this state exact ownership and retirement without a global map.
    pub shared_state: SharedOfdState,
    pub host_handle: i64,
    pub ref_count: u32,
    pub path: OfdPath,
    /// Host directory handle for getdents64 iteration (lazily opened).
    /// -1 means not yet opened, -2 means exhausted (EOF).
    pub dir_host_handle: i64,
    /// Synthetic "." / ".." state for getdents64: 0 = emit ".", 1 = emit "..", 2 = host entries
    pub dir_synth_state: u8,
    /// Cumulative entry count across getdents64 calls — used as d_off cookie for seekdir.
    pub dir_entry_offset: i64,
    /// Shared-position generation represented by this process-local iterator.
    pub dir_position_generation: u64,
    /// Host entry already consumed by `host_readdir` but not yet exposed to
    /// the guest because it did not fit in the caller's getdents64 buffer.
    /// The next getdents64 call must retry this exact entry before advancing
    /// the host iterator.
    pub dir_pending_entry: Option<PendingDirEntry>,
    /// DRI sidecar; see [`DriOfdState`]. Boxed so non-DRI OFDs pay
    /// only one pointer slot.
    pub dri_state: Option<IoBox<DriOfdState>>,
    /// evdev sidecar for `/dev/input/event{0,1}` OFDs; see
    /// [`InputFdState`]. Boxed so non-evdev OFDs pay only one pointer
    /// slot. Parallel to [`Self::dri_state`] (disjoint state machines).
    pub input_state: Option<IoBox<InputFdState>>,
}

struct SharedOfdStateInner {
    status_flags: Cell<u32>,
    offset: Cell<i64>,
    owner_pid: Cell<u32>,
    position_generation: Cell<u64>,
    epoll_identity: Cell<Option<OfdId>>,
}

impl Drop for SharedOfdStateInner {
    fn drop(&mut self) {
        if let Some(id) = self.epoll_identity.get() {
            // A sender waiting on this datagram receiver's full queue can
            // write without blocking once its last owner closes (and fail).
            crate::epoll::notify(
                crate::epoll::Source::DatagramCapacity(id),
                wasm_posix_shared::epoll::EPOLLOUT
                    | wasm_posix_shared::epoll::EPOLLWRNORM
                    | wasm_posix_shared::epoll::EPOLLWRBAND,
            );
            crate::epoll::forget(id);
        }
    }
}

/// Exact-ownership handle for the mutable POSIX portion of an OFD.
///
/// This is kernel-internal and does not change the guest/host ABI.
#[derive(Clone)]
pub struct SharedOfdState(IoRc<SharedOfdStateInner>);

impl SharedOfdState {
    #[cfg(test)]
    pub fn new(status_flags: u32, offset: i64, owner_pid: u32) -> Self {
        Self::try_new(status_flags, offset, owner_pid).unwrap()
    }

    pub fn try_new(status_flags: u32, offset: i64, owner_pid: u32) -> Result<Self, Errno> {
        Ok(Self(IoRc::try_new(SharedOfdStateInner {
            status_flags: Cell::new(status_flags),
            offset: Cell::new(offset),
            owner_pid: Cell::new(owner_pid),
            position_generation: Cell::new(0),
            epoll_identity: Cell::new(None),
        })?))
    }

    fn status_flags(&self) -> u32 {
        self.0.status_flags.get()
    }

    fn set_status_flags(&self, value: u32) {
        self.0.status_flags.set(value);
    }

    fn offset(&self) -> i64 {
        self.0.offset.get()
    }

    fn set_offset(&self, value: i64) {
        if self.0.offset.replace(value) != value {
            self.0
                .position_generation
                .set(self.0.position_generation.get().wrapping_add(1));
        }
    }

    fn owner_pid(&self) -> u32 {
        self.0.owner_pid.get()
    }

    fn set_owner_pid(&self, value: u32) {
        self.0.owner_pid.set(value);
    }

    fn position_generation(&self) -> u64 {
        self.0.position_generation.get()
    }
}

#[derive(Clone, Debug)]
enum PathStorage {
    Empty,
    Root,
    Owned(IoRc<MetadataBytes<'static>>),
}

#[derive(Clone, Debug)]
pub struct OfdPath(PathStorage);

impl OfdPath {
    pub const fn root() -> Self { Self(PathStorage::Root) }

    pub fn copy_from(path: &[u8]) -> Result<Self, Errno> {
        if path.is_empty() { return Ok(Self(PathStorage::Empty)); }
        if path == b"/" { return Ok(Self::root()); }
        Ok(Self(PathStorage::Owned(IoRc::try_new(MetadataBytes::copy_from(&crate::io_buffer::IO_MEMORY, path)?)?)))
    }

    pub fn as_slice(&self) -> &[u8] {
        match &self.0 {
            PathStorage::Empty => &[],
            PathStorage::Root => b"/",
            PathStorage::Owned(path) => path.as_ref(),
        }
    }
}

impl core::ops::Deref for OfdPath {
    type Target = [u8];
    fn deref(&self) -> &[u8] { self.as_slice() }
}

impl AsRef<[u8]> for OfdPath {
    fn as_ref(&self) -> &[u8] { self.as_slice() }
}

impl<Other: AsRef<[u8]> + ?Sized> PartialEq<Other> for OfdPath {
    fn eq(&self, other: &Other) -> bool { self.as_slice() == other.as_ref() }
}

#[derive(Debug, PartialEq)]
pub struct PendingDirEntry {
    pub ino: u64,
    pub d_type: u8,
    name: IoBuffer<u8>,
}

impl Eq for PendingDirEntry {}

impl PendingDirEntry {
    #[cfg(test)]
    pub fn new(ino: u64, d_type: u8, name: &[u8]) -> Result<Self, Errno> {
        let mut buffer = IoBuffer::new();
        buffer.reserve_with(name.len(), |bytes| bytes.try_reserve_exact(name.len()).map_err(|_| Errno::ENOMEM))?;
        buffer.extend_from_slice(name);
        Ok(Self::from_buffer(ino, d_type, buffer))
    }

    pub(crate) fn from_buffer(ino: u64, d_type: u8, name: IoBuffer<u8>) -> Self {
        Self { ino, d_type, name }
    }

    pub fn name(&self) -> &[u8] { &self.name }

    pub(crate) fn into_parts(self) -> (u64, u8, IoBuffer<u8>) { (self.ino, self.d_type, self.name) }
}

#[cfg(test)]
impl Clone for PendingDirEntry {
    fn clone(&self) -> Self { Self::new(self.ino, self.d_type, self.name()).unwrap() }
}

impl OpenFileDesc {
    fn try_clone(&self) -> Result<Self, Errno> {
        let dri_state = self.dri_state.as_ref().map(|state| IoBox::try_new(state.try_clone()?)).transpose()?;
        let input_state = self.input_state.as_ref().map(|state| IoBox::try_new((**state).clone())).transpose()?;
        let mut cloned = Self {
            ofd_id: self.ofd_id, file_id: self.file_id, file_type: self.file_type,
            shared_state: self.shared_state.clone(), host_handle: self.host_handle,
            ref_count: self.ref_count, path: self.path.clone(), dir_host_handle: self.dir_host_handle,
            dir_synth_state: self.dir_synth_state, dir_entry_offset: self.dir_entry_offset,
            dir_position_generation: self.dir_position_generation, dir_pending_entry: None,
            dri_state, input_state,
        };
        cloned.reset_directory_iterator_for_reopen();
        Ok(cloned)
    }
    pub fn status_flags(&self) -> u32 {
        self.shared_state.status_flags()
    }

    pub fn set_status_flags_raw(&self, value: u32) {
        self.shared_state.set_status_flags(value);
    }

    pub fn offset(&self) -> i64 {
        self.shared_state.offset()
    }

    pub fn set_offset(&self, value: i64) {
        self.shared_state.set_offset(value);
    }

    pub fn owner_pid(&self) -> u32 {
        self.shared_state.owner_pid()
    }

    pub fn set_owner_pid(&self, value: u32) {
        self.shared_state.set_owner_pid(value);
    }

    pub fn mark_epoll_watched(&self) {
        self.shared_state.0.epoll_identity.set(Some(self.ofd_id));
    }

    pub fn shared_state(&self) -> SharedOfdState {
        self.shared_state.clone()
    }

    #[cfg(test)]
    pub fn shared_state_ref_count(&self) -> usize {
        self.shared_state.0.strong_count()
    }

    /// Restore object identity after fork deserialization preserved only an
    /// OfdId and point-in-time scalar values.
    fn link_shared_state(&mut self, state: SharedOfdState) {
        self.shared_state = state;
        self.reset_directory_iterator_for_reopen();
    }

    /// Whether this open description denotes a terminal endpoint.
    ///
    /// Host-backed standard streams predate the dedicated PTY file types, so
    /// they remain encoded as `CharDevice` OFDs with their canonical stdio
    /// paths and non-negative host stream handles. Kernel-owned character
    /// devices use negative handles instead (`/dev/null`, framebuffer, DRM,
    /// and so on) and must not acquire terminal semantics merely because
    /// `stat(2)` reports `S_IFCHR`.
    pub fn is_terminal(&self) -> bool {
        match self.file_type {
            FileType::PtyMaster | FileType::PtySlave => true,
            FileType::CharDevice => {
                self.host_handle >= 0
                    && matches!(
                        self.path.as_slice(),
                        b"/dev/stdin" | b"/dev/stdout" | b"/dev/stderr"
                    )
            }
            _ => false,
        }
    }

    /// Drop process-local directory-iterator state while preserving the
    /// guest-visible position at which a newly inherited or transferred
    /// descriptor must resume.
    ///
    /// Host directory handles cannot be shared between independently copied
    /// per-process OFD tables: each copy also carries mutable pending-record
    /// and cookie metadata, and either process may close the handle.  Fork,
    /// non-forking spawn, retained legacy exec, and SCM_RIGHTS therefore call
    /// this at the process boundary.  `sys_getdents64` lazily reconstructs a
    /// host iterator from `dir_entry_offset`; kernel-generated directories
    /// retain their stable sentinel instead.
    pub fn reset_directory_iterator_for_reopen(&mut self) {
        if self.file_type != FileType::Directory {
            return;
        }

        debug_assert!(self.offset() >= 0, "directory cookies cannot be negative");
        let cookie = self.offset().max(0);
        self.dir_host_handle = if self.host_handle == crate::procfs::PROCFS_DIR_HANDLE
            || self.host_handle == crate::devfs::DEVFS_DIR_HANDLE
        {
            self.host_handle
        } else {
            -1
        };
        self.dir_synth_state = cookie.min(2) as u8;
        self.dir_entry_offset = cookie;
        self.dir_position_generation = self.shared_state.position_generation();
        self.dir_pending_entry = None;
    }

    pub fn directory_iterator_is_stale(&self) -> bool {
        self.file_type == FileType::Directory
            && self.dir_position_generation != self.shared_state.position_generation()
    }

    pub fn set_directory_offset(&mut self, value: i64) {
        self.set_offset(value);
        self.dir_position_generation = self.shared_state.position_generation();
    }

    /// Whether this OFD is a pathname capability rather than an I/O handle.
    /// Operations that act directly on an fd must reject path-only OFDs unless
    /// their contract explicitly accepts O_PATH/O_SEARCH descriptors.
    pub fn is_path_only(&self) -> bool {
        self.status_flags() & O_PATH != 0
    }

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
        match self.dri_state.take().unwrap().into_inner() {
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

    /// Borrow the `InputFdState` for `/dev/input/event{0,1}` OFDs.
    /// Returns `None` for any other OFD.
    pub fn input(&self) -> Option<&InputFdState> {
        self.input_state.as_deref()
    }

    pub fn input_mut(&mut self) -> Option<&mut InputFdState> {
        self.input_state.as_deref_mut()
    }

}

pub struct OfdTable {
    entries: IoBuffer<OfdSlot>,
}

enum OfdSlot {
    Free,
    Reserved,
    Open(OpenFileDesc),
}

pub struct PreparedOfd {
    index: usize,
    value: OpenFileDesc,
}

#[cfg(test)]
impl Clone for OfdTable {
    fn clone(&self) -> Self { self.try_clone().unwrap() }
}

impl PreparedOfd {
    pub fn value_mut(&mut self) -> &mut OpenFileDesc { &mut self.value }
}

impl OfdTable {
    pub fn new() -> Self {
        OfdTable {
            entries: IoBuffer::new(),
        }
    }

    /// Create a new open file description. Returns the OFD index.
    /// Reuses freed slots when available.
    pub fn prepare(
        &mut self,
        file_type: FileType,
        status_flags: u32,
        path: &[u8],
    ) -> Result<PreparedOfd, Errno> {
        let path = OfdPath::copy_from(path)?;
        let shared_state = SharedOfdState::try_new(status_flags, 0, 0)?;
        let ofd = OpenFileDesc {
            ofd_id: allocate_ofd_id(),
            file_id: None,
            file_type,
            shared_state,
            host_handle: -1,
            ref_count: 1,
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
            dir_entry_offset: 0,
            dir_position_generation: 0,
            dir_pending_entry: None,
            dri_state: None,
            input_state: None,
        };

        self.reserve(ofd)
    }

    #[cfg(test)]
    pub fn create(&mut self, file_type: FileType, status_flags: u32, host_handle: i64, path: Vec<u8>) -> usize {
        let prepared = self.prepare(file_type, status_flags, &path).unwrap();
        self.publish(prepared, host_handle)
    }

    /// Install an open description transferred through SCM_RIGHTS. The queued
    /// descriptor already owns one machine-wide backing reference, so this
    /// preserves its identity instead of allocating a new one.
    pub fn prepare_transferred(
        &mut self,
        ofd_id: OfdId,
        file_id: Option<FileId>,
        file_type: FileType,
        status_flags: u32,
        host_handle: i64,
        _offset: i64,
        shared_state: SharedOfdState,
        path: OfdPath,
    ) -> Result<PreparedOfd, Errno> {
        observe_ofd_id(ofd_id);
        debug_assert_eq!(
            shared_state.status_flags() & O_ACCMODE,
            status_flags & O_ACCMODE,
            "SCM_RIGHTS changed an OFD's immutable access mode"
        );
        let mut ofd = OpenFileDesc {
            ofd_id,
            file_id,
            file_type,
            shared_state,
            host_handle,
            ref_count: 1,
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
            dir_entry_offset: 0,
            dir_position_generation: 0,
            dir_pending_entry: None,
            dri_state: None,
            input_state: None,
        };
        ofd.reset_directory_iterator_for_reopen();
        self.reserve(ofd)
    }

    fn reserve(&mut self, value: OpenFileDesc) -> Result<PreparedOfd, Errno> {
        for index in 0..self.entries.len() {
            if matches!(self.entries[index], OfdSlot::Free) {
                self.entries[index] = OfdSlot::Reserved;
                return Ok(PreparedOfd { index, value });
            }
        }
        let index = self.entries.len();
        self.entries.try_push(OfdSlot::Reserved)?;
        Ok(PreparedOfd { index, value })
    }

    pub fn publish(&mut self, mut prepared: PreparedOfd, host_handle: i64) -> usize {
        assert!(matches!(self.entries.get(prepared.index), Some(OfdSlot::Reserved)), "prepared OFD slot changed");
        prepared.value.host_handle = host_handle;
        self.entries[prepared.index] = OfdSlot::Open(prepared.value);
        prepared.index
    }

    pub fn cancel(&mut self, prepared: PreparedOfd) {
        assert!(matches!(self.entries.get(prepared.index), Some(OfdSlot::Reserved)), "prepared OFD cancellation lost its slot");
        self.entries[prepared.index] = OfdSlot::Free;
    }

    #[cfg(test)]
    pub(crate) fn reserved_count(&self) -> usize {
        self.entries.iter().filter(|slot| matches!(slot, OfdSlot::Reserved)).count()
    }

    /// Get a reference to the OFD at `idx`, or `None` if the slot is empty or out of range.
    pub fn get(&self, idx: usize) -> Option<&OpenFileDesc> {
        match self.entries.get(idx)? { OfdSlot::Open(value) => Some(value), _ => None }
    }

    /// Get a mutable reference to the OFD at `idx`, or `None` if the slot is empty or out of range.
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut OpenFileDesc> {
        match self.entries.get_mut(idx)? { OfdSlot::Open(value) => Some(value), _ => None }
    }

    /// Keep only references actually inherited through a descriptor table.
    ///
    /// WHY: `ref_count` also includes kernel-owned blocked-retry pins. A
    /// fork/spawn child does not inherit those capabilities, so cloning the
    /// parent's count would either retain an OFD with no child fd or leave a
    /// phantom reference after the child's last real fd closes.
    pub fn retain_fd_references(&mut self, fd_table: &FdTable) -> Result<(), Errno> {
        let inherited_refs = InheritedOfdRefs::prepare(self, fd_table, 0)?;

        for (index, slot) in self.entries.iter_mut().enumerate() {
            let OfdSlot::Open(ofd) = slot else {
                continue;
            };
            let count = inherited_refs.count(index);
            if count > 0 {
                ofd.ref_count = count;
            } else {
                // This clone has not acquired a machine-wide backing
                // reference yet, so dropping an unreferenced local copy must
                // not run ordinary final-close bookkeeping.
                *slot = OfdSlot::Free;
            }
        }
        Ok(())
    }

    /// Increment the reference count for the OFD at `idx`.
    pub fn inc_ref(&mut self, idx: usize) {
        if let Some(ofd) = self.get_mut(idx) {
            ofd.ref_count = ofd
                .ref_count
                .checked_add(1)
                .expect("open-file-description reference count exhausted");
        }
    }

    /// Fallibly retain one exact live OFD.
    ///
    /// A table index is reusable, so callers that keep authority beyond the
    /// current syscall must also prove the stable [`OfdId`]. This is the
    /// allocation-free ownership primitive used by blocked-syscall bindings.
    pub fn try_inc_ref_exact(&mut self, idx: usize, id: OfdId) -> Result<(), Errno> {
        let ofd = self.get_mut(idx).ok_or(Errno::EBADF)?;
        if ofd.ofd_id != id {
            return Err(Errno::EBADF);
        }
        ofd.ref_count = ofd.ref_count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    }

    /// Decrement the reference count for the OFD at `idx`.
    /// Returns `true` if the OFD was freed (ref_count reached 0).
    pub fn dec_ref(&mut self, idx: usize) -> bool {
        let should_free = if let Some(ofd) = self.get_mut(idx) {
            ofd.ref_count -= 1;
            ofd.ref_count == 0
        } else {
            return false;
        };

        if should_free {
            self.entries[idx] = OfdSlot::Free;
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
            .filter_map(|(index, entry)| match entry { OfdSlot::Open(value) => Some((index, value)), _ => None })
    }

    /// Mutably iterate over all open file descriptions with their
    /// indices. Used by close-on-exec, signal delivery, and DRI
    /// per-fd cleanup.
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (usize, &mut OpenFileDesc)> + '_ {
        self.entries
            .iter_mut()
            .enumerate()
            .filter_map(|(index, entry)| match entry { OfdSlot::Open(value) => Some((index, value)), _ => None })
    }

    /// Reconstruct an OfdTable from raw entries. Used by fork deserialization.
    pub fn try_from_raw(entries: Vec<Option<OpenFileDesc>>) -> Result<Self, Errno> {
        let mut admitted = IoBuffer::new();
        admitted.reserve_with(entries.len(), |slots| slots.try_reserve_exact(entries.len()).map_err(|_| Errno::ENOMEM))?;
        for entry in entries {
            admitted.push(match entry {
                Some(ofd) => { observe_ofd_id(ofd.ofd_id); OfdSlot::Open(ofd) },
                None => OfdSlot::Free,
            });
        }
        Ok(OfdTable { entries: admitted })
    }

    pub fn restore_entry(&mut self, index: usize, value: OpenFileDesc) -> Result<(), Errno> {
        let length = index.checked_add(1).ok_or(Errno::ENOMEM)?;
        if length > self.entries.capacity() {
            let capacity = length.max(self.entries.capacity().saturating_mul(2)).max(4);
            if self.entries.reserve_with(capacity, |entries| entries.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)).is_err() {
                self.entries.reserve_with(length, |entries| entries.try_reserve_exact(length).map_err(|_| Errno::ENOMEM))?;
            }
        }
        while self.entries.len() < length { self.entries.push(OfdSlot::Free); }
        if !matches!(self.entries[index], OfdSlot::Free) { return Err(Errno::EINVAL); }
        observe_ofd_id(value.ofd_id);
        self.entries[index] = OfdSlot::Open(value);
        Ok(())
    }

    pub fn try_clone(&self) -> Result<Self, Errno> {
        let mut entries = IoBuffer::new();
        entries.reserve_with(self.entries.len(), |slots| slots.try_reserve_exact(self.entries.len()).map_err(|_| Errno::ENOMEM))?;
        for slot in self.entries.iter() {
            entries.push(match slot { OfdSlot::Open(value) => OfdSlot::Open(value.try_clone()?), _ => OfdSlot::Free });
        }
        Ok(Self { entries })
    }

    #[cfg(test)]
    pub fn from_raw(entries: Vec<Option<OpenFileDesc>>) -> Self { Self::try_from_raw(entries).unwrap() }

    #[cfg(test)]
    pub fn create_transferred(
        &mut self, ofd_id: OfdId, file_id: Option<FileId>, file_type: FileType,
        status_flags: u32, host_handle: i64, offset: i64, shared_state: SharedOfdState, path: impl AsRef<[u8]>,
    ) -> usize {
        let prepared = self.prepare_transferred(ofd_id, file_id, file_type, status_flags, host_handle,
            offset, shared_state, OfdPath::copy_from(path.as_ref()).unwrap()).unwrap();
        self.publish(prepared, host_handle)
    }

    /// Update status flags with F_SETFL semantics.
    ///
    /// Per POSIX, only `O_APPEND` and `O_NONBLOCK` are modifiable via F_SETFL.
    /// The access mode (O_RDONLY/O_WRONLY/O_RDWR) and all other flags are preserved.
    pub fn set_status_flags(&mut self, idx: usize, new_flags: u32) {
        if let Some(ofd) = self.get_mut(idx) {
            // Preserve everything except the modifiable bits.
            let preserved = ofd.status_flags() & !SETFL_MODIFIABLE;
            // Take only the modifiable bits from new_flags.
            let updated = new_flags & SETFL_MODIFIABLE;
            ofd.set_status_flags_raw(preserved | updated);
        }
    }

    /// Relink fork-deserialized entries to the source process's live shared
    /// state. Fork preserves table slots; an identity mismatch is corruption.
    pub fn link_shared_states_from(&mut self, source: &OfdTable) -> Result<(), Errno> {
        for (index, ofd) in self.iter_mut() {
            let source_ofd = source.get(index).ok_or(Errno::EINVAL)?;
            if source_ofd.ofd_id != ofd.ofd_id {
                return Err(Errno::EINVAL);
            }
            ofd.link_shared_state(source_ofd.shared_state());
            // The evdev ring rides the same OFD identity as the offset:
            // re-share the parent's live ring so a buffered event is
            // delivered once across parent and child (Linux shares the
            // `struct evdev_client` behind a forked `struct file`). The
            // point-in-time ring rebuilt by fork deserialization is
            // discarded here, exactly as the offset scalar is.
            if let (Some(child_input), Some(source_input)) =
                (ofd.input_state.as_deref_mut(), source_ofd.input_state.as_deref())
            {
                child_input.ring = source_input.ring.clone();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_paths_and_shared_cwd_aliases_need_no_new_admission() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert_eq!(OfdPath::root(), b"/");
            assert_eq!(OfdPath::copy_from(b"/").unwrap(), b"/");
            assert_eq!(OfdPath::copy_from(b"").unwrap(), b"");
            assert!(matches!(OfdPath::copy_from(b"/tmp"), Err(Errno::ENOMEM)));
        }
        let path = OfdPath::copy_from(b"/tmp").unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            let alias = path.clone();
            assert_eq!(alias.as_slice().as_ptr(), path.as_slice().as_ptr());
            drop(path);
            assert_eq!(alias, b"/tmp");
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
            drop(alias);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn ofd_path_state_and_arena_refusal_each_leave_no_unpublished_owner() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let path = OfdPath::copy_from(b"/refusal").unwrap();
        let path_bytes = crate::io_buffer::IO_MEMORY.usage().0 - baseline;
        drop(path);
        let state = SharedOfdState::try_new(0, 0, 0).unwrap();
        let state_bytes = crate::io_buffer::IO_MEMORY.usage().0 - baseline;
        drop(state);
        for available in [0, path_bytes, path_bytes + state_bytes] {
            let mut table = OfdTable::new();
            let _limit = crate::io_buffer::test_budget(baseline + available);
            assert!(matches!(table.prepare(FileType::Regular, O_RDONLY, b"/refusal"), Err(Errno::ENOMEM)));
            assert_eq!(table.reserved_count(), 0);
            assert_eq!(table.iter().count(), 0);
            assert_eq!(table.entries.len(), 0);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn prepared_ofd_owns_path_state_and_slot_before_allocation_free_publication() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut table = OfdTable::new();
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert!(matches!(table.prepare(FileType::Regular, O_PATH, b"/prepared"), Err(Errno::ENOMEM)));
        }
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        let mut prepared = table.prepare(FileType::Regular, O_PATH, b"/prepared").unwrap();
        let index = prepared.index;
        let path = prepared.value.path.clone();
        let state = prepared.value.shared_state.clone();
        prepared.value_mut().set_offset(37);
        assert_eq!(table.iter().count(), 0);
        assert!(table.get(index).is_none());
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            assert_eq!(table.publish(prepared, 71), index);
            assert_eq!(table.get(index).unwrap().offset(), 37);
            assert!(matches!(table.try_clone(), Err(Errno::ENOMEM)));
            assert_eq!(table.iter().count(), 1);
        }
        assert!(table.dec_ref(index));
        drop(table);
        assert_eq!(path.as_slice(), b"/prepared");
        assert_eq!(state.offset(), 37);
        assert!(crate::io_buffer::IO_MEMORY.usage().0 > baseline);
        drop((path, state));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn prepared_ofd_reservations_are_distinct_cancellable_and_not_inherited() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut table = OfdTable::new();
        let first = table.prepare(FileType::Regular, 0, b"/first").unwrap();
        let second = table.prepare(FileType::Regular, 0, b"/second").unwrap();
        let first_index = first.index;
        let second_index = second.index;
        assert_ne!(first_index, second_index);
        let child = table.try_clone().unwrap();
        assert_eq!(child.iter().count(), 0);
        table.cancel(first);
        let replacement = table.prepare(FileType::Regular, 0, b"/replacement").unwrap();
        assert_eq!(replacement.index, first_index);
        assert_eq!(table.publish(second, 31), second_index);
        assert_eq!(table.publish(replacement, 32), first_index);
        assert_eq!(table.iter().count(), 2);
        drop((table, child));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }
    use wasm_posix_shared::flags::*;

    #[test]
    fn queued_identity_growth_is_admitted_and_final_release_reclaims_capacity() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut refs = IoBuffer::new();
        let first = OfdId(17);
        let second = OfdId(29);
        assert_eq!(retain_queued_reference(&mut refs, OfdId(0)), Err(Errno::EINVAL));
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert_eq!(retain_queued_reference(&mut refs, first), Err(Errno::ENOMEM));
        }
        assert!(refs.is_empty());
        retain_queued_reference(&mut refs, first).unwrap();
        let old = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(old);
            retain_queued_reference(&mut refs, first).unwrap();
            assert_eq!(retain_queued_reference(&mut refs, second), Err(Errno::ENOMEM));
            assert_eq!(&*refs, &[(first, 2)]);
        }
        retain_queued_reference(&mut refs, second).unwrap();
        assert_eq!(&*refs, &[(first, 2), (second, 1)]);
        assert!(!release_queued_reference(&mut refs, first));
        assert!(release_queued_reference(&mut refs, first));
        assert!(release_queued_reference(&mut refs, second));
        assert_eq!(refs.capacity(), 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        retain_queued_reference(&mut refs, second).unwrap();
        assert!(release_queued_reference(&mut refs, second));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn queued_identity_refcount_overflow_does_not_change_ownership() {
        let mut refs = IoBuffer::new();
        retain_queued_reference(&mut refs, OfdId(31)).unwrap();
        refs[0].1 = u32::MAX;
        assert_eq!(retain_queued_reference(&mut refs, OfdId(31)), Err(Errno::EOVERFLOW));
        assert_eq!(refs[0].1, u32::MAX);
        refs[0].1 = 1;
        assert!(release_queued_reference(&mut refs, OfdId(31)));
    }

    #[test]
    fn inheritance_plan_counts_only_visible_aliases_and_releases_owned_capacity() {
        use crate::fd::OpenFileDescRef;
        use wasm_posix_shared::fd_flags::FD_CLOFORK;
        let mut table = OfdTable::new();
        let first = table.create(FileType::Regular, O_RDONLY, 41, Vec::new());
        let second = table.create(FileType::Regular, O_RDONLY, 43, Vec::new());
        let retry_only = table.create(FileType::Regular, O_RDONLY, 47, Vec::new());
        let mut fds = FdTable::new();
        fds.alloc(OpenFileDescRef(second), 0).unwrap();
        fds.alloc(OpenFileDescRef(first), FD_CLOFORK).unwrap();
        fds.alloc(OpenFileDescRef(first), 0).unwrap();
        fds.alloc(OpenFileDescRef(first), 0).unwrap();
        fds.reserve().unwrap();
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert!(matches!(InheritedOfdRefs::prepare(&table, &fds, FD_CLOFORK), Err(Errno::ENOMEM)));
        }
        let plan = InheritedOfdRefs::prepare(&table, &fds, FD_CLOFORK).unwrap();
        assert_eq!(plan.descriptor_count, 3);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan.count(first), 2);
        assert_eq!(plan.count(second), 1);
        assert_eq!(plan.count(retry_only), 0);
        assert_eq!(plan.count(usize::MAX), 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline + plan.counts.capacity() * core::mem::size_of::<(usize, u32)>() * 2);
        drop(plan);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn inheritance_preparation_refusal_does_not_rewrite_any_local_reference() {
        let mut table = OfdTable::new();
        let inherited = table.create(FileType::Regular, O_RDONLY, 53, Vec::new());
        let retry_only = table.create(FileType::Regular, O_RDONLY, 59, Vec::new());
        let retired_bytes = table.get(retry_only).unwrap().shared_state.0.admitted_bytes();
        table.inc_ref(inherited);
        let mut fds = FdTable::new();
        fds.alloc(crate::fd::OpenFileDescRef(inherited), 0).unwrap();
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert_eq!(table.retain_fd_references(&fds), Err(Errno::ENOMEM));
        }
        assert_eq!(table.get(inherited).unwrap().ref_count, 2);
        assert_eq!(table.get(retry_only).unwrap().ref_count, 1);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        table.retain_fd_references(&fds).unwrap();
        assert_eq!(table.get(inherited).unwrap().ref_count, 1);
        assert!(table.get(retry_only).is_none());
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline - retired_bytes);
    }

    #[test]
    fn test_create_ofd() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR | O_APPEND, 42, b"/test".to_vec());
        assert_eq!(idx, 0);

        let ofd = table.get(idx).expect("OFD should exist at index 0");
        assert_eq!(ofd.file_type, FileType::Regular);
        assert_eq!(ofd.status_flags(), O_RDWR | O_APPEND);
        assert_eq!(ofd.host_handle, 42);
        assert_ne!(ofd.ofd_id.0, 0);
        assert_eq!(ofd.file_id, None);
        assert_eq!(ofd.offset(), 0);
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
    fn inherited_table_counts_only_real_fd_aliases() {
        let mut table = OfdTable::new();
        let inherited = table.create(FileType::Regular, O_RDONLY, 11, Vec::new());
        let retry_only = table.create(FileType::Regular, O_RDONLY, 12, Vec::new());
        table.inc_ref(inherited);
        table.inc_ref(inherited);
        table.inc_ref(retry_only);

        let mut fds = FdTable::new();
        fds.alloc(crate::fd::OpenFileDescRef(inherited), 0)
            .unwrap();
        fds.alloc(crate::fd::OpenFileDescRef(inherited), 0)
            .unwrap();

        table.retain_fd_references(&fds).unwrap();
        assert_eq!(table.get(inherited).unwrap().ref_count, 2);
        assert!(table.get(retry_only).is_none());
    }

    #[test]
    fn inherited_table_rejects_a_dangling_fd_without_partial_rewrite() {
        let mut table = OfdTable::new();
        let retained = table.create(FileType::Regular, O_RDONLY, 13, Vec::new());
        table.inc_ref(retained);

        let mut fds = FdTable::new();
        fds.alloc(crate::fd::OpenFileDescRef(99), 0).unwrap();

        assert_eq!(table.retain_fd_references(&fds), Err(Errno::EBADF));
        assert_eq!(table.get(retained).unwrap().ref_count, 2);
    }

    #[test]
    fn test_set_status_flags_preserves_access_mode() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR | O_APPEND, 5, Vec::new());

        // Verify initial state: access mode is O_RDWR, O_APPEND is set
        let ofd = table.get(idx).unwrap();
        assert_eq!(ofd.status_flags() & O_ACCMODE, O_RDWR);
        assert_ne!(ofd.status_flags() & O_APPEND, 0);

        // set_status_flags with O_NONBLOCK (no O_APPEND, different access mode bits)
        // Per POSIX F_SETFL: access mode must be preserved, only O_APPEND/O_NONBLOCK modifiable
        table.set_status_flags(idx, O_NONBLOCK);

        let ofd = table.get(idx).unwrap();
        // Access mode should still be O_RDWR
        assert_eq!(ofd.status_flags() & O_ACCMODE, O_RDWR);
        // O_APPEND should be removed (caller did not include it)
        assert_eq!(ofd.status_flags() & O_APPEND, 0);
        // O_NONBLOCK should be added
        assert_ne!(ofd.status_flags() & O_NONBLOCK, 0);
    }

    #[test]
    fn test_slot_reuse() {
        let mut table = OfdTable::new();
        let idx0 = table.create(FileType::Regular, O_RDONLY, 1, Vec::new());
        assert_eq!(idx0, 0);
        let first_id = table.get(idx0).unwrap().ofd_id;

        // Free slot 0
        let freed = table.dec_ref(idx0);
        assert!(freed);

        // Create again; should reuse slot 0
        let idx_reused = table.create(FileType::Pipe, O_RDWR, 2, Vec::new());
        assert_eq!(idx_reused, 0);
        let ofd = table.get(idx_reused).unwrap();
        assert_eq!(ofd.file_type, FileType::Pipe);
        assert_eq!(ofd.host_handle, 2);
        assert_ne!(ofd.ofd_id, first_id);
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
                ofd_id: ofd.ofd_id,
                file_id: ofd.file_id,
                file_type: ofd.file_type,
                shared_state: ofd.shared_state(),
                host_handle: ofd.host_handle,
                ref_count: ofd.ref_count,
                path: ofd.path.clone(),
                dir_host_handle: -1,
                dir_synth_state: 0,
                dir_entry_offset: 0,
                dir_position_generation: 0,
                dir_pending_entry: None,
                dri_state: None,
                input_state: None,
            });
        }

        let rebuilt = OfdTable::from_raw(raw);
        assert_eq!(rebuilt.get(0).unwrap().host_handle, 10);
        assert_eq!(rebuilt.get(1).unwrap().host_handle, 30);
    }

    #[test]
    fn transferred_directories_preserve_cookie_without_aliasing_an_iterator() {
        let mut source = OfdTable::new();
        let source_idx = source.create(
            FileType::Directory,
            O_RDONLY,
            41,
            b"/transferred".to_vec(),
        );
        let source_ofd = source.get_mut(source_idx).unwrap();
        source_ofd.set_directory_offset(7);
        source_ofd.dir_host_handle = 99;
        source_ofd.dir_synth_state = 2;
        source_ofd.dir_entry_offset = 7;
        source_ofd.dir_pending_entry = Some(PendingDirEntry::new(123, 8, b"pending").unwrap());
        let source_snapshot = source_ofd.clone();

        let mut receiver = OfdTable::new();
        let received_idx = receiver.create_transferred(
            source_snapshot.ofd_id,
            source_snapshot.file_id,
            source_snapshot.file_type,
            source_snapshot.status_flags(),
            source_snapshot.host_handle,
            source_snapshot.offset(),
            source_snapshot.shared_state(),
            source_snapshot.path.clone(),
        );
        let received = receiver.get(received_idx).unwrap();
        assert_eq!(received.ofd_id, source_snapshot.ofd_id);
        assert_eq!(received.offset(), 7);
        assert_eq!(received.dir_entry_offset, 7);
        assert_eq!(received.dir_synth_state, 2);
        assert_eq!(received.dir_host_handle, -1);
        assert!(received.dir_pending_entry.is_none());

        // Reconstructing the recipient must not mutate or take ownership of
        // the sender's live iterator or staged record.
        let source = source.get(source_idx).unwrap();
        assert_eq!(source.dir_host_handle, 99);
        assert_eq!(source.dir_pending_entry.as_ref().unwrap().name(), b"pending");
    }

    #[test]
    fn transferred_kernel_directories_keep_their_sentinel_and_cookie() {
        for sentinel in [
            crate::devfs::DEVFS_DIR_HANDLE,
            crate::procfs::PROCFS_DIR_HANDLE,
        ] {
            let mut source = OfdTable::new();
            let source_idx = source.create(
                FileType::Directory,
                O_RDONLY,
                sentinel,
                b"/virtual".to_vec(),
            );
            let ofd_id = source.get(source_idx).unwrap().ofd_id;
            let mut table = OfdTable::new();
            let idx = table.create_transferred(
                ofd_id,
                None,
                FileType::Directory,
                O_RDONLY,
                sentinel,
                5,
                SharedOfdState::new(O_RDONLY, 5, 0),
                b"/virtual".to_vec(),
            );
            let ofd = table.get(idx).unwrap();
            assert_eq!(ofd.dir_host_handle, sentinel);
            assert_eq!(ofd.dir_entry_offset, 5);
            assert_eq!(ofd.dir_synth_state, 2);
        }
    }

    #[test]
    fn from_raw_advances_ofd_identity_high_water() {
        let mut original = OfdTable::new();
        let idx = original.create(FileType::Regular, O_RDONLY, 10, b"/a".to_vec());
        let mut restored_ofd = original.get(idx).unwrap().clone();
        let observed = OfdId(restored_ofd.ofd_id.0.checked_add(10_000).unwrap());
        restored_ofd.ofd_id = observed;

        let restored = OfdTable::from_raw(alloc::vec![Some(restored_ofd)]);
        assert_eq!(restored.get(0).unwrap().ofd_id, observed);

        let mut later = OfdTable::new();
        let later_idx = later.create(FileType::Regular, O_RDONLY, 11, b"/b".to_vec());
        assert!(later.get(later_idx).unwrap().ofd_id > observed);
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
    fn graphics_clone_rolls_back_nodes_and_prepares_future_completions() {
        let mut dri = DriFdState::default();
        for handle in 1..=4 {
            dri.handles.try_insert_io(handle, handle + 100).unwrap();
        }
        dri.next_handle = 5;
        let mut kms = KmsFdState::default();
        kms.fbs.try_insert_io(1, KmsFb { bo_id: 101, width: 8, height: 8,
            pixel_format: 0, stride: 32 }).unwrap();
        kms.next_fb_id = 1;
        kms.event_ring.try_reserve(2).unwrap();
        kms.event_ring.extend_from_slice(&[7, 8]);
        kms.prepare_flip().unwrap();
        kms.pending_flips.push(PendingFlip { crtc_id: 1, fb_id: 1, user_data: 0x1234 });
        let source = DriOfdState::Card { dri, kms };
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        for successful_nodes in [0, 1, 3, 4] {
            crate::prepared_map::fail_after_allocations(successful_nodes);
            let result = source.try_clone();
            crate::prepared_map::fail_after_allocations(usize::MAX);
            assert!(matches!(result, Err(Errno::ENOMEM)));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
        let mut proc = crate::process::Process::new(1);
        let index = proc.ofd_table.create(FileType::CharDevice, O_RDWR, -9, b"/dev/dri/card0".to_vec());
        proc.ofd_table.get_mut(index).unwrap().dri_state =
            Some(crate::IoBox::try_new(source.try_clone().unwrap()).unwrap());
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            crate::dri::drain_pending_flips_for_process(&mut proc, 19, 2, 3);
            let kms = proc.ofd_table.get_mut(index).unwrap().kms_mut().unwrap();
            assert!(kms.pending_flips.is_empty());
            assert_eq!(kms.event_ring.len(), 34);
            assert_eq!(kms.event_ring.pop_front(), Some(7));
            assert_eq!(kms.event_ring.pop_front(), Some(8));
            let mut event = [0u8; 32];
            for byte in &mut event { *byte = kms.event_ring.pop_front().unwrap(); }
            assert_eq!(u64::from_le_bytes(event[8..16].try_into().unwrap()), 0x1234);
            assert_eq!(u32::from_le_bytes(event[24..28].try_into().unwrap()), 19);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        }
        drop(proc);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        let DriOfdState::Card { dri, kms } = source else { unreachable!() };
        assert_eq!(dri.handles.len(), 4);
        assert_eq!(kms.pending_flips.len(), 1);
        assert_eq!(kms.event_ring.len(), 2);
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
    fn ofd_default_has_no_input_state() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::CharDevice, O_RDONLY, -10, b"/dev/input/event0".to_vec());
        let ofd = table.get(idx).unwrap();
        assert!(ofd.input_state.is_none());
        assert!(ofd.input().is_none());
    }

    #[test]
    fn input_accessors_route_to_attached_state() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::CharDevice, O_RDONLY, -10, b"/dev/input/event0".to_vec());
        table.get_mut(idx).unwrap().input_state = Some(Box::new(InputFdState {
            device: 0,
            ..Default::default()
        }));

        let st = table.get(idx).unwrap().input().unwrap();
        assert_eq!(st.device, 0);
        {
            let ring = st.ring.borrow();
            assert!(!ring.dropped);
            assert!(ring.event_ring.is_empty());
        }

        let st = table.get_mut(idx).unwrap().input_mut().unwrap();
        st.ring.borrow_mut().event_ring.push_back(0xab);
        assert_eq!(
            table.get(idx).unwrap().input().unwrap().ring.borrow().event_ring.len(),
            1
        );
    }

    #[test]
    fn shared_input_ring_admission_and_payload_credit_follow_the_last_alias() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        for allowance in [0, 2 * INPUT_RING_MAX_BYTES] {
            let _limit = crate::io_buffer::test_budget(baseline + allowance);
            assert!(matches!(SharedInputRing::try_new(), Err(Errno::ENOMEM)));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
        let ring = SharedInputRing::try_new().unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        assert!(held > baseline + 2 * INPUT_RING_MAX_BYTES);
        let _limit = crate::io_buffer::test_budget(held);
        let alias = ring.clone();
        drop(ring);
        for _ in 0..INPUT_RING_MAX_RECORDS {
            let mut payload = alias.borrow_mut();
            for value in 0..24 { payload.event_ring.push_back(value); }
        }
        assert_eq!(alias.borrow().event_ring.len(), INPUT_RING_MAX_BYTES);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        drop(alias);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn input_ring_cap_bytes_is_24_kib() {
        // Lock the per-fd memory budget so it cannot drift silently.
        assert_eq!(INPUT_RING_MAX_RECORDS, 1024);
        assert_eq!(INPUT_RING_MAX_BYTES, 24 * 1024);
    }

    #[test]
    fn inherited_host_handle_plan_prepares_all_nodes_before_reference_publication() {
        const FIRST: i64 = 910_001;
        const EXISTING: i64 = 910_002;
        const LAST: i64 = 910_003;
        let mut table = OfdTable::new();
        for handle in [FIRST, EXISTING, FIRST, LAST] {
            table.create(FileType::Regular, O_RDONLY, handle, Vec::new());
        }
        let before_refs = crate::io_buffer::IO_MEMORY.usage().0;
        host_handle_fork_ref(EXISTING).unwrap();
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert!(matches!(PreparedHostHandleRefs::prepare(&table), Err(Errno::ENOMEM)));
        }
        crate::prepared_map::fail_after_allocations(1);
        let result = PreparedHostHandleRefs::prepare(&table);
        crate::prepared_map::fail_after_allocations(usize::MAX);
        assert!(matches!(result, Err(Errno::ENOMEM)));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        assert_eq!(host_handle_ref_count(FIRST), 0);
        assert_eq!(host_handle_ref_count(EXISTING), 2);
        assert_eq!(host_handle_ref_count(LAST), 0);
        let prepared = PreparedHostHandleRefs::prepare(&table).unwrap();
        {
            let held = crate::io_buffer::IO_MEMORY.usage().0;
            let _limit = crate::io_buffer::test_budget(held);
            prepared.publish();
        }
        assert_eq!(host_handle_ref_count(FIRST), 3);
        assert_eq!(host_handle_ref_count(EXISTING), 3);
        assert_eq!(host_handle_ref_count(LAST), 2);
        for (handle, count) in [(FIRST, 3), (EXISTING, 3), (LAST, 2)] {
            for remaining in (0..count).rev() {
                assert_eq!(host_handle_close_ref(handle), remaining == 0);
            }
            assert_eq!(host_handle_ref_count(handle), 0);
        }
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before_refs);
    }

    #[test]
    fn inherited_directory_keeps_parent_pending_bytes_without_cloning_them() {
        let mut table = OfdTable::new();
        let index = table.create(FileType::Directory, O_RDONLY, 19, b"/directory".to_vec());
        let ofd = table.get_mut(index).unwrap();
        ofd.set_directory_offset(2);
        ofd.dir_host_handle = 71;
        ofd.dir_synth_state = 2;
        ofd.dir_entry_offset = 2;
        ofd.dir_pending_entry = Some(PendingDirEntry::new(42, 8, b"pending").unwrap());
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let child_arena = 2 * core::mem::size_of::<OfdSlot>();
        let _limit = crate::io_buffer::test_budget(baseline + child_arena);
        let child = table.try_clone().unwrap();
        let inherited = child.get(index).unwrap();
        assert_eq!(inherited.dir_host_handle, -1);
        assert_eq!(inherited.dir_entry_offset, 2);
        assert!(inherited.dir_pending_entry.is_none());
        assert_eq!(table.get(index).unwrap().dir_pending_entry.as_ref().unwrap().name(), b"pending");
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline + child_arena);
        drop(child);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
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
            ofd.set_offset((i as i64) * 100);
            visited.push((i, ofd.host_handle));
        }
        assert_eq!(visited, vec![(0, 1), (2, 3)]);
        assert_eq!(table.get(0).unwrap().offset(), 0);
        assert_eq!(table.get(2).unwrap().offset(), 200);
    }
}
