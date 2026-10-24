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

use alloc::vec::Vec;
use core::cell::UnsafeCell;
use wasm_posix_shared::Errno;
use crate::io_buffer::{IoBuffer, IO_MEMORY};
use crate::metadata_budget::{MetadataBudget, MetadataBytes};
use crate::prepared_map::{PreparedEntry, PreparedMap};

pub(crate) struct PreparedFifoName(PreparedEntry<Vec<u8>, usize>);

impl PreparedFifoName {
    pub(crate) fn set_pipe(&mut self, pipe_idx: usize) { *self.0.value_mut() = pipe_idx; }
    pub(crate) fn pipe_index(&self) -> usize { *self.0.value() }

    fn from_parts(budget: &'static MetadataBudget, prefix: &[u8], suffix: &[u8], pipe_idx: usize) -> Result<Self, Errno> {
        let length = prefix.len().checked_add(suffix.len()).ok_or(Errno::ENOMEM)?;
        let reservation = PreparedEntry::<Vec<u8>, usize>::reserve_in(budget, length)?;
        let mut path = Vec::new();
        path.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
        path.extend_from_slice(prefix);
        path.extend_from_slice(suffix);
        Ok(Self(PreparedEntry::new_reserved_in(budget, path, pipe_idx, reservation)?))
    }
}

pub(crate) struct PreparedFifoRename {
    moves: IoBuffer<(MetadataBytes<'static>, PreparedFifoName)>,
    displaced: Option<MetadataBytes<'static>>,
}

/// Registry mapping a FIFO's canonical path to its backing pipe index.
pub struct FifoTable {
    map: PreparedMap<Vec<u8>, usize>,
    budget: &'static MetadataBudget,
}

impl FifoTable {
    pub const fn new() -> Self {
        FifoTable { map: PreparedMap::new(), budget: &IO_MEMORY }
    }

    /// Register one FIFO name. Returns false if the canonical path is already
    /// registered; callers must preserve the VFS operation's exclusive-create
    /// semantics rather than silently replacing a live name.
    #[cfg(test)]
    pub fn register(&mut self, path: Vec<u8>, pipe_idx: usize) -> bool {
        match self.prepare_registration(&path, pipe_idx) {
            Ok(prepared) => self.publish_registration(prepared),
            Err(Errno::EEXIST) => false,
            Err(error) => panic!("FIFO fixture registration failed: {error:?}"),
        }
    }

    pub(crate) fn prepare_registration(&self, path: &[u8], pipe_idx: usize) -> Result<PreparedFifoName, Errno> {
        if self.map.contains_key(path) { return Err(Errno::EEXIST); }
        PreparedFifoName::from_parts(self.budget, path, &[], pipe_idx)
    }

    pub(crate) fn publish_registration(&mut self, prepared: PreparedFifoName) -> bool {
        if self.map.contains_key(prepared.0.key()) { return false; }
        self.map.insert_prepared(prepared.0);
        true
    }

    pub(crate) fn publish_into(mut self, destination: &mut Self) {
        while let Some(entry) = self.map.pop_first() {
            assert!(destination.publish_registration(PreparedFifoName(entry)), "prepared FIFO destination changed");
        }
    }

    /// Return the backing pipe index for `path`, if it names a FIFO.
    pub fn lookup(&self, path: &[u8]) -> Option<usize> {
        self.map.get(path).copied()
    }

    pub(crate) fn lookup_child(&self, directory: &[u8], name: &[u8]) -> Option<usize> {
        let separator = if directory.len() > 1 { &b"/"[..] } else { &[][..] };
        self.map.get_by(|candidate| directory.iter().chain(separator).chain(name).cmp(candidate.iter())).copied()
    }

    /// Return any live name for a FIFO buffer. This lets fstat refresh marker
    /// metadata after the original open pathname has been renamed or unlinked.
    pub(crate) fn path_for_pipe(&self, pipe_idx: usize) -> Result<Option<MetadataBytes<'static>>, Errno> {
        self.map
            .iter()
            .find_map(|(path, &idx)| (idx == pipe_idx).then_some(path.as_slice()))
            .map(|path| MetadataBytes::copy_from(self.budget, path)).transpose()
    }

    /// Remove the FIFO named `path`, returning its backing pipe index.
    pub fn remove(&mut self, path: &[u8]) -> Option<usize> {
        self.map.remove_entry(path).map(|entry| *entry.value())
    }

    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&[u8], usize) -> bool) {
        self.map.retain(|path, index| keep(path, *index));
    }

    /// Re-key FIFO names after a successful VFS rename. Directory renames move
    /// every registered descendant. Any destination registration replaced by
    /// the VFS operation is returned so its backing pipe can drop one name.
    #[cfg(test)]
    pub fn rename_path(&mut self, oldpath: &[u8], newpath: &[u8]) -> Vec<usize> {
        let mut replaced = Vec::new();
        let prepared = self.prepare_rename(oldpath, newpath).unwrap();
        self.publish_rename(prepared, |index| replaced.push(index));
        replaced
    }

    pub(crate) fn prepare_rename(&self, oldpath: &[u8], newpath: &[u8]) -> Result<PreparedFifoRename, Errno> {
        let mut moves = IoBuffer::new_in(self.budget);
        let old_pipe = self.lookup(oldpath);
        if oldpath == newpath || (old_pipe.is_some() && old_pipe == self.lookup(newpath)) {
            return Ok(PreparedFifoRename { moves, displaced: None });
        }
        let count = self.map.iter().filter(|(path, _)| rebase_suffix(path, oldpath).is_some()).count();
        moves.reserve_with(count, |entries| {
            entries.try_reserve_exact(count).map_err(|_| Errno::ENOMEM)
        })?;
        for (path, &index) in self.map.iter() {
            if let Some(suffix) = rebase_suffix(path, oldpath) {
                let old = MetadataBytes::copy_from(self.budget, path)?;
                let new = PreparedFifoName::from_parts(self.budget, newpath, suffix, index)?;
                moves.push((old, new));
            }
        }
        let displaced = if count == 0 && self.lookup(newpath).is_some() {
            Some(MetadataBytes::copy_from(self.budget, newpath)?)
        } else { None };
        Ok(PreparedFifoRename { moves, displaced })
    }

    pub(crate) fn publish_rename(&mut self, prepared: PreparedFifoRename, mut displaced: impl FnMut(usize)) {
        for (old, entry) in prepared.moves.iter() {
            let removed = self.remove(old.as_ref());
            assert_eq!(removed, Some(*entry.0.value()), "prepared FIFO source changed");
        }
        for (_, entry) in prepared.moves {
            if let Some(replaced) = self.map.insert_prepared(entry.0) { displaced(*replaced.value()); }
        }
        if let Some(path) = prepared.displaced {
            if let Some(index) = self.remove(path.as_ref()) { displaced(index); }
        }
    }
}

fn rebase_suffix<'a>(path: &'a [u8], oldpath: &[u8]) -> Option<&'a [u8]> {
    if path == oldpath { Some(&[]) }
    else if path.starts_with(oldpath) && path.get(oldpath.len()) == Some(&b'/') { Some(&path[oldpath.len()..]) }
    else { None }
}

#[cfg(test)]
pub fn rebase_path(path: &[u8], oldpath: &[u8], newpath: &[u8]) -> Option<Vec<u8>> {
    let suffix = rebase_suffix(path, oldpath)?;

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
    fn fifo_registration_prepares_admission_and_physical_allocation_before_publication() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        let mut table = FifoTable { map: PreparedMap::new(), budget: &BUDGET };
        BUDGET.set_limit(0).unwrap();
        assert!(matches!(table.prepare_registration(b"/fifo", 7), Err(Errno::ENOMEM)));
        assert_eq!(table.lookup(b"/fifo"), None);
        BUDGET.set_limit(4096).unwrap();
        crate::prepared_map::fail_after_allocations(0);
        assert!(matches!(table.prepare_registration(b"/fifo", 7), Err(Errno::ENOMEM)));
        assert_eq!(BUDGET.usage().0, 0);
        let prepared = table.prepare_registration(b"/fifo", 7).unwrap();
        let retained = BUDGET.usage().0;
        assert!(retained >= 2 * b"/fifo".len());
        BUDGET.set_limit(retained).unwrap();
        assert!(table.publish_registration(prepared));
        assert_eq!(table.lookup(b"/fifo"), Some(7));
        assert!(matches!(table.path_for_pipe(7), Err(Errno::ENOMEM)));
        BUDGET.set_limit(4096).unwrap();
        assert_eq!(table.path_for_pipe(7).unwrap().as_deref().map(Vec::as_slice), Some(b"/fifo".as_slice()));
        assert_eq!(table.remove(b"/fifo"), Some(7));
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn fifo_directory_rename_refusal_retains_every_name_and_credit_until_retry() {
        static BUDGET: MetadataBudget = MetadataBudget::new(64 * 1024);
        let mut table = FifoTable { map: PreparedMap::new(), budget: &BUDGET };
        for (path, index) in [(b"/old/a".as_slice(), 1), (b"/old/nested/b", 2), (b"/new/a", 3)] {
            let prepared = table.prepare_registration(path, index).unwrap();
            assert!(table.publish_registration(prepared));
        }
        let retained = BUDGET.usage().0;
        BUDGET.set_limit(retained).unwrap();
        assert!(matches!(table.prepare_rename(b"/old", b"/new"), Err(Errno::ENOMEM)));
        BUDGET.set_limit(64 * 1024).unwrap();
        for allocations in 0..2 {
            crate::prepared_map::fail_after_allocations(allocations);
            assert!(matches!(table.prepare_rename(b"/old", b"/new"), Err(Errno::ENOMEM)));
            assert_eq!(BUDGET.usage().0, retained);
            assert_eq!(table.lookup(b"/old/a"), Some(1));
            assert_eq!(table.lookup(b"/old/nested/b"), Some(2));
            assert_eq!(table.lookup(b"/new/a"), Some(3));
            assert_eq!(table.lookup(b"/new/nested/b"), None);
        }
        let prepared = table.prepare_rename(b"/old", b"/new").unwrap();
        BUDGET.set_limit(BUDGET.usage().0).unwrap();
        let mut displaced = None;
        table.publish_rename(prepared, |index| {
            assert!(displaced.replace(index).is_none());
        });
        assert_eq!(displaced, Some(3));
        assert_eq!(table.lookup(b"/old/a"), None);
        assert_eq!(table.lookup(b"/old/nested/b"), None);
        assert_eq!(table.lookup(b"/new/a"), Some(1));
        assert_eq!(table.lookup(b"/new/nested/b"), Some(2));
        drop(table);
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn fifo_same_inode_rename_needs_no_credit_and_keeps_both_names() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        let mut table = FifoTable { map: PreparedMap::new(), budget: &BUDGET };
        assert!(table.register(b"/source".to_vec(), 1));
        assert!(table.register(b"/alias".to_vec(), 1));
        BUDGET.set_limit(BUDGET.usage().0).unwrap();
        let prepared = table.prepare_rename(b"/source", b"/alias").unwrap();
        table.publish_rename(prepared, |_| panic!("same inode cannot be displaced"));
        assert_eq!(table.lookup(b"/source"), Some(1));
        assert_eq!(table.lookup(b"/alias"), Some(1));
        drop(table);
        assert_eq!(BUDGET.usage().0, 0);
    }

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
