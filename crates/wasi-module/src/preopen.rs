//! The preopened-directory table.
//!
//! `WasiShim` keeps this as a `Map<number, string>` (`wasi-shim.ts:447`) that
//! in practice holds exactly one entry: `"/"` seeded by `init()`. A fixed
//! table needs no allocator, which keeps the module `no_std` with no heap, and
//! makes the bound explicit rather than latent.

use wasi_abi::WasiErrno;

/// How many preopens a process may have. WASI runtimes commonly grant one per
/// `--dir` flag; Kandelo seeds exactly one. Exceeding this is a loud failure,
/// not a silent drop.
pub const MAX_PREOPENS: usize = 8;

/// Longest preopen path. Preopen paths are mount points, not arbitrary file
/// paths.
pub const MAX_PREOPEN_PATH: usize = 128;

#[derive(Clone, Copy)]
struct Entry {
    fd: u32,
    path: [u8; MAX_PREOPEN_PATH],
    len: u8,
    live: bool,
}

impl Entry {
    const EMPTY: Self = Self {
        fd: 0,
        path: [0; MAX_PREOPEN_PATH],
        len: 0,
        live: false,
    };
}

pub struct PreopenTable {
    entries: [Entry; MAX_PREOPENS],
}

impl Default for PreopenTable {
    fn default() -> Self {
        Self::new()
    }
}

impl PreopenTable {
    pub const fn new() -> Self {
        Self {
            entries: [Entry::EMPTY; MAX_PREOPENS],
        }
    }

    /// The path preopened at `fd`, if any.
    pub fn get(&self, fd: u32) -> Option<&[u8]> {
        self.entries
            .iter()
            .find(|e| e.live && e.fd == fd)
            .map(|e| &e.path[..e.len as usize])
    }

    /// Record `path` as preopened at `fd`, replacing any existing entry.
    ///
    /// Returns `NameTooLong` for an over-long path and `NFile` when the table
    /// is full: a preopen that cannot be recorded must fail loudly, because
    /// silently dropping it would make every later path resolution against
    /// that fd resolve against the wrong root.
    pub fn insert(&mut self, fd: u32, path: &[u8]) -> Result<(), WasiErrno> {
        if path.len() > MAX_PREOPEN_PATH {
            return Err(WasiErrno::NameTooLong);
        }
        // Index-based so the "replace existing, else take a free slot" search
        // does not hold a mutable borrow across the second scan.
        let index = match self.entries.iter().position(|e| e.live && e.fd == fd) {
            Some(existing) => existing,
            None => self
                .entries
                .iter()
                .position(|e| !e.live)
                .ok_or(WasiErrno::NFile)?,
        };
        let slot = &mut self.entries[index];
        slot.fd = fd;
        slot.len = path.len() as u8;
        slot.path[..path.len()].copy_from_slice(path);
        slot.live = true;
        Ok(())
    }

    /// Forget the preopen at `fd`. Returns whether one was there.
    pub fn remove(&mut self, fd: u32) -> bool {
        match self.entries.iter_mut().find(|e| e.live && e.fd == fd) {
            Some(entry) => {
                *entry = Entry::EMPTY;
                true
            }
            None => false,
        }
    }

    /// Move the preopen at `from` to `to`, if there is one. Used by
    /// `fd_renumber`.
    pub fn rename(&mut self, from: u32, to: u32) -> Result<(), WasiErrno> {
        let moved = match self.entries.iter().find(|e| e.live && e.fd == from) {
            Some(entry) => (entry.path, entry.len),
            None => return Ok(()),
        };
        self.remove(from);
        self.insert(to, &moved.0[..moved.1 as usize])
    }

    pub fn len(&self) -> usize {
        self.entries.iter().filter(|e| e.live).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(all(test, feature = "testing"))]
mod tests {
    use super::*;

    #[test]
    fn seeded_root_round_trips() {
        let mut table = PreopenTable::new();
        assert!(table.is_empty());
        table.insert(3, b"/").unwrap();
        assert_eq!(table.get(3), Some(&b"/"[..]));
        assert_eq!(table.get(4), None);
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn insert_replaces_rather_than_duplicating() {
        let mut table = PreopenTable::new();
        table.insert(3, b"/").unwrap();
        table.insert(3, b"/tmp").unwrap();
        assert_eq!(table.get(3), Some(&b"/tmp"[..]));
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn remove_reports_whether_it_removed_anything() {
        let mut table = PreopenTable::new();
        table.insert(3, b"/").unwrap();
        assert!(table.remove(3));
        assert!(!table.remove(3));
        assert_eq!(table.get(3), None);
    }

    #[test]
    fn rename_moves_the_entry_and_is_a_noop_for_a_plain_fd() {
        let mut table = PreopenTable::new();
        table.insert(3, b"/data").unwrap();
        table.rename(3, 9).unwrap();
        assert_eq!(table.get(3), None);
        assert_eq!(table.get(9), Some(&b"/data"[..]));
        // Renaming an fd with no preopen must not invent one.
        table.rename(50, 51).unwrap();
        assert_eq!(table.get(51), None);
    }

    #[test]
    fn a_full_table_fails_loudly_rather_than_dropping_a_preopen() {
        let mut table = PreopenTable::new();
        for fd in 0..MAX_PREOPENS as u32 {
            table.insert(fd, b"/").unwrap();
        }
        assert_eq!(table.insert(99, b"/"), Err(WasiErrno::NFile));
    }

    #[test]
    fn an_over_long_path_is_rejected_not_truncated() {
        let mut table = PreopenTable::new();
        let long = [b'a'; MAX_PREOPEN_PATH + 1];
        assert_eq!(table.insert(3, &long), Err(WasiErrno::NameTooLong));
        let exact = [b'a'; MAX_PREOPEN_PATH];
        assert_eq!(table.insert(3, &exact), Ok(()));
        assert_eq!(table.get(3).map(|p| p.len()), Some(MAX_PREOPEN_PATH));
    }
}
