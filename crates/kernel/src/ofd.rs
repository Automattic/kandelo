extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::flags::{O_APPEND, O_NONBLOCK};

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
}

#[derive(Clone)]
pub struct OpenFileDesc {
    pub file_type: FileType,
    pub status_flags: u32,
    pub host_handle: i64,
    pub offset: i64,
    pub ref_count: u32,
    pub owner_pid: u32,
    pub path: Vec<u8>,  // resolved absolute path
    /// Host directory handle for getdents64 iteration (lazily opened).
    /// -1 means not yet opened, -2 means exhausted (EOF).
    pub dir_host_handle: i64,
}

pub struct OfdTable {
    entries: Vec<Option<OpenFileDesc>>,
}

impl OfdTable {
    pub fn new() -> Self {
        OfdTable {
            entries: Vec::new(),
        }
    }

    /// Create a new open file description. Returns the OFD index.
    /// Reuses freed slots when available.
    pub fn create(&mut self, file_type: FileType, status_flags: u32, host_handle: i64, path: Vec<u8>) -> usize {
        let ofd = OpenFileDesc {
            file_type,
            status_flags,
            host_handle,
            offset: 0,
            ref_count: 1,
            owner_pid: 0,
            path,
            dir_host_handle: -1,
        };

        // Search for a free (None) slot to reuse.
        for i in 0..self.entries.len() {
            if self.entries[i].is_none() {
                self.entries[i] = Some(ofd);
                return i;
            }
        }

        // No free slot; append.
        let idx = self.entries.len();
        self.entries.push(Some(ofd));
        idx
    }

    /// Get a reference to the OFD at `idx`, or `None` if the slot is empty or out of range.
    pub fn get(&self, idx: usize) -> Option<&OpenFileDesc> {
        self.entries.get(idx).and_then(|slot| slot.as_ref())
    }

    /// Get a mutable reference to the OFD at `idx`, or `None` if the slot is empty or out of range.
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut OpenFileDesc> {
        self.entries.get_mut(idx).and_then(|slot| slot.as_mut())
    }

    /// Increment the reference count for the OFD at `idx`.
    pub fn inc_ref(&mut self, idx: usize) {
        if let Some(ofd) = self.get_mut(idx) {
            ofd.ref_count += 1;
        }
    }

    /// Decrement the reference count for the OFD at `idx`.
    /// Returns `true` if the OFD was freed (ref_count reached 0).
    pub fn dec_ref(&mut self, idx: usize) -> bool {
        let should_free = if let Some(ofd) = self.entries.get_mut(idx).and_then(|s| s.as_mut()) {
            ofd.ref_count -= 1;
            ofd.ref_count == 0
        } else {
            return false;
        };

        if should_free {
            self.entries[idx] = None;
            true
        } else {
            false
        }
    }

    /// Iterate over all open file descriptions with their indices.
    pub fn iter(&self) -> impl Iterator<Item = (usize, &OpenFileDesc)> + '_ {
        self.entries.iter().enumerate()
            .filter_map(|(i, e)| e.as_ref().map(|ofd| (i, ofd)))
    }

    /// Reconstruct an OfdTable from raw entries. Used by fork deserialization.
    pub fn from_raw(entries: Vec<Option<OpenFileDesc>>) -> Self {
        OfdTable { entries }
    }

    /// Update status flags with F_SETFL semantics.
    ///
    /// Per POSIX, only `O_APPEND` and `O_NONBLOCK` are modifiable via F_SETFL.
    /// The access mode (O_RDONLY/O_WRONLY/O_RDWR) and all other flags are preserved.
    pub fn set_status_flags(&mut self, idx: usize, new_flags: u32) {
        if let Some(ofd) = self.get_mut(idx) {
            // Preserve everything except the modifiable bits.
            let preserved = ofd.status_flags & !SETFL_MODIFIABLE;
            // Take only the modifiable bits from new_flags.
            let updated = new_flags & SETFL_MODIFIABLE;
            ofd.status_flags = preserved | updated;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::flags::*;

    #[test]
    fn test_create_ofd() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR | O_APPEND, 42, b"/test".to_vec());
        assert_eq!(idx, 0);

        let ofd = table.get(idx).expect("OFD should exist at index 0");
        assert_eq!(ofd.file_type, FileType::Regular);
        assert_eq!(ofd.status_flags, O_RDWR | O_APPEND);
        assert_eq!(ofd.host_handle, 42);
        assert_eq!(ofd.offset, 0);
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
        assert!(table.get(idx).is_none(), "OFD should be freed when ref_count hits 0");
    }

    #[test]
    fn test_set_status_flags_preserves_access_mode() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, O_RDWR | O_APPEND, 5, Vec::new());

        // Verify initial state: access mode is O_RDWR, O_APPEND is set
        let ofd = table.get(idx).unwrap();
        assert_eq!(ofd.status_flags & O_ACCMODE, O_RDWR);
        assert_ne!(ofd.status_flags & O_APPEND, 0);

        // set_status_flags with O_NONBLOCK (no O_APPEND, different access mode bits)
        // Per POSIX F_SETFL: access mode must be preserved, only O_APPEND/O_NONBLOCK modifiable
        table.set_status_flags(idx, O_NONBLOCK);

        let ofd = table.get(idx).unwrap();
        // Access mode should still be O_RDWR
        assert_eq!(ofd.status_flags & O_ACCMODE, O_RDWR);
        // O_APPEND should be removed (caller did not include it)
        assert_eq!(ofd.status_flags & O_APPEND, 0);
        // O_NONBLOCK should be added
        assert_ne!(ofd.status_flags & O_NONBLOCK, 0);
    }

    #[test]
    fn test_slot_reuse() {
        let mut table = OfdTable::new();
        let idx0 = table.create(FileType::Regular, O_RDONLY, 1, Vec::new());
        assert_eq!(idx0, 0);

        // Free slot 0
        let freed = table.dec_ref(idx0);
        assert!(freed);

        // Create again; should reuse slot 0
        let idx_reused = table.create(FileType::Pipe, O_RDWR, 2, Vec::new());
        assert_eq!(idx_reused, 0);
        let ofd = table.get(idx_reused).unwrap();
        assert_eq!(ofd.file_type, FileType::Pipe);
        assert_eq!(ofd.host_handle, 2);
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
                file_type: ofd.file_type,
                status_flags: ofd.status_flags,
                host_handle: ofd.host_handle,
                offset: ofd.offset,
                ref_count: ofd.ref_count,
                owner_pid: ofd.owner_pid,
                path: ofd.path.clone(),
                dir_host_handle: -1,
            });
        }

        let rebuilt = OfdTable::from_raw(raw);
        assert_eq!(rebuilt.get(0).unwrap().host_handle, 10);
        assert_eq!(rebuilt.get(1).unwrap().host_handle, 30);
    }
}
