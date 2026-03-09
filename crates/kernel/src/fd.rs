extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

/// Reference to an open file description (index into the OFD table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenFileDescRef(pub usize);

/// Per-fd entry in the file descriptor table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FdEntry {
    pub ofd_ref: OpenFileDescRef,
    pub fd_flags: u32,
}

/// Per-process file descriptor table.
///
/// Maps integer file descriptors to open file description references.
/// Guarantees lowest-available-fd allocation (POSIX requirement).
pub struct FdTable {
    /// Sparse table: index is the fd number, `None` means the slot is free.
    entries: Vec<Option<FdEntry>>,
    /// Maximum number of file descriptors allowed.
    max_fds: usize,
}

impl FdTable {
    /// Default maximum of 1024 file descriptors.
    const DEFAULT_MAX: usize = 1024;

    pub fn new() -> Self {
        Self::with_max(Self::DEFAULT_MAX)
    }

    pub fn with_max(max_fds: usize) -> Self {
        FdTable {
            entries: Vec::new(),
            max_fds,
        }
    }

    /// Pre-open stdin (0), stdout (1), stderr (2) pointing to OFD refs 0, 1, 2.
    pub fn preopen_stdio(&mut self) {
        for i in 0..3 {
            let _ = self.alloc(OpenFileDescRef(i), 0);
        }
    }

    /// Allocate the lowest available fd for the given OFD reference.
    pub fn alloc(&mut self, ofd_ref: OpenFileDescRef, fd_flags: u32) -> Result<i32, Errno> {
        self.alloc_at_min(ofd_ref, fd_flags, 0)
    }

    /// Allocate the lowest available fd >= `min_fd`.
    pub fn alloc_at_min(
        &mut self,
        ofd_ref: OpenFileDescRef,
        fd_flags: u32,
        min_fd: i32,
    ) -> Result<i32, Errno> {
        let min = min_fd.max(0) as usize;

        // Search for a free slot starting at min_fd.
        for i in min..self.entries.len() {
            if self.entries[i].is_none() {
                if i >= self.max_fds {
                    return Err(Errno::EMFILE);
                }
                self.entries[i] = Some(FdEntry { ofd_ref, fd_flags });
                return Ok(i as i32);
            }
        }

        // No free slot found in existing entries; extend the vector.
        let next = self.entries.len().max(min);
        if next >= self.max_fds {
            return Err(Errno::EMFILE);
        }

        // Extend with None slots up to the target index, then place the entry.
        while self.entries.len() < next {
            self.entries.push(None);
        }
        self.entries.push(Some(FdEntry { ofd_ref, fd_flags }));
        Ok(next as i32)
    }

    /// Close a file descriptor, returning the OFD reference it pointed to.
    pub fn free(&mut self, fd: i32) -> Result<OpenFileDescRef, Errno> {
        let idx = fd as usize;
        if fd < 0 || idx >= self.entries.len() {
            return Err(Errno::EBADF);
        }
        match self.entries[idx].take() {
            Some(entry) => Ok(entry.ofd_ref),
            None => Err(Errno::EBADF),
        }
    }

    /// Look up an fd entry by reference.
    pub fn get(&self, fd: i32) -> Result<&FdEntry, Errno> {
        let idx = fd as usize;
        if fd < 0 || idx >= self.entries.len() {
            return Err(Errno::EBADF);
        }
        self.entries[idx].as_ref().ok_or(Errno::EBADF)
    }

    /// Look up an fd entry by mutable reference.
    pub fn get_mut(&mut self, fd: i32) -> Result<&mut FdEntry, Errno> {
        let idx = fd as usize;
        if fd < 0 || idx >= self.entries.len() {
            return Err(Errno::EBADF);
        }
        self.entries[idx].as_mut().ok_or(Errno::EBADF)
    }

    /// Iterate over all open file descriptors.
    pub fn iter(&self) -> impl Iterator<Item = (i32, &FdEntry)> + '_ {
        self.entries.iter().enumerate()
            .filter_map(|(i, e)| e.as_ref().map(|entry| (i as i32, entry)))
    }

    /// Reconstruct an FdTable from raw entries. Used by fork deserialization.
    pub fn from_raw(entries: Vec<Option<FdEntry>>, max_fds: usize) -> Self {
        FdTable { entries, max_fds }
    }

    /// Returns the max_fds limit.
    pub fn max_fds(&self) -> usize {
        self.max_fds
    }

    /// Update the max_fds limit (e.g. when RLIMIT_NOFILE changes).
    pub fn set_max_fds(&mut self, max: usize) {
        self.max_fds = max;
    }

    /// Place an entry at a specific fd (dup2 semantics).
    ///
    /// If the slot was occupied, returns `Some(old_ofd_ref)`.
    /// If the slot was empty, returns `None`.
    /// Returns `EBADF` if `fd` is negative or exceeds the max limit.
    pub fn set_at(
        &mut self,
        fd: i32,
        ofd_ref: OpenFileDescRef,
        fd_flags: u32,
    ) -> Result<Option<OpenFileDescRef>, Errno> {
        let idx = fd as usize;
        if fd < 0 || idx >= self.max_fds {
            return Err(Errno::EBADF);
        }

        // Extend the vector if needed.
        while self.entries.len() <= idx {
            self.entries.push(None);
        }

        let old = self.entries[idx].take().map(|e| e.ofd_ref);
        self.entries[idx] = Some(FdEntry { ofd_ref, fd_flags });
        Ok(old)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;

    #[test]
    fn test_alloc_returns_lowest_available() {
        let mut table = FdTable::new();
        table.preopen_stdio(); // occupies 0, 1, 2
        let fd = table.alloc(OpenFileDescRef(10), 0).unwrap();
        assert_eq!(fd, 3);
    }

    #[test]
    fn test_alloc_fills_gaps() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        // Alloc fds 3 and 4
        let fd3 = table.alloc(OpenFileDescRef(10), 0).unwrap();
        let fd4 = table.alloc(OpenFileDescRef(11), 0).unwrap();
        assert_eq!(fd3, 3);
        assert_eq!(fd4, 4);
        // Free fd 3, creating a gap
        table.free(3).unwrap();
        // Next alloc should reuse fd 3, not allocate fd 5
        let fd_reused = table.alloc(OpenFileDescRef(12), 0).unwrap();
        assert_eq!(fd_reused, 3);
    }

    #[test]
    fn test_alloc_at_minimum() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd = table.alloc_at_min(OpenFileDescRef(10), 0, 10).unwrap();
        assert_eq!(fd, 10);
    }

    #[test]
    fn test_close_invalid_fd() {
        let mut table = FdTable::new();
        let result = table.free(99);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_get_fd_flags() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd = table.alloc(OpenFileDescRef(10), FD_CLOEXEC).unwrap();
        let entry = table.get(fd).unwrap();
        assert_eq!(entry.fd_flags, FD_CLOEXEC);
        assert_eq!(entry.ofd_ref, OpenFileDescRef(10));
    }

    #[test]
    fn test_emfile_when_full() {
        let mut table = FdTable::with_max(4);
        table.preopen_stdio(); // occupies 0, 1, 2
        // One more should succeed (fd 3)
        table.alloc(OpenFileDescRef(10), 0).unwrap();
        // Table is now full (4 of 4)
        let result = table.alloc(OpenFileDescRef(11), 0);
        assert_eq!(result, Err(Errno::EMFILE));
    }

    #[test]
    fn test_set_at_displaces_existing() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd = table.alloc(OpenFileDescRef(10), 0).unwrap();
        assert_eq!(fd, 3);
        // set_at on occupied fd 3 should return the old OFD ref
        let old = table.set_at(3, OpenFileDescRef(20), 0).unwrap();
        assert_eq!(old, Some(OpenFileDescRef(10)));
        // Verify the new entry is in place
        let entry = table.get(3).unwrap();
        assert_eq!(entry.ofd_ref, OpenFileDescRef(20));
    }

    #[test]
    fn test_set_at_empty_slot() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        // set_at on unused fd 5 should return None
        let old = table.set_at(5, OpenFileDescRef(10), 0).unwrap();
        assert_eq!(old, None);
        // Verify the entry exists now
        let entry = table.get(5).unwrap();
        assert_eq!(entry.ofd_ref, OpenFileDescRef(10));
    }

    #[test]
    fn test_get_invalid_fd_returns_ebadf() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        // fd 5 is not allocated
        let result = table.get(5);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_iter_returns_open_fds() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd3 = table.alloc(OpenFileDescRef(10), 0).unwrap();
        assert_eq!(fd3, 3);

        let fds: Vec<(i32, &FdEntry)> = table.iter().collect();
        assert_eq!(fds.len(), 4); // 0,1,2,3
        assert_eq!(fds[0].0, 0);
        assert_eq!(fds[3].0, 3);
        assert_eq!(fds[3].1.ofd_ref, OpenFileDescRef(10));
    }

    #[test]
    fn test_iter_skips_closed_fds() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        table.free(1).unwrap(); // close fd 1

        let fds: Vec<(i32, &FdEntry)> = table.iter().collect();
        assert_eq!(fds.len(), 2); // 0, 2
        assert_eq!(fds[0].0, 0);
        assert_eq!(fds[1].0, 2);
    }

    #[test]
    fn test_from_raw_roundtrip() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let max = table.max_fds();

        let entries: Vec<Option<FdEntry>> = table.iter()
            .fold(Vec::new(), |mut v, (fd, entry)| {
                while v.len() <= fd as usize {
                    v.push(None);
                }
                v[fd as usize] = Some(entry.clone());
                v
            });
        let rebuilt = FdTable::from_raw(entries, max);
        assert_eq!(rebuilt.get(0).unwrap().ofd_ref, OpenFileDescRef(0));
        assert_eq!(rebuilt.get(1).unwrap().ofd_ref, OpenFileDescRef(1));
        assert_eq!(rebuilt.get(2).unwrap().ofd_ref, OpenFileDescRef(2));
        assert!(rebuilt.get(3).is_err());
    }
}
