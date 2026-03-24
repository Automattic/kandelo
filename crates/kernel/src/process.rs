extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::{Errno, WasmStat};

use crate::fd::FdTable;
use crate::lock::LockTable;
use crate::memory::MemoryManager;
use crate::ofd::OfdTable;
use crate::pipe::PipeBuffer;
use crate::signal::SignalState;
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
    fn host_futex_wait(&mut self, addr: u32, expected: u32, timeout_ns: i64) -> Result<i32, Errno>;
    /// Futex wake: wake up to `count` waiters on addr. Returns number woken.
    fn host_futex_wake(&mut self, addr: u32, count: u32) -> Result<i32, Errno>;
    /// Clone: spawn a new thread worker. Returns child TID on success.
    fn host_clone(&mut self, fn_ptr: u32, arg: u32, stack_ptr: u32, tls_ptr: u32, ctid_ptr: u32) -> Result<i32, Errno>;
}

/// Process lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Running,
    Exited,
}

/// Per-thread state within a process.
#[derive(Debug, Clone)]
pub struct ThreadInfo {
    pub tid: u32,
    pub ctid_ptr: u32,    // CLONE_CHILD_CLEARTID address (futex wake on exit)
    pub stack_ptr: u32,
    pub tls_ptr: u32,
    pub tidptr: u32,       // set_tid_address pointer
}

impl ThreadInfo {
    pub fn new(tid: u32, ctid_ptr: u32, stack_ptr: u32, tls_ptr: u32) -> Self {
        ThreadInfo { tid, ctid_ptr, stack_ptr, tls_ptr, tidptr: 0 }
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
    /// Alternate signal stack (sigaltstack): ss_sp, ss_flags, ss_size.
    pub alt_stack_sp: u32,
    pub alt_stack_flags: u32,
    pub alt_stack_size: u32,
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
            uid: 1000,
            gid: 1000,
            euid: 1000,
            egid: 1000,
            pgid: pid,
            sid: 0,
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
            alt_stack_sp: 0,
            alt_stack_flags: 2, // SS_DISABLE
            alt_stack_size: 0,
        }
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
}
