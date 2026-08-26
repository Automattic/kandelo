//! Global registry for filesystem-backed AF_UNIX sockets.
//!
//! Maps resolved paths to (pid, socket_table_index) so that
//! `connect()` in any process can find a listening socket bound
//! to a given path.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use wasm_posix_shared::Errno;

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
        let Some(entry) = self
            .entries
            .values_mut()
            .find(|entry| entry.owners.contains(&(parent_pid, parent_sock_idx)))
        else {
            // Unlinked/replaced pathname sockets no longer own a registry
            // name, so there is no machine-wide name authority to inherit.
            return Ok(false);
        };
        if entry.owners.contains(&(child_pid, child_sock_idx)) {
            return Ok(false);
        }
        entry
            .owners
            .try_reserve_exact(1)
            .map_err(|_| Errno::ENOMEM)?;
        entry.owners.push((child_pid, child_sock_idx));
        Ok(true)
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
