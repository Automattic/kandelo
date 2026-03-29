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
use wasm_posix_shared::flags::O_ACCMODE;

use crate::ofd::FileType;
use crate::process::Process;

/// Table of all processes managed by the centralized kernel.
///
/// In centralized mode (mode=1), the kernel manages multiple processes.
/// Each process is identified by its pid. The `current_pid` field tracks
/// which process is currently being serviced (set by the JS host before
/// calling `kernel_handle_channel`).
pub struct ProcessTable {
    pub(crate) processes: BTreeMap<u32, Process>,
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
    /// Decrements pipe ref counts in the global pipe table for any pipe OFDs
    /// the process still holds open.
    pub fn remove_process(&mut self, pid: u32) -> Option<Process> {
        let proc = self.processes.remove(&pid)?;

        // Decrement pipe ref counts for any open pipe OFDs.
        // Each OFD represents one pipe endpoint (one reader or one writer),
        // regardless of how many FDs point to it (ofd.ref_count).
        let pipe_table = unsafe { crate::pipe::global_pipe_table() };
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            if ofd.file_type == FileType::Pipe && ofd.host_handle < 0 {
                let pipe_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(pipe) = pipe_table.get_mut(pipe_idx) {
                    let access_mode = ofd.status_flags & O_ACCMODE;
                    if access_mode == wasm_posix_shared::flags::O_RDONLY {
                        pipe.close_read_end();
                    } else {
                        pipe.close_write_end();
                    }
                }
                pipe_table.free_if_closed(pipe_idx);
            }
        }

        Some(proc)
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

        // Increment pipe ref counts in the global pipe table for pipe OFDs
        // that the child inherited from the parent.
        // Also build pipe_fd_pairs for fork_pipe_replay (ordered by pipe_idx).
        use alloc::collections::BTreeMap;
        let pipe_table = unsafe { crate::pipe::global_pipe_table() };
        let mut pipe_fd_pairs: BTreeMap<usize, (i32, i32)> = BTreeMap::new(); // pipe_idx → (read_fd, write_fd)
        for (_ofd_idx, ofd) in child.ofd_table.iter() {
            if ofd.file_type == FileType::Pipe && ofd.host_handle < 0 {
                let pipe_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(pipe) = pipe_table.get_mut(pipe_idx) {
                    let access_mode = ofd.status_flags & O_ACCMODE;
                    if access_mode == wasm_posix_shared::flags::O_RDONLY {
                        pipe.add_reader();
                    } else {
                        pipe.add_writer();
                    }
                }
            }
        }

        // Build fork_pipe_replay: map pipe FDs by pipe_idx
        // Scan fd_table → ofd_table to find (read_fd, write_fd) pairs per pipe_idx
        for fd in 0..1024i32 {
            if let Ok(entry) = child.fd_table.get(fd) {
                if let Some(ofd) = child.ofd_table.get(entry.ofd_ref.0) {
                    if ofd.file_type == FileType::Pipe && ofd.host_handle < 0 {
                        let pipe_idx = (-(ofd.host_handle + 1)) as usize;
                        let access_mode = ofd.status_flags & O_ACCMODE;
                        let pair = pipe_fd_pairs.entry(pipe_idx).or_insert((-1, -1));
                        if access_mode == wasm_posix_shared::flags::O_RDONLY {
                            pair.0 = fd;
                        } else {
                            pair.1 = fd;
                        }
                    }
                }
            }
        }
        let mut child = child;
        child.fork_pipe_replay = pipe_fd_pairs.into_values().collect();

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
