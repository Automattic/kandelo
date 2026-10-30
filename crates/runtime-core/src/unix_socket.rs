//! Global registry for filesystem-backed AF_UNIX sockets.
//!
//! Maps resolved paths to (pid, socket_table_index) so that
//! `connect()` in any process can find a listening socket bound
//! to a given path.

extern crate alloc;

use alloc::vec::Vec;
use core::cell::UnsafeCell;
use wasm_posix_shared::Errno;
use crate::io_buffer::{IoBuffer, IO_MEMORY};
use crate::metadata_budget::MetadataBytes;
use crate::prepared_map::{MapMemory, PreparedEntry, PreparedMap};

/// Entry in the Unix socket registry.
#[derive(Debug)]
pub struct UnixSocketEntry {
    /// PID of the process that owns the listening socket.
    pub pid: u32,
    /// Index into that process's SocketTable.
    pub sock_idx: usize,
    /// Every process-local socket table entry that inherited this bound
    /// endpoint. The public pid/sock_idx pair above is the current lookup
    /// target; ownership moves to another live entry when that owner closes.
    owners: IoBuffer<(u32, usize)>,
}

impl MapMemory for UnixSocketEntry {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

pub(crate) struct PreparedUnixName(PreparedEntry<Vec<u8>, UnixSocketEntry>);

impl PreparedUnixName {
    fn new(prefix: &[u8], suffix: &[u8], value: UnixSocketEntry) -> Result<Self, Errno> {
        let length = prefix.len().checked_add(suffix.len()).ok_or(Errno::ENOMEM)?;
        let reservation = PreparedEntry::<Vec<u8>, UnixSocketEntry>::reserve_in(&IO_MEMORY, length)?;
        let mut path = Vec::new();
        path.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
        path.extend_from_slice(prefix);
        path.extend_from_slice(suffix);
        Ok(Self(PreparedEntry::new_reserved_in(&IO_MEMORY, path, value, reservation)?))
    }
}

pub(crate) struct PreparedUnixRename {
    moves: IoBuffer<(MetadataBytes<'static>, PreparedUnixName)>,
    displaced: Option<MetadataBytes<'static>>,
}

/// Global registry mapping resolved paths to listening Unix sockets.
pub struct UnixSocketRegistry {
    entries: PreparedMap<Vec<u8>, UnixSocketEntry>,
}

impl UnixSocketRegistry {
    pub const fn new() -> Self {
        UnixSocketRegistry {
            entries: PreparedMap::new(),
        }
    }

    /// Register a bound Unix socket at the given path.
    /// Returns false if the path is already in use.
    #[cfg(test)]
    pub fn register(&mut self, path: Vec<u8>, pid: u32, sock_idx: usize) -> bool {
        match self.prepare_registration(&path, pid, sock_idx) {
            Ok(prepared) => self.publish_registration(prepared),
            Err(Errno::EADDRINUSE) => false,
            Err(error) => panic!("Unix socket fixture registration failed: {error:?}"),
        }
    }

    pub(crate) fn prepare_registration(&self, path: &[u8], pid: u32, sock_idx: usize) -> Result<PreparedUnixName, Errno> {
        if self.entries.contains_key(path) {
            return Err(Errno::EADDRINUSE);
        }
        let owners = IoBuffer::copy_from(&[(pid, sock_idx)])?;
        PreparedUnixName::new(path, &[], UnixSocketEntry { pid, sock_idx, owners })
    }

    pub(crate) fn publish_registration(&mut self, prepared: PreparedUnixName) -> bool {
        if self.entries.contains_key(prepared.0.key()) { return false; }
        self.entries.insert_prepared(prepared.0);
        true
    }

    /// Record a fork/spawn child that inherited the parent's exact endpoint.
    ///
    /// The sockaddr retained by `SocketInfo` is not an authority lookup key:
    /// the bound pathname may have been renamed and reused by another socket.
    /// Match the stable parent owner tuple, then reserve before mutation so
    /// allocation failure leaves the registry unchanged.
    pub fn add_inherited_owner(
        &mut self,
        parent_pid: u32,
        parent_sock_idx: usize,
        child_pid: u32,
        child_sock_idx: usize,
    ) -> Result<bool, Errno> {
        let mut found = false;
        let mut result = Ok(false);
        self.entries.for_each_mut(|entry| {
            if found || !entry.owners.contains(&(parent_pid, parent_sock_idx)) { return; }
            found = true;
            if entry.owners.contains(&(child_pid, child_sock_idx)) { return; }
            result = entry.owners.try_reserve(1).map(|()| {
                entry.owners.push((child_pid, child_sock_idx));
                true
            });
        });
        result
    }

    /// Drop the exact process-local owner independently of its current name.
    ///
    /// The name remains registered while any inherited endpoint is live;
    /// otherwise an abstract name becomes reusable immediately. A pathname
    /// socket retains its metadata tombstone until unlink.
    pub fn remove_owner_exact(&mut self, pid: u32, sock_idx: usize) -> bool {
        let mut removed = false;
        self.entries.retain(|path, entry| {
            if removed || !entry.owners.contains(&(pid, sock_idx)) {
                return true;
            }

            entry.owners.retain(|owner| *owner != (pid, sock_idx));
            removed = true;
            if entry.owners.is_empty() {
                // A pathname socket leaves its filesystem node behind after
                // last close; abstract names disappear immediately.
                return path.first().copied() != Some(0);
            }
            if entry.pid == pid && entry.sock_idx == sock_idx {
                (entry.pid, entry.sock_idx) = entry.owners[0];
            }
            true
        });
        removed
    }

    /// Re-key filesystem-backed socket metadata after a successful VFS
    /// rename. Replacing an existing destination removes that destination's
    /// old name, exactly as the filesystem operation did.
    #[cfg(test)]
    pub fn rename_path(&mut self, oldpath: &[u8], newpath: &[u8]) -> bool {
        let prepared = self.prepare_rename(oldpath, newpath).unwrap();
        self.publish_rename(prepared)
    }

    pub(crate) fn prepare_rename(&self, oldpath: &[u8], newpath: &[u8]) -> Result<PreparedUnixRename, Errno> {
        let mut moves = IoBuffer::new();
        if oldpath == newpath { return Ok(PreparedUnixRename { moves, displaced: None }); }
        let suffix_for = |path: &[u8]| {
            path == oldpath || (path.starts_with(oldpath) && path.get(oldpath.len()) == Some(&b'/'))
        };
        let count = self.entries.keys().filter(|path| suffix_for(path)).count();
        moves.try_reserve_exact(count)?;
        for (path, entry) in &self.entries {
            if !suffix_for(path) { continue; }
            let old = MetadataBytes::copy_from(&IO_MEMORY, path)?;
            let new = PreparedUnixName::new(newpath, &path[oldpath.len()..], UnixSocketEntry {
                pid: entry.pid, sock_idx: entry.sock_idx, owners: IoBuffer::new() })?;
            moves.push((old, new));
        }
        let displaced = if count == 0 && self.entries.contains_key(newpath) {
            Some(MetadataBytes::copy_from(&IO_MEMORY, newpath)?)
        } else { None };
        Ok(PreparedUnixRename { moves, displaced })
    }

    pub(crate) fn publish_rename(&mut self, mut prepared: PreparedUnixRename) -> bool {
        let changed = !prepared.moves.is_empty() || prepared.displaced.is_some();
        for (old, new) in &mut prepared.moves {
            *new.0.value_mut() = self.entries.remove(old.as_ref()).expect("prepared Unix socket source disappeared");
        }
        for (_, entry) in prepared.moves { self.entries.insert_prepared(entry.0); }
        if let Some(path) = prepared.displaced { self.entries.remove(path.as_ref()); }
        changed
    }

    /// Look up a Unix socket by path.
    pub fn lookup(&self, path: &[u8]) -> Option<&UnixSocketEntry> {
        self.entries
            .get(path)
            .filter(|entry| !entry.owners.is_empty())
    }

    /// Remove a Unix socket registration by path.
    pub fn unregister(&mut self, path: &[u8]) -> bool {
        self.entries.remove(path).is_some()
    }

    /// Remove every registration at or below `prefix`: a directory tree the
    /// kernel removes on its own.
    pub fn unregister_under(&mut self, prefix: &[u8]) {
        self.entries
            .retain(|path, _| !crate::fifo::contains_path(path, prefix));
    }

    /// Remove all registrations for a given pid (process cleanup).
    pub fn cleanup_process(&mut self, pid: u32) {
        self.entries.retain(|path, entry| {
            entry.owners.retain(|owner| owner.0 != pid);
            if entry.owners.is_empty() {
                return path.first().copied() != Some(0);
            }
            if entry.pid == pid {
                (entry.pid, entry.sock_idx) = entry.owners[0];
            }
            true
        });
    }

    /// Check if a path is registered (for stat/lstat).
    pub fn contains(&self, path: &[u8]) -> bool {
        self.entries.contains_key(path)
    }
}

/// Wrapper for static global storage.
pub struct GlobalUnixSocketRegistry(pub UnsafeCell<UnixSocketRegistry>);

/// SAFETY: Access is serialized — the kernel services one syscall at a time.
unsafe impl Sync for GlobalUnixSocketRegistry {}

pub static UNIX_SOCKET_REGISTRY: GlobalUnixSocketRegistry =
    GlobalUnixSocketRegistry(UnsafeCell::new(UnixSocketRegistry::new()));

/// Get a mutable reference to the global Unix socket registry.
///
/// # Safety
/// Caller must ensure no other references exist. Safe in single-threaded kernel.
pub unsafe fn global_unix_socket_registry() -> &'static mut UnixSocketRegistry {
    unsafe { &mut *UNIX_SOCKET_REGISTRY.0.get() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rename_prepares_prefix_moves_and_publishes_without_allocation() {
        let mut registry = UnixSocketRegistry::new();
        assert!(registry.register(b"/old/one".to_vec(), 31, 1));
        assert!(registry.register(b"/old/two".to_vec(), 32, 2));
        assert!(registry.register(b"/oldish/three".to_vec(), 33, 3));
        assert!(registry.register(b"/new/one".to_vec(), 34, 4));
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert!(matches!(registry.prepare_registration(b"/next", 35, 5), Err(Errno::ENOMEM)));
            assert!(matches!(registry.prepare_rename(b"/old", b"/new"), Err(Errno::ENOMEM)));
        }
        crate::prepared_map::fail_after_allocations(1);
        let result = registry.prepare_rename(b"/old", b"/new");
        crate::prepared_map::fail_after_allocations(usize::MAX);
        assert!(matches!(result, Err(Errno::ENOMEM)));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        assert_eq!(registry.lookup(b"/old/one").unwrap().pid, 31);
        assert_eq!(registry.lookup(b"/new/one").unwrap().pid, 34);
        let prepared = registry.prepare_rename(b"/old", b"/new").unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            assert!(registry.publish_rename(prepared));
        }
        assert!(registry.lookup(b"/old/one").is_none());
        assert!(registry.lookup(b"/old/two").is_none());
        assert_eq!(registry.lookup(b"/new/one").unwrap().pid, 31);
        assert_eq!(registry.lookup(b"/new/two").unwrap().pid, 32);
        assert_eq!(registry.lookup(b"/oldish/three").unwrap().pid, 33);
        registry.add_inherited_owner(31, 1, 36, 6).unwrap();
        assert!(registry.remove_owner_exact(31, 1));
        assert_eq!(registry.lookup(b"/new/one").unwrap().pid, 36);
    }

    #[test]
    fn test_register_and_lookup() {
        let mut reg = UnixSocketRegistry::new();
        assert!(reg.register(b"/tmp/test.sock".to_vec(), 1, 0));
        let entry = reg.lookup(b"/tmp/test.sock").unwrap();
        assert_eq!(entry.pid, 1);
        assert_eq!(entry.sock_idx, 0);
    }

    #[test]
    fn test_duplicate_register_fails() {
        let mut reg = UnixSocketRegistry::new();
        assert!(reg.register(b"/tmp/test.sock".to_vec(), 1, 0));
        assert!(!reg.register(b"/tmp/test.sock".to_vec(), 2, 1));
    }

    #[test]
    fn test_unregister() {
        let mut reg = UnixSocketRegistry::new();
        reg.register(b"/tmp/test.sock".to_vec(), 1, 0);
        assert!(reg.unregister(b"/tmp/test.sock"));
        assert!(reg.lookup(b"/tmp/test.sock").is_none());
    }

    #[test]
    fn rename_rekeys_path_and_owner_cleanup_finds_new_name() {
        let mut reg = UnixSocketRegistry::new();
        assert!(reg.register(b"/tmp/old.sock".to_vec(), 1, 7));

        assert!(reg.rename_path(b"/tmp/old.sock", b"/tmp/new.sock"));
        assert!(reg.lookup(b"/tmp/old.sock").is_none());
        assert!(reg.lookup(b"/tmp/new.sock").is_some());

        assert!(reg.remove_owner_exact(1, 7));
        assert!(reg.lookup(b"/tmp/new.sock").is_none());
        assert!(reg.contains(b"/tmp/new.sock"));
    }

    #[test]
    fn rename_overwrites_stale_destination_registration() {
        let mut reg = UnixSocketRegistry::new();
        assert!(reg.register(b"/tmp/source.sock".to_vec(), 1, 1));
        assert!(reg.register(b"/tmp/destination.sock".to_vec(), 2, 2));

        assert!(reg.rename_path(b"/tmp/source.sock", b"/tmp/destination.sock"));
        let entry = reg.lookup(b"/tmp/destination.sock").unwrap();
        assert_eq!((entry.pid, entry.sock_idx), (1, 1));
    }

    #[test]
    fn test_cleanup_process() {
        let mut reg = UnixSocketRegistry::new();
        reg.register(b"\0a".to_vec(), 1, 0);
        reg.register(b"\0b".to_vec(), 1, 1);
        reg.register(b"/tmp/c.sock".to_vec(), 2, 0);
        reg.cleanup_process(1);
        assert!(reg.lookup(b"\0a").is_none());
        assert!(reg.lookup(b"\0b").is_none());
        assert!(reg.lookup(b"/tmp/c.sock").is_some());
    }

    #[test]
    fn test_pathname_metadata_remains_until_unlink() {
        let mut reg = UnixSocketRegistry::new();
        reg.register(b"/tmp/stale.sock".to_vec(), 1, 0);
        assert!(reg.remove_owner_exact(1, 0));
        assert!(reg.contains(b"/tmp/stale.sock"));
        assert!(reg.lookup(b"/tmp/stale.sock").is_none());
        assert!(reg.unregister(b"/tmp/stale.sock"));
        assert!(!reg.contains(b"/tmp/stale.sock"));
    }

    #[test]
    fn test_contains() {
        let mut reg = UnixSocketRegistry::new();
        assert!(!reg.contains(b"/tmp/test.sock"));
        reg.register(b"/tmp/test.sock".to_vec(), 1, 0);
        assert!(reg.contains(b"/tmp/test.sock"));
    }

    #[test]
    fn test_reregister_after_unregister() {
        let mut reg = UnixSocketRegistry::new();
        reg.register(b"/tmp/test.sock".to_vec(), 1, 0);
        reg.unregister(b"/tmp/test.sock");
        assert!(reg.register(b"/tmp/test.sock".to_vec(), 2, 1));
        let entry = reg.lookup(b"/tmp/test.sock").unwrap();
        assert_eq!(entry.pid, 2);
    }

    #[test]
    fn test_inherited_owner_keeps_registration_live() {
        let mut reg = UnixSocketRegistry::new();
        reg.register(b"\0abstract".to_vec(), 10, 4);
        assert_eq!(reg.add_inherited_owner(10, 4, 20, 4), Ok(true));
        assert_eq!(reg.add_inherited_owner(10, 4, 20, 4), Ok(false));
        assert!(reg.remove_owner_exact(10, 4));
        let entry = reg.lookup(b"\0abstract").unwrap();
        assert_eq!((entry.pid, entry.sock_idx), (20, 4));
        assert!(reg.remove_owner_exact(20, 4));
        assert!(reg.lookup(b"\0abstract").is_none());
    }

    #[test]
    fn inheritance_and_removal_follow_exact_owner_across_rename_and_reuse() {
        let mut reg = UnixSocketRegistry::new();
        assert!(reg.register(b"/tmp/original.sock".to_vec(), 10, 4));
        assert!(reg.rename_path(b"/tmp/original.sock", b"/tmp/renamed.sock"));
        assert!(reg.register(b"/tmp/original.sock".to_vec(), 30, 9));

        assert_eq!(reg.add_inherited_owner(10, 4, 20, 4), Ok(true));
        assert_eq!(
            (
                reg.lookup(b"/tmp/renamed.sock").unwrap().pid,
                reg.lookup(b"/tmp/renamed.sock").unwrap().sock_idx
            ),
            (10, 4)
        );
        assert_eq!(
            (
                reg.lookup(b"/tmp/original.sock").unwrap().pid,
                reg.lookup(b"/tmp/original.sock").unwrap().sock_idx
            ),
            (30, 9)
        );

        // The old sockaddr now names pid 30, but exact removal must update the
        // renamed entry and leave that unrelated registration untouched.
        assert!(reg.remove_owner_exact(10, 4));
        let renamed = reg.lookup(b"/tmp/renamed.sock").unwrap();
        assert_eq!((renamed.pid, renamed.sock_idx), (20, 4));
        let reused = reg.lookup(b"/tmp/original.sock").unwrap();
        assert_eq!((reused.pid, reused.sock_idx), (30, 9));
    }

    #[test]
    fn inheritance_without_an_exact_parent_owner_does_not_mutate_registry() {
        let mut reg = UnixSocketRegistry::new();
        assert!(reg.register(b"\0unrelated".to_vec(), 30, 9));

        assert_eq!(reg.add_inherited_owner(10, 4, 20, 4), Ok(false));
        let entry = reg.lookup(b"\0unrelated").unwrap();
        assert_eq!((entry.pid, entry.sock_idx), (30, 9));
    }
}
