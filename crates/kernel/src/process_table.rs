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
use core::sync::atomic::AtomicI32;

use wasm_posix_shared::Errno;
use wasm_posix_shared::flags::O_ACCMODE;

use crate::ofd::FileType;
use crate::process::Process;

/// Owning pid of `/dev/fb0`, or `-1` if no process holds it.
///
/// `/dev/fb0` is single-open; the second `open` while another process
/// holds the device returns `EBUSY`. The owner is released when the
/// owning process closes its last `/dev/fb0` fd, calls `munmap` on its
/// framebuffer region, or exits.
pub static FB0_OWNER: AtomicI32 = AtomicI32::new(-1);

/// Table of all processes managed by the centralized kernel.
///
/// In centralized mode (mode=1), the kernel manages multiple processes.
/// Each process is identified by its pid. The `current_pid` field tracks
/// which process is currently being serviced (set by the JS host before
/// calling `kernel_handle_channel`).
pub struct ProcessTable {
    pub(crate) processes: BTreeMap<u32, Process>,
    current_pid: u32,
    /// TID of the thread currently servicing a syscall. 0 means "main thread"
    /// (or unknown — callers that don't set this get main-thread semantics).
    /// The host sets this before each `kernel_handle_channel` when a thread
    /// worker is the caller.
    current_tid: u32,
}

/// Outcome of `ProcessTable::remove_process`. Bundles the removed
/// `Process` with side-effect lists the caller must drain — currently
/// just AF_INET host net handles whose cross-process refcount hit zero
/// during cleanup. The caller is `kernel_remove_process`, which has
/// access to the raw `host_net_close` extern; this layer doesn't.
pub struct RemoveProcessResult {
    pub process: Process,
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
/// so it does not need access to `ProcessTable`.
fn bump_inherited_resource_refcounts(child: &Process) {
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

    // Shared listener backlog (AF_INET listeners) and host_net_handle
    // (connected AF_INET sockets): increment one ref per socket entry that
    // carries one. close() and process exit each drop one ref; last-drop
    // either frees the listener slot or calls host_net_close. Iterates
    // `child.sockets` directly (not via OFDs) so an unaccepted-but-stored
    // listener inherits a refcount even if no fd in the child happens to
    // reference it — this matches the prior fork-deserialize-time bump.
    let backlog_table = unsafe { crate::socket::shared_listener_backlog_table() };
    for sock_idx in 0..child.sockets.len() {
        if let Some(sock) = child.sockets.get(sock_idx) {
            if let Some(shared_idx) = sock.shared_backlog_idx {
                backlog_table.add_ref(shared_idx);
            }
            if let Some(net_handle) = sock.host_net_handle {
                crate::socket::host_net_handle_fork_ref(net_handle);
            }
        }
    }
}

/// Build the fork-only `fork_pipe_replay` table: a list of (read_fd,
/// write_fd) pairs so that when the child re-runs pre-fork code under
/// asyncify rewind, `sys_pipe` returns the same fd numbers the parent saw.
/// Spawn doesn't replay code, so this stays fork-local.
fn build_fork_pipe_replay(child: &Process) -> Vec<(i32, i32)> {
    use alloc::collections::BTreeMap;
    let mut pipe_fd_pairs: BTreeMap<usize, (i32, i32)> = BTreeMap::new();
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
    pipe_fd_pairs.into_values().collect()
}

impl ProcessTable {
    pub const fn new() -> Self {
        ProcessTable {
            processes: BTreeMap::new(),
            current_pid: 0,
            current_tid: 0,
        }
    }

    /// Create a new process with the given pid and add it to the table.
    ///
    /// Also lazily registers a virtual init process (pid 1) if absent. Init has
    /// no worker — it exists so that `kill(1, ...)` and `sched_*(1, ...)` from
    /// user processes resolve to a real target owned by root, enabling EPERM
    /// checks to fire instead of ESRCH.
    pub fn create_process(&mut self, pid: u32) -> Result<(), ()> {
        self.ensure_init();
        if self.processes.contains_key(&pid) {
            return Err(());
        }
        self.processes.insert(pid, Process::new(pid));
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
        let proc = self.processes.remove(&pid)?;
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

        // Release any PTHREAD_PROCESS_SHARED primitives owned by this pid
        // so peers aren't wedged on mutexes or waiter queues.
        let pshared = unsafe { crate::pshared::global_pshared_table() };
        pshared.cleanup_process(pid);

        Some(RemoveProcessResult { process: proc, host_net_closes })
    }

    /// Set the current pid for syscall dispatch.
    pub fn set_current_pid(&mut self, pid: u32) {
        self.current_pid = pid;
    }

    /// Get the current pid.
    pub fn current_pid(&self) -> u32 {
        self.current_pid
    }

    /// Set the current thread id. 0 means "main thread" and is the default.
    /// The host must call this before `kernel_handle_channel` for any syscall
    /// originating from a non-main thread so that per-thread signal state is
    /// consulted correctly.
    pub fn set_current_tid(&mut self, tid: u32) {
        self.current_tid = tid;
    }

    /// Get the current thread id (0 for main thread).
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
        let parent = self.processes.get(&parent_pid).ok_or(Errno::ESRCH)?;

        // Serialize parent state into a temporary buffer
        let mut buf = Vec::new();
        buf.resize(64 * 1024, 0u8); // 64KB should be plenty
        let written = crate::fork::serialize_fork_state(parent, &mut buf)?;

        // Deserialize as child
        let mut child = crate::fork::deserialize_fork_state(&buf[..written], child_pid)?;

        // Bump cross-process refcounts on inherited fd state (host handles,
        // global pipes, PTYs, socket-pipes). Identical to spawn's needs —
        // factored out into a free helper.
        bump_inherited_resource_refcounts(&child);

        // Build fork-only `fork_pipe_replay` (asyncify replay needs it to
        // return the same fds as the parent did when re-running
        // pre-fork code). Spawn doesn't replay, so this stays fork-local.
        child.fork_pipe_replay = build_fork_pipe_replay(&child);

        self.processes.insert(child_pid, child);

        // Parent's fork-counter regression guardrail. The non-forking spawn
        // tests assert this stays put across a SYS_SPAWN, proving the new
        // path doesn't fall back to fork. Re-borrow at the very end because
        // earlier code held an immutable `&parent`.
        if let Some(parent) = self.processes.get_mut(&parent_pid) {
            parent.increment_fork_count();
        }

        Ok(())
    }

    /// Non-forking spawn: build a child process for `posix_spawn` without
    /// going through fork/asyncify at all. The child is constructed from a
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
        child.pgid = inherit.pgid;     // POSIX_SPAWN_SETPGROUP may override (Task 9).
        child.sid = inherit.sid;       // POSIX_SPAWN_SETSID may override (Task 9).
        child.umask = inherit.umask;
        child.nice = inherit.nice;
        child.rlimits = inherit.rlimits;
        child.cwd = inherit.cwd;

        // The new program's argv/envp come from the spawn caller.
        child.argv = argv.iter().map(|s| s.to_vec()).collect();
        child.environ = envp.iter().map(|s| s.to_vec()).collect();

        // Parent's fd state replaces the default stdio table from
        // Process::new (we want the parent's open fds, not fresh stdio).
        // The Process::new-created OFDs at indices 0/1/2 are dropped here
        // without decrementing any global refcount because Process::new
        // never bumped them.
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
                let _ = child.signals.set_handler(sig, crate::signal::SignalHandler::Ignore);
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
                // child's terminal state is fresh from `Process::new`, so
                // there's no ctty to release.
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

        self.processes.insert(child_pid, child);

        // Bump cross-process refcounts on the inherited fd state. The same
        // helper fork uses — this is the genuinely-shared concern.
        let child_ref = self.processes.get(&child_pid).unwrap();
        bump_inherited_resource_refcounts(child_ref);

        // Apply file actions in forward order against the child. Any failure
        // rolls back the partial child via remove_process — which runs the
        // proper exit cleanup (decrements every refcount we bumped, drops
        // any newly-opened fds, queues last-ref host net handles for close).
        if let Err(e) = self.apply_spawn_file_actions(child_pid, file_actions, host) {
            if let Some(removed) = self.remove_process(child_pid) {
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
                FileAction::Open { fd, path, oflag, mode } => {
                    let opened = crate::syscalls::sys_open(child, host, path, *oflag as u32, *mode)?;
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

    /// Smallest unused pid >= 2 (pid 1 is reserved for init).
    fn allocate_spawn_pid(&self) -> u32 {
        let mut pid = 2u32;
        while self.processes.contains_key(&pid) {
            pid += 1;
        }
        pid
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

/// Single global `ProcessTable` instance used by the centralized kernel.
/// Lives here (rather than inside `wasm_api.rs`) so other modules can read
/// the currently-serviced `pid`/`tid` without a back-reference through the
/// export layer.
pub static GLOBAL_PROCESS_TABLE: GlobalProcessTable =
    GlobalProcessTable(UnsafeCell::new(ProcessTable::new()));

/// Read the currently-serviced thread id (0 = main thread).
#[inline]
pub fn current_tid() -> u32 {
    unsafe { (*GLOBAL_PROCESS_TABLE.0.get()).current_tid() }
}

/// Read the currently-serviced process id.
#[inline]
pub fn current_pid() -> u32 {
    unsafe { (*GLOBAL_PROCESS_TABLE.0.get()).current_pid() }
}
