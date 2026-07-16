//! Kernel-global backings for descriptor types whose state belongs to an
//! open file description rather than to a process.
//!
//! Fork and spawn clone a process's FD/OFD tables.  The cloned OFDs retain a
//! stable negative handle into these tables, and each inherited OFD owns one
//! reference.  This keeps state coherent across processes and prevents a
//! newly-created descriptor in a child from reusing (and aliasing) an
//! inherited process-local slot.

extern crate alloc;

use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, Ordering};

use wasm_posix_shared::Errno;

use crate::ofd::FileType;
use crate::process::{EventFdState, Process, SignalFdState, TimerFdState};

#[derive(Debug)]
struct SharedBacking<T> {
    refs: u32,
    value: T,
    #[cfg(test)]
    generation: u64,
}

/// A stable-index table with one reference per owning OFD in each process.
pub struct SharedBackingTable<T> {
    entries: Vec<Option<SharedBacking<T>>>,
    #[cfg(test)]
    next_generation: u64,
}

impl<T> SharedBackingTable<T> {
    fn new() -> Self {
        Self {
            entries: Vec::new(),
            #[cfg(test)]
            next_generation: 1,
        }
    }

    pub fn alloc(&mut self, value: T) -> usize {
        #[cfg(test)]
        let entry = {
            let generation = self.next_generation;
            self.next_generation = self.next_generation.wrapping_add(1).max(1);
            SharedBacking {
                refs: 1,
                value,
                generation,
            }
        };
        #[cfg(not(test))]
        let entry = SharedBacking { refs: 1, value };

        if let Some((idx, slot)) = self
            .entries
            .iter_mut()
            .enumerate()
            .find(|(_, slot)| slot.is_none())
        {
            *slot = Some(entry);
            return idx;
        }

        let idx = self.entries.len();
        self.entries.push(Some(entry));
        idx
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
            .ok_or(Errno::EBADF)?;
        entry.refs = entry.refs.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    }

    /// Drop one owning OFD reference. Returns true when the backing was freed.
    pub fn release(&mut self, idx: usize) -> bool {
        let Some(slot) = self.entries.get_mut(idx) else {
            return false;
        };
        let Some(entry) = slot.as_mut() else {
            return false;
        };
        if entry.refs > 1 {
            entry.refs -= 1;
            return false;
        }
        *slot = None;
        true
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
    pub data: Vec<u8>,
    pub offset: i64,
}

impl MemFdBacking {
    pub fn new() -> Self {
        Self {
            data: Vec::new(),
            offset: 0,
        }
    }
}

/// Immutable procfs snapshot plus the shared open-file-description cursor.
#[derive(Debug)]
pub struct ProcfsBacking {
    pub data: Vec<u8>,
    pub offset: i64,
}

impl ProcfsBacking {
    pub fn new(data: Vec<u8>) -> Self {
        Self { data, offset: 0 }
    }
}

struct GlobalBackingTable<T> {
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
    const fn new() -> Self {
        Self {
            locked: AtomicBool::new(false),
            table: UnsafeCell::new(None),
        }
    }

    fn with<R>(&'static self, f: impl for<'a> FnOnce(&'a mut SharedBackingTable<T>) -> R) -> R {
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
static PCM_STREAMS: GlobalBackingTable<crate::audio::PcmStream> = GlobalBackingTable::new();

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
    ) || (file_type == FileType::Regular && crate::procfs::is_procfs_buf_handle(host_handle))
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
) -> Result<Vec<(FileType, i64)>, Errno> {
    let old_backings: Vec<(FileType, i64)> = old
        .ofd_table
        .iter()
        .filter_map(|(_, ofd)| {
            manages_ofd(ofd.file_type, ofd.host_handle).then_some((ofd.file_type, ofd.host_handle))
        })
        .collect();
    let mut retained = alloc::vec![false; old_backings.len()];

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

    Ok(old_backings
        .into_iter()
        .zip(retained)
        .filter_map(|(key, retained)| (!retained).then_some(key))
        .collect())
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
        _ => Ok(false),
    }
}

/// Add the child's one-per-OFD ownership reference when an OFD is inherited.
/// Returns `Ok(false)` for descriptor types without a backing in this module.
pub fn add_ref_for_ofd(file_type: FileType, host_handle: i64) -> Result<bool, Errno> {
    match file_type {
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
        FileType::Regular if crate::procfs::is_procfs_buf_handle(host_handle) => {
            with_procfs_bufs(|table| table.add_ref(crate::procfs::procfs_buf_idx(host_handle)))?
        }
        _ => return Ok(false),
    }
    Ok(true)
}

/// Drop one owning OFD reference. Returns true when this module owns the
/// descriptor type, including when a corrupt/stale handle had no live entry.
pub fn release_for_ofd(file_type: FileType, host_handle: i64) -> bool {
    match file_type {
        FileType::EventFd => {
            if let Ok(idx) = negative_handle_idx(host_handle) {
                with_eventfds(|table| table.release(idx));
            }
            true
        }
        FileType::TimerFd => {
            if let Ok(idx) = negative_handle_idx(host_handle) {
                with_timerfds(|table| table.release(idx));
            }
            true
        }
        FileType::SignalFd => {
            if let Ok(idx) = negative_handle_idx(host_handle) {
                with_signalfds(|table| table.release(idx));
            }
            true
        }
        FileType::MemFd => {
            if let Ok(idx) = negative_handle_idx(host_handle) {
                with_memfds(|table| table.release(idx));
            }
            true
        }
        FileType::PcmPlayback => {
            if let Ok(idx) = negative_handle_idx(host_handle) {
                let freed = with_pcm_streams(|table| table.release(idx));
                if freed {
                    crate::audio::on_last_ofd_released(idx);
                }
            }
            true
        }
        FileType::Regular if crate::procfs::is_procfs_buf_handle(host_handle) => {
            with_procfs_bufs(|table| table.release(crate::procfs::procfs_buf_idx(host_handle)));
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{GlobalBackingTable, SharedBackingTable};

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
