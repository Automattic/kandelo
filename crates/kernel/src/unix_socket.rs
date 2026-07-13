//! Global registry for filesystem-backed AF_UNIX sockets.
//!
//! Maps resolved paths to (pid, socket_table_index) so that
//! `connect()` in any process can find a listening socket bound
//! to a given path.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

/// Entry in the Unix socket registry.
#[derive(Debug, Clone)]
pub struct UnixSocketEntry {
    /// PID of the process that owns the listening socket.
    pub pid: u32,
    /// Index into that process's SocketTable.
    pub sock_idx: usize,
    /// Every process-local socket table entry that inherited this bound
    /// endpoint. The public pid/sock_idx pair above is the current lookup
    /// target; ownership moves to another live entry when that owner closes.
    owners: Vec<(u32, usize)>,
}

/// Global registry mapping resolved paths to listening Unix sockets.
pub struct UnixSocketRegistry {
    entries: BTreeMap<Vec<u8>, UnixSocketEntry>,
}

impl UnixSocketRegistry {
    pub const fn new() -> Self {
        UnixSocketRegistry {
            entries: BTreeMap::new(),
        }
    }

    /// Register a bound Unix socket at the given path.
    /// Returns false if the path is already in use.
    pub fn register(&mut self, path: Vec<u8>, pid: u32, sock_idx: usize) -> bool {
        if self.entries.contains_key(&path) {
            return false;
        }
        self.entries.insert(
            path,
            UnixSocketEntry {
                pid,
                sock_idx,
                owners: alloc::vec![(pid, sock_idx)],
            },
        );
        true
    }

    /// Record a fork/spawn child that inherited a bound AF_UNIX endpoint.
    pub fn add_owner(&mut self, path: &[u8], pid: u32, sock_idx: usize) -> bool {
        let Some(entry) = self.entries.get_mut(path) else {
            return false;
        };
        if !entry.owners.contains(&(pid, sock_idx)) {
            entry.owners.push((pid, sock_idx));
        }
        true
    }

    /// Drop one process-local owner. The name remains registered while any
    /// inherited endpoint is live; otherwise it becomes reusable (which is
    /// essential for Linux abstract-namespace sockets, which have no inode).
    pub fn remove_owner(&mut self, path: &[u8], pid: u32, sock_idx: usize) -> bool {
        let resolved_path = if self.entries.contains_key(path) {
            Some(path.to_vec())
        } else {
            // A bound pathname can be renamed while the socket remains open.
            // SocketInfo intentionally retains the sockaddr supplied to
            // bind(2), so locate the renamed registry entry by stable owner.
            self.entries
                .iter()
                .find(|(_, entry)| entry.owners.contains(&(pid, sock_idx)))
                .map(|(registered_path, _)| registered_path.clone())
        };
        let Some(resolved_path) = resolved_path else {
            return false;
        };
        let Some(entry) = self.entries.get_mut(&resolved_path) else {
            return false;
        };
        let old_len = entry.owners.len();
        entry
            .owners
            .retain(|owner| *owner != (pid, sock_idx));
        if entry.owners.len() == old_len {
            return false;
        }
        if entry.owners.is_empty() {
            // A pathname socket leaves its filesystem node behind after the
            // last close; keep a metadata tombstone until unlink so stat still
            // reports S_IFSOCK and bind still sees EADDRINUSE. Abstract names
            // have no inode and disappear immediately.
            if resolved_path.first().copied() == Some(0) {
                self.entries.remove(&resolved_path);
            }
        } else if entry.pid == pid && entry.sock_idx == sock_idx {
            (entry.pid, entry.sock_idx) = entry.owners[0];
        }
        true
    }

    /// Re-key filesystem-backed socket metadata after a successful VFS
    /// rename. Replacing an existing destination removes that destination's
    /// old name, exactly as the filesystem operation did.
    pub fn rename_path(&mut self, oldpath: &[u8], newpath: &[u8]) -> bool {
        let old_entry = self.entries.remove(oldpath);
        let replaced = self.entries.remove(newpath).is_some();
        if let Some(entry) = old_entry {
            self.entries.insert(newpath.to_vec(), entry);
            true
        } else {
            replaced
        }
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

        assert!(reg.remove_owner(b"/tmp/old.sock", 1, 7));
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
        assert!(reg.remove_owner(b"/tmp/stale.sock", 1, 0));
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
        assert!(reg.add_owner(b"\0abstract", 20, 4));
        assert!(reg.remove_owner(b"\0abstract", 10, 4));
        let entry = reg.lookup(b"\0abstract").unwrap();
        assert_eq!((entry.pid, entry.sock_idx), (20, 4));
        assert!(reg.remove_owner(b"\0abstract", 20, 4));
        assert!(reg.lookup(b"\0abstract").is_none());
    }
}
