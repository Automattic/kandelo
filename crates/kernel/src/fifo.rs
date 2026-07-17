//! Named pipes (FIFOs).
//!
//! `mkfifo`/`mknod(S_IFIFO)` creates a FIFO: a *named* pipe that lives in the
//! filesystem namespace but carries real pipe I/O semantics (blocking reads,
//! EAGAIN when empty-but-open, EOF only after all writers close). Unlike an
//! anonymous `pipe()`, a FIFO is looked up by path when opened, so two
//! independent processes (e.g. a shell's process-substitution reader and
//! writer) can rendezvous through it.
//!
//! Modeling: a FIFO has a real VFS marker inode for namespace and metadata
//! operations, while a kernel [`crate::pipe::PipeBuffer`] owns its I/O state.
//! This registry maps every canonical hard-link name to that shared buffer.
//! The buffer survives with no open endpoints while at least one name exists;
//! after the last unlink, open file descriptions keep it alive until close.
//!
//! Without this, `mknod(S_IFIFO)` fell back to creating a *regular file*
//! (see the old `kernel_mknod` path), so a concurrent reader saw an empty
//! file and got a premature EOF — breaking `read < <(cmd)`.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

/// Registry mapping a FIFO's canonical path to its backing pipe index.
pub struct FifoTable {
    map: BTreeMap<Vec<u8>, usize>,
}

impl FifoTable {
    pub const fn new() -> Self {
        FifoTable { map: BTreeMap::new() }
    }

    /// Register one FIFO name. Returns false if the canonical path is already
    /// registered; callers must preserve the VFS operation's exclusive-create
    /// semantics rather than silently replacing a live name.
    pub fn register(&mut self, path: Vec<u8>, pipe_idx: usize) -> bool {
        if self.map.contains_key(&path) {
            return false;
        }
        self.map.insert(path, pipe_idx);
        true
    }

    /// Return the backing pipe index for `path`, if it names a FIFO.
    pub fn lookup(&self, path: &[u8]) -> Option<usize> {
        self.map.get(path).copied()
    }

    /// Return any live name for a FIFO buffer. This lets fstat refresh marker
    /// metadata after the original open pathname has been renamed or unlinked.
    pub fn path_for_pipe(&self, pipe_idx: usize) -> Option<Vec<u8>> {
        self.map
            .iter()
            .find_map(|(path, &idx)| (idx == pipe_idx).then(|| path.clone()))
    }

    /// Remove the FIFO named `path`, returning its backing pipe index.
    pub fn remove(&mut self, path: &[u8]) -> Option<usize> {
        self.map.remove(path)
    }

    /// Re-key FIFO names after a successful VFS rename. Directory renames move
    /// every registered descendant. Any destination registration replaced by
    /// the VFS operation is returned so its backing pipe can drop one name.
    pub fn rename_path(&mut self, oldpath: &[u8], newpath: &[u8]) -> Vec<usize> {
        if oldpath == newpath {
            return Vec::new();
        }

        let moving: Vec<(Vec<u8>, Vec<u8>, usize)> = self
            .map
            .iter()
            .filter_map(|(path, &pipe_idx)| {
                rebase_path(path, oldpath, newpath)
                    .map(|new_name| (path.clone(), new_name, pipe_idx))
            })
            .collect();

        if moving.is_empty() {
            return self.map.remove(newpath).into_iter().collect();
        }

        for (old_name, _, _) in &moving {
            self.map.remove(old_name);
        }

        let mut replaced = Vec::new();
        for (_, new_name, pipe_idx) in moving {
            if let Some(replaced_idx) = self.map.remove(&new_name) {
                replaced.push(replaced_idx);
            }
            self.map.insert(new_name, pipe_idx);
        }
        replaced
    }
}

pub(crate) fn rebase_path(path: &[u8], oldpath: &[u8], newpath: &[u8]) -> Option<Vec<u8>> {
    let suffix = if path == oldpath {
        &[][..]
    } else if path.starts_with(oldpath)
        && path.get(oldpath.len()) == Some(&b'/')
    {
        &path[oldpath.len()..]
    } else {
        return None;
    };

    let mut rebased = Vec::with_capacity(newpath.len() + suffix.len());
    rebased.extend_from_slice(newpath);
    rebased.extend_from_slice(suffix);
    Some(rebased)
}

pub struct GlobalFifoTable(pub UnsafeCell<FifoTable>);

/// SAFETY: access is serialized — the kernel services one syscall at a time
/// (no concurrent Wasm execution).
unsafe impl Sync for GlobalFifoTable {}

pub static FIFO_TABLE: GlobalFifoTable = GlobalFifoTable(UnsafeCell::new(FifoTable::new()));

/// Get a mutable reference to the global FIFO table.
///
/// # Safety
/// Only safe when access is serialized (single-threaded kernel).
pub unsafe fn global_fifo_table() -> &'static mut FifoTable {
    unsafe { &mut *FIFO_TABLE.0.get() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_is_exclusive_and_aliases_share_a_pipe() {
        let mut table = FifoTable::new();
        assert!(table.register(b"/tmp/a".to_vec(), 7));
        assert!(!table.register(b"/tmp/a".to_vec(), 8));
        assert!(table.register(b"/tmp/b".to_vec(), 7));
        assert_eq!(table.lookup(b"/tmp/a"), Some(7));
        assert_eq!(table.lookup(b"/tmp/b"), Some(7));
    }

    #[test]
    fn rename_rekeys_file_and_directory_names() {
        let mut table = FifoTable::new();
        assert!(table.register(b"/old/a".to_vec(), 1));
        assert!(table.register(b"/old/nested/b".to_vec(), 2));

        assert!(table.rename_path(b"/old", b"/new").is_empty());
        assert_eq!(table.lookup(b"/old/a"), None);
        assert_eq!(table.lookup(b"/new/a"), Some(1));
        assert_eq!(table.lookup(b"/new/nested/b"), Some(2));
    }

    #[test]
    fn rename_reports_replaced_destination_name() {
        let mut table = FifoTable::new();
        assert!(table.register(b"/source".to_vec(), 1));
        assert!(table.register(b"/destination".to_vec(), 2));

        assert_eq!(table.rename_path(b"/source", b"/destination"), alloc::vec![2]);
        assert_eq!(table.lookup(b"/source"), None);
        assert_eq!(table.lookup(b"/destination"), Some(1));
    }
}
