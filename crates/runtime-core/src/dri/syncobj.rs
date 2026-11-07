//! DRM sync objects (`drivers/gpu/drm/drm_syncobj.c`), binary and timeline.
//!
//! A sync object is a container for a fence that a DRM file names by a
//! handle. Binary use replaces the fence (`SIGNAL`, `RESET`, a sync_file
//! import); timeline use appends points to a fence chain (`TIMELINE_SIGNAL`,
//! `TRANSFER` to a point), and a point is complete once it and every earlier
//! point have signaled. Handles belong to the DRM open file description (a
//! `dup`, `fork` or `SCM_RIGHTS` copy of the file shares them); a sync object
//! itself crosses to another file through a syncobj fd
//! (`HANDLE_TO_FD`/`FD_TO_HANDLE`) or a `sync_file` export/import.
//!
//! Waits keep Linux's snapshot rule: the fences a wait observes are the ones
//! its sync objects held when it began (or, with `WAIT_FOR_SUBMIT`, the first
//! fence attached afterwards); resetting or replacing a sync object's fence
//! does not change a wait already in progress. A blocking wait parks on the
//! host's EAGAIN retry path; the per-task record that carries its snapshot
//! across retries is dropped when the call completes, a handler signal
//! interrupts it, or its task or process goes away.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::rc::{Rc, Weak};
use alloc::vec::Vec;
use core::cell::RefCell;
use core::fmt;

use wasm_posix_shared::Errno;
use wasm_posix_shared::dri_sync::*;

use super::fence::Fence;
use super::sync_file::SyncFile;
use crate::process::{HostIO, Process};

/// `DRM_SYNCOBJ_WAIT_FOR_SUBMIT_TIMEOUT`: how long `drm_syncobj_find_fence`
/// waits for a fence to be submitted (a `TRANSFER` with `WAIT_FOR_SUBMIT`).
const WAIT_FOR_SUBMIT_TIMEOUT_NS: i64 = 5_000_000_000;

/// An eventfd reference held by a registered `SYNCOBJ_EVENTFD`
/// (`eventfd_ctx_fdget`). Dropping it releases the eventfd's backing.
pub struct EventfdRef(i64);

impl EventfdRef {
    fn acquire(handle: i64) -> Result<Self, Errno> {
        let owned = crate::descriptor_backing::add_ref_for_ofd(crate::ofd::FileType::EventFd,
            handle)?;
        assert!(owned, "an eventfd OFD always owns a descriptor backing");
        Ok(Self(handle))
    }

    /// `eventfd_signal`: add one and wake readers.
    fn signal(&self) {
        let handle = self.0;
        let idx = (-(handle + 1)) as usize;
        let live = crate::descriptor_backing::with_eventfds(|table| match table.get_mut(idx) {
            Some(efd) => {
                efd.counter = efd.counter.saturating_add(1).min(u64::MAX - 1);
                true
            }
            None => false,
        });
        assert!(live, "a referenced eventfd backing is live");
        use wasm_posix_shared::epoll::{EPOLLIN, EPOLLRDNORM};
        crate::epoll::notify(crate::epoll::Source::Backing(crate::ofd::FileType::EventFd, handle),
            EPOLLIN | EPOLLRDNORM);
        super::fence::raise_wake();
    }
}

impl Drop for EventfdRef {
    fn drop(&mut self) {
        crate::descriptor_backing::release_for_ofd(crate::ofd::FileType::EventFd, self.0);
    }
}

/// A `SYNCOBJ_EVENTFD` registration still waiting for its point's fence.
struct EventfdEntry {
    point: u64,
    flags: u32,
    eventfd: EventfdRef,
}

struct SyncobjInner {
    id: u64,
    fence: RefCell<Option<Fence>>,
    eventfds: RefCell<Vec<EventfdEntry>>,
}

/// One sync object; every handle and syncobj fd holds a clone.
#[derive(Clone)]
pub struct Syncobj(Rc<SyncobjInner>);

impl fmt::Debug for Syncobj {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Syncobj(#{} {:?})", self.0.id, self.0.fence.borrow())
    }
}

/// A wait in progress, carried across the host's EAGAIN retries.
struct PendingWait {
    pid: u32,
    tid: u32,
    request: u32,
    args: Vec<u8>,
    entries: Vec<WaitEntry>,
    /// `first_signaled` as the first pass found it.
    first: u32,
    /// For a `TRANSFER` waiting for submission: when it gives up.
    deadline_ns: i64,
}

struct WaitEntry {
    syncobj: Syncobj,
    point: u64,
    fence: Option<Fence>,
}

struct Globals {
    next_id: u64,
    live: BTreeMap<u64, Weak<SyncobjInner>>,
    waits: Vec<PendingWait>,
    /// Eventfd registrations whose fence is known, waiting for it to signal.
    armed: Vec<(Fence, EventfdRef)>,
}

impl Globals {
    const fn new() -> Self {
        Self { next_id: 1, live: BTreeMap::new(), waits: Vec::new(), armed: Vec::new() }
    }
}

#[cfg(not(test))]
struct GlobalCell(RefCell<Globals>);
#[cfg(not(test))]
unsafe impl Sync for GlobalCell {}
#[cfg(not(test))]
static GLOBALS: GlobalCell = GlobalCell(RefCell::new(Globals::new()));
#[cfg(test)]
std::thread_local! {
    static GLOBALS: RefCell<Globals> = const { RefCell::new(Globals::new()) };
}

/// For destructors: a test thread's storage may already be torn down when
/// its last objects drop at thread exit; nothing is left to update then.
fn with_globals_on_drop(f: impl FnOnce(&mut Globals)) {
    #[cfg(not(test))]
    { f(&mut GLOBALS.0.borrow_mut()) }
    #[cfg(test)]
    { let _ = GLOBALS.try_with(|g| f(&mut g.borrow_mut())); }
}

fn with_globals<R>(f: impl FnOnce(&mut Globals) -> R) -> R {
    #[cfg(not(test))]
    { f(&mut GLOBALS.0.borrow_mut()) }
    #[cfg(test)]
    { GLOBALS.with(|g| f(&mut g.borrow_mut())) }
}

impl Drop for SyncobjInner {
    fn drop(&mut self) {
        let id = self.id;
        with_globals_on_drop(|g| { g.live.remove(&id); });
    }
}

impl Syncobj {
    pub fn new() -> Self {
        let id = with_globals(|g| {
            let id = g.next_id;
            g.next_id = g.next_id.checked_add(1).expect("syncobj id space exhausted");
            id
        });
        let obj = Syncobj(Rc::new(SyncobjInner { id, fence: RefCell::new(None),
            eventfds: RefCell::new(Vec::new()) }));
        with_globals(|g| { g.live.insert(id, Rc::downgrade(&obj.0)); });
        obj
    }

    /// The live sync object with this identity (fork reconstruction).
    pub fn lookup(id: u64) -> Option<Self> {
        with_globals(|g| g.live.get(&id).and_then(Weak::upgrade)).map(Syncobj)
    }

    pub fn id(&self) -> u64 { self.0.id }
    pub fn ptr_eq(&self, other: &Syncobj) -> bool { Rc::ptr_eq(&self.0, &other.0) }

    /// `drm_syncobj_fence_get`.
    pub fn fence(&self) -> Option<Fence> {
        self.0.fence.borrow().clone()
    }

    /// `drm_syncobj_replace_fence`.
    pub fn replace_fence(&self, fence: Option<Fence>, now_ns: i64) {
        let changed = {
            let current = self.0.fence.borrow();
            match (&*current, &fence) {
                (Some(a), Some(b)) => !a.ptr_eq(b),
                (None, None) => false,
                _ => true,
            }
        };
        let old = self.0.fence.replace(fence);
        if changed {
            self.fence_attached(now_ns);
        }
        drop(old);
    }

    /// `drm_syncobj_add_point`.
    pub fn add_point(&self, fence: Fence, point: u64, now_ns: i64) {
        let prev = self.fence();
        let chain = Fence::chain(prev, fence, point);
        let old = self.0.fence.replace(Some(chain));
        self.fence_attached(now_ns);
        drop(old);
    }

    /// The fence that completes `point`, as a waiter or an eventfd captures
    /// it: `None` while the point is unsubmitted.
    fn capture(&self, point: u64, now_ns: i64) -> Option<Fence> {
        match self.fence()?.find_seqno(point) {
            Ok(Some(fence)) => Some(fence),
            // Already signaled: a fresh stub still lets the waiter finish.
            Ok(None) => Some(Fence::stub(now_ns)),
            Err(()) => None,
        }
    }

    /// The sync object's fence changed: give waits that were waiting for a
    /// submission, and eventfds waiting for this point, their fence
    /// (`syncobj_wait_syncobj_func` / `syncobj_eventfd_entry_func`).
    fn fence_attached(&self, now_ns: i64) {
        with_globals(|g| {
            for wait in &mut g.waits {
                for entry in &mut wait.entries {
                    if entry.fence.is_none() && entry.syncobj.ptr_eq(self) {
                        entry.fence = self.capture(entry.point, now_ns);
                        if let Some(fence) = &entry.fence {
                            fence.enable_signaling();
                        }
                    }
                }
            }
        });
        let mut ready = Vec::new();
        {
            let mut entries = self.0.eventfds.borrow_mut();
            let mut i = 0;
            while i < entries.len() {
                match self.capture(entries[i].point, now_ns) {
                    Some(fence) => ready.push((entries.remove(i), fence)),
                    None => i += 1,
                }
            }
        }
        for (entry, fence) in ready {
            arm_eventfd(entry, fence);
        }
        // A wait for submission or availability may now finish.
        super::fence::raise_wake();
    }
}

/// An eventfd registration whose fence is known: signal now for
/// `WAIT_AVAILABLE` or a signaled fence, otherwise when the fence signals.
fn arm_eventfd(entry: EventfdEntry, fence: Fence) {
    if entry.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE != 0 || fence.is_signaled() {
        entry.eventfd.signal();
        return;
    }
    fence.enable_signaling();
    with_globals(|g| g.armed.push((fence, entry.eventfd)));
}

/// A fence signaled: fire every armed eventfd whose fence is now complete.
pub(crate) fn fire_armed_eventfds() {
    let due = with_globals(|g| {
        if g.armed.is_empty() {
            return Vec::new();
        }
        let mut due = Vec::new();
        let mut i = 0;
        while i < g.armed.len() {
            if g.armed[i].0.is_signaled() {
                due.push(g.armed.remove(i));
            } else {
                i += 1;
            }
        }
        due
    });
    for (fence, eventfd) in due {
        eventfd.signal();
        drop(fence);
    }
}

/// A handler signal interrupted `tid`'s parked wait, or the task exited:
/// its snapshot must not outlive the call.
pub fn forget_task(pid: u32, tid: u32) {
    let dropped = with_globals(|g| {
        let mut dropped = Vec::new();
        let mut i = 0;
        while i < g.waits.len() {
            if g.waits[i].pid == pid && g.waits[i].tid == tid {
                dropped.push(g.waits.remove(i));
            } else {
                i += 1;
            }
        }
        dropped
    });
    drop(dropped);
}

/// The process image is gone: drop every wait snapshot it owned.
pub fn forget_process(pid: u32) {
    let dropped = with_globals(|g| {
        let (gone, kept): (Vec<_>, Vec<_>) =
            core::mem::take(&mut g.waits).into_iter().partition(|w| w.pid == pid);
        g.waits = kept;
        gone
    });
    drop(dropped);
}

#[cfg(test)]
pub(crate) fn pending_wait_count() -> usize {
    with_globals(|g| g.waits.len())
}

// ── Per-file handle namespace ─────────────────────────────────────────────

/// The sync-object handles of one DRM open file description
/// (`drm_file.syncobj_idr`). Shared by every alias of the description.
#[derive(Clone, Default)]
pub struct SharedSyncobjs(Rc<RefCell<BTreeMap<u32, Syncobj>>>);

impl fmt::Debug for SharedSyncobjs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SharedSyncobjs({} handles)", self.0.borrow().len())
    }
}

/// A non-owning reference to a handle namespace (SCM_RIGHTS snapshots).
#[derive(Clone)]
pub struct WeakSyncobjs(Weak<RefCell<BTreeMap<u32, Syncobj>>>);

impl WeakSyncobjs {
    pub fn upgrade(&self) -> Option<SharedSyncobjs> {
        self.0.upgrade().map(SharedSyncobjs)
    }
}

impl SharedSyncobjs {
    pub fn downgrade(&self) -> WeakSyncobjs {
        WeakSyncobjs(Rc::downgrade(&self.0))
    }

    pub fn ptr_eq(&self, other: &SharedSyncobjs) -> bool { Rc::ptr_eq(&self.0, &other.0) }

    pub fn len(&self) -> usize { self.0.borrow().len() }

    pub fn get(&self, handle: u32) -> Option<Syncobj> {
        self.0.borrow().get(&handle).cloned()
    }

    /// `idr_alloc(.., 1, 0, ..)`: the lowest free handle from 1.
    pub fn insert(&self, obj: Syncobj) -> Result<u32, Errno> {
        let mut map = self.0.borrow_mut();
        let mut handle = 1u32;
        for &used in map.keys() {
            if used != handle {
                break;
            }
            handle = handle.checked_add(1).filter(|&h| h <= i32::MAX as u32)
                .ok_or(Errno::ENOSPC)?;
        }
        map.insert(handle, obj);
        Ok(handle)
    }

    pub fn remove(&self, handle: u32) -> Option<Syncobj> {
        let removed = self.0.borrow_mut().remove(&handle);
        removed
    }
}

// ── Descriptors ───────────────────────────────────────────────────────────

/// `drm_syncobj_get_fd`: a new close-on-exec syncobj fd.
fn install_fd(proc: &mut Process, obj: Syncobj) -> Result<i32, Errno> {
    let path = alloc::format!("anon_inode:syncobj_file:{}", obj.id()).into_bytes();
    let ofd = proc.ofd_table.create(crate::ofd::FileType::CharDevice,
        wasm_posix_shared::flags::O_RDONLY, crate::ofd::SYNCOBJ_FD_HOST_HANDLE, path);
    proc.ofd_table.get_mut(ofd).expect("fresh OFD").dri_state =
        Some(alloc::boxed::Box::new(crate::ofd::DriOfdState::Syncobj(obj)));
    match proc.fd_table.alloc(crate::fd::OpenFileDescRef(ofd), wasm_posix_shared::fd_flags::FD_CLOEXEC) {
        Ok(fd) => Ok(fd),
        Err(e) => {
            proc.ofd_table.dec_ref(ofd);
            Err(e)
        }
    }
}

fn syncobj_from_fd(proc: &Process, fd: i32) -> Option<Syncobj> {
    let entry = proc.fd_table.get(fd).ok()?;
    match proc.ofd_table.get(entry.ofd_ref.0)?.dri_state.as_deref()? {
        crate::ofd::DriOfdState::Syncobj(obj) => Some(obj.clone()),
        _ => None,
    }
}

// ── ioctls ────────────────────────────────────────────────────────────────

/// Copy the caller's argument into a zero-filled full-size struct, as
/// `drm_ioctl` does for a request encoded with an older, shorter layout.
fn read_args<T: Copy + Default>(buf: &[u8]) -> T {
    let mut value = T::default();
    let size = core::mem::size_of::<T>();
    let n = buf.len().min(size);
    unsafe {
        core::ptr::copy_nonoverlapping(buf.as_ptr(), (&mut value as *mut T).cast::<u8>(), n);
    }
    value
}

/// Copy back only the bytes the caller's encoding has.
fn write_args<T: Copy>(buf: &mut [u8], value: &T) {
    let size = core::mem::size_of::<T>();
    let n = buf.len().min(size);
    unsafe {
        core::ptr::copy_nonoverlapping((value as *const T).cast::<u8>(), buf.as_mut_ptr(), n);
    }
}

fn read_array<const N: usize>(host: &mut dyn HostIO, pid: i32, pointer: u64, count: u32)
    -> Result<Vec<[u8; N]>, Errno> {
    let len = (count as usize).checked_mul(N).ok_or(Errno::ENOMEM)?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(len).map_err(|_| Errno::ENOMEM)?;
    bytes.resize(len, 0);
    if host.proc_read_bytes(pid, pointer, &mut bytes) < 0 {
        return Err(Errno::EFAULT);
    }
    Ok(bytes.chunks_exact(N).map(|c| c.try_into().unwrap()).collect())
}

fn read_handles(host: &mut dyn HostIO, pid: i32, pointer: u64, count: u32) -> Result<Vec<u32>, Errno> {
    Ok(read_array::<4>(host, pid, pointer, count)?.into_iter().map(u32::from_le_bytes).collect())
}

fn read_points(host: &mut dyn HostIO, pid: i32, pointer: u64, count: u32) -> Result<Vec<u64>, Errno> {
    Ok(read_array::<8>(host, pid, pointer, count)?.into_iter().map(u64::from_le_bytes).collect())
}

/// `drm_syncobj_array_find`: every handle must name a sync object.
fn find_all(ns: &SharedSyncobjs, host: &mut dyn HostIO, pid: i32, pointer: u64, count: u32)
    -> Result<Vec<Syncobj>, Errno> {
    read_handles(host, pid, pointer, count)?.into_iter()
        .map(|h| ns.get(h).ok_or(Errno::ENOENT)).collect()
}

fn now_ns(host: &mut dyn HostIO) -> Result<i64, Errno> {
    super::sync_file::monotonic_now(host)
}

/// `drm_syncobj_find_fence` without waiting: `EINVAL` for an unsubmitted
/// point, a stub for one already signaled.
fn find_fence(obj: &Syncobj, point: u64, now_ns: i64) -> Result<Fence, Errno> {
    obj.capture(point, now_ns).ok_or(Errno::EINVAL)
}

/// Whether `request` is a sync-object ioctl this module serves.
pub fn is_syncobj_request(request: u32) -> bool {
    matches!(request,
        DRM_IOCTL_SYNCOBJ_CREATE | DRM_IOCTL_SYNCOBJ_DESTROY
        | DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD | DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD_V1
        | DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE | DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE_V1
        | DRM_IOCTL_SYNCOBJ_WAIT | DRM_IOCTL_SYNCOBJ_WAIT_V1
        | DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT | DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT_V1
        | DRM_IOCTL_SYNCOBJ_RESET | DRM_IOCTL_SYNCOBJ_SIGNAL | DRM_IOCTL_SYNCOBJ_QUERY
        | DRM_IOCTL_SYNCOBJ_TRANSFER | DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL
        | DRM_IOCTL_SYNCOBJ_EVENTFD)
}

/// One sync-object ioctl on the DRM file whose namespace is `ns`.
pub fn ioctl(proc: &mut Process, host: &mut dyn HostIO, ns: &SharedSyncobjs, request: u32,
    buf: &mut [u8]) -> Result<(), Errno> {
    let pid = proc.pid as i32;
    match request {
        DRM_IOCTL_SYNCOBJ_CREATE => {
            let mut args: DrmSyncobjCreate = read_args(buf);
            if args.flags & !DRM_SYNCOBJ_CREATE_SIGNALED != 0 {
                return Err(Errno::EINVAL);
            }
            let obj = Syncobj::new();
            if args.flags & DRM_SYNCOBJ_CREATE_SIGNALED != 0 {
                let now = now_ns(host)?;
                obj.replace_fence(Some(Fence::stub(now)), now);
            }
            args.handle = ns.insert(obj)?;
            write_args(buf, &args);
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_DESTROY => {
            let args: DrmSyncobjDestroy = read_args(buf);
            if args.pad != 0 {
                return Err(Errno::EINVAL);
            }
            ns.remove(args.handle).map(drop).ok_or(Errno::EINVAL)
        }
        DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD | DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD_V1 => {
            let mut args: DrmSyncobjHandle = read_args(buf);
            let valid = DRM_SYNCOBJ_HANDLE_TO_FD_FLAGS_TIMELINE
                | DRM_SYNCOBJ_HANDLE_TO_FD_FLAGS_EXPORT_SYNC_FILE;
            if args.pad != 0 || args.flags & !valid != 0 {
                return Err(Errno::EINVAL);
            }
            let point = if args.flags & DRM_SYNCOBJ_HANDLE_TO_FD_FLAGS_TIMELINE != 0 {
                args.point
            } else {
                0
            };
            if args.flags & DRM_SYNCOBJ_HANDLE_TO_FD_FLAGS_EXPORT_SYNC_FILE != 0 {
                let obj = ns.get(args.handle).ok_or(Errno::ENOENT)?;
                let fence = find_fence(&obj, point, now_ns(host)?)?;
                args.fd = super::sync_file::install_fd(proc, SyncFile::new(fence), true)?;
            } else {
                if args.point != 0 {
                    return Err(Errno::EINVAL);
                }
                let obj = ns.get(args.handle).ok_or(Errno::EINVAL)?;
                args.fd = install_fd(proc, obj)?;
            }
            write_args(buf, &args);
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE | DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE_V1 => {
            let mut args: DrmSyncobjHandle = read_args(buf);
            let valid = DRM_SYNCOBJ_FD_TO_HANDLE_FLAGS_TIMELINE
                | DRM_SYNCOBJ_FD_TO_HANDLE_FLAGS_IMPORT_SYNC_FILE;
            if args.pad != 0 || args.flags & !valid != 0 {
                return Err(Errno::EINVAL);
            }
            let point = if args.flags & DRM_SYNCOBJ_FD_TO_HANDLE_FLAGS_TIMELINE != 0 {
                args.point
            } else {
                0
            };
            if args.flags & DRM_SYNCOBJ_FD_TO_HANDLE_FLAGS_IMPORT_SYNC_FILE != 0 {
                let file = super::sync_file::from_fd(proc, args.fd).ok_or(Errno::EINVAL)?;
                let obj = ns.get(args.handle).ok_or(Errno::ENOENT)?;
                let now = now_ns(host)?;
                if point != 0 {
                    obj.add_point(file.fence().clone(), point, now);
                } else {
                    obj.replace_fence(Some(file.fence().clone()), now);
                }
                return Ok(());
            }
            if args.point != 0 {
                return Err(Errno::EINVAL);
            }
            let obj = syncobj_from_fd(proc, args.fd).ok_or(Errno::EINVAL)?;
            args.handle = ns.insert(obj)?;
            write_args(buf, &args);
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_WAIT | DRM_IOCTL_SYNCOBJ_WAIT_V1 => {
            let mut args: DrmSyncobjWait = read_args(buf);
            let possible = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL | DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT
                | DRM_SYNCOBJ_WAIT_FLAGS_WAIT_DEADLINE;
            if args.flags & !possible != 0 {
                return Err(Errno::EINVAL);
            }
            if args.count_handles == 0 {
                return Ok(());
            }
            let deadline = (args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_DEADLINE != 0)
                .then_some(args.deadline_nsec);
            let first = wait(proc, host, ns, request, buf, WaitRequest {
                handles: args.handles, points: None, count: args.count_handles,
                flags: args.flags, timeout_nsec: args.timeout_nsec, deadline })?;
            args.first_signaled = first;
            write_args(buf, &args);
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT | DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT_V1 => {
            let mut args: DrmSyncobjTimelineWait = read_args(buf);
            let possible = DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL | DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT
                | DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE | DRM_SYNCOBJ_WAIT_FLAGS_WAIT_DEADLINE;
            if args.flags & !possible != 0 {
                return Err(Errno::EINVAL);
            }
            if args.count_handles == 0 {
                return Ok(());
            }
            let deadline = (args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_DEADLINE != 0)
                .then_some(args.deadline_nsec);
            let first = wait(proc, host, ns, request, buf, WaitRequest {
                handles: args.handles, points: Some(args.points), count: args.count_handles,
                flags: args.flags, timeout_nsec: args.timeout_nsec, deadline })?;
            args.first_signaled = first;
            write_args(buf, &args);
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_RESET | DRM_IOCTL_SYNCOBJ_SIGNAL => {
            let args: DrmSyncobjArray = read_args(buf);
            if args.pad != 0 || args.count_handles == 0 {
                return Err(Errno::EINVAL);
            }
            let objs = find_all(ns, host, pid, args.handles, args.count_handles)?;
            let now = now_ns(host)?;
            for obj in objs {
                if request == DRM_IOCTL_SYNCOBJ_RESET {
                    obj.replace_fence(None, now);
                } else {
                    // drm_syncobj_assign_null_handle: a private signaled stub.
                    obj.replace_fence(Some(Fence::stub(now)), now);
                }
            }
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL => {
            let args: DrmSyncobjTimelineArray = read_args(buf);
            if args.flags != 0 || args.count_handles == 0 {
                return Err(Errno::EINVAL);
            }
            let objs = find_all(ns, host, pid, args.handles, args.count_handles)?;
            let points = read_points(host, pid, args.points, args.count_handles)?;
            let now = now_ns(host)?;
            for (obj, point) in objs.into_iter().zip(points) {
                if point == 0 {
                    obj.replace_fence(Some(Fence::stub(now)), now);
                } else {
                    obj.add_point(Fence::stub(now), point, now);
                }
            }
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_QUERY => {
            let args: DrmSyncobjTimelineArray = read_args(buf);
            if args.flags & !DRM_SYNCOBJ_QUERY_FLAGS_LAST_SUBMITTED != 0 || args.count_handles == 0 {
                return Err(Errno::EINVAL);
            }
            let objs = find_all(ns, host, pid, args.handles, args.count_handles)?;
            let last_submitted = args.flags & DRM_SYNCOBJ_QUERY_FLAGS_LAST_SUBMITTED != 0;
            for (i, obj) in objs.iter().enumerate() {
                let point = query_point(obj.fence(), last_submitted);
                let at = args.points.checked_add(8 * i as u64).ok_or(Errno::EFAULT)?;
                crate::syscalls::write_dri_bytes(host, pid, at, &point.to_le_bytes())?;
            }
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_TRANSFER => {
            let args: DrmSyncobjTransfer = read_args(buf);
            if args.pad != 0 {
                return Err(Errno::EINVAL);
            }
            let dst = ns.get(args.dst_handle).ok_or(Errno::ENOENT)?;
            if args.flags & !DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT != 0 {
                return Err(Errno::EINVAL);
            }
            let src = ns.get(args.src_handle).ok_or(Errno::ENOENT)?;
            let now = now_ns(host)?;
            let fence = find_fence_for_transfer(proc, request, buf, &src, args.src_point,
                args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT != 0, now)?;
            if args.dst_point != 0 {
                dst.add_point(Fence::merge(&[fence]), args.dst_point, now);
            } else {
                dst.replace_fence(Some(fence), now);
            }
            Ok(())
        }
        DRM_IOCTL_SYNCOBJ_EVENTFD => {
            let args: DrmSyncobjEventfd = read_args(buf);
            if args.flags & !DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE != 0 || args.pad != 0 {
                return Err(Errno::EINVAL);
            }
            let obj = ns.get(args.handle).ok_or(Errno::ENOENT)?;
            let entry = proc.fd_table.get(args.fd).map_err(|_| Errno::EBADF)?;
            let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
            if ofd.file_type != crate::ofd::FileType::EventFd {
                return Err(Errno::EINVAL);
            }
            let eventfd = EventfdRef::acquire(ofd.host_handle)?;
            let entry = EventfdEntry { point: args.point, flags: args.flags, eventfd };
            match obj.capture(entry.point, now_ns(host)?) {
                Some(fence) => arm_eventfd(entry, fence),
                None => obj.0.eventfds.borrow_mut().push(entry),
            }
            Ok(())
        }
        _ => Err(Errno::EINVAL),
    }
}

/// `drm_syncobj_query_ioctl`'s point for one sync object.
fn query_point(fence: Option<Fence>, last_submitted: bool) -> u64 {
    let Some(fence) = fence else { return 0 };
    if !fence.is_chain() {
        return 0;
    }
    if last_submitted {
        return fence.seqno();
    }
    let mut last = fence.clone();
    let mut iter = Some(fence.clone());
    while let Some(link) = iter {
        if link.context() != fence.context() {
            // Most likely an unordered point.
            break;
        }
        last = link.clone();
        iter = link.walk_prev();
    }
    if last.is_signaled() { last.seqno() } else { last.prev_seqno() }
}

struct WaitRequest {
    handles: u64,
    points: Option<u64>,
    count: u32,
    flags: u32,
    timeout_nsec: i64,
    deadline: Option<u64>,
}

fn take_wait(pid: u32, tid: u32, request: u32, args: &[u8]) -> Option<PendingWait> {
    let taken = with_globals(|g| {
        let at = g.waits.iter().position(|w| w.pid == pid && w.tid == tid)?;
        Some(g.waits.remove(at))
    });
    // A record for another request is stale: that call ended without us.
    taken.filter(|w| w.request == request && w.args == args)
}

fn park(wait: PendingWait) -> Errno {
    with_globals(|g| g.waits.push(wait));
    Errno::EAGAIN
}

/// `drm_syncobj_array_wait_timeout`: returns `first_signaled`.
fn wait(proc: &mut Process, host: &mut dyn HostIO, ns: &SharedSyncobjs, request: u32,
    buf: &[u8], req: WaitRequest) -> Result<u32, Errno> {
    let pid = proc.pid;
    let tid = crate::syscalls::current_tid_for_process(proc);
    let wait_all = req.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL != 0;
    let available = req.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE != 0;
    let now = now_ns(host)?;
    let mut state = match take_wait(pid, tid, request, buf) {
        Some(state) => state,
        None => {
            let objs = find_all(ns, host, pid as i32, req.handles, req.count)?;
            let points = match req.points {
                Some(pointer) if pointer != 0 => read_points(host, pid as i32, pointer, req.count)?,
                _ => alloc::vec![0; req.count as usize],
            };
            let mut entries = Vec::new();
            let mut first = u32::MAX;
            let mut signaled = 0;
            for (i, (obj, point)) in objs.into_iter().zip(points).enumerate() {
                let fence = obj.capture(point, now);
                if fence.is_none()
                    && req.flags & (DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT
                        | DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE) == 0
                {
                    return Err(Errno::EINVAL);
                }
                if fence.as_ref().is_some_and(|f| available || f.is_signaled()) {
                    if signaled == 0 {
                        first = i as u32;
                    }
                    signaled += 1;
                }
                if let (Some(deadline), Some(fence)) = (req.deadline, &fence) {
                    fence.set_deadline(deadline);
                }
                entries.push(WaitEntry { syncobj: obj, point, fence });
            }
            PendingWait { pid, tid, request, args: buf.to_vec(), entries, first, deadline_ns: 0 }
        }
    };
    let ready = |e: &WaitEntry| e.fence.as_ref().is_some_and(|f| available || f.is_signaled());
    if wait_all {
        if state.entries.iter().all(ready) {
            return Ok(state.first);
        }
    } else if let Some(i) = state.entries.iter().position(ready) {
        return Ok(i as u32);
    }
    // drm_timeout_abs_to_jiffies: a timeout at or before now polls once.
    if req.timeout_nsec <= now {
        return Err(Errno::ETIME);
    }
    for fence in state.entries.iter().filter_map(|e| e.fence.as_ref()) {
        fence.enable_signaling();
    }
    state.args = buf.to_vec();
    Err(park(state))
}

/// `drm_syncobj_find_fence` for `TRANSFER`. With `WAIT_FOR_SUBMIT` an
/// unsubmitted point parks until a fence is attached (the first one attached
/// is the one used, as Linux's wait callback captures it), for at most five
/// seconds (`ETIME` after).
fn find_fence_for_transfer(proc: &mut Process, request: u32, buf: &[u8], src: &Syncobj,
    point: u64, wait_for_submit: bool, now: i64) -> Result<Fence, Errno> {
    let pid = proc.pid;
    let tid = crate::syscalls::current_tid_for_process(proc);
    let state = match take_wait(pid, tid, request, buf) {
        Some(state) => state,
        None => match src.capture(point, now) {
            Some(fence) => return Ok(fence),
            None if !wait_for_submit => return Err(Errno::EINVAL),
            None => PendingWait { pid, tid, request, args: buf.to_vec(),
                entries: alloc::vec![WaitEntry { syncobj: src.clone(), point, fence: None }],
                first: 0, deadline_ns: now.saturating_add(WAIT_FOR_SUBMIT_TIMEOUT_NS) },
        },
    };
    if let Some(fence) = state.entries[0].fence.clone() {
        return Ok(fence);
    }
    if now >= state.deadline_ns {
        return Err(Errno::ETIME);
    }
    Err(park(state))
}
