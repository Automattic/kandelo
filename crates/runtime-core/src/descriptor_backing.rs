//! Kernel-global backings for descriptor types whose state belongs to an
//! open file description rather than to a process.
//!
//! Fork and spawn clone a process's FD/OFD tables.  The cloned OFDs retain a
//! stable negative handle into these tables, and each inherited OFD owns one
//! reference.  This keeps state coherent across processes and prevents a
//! newly-created descriptor in a child from reusing (and aliasing) an
//! inherited process-local slot.

extern crate alloc;

use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, Ordering};

use wasm_posix_shared::Errno;

use crate::ofd::FileType;
use crate::process::{EpollInstance, EventFdState, Process, SignalFdState, TimerFdState};

#[derive(Debug)]
struct SharedBacking<T> {
    refs: u32,
    /// Shared-mapping references (see [`SharedBackingTable::pin`]). Counted
    /// apart from `refs`, which is one per owning OFD and whose last release
    /// is the end of the description's lifetime.
    pins: u32,
    value: T,
    #[cfg(test)]
    generation: u64,
}

/// A stable-index table with one reference per owning OFD in each process.
pub struct SharedBackingTable<T> {
    entries: crate::IoBuffer<Option<SharedBacking<T>>>,
    #[cfg(test)]
    next_generation: u64,
}

#[must_use]
pub struct SharedBackingRelease<T> {
    pub final_reference: bool,
    pub value: Option<T>,
}

#[must_use]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct BackingReleaseEffects {
    pub final_ofd_reference: bool,
    host_closes: [Option<i64>; 2],
}

impl BackingReleaseEffects {
    pub(crate) fn push_host_close(&mut self, handle: i64) {
        let slot = self.host_closes.iter_mut().find(|slot| slot.is_none())
            .expect("regular backing release exceeded its two raw constituents");
        *slot = Some(handle);
    }

    pub fn into_host_closes(self) -> [Option<i64>; 2] { self.host_closes }

    pub fn close_with(self, host: &mut dyn crate::process::HostIO) -> Result<(), Errno> {
        let mut failure = None;
        for handle in self.host_closes.into_iter().flatten() {
            if let Err(error) = host.host_close(handle) { failure.get_or_insert(error); }
        }
        failure.map_or(Ok(()), Err)
    }
}

impl<T> SharedBackingTable<T> {
    fn new() -> Self {
        Self {
            entries: crate::IoBuffer::new(),
            #[cfg(test)]
            next_generation: 1,
        }
    }

    #[cfg(test)]
    pub fn alloc(&mut self, value: T) -> usize { self.try_alloc(value).unwrap() }

    pub fn try_alloc(&mut self, value: T) -> Result<usize, Errno> {
        let index = self.entries.iter().position(Option::is_none).unwrap_or(self.entries.len());
        if index == self.entries.len() { self.entries.try_reserve(1)?; }
        #[cfg(test)]
        let entry = {
            let generation = self.next_generation;
            self.next_generation = self.next_generation.wrapping_add(1).max(1);
            SharedBacking {
                refs: 1,
                pins: 0,
                value,
                generation,
            }
        };
        #[cfg(not(test))]
        let entry = SharedBacking { refs: 1, pins: 0, value };

        if index == self.entries.len() { self.entries.push(Some(entry)); }
        else { self.entries[index] = Some(entry); }
        Ok(index)
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (usize, &mut T)> {
        self.entries
            .iter_mut()
            .enumerate()
            .filter_map(|(idx, slot)| slot.as_mut().map(|entry| (idx, &mut entry.value)))
    }

    pub fn get(&self, idx: usize) -> Option<&T> {
        self.entries
            .get(idx)
            .and_then(Option::as_ref)
            .map(|entry| &entry.value)
    }

    pub fn get_mut(&mut self, idx: usize) -> Option<&mut T> {
        self.entries
            .get_mut(idx)
            .and_then(Option::as_mut)
            .map(|entry| &mut entry.value)
    }

    pub fn add_ref(&mut self, idx: usize) -> Result<(), Errno> {
        let entry = self
            .entries
            .get_mut(idx)
            .and_then(Option::as_mut)
            .filter(|entry| entry.refs > 0)
            .ok_or(Errno::EBADF)?;
        entry.refs = entry.refs.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    }

    /// Drop one owning OFD reference. Returns true when that was the last
    /// one: the descriptions' lifetime is over. The value itself is freed
    /// then too, unless a shared mapping still pins it (see [`Self::pin`]).
    pub fn release(&mut self, idx: usize) -> bool {
        self.release_take(idx).final_reference
    }

    pub fn release_take(&mut self, idx: usize) -> SharedBackingRelease<T> {
        let mut result = SharedBackingRelease { final_reference: false, value: None };
        let Some(slot) = self.entries.get_mut(idx) else {
            return result;
        };
        let Some(entry) = slot.as_mut() else {
            return result;
        };
        if entry.refs == 0 {
            return result;
        }
        if entry.refs > 1 {
            entry.refs -= 1;
            return result;
        }
        entry.refs = 0;
        result.final_reference = true;
        if entry.pins == 0 {
            result.value = slot.take().map(|entry| entry.value);
        }
        result
    }

    /// Keep a value alive for a shared mapping after its descriptors close.
    ///
    /// POSIX: `mmap` adds a reference to the file that a later `close` of the
    /// descriptor does not remove. Only a value some OFD still owns can be
    /// pinned; a pinned value no OFD owns is reachable only through the pin.
    pub fn pin(&mut self, idx: usize) -> Result<(), Errno> {
        let entry = self
            .entries
            .get_mut(idx)
            .and_then(Option::as_mut)
            .filter(|entry| entry.refs > 0)
            .ok_or(Errno::EBADF)?;
        entry.pins = entry.pins.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    }

    /// Drop a [`Self::pin`], freeing the value once no OFD and no other
    /// mapping holds it.
    pub fn unpin(&mut self, idx: usize) {
        drop(self.unpin_take(idx));
    }

    #[must_use]
    pub fn unpin_take(&mut self, idx: usize) -> Option<T> {
        let Some(slot) = self.entries.get_mut(idx) else {
            return None;
        };
        let Some(entry) = slot.as_mut() else {
            return None;
        };
        entry.pins = entry.pins.saturating_sub(1);
        if entry.pins == 0 && entry.refs == 0 {
            return slot.take().map(|entry| entry.value);
        }
        None
    }

    /// Whether some OFD still owns the value, as opposed to only a mapping.
    pub fn is_owned(&self, idx: usize) -> bool {
        self.entries
            .get(idx)
            .and_then(Option::as_ref)
            .is_some_and(|entry| entry.refs > 0)
    }

    pub fn ref_count(&self, idx: usize) -> Option<u32> {
        self.entries
            .get(idx)
            .and_then(Option::as_ref)
            .map(|entry| entry.refs)
    }

    #[cfg(test)]
    pub fn generation(&self, idx: usize) -> Option<u64> {
        self.entries
            .get(idx)
            .and_then(Option::as_ref)
            .map(|entry| entry.generation)
    }
}

/// Shared contents and cursor for a memfd open file description.
#[derive(Debug)]
pub struct MemFdBacking {
    pub data: crate::IoBuffer<u8>,
    pub offset: i64,
    /// Advanced by every mutation of `data` (write, pwrite, ftruncate, a
    /// shared-mapping writeback). The shared-mapping layer compares it to
    /// learn that descriptor I/O changed a mapped memfd.
    pub content_gen: u64,
}

impl MemFdBacking {
    pub fn new() -> Self {
        Self {
            data: crate::IoBuffer::new(),
            offset: 0,
            content_gen: 0,
        }
    }

    /// Record a mutation of `data`.
    pub fn touch_modified(&mut self) {
        self.content_gen = self.content_gen.wrapping_add(1);
    }

    pub fn write_at(&mut self, offset: usize, bytes: &[u8]) -> Result<usize, Errno> {
        if bytes.is_empty() { return Ok(0); }
        let end = offset.checked_add(bytes.len()).ok_or(Errno::EFBIG)?;
        if end > self.data.len() {
            self.data.try_reserve(end - self.data.len())?;
            self.data.resize(end, 0);
        }
        self.data[offset..end].copy_from_slice(bytes);
        self.touch_modified();
        Ok(bytes.len())
    }

    pub fn resize(&mut self, length: usize) -> Result<(), Errno> {
        if length > self.data.len() { self.data.try_reserve(length - self.data.len())?; }
        if length == 0 { self.data = crate::IoBuffer::new(); }
        else { self.data.resize(length, 0); }
        self.touch_modified();
        Ok(())
    }
}

/// Immutable procfs snapshot plus the shared open-file-description cursor.
#[derive(Debug)]
pub struct ProcfsBacking {
    pub data: crate::IoBuffer<u8>,
    pub offset: i64,
}

/// Shared cursor/lifetime state for one open description of a read-only
/// synthetic regular file such as `/etc/mtab`.
#[derive(Debug)]
pub struct SyntheticRegularBacking {
    pub offset: i64,
}

impl SyntheticRegularBacking {
    pub fn new() -> Self {
        Self { offset: 0 }
    }
}

impl ProcfsBacking {
    pub fn new(data: crate::IoBuffer<u8>) -> Self {
        Self { data, offset: 0 }
    }
}

pub(crate) struct GlobalBackingTable<T> {
    locked: AtomicBool,
    table: UnsafeCell<Option<SharedBackingTable<T>>>,
}

struct UnlockOnDrop<'a>(&'a AtomicBool);

impl Drop for UnlockOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl<T> GlobalBackingTable<T> {
    pub(crate) const fn new() -> Self {
        Self {
            locked: AtomicBool::new(false),
            table: UnsafeCell::new(None),
        }
    }

    pub(crate) fn with<R>(&'static self, f: impl for<'a> FnOnce(&'a mut SharedBackingTable<T>) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: `locked` serializes every access and the closure's
        // higher-ranked input lifetime prevents a table reference escaping.
        let slot = unsafe { &mut *self.table.get() };
        f(slot.get_or_insert_with(SharedBackingTable::new))
    }
}

// Kandelo serializes entry into one kernel instance. These tables follow the
// same UnsafeCell-backed global pattern as pipes, sockets, PTYs, and mqueues.
unsafe impl<T: Send> Sync for GlobalBackingTable<T> {}

static EVENTFDS: GlobalBackingTable<EventFdState> = GlobalBackingTable::new();
static TIMERFDS: GlobalBackingTable<TimerFdState> = GlobalBackingTable::new();
static SIGNALFDS: GlobalBackingTable<SignalFdState> = GlobalBackingTable::new();
static MEMFDS: GlobalBackingTable<MemFdBacking> = GlobalBackingTable::new();
static PROCFS_BUFS: GlobalBackingTable<ProcfsBacking> = GlobalBackingTable::new();
static SYNTHETIC_REGULARS: GlobalBackingTable<SyntheticRegularBacking> =
    GlobalBackingTable::new();
static PCM_STREAMS: GlobalBackingTable<crate::audio::PcmStream> = GlobalBackingTable::new();
static EPOLLS: GlobalBackingTable<EpollInstance> = GlobalBackingTable::new();

// Keep synthetic backing handles disjoint from the small negative sentinels
// used by pipes, devices, and procfs.
pub const SYNTHETIC_REGULAR_HANDLE_BASE: i64 = 1_000_000_000;

pub fn with_eventfds<R>(
    f: impl for<'a> FnOnce(&'a mut SharedBackingTable<EventFdState>) -> R,
) -> R {
    EVENTFDS.with(f)
}

pub fn with_timerfds<R>(
    f: impl for<'a> FnOnce(&'a mut SharedBackingTable<TimerFdState>) -> R,
) -> R {
    TIMERFDS.with(f)
}

pub fn with_signalfds<R>(
    f: impl for<'a> FnOnce(&'a mut SharedBackingTable<SignalFdState>) -> R,
) -> R {
    SIGNALFDS.with(f)
}

pub fn with_memfds<R>(f: impl for<'a> FnOnce(&'a mut SharedBackingTable<MemFdBacking>) -> R) -> R {
    MEMFDS.with(f)
}

pub fn with_procfs_bufs<R>(
    f: impl for<'a> FnOnce(&'a mut SharedBackingTable<ProcfsBacking>) -> R,
) -> R {
    PROCFS_BUFS.with(f)
}

fn with_synthetic_regulars<R>(
    f: impl for<'a> FnOnce(&'a mut SharedBackingTable<SyntheticRegularBacking>) -> R,
) -> R {
    SYNTHETIC_REGULARS.with(f)
}

pub fn try_alloc_synthetic_regular() -> Result<i64, Errno> {
    let idx = with_synthetic_regulars(|table| table.try_alloc(SyntheticRegularBacking::new()))?;
    Ok(-(SYNTHETIC_REGULAR_HANDLE_BASE + idx as i64))
}

#[cfg(test)]
pub fn alloc_synthetic_regular() -> i64 { try_alloc_synthetic_regular().unwrap() }

pub fn is_synthetic_regular_handle(host_handle: i64) -> bool {
    // Bounded below by the tmpfs file-handle base so the two negative-handle
    // classes stay disjoint: synthetic regulars occupy (-TMPFS_FILE_HANDLE_BASE,
    // -SYNTHETIC_REGULAR_HANDLE_BASE], tmpfs handles live below that.
    host_handle <= -SYNTHETIC_REGULAR_HANDLE_BASE
        && host_handle > -crate::tmpfs::TMPFS_FILE_HANDLE_BASE
}

fn synthetic_regular_idx(host_handle: i64) -> Result<usize, Errno> {
    if !is_synthetic_regular_handle(host_handle) {
        return Err(Errno::EBADF);
    }
    host_handle
        .checked_add(SYNTHETIC_REGULAR_HANDLE_BASE)
        .and_then(i64::checked_neg)
        .and_then(|idx| usize::try_from(idx).ok())
        .ok_or(Errno::EBADF)
}

/// Epoll instances, one per open file description that `epoll_create1`
/// created. Sharing them here is what lets a `fork` child use an inherited
/// epoll descriptor and see the parent's registrations, and vice versa.
pub fn with_epolls<R>(f: impl for<'a> FnOnce(&'a mut SharedBackingTable<EpollInstance>) -> R) -> R {
    EPOLLS.with(f)
}

pub fn with_pcm_streams<R>(
    f: impl for<'a> FnOnce(&'a mut SharedBackingTable<crate::audio::PcmStream>) -> R,
) -> R {
    PCM_STREAMS.with(f)
}

fn negative_handle_idx(host_handle: i64) -> Result<usize, Errno> {
    if host_handle >= 0 {
        return Err(Errno::EBADF);
    }
    host_handle
        .checked_neg()
        .and_then(|value| value.checked_sub(1))
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(Errno::EBADF)
}

#[cfg_attr(
    not(any(target_arch = "wasm32", target_arch = "wasm64")),
    allow(dead_code)
)]
pub fn manages_ofd(file_type: FileType, host_handle: i64) -> bool {
    matches!(
        file_type,
        FileType::EventFd
            | FileType::TimerFd
            | FileType::SignalFd
            | FileType::MemFd
            | FileType::PcmPlayback
            | FileType::Epoll
    ) || (file_type == FileType::Regular
        && (crate::procfs::is_procfs_buf_handle(host_handle)
            || crate::executable_backing::is_executable_handle(host_handle)
            || is_synthetic_regular_handle(host_handle)
            || crate::tmpfs::is_tmpfs_file_handle(host_handle)
            || crate::rootfs::is_rootfs_file_handle(host_handle)))
}

/// Whether an encoded handle currently names a live backing owned here.
///
/// Shape recognition alone is insufficient at trust boundaries: a stale
/// negative index has the right bit pattern but cannot reconstruct an open
/// file description.
pub fn is_live_managed_ofd(file_type: FileType, host_handle: i64) -> bool {
    match file_type {
        FileType::Regular if crate::executable_backing::is_executable_handle(host_handle) => {
            crate::executable_backing::is_live(host_handle)
        }
        FileType::EventFd => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_eventfds(|table| table.get(idx).is_some())),
        FileType::TimerFd => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_timerfds(|table| table.get(idx).is_some())),
        FileType::SignalFd => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_signalfds(|table| table.get(idx).is_some())),
        // A memfd only a shared mapping still pins has no description left.
        FileType::MemFd => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_memfds(|table| table.is_owned(idx))),
        FileType::PcmPlayback => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_pcm_streams(|table| table.get(idx).is_some())),
        FileType::Epoll => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_epolls(|table| table.get(idx).is_some())),
        FileType::Regular if crate::procfs::is_procfs_buf_handle(host_handle) => {
            with_procfs_bufs(|table| {
                table
                    .get(crate::procfs::procfs_buf_idx(host_handle))
                    .is_some()
            })
        }
        FileType::Regular if is_synthetic_regular_handle(host_handle) => {
            synthetic_regular_idx(host_handle)
                .is_ok_and(|idx| with_synthetic_regulars(|table| table.get(idx).is_some()))
        }
        FileType::Regular if crate::tmpfs::is_tmpfs_file_handle(host_handle) => {
            crate::tmpfs::handle_is_live(host_handle)
        }
        FileType::Regular if crate::rootfs::is_rootfs_file_handle(host_handle) => {
            crate::rootfs::handle_is_live(host_handle)
        }
        _ => false,
    }
}

/// Plan ownership transfer for the legacy serialize/init exec ABI. Surviving
/// OFDs take over the old process's existing ownership reference; old OFDs
/// omitted by CLOEXEC filtering must be released exactly once. A replacement
/// may not acquire a backing it did not already own.
#[cfg_attr(
    not(any(target_arch = "wasm32", target_arch = "wasm64")),
    allow(dead_code)
)]
pub fn removed_backings_for_exec(
    old: &Process,
    replacement: &Process,
) -> Result<crate::IoBuffer<(FileType, i64)>, Errno> {
    let count = old.ofd_table.iter().filter(|(_, ofd)| manages_ofd(ofd.file_type, ofd.host_handle)).count();
    let mut old_backings = crate::IoBuffer::try_with_capacity(count)?;
    for (_, ofd) in old.ofd_table.iter() {
        if manages_ofd(ofd.file_type, ofd.host_handle) { old_backings.push((ofd.file_type, ofd.host_handle)); }
    }
    let mut retained = crate::IoBuffer::try_with_capacity(count)?;
    retained.resize(count, false);

    for (_, ofd) in replacement.ofd_table.iter() {
        if !manages_ofd(ofd.file_type, ofd.host_handle) {
            continue;
        }
        let Some((idx, _)) = old_backings
            .iter()
            .enumerate()
            .find(|(idx, key)| !retained[*idx] && **key == (ofd.file_type, ofd.host_handle))
        else {
            return Err(Errno::EBADF);
        };
        retained[idx] = true;
    }

    let mut position = 0;
    old_backings.retain(|_| {
        let removed = !retained[position];
        position += 1;
        removed
    });
    Ok(old_backings)
}

#[cfg_attr(
    not(any(target_arch = "wasm32", target_arch = "wasm64")),
    allow(dead_code)
)]
pub fn release_backings(backings: &[(FileType, i64)]) {
    for &(file_type, host_handle) in backings {
        release_for_ofd(file_type, host_handle);
    }
}

/// Read the authoritative open-file-description cursor. Memfd and procfs
/// cursors live in their shared backing; all other OFDs use their local field.
pub fn current_offset(
    file_type: FileType,
    host_handle: i64,
    local_offset: i64,
) -> Result<i64, Errno> {
    match file_type {
        FileType::MemFd => with_memfds(|table| {
            table
                .get(negative_handle_idx(host_handle)?)
                .map(|backing| backing.offset)
                .ok_or(Errno::EBADF)
        }),
        FileType::Regular if crate::procfs::is_procfs_buf_handle(host_handle) => {
            with_procfs_bufs(|table| {
                table
                    .get(crate::procfs::procfs_buf_idx(host_handle))
                    .map(|backing| backing.offset)
                    .ok_or(Errno::EBADF)
            })
        }
        FileType::Regular if is_synthetic_regular_handle(host_handle) => {
            with_synthetic_regulars(|table| {
                table
                    .get(synthetic_regular_idx(host_handle)?)
                    .map(|backing| backing.offset)
                    .ok_or(Errno::EBADF)
            })
        }
        _ => Ok(local_offset),
    }
}

/// Set the authoritative cursor. Returns true for shared-cursor OFDs so the
/// caller knows the local `OpenFileDesc::offset` field is only a wire-format
/// placeholder and must not become a second authority.
pub fn set_current_offset(
    file_type: FileType,
    host_handle: i64,
    offset: i64,
) -> Result<bool, Errno> {
    match file_type {
        FileType::MemFd => {
            with_memfds(|table| {
                let backing = table
                    .get_mut(negative_handle_idx(host_handle)?)
                    .ok_or(Errno::EBADF)?;
                backing.offset = offset;
                Ok(())
            })?;
            Ok(true)
        }
        FileType::Regular if crate::procfs::is_procfs_buf_handle(host_handle) => {
            with_procfs_bufs(|table| {
                let backing = table
                    .get_mut(crate::procfs::procfs_buf_idx(host_handle))
                    .ok_or(Errno::EBADF)?;
                backing.offset = offset;
                Ok(())
            })?;
            Ok(true)
        }
        FileType::Regular if is_synthetic_regular_handle(host_handle) => {
            with_synthetic_regulars(|table| {
                let backing = table
                    .get_mut(synthetic_regular_idx(host_handle)?)
                    .ok_or(Errno::EBADF)?;
                backing.offset = offset;
                Ok(())
            })?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Add the child's one-per-OFD ownership reference when an OFD is inherited.
/// Returns `Ok(false)` for descriptor types without a backing in this module.
pub fn add_ref_for_ofd(file_type: FileType, host_handle: i64) -> Result<bool, Errno> {
    match file_type {
        FileType::Regular if crate::executable_backing::is_executable_handle(host_handle) => {
            crate::executable_backing::add_ref(host_handle)?;
        }
        FileType::EventFd => {
            with_eventfds(|table| table.add_ref(negative_handle_idx(host_handle)?))?
        }
        FileType::TimerFd => {
            with_timerfds(|table| table.add_ref(negative_handle_idx(host_handle)?))?
        }
        FileType::SignalFd => {
            with_signalfds(|table| table.add_ref(negative_handle_idx(host_handle)?))?
        }
        FileType::MemFd => with_memfds(|table| table.add_ref(negative_handle_idx(host_handle)?))?,
        FileType::PcmPlayback => {
            with_pcm_streams(|table| table.add_ref(negative_handle_idx(host_handle)?))?
        }
        FileType::Epoll => with_epolls(|table| table.add_ref(negative_handle_idx(host_handle)?))?,
        FileType::Regular if crate::procfs::is_procfs_buf_handle(host_handle) => {
            with_procfs_bufs(|table| table.add_ref(crate::procfs::procfs_buf_idx(host_handle)))?
        }
        FileType::Regular if is_synthetic_regular_handle(host_handle) => {
            with_synthetic_regulars(|table| table.add_ref(synthetic_regular_idx(host_handle)?))?
        }
        FileType::Regular if crate::tmpfs::is_tmpfs_file_handle(host_handle) => {
            if !crate::tmpfs::add_ref_handle(host_handle) {
                return Err(Errno::EBADF);
            }
        }
        FileType::Regular if crate::rootfs::is_rootfs_file_handle(host_handle) => {
            if !crate::rootfs::add_ref_handle(host_handle) {
                return Err(Errno::EBADF);
            }
        }
        FileType::CharDevice if crate::exchange::is_exchange_handle(host_handle) => {
            crate::exchange::add_ref_handle(host_handle)?;
        }
        _ => return Ok(false),
    }
    Ok(true)
}

/// Drop one owning OFD reference. Returns true only when this was the final
/// machine-wide reference and the backing was freed. Descriptor types not
/// owned by this module, and stale/corrupt handles, return false.
pub fn release_for_ofd(file_type: FileType, host_handle: i64) -> bool {
    assert!(file_type != FileType::Regular || !crate::executable_backing::is_executable_handle(host_handle),
        "paired executable backings require an IO-aware release");
    match file_type {
        FileType::EventFd => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_eventfds(|table| table.release(idx))),
        FileType::TimerFd => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_timerfds(|table| table.release(idx))),
        FileType::SignalFd => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_signalfds(|table| table.release(idx))),
        FileType::MemFd => negative_handle_idx(host_handle)
            .is_ok_and(|idx| with_memfds(|table| table.release(idx))),
        FileType::PcmPlayback => {
            negative_handle_idx(host_handle).is_ok_and(|idx| {
                let freed = with_pcm_streams(|table| table.release(idx));
                if freed {
                    crate::audio::on_last_ofd_released(idx);
                }
                freed
            })
        }
        FileType::Epoll => {
            negative_handle_idx(host_handle).is_ok_and(|idx| with_epolls(|table| table.release(idx)))
        }
        FileType::Regular if crate::procfs::is_procfs_buf_handle(host_handle) => {
            with_procfs_bufs(|table| table.release(crate::procfs::procfs_buf_idx(host_handle)))
        }
        FileType::Regular if is_synthetic_regular_handle(host_handle) => {
            synthetic_regular_idx(host_handle)
                .is_ok_and(|idx| with_synthetic_regulars(|table| table.release(idx)))
        }
        FileType::Regular if crate::tmpfs::is_tmpfs_file_handle(host_handle) => {
            crate::tmpfs::release_handle(host_handle)
        }
        FileType::Regular if crate::rootfs::is_rootfs_file_handle(host_handle) => {
            crate::rootfs::release_handle(host_handle)
        }
        FileType::CharDevice if crate::exchange::is_exchange_handle(host_handle) => {
            crate::exchange::release_handle(host_handle)
        }
        _ => false,
    }
}

pub fn release_for_ofd_effects(file_type: FileType, host_handle: i64) -> BackingReleaseEffects {
    if file_type == FileType::Regular && crate::executable_backing::is_executable_handle(host_handle) {
        return crate::executable_backing::release(host_handle);
    }
    let mut effects = BackingReleaseEffects::default();
    effects.final_ofd_reference = release_for_ofd(file_type, host_handle);
    effects
}

pub fn release_added_ref_for_ofd(file_type: FileType, host_handle: i64) {
    let effects = release_for_ofd_effects(file_type, host_handle);
    assert!(!effects.final_ofd_reference, "inheritance rollback released the original owner");
    assert!(effects.into_host_closes().iter().all(Option::is_none), "inheritance rollback owns no host-close effect");
}

#[cfg(test)]
mod tests {
    use super::{GlobalBackingTable, SharedBackingTable};

    #[test]
    fn take_release_and_final_mapping_unpin_transfer_values_without_allocation() {
        let mut table = SharedBackingTable::new();
        let slot = table.alloc(41u32);
        table.add_ref(slot).unwrap();
        table.pin(slot).unwrap();
        table.pin(slot).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(held);
        let first = table.release_take(slot);
        assert!(!first.final_reference && first.value.is_none());
        let final_reference = table.release_take(slot);
        assert!(final_reference.final_reference && final_reference.value.is_none());
        assert_eq!(table.add_ref(slot), Err(wasm_posix_shared::Errno::EBADF));
        assert_eq!(table.pin(slot), Err(wasm_posix_shared::Errno::EBADF));
        assert_eq!(table.unpin_take(slot), None);
        assert_eq!(table.get(slot), Some(&41));
        assert_eq!(table.unpin_take(slot), Some(41));
        assert_eq!(table.get(slot), None);
        assert!(!table.release_take(slot).final_reference);
        assert_eq!(table.unpin_take(slot), None);
        assert_eq!(table.alloc(42), slot);
        let last = table.release_take(slot);
        assert!(last.final_reference);
        assert_eq!(last.value, Some(42));
    }

    #[test]
    fn taken_values_are_destroyed_after_the_global_table_borrow_ends() {
        use core::sync::atomic::{AtomicUsize, Ordering};
        struct Probe {
            table: &'static GlobalBackingTable<Probe>,
            drops: &'static AtomicUsize,
        }
        impl Drop for Probe {
            fn drop(&mut self) {
                assert!(!self.table.locked.load(Ordering::Acquire));
                self.drops.fetch_add(1, Ordering::Relaxed);
            }
        }
        let arena = Box::leak(Box::new(GlobalBackingTable::new()));
        let drops = Box::leak(Box::new(AtomicUsize::new(0)));
        let slot = arena.with(|table| table.try_alloc(Probe { table: arena, drops })).unwrap();
        let released = arena.with(|table| table.release_take(slot));
        assert_eq!(drops.load(Ordering::Relaxed), 0);
        drop(released.value);
        assert_eq!(drops.load(Ordering::Relaxed), 1);
        let slot = arena.with(|table| {
            let slot = table.try_alloc(Probe { table: arena, drops }).unwrap();
            table.pin(slot).unwrap();
            assert!(table.release_take(slot).value.is_none());
            slot
        });
        let value = arena.with(|table| table.unpin_take(slot));
        assert_eq!(drops.load(Ordering::Relaxed), 1);
        drop(value);
        assert_eq!(drops.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn arena_refusal_and_mapping_pins_preserve_payload_ownership_and_indices() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut table = SharedBackingTable::new();
        let payload = crate::IoBuffer::copy_from(b"owned").unwrap();
        {
            let held = crate::io_buffer::IO_MEMORY.usage().0;
            let _limit = crate::io_buffer::test_budget(held);
            assert!(matches!(table.try_alloc(payload), Err(wasm_posix_shared::Errno::ENOMEM)));
            assert!(table.entries.is_empty());
            assert_eq!(table.next_generation, 1);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
        let payload = crate::IoBuffer::copy_from(b"owned").unwrap();
        let payload_credit = crate::io_buffer::IO_MEMORY.usage().0 - baseline;
        let index = table.try_alloc(payload).unwrap();
        table.pin(index).unwrap();
        assert!(table.release(index));
        assert!(!table.is_owned(index));
        assert_eq!(table.get(index).unwrap(), b"owned");
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            let second = table.try_alloc(crate::IoBuffer::new()).unwrap();
            assert_ne!(second, index);
            assert!(table.release(second));
            table.unpin(index);
            assert!(table.get(index).is_none());
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held - payload_credit);
        }
        drop(table);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn memfd_payload_refusal_preserves_bytes_cursor_and_generation() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut backing = super::MemFdBacking::new();
        backing.write_at(0, b"original").unwrap();
        backing.offset = 4;
        let generation = backing.content_gen;
        {
            let held = crate::io_buffer::IO_MEMORY.usage().0;
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(backing.write_at(64, b"new"), Err(wasm_posix_shared::Errno::ENOMEM));
            assert_eq!(backing.resize(64), Err(wasm_posix_shared::Errno::ENOMEM));
            assert_eq!(backing.data, b"original");
            assert_eq!(backing.offset, 4);
            assert_eq!(backing.content_gen, generation);
            assert_eq!(backing.write_at(usize::MAX, b""), Ok(0));
            assert_eq!(backing.content_gen, generation);
            assert_eq!(backing.write_at(0, b"changed!"), Ok(8));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
            backing.resize(0).unwrap();
            assert_eq!(backing.offset, 4);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn shared_backing_reuses_only_freed_slots() {
        let mut table = SharedBackingTable::new();
        let first = table.alloc(10u32);
        assert_eq!(first, 0);
        table.add_ref(first).unwrap();
        assert!(!table.release(first));

        let second = table.alloc(20u32);
        assert_eq!(second, 1, "live backing must retain its stable index");
        assert!(table.release(first));
        let reused = table.alloc(30u32);
        assert_eq!(reused, first);
        assert_eq!(table.get(reused), Some(&30));
    }

    #[test]
    fn global_backing_closure_serializes_parallel_access() {
        let table: &'static GlobalBackingTable<u64> =
            Box::leak(Box::new(GlobalBackingTable::new()));
        let threads: Vec<_> = (0..8u64)
            .map(|thread_id| {
                std::thread::spawn(move || {
                    for iteration in 0..500u64 {
                        let value = (thread_id << 32) | iteration;
                        let idx = table.with(|entries| entries.alloc(value));
                        assert_eq!(table.with(|entries| entries.get(idx).copied()), Some(value));
                        assert!(table.with(|entries| entries.release(idx)));
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
    }
}
