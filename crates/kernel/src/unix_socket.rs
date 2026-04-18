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
        self.entries.insert(path, UnixSocketEntry { pid, sock_idx });
        true
    }

    /// Look up a Unix socket by path.
    pub fn lookup(&self, path: &[u8]) -> Option<&UnixSocketEntry> {
        self.entries.get(path)
    }

    /// Remove a Unix socket registration by path.
    pub fn unregister(&mut self, path: &[u8]) -> bool {
        self.entries.remove(path).is_some()
    }

    /// Remove all registrations for a given pid (process cleanup).
    pub fn cleanup_process(&mut self, pid: u32) {
        self.entries.retain(|_, entry| entry.pid != pid);
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
    fn test_cleanup_process() {
        let mut reg = UnixSocketRegistry::new();
        reg.register(b"/tmp/a.sock".to_vec(), 1, 0);
        reg.register(b"/tmp/b.sock".to_vec(), 1, 1);
        reg.register(b"/tmp/c.sock".to_vec(), 2, 0);
        reg.cleanup_process(1);
        assert!(reg.lookup(b"/tmp/a.sock").is_none());
        assert!(reg.lookup(b"/tmp/b.sock").is_none());
        assert!(reg.lookup(b"/tmp/c.sock").is_some());
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
}
