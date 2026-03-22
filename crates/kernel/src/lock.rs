extern crate alloc;
use alloc::vec::Vec;
use wasm_posix_shared::lock_type::*;

/// A single byte-range lock on a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileLock {
    pub pid: u32,
    pub lock_type: u32, // F_RDLCK or F_WRLCK
    pub start: i64,     // start offset (absolute, after whence resolution)
    pub len: i64,       // length (0 = to end of file)
}

impl FileLock {
    /// Check if two ranges overlap.
    pub fn overlaps(&self, start: i64, len: i64) -> bool {
        let self_end = if self.len == 0 {
            i64::MAX
        } else {
            self.start + self.len
        };
        let other_end = if len == 0 { i64::MAX } else { start + len };
        self.start < other_end && start < self_end
    }

    /// Check if this lock conflicts with a requested lock type + range.
    /// Read locks don't conflict with read locks. Everything else conflicts.
    pub fn conflicts_with(&self, lock_type: u32, start: i64, len: i64, pid: u32) -> bool {
        // Same process can always override its own locks
        if self.pid == pid {
            return false;
        }
        // Check range overlap
        if !self.overlaps(start, len) {
            return false;
        }
        // Read-read is compatible
        if self.lock_type == F_RDLCK && lock_type == F_RDLCK {
            return false;
        }
        true
    }
}

/// Per-file lock table keyed by host_handle.
pub struct LockTable {
    /// All active locks. Centralized kernel manages locks for all processes.
    locks: Vec<(i64, FileLock)>, // (host_handle, lock)
}

impl LockTable {
    pub fn new() -> Self {
        LockTable { locks: Vec::new() }
    }

    /// Check if a lock would conflict. Returns the conflicting lock if any.
    pub fn get_blocking_lock(
        &self,
        host_handle: i64,
        lock_type: u32,
        start: i64,
        len: i64,
        pid: u32,
    ) -> Option<&FileLock> {
        for (handle, lock) in &self.locks {
            if *handle == host_handle && lock.conflicts_with(lock_type, start, len, pid) {
                return Some(lock);
            }
        }
        None
    }

    /// Set a lock. Replaces/splits existing locks from the same pid on overlapping ranges.
    pub fn set_lock(&mut self, host_handle: i64, lock: FileLock) {
        // Remove existing locks from the same pid that overlap
        self.locks.retain(|(h, l)| {
            !(*h == host_handle && l.pid == lock.pid && l.overlaps(lock.start, lock.len))
        });

        // If it's an unlock, we're done (we just removed the overlapping locks)
        if lock.lock_type == F_UNLCK {
            return;
        }

        self.locks.push((host_handle, lock));
    }

    /// Remove all locks held by a process (called on exit/close).
    pub fn remove_all_for_pid(&mut self, pid: u32) {
        self.locks.retain(|(_, l)| l.pid != pid);
    }

    /// Remove all locks on a specific file handle held by a process.
    pub fn remove_for_handle(&mut self, host_handle: i64, pid: u32) {
        self.locks
            .retain(|(h, l)| !(*h == host_handle && l.pid == pid));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_conflict_different_files() {
        let mut table = LockTable::new();
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_WRLCK,
                start: 0,
                len: 100,
            },
        );
        // Different file handle - no conflict
        assert!(table
            .get_blocking_lock(2, F_WRLCK, 0, 100, 2)
            .is_none());
    }

    #[test]
    fn test_read_read_no_conflict() {
        let mut table = LockTable::new();
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_RDLCK,
                start: 0,
                len: 100,
            },
        );
        assert!(table
            .get_blocking_lock(1, F_RDLCK, 0, 100, 2)
            .is_none());
    }

    #[test]
    fn test_read_write_conflict() {
        let mut table = LockTable::new();
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_RDLCK,
                start: 0,
                len: 100,
            },
        );
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 50, 50, 2)
            .is_some());
    }

    #[test]
    fn test_write_write_conflict() {
        let mut table = LockTable::new();
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_WRLCK,
                start: 0,
                len: 100,
            },
        );
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 50, 50, 2)
            .is_some());
    }

    #[test]
    fn test_same_pid_no_conflict() {
        let mut table = LockTable::new();
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_WRLCK,
                start: 0,
                len: 100,
            },
        );
        // Same pid - never conflicts (can override)
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 0, 100, 1)
            .is_none());
    }

    #[test]
    fn test_non_overlapping_ranges() {
        let mut table = LockTable::new();
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_WRLCK,
                start: 0,
                len: 50,
            },
        );
        // Non-overlapping range
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 50, 50, 2)
            .is_none());
    }

    #[test]
    fn test_unlock_removes_lock() {
        let mut table = LockTable::new();
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_WRLCK,
                start: 0,
                len: 100,
            },
        );
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 0, 100, 2)
            .is_some());
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_UNLCK,
                start: 0,
                len: 100,
            },
        );
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 0, 100, 2)
            .is_none());
    }

    #[test]
    fn test_remove_all_for_pid() {
        let mut table = LockTable::new();
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_WRLCK,
                start: 0,
                len: 100,
            },
        );
        table.set_lock(
            2,
            FileLock {
                pid: 1,
                lock_type: F_RDLCK,
                start: 0,
                len: 50,
            },
        );
        table.remove_all_for_pid(1);
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 0, 100, 2)
            .is_none());
        assert!(table
            .get_blocking_lock(2, F_WRLCK, 0, 50, 2)
            .is_none());
    }

    #[test]
    fn test_zero_len_means_to_eof() {
        let mut table = LockTable::new();
        // Lock from offset 100 to end of file (len=0)
        table.set_lock(
            1,
            FileLock {
                pid: 1,
                lock_type: F_WRLCK,
                start: 100,
                len: 0,
            },
        );
        // Should conflict with anything from 100 onwards
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 200, 50, 2)
            .is_some());
        // Should not conflict with range before 100
        assert!(table
            .get_blocking_lock(1, F_WRLCK, 0, 100, 2)
            .is_none());
    }
}
