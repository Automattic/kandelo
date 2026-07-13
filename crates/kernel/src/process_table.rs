//! Process table for the kernel.
//!
//! A single kernel instance manages all processes. The `ProcessTable` maps
//! PIDs to `Process` structs, allowing the kernel to service syscalls for
//! any process based on the PID passed via `kernel_handle_channel`.
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
use core::sync::atomic::AtomicI32;

use wasm_posix_shared::flags::O_ACCMODE;
use wasm_posix_shared::Errno;

use crate::ofd::FileType;
use crate::process::{ChildWaitEvent, Process, ProcessState, StdioConfig};

const INITIAL_FORK_STATE_BUFFER_LEN: usize = 64 * 1024;
const MAX_FORK_STATE_BUFFER_LEN: usize = 4 * 1024 * 1024;

/// Owning pid of `/dev/fb0`, or `-1` if no process holds it.
///
/// `/dev/fb0` is single-open; the second `open` while another process
/// holds the device returns `EBUSY`. The owner is released when the
/// owning process closes its last `/dev/fb0` fd, calls `munmap` on its
/// framebuffer region, or exits.
pub static FB0_OWNER: AtomicI32 = AtomicI32::new(-1);

/// Table of all processes managed by the kernel.
///
/// Each process is identified by its pid. The `current_pid` field tracks
/// which process is currently being serviced (set by the JS host before
/// calling `kernel_handle_channel`).
pub struct ProcessTable {
    pub(crate) processes: BTreeMap<u32, Process>,
    current_pid: u32,
    next_spawn_pid: u32,
    /// Kernel/libc thread id for the syscall currently being serviced.
    ///
    /// The host already selected a syscall channel by its `channelOffset`; this
    /// field supplies the POSIX thread identity that cannot be inferred from the
    /// `kernel_handle_channel(pid)` call. `0` means "main thread" and is also
    /// the fallback for callers that do not bind a pthread TID.
    ///
    /// This is ambient dispatch context for the current serialized kernel call.
    /// If a single kernel instance ever services channels concurrently or
    /// reentrantly, the TID should move into the syscall header or be passed as
    /// an explicit `kernel_handle_channel` argument.
    current_tid: u32,
}

/// Outcome of `ProcessTable::remove_process`. Bundles the removed
/// `Process` with side-effect lists the caller must drain: file, directory,
/// and AF_INET host handles released during cleanup. The caller is
/// `kernel_remove_process`, which has access to the raw host-close externs;
/// this layer doesn't.
pub struct RemoveProcessResult {
    pub process: Process,
    /// Host file handles whose cross-process refcount reached 0 during
    /// teardown. The caller must invoke `host_close(h)` on each.
    pub host_closes: Vec<i64>,
    /// Per-process directory-iteration handles that were still open during
    /// teardown. These are never inherited across fork, so every retained
    /// handle must be closed by the caller.
    pub host_dir_closes: Vec<i64>,
    /// Host net handles whose cross-process refcount reached 0 during
    /// teardown. The caller must invoke `host_net_close(h)` on each —
    /// this kernel-side bookkeeping intentionally doesn't touch the
    /// host trait so `process_table.rs` stays host-agnostic.
    pub host_net_closes: Vec<i32>,
}

/// Subset of parent state inherited by a `posix_spawn` child. Captured up
/// front under an immutable `&parent` borrow so the rest of `spawn_child`
/// can mutate `self.processes` freely.
struct SpawnInheritFromParent {
    uid: u32,
    gid: u32,
    euid: u32,
    egid: u32,
    pgid: u32,
    sid: u32,
    umask: u32,
    nice: i32,
    rlimits: [[u64; 2]; 16],
    cwd: Vec<u8>,
    blocked_signals: u64,
    /// Bitmask of signals (1..=64) where the parent's disposition is
    /// `SIG_IGN`. POSIX exec preserves SIG_IGN across the boundary while
    /// resetting custom handlers to SIG_DFL — spawn applies the same
    /// rule. SIGKILL and SIGSTOP can't be set to ignored, so they
    /// can't appear here.
    ignored_signals: u64,
    fd_table: crate::fd::FdTable,
    ofd_table: crate::ofd::OfdTable,
    sockets: crate::socket::SocketTable,
}

/// Bump cross-process refcounts on resources the child inherited from the
/// parent (host file handles, global pipes, PTYs, and the global pipes
/// referenced by sockets with `global_pipes`).
///
/// Both fork and spawn need this — once a child holds a reference to any of
/// these shared resources, the parent closing or exiting must not free them
/// out from under the child.
///
/// The function operates only on global tables and the child's own state,
/// so it does not need access to `ProcessTable`. `parent_pid` identifies the
/// exact source owner when copying machine-wide INET binding ownership.
pub(crate) fn bump_inherited_resource_refcounts(
    parent_pid: u32,
    child: &Process,
) -> Result<(), Errno> {
    // Backings for eventfd/timerfd/signalfd/memfd/procfs are indexed by the
    // inherited OFD's stable negative handle. Add these fallible references
    // first, rolling them back if a stale handle is encountered, before
    // touching the older infallible global-resource refcounts below.
    let mut shared_backings_bumped: Vec<(FileType, i64)> = Vec::new();
    for (_idx, ofd) in child.ofd_table.iter() {
        match crate::descriptor_backing::add_ref_for_ofd(ofd.file_type, ofd.host_handle) {
            Ok(true) => shared_backings_bumped.push((ofd.file_type, ofd.host_handle)),
            Ok(false) => {}
            Err(err) => {
                for (file_type, host_handle) in shared_backings_bumped.into_iter().rev() {
                    crate::descriptor_backing::release_for_ofd(file_type, host_handle);
                }
                return Err(err);
            }
        }
    }

    let pipe_table = unsafe { crate::pipe::global_pipe_table() };

    // Pipe-OFDs (host_handle is the negative-encoded global pipe index).
    for (_idx, ofd) in child.ofd_table.iter() {
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

    // Host file handles (regular files / dirs / chardevs / pipe-via-host).
    for (_idx, ofd) in child.ofd_table.iter() {
        if ofd.host_handle >= 0 {
            match ofd.file_type {
                FileType::Regular | FileType::Directory | FileType::CharDevice | FileType::Pipe => {
                    crate::ofd::host_handle_fork_ref(ofd.host_handle);
                }
                _ => {}
            }
        }
    }

    // PTYs.
    for (_idx, ofd) in child.ofd_table.iter() {
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

    // Global pipes referenced by socket OFDs (cross-process loopback).
    for (_idx, ofd) in child.ofd_table.iter() {
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

    // Shared listener backlog (AF_INET/AF_INET6 listeners) and host_net_handle
    // (connected AF_INET sockets): increment one ref per socket entry that
    // carries one. close() and process exit each drop one ref; last-drop
    // either frees the listener slot or calls host_net_close. Iterates
    // `child.sockets` directly (not via OFDs) so an unaccepted-but-stored
    // listener inherits a refcount even if no fd in the child happens to
    // reference it — this matches the prior fork-deserialize-time bump.
    let backlog_table = unsafe { crate::socket::shared_listener_backlog_table() };
    for sock_idx in 0..child.sockets.len() {
        if let Some(sock) = child.sockets.get(sock_idx) {
            crate::socket::inherit_inet_binding_owners(parent_pid, child.pid, sock_idx);
            if let Some(shared_idx) = sock.shared_backlog_idx {
                backlog_table.add_ref(shared_idx);
            }
            if let Some(net_handle) = sock.host_net_handle {
                crate::socket::host_net_handle_fork_ref(net_handle);
            }
            if let Some(path) = sock.bind_path.as_deref() {
                let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
                registry.add_owner(path, child.pid, sock_idx);
            }
        }
    }

    Ok(())
}

/// Build the fork-only `fork_pipe_replay` table: a list of (read_fd,
/// write_fd) pairs so that when the child resumes through fork rewind,
/// `sys_pipe` returns the same fd numbers the parent saw.
/// Spawn doesn't replay code, so this stays fork-local.
fn build_fork_pipe_replay(child: &Process) -> Vec<(i32, i32)> {
    use alloc::collections::BTreeMap;
    let mut pipe_fd_pairs: BTreeMap<usize, (i32, i32)> = BTreeMap::new();
    for (fd, entry) in child.fd_table.iter() {
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
    pipe_fd_pairs.into_values().collect()
}

fn serialize_fork_state_with_growing_buffer(parent: &Process) -> Result<Vec<u8>, Errno> {
    let mut len = INITIAL_FORK_STATE_BUFFER_LEN;

    loop {
        let mut buf = Vec::new();
        buf.resize(len, 0u8);

        match crate::fork::serialize_fork_state(parent, &mut buf) {
            Ok(written) => {
                buf.truncate(written);
                return Ok(buf);
            }
            Err(Errno::ENOMEM) if len < MAX_FORK_STATE_BUFFER_LEN => {
                len = len.saturating_mul(2).min(MAX_FORK_STATE_BUFFER_LEN);
            }
            Err(err) => return Err(err),
        }
    }
}

impl ProcessTable {
    pub const fn new() -> Self {
        ProcessTable {
            processes: BTreeMap::new(),
            current_pid: 0,
            next_spawn_pid: 2,
            current_tid: 0,
        }
    }

    /// Create a new process with captured, pipe-backed stdio and add it to
    /// the table.
    ///
    /// Also lazily registers a virtual init process (pid 1) if absent. Init has
    /// no worker — it exists so that `kill(1, ...)` and `sched_*(1, ...)` from
    /// user processes resolve to a real target owned by root, enabling EPERM
    /// checks to fire instead of ESRCH.
    pub fn create_process(&mut self, pid: u32) -> Result<(), ()> {
        self.create_process_with_stdio(pid, StdioConfig::captured())
    }

    /// Create a new process with explicit stdio wiring and add it to the table.
    pub fn create_process_with_stdio(&mut self, pid: u32, stdio: StdioConfig) -> Result<(), ()> {
        self.ensure_init();
        if self.processes.contains_key(&pid) {
            return Err(());
        }
        self.processes.insert(pid, Process::new_with_stdio(pid, stdio));
        Ok(())
    }

    /// Ensure the virtual init process (pid 1) is present. Idempotent.
    pub fn ensure_init(&mut self) {
        if !self.processes.contains_key(&1) {
            let mut init = Process::new(1);
            init.ppid = 0;
            init.argv.push(alloc::vec::Vec::from(b"init".as_slice()));
            self.processes.insert(1, init);
        }
    }

    /// Remove a process from the table.
    /// Cleans up all cross-process resources: pipe ref counts, socket pipes,
    /// and listening socket backlogs in the global pipe table.
    pub fn remove_process(&mut self, pid: u32) -> Option<RemoveProcessResult> {
        let result = self.remove_process_inner(pid, false)?;
        self.prune_empty_limbo_groups();
        Some(result)
    }

    /// Reap a wait-consumed process from the table. If it is still the
    /// process-group leader for remaining members, keep a resource-free limbo
    /// record so getpgid/setpgid can still address the leader until the group
    /// empties.
    pub fn reap_process(&mut self, pid: u32) -> Option<RemoveProcessResult> {
        let result = self.remove_process_inner(pid, true)?;
        self.prune_empty_limbo_groups();
        Some(result)
    }

    fn remove_process_inner(
        &mut self,
        pid: u32,
        retain_limbo_leader: bool,
    ) -> Option<RemoveProcessResult> {
        let proc = self.processes.remove(&pid)?;
        let mut host_closes: Vec<i64> = Vec::new();
        let mut host_dir_closes: Vec<i64> = Vec::new();
        let mut host_net_closes: Vec<i32> = Vec::new();

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
                        if pty.master_refs > 0 {
                            pty.master_refs -= 1;
                        }
                        if !pty.is_alive() {
                            crate::pty::free_pty(pty_idx);
                        }
                    }
                }
                FileType::PtySlave => {
                    let pty_idx = ofd.host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        if pty.slave_refs > 0 {
                            pty.slave_refs -= 1;
                        }
                        if !pty.is_alive() {
                            crate::pty::free_pty(pty_idx);
                        }
                    }
                }
                _ => {}
            }
        }

        // Drop kernel-global eventfd/timerfd/signalfd/memfd/procfs backing
        // references for every OFD the process still owns. Normal exit closes
        // fds first; this also covers crash removal and spawn rollback.
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            crate::descriptor_backing::release_for_ofd(ofd.file_type, ofd.host_handle);
        }

        // Drop host-backed file and directory handles that a process still
        // owned when it was removed without reaching sys_exit (worker crash,
        // explicit host termination, or failed fork/spawn launch). Normal
        // exit closes every fd first, so these lists are empty on the zombie
        // reaping path. Fork/spawn share positive host handles by refcount;
        // only the last process queues the underlying host_close.
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            if ofd.dir_host_handle >= 0 {
                host_dir_closes.push(ofd.dir_host_handle);
            }
            if ofd.host_handle < 0 {
                continue;
            }
            if matches!(
                ofd.file_type,
                FileType::Regular | FileType::Directory | FileType::CharDevice | FileType::Pipe
            ) && crate::ofd::host_handle_close_ref(ofd.host_handle)
            {
                host_closes.push(ofd.host_handle);
            }
        }
        for stream in proc.dir_streams.iter().flatten() {
            host_dir_closes.push(stream.host_handle);
        }

        // Clean up socket OFDs. Active TCP streams use the same orderly FIN
        // and orphaned receive state as close(2); other socket kinds close
        // their pipe endpoints directly.
        // Without this, a peer process reading from a connected socket would
        // block forever instead of getting EOF when this process exits.
        //
        // NOTE: refcount drops for shared_backlog_idx and host_net_handle
        // happen in the separate per-socket loop below — once per socket
        // entry, not once per Socket OFD. That matches the per-socket bump
        // in `bump_inherited_resource_refcounts` and stays consistent
        // regardless of fd-dup count.
        for (_ofd_idx, ofd) in proc.ofd_table.iter() {
            if ofd.file_type == FileType::Socket && ofd.host_handle < 0 {
                let sock_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(sock) = proc.sockets.get(sock_idx) {
                    if sock.global_pipes {
                        let orderly_tcp_close = matches!(
                            (sock.domain, sock.sock_type),
                            (
                                crate::socket::SocketDomain::Inet
                                    | crate::socket::SocketDomain::Inet6,
                                crate::socket::SocketType::Stream,
                            )
                        );
                        // Cross-process socket: close pipe ends in global table
                        if let Some(send_idx) = sock.send_buf_idx {
                            if let Some(pipe) = pipe_table.get_mut(send_idx) {
                                pipe.close_write_end();
                            }
                            pipe_table.free_if_closed(send_idx);
                        }
                        if let Some(recv_idx) = sock.recv_buf_idx {
                            if let Some(pipe) = pipe_table.get_mut(recv_idx) {
                                if orderly_tcp_close {
                                    pipe.close_read_end_orderly();
                                } else {
                                    pipe.close_read_end();
                                }
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

        // Drop cross-process refcounts for socket-side resources, once per
        // socket entry. Mirrors the per-socket bump in
        // `bump_inherited_resource_refcounts` so a fork/spawn parent and
        // child each contribute exactly one ref on inheritance and one
        // drop on exit. Sockets that the process closed via sys_close are
        // already removed from `proc.sockets` (sys_close calls
        // `sockets.free` on its happy path), so this loop visits only
        // entries the process held until exit.
        let shared_backlog_table = unsafe { crate::socket::shared_listener_backlog_table() };
        for sock_idx in 0..proc.sockets.len() {
            if let Some(sock) = proc.sockets.get(sock_idx) {
                if let Some(shared_idx) = sock.shared_backlog_idx {
                    shared_backlog_table.dec_ref(shared_idx);
                }
                if let Some(net_handle) = sock.host_net_handle {
                    if crate::socket::host_net_handle_close_ref(net_handle) {
                        host_net_closes.push(net_handle);
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

        // Clean up AF_INET bind table entries for sockets the process held.
        crate::socket::udp_cleanup_process(pid);
        crate::socket::udp6_cleanup_process(pid);
        crate::socket::tcp_cleanup_process(pid);
        crate::socket::tcp6_cleanup_process(pid);

        // Release any PTHREAD_PROCESS_SHARED primitives owned by this pid
        // so peers aren't wedged on mutexes or waiter queues.
        let pshared = unsafe { crate::pshared::global_pshared_table() };
        pshared.cleanup_process(pid);

        // Release kernel fallback advisory locks. Host-backed locks are owned
        // by the host shared lock table; fallback locks for non-host files are
        // coordinated by the kernel.
        let fallback_locks = unsafe { crate::lock::global_fallback_lock_table() };
        fallback_locks.remove_all_for_pid(pid);
        for (ofd_idx, ofd) in proc.ofd_table.iter() {
            let ofd_lock_owner = (ofd_idx as u32) | 0x80000000;
            fallback_locks.remove_for_handle(ofd.host_handle, ofd_lock_owner);
        }

        if retain_limbo_leader && proc.pgid == pid && self.group_has_member(pid) {
            self.processes.insert(pid, Self::limbo_process_from(&proc));
        }

        Some(RemoveProcessResult {
            process: proc,
            host_closes,
            host_dir_closes,
            host_net_closes,
        })
    }

    fn group_has_member(&self, pgid: u32) -> bool {
        self.processes.iter().any(|(&pid, proc)| {
            pid != pgid && proc.pgid == pgid && proc.state != ProcessState::Limbo
        })
    }

    fn limbo_process_from(proc: &Process) -> Process {
        let mut limbo = Process::new(proc.pid);
        limbo.ppid = proc.ppid;
        limbo.uid = proc.uid;
        limbo.gid = proc.gid;
        limbo.euid = proc.euid;
        limbo.egid = proc.egid;
        limbo.pgid = proc.pgid;
        limbo.sid = proc.sid;
        limbo.is_session_leader = proc.is_session_leader;
        limbo.state = ProcessState::Limbo;
        limbo.exit_status = proc.exit_status;
        limbo.exit_signal = proc.exit_signal;
        limbo.cwd = proc.cwd.clone();
        limbo.environ = proc.environ.clone();
        limbo.argv = proc.argv.clone();
        limbo.umask = proc.umask;
        limbo.nice = proc.nice;
        limbo.rlimits = proc.rlimits;
        limbo.thread_name = proc.thread_name;
        limbo.has_exec = proc.has_exec;

        // Limbo records must not own any resources because teardown already
        // ran for the real process.
        limbo.fd_table = crate::fd::FdTable::new();
        limbo.ofd_table = crate::ofd::OfdTable::new();
        limbo
    }

    pub fn prune_empty_limbo_groups(&mut self) {
        let limbo_pids: Vec<u32> = self
            .processes
            .iter()
            .filter(|(pid, proc)| {
                let pid = **pid;
                proc.state == ProcessState::Limbo && proc.pgid == pid && !self.group_has_member(pid)
            })
            .map(|(pid, _)| *pid)
            .collect();

        for pid in limbo_pids {
            self.processes.remove(&pid);
        }
    }

    /// Set the current pid for syscall dispatch.
    pub fn set_current_pid(&mut self, pid: u32) {
        self.current_pid = pid;
    }

    /// Get the current pid.
    pub fn current_pid(&self) -> u32 {
        self.current_pid
    }

    /// Set the current kernel/libc thread id for the next serialized dispatch.
    ///
    /// The host calls this after selecting a pthread channel and before
    /// `kernel_handle_channel` so gettid, set_tid_address, pthread signal masks,
    /// directed signal delivery, and clear-TID cleanup all refer to the calling
    /// thread. `0` means "main thread" and is the default.
    pub fn set_current_tid(&mut self, tid: u32) {
        self.current_tid = tid;
    }

    /// Get the current kernel/libc thread id (0 for main thread).
    pub fn current_tid(&self) -> u32 {
        self.current_tid
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
        let serialized_parent = {
            let parent = self.processes.get(&parent_pid).ok_or(Errno::ESRCH)?;
            if matches!(
                parent.state,
                crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
            ) {
                return Err(Errno::ESRCH);
            }
            serialize_fork_state_with_growing_buffer(parent)?
        };

        // Deserialize as child
        let mut child = crate::fork::deserialize_fork_state(&serialized_parent, child_pid)?;

        // Bump cross-process refcounts on inherited fd state (host handles,
        // global pipes, PTYs, socket-pipes). Identical to spawn's needs —
        // factored out into a free helper.
        bump_inherited_resource_refcounts(parent_pid, &child)?;

        // Build fork-only `fork_pipe_replay` (fork replay needs it to
        // return the same fds as the parent did when re-running
        // pre-fork code). Spawn doesn't replay, so this stays fork-local.
        child.fork_pipe_replay = build_fork_pipe_replay(&child);

        self.processes.insert(child_pid, child);

        // Parent's fork-counter regression guardrail. The non-forking spawn
        // tests assert this stays put across a SYS_SPAWN, proving the new
        // path doesn't fall back to fork.
        if let Some(parent) = self.processes.get_mut(&parent_pid) {
            parent.increment_fork_count();
        }

        Ok(())
    }

    /// Insert a process produced by the retained legacy fork-state ABI.
    /// Unlike a raw map insert, this refuses to replace an existing pid and
    /// either establishes same-instance inherited refs or preserves fresh-
    /// kernel sole ownership before moving the process into the table.
    #[cfg_attr(
        not(any(target_arch = "wasm32", target_arch = "wasm64")),
        allow(dead_code)
    )]
    pub(crate) fn insert_legacy_fork_process(&mut self, child: Process) -> Result<(), Errno> {
        if self.processes.contains_key(&child.pid) {
            return Err(Errno::EEXIST);
        }

        if self.processes.contains_key(&child.ppid) {
            // Same-instance legacy install: the parent still owns every
            // inherited resource, so establish the child's additional refs.
            bump_inherited_resource_refcounts(child.ppid, &child)?;
        } else {
            // The retained ABI also initializes a fresh kernel instance where
            // the parent Process is intentionally absent. Ordinary host-backed
            // handles are sole-owned by that child and must not receive a
            // phantom parent ref. Kernel-global descriptor backings are not
            // serialized, however, so accepting one here could alias a reused
            // slot; fail truthfully instead.
            if child.ofd_table.iter().any(|(_, ofd)| {
                crate::descriptor_backing::manages_ofd(ofd.file_type, ofd.host_handle)
            }) {
                return Err(Errno::EBADF);
            }
        }
        self.processes.insert(child.pid, child);
        Ok(())
    }

    /// Replace an existing process through the retained legacy exec-state
    /// ABI, transferring one ownership reference for surviving descriptor
    /// backings and releasing old CLOEXEC-only/orphaned OFDs exactly once.
    #[cfg_attr(
        not(any(target_arch = "wasm32", target_arch = "wasm64")),
        allow(dead_code)
    )]
    pub(crate) fn replace_legacy_exec_process(
        &mut self,
        pid: u32,
        mut replacement: Process,
    ) -> Result<(), Errno> {
        if replacement.pid != pid {
            return Err(Errno::EINVAL);
        }
        if let Some(old) = self.processes.get(&pid) {
            if matches!(old.state, ProcessState::Exited | ProcessState::Limbo) {
                return Err(Errno::ESRCH);
            }
            // Exec replaces the image, not the process identity or its
            // job-control state or unconsumed parent-visible status record.
            replacement.state = old.state;
            replacement.wait_event = old.wait_event;
            let removed = crate::descriptor_backing::removed_backings_for_exec(old, &replacement)?;
            let old = self.processes.insert(pid, replacement).unwrap();
            crate::descriptor_backing::release_backings(&removed);
            drop(old);
        } else {
            // A fresh kernel instance has no old Process from which to
            // transfer global backing ownership, and the retained wire format
            // does not serialize those backing values. Reject them instead of
            // letting a stale stable index alias this instance's current or
            // future allocation at the same slot.
            if replacement.ofd_table.iter().any(|(_, ofd)| {
                crate::descriptor_backing::manages_ofd(ofd.file_type, ofd.host_handle)
            }) {
                return Err(Errno::EBADF);
            }
            self.processes.insert(pid, replacement);
        }
        Ok(())
    }

    /// Non-forking spawn: build a child process for `posix_spawn` without
    /// going through fork continuation at all. The child is constructed from a
    /// fresh `Process::new(child_pid)` and selectively inherits only what
    /// POSIX requires (identity, cwd, umask, rlimits, signal mask, fd
    /// state); everything else (signal handlers, threads, mmap, alt-stack,
    /// terminal state, pending signals, alarms) is left at the
    /// `Process::new` defaults — exec semantics would reset those anyway.
    ///
    /// `argv` and `envp` come from the spawn caller, not the parent.
    ///
    /// Critically, `fork_count` on the parent is **not** incremented.
    ///
    /// File actions and spawn attributes are accepted but not yet applied
    /// (Tasks 8 / 9).
    pub fn spawn_child(
        &mut self,
        parent_pid: u32,
        argv: &[&[u8]],
        envp: &[&[u8]],
        file_actions: &[crate::spawn::FileAction],
        attrs: &crate::spawn::SpawnAttrs,
        host: &mut dyn crate::process::HostIO,
    ) -> Result<u32, Errno> {
        // Snapshot inheritable parent state under an immutable borrow.
        let inherit = {
            let parent = self.processes.get(&parent_pid).ok_or(Errno::ESRCH)?;
            if matches!(
                parent.state,
                crate::process::ProcessState::Exited | crate::process::ProcessState::Limbo
            ) {
                return Err(Errno::ESRCH);
            }
            // Compute the SIG_IGN-disposition bitmask for signals 1..=64.
            let mut ignored_signals: u64 = 0;
            for sig in 1u32..=64 {
                if parent.signals.get_handler(sig) == crate::signal::SignalHandler::Ignore {
                    ignored_signals |= 1u64 << (sig - 1);
                }
            }
            SpawnInheritFromParent {
                uid: parent.uid,
                gid: parent.gid,
                euid: parent.euid,
                egid: parent.egid,
                pgid: parent.pgid,
                sid: parent.sid,
                umask: parent.umask,
                nice: parent.nice,
                rlimits: parent.rlimits,
                cwd: parent.cwd.clone(),
                blocked_signals: parent.signals.blocked,
                ignored_signals,
                fd_table: parent.fd_table.clone(),
                ofd_table: parent.ofd_table.clone(),
                sockets: parent.sockets.clone(),
            }
        };

        let child_pid = self.allocate_spawn_pid();
        let mut child = Process::new(child_pid);

        // ── POSIX-required inheritance ─────────────────────────────────
        child.ppid = parent_pid;
        child.uid = inherit.uid;
        child.gid = inherit.gid;
        child.euid = inherit.euid;
        child.egid = inherit.egid;
        child.pgid = inherit.pgid; // POSIX_SPAWN_SETPGROUP may override (Task 9).
        child.sid = inherit.sid; // POSIX_SPAWN_SETSID may override (Task 9).
        child.umask = inherit.umask;
        child.nice = inherit.nice;
        child.rlimits = inherit.rlimits;
        child.cwd = inherit.cwd;

        // The new program's argv/envp come from the spawn caller.
        child.argv = argv.iter().map(|s| s.to_vec()).collect();
        child.environ = envp.iter().map(|s| s.to_vec()).collect();

        // Parent's fd state replaces the fresh process fd table; spawn
        // inherits the parent's open fds instead of creating new stdio.
        // The constructor-created OFDs at indices 0/1/2 are dropped here
        // without decrementing any global refcount because they never
        // bumped one.
        child.fd_table = inherit.fd_table;
        child.ofd_table = inherit.ofd_table;
        child.sockets = inherit.sockets;

        // Signal state inheritance:
        //   * Blocked mask: inherited from parent unless SETSIGMASK overrides.
        //   * Handlers: parent's custom handlers reset to SIG_DFL (POSIX exec
        //     semantics); SIG_IGN dispositions are preserved across the
        //     implicit exec; SETSIGDEF (below) can force named signals back
        //     to SIG_DFL.
        child.signals.blocked = inherit.blocked_signals;
        for sig in 1u32..=64 {
            if (inherit.ignored_signals & (1u64 << (sig - 1))) != 0 {
                // SIGKILL/SIGSTOP can never be ignored, so they can't appear
                // in this mask; set_handler still rejects them — ignore Err.
                let _ = child
                    .signals
                    .set_handler(sig, crate::signal::SignalHandler::Ignore);
            }
        }

        // Apply spawn attrs in POSIX order (SETSID → SETPGROUP → SETSIGMASK
        // → SETSIGDEF). All operate on local Process state and are
        // infallible; happens before file actions, before insertion.
        {
            use crate::spawn::attr_flags;
            if attrs.flags & attr_flags::SETSID != 0 {
                child.sid = child.pid;
                child.pgid = child.pid;
                child.is_session_leader = true;
                // POSIX also releases the controlling tty here. The spawn
                // child starts from fresh terminal state, so there's no ctty
                // to release.
            }
            if attrs.flags & attr_flags::SETPGROUP != 0 {
                child.pgid = if attrs.pgrp == 0 {
                    child.pid
                } else {
                    attrs.pgrp as u32
                };
            }
            if attrs.flags & attr_flags::SETSIGMASK != 0 {
                child.signals.blocked = attrs.sigmask;
            }
            if attrs.flags & attr_flags::SETSIGDEF != 0 {
                for sig in 1u32..=64 {
                    if (attrs.sigdef & (1u64 << (sig - 1))) != 0 {
                        // SIGKILL/SIGSTOP set_handler rejects — ignore Err
                        // (those signals are always SIG_DFL anyway).
                        let _ = child
                            .signals
                            .set_handler(sig, crate::signal::SignalHandler::Default);
                    }
                }
            }
        }

        // Bump cross-process refcounts on the inherited fd state. The same
        // helper fork uses — this is the genuinely-shared concern.
        bump_inherited_resource_refcounts(parent_pid, &child)?;

        self.processes.insert(child_pid, child);

        // Apply file actions in forward order against the child. Any failure
        // rolls back the partial child via remove_process — which runs the
        // proper exit cleanup (decrements every refcount we bumped, drops
        // any newly-opened fds, queues last-ref host net handles for close).
        if let Err(e) = self.apply_spawn_file_actions(child_pid, file_actions, host) {
            if let Some(removed) = self.remove_process(child_pid) {
                for dir_handle in removed.host_dir_closes {
                    let _ = host.host_closedir(dir_handle);
                }
                for handle in removed.host_closes {
                    let _ = host.host_close(handle);
                }
                for net_handle in removed.host_net_closes {
                    let _ = host.host_net_close(net_handle);
                }
            }
            return Err(e);
        }

        Ok(child_pid)
    }

    /// Apply a list of `posix_spawn` file actions to the child process,
    /// in the order given. Each action is dispatched to the existing
    /// `sys_*` helper that takes `&mut Process`. On error, returns the
    /// errno; the caller (`spawn_child`) is responsible for cleanup.
    fn apply_spawn_file_actions(
        &mut self,
        child_pid: u32,
        file_actions: &[crate::spawn::FileAction],
        host: &mut dyn crate::process::HostIO,
    ) -> Result<(), Errno> {
        use crate::spawn::FileAction;
        for action in file_actions {
            let child = self.processes.get_mut(&child_pid).ok_or(Errno::ESRCH)?;
            match action {
                FileAction::Close { fd } => {
                    // POSIX: close errors are silently ignored for spawn.
                    let _ = crate::syscalls::sys_close(child, host, *fd);
                }
                FileAction::Dup2 { srcfd, fd } => {
                    if srcfd == fd {
                        // POSIX dup2(N,N) clears FD_CLOEXEC if N is open;
                        // EBADF otherwise.
                        let entry = child.fd_table.get_mut(*fd)?;
                        entry.fd_flags &= !wasm_posix_shared::fd_flags::FD_CLOEXEC;
                    } else {
                        let _ = crate::syscalls::sys_dup2(child, host, *srcfd, *fd)?;
                    }
                }
                FileAction::Open {
                    fd,
                    path,
                    oflag,
                    mode,
                } => {
                    let opened =
                        crate::syscalls::sys_open(child, host, path, *oflag as u32, *mode)?;
                    if opened != *fd {
                        // Move opened fd to the requested target slot.
                        let r = crate::syscalls::sys_dup2(child, host, opened, *fd);
                        // Always close the temporary fd, even if dup2 failed —
                        // we don't want to leak it on the error path.
                        let _ = crate::syscalls::sys_close(child, host, opened);
                        let _ = r?;
                    }
                }
                FileAction::Chdir { path } => {
                    crate::syscalls::sys_chdir(child, host, path)?;
                }
                FileAction::Fchdir { fd } => {
                    crate::syscalls::sys_fchdir(child, *fd)?;
                }
            }
        }

        // POSIX exec semantics: after file_actions are applied, any fd that
        // still has FD_CLOEXEC set is closed before the new program image
        // runs. The dup2(N, N) self-dup pattern clears FD_CLOEXEC on the
        // target fd specifically to RESCUE it from this closure (sortix
        // basic/spawn/posix_spawn_file_actions_adddup2 exercises exactly
        // this). Run after the action loop so file actions can rescue or
        // clear individual fds before the sweep.
        let child = self.processes.get_mut(&child_pid).ok_or(Errno::ESRCH)?;
        let cloexec_fds: Vec<i32> = child
            .fd_table
            .iter()
            .filter(|(_fd, e)| e.fd_flags & wasm_posix_shared::fd_flags::FD_CLOEXEC != 0)
            .map(|(fd, _)| fd)
            .collect();
        for fd in cloexec_fds {
            // POSIX: close errors here are silently ignored — same policy
            // as the FileAction::Close handler above.
            let _ = crate::syscalls::sys_close(child, host, fd);
        }

        Ok(())
    }

    /// Next unused spawn pid >= 2 (pid 1 is reserved for init).
    ///
    /// Keep this monotonic instead of reusing the smallest recently-reaped pid.
    /// The JS host can still be asynchronously terminating pthread workers for
    /// the old process generation after waitpid reaps it; avoiding immediate
    /// pid reuse prevents stale host cleanup from targeting the new child.
    fn allocate_spawn_pid(&mut self) -> u32 {
        let mut pid = self.next_spawn_pid.max(2);
        while self.processes.contains_key(&pid) {
            pid += 1;
        }
        self.next_spawn_pid = pid.saturating_add(1).max(2);
        pid
    }

    /// Get a reference to a process by pid.
    pub fn get(&self, pid: u32) -> Option<&Process> {
        self.processes.get(&pid)
    }

    /// Find the process record that owns a retained Linux-style task ID.
    ///
    /// A process leader's TID is its PID; pthread TIDs live in the owning
    /// Process record. Exited leaders remain addressable until reaped, while a
    /// Limbo record is only an internal process-group/session placeholder.
    pub fn get_process_containing_task(&self, tid: u32) -> Option<&Process> {
        if let Some(leader) = self
            .processes
            .get(&tid)
            .filter(|process| process.state != ProcessState::Limbo)
        {
            return Some(leader);
        }

        self.processes.values().find(|process| {
            matches!(process.state, ProcessState::Running | ProcessState::Stopped)
                && process.get_thread(tid).is_some()
        })
    }

    /// Collect every retained PID, including internal limbo identities.
    pub fn all_pids(&self) -> Vec<u32> {
        self.processes.keys().copied().collect()
    }

    /// Collect PIDs that should be visible through procfs.
    ///
    /// Exited processes remain visible as zombies until their parent reaps
    /// them. Limbo entries are already reaped and retained only as internal
    /// process-group/session identities, so exposing them as `/proc/<pid>`
    /// would resurrect a process that no longer exists.
    pub fn procfs_pids(&self) -> Vec<u32> {
        self.processes
            .iter()
            .filter(|(_, proc)| proc.state != ProcessState::Limbo)
            .map(|(&pid, _)| pid)
            .collect()
    }

    /// Collect PIDs of all processes in a given process group.
    pub fn pids_in_group(&self, pgid: u32) -> Vec<u32> {
        self.processes
            .iter()
            .filter(|(_, p)| p.pgid == pgid && p.state != ProcessState::Limbo)
            .map(|(&pid, _)| pid)
            .collect()
    }

    /// Return the recorded parent pid for a process.
    pub fn parent_pid(&self, pid: u32) -> Option<u32> {
        self.processes.get(&pid).map(|proc| proc.ppid)
    }

    /// Mark a process as terminated by a host-observed signal death.
    ///
    /// Used when the worker dies without reaching the normal `SYS_EXIT`
    /// path. The process remains in the table as an Exited zombie until its
    /// parent reaps it, so wait semantics stay kernel-owned.
    pub fn mark_process_signaled(&mut self, pid: u32, signum: u32) -> Result<(), Errno> {
        let proc = self.processes.get_mut(&pid).ok_or(Errno::ESRCH)?;
        proc.record_signal_exit(signum);
        Ok(())
    }

    /// Select the latest status-information record for a direct child.
    /// Nonmatching masks and WNOWAIT leave that single record untouched.
    pub fn poll_wait_event(
        &mut self,
        parent_pid: u32,
        target_pid: i32,
        event_mask: u32,
        flags: u32,
    ) -> Result<Option<(u32, ChildWaitEvent)>, Errno> {
        use wasm_posix_shared::wait::{
            EVENT_CONTINUED, EVENT_EXITED, EVENT_STOPPED, WNOWAIT,
        };

        let valid_events = EVENT_EXITED | EVENT_STOPPED | EVENT_CONTINUED;
        if event_mask == 0 || event_mask & !valid_events != 0 || flags & !WNOWAIT != 0 {
            return Err(Errno::EINVAL);
        }

        let parent_pgid = self
            .processes
            .get(&parent_pid)
            .ok_or(Errno::ESRCH)?
            .pgid;
        let mut saw_matching_child = false;

        for (&child_pid, child) in &mut self.processes {
            if child.ppid != parent_pid || child.state == ProcessState::Limbo {
                continue;
            }
            if !Self::child_matches_wait_target(child_pid, child, target_pid, parent_pgid) {
                continue;
            }
            saw_matching_child = true;

            let Some(event) = child.wait_event else {
                continue;
            };
            if event.event_mask & event_mask == 0 {
                continue;
            }
            if flags & WNOWAIT == 0 {
                child.wait_event = None;
            }
            return Ok(Some((child_pid, event)));
        }

        if saw_matching_child {
            Ok(None)
        } else {
            Err(Errno::ECHILD)
        }
    }

    /// True when `child_pid` is an exited direct child of `parent_pid`.
    pub fn is_exited_child_of(&self, parent_pid: u32, child_pid: u32) -> bool {
        self.processes
            .get(&child_pid)
            .map(|child| child.ppid == parent_pid && child.state == ProcessState::Exited)
            .unwrap_or(false)
    }

    fn child_matches_wait_target(
        child_pid: u32,
        child: &Process,
        target_pid: i32,
        parent_pgid: u32,
    ) -> bool {
        if target_pid > 0 {
            return child_pid == target_pid as u32;
        }
        if target_pid == -1 {
            return true;
        }
        if target_pid == 0 {
            return child.pgid == parent_pgid;
        }
        let Some(target_pgid) = target_pid.checked_neg().map(|pid| pid as u32) else {
            return false;
        };
        child.pgid == target_pgid
    }
}

#[cfg(test)]
mod wait_tests {
    use super::*;

    #[test]
    fn spawn_pid_allocation_does_not_reuse_reaped_pid() {
        let mut table = ProcessTable::new();

        let first_pid = table.allocate_spawn_pid();
        table.processes.insert(first_pid, Process::new(first_pid));
        table.processes.remove(&first_pid);

        let second_pid = table.allocate_spawn_pid();
        assert!(
            second_pid > first_pid,
            "spawn pid allocation must not immediately reuse a reaped pid"
        );
    }

    #[test]
    fn reap_retains_group_leader_as_limbo_until_group_empties() {
        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();
        table.fork_process(100, 101).unwrap();
        table.fork_process(100, 102).unwrap();
        table.processes.get_mut(&101).unwrap().pgid = 101;
        table.processes.get_mut(&102).unwrap().pgid = 101;
        table.processes.get_mut(&101).unwrap().state = ProcessState::Exited;

        assert!(
            table.procfs_pids().contains(&101),
            "an unreaped zombie remains visible through procfs"
        );

        table.reap_process(101).expect("reap group leader");

        let limbo = table.get(101).expect("limbo leader retained");
        assert_eq!(limbo.state, ProcessState::Limbo);
        assert_eq!(limbo.pgid, 101);
        assert_eq!(limbo.ppid, 100);
        assert!(table.all_pids().contains(&101));
        assert!(
            !table.procfs_pids().contains(&101),
            "a reaped limbo identity must not remain visible through procfs"
        );

        table.processes.get_mut(&102).unwrap().state = ProcessState::Exited;
        table.reap_process(102).expect("reap final member");
        assert!(table.get(101).is_none(), "empty limbo group is pruned");
    }

    #[test]
    fn remove_process_does_not_create_limbo_record() {
        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();
        table.fork_process(100, 101).unwrap();
        table.fork_process(100, 102).unwrap();
        table.processes.get_mut(&101).unwrap().pgid = 101;
        table.processes.get_mut(&102).unwrap().pgid = 101;
        table.processes.get_mut(&101).unwrap().state = ProcessState::Exited;

        table.remove_process(101).expect("remove group leader");

        assert!(table.get(101).is_none());
        assert_eq!(table.get(102).unwrap().pgid, 101);
    }
}

/// Global process table wrapper for static storage.
pub struct GlobalProcessTable(pub UnsafeCell<ProcessTable>);

/// SAFETY: Access is serialized — the kernel services one syscall at a time
/// from the JS event loop (no concurrent Wasm execution).
unsafe impl Sync for GlobalProcessTable {}

/// Single global `ProcessTable` instance used by the kernel. Lives here
/// (rather than inside `wasm_api.rs`) so other modules can read the
/// currently-serviced `pid`/`tid` without a back-reference through the export
/// layer.
pub static GLOBAL_PROCESS_TABLE: GlobalProcessTable =
    GlobalProcessTable(UnsafeCell::new(ProcessTable::new()));

/// Read the currently-serviced kernel/libc thread id (0 = main thread).
#[inline]
pub fn current_tid() -> u32 {
    unsafe { (*GLOBAL_PROCESS_TABLE.0.get()).current_tid() }
}

/// Read the currently-serviced process id.
#[inline]
pub fn current_pid() -> u32 {
    unsafe { (*GLOBAL_PROCESS_TABLE.0.get()).current_pid() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_state_install_rejects_collisions_but_allows_fresh_kernel_tables() {
        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();
        table.get_mut(100).unwrap().argv = alloc::vec![b"original".to_vec()];

        let mut colliding_fork = Process::new(100);
        colliding_fork.ppid = 100;
        assert_eq!(
            table.insert_legacy_fork_process(colliding_fork),
            Err(Errno::EEXIST)
        );
        assert_eq!(table.get(100).unwrap().argv[0], b"original");

        let mut child_without_local_parent = Process::new(101);
        child_without_local_parent.ppid = 999;
        table
            .insert_legacy_fork_process(child_without_local_parent)
            .unwrap();
        assert_eq!(table.get(101).unwrap().ppid, 999);

        table
            .replace_legacy_exec_process(777, Process::new(777))
            .unwrap();
        assert!(table.get(777).is_some());
        assert_eq!(
            table.replace_legacy_exec_process(100, Process::new(102)),
            Err(Errno::EINVAL)
        );
        assert_eq!(table.get(100).unwrap().argv[0], b"original");
    }

    #[test]
    fn legacy_exec_preserves_stopped_state_and_parent_visible_status_record() {
        use wasm_posix_shared::signal::SIGTSTP;
        use wasm_posix_shared::wait::EVENT_STOPPED;

        let mut table = ProcessTable::new();
        table.create_process(200).unwrap();
        assert!(table.get_mut(200).unwrap().record_stop(SIGTSTP));

        table
            .replace_legacy_exec_process(200, Process::new(200))
            .unwrap();

        assert_eq!(table.get(200).unwrap().state, ProcessState::Stopped);
        let event = table.get(200).unwrap().wait_event.unwrap();
        assert_eq!(event.event_mask, EVENT_STOPPED);
        assert_eq!(event.si_status, SIGTSTP as i32);
    }

    #[test]
    fn fork_pipe_replay_includes_fds_above_default_nofile_limit() {
        use crate::fd::OpenFileDescRef;
        use wasm_posix_shared::flags::{O_RDONLY, O_WRONLY};

        let mut child = Process::new(100);
        child.fd_table.set_max_fds(4096);
        let read_ofd = child
            .ofd_table
            .create(FileType::Pipe, O_RDONLY, -1, b"pipe-read".to_vec());
        let write_ofd = child
            .ofd_table
            .create(FileType::Pipe, O_WRONLY, -1, b"pipe-write".to_vec());
        let read_fd = child
            .fd_table
            .alloc_at_min(OpenFileDescRef(read_ofd), 0, 2048)
            .unwrap();
        let write_fd = child
            .fd_table
            .alloc_at_min(OpenFileDescRef(write_ofd), 0, 2049)
            .unwrap();

        assert_eq!(build_fork_pipe_replay(&child), vec![(read_fd, write_fd)]);
    }

    #[test]
    fn exited_parent_cannot_fork_or_spawn() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();
        table.get_mut(100).unwrap().state = crate::process::ProcessState::Exited;

        assert_eq!(table.fork_process(100, 101), Err(Errno::ESRCH));
        let mut host = NoopHost;
        assert_eq!(
            table.spawn_child(
                100,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            ),
            Err(Errno::ESRCH),
        );
    }

    #[test]
    fn stopped_parent_can_finish_spawn_after_async_resolution() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::signal::SIGSTOP;

        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();
        assert!(table.get_mut(100).unwrap().record_stop(SIGSTOP));

        // The host resolves a posix_spawn executable asynchronously. A stop
        // can land during that await; the parent remains a live process and
        // the resolved continuation must still be allowed to create its child.
        let mut host = NoopHost;
        let child_pid = table
            .spawn_child(
                100,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("stopped parent remains eligible to complete spawn");

        assert_eq!(table.get(100).unwrap().state, ProcessState::Stopped);
        assert_eq!(table.get(child_pid).unwrap().ppid, 100);
        assert_eq!(table.get(child_pid).unwrap().state, ProcessState::Running);
    }

    #[test]
    fn process_exit_closes_tcp_pipes_orderly() {
        use crate::pipe::{global_pipe_table, PipeBuffer, DEFAULT_PIPE_CAPACITY};
        use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};

        let pipe_table = unsafe { global_pipe_table() };
        let send_idx = pipe_table.alloc(PipeBuffer::new(DEFAULT_PIPE_CAPACITY));
        let recv_idx = pipe_table.alloc(PipeBuffer::new(DEFAULT_PIPE_CAPACITY));

        let mut table = ProcessTable::new();
        table.create_process(950_001).unwrap();
        let proc = table.processes.get_mut(&950_001).unwrap();
        let mut socket = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 6);
        socket.state = SocketState::Connected;
        socket.send_buf_idx = Some(send_idx);
        socket.recv_buf_idx = Some(recv_idx);
        socket.global_pipes = true;
        let sock_idx = proc.sockets.alloc(socket);
        let ofd_idx = proc.ofd_table.create(
            FileType::Socket,
            wasm_posix_shared::flags::O_RDWR,
            -((sock_idx as i64) + 1),
            Vec::new(),
        );
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        table.remove_process(950_001).unwrap();

        let send_pipe = pipe_table.get_mut(send_idx).unwrap();
        assert!(!send_pipe.is_write_end_open());
        assert!(send_pipe.is_read_end_open());
        let recv_pipe = pipe_table.get_mut(recv_idx).unwrap();
        assert!(recv_pipe.is_read_end_open());
        assert_eq!(recv_pipe.write(b"after-exit-one"), 14);
        assert_eq!(recv_pipe.write(b"after-exit-two"), 14);
        assert_eq!(recv_pipe.available(), 0);

        pipe_table.get_mut(send_idx).unwrap().close_read_end();
        pipe_table.free_if_closed(send_idx);
        pipe_table.get_mut(recv_idx).unwrap().close_write_end();
        pipe_table.free_if_closed(recv_idx);
        assert!(pipe_table.get(send_idx).is_none());
        assert!(pipe_table.get(recv_idx).is_none());
    }

    fn install_bound_udp4_socket(table: &mut ProcessTable, pid: u32, port: u16) -> usize {
        use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};

        let sock_idx = {
            let proc = table.processes.get_mut(&pid).unwrap();
            let mut socket = SocketInfo::new(SocketDomain::Inet, SocketType::Dgram, 17);
            socket.state = SocketState::Bound;
            socket.bind_addr = [127, 0, 0, 1];
            socket.bind_port = port;
            proc.sockets.alloc(socket)
        };
        crate::socket::udp_register(pid, sock_idx, [127, 0, 0, 1], port, false).unwrap();
        sock_idx
    }

    fn assert_udp_owner(port: u16, pid: u32, sock_idx: usize, present: bool) {
        let present_in_lookup = crate::socket::udp_lookup([127, 0, 0, 1], port)
            .iter()
            .any(|target| target.pid == pid && target.sock_idx == sock_idx);
        assert_eq!(present_in_lookup, present);
    }

    #[test]
    fn fork_process_grows_state_buffer_for_large_parent_state() {
        const LARGE_FD_COUNT: usize = 80;
        const LARGE_PATH_LEN: usize = 1024;

        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();

        let last_fd = {
            let parent = table.processes.get_mut(&100).unwrap();
            let mut last_fd = -1;

            for _ in 0..LARGE_FD_COUNT {
                let path = alloc::vec![b'x'; LARGE_PATH_LEN];
                let ofd_ref = parent.ofd_table.create(FileType::Regular, 0, -10, path);
                last_fd = parent
                    .fd_table
                    .alloc(crate::fd::OpenFileDescRef(ofd_ref), 0)
                    .unwrap();
            }

            last_fd
        };

        {
            let parent = table.processes.get(&100).unwrap();
            let mut old_limit_buf = alloc::vec![0u8; INITIAL_FORK_STATE_BUFFER_LEN];

            assert_eq!(
                crate::fork::serialize_fork_state(parent, &mut old_limit_buf),
                Err(Errno::ENOMEM)
            );
        }

        table
            .fork_process(100, 101)
            .expect("fork should grow its process-state buffer");

        let child = table.processes.get(&101).unwrap();
        let child_fd = child.fd_table.get(last_fd).unwrap();
        let child_ofd = child.ofd_table.get(child_fd.ofd_ref.0).unwrap();

        assert_eq!(child.ppid, 100);
        assert_eq!(child_ofd.file_type, FileType::Regular);
        assert_eq!(child_ofd.path.len(), LARGE_PATH_LEN);
    }

    #[test]
    fn fork_inherits_udp_binding_owner_before_parent_exit() {
        const PARENT: u32 = 930_001;
        const CHILD: u32 = 930_002;
        const PORT: u16 = 64_905;

        crate::socket::udp_cleanup_process(PARENT);
        crate::socket::udp_cleanup_process(CHILD);
        let mut table = ProcessTable::new();
        table.create_process(PARENT).unwrap();
        let sock_idx = install_bound_udp4_socket(&mut table, PARENT, PORT);

        table.fork_process(PARENT, CHILD).unwrap();
        assert_udp_owner(PORT, PARENT, sock_idx, true);
        assert_udp_owner(PORT, CHILD, sock_idx, true);

        table.remove_process(PARENT).unwrap();
        assert_udp_owner(PORT, PARENT, sock_idx, false);
        assert_udp_owner(PORT, CHILD, sock_idx, true);
        assert!(!crate::socket::udp_can_bind(
            930_003,
            0,
            [127, 0, 0, 1],
            PORT,
            false
        ));

        table.remove_process(CHILD).unwrap();
        assert!(crate::socket::udp_lookup([127, 0, 0, 1], PORT).is_empty());
        assert!(crate::socket::udp_can_bind(
            930_003,
            0,
            [127, 0, 0, 1],
            PORT,
            false
        ));
    }

    #[test]
    fn spawn_inherits_udp_binding_owner_before_parent_exit() {
        use crate::process::test_host::NoopHost;
        use crate::spawn::SpawnAttrs;

        const PARENT: u32 = 940_001;
        const PORT: u16 = 64_906;

        crate::socket::udp_cleanup_process(PARENT);
        let mut table = ProcessTable::new();
        table.create_process(PARENT).unwrap();
        let sock_idx = install_bound_udp4_socket(&mut table, PARENT, PORT);
        let mut host = NoopHost;

        let child_pid = table
            .spawn_child(
                PARENT,
                &[b"/bin/child".as_slice()],
                &[],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .unwrap();
        assert_udp_owner(PORT, PARENT, sock_idx, true);
        assert_udp_owner(PORT, child_pid, sock_idx, true);

        table.remove_process(PARENT).unwrap();
        assert_udp_owner(PORT, PARENT, sock_idx, false);
        assert_udp_owner(PORT, child_pid, sock_idx, true);

        table.remove_process(child_pid).unwrap();
        assert!(crate::socket::udp_lookup([127, 0, 0, 1], PORT).is_empty());
    }

    #[test]
    fn poll_wait_event_selects_and_consumes_exit_status() {
        use wasm_posix_shared::wait::{CLD_EXITED, EVENT_EXITED};

        let mut table = ProcessTable::new();
        table.create_process(10).unwrap();
        table.create_process(11).unwrap();
        let child = table.processes.get_mut(&11).unwrap();
        child.ppid = 10;
        assert!(child.record_normal_exit(7));

        let (pid, event) = table
            .poll_wait_event(10, -1, EVENT_EXITED, 0)
            .unwrap()
            .unwrap();
        assert_eq!(pid, 11);
        assert_eq!(event.wait_status, 7 << 8);
        assert_eq!(event.si_code, CLD_EXITED);
        assert_eq!(event.si_status, 7);
        assert!(table.get(11).unwrap().wait_event.is_none());
        assert_eq!(table.poll_wait_event(10, -1, EVENT_EXITED, 0), Ok(None));
    }

    #[test]
    fn poll_wait_event_wnowait_repeats_the_same_signal_exit() {
        use wasm_posix_shared::wait::{CLD_KILLED, EVENT_EXITED, WNOWAIT};

        let mut table = ProcessTable::new();
        table.create_process(10).unwrap();
        table.create_process(11).unwrap();
        table.processes.get_mut(&11).unwrap().ppid = 10;
        table.mark_process_signaled(11, 15).unwrap();

        for _ in 0..2 {
            let (_, event) = table
                .poll_wait_event(10, 11, EVENT_EXITED, WNOWAIT)
                .unwrap()
                .unwrap();
            assert_eq!(event.wait_status, 15);
            assert_eq!(event.si_code, CLD_KILLED);
            assert_eq!(event.si_status, 15);
        }
        assert!(table.get(11).unwrap().wait_event.is_some());
    }

    #[test]
    fn poll_wait_event_nonmatching_mask_preserves_latest_record() {
        use wasm_posix_shared::signal::SIGTSTP;
        use wasm_posix_shared::wait::{EVENT_EXITED, EVENT_STOPPED};

        let mut table = ProcessTable::new();
        table.create_process(10).unwrap();
        table.create_process(11).unwrap();
        let child = table.processes.get_mut(&11).unwrap();
        child.ppid = 10;
        assert!(child.record_stop(SIGTSTP));

        assert_eq!(table.poll_wait_event(10, -1, EVENT_EXITED, 0), Ok(None));
        assert_eq!(
            table.get(11).unwrap().wait_event.unwrap().event_mask,
            EVENT_STOPPED
        );
        assert!(
            table
                .poll_wait_event(10, -1, EVENT_STOPPED, 0)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn poll_wait_event_distinguishes_running_from_no_child_and_validates_input() {
        use wasm_posix_shared::wait::{EVENT_EXITED, WNOWAIT};

        let mut table = ProcessTable::new();
        table.create_process(10).unwrap();
        table.create_process(11).unwrap();
        table.processes.get_mut(&11).unwrap().ppid = 10;

        assert_eq!(table.poll_wait_event(10, -1, EVENT_EXITED, 0), Ok(None));
        assert_eq!(
            table.poll_wait_event(10, 12, EVENT_EXITED, 0),
            Err(Errno::ECHILD)
        );
        assert_eq!(table.poll_wait_event(10, -1, 0, 0), Err(Errno::EINVAL));
        assert_eq!(
            table.poll_wait_event(10, -1, EVENT_EXITED, WNOWAIT | 2),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn poll_wait_event_matches_process_groups() {
        use wasm_posix_shared::wait::EVENT_EXITED;

        let mut table = ProcessTable::new();
        table.create_process(10).unwrap();
        table.processes.get_mut(&10).unwrap().pgid = 20;
        table.create_process(11).unwrap();
        {
            let child = table.processes.get_mut(&11).unwrap();
            child.ppid = 10;
            child.pgid = 20;
            child.record_normal_exit(0);
        }
        table.create_process(12).unwrap();
        {
            let child = table.processes.get_mut(&12).unwrap();
            child.ppid = 10;
            child.pgid = 30;
            child.record_normal_exit(1);
        }

        assert_eq!(
            table
                .poll_wait_event(10, 0, EVENT_EXITED, 0)
                .unwrap()
                .unwrap()
                .0,
            11
        );
        assert_eq!(
            table
                .poll_wait_event(10, -30, EVENT_EXITED, 0)
                .unwrap()
                .unwrap()
                .0,
            12
        );
    }

    #[test]
    fn remove_process_releases_global_fallback_locks() {
        let _guard = crate::lock::FALLBACK_LOCK_TEST_LOCK.lock().unwrap();
        unsafe { crate::lock::global_fallback_lock_table().clear() };

        let mut table = ProcessTable::new();
        table.create_process(20).unwrap();
        let proc = table.processes.get_mut(&20).unwrap();
        let host_handle = -900;
        let ofd_idx = proc.ofd_table.create(
            FileType::Pipe,
            wasm_posix_shared::flags::O_RDWR,
            host_handle,
            b"/dev/pipe".to_vec(),
        );
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let ofd_owner = (ofd_idx as u32) | 0x80000000;
        unsafe { crate::lock::global_fallback_lock_table() }.set_lock(
            host_handle,
            crate::lock::FileLock {
                pid: 20,
                lock_type: wasm_posix_shared::lock_type::F_WRLCK,
                start: 0,
                len: 100,
            },
        );
        unsafe { crate::lock::global_fallback_lock_table() }.set_lock(
            host_handle,
            crate::lock::FileLock {
                pid: ofd_owner,
                lock_type: wasm_posix_shared::lock_type::F_WRLCK,
                start: 200,
                len: 100,
            },
        );

        table.remove_process(20).expect("process removed");

        let locks = unsafe { crate::lock::global_fallback_lock_table() };
        assert!(
            locks
                .get_blocking_lock(
                    host_handle,
                    wasm_posix_shared::lock_type::F_WRLCK,
                    0,
                    100,
                    99
                )
                .is_none()
        );
        assert!(
            locks
                .get_blocking_lock(
                    host_handle,
                    wasm_posix_shared::lock_type::F_WRLCK,
                    200,
                    100,
                    99
                )
                .is_none()
        );
        locks.clear();
    }

    #[test]
    fn task_lookup_prefers_leaders_and_excludes_dead_worker_threads() {
        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();
        table.create_process(200).unwrap();
        table
            .get_mut(100)
            .unwrap()
            .add_thread(crate::process::ThreadInfo::new(900, 0, 0, 0));
        table
            .get_mut(100)
            .unwrap()
            .add_thread(crate::process::ThreadInfo::new(200, 0, 0, 0));

        assert_eq!(table.get_process_containing_task(100).unwrap().pid, 100);
        // An exact process leader wins over a numerically colliding worker TID.
        assert_eq!(table.get_process_containing_task(200).unwrap().pid, 200);
        assert_eq!(table.get_process_containing_task(900).unwrap().pid, 100);

        table.get_mut(100).unwrap().state = ProcessState::Stopped;
        assert_eq!(table.get_process_containing_task(900).unwrap().pid, 100);
        table.get_mut(100).unwrap().state = ProcessState::Exited;
        assert_eq!(table.get_process_containing_task(100).unwrap().pid, 100);
        assert!(table.get_process_containing_task(900).is_none());

        table.get_mut(200).unwrap().state = ProcessState::Exited;
        assert_eq!(table.get_process_containing_task(200).unwrap().pid, 200);
        table.get_mut(200).unwrap().state = ProcessState::Limbo;
        assert!(table.get_process_containing_task(200).is_none());

        assert!(table.get_process_containing_task(9999).is_none());
    }
}
