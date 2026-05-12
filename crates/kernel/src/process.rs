extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::{Errno, WasmStat};

use crate::fd::FdTable;
use crate::lock::LockTable;
use crate::memory::MemoryManager;
use crate::ofd::OfdTable;
use crate::pipe::PipeBuffer;
use crate::signal::{PerThreadSignalState, SignalState};
use crate::socket::SocketTable;
use crate::terminal::TerminalState;

/// A handle to an open directory stream for readdir iteration.
pub struct DirStream {
    pub host_handle: i64,
    pub path: Vec<u8>,     // resolved directory path (for rewinddir)
    pub position: u64,     // entry counter (for telldir/seekdir)
    /// Synthetic "." / ".." state: 0 = emit ".", 1 = emit "..", 2 = host entries
    pub synth_dot_state: u8,
}

/// Trait for host I/O operations that the kernel delegates to the runtime.
pub trait HostIO {
    fn host_open(&mut self, path: &[u8], flags: u32, mode: u32) -> Result<i64, Errno>;
    fn host_close(&mut self, handle: i64) -> Result<(), Errno>;
    fn host_read(&mut self, handle: i64, buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_write(&mut self, handle: i64, buf: &[u8]) -> Result<usize, Errno>;
    fn host_seek(&mut self, handle: i64, offset: i64, whence: u32) -> Result<i64, Errno>;
    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno>;
    fn host_stat(&mut self, path: &[u8]) -> Result<WasmStat, Errno>;
    fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno>;
    fn host_mkdir(&mut self, path: &[u8], mode: u32) -> Result<(), Errno>;
    fn host_rmdir(&mut self, path: &[u8]) -> Result<(), Errno>;
    fn host_unlink(&mut self, path: &[u8]) -> Result<(), Errno>;
    fn host_rename(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno>;
    fn host_link(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno>;
    fn host_symlink(&mut self, target: &[u8], linkpath: &[u8]) -> Result<(), Errno>;
    fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_chmod(&mut self, path: &[u8], mode: u32) -> Result<(), Errno>;
    fn host_chown(&mut self, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno>;
    fn host_access(&mut self, path: &[u8], amode: u32) -> Result<(), Errno>;
    fn host_opendir(&mut self, path: &[u8]) -> Result<i64, Errno>;
    fn host_readdir(&mut self, handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno>;
    fn host_closedir(&mut self, handle: i64) -> Result<(), Errno>;
    fn host_clock_gettime(&mut self, clock_id: u32) -> Result<(i64, i64), Errno>;
    fn host_nanosleep(&mut self, seconds: i64, nanoseconds: i64) -> Result<(), Errno>;
    fn host_ftruncate(&mut self, handle: i64, length: i64) -> Result<(), Errno>;
    fn host_fsync(&mut self, handle: i64) -> Result<(), Errno>;
    fn host_fchmod(&mut self, handle: i64, mode: u32) -> Result<(), Errno>;
    fn host_fchown(&mut self, handle: i64, uid: u32, gid: u32) -> Result<(), Errno>;
    fn host_kill(&mut self, pid: i32, sig: u32) -> Result<(), Errno>;
    fn host_exec(&mut self, path: &[u8]) -> Result<(), Errno>;
    fn host_set_alarm(&mut self, seconds: u32) -> Result<(), Errno>;
    /// Arm/disarm a POSIX timer on the host.
    /// `timer_id` is the per-process timer slot index.
    /// `signo` is the signal to deliver on expiry.
    /// `value_ms` is the initial delay in milliseconds (0 = disarm).
    /// `interval_ms` is the repeat interval in milliseconds (0 = one-shot).
    fn host_set_posix_timer(&mut self, timer_id: i32, signo: i32, value_ms: i64, interval_ms: i64) -> Result<(), Errno>;
    /// Block until a signal is delivered. Returns the signal number.
    fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno>;
    /// Ask the host to invoke a user-space signal handler.
    /// `handler_index` is the Wasm function table index.
    /// `signum` is the signal number being delivered.
    /// `sa_flags` is the sigaction flags (SA_SIGINFO, SA_RESTART, etc.)
    /// When SA_SIGINFO is set, the host should call handler(signum, siginfo_ptr, 0)
    /// instead of handler(signum).
    fn host_call_signal_handler(&mut self, handler_index: u32, signum: u32, sa_flags: u32) -> Result<(), Errno>;
    fn host_getrandom(&mut self, buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_utimensat(&mut self, path: &[u8], atime_sec: i64, atime_nsec: i64, mtime_sec: i64, mtime_nsec: i64) -> Result<(), Errno>;
    fn host_waitpid(&mut self, pid: i32, options: u32) -> Result<(i32, i32), Errno>;
    fn host_net_connect(&mut self, handle: i32, addr: &[u8], port: u16) -> Result<(), Errno>;
    fn host_net_send(&mut self, handle: i32, data: &[u8], flags: u32) -> Result<usize, Errno>;
    fn host_net_recv(&mut self, handle: i32, len: u32, flags: u32, buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_net_close(&mut self, handle: i32) -> Result<(), Errno>;
    /// Notify the host that an AF_INET socket is now listening, so the host
    /// can open a real TCP server on the given port.
    fn host_net_listen(&mut self, fd: i32, port: u16, addr: &[u8; 4]) -> Result<(), Errno>;
    fn host_getaddrinfo(&mut self, name: &[u8], result: &mut [u8]) -> Result<usize, Errno>;
    fn host_fcntl_lock(
        &mut self, path: &[u8], pid: u32, cmd: u32, lock_type: u32,
        start: i64, len: i64, result_buf: &mut [u8],
    ) -> Result<(), Errno>;
    /// Request the host to fork the current process.
    /// Returns child PID (>= 0) on success, or negative errno on error.
    fn host_fork(&self) -> i32;
    /// Futex wait: block if `*addr == expected`, with optional timeout in nanoseconds.
    /// timeout_ns < 0 means infinite wait.
    /// Returns 0 on wake, negative errno on error.
    fn host_futex_wait(&mut self, addr: usize, expected: u32, timeout_ns: i64) -> Result<i32, Errno>;
    /// Futex wake: wake up to `count` waiters on addr. Returns number woken.
    fn host_futex_wake(&mut self, addr: usize, count: u32) -> Result<i32, Errno>;
    /// Clone: spawn a new thread worker. Returns child TID on success.
    fn host_clone(&mut self, fn_ptr: usize, arg: usize, stack_ptr: usize, tls_ptr: usize, ctid_ptr: usize) -> Result<i32, Errno>;
    /// Notify the host that process `pid` has mapped its `/dev/fb0`
    /// framebuffer at `[addr, addr+len)` within its wasm `Memory`. The host
    /// should mirror that byte range to whatever display surface it owns.
    /// `fmt` is reserved for future format negotiation; currently always
    /// BGRA32 (0).
    fn bind_framebuffer(
        &mut self, pid: i32, addr: usize, len: usize,
        w: u32, h: u32, stride: u32, fmt: u32,
    );
    /// Notify the host that the framebuffer for `pid` is gone (`munmap`,
    /// process exit, or exec). Idempotent: calling unbind on a pid with no
    /// binding is a no-op.
    fn unbind_framebuffer(&mut self, pid: i32);
    /// Push pixel bytes to the host's framebuffer surface for `pid` at
    /// byte `offset`. Used by software (e.g. fbDOOM) that issues
    /// `write(fd_fb, …)` rather than mmap-and-store. The host owns the
    /// pixel buffer in this mode; the kernel has no `FbBinding.addr` to
    /// copy into. Geometry/format come from a prior `bind_framebuffer`
    /// call with `addr=0, len=0` (the sentinel "write-based binding").
    fn fb_write(&mut self, pid: i32, offset: usize, bytes: &[u8]);
}

/// Process lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Running,
    Exited,
}

/// Per-process binding tracking the live mmap of `/dev/fb0`.
///
/// The pixel buffer lives inside the process's wasm `Memory`. The host
/// reads it directly via a typed-array view over the same SharedArrayBuffer.
#[derive(Debug, Clone, Copy)]
pub struct FbBinding {
    /// Offset within the process's wasm `Memory` where the pixel buffer
    /// starts. Address-style usize so it survives wasm32 / wasm64.
    pub addr: usize,
    /// Length in bytes (`smem_len`).
    pub len: usize,
    pub w: u32,
    pub h: u32,
    pub stride: u32,
    /// Pixel format tag (reserved; currently always 0 = BGRA32).
    pub fmt: u32,
}

/// Per-thread state within a process.
#[derive(Debug, Clone)]
pub struct ThreadInfo {
    pub tid: u32,
    pub ctid_ptr: usize,    // CLONE_CHILD_CLEARTID address (futex wake on exit)
    pub stack_ptr: usize,
    pub tls_ptr: usize,
    pub tidptr: usize,       // set_tid_address pointer
    /// Per-thread signal state: directed-pending set + blocked mask + RT queue.
    /// Handlers remain process-wide and live on [`Process::signals`].
    pub signals: PerThreadSignalState,
}

impl ThreadInfo {
    pub fn new(tid: u32, ctid_ptr: usize, stack_ptr: usize, tls_ptr: usize) -> Self {
        ThreadInfo {
            tid,
            ctid_ptr,
            stack_ptr,
            tls_ptr,
            tidptr: 0,
            signals: PerThreadSignalState::new(),
        }
    }
}

/// Per-eventfd state: a u64 counter with optional semaphore semantics.
#[derive(Debug, Clone)]
pub struct EventFdState {
    pub counter: u64,
    pub semaphore: bool,
}

/// An entry in an epoll interest list.
#[derive(Debug, Clone)]
pub struct EpollInterest {
    pub fd: i32,
    pub events: u32,
    pub data: u64,
}

/// An epoll instance: a set of monitored file descriptors.
#[derive(Debug, Clone)]
pub struct EpollInstance {
    pub interests: Vec<EpollInterest>,
}

impl EpollInstance {
    pub fn new() -> Self {
        EpollInstance { interests: Vec::new() }
    }
}

/// Per-timerfd state: clock, interval, and next expiration.
#[derive(Debug, Clone)]
pub struct TimerFdState {
    pub clock_id: u32,
    /// Interval for repeating timers (0 = one-shot).
    pub interval_sec: i64,
    pub interval_nsec: i64,
    /// Next expiration time (absolute, in the timer's clock).
    /// 0/0 = disarmed.
    pub value_sec: i64,
    pub value_nsec: i64,
    /// Number of expirations not yet read.
    pub expirations: u64,
}

/// POSIX timer (timer_create / timer_settime).
#[derive(Debug, Clone)]
pub struct PosixTimerState {
    pub clock_id: u32,
    pub sigev_signo: u32,
    pub sigev_value: i32,
    /// Interval for repeating timers (0 = one-shot).
    pub interval_sec: i64,
    pub interval_nsec: i64,
    /// Next expiration value (relative, for host-side setTimeout).
    /// 0/0 = disarmed.
    pub value_sec: i64,
    pub value_nsec: i64,
    /// Number of overruns (expirations not yet handled).
    pub overrun: i32,
}

/// Per-signalfd state: the set of signals to watch.
#[derive(Debug, Clone)]
pub struct SignalFdState {
    pub mask: u64,
}

/// File descriptor action to apply in a fork child before exec.
#[derive(Debug, Clone)]
pub enum FdAction {
    Dup2 { old_fd: i32, new_fd: i32 },
    Close { fd: i32 },
    Open { fd: i32, path: Vec<u8>, flags: i32, mode: i32 },
}

/// Per-process kernel state: file descriptor table, OFD table, pipes, cwd, and directory streams.
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub gid: u32,
    pub euid: u32,
    pub egid: u32,
    pub pgid: u32,
    pub sid: u32,
    /// True iff this process is the session leader of its session (i.e. the
    /// process that called `setsid()` or was implicitly made a session
    /// leader by a PTY-creation path). Linux tracks this as an explicit flag
    /// (`task->signal->leader`) rather than `sid == pid`, because a forked
    /// child inherits its parent's sid but is NOT itself a session leader.
    /// POSIX uses this flag (not `sid == pid`) to gate setpgid EPERM checks.
    pub is_session_leader: bool,
    pub state: ProcessState,
    pub exit_status: i32,
    pub fd_table: FdTable,
    pub ofd_table: OfdTable,
    pub lock_table: LockTable,
    pub pipes: Vec<Option<PipeBuffer>>,
    pub sockets: SocketTable,
    pub cwd: Vec<u8>,
    pub dir_streams: Vec<Option<DirStream>>,
    pub signals: SignalState,
    pub memory: MemoryManager,
    pub terminal: TerminalState,
    pub environ: Vec<Vec<u8>>,
    pub argv: Vec<Vec<u8>>,
    pub umask: u32,
    /// Scheduling priority nice value (-20 to 19, default 0).
    pub nice: i32,
    pub rlimits: [[u64; 2]; 16], // [soft, hard] pairs for each resource
    pub alarm_deadline_ns: u64,
    pub alarm_interval_ns: u64,
    pub thread_name: [u8; 16],
    /// True if this process is a fork child that should exec on startup.
    pub fork_child: bool,
    /// Saved signal mask during sigsuspend (centralized mode blocking retry).
    /// Set on first sigsuspend call, restored when a signal is delivered.
    pub sigsuspend_saved_mask: Option<u64>,
    /// Path to exec after fork (set by posix_spawn before forking).
    pub fork_exec_path: Option<Vec<u8>>,
    /// Argv for exec after fork.
    pub fork_exec_argv: Option<Vec<Vec<u8>>>,
    /// FD actions to apply before exec in fork child.
    pub fork_fd_actions: Vec<FdAction>,
    /// Next ephemeral port to assign for bind(port=0).
    pub next_ephemeral_port: u16,
    /// Threads created by this process (centralized mode).
    pub threads: Vec<ThreadInfo>,
    /// Next thread ID to allocate.
    pub next_tid: u32,
    /// Eventfd instances owned by this process.
    pub eventfds: Vec<Option<EventFdState>>,
    /// Epoll instances owned by this process.
    pub epolls: Vec<Option<EpollInstance>>,
    /// Timerfd instances owned by this process.
    pub timerfds: Vec<Option<TimerFdState>>,
    /// Signalfd instances owned by this process.
    pub signalfds: Vec<Option<SignalFdState>>,
    /// POSIX timers (timer_create / timer_settime).
    pub posix_timers: Vec<Option<PosixTimerState>>,
    /// Alternate signal stack (sigaltstack): ss_sp, ss_flags, ss_size.
    pub alt_stack_sp: usize,
    pub alt_stack_flags: u32,
    pub alt_stack_size: usize,
    /// Number of nested signal handlers running with SA_ONSTACK on alt stack.
    /// When > 0, SS_ONSTACK is set in alt_stack_flags.
    pub alt_stack_depth: u32,
    /// Pipe FD pairs inherited from parent, for replay during fork child
    /// re-execution. Each entry is (read_fd, write_fd). sys_pipe pops
    /// from this list to return the correct FDs when the child re-runs
    /// code before fork(). Empty in non-fork-child processes.
    pub fork_pipe_replay: Vec<(i32, i32)>,
    /// In-memory file buffers for memfd_create fds.
    pub memfds: Vec<Option<Vec<u8>>>,
    /// Content buffers for open procfs files (snapshot at open time).
    pub procfs_bufs: Vec<Option<Vec<u8>>>,
    /// True if this process has called exec (for POSIX setpgid EACCES check).
    pub has_exec: bool,
    /// Live mmap of `/dev/fb0`, if any. `Some` between successful
    /// `mmap` and the matching `munmap`/process-exit/exec.
    pub fb_binding: Option<FbBinding>,
    /// Counts how many times this process has called fork() (parent side, on success).
    /// Read-only from outside the kernel via `kernel_get_fork_count`.
    /// Used as a regression guardrail by the spawn test suite to confirm
    /// non-forking spawn doesn't sneak through the fork path.
    pub(crate) fork_count: u64,
}

impl Process {
    /// Create a new process with stdio pre-opened (fds 0, 1, 2).
    ///
    /// - OFD 0 = stdin  (CharDevice, O_RDONLY, host_handle=0)
    /// - OFD 1 = stdout (CharDevice, O_WRONLY, host_handle=1)
    /// - OFD 2 = stderr (CharDevice, O_WRONLY, host_handle=2)
    pub fn new(pid: u32) -> Self {
        use crate::ofd::FileType;
        use wasm_posix_shared::flags::{O_RDONLY, O_WRONLY};

        let mut ofd_table = OfdTable::new();
        ofd_table.create(FileType::CharDevice, O_RDONLY, 0, b"/dev/stdin".to_vec()); // OFD 0 = stdin
        ofd_table.create(FileType::CharDevice, O_WRONLY, 1, b"/dev/stdout".to_vec()); // OFD 1 = stdout
        ofd_table.create(FileType::CharDevice, O_WRONLY, 2, b"/dev/stderr".to_vec()); // OFD 2 = stderr

        let mut fd_table = FdTable::new();
        fd_table.preopen_stdio(); // fds 0,1,2 → OFD refs 0,1,2

        let mut rlimits = [[u64::MAX; 2]; 16]; // Default: infinity for all
        rlimits[7] = [1024, 4096];             // RLIMIT_NOFILE: soft=1024, hard=4096
        rlimits[3] = [8 * 1024 * 1024, u64::MAX]; // RLIMIT_STACK: soft=8MB, hard=infinity

        Process {
            pid,
            ppid: 0,
            // Default to root (uid=0). The kernel is single-user; privilege
            // drops happen explicitly via setuid/setgid and gate cross-user
            // operations (kill, sched_*).
            uid: 0,
            gid: 0,
            euid: 0,
            egid: 0,
            pgid: pid,
            sid: 0,
            is_session_leader: false,
            state: ProcessState::Running,
            exit_status: 0,
            fd_table,
            ofd_table,
            lock_table: LockTable::new(),
            pipes: Vec::new(),
            sockets: SocketTable::new(),
            cwd: alloc::vec![b'/'],
            dir_streams: Vec::new(),
            signals: SignalState::new(),
            memory: MemoryManager::new(),
            terminal: TerminalState::new(),
            environ: Vec::new(),
            argv: Vec::new(),
            umask: 0o022,
            nice: 0,
            rlimits,
            alarm_deadline_ns: 0,
            alarm_interval_ns: 0,
            thread_name: [0u8; 16],
            fork_child: false,
            sigsuspend_saved_mask: None,
            fork_exec_path: None,
            fork_exec_argv: None,
            fork_fd_actions: Vec::new(),
            next_ephemeral_port: 49152,
            threads: Vec::new(),
            next_tid: 0, // will be set to pid + 1 after pid is known
            eventfds: Vec::new(),
            epolls: Vec::new(),
            timerfds: Vec::new(),
            signalfds: Vec::new(),
            posix_timers: Vec::new(),
            alt_stack_sp: 0,
            alt_stack_flags: 2, // SS_DISABLE
            alt_stack_size: 0,
            alt_stack_depth: 0,
            fork_pipe_replay: Vec::new(),
            memfds: Vec::new(),
            procfs_bufs: Vec::new(),
            has_exec: false,
            fb_binding: None,
            fork_count: 0,
        }
    }

    /// Returns how many times this process has successfully forked (parent side).
    pub fn fork_count(&self) -> u64 {
        self.fork_count
    }

    /// Increment the fork counter. Called by `ProcessTable::fork_process` on
    /// the parent after a child is successfully created.
    pub(crate) fn increment_fork_count(&mut self) {
        self.fork_count += 1;
    }

    /// Allocate a process-local pipe buffer, reusing the first free slot.
    pub fn alloc_pipe(&mut self, pipe: PipeBuffer) -> usize {
        for (i, slot) in self.pipes.iter().enumerate() {
            if slot.is_none() {
                self.pipes[i] = Some(pipe);
                return i;
            }
        }
        let idx = self.pipes.len();
        self.pipes.push(Some(pipe));
        idx
    }

    /// Allocate a consecutive pair of process-local pipe buffers, reusing freed
    /// slots. Preserves adjacency so that `second_idx == first_idx + 1`.
    pub fn alloc_pipe_pair(&mut self, first: PipeBuffer, second: PipeBuffer) -> (usize, usize) {
        let len = self.pipes.len();
        for i in 0..len.saturating_sub(1) {
            if self.pipes[i].is_none() && self.pipes[i + 1].is_none() {
                self.pipes[i] = Some(first);
                self.pipes[i + 1] = Some(second);
                return (i, i + 1);
            }
        }
        let idx = self.pipes.len();
        self.pipes.push(Some(first));
        self.pipes.push(Some(second));
        (idx, idx + 1)
    }

    /// Allocate a new thread ID for this process.
    pub fn alloc_tid(&mut self) -> u32 {
        // First thread TID starts at pid + 1
        if self.next_tid == 0 {
            self.next_tid = self.pid + 1;
        }
        let tid = self.next_tid;
        self.next_tid += 1;
        tid
    }

    /// Add a thread to this process.
    pub fn add_thread(&mut self, info: ThreadInfo) {
        self.threads.push(info);
    }

    /// Remove a thread by TID.
    pub fn remove_thread(&mut self, tid: u32) -> Option<ThreadInfo> {
        if let Some(idx) = self.threads.iter().position(|t| t.tid == tid) {
            Some(self.threads.swap_remove(idx))
        } else {
            None
        }
    }

    /// Find a thread by TID.
    pub fn get_thread(&self, tid: u32) -> Option<&ThreadInfo> {
        self.threads.iter().find(|t| t.tid == tid)
    }

    /// Find a thread by TID (mutable).
    pub fn get_thread_mut(&mut self, tid: u32) -> Option<&mut ThreadInfo> {
        self.threads.iter_mut().find(|t| t.tid == tid)
    }

    /// True if `tid` names the process's main thread. The main thread's TID
    /// equals the process PID (Linux convention) and is not tracked in
    /// [`Process::threads`]; per-thread signal state for the main thread lives
    /// in [`Process::signals`] instead.
    ///
    /// `tid == 0` is also treated as "main thread" because the host uses 0
    /// for syscalls from the main channel (no thread worker is involved).
    pub fn is_main_thread(&self, tid: u32) -> bool {
        tid == 0 || tid == self.pid
    }

    /// Effective blocked mask for the given TID.
    pub fn blocked_for(&self, tid: u32) -> u64 {
        if self.is_main_thread(tid) {
            self.signals.blocked
        } else {
            self.get_thread(tid)
                .map(|t| t.signals.blocked)
                .unwrap_or(self.signals.blocked)
        }
    }

    /// Replace the blocked mask for the given TID. Returns the old value.
    pub fn set_blocked_for(&mut self, tid: u32, new_blocked: u64) -> u64 {
        if self.is_main_thread(tid) {
            let old = self.signals.blocked;
            self.signals.blocked = new_blocked;
            old
        } else if let Some(t) = self.get_thread_mut(tid) {
            let old = t.signals.blocked;
            t.signals.blocked = new_blocked;
            old
        } else {
            // Unknown thread — fall back to process-level.
            let old = self.signals.blocked;
            self.signals.blocked = new_blocked;
            old
        }
    }

    /// Union of the process's shared pending bits and TID's directed pending
    /// bits — the full set of signals that *could* be delivered to TID once
    /// unblocked.
    pub fn pending_for(&self, tid: u32) -> u64 {
        if self.is_main_thread(tid) {
            self.signals.pending
        } else {
            let thread_pending = self.get_thread(tid)
                .map(|t| t.signals.pending)
                .unwrap_or(0);
            self.signals.pending | thread_pending
        }
    }

    /// True iff `sig` is pending somewhere visible to TID (directed at TID
    /// or sitting in the shared process-level pending set).
    pub fn signal_pending_for(&self, tid: u32, sig: u32) -> bool {
        if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
            return false;
        }
        let bit = crate::signal::sig_bit(sig);
        let shared = (self.signals.pending & bit) != 0;
        if self.is_main_thread(tid) {
            shared
        } else {
            let thread_bit = self.get_thread(tid)
                .map(|t| (t.signals.pending & bit) != 0)
                .unwrap_or(false);
            shared || thread_bit
        }
    }

    /// Pick a thread TID that does not block `sig`. Preference order:
    ///   1. Main thread, if it does not block `sig`.
    ///   2. Any worker thread (in allocation order) with `sig` unblocked.
    /// Returns `None` if every thread blocks `sig`; the signal stays queued
    /// in the shared pending set until some thread unblocks it.
    pub fn pick_thread_for_shared_signal(&self, sig: u32) -> Option<u32> {
        if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
            return None;
        }
        let bit = crate::signal::sig_bit(sig);
        if (self.signals.blocked & bit) == 0 {
            return Some(self.pid); // main thread
        }
        for t in &self.threads {
            if (t.signals.blocked & bit) == 0 {
                return Some(t.tid);
            }
        }
        None
    }

    /// Bitmask of signals currently deliverable to TID:
    /// `(shared_pending | thread_pending) & !thread_blocked`.
    pub fn deliverable_for(&self, tid: u32) -> u64 {
        let pending = self.pending_for(tid);
        let blocked = self.blocked_for(tid);
        pending & !blocked
    }

    /// Read the saved sigsuspend/ppoll/pselect mask for TID.
    pub fn sigsuspend_saved_mask_for(&self, tid: u32) -> Option<u64> {
        if self.is_main_thread(tid) {
            self.sigsuspend_saved_mask
        } else {
            self.get_thread(tid).and_then(|t| t.signals.sigsuspend_saved_mask)
        }
    }

    /// Set the saved sigsuspend/ppoll/pselect mask for TID.
    pub fn set_sigsuspend_saved_mask_for(&mut self, tid: u32, val: Option<u64>) {
        if self.is_main_thread(tid) {
            self.sigsuspend_saved_mask = val;
        } else if let Some(t) = self.get_thread_mut(tid) {
            t.signals.sigsuspend_saved_mask = val;
        }
    }

    /// Take (clear) the saved sigsuspend mask for TID, returning the old value.
    pub fn take_sigsuspend_saved_mask_for(&mut self, tid: u32) -> Option<u64> {
        if self.is_main_thread(tid) {
            self.sigsuspend_saved_mask.take()
        } else {
            self.get_thread_mut(tid)
                .and_then(|t| t.signals.sigsuspend_saved_mask.take())
        }
    }

    /// Collect every TID that has `sig` unblocked (main + worker threads).
    /// Used by the host to decide which thread channels to wake when a new
    /// shared signal arrives.
    pub fn tids_accepting(&self, sig: u32) -> Vec<u32> {
        let mut out = Vec::new();
        if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
            return out;
        }
        let bit = crate::signal::sig_bit(sig);
        if (self.signals.blocked & bit) == 0 {
            out.push(self.pid);
        }
        for t in &self.threads {
            if (t.signals.blocked & bit) == 0 {
                out.push(t.tid);
            }
        }
        out
    }
}

/// A `HostIO` impl that returns sensible defaults for the methods our
/// kernel-level unit tests actually invoke, and `unimplemented!()` for the
/// rest. Lives at module scope (under `#[cfg(test)]`) so any test in the
/// crate can `use crate::process::test_host::NoopHost;`.
#[cfg(test)]
pub(crate) mod test_host {
    use super::HostIO;
    use wasm_posix_shared::Errno;
    use wasm_posix_shared::WasmStat;

    pub struct NoopHost;

    impl HostIO for NoopHost {
        fn host_open(&mut self, _path: &[u8], _flags: u32, _mode: u32) -> Result<i64, Errno> { Err(Errno::ENOSYS) }
        fn host_close(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
        fn host_read(&mut self, _h: i64, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
        fn host_write(&mut self, _h: i64, b: &[u8]) -> Result<usize, Errno> { Ok(b.len()) }
        fn host_seek(&mut self, _h: i64, _o: i64, _w: u32) -> Result<i64, Errno> { Ok(0) }
        fn host_fstat(&mut self, _h: i64) -> Result<WasmStat, Errno> { Err(Errno::ENOSYS) }
        fn host_stat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> { Err(Errno::ENOENT) }
        fn host_lstat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> { Err(Errno::ENOENT) }
        fn host_mkdir(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_rmdir(&mut self, _p: &[u8]) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_unlink(&mut self, _p: &[u8]) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_rename(&mut self, _o: &[u8], _n: &[u8]) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_link(&mut self, _o: &[u8], _n: &[u8]) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_symlink(&mut self, _t: &[u8], _l: &[u8]) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_readlink(&mut self, _p: &[u8], _b: &mut [u8]) -> Result<usize, Errno> { Err(Errno::ENOSYS) }
        fn host_chmod(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_chown(&mut self, _p: &[u8], _u: u32, _g: u32) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_access(&mut self, _p: &[u8], _a: u32) -> Result<(), Errno> { Err(Errno::ENOENT) }
        fn host_opendir(&mut self, _p: &[u8]) -> Result<i64, Errno> { Err(Errno::ENOSYS) }
        fn host_readdir(&mut self, _h: i64, _b: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> { Ok(None) }
        fn host_closedir(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
        fn host_clock_gettime(&mut self, _c: u32) -> Result<(i64, i64), Errno> { Ok((0, 0)) }
        fn host_nanosleep(&mut self, _s: i64, _n: i64) -> Result<(), Errno> { Ok(()) }
        fn host_ftruncate(&mut self, _h: i64, _l: i64) -> Result<(), Errno> { Ok(()) }
        fn host_fsync(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
        fn host_fchmod(&mut self, _h: i64, _m: u32) -> Result<(), Errno> { Ok(()) }
        fn host_fchown(&mut self, _h: i64, _u: u32, _g: u32) -> Result<(), Errno> { Ok(()) }
        fn host_kill(&mut self, _p: i32, _s: u32) -> Result<(), Errno> { Ok(()) }
        fn host_exec(&mut self, _p: &[u8]) -> Result<(), Errno> { Err(Errno::ENOSYS) }
        fn host_set_alarm(&mut self, _s: u32) -> Result<(), Errno> { Ok(()) }
        fn host_set_posix_timer(&mut self, _t: i32, _s: i32, _v: i64, _i: i64) -> Result<(), Errno> { Ok(()) }
        fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> { Err(Errno::EINTR) }
        fn host_call_signal_handler(&mut self, _h: u32, _s: u32, _f: u32) -> Result<(), Errno> { Ok(()) }
        fn host_getrandom(&mut self, b: &mut [u8]) -> Result<usize, Errno> { for x in b.iter_mut() { *x = 0; } Ok(b.len()) }
        fn host_utimensat(&mut self, _p: &[u8], _as: i64, _an: i64, _ms: i64, _mn: i64) -> Result<(), Errno> { Ok(()) }
        fn host_waitpid(&mut self, _p: i32, _o: u32) -> Result<(i32, i32), Errno> { Err(Errno::ECHILD) }
        fn host_net_connect(&mut self, _h: i32, _a: &[u8], _p: u16) -> Result<(), Errno> { Ok(()) }
        fn host_net_send(&mut self, _h: i32, d: &[u8], _f: u32) -> Result<usize, Errno> { Ok(d.len()) }
        fn host_net_recv(&mut self, _h: i32, _l: u32, _f: u32, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
        fn host_net_close(&mut self, _h: i32) -> Result<(), Errno> { Ok(()) }
        fn host_net_listen(&mut self, _f: i32, _p: u16, _a: &[u8; 4]) -> Result<(), Errno> { Ok(()) }
        fn host_getaddrinfo(&mut self, _n: &[u8], _r: &mut [u8]) -> Result<usize, Errno> { Err(Errno::ENOENT) }
        fn host_fcntl_lock(&mut self, _p: &[u8], _pid: u32, _c: u32, _t: u32, _s: i64, _l: i64, _r: &mut [u8]) -> Result<(), Errno> { Ok(()) }
        fn host_fork(&self) -> i32 { -(Errno::ENOSYS as i32) }
        fn host_futex_wait(&mut self, _a: usize, _e: u32, _t: i64) -> Result<i32, Errno> { Err(Errno::EAGAIN) }
        fn host_futex_wake(&mut self, _a: usize, _c: u32) -> Result<i32, Errno> { Ok(0) }
        fn host_clone(&mut self, _f: usize, _a: usize, _s: usize, _t: usize, _c: usize) -> Result<i32, Errno> { Err(Errno::ENOSYS) }
        fn bind_framebuffer(&mut self, _p: i32, _a: usize, _l: usize, _w: u32, _h: u32, _s: u32, _f: u32) {}
        fn unbind_framebuffer(&mut self, _p: i32) {}
        fn fb_write(&mut self, _p: i32, _o: usize, _b: &[u8]) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipe::PipeBuffer;

    #[test]
    fn fork_count_starts_at_zero() {
        let proc = Process::new(1);
        assert_eq!(proc.fork_count(), 0);
    }

    #[test]
    fn spawn_child_basic_inherits_cwd_and_returns_pid() {
        use crate::process_table::ProcessTable;
        use crate::spawn::SpawnAttrs;
        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();
        table.processes.get_mut(&100).unwrap().cwd = b"/tmp".to_vec();

        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child(
                100,
                &[b"/bin/echo".as_slice(), b"hi".as_slice()],
                &[b"PATH=/bin".as_slice()],
                &[],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");

        assert_ne!(child_pid, 100, "child pid must differ from parent");
        let child = table.get(child_pid).expect("child in table");
        assert_eq!(child.cwd, b"/tmp", "child inherits parent cwd");
        assert_eq!(child.ppid, 100, "child ppid is parent pid");
        assert_eq!(
            child.argv,
            alloc::vec![b"/bin/echo".to_vec(), b"hi".to_vec()],
            "child argv comes from caller, not parent"
        );
        // The whole point of non-forking spawn: the parent's fork counter
        // must NOT bump.
        assert_eq!(table.get(100).unwrap().fork_count(), 0);
    }

    #[test]
    fn spawn_child_bumps_shared_listener_backlog_refcount() {
        // Regression: spawn must inherit AF_INET listener backlog the same
        // way fork does. Otherwise a parent that opened a listener and then
        // spawned a child would see the backlog free'd when the child
        // exited and called dec_ref one too many times.
        use crate::process_table::ProcessTable;
        use crate::socket::{shared_listener_backlog_table, SocketDomain, SocketInfo, SocketType};
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        table.create_process(200).unwrap();

        // Allocate a backlog slot (starts with ref_count=1) and attach it
        // to a parent-owned listener socket.
        let backlog_idx = unsafe { shared_listener_backlog_table().alloc() };
        let mut listener = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        listener.shared_backlog_idx = Some(backlog_idx);
        let _sock_idx = table
            .processes
            .get_mut(&200)
            .unwrap()
            .sockets
            .alloc(listener);

        let initial = unsafe { shared_listener_backlog_table().entries[backlog_idx].ref_count };
        assert_eq!(initial, 1, "alloc starts the slot at ref_count=1");

        let mut host = test_host::NoopHost;
        let _child_pid = table
            .spawn_child(200, &[b"a".as_slice()], &[], &[], &SpawnAttrs::empty(), &mut host)
            .expect("spawn_child");

        let after_spawn = unsafe { shared_listener_backlog_table().entries[backlog_idx].ref_count };
        assert_eq!(
            after_spawn, 2,
            "spawn child must add one ref to the inherited listener backlog"
        );

        // Same slot should also bump on fork — the helper is shared.
        table.fork_process(200, 999).expect("fork_process");
        let after_fork = unsafe { shared_listener_backlog_table().entries[backlog_idx].ref_count };
        assert_eq!(
            after_fork, 3,
            "fork child must add one ref via the shared helper"
        );
    }

    #[test]
    fn fork_and_spawn_bump_host_net_handle_refcount() {
        // Regression: connected AF_INET sockets were value-cloned across
        // fork and spawn, so the first process to call close()/host_net_close
        // would kill the other's view of the connection. Now we refcount
        // host_net_handle the same way we refcount file host handles.
        use crate::process_table::ProcessTable;
        use crate::socket::{host_net_handle_ref_count, SocketDomain, SocketInfo, SocketType};
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        table.create_process(300).unwrap();

        // Pretend the parent connected an AF_INET socket; the host returned
        // handle 42.
        const HANDLE: i32 = 42;
        let mut sock = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        sock.host_net_handle = Some(HANDLE);
        table
            .processes
            .get_mut(&300)
            .unwrap()
            .sockets
            .alloc(sock);

        // The handle isn't in the cross-process table yet — single-owner.
        assert_eq!(host_net_handle_ref_count(HANDLE), 0);

        // Spawn a child. The bump turns the table entry into "1 (parent) + 1
        // (child) = 2".
        let mut host = test_host::NoopHost;
        let _child = table
            .spawn_child(300, &[b"a".as_slice()], &[], &[], &SpawnAttrs::empty(), &mut host)
            .expect("spawn_child");
        assert_eq!(
            host_net_handle_ref_count(HANDLE),
            2,
            "spawn child must bump host_net_handle ref"
        );

        // Forking again bumps once more.
        table.fork_process(300, 999).expect("fork_process");
        assert_eq!(
            host_net_handle_ref_count(HANDLE),
            3,
            "fork child must bump host_net_handle ref via the same helper"
        );
    }

    #[test]
    fn spawn_child_clears_consume_once_socket_state() {
        // Regression: SocketInfo's hand-written Clone must drop dgram_queue
        // and oob_byte so a fork/spawn child can't consume the "same"
        // datagram or OOB byte the parent will consume. fork already
        // discards these via its serialize-side skip; this test pins the
        // spawn path to the same behavior.
        use crate::process_table::ProcessTable;
        use crate::socket::{Datagram, SocketDomain, SocketInfo, SocketType};
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        table.create_process(400).unwrap();

        // Parent has a UDP socket with a pending datagram and a TCP socket
        // with a pending OOB byte.
        let mut udp = SocketInfo::new(SocketDomain::Inet, SocketType::Dgram, 0);
        udp.dgram_queue.push(Datagram {
            data: b"hello".to_vec(),
            src_addr: [127, 0, 0, 1],
            src_port: 12345,
        });
        let mut tcp = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        tcp.oob_byte = Some(0xAB);
        let parent = table.processes.get_mut(&400).unwrap();
        let udp_idx = parent.sockets.alloc(udp);
        let tcp_idx = parent.sockets.alloc(tcp);

        // Sanity: parent still has the consume-once data.
        assert_eq!(table.get(400).unwrap().sockets.get(udp_idx).unwrap().dgram_queue.len(), 1);
        assert_eq!(table.get(400).unwrap().sockets.get(tcp_idx).unwrap().oob_byte, Some(0xAB));

        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child(400, &[b"a".as_slice()], &[], &[], &SpawnAttrs::empty(), &mut host)
            .expect("spawn_child");

        // Child must NOT see them.
        let child = table.get(child_pid).unwrap();
        assert!(
            child.sockets.get(udp_idx).unwrap().dgram_queue.is_empty(),
            "child must start with empty dgram queue"
        );
        assert_eq!(
            child.sockets.get(tcp_idx).unwrap().oob_byte, None,
            "child must not inherit pending OOB byte"
        );

        // Parent's pending data is intact (consume-once stayed with parent).
        let parent = table.get(400).unwrap();
        assert_eq!(parent.sockets.get(udp_idx).unwrap().dgram_queue.len(), 1);
        assert_eq!(parent.sockets.get(tcp_idx).unwrap().oob_byte, Some(0xAB));
    }

    #[test]
    fn fork_and_spawn_clear_listen_backlog_on_child() {
        // Pre-accepted AF_UNIX same-process connections are consume-once
        // (the indices reference the same SocketTable both processes now
        // hold copies of). A child that inherited them could double-accept.
        // Fork serializes 0-length; spawn's hand-written Clone clears the
        // Vec.
        use crate::process_table::ProcessTable;
        use crate::socket::{SocketDomain, SocketInfo, SocketType};
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        table.create_process(500).unwrap();

        // Parent has a listening AF_UNIX socket with pending pre-accepted
        // connections.
        let mut listener = SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0);
        listener.listen_backlog.push(7);
        listener.listen_backlog.push(11);
        let parent = table.processes.get_mut(&500).unwrap();
        let listener_idx = parent.sockets.alloc(listener);

        // Sanity: parent has both pending entries.
        assert_eq!(
            table.get(500).unwrap().sockets.get(listener_idx).unwrap().listen_backlog.len(),
            2
        );

        // Spawn child must NOT inherit them.
        let mut host = test_host::NoopHost;
        let spawn_child = table
            .spawn_child(500, &[b"a".as_slice()], &[], &[], &SpawnAttrs::empty(), &mut host)
            .expect("spawn_child");
        assert!(
            table.get(spawn_child).unwrap().sockets.get(listener_idx).unwrap().listen_backlog.is_empty(),
            "spawn child must start with empty listen_backlog"
        );

        // Fork child must NOT inherit them either.
        table.fork_process(500, 998).expect("fork_process");
        assert!(
            table.get(998).unwrap().sockets.get(listener_idx).unwrap().listen_backlog.is_empty(),
            "fork child must start with empty listen_backlog"
        );

        // Parent retains them.
        assert_eq!(
            table.get(500).unwrap().sockets.get(listener_idx).unwrap().listen_backlog.len(),
            2,
            "parent's pending pre-accepted connections are intact"
        );
    }

    #[test]
    fn remove_process_emits_host_net_close_only_on_last_ref() {
        // Regression: when the last process holding a host_net_handle
        // exits, remove_process must report it in `host_net_closes` so
        // the kernel-export wrapper can call host_net_close. Earlier
        // refs (parent still holding it) must NOT report it.
        use crate::process_table::ProcessTable;
        use crate::socket::{host_net_handle_ref_count, SocketDomain, SocketInfo, SocketType};
        use crate::spawn::SpawnAttrs;

        const HANDLE: i32 = 84;
        let mut table = ProcessTable::new();
        table.create_process(600).unwrap();
        let mut sock = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
        sock.host_net_handle = Some(HANDLE);
        let _sock_idx = table
            .processes
            .get_mut(&600)
            .unwrap()
            .sockets
            .alloc(sock);

        // Spawn a child → bump the refcount to (parent=1, child=2).
        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child(600, &[b"a".as_slice()], &[], &[], &SpawnAttrs::empty(), &mut host)
            .expect("spawn_child");
        assert_eq!(host_net_handle_ref_count(HANDLE), 2);

        // Removing the child first: NOT the last reference → no close.
        let r1 = table.remove_process(child_pid).expect("remove child");
        assert!(
            r1.host_net_closes.is_empty(),
            "child exit must not emit host_net_close while parent still holds the handle"
        );
        assert_eq!(host_net_handle_ref_count(HANDLE), 1);

        // Removing the parent now: IS the last reference → emit close.
        let r2 = table.remove_process(600).expect("remove parent");
        assert_eq!(
            r2.host_net_closes,
            alloc::vec![HANDLE],
            "parent exit must emit host_net_close for the last-ref handle"
        );
        // The refcount table entry should be gone (close_ref dropped to 0).
        assert_eq!(host_net_handle_ref_count(HANDLE), 0);
    }

    #[test]
    fn spawn_child_applies_close_action() {
        // Parent has fd 5 → some inherited OFD. After spawn with file
        // action Close{fd:5}, the child must NOT have fd 5; the parent
        // is unaffected.
        use crate::process_table::ProcessTable;
        use crate::spawn::{FileAction, SpawnAttrs};

        let mut table = ProcessTable::new();
        table.create_process(700).unwrap();

        // Inject an OFD + fd 5 into parent. Use a file_type+host_handle that
        // won't trigger any host call on close-after-spawn.
        let parent = table.processes.get_mut(&700).unwrap();
        let ofd_idx = parent.ofd_table.create(
            crate::ofd::FileType::Regular,
            wasm_posix_shared::flags::O_RDONLY,
            42, // host_handle (positive). bump_inherited_resource_refcounts
                // will register it; close_ref returns false → no host_close.
            b"/tmp/foo".to_vec(),
        );
        parent.fd_table.alloc_at_min(crate::fd::OpenFileDescRef(ofd_idx), 0, 5).unwrap();
        // Sanity: parent has fd 5.
        assert!(table.get(700).unwrap().fd_table.get(5).is_ok());

        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child(
                700,
                &[b"a".as_slice()],
                &[],
                &[FileAction::Close { fd: 5 }],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");

        // Child: fd 5 closed.
        assert!(
            table.get(child_pid).unwrap().fd_table.get(5).is_err(),
            "child must have fd 5 closed by file action"
        );
        // Parent: fd 5 still open.
        assert!(
            table.get(700).unwrap().fd_table.get(5).is_ok(),
            "parent fd 5 must be unaffected"
        );
    }

    #[test]
    fn spawn_child_applies_dup2_action() {
        // Parent has fd 5 → some OFD. After spawn with Dup2{srcfd:5, fd:1},
        // the child's fd 1 points at fd 5's OFD; the parent is unaffected.
        use crate::process_table::ProcessTable;
        use crate::spawn::{FileAction, SpawnAttrs};

        let mut table = ProcessTable::new();
        table.create_process(701).unwrap();

        let parent = table.processes.get_mut(&701).unwrap();
        let ofd_idx = parent.ofd_table.create(
            crate::ofd::FileType::Regular,
            wasm_posix_shared::flags::O_RDONLY,
            43,
            b"/tmp/bar".to_vec(),
        );
        parent.fd_table.alloc_at_min(crate::fd::OpenFileDescRef(ofd_idx), 0, 5).unwrap();
        let parent_fd1_ofd = table.get(701).unwrap().fd_table.get(1).unwrap().ofd_ref.0;

        let mut host = test_host::NoopHost;
        let child_pid = table
            .spawn_child(
                701,
                &[b"a".as_slice()],
                &[],
                &[FileAction::Dup2 { srcfd: 5, fd: 1 }],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect("spawn_child");

        // Child fd 1 now points at the same OFD as fd 5.
        let child = table.get(child_pid).unwrap();
        let child_fd1_ofd = child.fd_table.get(1).unwrap().ofd_ref.0;
        let child_fd5_ofd = child.fd_table.get(5).unwrap().ofd_ref.0;
        assert_eq!(child_fd1_ofd, child_fd5_ofd, "child fd 1 dup2'd from fd 5");
        // Parent fd 1 unchanged.
        assert_eq!(
            table.get(701).unwrap().fd_table.get(1).unwrap().ofd_ref.0,
            parent_fd1_ofd,
            "parent fd 1 unaffected"
        );
    }

    #[test]
    fn spawn_child_action_failure_drops_partial_child() {
        // Dup2 from a closed source fd must fail with EBADF and leave the
        // parent's process table unchanged.
        use crate::process_table::ProcessTable;
        use crate::spawn::{FileAction, SpawnAttrs};
        use wasm_posix_shared::Errno;

        let mut table = ProcessTable::new();
        table.create_process(702).unwrap();
        let pids_before: Vec<u32> = table.all_pids();
        let parent_fork_count_before = table.get(702).unwrap().fork_count();

        let mut host = test_host::NoopHost;
        let err = table
            .spawn_child(
                702,
                &[b"a".as_slice()],
                &[],
                &[FileAction::Dup2 { srcfd: 999, fd: 1 }],
                &SpawnAttrs::empty(),
                &mut host,
            )
            .expect_err("spawn_child must fail when an action errors");
        assert_eq!(err, Errno::EBADF);

        // No new pid leaked.
        let pids_after: Vec<u32> = table.all_pids();
        assert_eq!(pids_before, pids_after, "no partial child must remain");
        // fork_count still 0.
        assert_eq!(table.get(702).unwrap().fork_count(), parent_fork_count_before);
    }

    #[test]
    fn spawn_child_setsid_makes_session_leader() {
        use crate::process_table::ProcessTable;
        use crate::spawn::{attr_flags, SpawnAttrs};

        let mut table = ProcessTable::new();
        table.create_process(800).unwrap();
        // Parent's identity to confirm child diverges.
        table.processes.get_mut(&800).unwrap().sid = 50;
        table.processes.get_mut(&800).unwrap().pgid = 60;

        let attrs = SpawnAttrs { flags: attr_flags::SETSID, pgrp: 0, sigdef: 0, sigmask: 0 };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child(800, &[b"a".as_slice()], &[], &[], &attrs, &mut host)
            .unwrap();

        let child = table.get(cpid).unwrap();
        assert_eq!(child.sid, cpid, "SETSID makes child its own session leader");
        assert_eq!(child.pgid, cpid, "SETSID also makes child its own pgrp leader");
        assert!(child.is_session_leader, "is_session_leader flag set");
    }

    #[test]
    fn spawn_child_setpgroup_zero_uses_child_pid() {
        use crate::process_table::ProcessTable;
        use crate::spawn::{attr_flags, SpawnAttrs};

        let mut table = ProcessTable::new();
        table.create_process(801).unwrap();

        let attrs = SpawnAttrs { flags: attr_flags::SETPGROUP, pgrp: 0, sigdef: 0, sigmask: 0 };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child(801, &[b"a".as_slice()], &[], &[], &attrs, &mut host)
            .unwrap();
        assert_eq!(table.get(cpid).unwrap().pgid, cpid, "SETPGROUP with pgrp=0 → child's own pid");
    }

    #[test]
    fn spawn_child_setpgroup_explicit_lands_in_target() {
        use crate::process_table::ProcessTable;
        use crate::spawn::{attr_flags, SpawnAttrs};

        let mut table = ProcessTable::new();
        table.create_process(802).unwrap();

        let attrs = SpawnAttrs { flags: attr_flags::SETPGROUP, pgrp: 42, sigdef: 0, sigmask: 0 };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child(802, &[b"a".as_slice()], &[], &[], &attrs, &mut host)
            .unwrap();
        assert_eq!(table.get(cpid).unwrap().pgid, 42);
    }

    #[test]
    fn spawn_child_setsigmask_overrides_inherited_mask() {
        use crate::process_table::ProcessTable;
        use crate::spawn::{attr_flags, SpawnAttrs};

        let mut table = ProcessTable::new();
        table.create_process(803).unwrap();
        // Parent has SIGINT (bit 0) blocked.
        table.processes.get_mut(&803).unwrap().signals.blocked = 0x1;

        let attrs = SpawnAttrs { flags: attr_flags::SETSIGMASK, pgrp: 0, sigdef: 0, sigmask: 0xFFu64 };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child(803, &[b"a".as_slice()], &[], &[], &attrs, &mut host)
            .unwrap();
        assert_eq!(
            table.get(cpid).unwrap().signals.blocked, 0xFFu64,
            "SETSIGMASK overrides the inherited mask wholesale"
        );
    }

    #[test]
    fn spawn_child_without_setsigmask_inherits_blocked_mask() {
        // Sanity: confirm that without SETSIGMASK, the child gets the parent's
        // blocked mask. This is the baseline the override test contrasts against.
        use crate::process_table::ProcessTable;
        use crate::spawn::SpawnAttrs;

        let mut table = ProcessTable::new();
        table.create_process(804).unwrap();
        table.processes.get_mut(&804).unwrap().signals.blocked = 0xAAu64;
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child(804, &[b"a".as_slice()], &[], &[], &SpawnAttrs::empty(), &mut host)
            .unwrap();
        assert_eq!(table.get(cpid).unwrap().signals.blocked, 0xAAu64);
    }

    #[test]
    fn spawn_child_inherits_sig_ign_but_not_custom_handlers() {
        // POSIX exec semantics: SIG_IGN persists across exec, custom handlers
        // reset to SIG_DFL. spawn is fork+exec atomic, so the same applies.
        use crate::process_table::ProcessTable;
        use crate::signal::SignalHandler;
        use crate::spawn::SpawnAttrs;
        use wasm_posix_shared::signal::{SIGUSR1, SIGUSR2};

        let mut table = ProcessTable::new();
        table.create_process(805).unwrap();
        let parent = table.processes.get_mut(&805).unwrap();
        parent.signals.set_handler(SIGUSR1, SignalHandler::Ignore).unwrap();
        parent.signals.set_handler(SIGUSR2, SignalHandler::Handler(42)).unwrap();

        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child(805, &[b"a".as_slice()], &[], &[], &SpawnAttrs::empty(), &mut host)
            .unwrap();

        let child = table.get(cpid).unwrap();
        assert_eq!(
            child.signals.get_handler(SIGUSR1), SignalHandler::Ignore,
            "child inherits SIG_IGN across the implicit exec"
        );
        assert_eq!(
            child.signals.get_handler(SIGUSR2), SignalHandler::Default,
            "child resets parent's custom handler to SIG_DFL"
        );
    }

    #[test]
    fn spawn_child_setsigdef_resets_named_handlers_to_default() {
        // SETSIGDEF should override SIG_IGN inheritance for named signals.
        use crate::process_table::ProcessTable;
        use crate::signal::SignalHandler;
        use crate::spawn::{attr_flags, SpawnAttrs};
        use wasm_posix_shared::signal::{SIGUSR1, SIGUSR2};

        let mut table = ProcessTable::new();
        table.create_process(806).unwrap();
        let parent = table.processes.get_mut(&806).unwrap();
        parent.signals.set_handler(SIGUSR1, SignalHandler::Ignore).unwrap();
        parent.signals.set_handler(SIGUSR2, SignalHandler::Ignore).unwrap();

        // Reset SIGUSR1 to SIG_DFL via SETSIGDEF; leave SIGUSR2 alone.
        let sigdef = 1u64 << (SIGUSR1 - 1);
        let attrs = SpawnAttrs { flags: attr_flags::SETSIGDEF, pgrp: 0, sigdef, sigmask: 0 };
        let mut host = test_host::NoopHost;
        let cpid = table
            .spawn_child(806, &[b"a".as_slice()], &[], &[], &attrs, &mut host)
            .unwrap();

        let child = table.get(cpid).unwrap();
        assert_eq!(child.signals.get_handler(SIGUSR1), SignalHandler::Default);
        assert_eq!(child.signals.get_handler(SIGUSR2), SignalHandler::Ignore);
    }

    #[test]
    fn fork_count_bumps_on_successful_fork() {
        use crate::process_table::ProcessTable;
        let mut table = ProcessTable::new();
        table.create_process(100).unwrap();
        // Sanity: counter starts at 0.
        assert_eq!(table.get(100).unwrap().fork_count(), 0);

        table.fork_process(100, 101).expect("first fork");
        assert_eq!(table.get(100).unwrap().fork_count(), 1);

        table.fork_process(100, 102).expect("second fork");
        assert_eq!(table.get(100).unwrap().fork_count(), 2);

        // Children's counters are independent and start at 0 — they have not
        // forked themselves.
        assert_eq!(table.get(101).unwrap().fork_count(), 0);
        assert_eq!(table.get(102).unwrap().fork_count(), 0);
    }

    #[test]
    fn test_alloc_pipe_reuses_freed_slots() {
        let mut proc = Process::new(1);
        assert!(proc.pipes.is_empty());

        // Allocate first pipe
        let idx0 = proc.alloc_pipe(PipeBuffer::new(64));
        assert_eq!(idx0, 0);
        let idx1 = proc.alloc_pipe(PipeBuffer::new(64));
        assert_eq!(idx1, 1);
        assert_eq!(proc.pipes.len(), 2);

        // Free slot 0
        proc.pipes[0] = None;

        // Next alloc should reuse slot 0
        let idx2 = proc.alloc_pipe(PipeBuffer::new(64));
        assert_eq!(idx2, 0);
        assert_eq!(proc.pipes.len(), 2); // No growth
    }

    #[test]
    fn test_alloc_pipe_pair_reuses_consecutive_slots() {
        let mut proc = Process::new(1);

        // Allocate 4 pipes (2 pairs)
        let (a, b) = proc.alloc_pipe_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        assert_eq!((a, b), (0, 1));
        let (c, d) = proc.alloc_pipe_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        assert_eq!((c, d), (2, 3));
        assert_eq!(proc.pipes.len(), 4);

        // Free first pair
        proc.pipes[0] = None;
        proc.pipes[1] = None;

        // Next pair should reuse slots 0,1
        let (e, f) = proc.alloc_pipe_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        assert_eq!((e, f), (0, 1));
        assert_eq!(proc.pipes.len(), 4); // No growth
    }

    #[test]
    fn test_alloc_pipe_pair_skips_non_consecutive_free_slots() {
        let mut proc = Process::new(1);

        // Allocate 4 individual pipes
        for _ in 0..4 {
            proc.alloc_pipe(PipeBuffer::new(64));
        }
        assert_eq!(proc.pipes.len(), 4);

        // Free only slots 0 and 2 (not consecutive)
        proc.pipes[0] = None;
        proc.pipes[2] = None;

        // Pair allocation needs consecutive slots, should append
        let (a, b) = proc.alloc_pipe_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        assert_eq!((a, b), (4, 5));
        assert_eq!(proc.pipes.len(), 6);
    }
}
