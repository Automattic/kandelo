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
    /// Cleans up all cross-process resources: pipe ref counts, socket pipes,
    /// and listening socket backlogs in the global pipe table.
    pub fn remove_process(&mut self, pid: u32) -> Option<Process> {
        let proc = self.processes.remove(&pid)?;

        let pipe_table = unsafe { crate::pipe::global_pipe_table() };

        // Clean up pipe OFDs: decrement ref counts in the global pipe table.
        // Each OFD represents one pipe endpoint (one reader or one writer),
        // regardless of how many FDs point to it (ofd.ref_count).
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

        // Clean up PTY OFDs: decrement master/slave refcounts on PTY pairs.
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            match ofd.file_type {
                FileType::PtyMaster => {
                    let pty_idx = ofd.host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        if pty.master_refs > 0 { pty.master_refs -= 1; }
                        if !pty.is_alive() { crate::pty::free_pty(pty_idx); }
                    }
                }
                FileType::PtySlave => {
                    let pty_idx = ofd.host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        if pty.slave_refs > 0 { pty.slave_refs -= 1; }
                        if !pty.is_alive() { crate::pty::free_pty(pty_idx); }
                    }
                }
                _ => {}
            }
        }

        // Clean up socket OFDs: close pipe endpoints so peers get EOF/EPIPE.
        // Without this, a peer process reading from a connected socket would
        // block forever instead of getting EOF when this process exits.
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            if ofd.file_type == FileType::Socket && ofd.host_handle < 0 {
                let sock_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(sock) = proc.sockets.get(sock_idx) {
                    if sock.global_pipes {
                        // Cross-process socket: close pipe ends in global table
                        if let Some(send_idx) = sock.send_buf_idx {
                            if let Some(pipe) = pipe_table.get_mut(send_idx) {
                                pipe.close_write_end();
                            }
                            pipe_table.free_if_closed(send_idx);
                        }
                        if let Some(recv_idx) = sock.recv_buf_idx {
                            if let Some(pipe) = pipe_table.get_mut(recv_idx) {
                                pipe.close_read_end();
                            }
                            pipe_table.free_if_closed(recv_idx);
                        }
                    }
                    // Clean up unaccepted connections in listen backlog
                    for &backlog_sock_idx in &sock.listen_backlog {
                        if let Some(backlog_sock) = proc.sockets.get(backlog_sock_idx) {
                            if backlog_sock.global_pipes {
                                if let Some(send_idx) = backlog_sock.send_buf_idx {
                                    if let Some(pipe) = pipe_table.get_mut(send_idx) {
                                        pipe.close_write_end();
                                    }
                                    pipe_table.free_if_closed(send_idx);
                                }
                                if let Some(recv_idx) = backlog_sock.recv_buf_idx {
                                    if let Some(pipe) = pipe_table.get_mut(recv_idx) {
                                        pipe.close_read_end();
                                    }
                                    pipe_table.free_if_closed(recv_idx);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Clean up mqueue notifications for this process
        let mq_table = unsafe { crate::mqueue::global_mqueue_table() };
        mq_table.cleanup_process(pid);

        // Clean up Unix socket registry entries for this process
        let unix_reg = unsafe { crate::unix_socket::global_unix_socket_registry() };
        unix_reg.cleanup_process(pid);

        // Release any PTHREAD_PROCESS_SHARED primitives owned by this pid
        // so peers aren't wedged on mutexes or waiter queues.
        let pshared = unsafe { crate::pshared::global_pshared_table() };
        pshared.cleanup_process(pid);

        Some(proc)
    }

    /// Set the current pid for syscall dispatch.
    pub fn set_current_pid(&mut self, pid: u32) {
        self.current_pid = pid;
    }

    /// Get the current pid.
    pub fn current_pid(&self) -> u32 {
        self.current_pid
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

        // Increment cross-process refcount for host file handles (regular files,
        // directories, etc.) so that fork children closing their FDs don't
        // invalidate host handles the parent still uses.
        for (_ofd_idx, ofd) in child.ofd_table.iter() {
            if ofd.host_handle >= 0 {
                match ofd.file_type {
                    FileType::Regular | FileType::Directory | FileType::CharDevice | FileType::Pipe => {
                        crate::ofd::host_handle_fork_ref(ofd.host_handle);
                    }
                    _ => {}
                }
            }
        }

        // Increment PTY refcounts for inherited PTY OFDs.
        for (_ofd_idx, ofd) in child.ofd_table.iter() {
            match ofd.file_type {
                FileType::PtyMaster => {
                    let pty_idx = ofd.host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        pty.master_refs += 1;
                    }
                }
                FileType::PtySlave => {
                    let pty_idx = ofd.host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        pty.slave_refs += 1;
                    }
                }
                _ => {}
            }
        }

        // Increment global pipe ref counts for cross-process socket OFDs.
        // Without this, the parent closing/exiting would free pipes still
        // needed by the child (or vice versa).
        for (_ofd_idx, ofd) in child.ofd_table.iter() {
            if ofd.file_type == FileType::Socket && ofd.host_handle < 0 {
                let sock_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(sock) = child.sockets.get(sock_idx) {
                    if sock.global_pipes {
                        if let Some(send_idx) = sock.send_buf_idx {
                            if let Some(pipe) = pipe_table.get_mut(send_idx) {
                                pipe.add_writer();
                            }
                        }
                        if let Some(recv_idx) = sock.recv_buf_idx {
                            if let Some(pipe) = pipe_table.get_mut(recv_idx) {
                                pipe.add_reader();
                            }
                        }
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

    /// Collect all active PIDs.
    pub fn all_pids(&self) -> Vec<u32> {
        self.processes.keys().copied().collect()
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
