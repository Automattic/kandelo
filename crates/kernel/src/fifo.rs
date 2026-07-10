//! Named pipes (FIFOs).
//!
//! `mkfifo`/`mknod(S_IFIFO)` creates a FIFO: a *named* pipe that lives in the
//! filesystem namespace but carries real pipe I/O semantics (blocking reads,
//! EAGAIN when empty-but-open, EOF only after all writers close). Unlike an
//! anonymous `pipe()`, a FIFO is looked up by path when opened, so two
//! independent processes (e.g. a shell's process-substitution reader and
//! writer) can rendezvous through it.
//!
//! Modeling: a FIFO is a kernel [`crate::pipe::PipeBuffer`] (marked
//! `is_fifo`) registered here by canonical path. `open()` connects a read or
//! write end to that shared pipe; `unlink()` removes the registration and
//! frees the pipe. The backing pipe persists across all fds closing (a FIFO
//! keeps existing until unlinked), which is why `PipeBuffer::is_fully_closed`
//! ignores FIFO pipes.
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

    /// Register `path` as a FIFO backed by pipe `pipe_idx` (replacing any
    /// prior entry — mknod(O_EXCL semantics) is enforced by the caller).
    pub fn register(&mut self, path: Vec<u8>, pipe_idx: usize) {
        self.map.insert(path, pipe_idx);
    }

    /// Return the backing pipe index for `path`, if it names a FIFO.
    pub fn lookup(&self, path: &[u8]) -> Option<usize> {
        self.map.get(path).copied()
    }

    /// Remove the FIFO named `path`, returning its backing pipe index.
    pub fn remove(&mut self, path: &[u8]) -> Option<usize> {
        self.map.remove(path)
    }
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
