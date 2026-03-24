//! Process table for centralized kernel mode.
//!
//! In centralized mode (mode=1), a single kernel instance manages multiple
//! processes. The `ProcessTable` maps PIDs to `Process` structs, allowing
//! the kernel to service syscalls for any process based on the PID passed
//! via `kernel_handle_channel`.
//!
//! Operations:
//! - `create_process` — create a new empty process
//! - `fork_process` — clone a parent process via serialize/deserialize
//! - `remove_process` — remove a process from the table
//! - `set_current_pid` — select which process is being serviced

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

use wasm_posix_shared::Errno;

use crate::process::Process;

/// Table of all processes managed by the centralized kernel.
///
/// In centralized mode (mode=1), the kernel manages multiple processes.
/// Each process is identified by its pid. The `current_pid` field tracks
/// which process is currently being serviced (set by the JS host before
/// calling `kernel_handle_channel`).
pub struct ProcessTable {
    processes: BTreeMap<u32, Process>,
    current_pid: u32,
}

impl ProcessTable {
    pub const fn new() -> Self {
        ProcessTable {
            processes: BTreeMap::new(),
            current_pid: 0,
        }
    }

    /// Create a new process with the given pid and add it to the table.
    pub fn create_process(&mut self, pid: u32) -> Result<(), ()> {
        if self.processes.contains_key(&pid) {
            return Err(());
        }
        self.processes.insert(pid, Process::new(pid));
        Ok(())
    }

    /// Remove a process from the table.
    pub fn remove_process(&mut self, pid: u32) -> Option<Process> {
        self.processes.remove(&pid)
    }

    /// Set the current pid for syscall dispatch.
    pub fn set_current_pid(&mut self, pid: u32) {
        self.current_pid = pid;
    }

    /// Get a mutable reference to the current process.
    pub fn current_process(&mut self) -> Option<&mut Process> {
        self.processes.get_mut(&self.current_pid)
    }

    /// Get a mutable reference to a process by pid.
    pub fn get_mut(&mut self, pid: u32) -> Option<&mut Process> {
        self.processes.get_mut(&pid)
    }

    /// Fork a process: serialize the parent's state and deserialize it as the child.
    /// Uses the existing fork serialization infrastructure to deep-copy Process state.
    /// Returns Ok(()) on success, Err(errno) on failure.
    pub fn fork_process(&mut self, parent_pid: u32, child_pid: u32) -> Result<(), Errno> {
        if self.processes.contains_key(&child_pid) {
            return Err(Errno::EEXIST);
        }
        let parent = self.processes.get(&parent_pid).ok_or(Errno::ESRCH)?;

        // Serialize parent state into a temporary buffer
        let mut buf = Vec::new();
        buf.resize(64 * 1024, 0u8); // 64KB should be plenty
        let written = crate::fork::serialize_fork_state(parent, &mut buf)?;

        // Deserialize as child
        let child = crate::fork::deserialize_fork_state(&buf[..written], child_pid)?;
        self.processes.insert(child_pid, child);
        Ok(())
    }

    /// Get a reference to a process by pid.
    pub fn get(&self, pid: u32) -> Option<&Process> {
        self.processes.get(&pid)
    }

    /// Collect PIDs of all processes in a given process group.
    pub fn pids_in_group(&self, pgid: u32) -> Vec<u32> {
        self.processes.iter()
            .filter(|(_, p)| p.pgid == pgid)
            .map(|(&pid, _)| pid)
            .collect()
    }
}

/// Global process table wrapper for static storage.
pub struct GlobalProcessTable(pub UnsafeCell<ProcessTable>);

/// SAFETY: Access is serialized — the centralized kernel services one syscall
/// at a time from the JS event loop (no concurrent Wasm execution).
unsafe impl Sync for GlobalProcessTable {}
