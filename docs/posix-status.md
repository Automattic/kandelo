# POSIX API Compliance Status

This document tracks the implementation status of POSIX APIs in the wasm-posix-kernel. It is organized by subsystem and updated as features are implemented.

**Legend:**
- **Full** — Fully implemented per POSIX spec
- **Partial** — Implemented with documented limitations
- **Stub** — Returns ENOSYS or placeholder
- **Planned** — Not yet started, on roadmap
- **N/A** — Not applicable to Wasm environment

---

## File Descriptors & I/O

| Function | Status | Notes |
|----------|--------|-------|
| `open()` | Partial | Host-delegated. O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_NONBLOCK, O_CLOEXEC, O_DIRECTORY, O_NOFOLLOW flags handled. umask applied to mode on O_CREAT. Virtual device interception (`/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/full`, `/dev/fd/N`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`). |
| `openat()` | Full | AT_FDCWD delegates to open(). Absolute paths handled. Real dirfd supported via stored OFD paths. |
| `close()` | Partial | Ref-counted OFD cleanup. Host handle closed when last ref dropped. Releases all fcntl advisory locks on the file (POSIX-compliant). EINTR not yet handled. |
| `read()` | Partial | Host-delegated for files. Pipe/socket reads from kernel ring buffer with blocking when empty (EINTR on signal). Short reads permitted. O_NONBLOCK returns EAGAIN. |
| `pread()` | Partial | Host-delegated via seek-read-restore. Not atomic (single-threaded safe only). Rejects pipes/sockets with ESPIPE. |
| `write()` | Partial | Host-delegated for files. Pipe writes to kernel ring buffer with blocking when full (EINTR on signal). EPIPE + SIGPIPE on closed read end (POSIX-compliant). O_APPEND seeks to end before write. RLIMIT_FSIZE enforced (EFBIG + SIGXFSZ). |
| `pwrite()` | Partial | Host-delegated via seek-write-restore. Not atomic (single-threaded safe only). Rejects pipes/sockets with ESPIPE. |
| `lseek()` | Full | SEEK_SET, SEEK_CUR, SEEK_END all implemented. SEEK_END delegates to host for file size calculation. |
| `dup()` | Full | Lowest available fd. FD_CLOEXEC cleared. Shares OFD with original. |
| `dup2()` | Full | Atomic close-and-dup. Same-fd no-op. FD_CLOEXEC cleared. |
| `dup3()` | Full | Like dup2 but returns EINVAL if oldfd==newfd. Supports O_CLOEXEC flag. |
| `pipe()` | Partial | Kernel-space ring buffer (64KB). PIPE_BUF=4096 but atomicity not enforced for writes ≤ PIPE_BUF (POSIX requires no interleaving). O_NONBLOCK enforced (EAGAIN). Cross-process pipes via SharedArrayBuffer after fork. Blocking read/write not yet implemented. |
| `pipe2()` | Full | Like pipe with O_NONBLOCK and O_CLOEXEC flag support. |
| `readv()` | Full | Scatter read. Iterates over iovec array calling sys_read for each buffer. Stops on short read or EOF. |
| `writev()` | Full | Gather write. Iterates over iovec array calling sys_write for each buffer. Stops on short write. |
| `fstat()` | Partial | Host-delegated for regular files. Pipe returns S_IFIFO | 0o600. Full struct stat populated. |
| `ftruncate()` | Partial | Host-delegated for regular files with write access. Validates length >= 0. Rejects non-regular fds. |
| `fsync()` | Partial | Host-delegated for regular files. Rejects non-regular fds (pipes, sockets). |
| `fdatasync()` | Partial | Alias for fsync(). No metadata distinction in Wasm environment. |
| `truncate()` | Partial | Path-based. Opens file O_WRONLY, calls ftruncate, closes. |
| `fchmod()` | Partial | Host-delegated for regular files and directories. Rejects pipes/sockets. |
| `fchown()` | Partial | Host-delegated for regular files and directories. Rejects pipes/sockets. |
| `preadv()` | Full | Scatter-gather read at offset. Iterates iovec entries calling pread for each. Stops on short read or EOF. |
| `pwritev()` | Full | Scatter-gather write at offset. Iterates iovec entries calling pwrite for each. Stops on short write. |
| `preadv2()` / `pwritev2()` | Partial | Delegates to preadv/pwritev. Extra flags parameter ignored. |
| `sendfile()` | Full | Emulated with read+write loop (no zero-copy in Wasm). Supports offset parameter for positioned read from input fd. |
| `fallocate()` | Stub | Returns 0 (no-op). File space managed by host. |
| `copy_file_range()` | Stub | Returns ENOSYS. Programs fall back to read+write. |
| `splice()` / `tee()` / `vmsplice()` | Stub | Returns ENOSYS. |
| `readahead()` | Stub | Returns 0 (no-op advisory). |
| `fstatat()` | Full | AT_FDCWD delegates to stat/lstat. AT_SYMLINK_NOFOLLOW supported. Real dirfd supported via stored OFD paths. |
| `statx()` | Full | Delegates to fstatat, fills statx struct (256 bytes) from WasmStat. STATX_BASIC_STATS mask. |
| `unlinkat()` | Full | AT_FDCWD delegates to unlink/rmdir. AT_REMOVEDIR flag supported. Real dirfd supported. |
| `mkdirat()` | Full | AT_FDCWD delegates to mkdir. umask applied. Real dirfd supported. |
| `renameat()` | Full | Both dirfds supported (AT_FDCWD, absolute, or real dirfd). |
| `faccessat()` | Full | AT_FDCWD delegates to access(). Absolute paths and real dirfd supported. |
| `fchmodat()` | Full | AT_FDCWD delegates to chmod(). AT_SYMLINK_NOFOLLOW accepted. Real dirfd supported. |
| `fchownat()` | Full | AT_FDCWD delegates to chown(). Real dirfd supported. |
| `linkat()` | Full | Both dirfds supported (AT_FDCWD, absolute, or real dirfd). |
| `symlinkat()` | Full | Target stored as-is. Linkpath resolved via dirfd. Real dirfd supported. |
| `readlinkat()` | Full | AT_FDCWD delegates to readlink(). Real dirfd supported. |

## fcntl()

| Command | Status | Notes |
|---------|--------|-------|
| `F_DUPFD` | Full | Lowest fd >= arg. FD_CLOEXEC cleared. |
| `F_DUPFD_CLOEXEC` | Full | Atomic dup + set FD_CLOEXEC. |
| `F_GETFD` | Full | Returns FD_CLOEXEC flag. |
| `F_SETFD` | Full | Sets FD_CLOEXEC flag. Per-fd, not per-OFD. |
| `F_GETFL` | Full | Returns status flags + access mode. Use O_ACCMODE mask. |
| `F_SETFL` | Full | Only O_APPEND, O_NONBLOCK modifiable. Access mode bits preserved. |
| `F_GETLK` | Full | Advisory record locking. Returns blocking lock info or F_UNLCK if no conflict. Locks released on close() and exit() per POSIX. |
| `F_SETLK` | Full | Non-blocking lock acquisition. Returns EAGAIN on conflict. Read/write access mode validated. Locks released on close() and exit() per POSIX. |
| `F_SETLKW` | Partial | Blocking lock acquisition. In single-process mode, behaves like F_SETLK (no contention possible). Multi-process blocking not yet implemented. No deadlock detection. |
| `F_GETOWN` | Full | Returns async I/O owner PID from OFD. Default 0. |
| `F_SETOWN` | Full | Sets async I/O owner PID on OFD. SIGIO delivery deferred to signal delivery phase. |

## Process Management

| Function | Status | Notes |
|----------|--------|-------|
| `fork()` | Partial | Host-side ProcessManager.fork() serializes kernel state from parent worker, deserializes in child worker. Binary format covers process scalars, FD/OFD tables, signals, environment, CWD, rlimits, terminal. No Wasm-internal fork syscall yet (host-initiated only). |
| `exec()` | Partial | Replaces process image with new Wasm binary in same worker. Preserves PID, open fds (closes CLOEXEC), environment, CWD, signal mask. Resets caught handlers to default (SIG_IGN preserved). Host-initiated via ProcessManager.exec() and kernel-initiated via host_exec import. |
| `waitpid()` | Partial | Host-side ProcessManager.waitpid() with WNOHANG support. Reaps zombie processes. No Wasm-internal waitpid syscall yet (host-initiated only). |
| `exit()` / `_exit()` | Partial | Closes all fds and dir streams, releases all fcntl locks, sets ProcessState::Exited. SIGCHLD delivered to parent via host ProcessManager. |
| `getpid()` | Full | Returns pid from Process struct. |
| `getppid()` | Full | Returns ppid (0 for init process). |
| `getuid()` / `geteuid()` | Full | Simulated; defaults to uid=1000. Configurable at init. |
| `getgid()` / `getegid()` | Full | Simulated; defaults to gid=1000. Configurable at init. |
| `setuid()` / `seteuid()` | Full | Simulated. setuid sets both uid and euid. seteuid sets only euid. No privilege checks. |
| `setgid()` / `setegid()` | Full | Simulated. setgid sets both gid and egid. setegid sets only egid. No privilege checks. |
| `getpgrp()` | Full | Returns process group ID (simulated, defaults to pid). |
| `setpgid()` | Partial | Sets process group ID. pid=0 means self. pgid=0 means use target pid. Only supports setting own pgid; other processes return ESRCH. |
| `getsid()` | Full | Returns session ID (simulated, defaults to pid). pid=0 means self. |
| `setsid()` | Full | Creates new session. Sets sid=pid, pgid=pid. Returns new session ID. Returns EPERM if already session leader (POSIX-compliant). |
| `prctl()` | Partial | PR_SET_NAME and PR_GET_NAME store/retrieve thread name (16 bytes). All other operations return success (no-op). Syscall number fixed to 223 (Batch 3). |
| `gettid()` | Stub | Single-threaded: returns pid (tid == pid). Threading upgrade: return actual thread ID from thread table. |
| `set_tid_address()` | Stub | Single-threaded: returns pid, ignores tidptr. Threading upgrade: store tidptr per-thread; kernel writes 0 + futex-wakes on thread exit. |
| `set_robust_list()` | Stub | Single-threaded: no-op. Threading upgrade: track robust futex list per-thread; kernel walks list on thread exit. |
| `futex()` | Stub | Single-threaded: FUTEX_WAIT returns EAGAIN (no contention possible), FUTEX_WAKE returns 0 (no waiters). PRIVATE variants handled. Threading upgrade: hash table mapping (process, uaddr) → wait queue. |
| `execve()` | Full | Delegates to kernel_execve. Replaces process image. |
| `execveat()` | Partial | Extracts path, delegates to kernel_execve. Ignores dirfd (path must be absolute or CWD-relative). |
| `fork()` (syscall) | Stub | Returns ENOSYS from glue. Host-initiated only via ProcessManager. |
| `vfork()` | Stub | Returns ENOSYS. |
| `clone()` | Stub | Returns ENOSYS. Threading not yet supported. |
| `personality()` | Stub | Returns 0 (PER_LINUX). |
| `unshare()` / `setns()` | Stub | Returns EPERM. No namespace support. |
| `ptrace()` | Stub | Returns ENOSYS. |
| `process_vm_readv()` / `process_vm_writev()` | Stub | Returns ENOSYS. |
| `membarrier()` | Stub | Returns 0 (no-op, single-threaded). |
| `getcpu()` | Stub | Writes cpu=0, node=0. Single-CPU Wasm. |
| `get_robust_list()` | Stub | Returns ENOSYS. |
| `set_thread_area()` | Stub | Returns ENOSYS. |
| `setfsuid()` / `setfsgid()` | Stub | Returns 0 (no-op). |
| `acct()` | Stub | Returns ENOSYS. |
| `reboot()` | Stub | Returns EPERM. |
| `swapon()` / `swapoff()` | Stub | Returns EPERM. |
| `syslog()` | Stub | Returns EPERM. |
| `capget()` / `capset()` | Stub | Returns EPERM. No capabilities model. |
| `vhangup()` | Stub | Returns EPERM. |
| `sethostname()` / `setdomainname()` | Stub | Returns EPERM. |
| `init_module()` / `delete_module()` | Stub | Returns EPERM. No kernel module support. |
| `ioperm()` / `iopl()` | Stub | Returns EPERM. No I/O port access. |
| `remap_file_pages()` | Stub | Returns ENOSYS. |

## Signals

| Function | Status | Notes |
|----------|--------|-------|
| `kill()` | Partial | Marks signal as pending. sig=0 validity check. Cross-process delivery via host_kill import and ProcessManager.deliverSignal(). Pending signals delivered at syscall boundaries. |
| `signal()` | Full | Legacy API. Returns previous handler. Wraps sigaction() semantics. SIGKILL/SIGSTOP immutable. |
| `sigaction()` | Partial | Sets handler disposition (SIG_DFL, SIG_IGN, or function pointer) plus sa_flags and sa_mask. SIGKILL/SIGSTOP immutable. SA_RESTART supported: blocking read/write/recv/poll auto-restart instead of returning EINTR. SA_NOCLDSTOP/SA_NOCLDWAIT/SA_SIGINFO stored but not yet acted upon. **Note:** Programs must be linked with `--table-base=2 --export-table` so the host can dispatch handlers from the user program's function table (indices 0/1 reserved for SIG_DFL/SIG_IGN). |
| `sigprocmask()` | Full | Block/unblock/setmask operations on 64-bit signal mask. SIGKILL and SIGSTOP cannot be blocked per POSIX. |
| `sigsuspend()` | Full | Atomically replaces signal mask and blocks until deliverable signal arrives. Uses SharedArrayBuffer + Atomics.wait/notify for cross-thread wake. Always returns EINTR. |
| `pause()` | Full | Suspends until a signal is delivered. Delegates to sigsuspend with current mask. Always returns EINTR. |
| `raise()` | Full | Equivalent to kill(getpid(), sig). |
| `alarm()` | Full | Sets SIGALRM timer via host setTimeout. Returns previous remaining seconds. alarm(0) cancels. Not inherited by fork, canceled by exec. |
| `setitimer()` | Full | ITIMER_REAL: sets alarm deadline + interval via host_set_alarm. ITIMER_VIRTUAL/ITIMER_PROF: no-op (no CPU time tracking). Fixes musl's alarm() which internally calls setitimer. |
| `getitimer()` | Full | ITIMER_REAL: returns stored interval + remaining time from deadline. ITIMER_VIRTUAL/ITIMER_PROF: returns zero. |
| `sigtimedwait()` | Full | Checks pending signals in mask, dequeues lowest. Polls with 1ms sleep on timeout. Returns EAGAIN on timeout. |
| `sigqueue()` / `rt_sigqueueinfo()` | Partial | Extracts signal number and delivers via raise(). siginfo_t data ignored (no signal queuing). |
| `rt_sigreturn()` | Stub | Returns 0. Signal trampoline handled by host. |
| `signalfd()` / `signalfd4()` | Stub | Returns ENOSYS. |

## Memory Management

| Function | Status | Notes |
|----------|--------|-------|
| `mmap()` | Partial | Anonymous mappings only (MAP_ANONYMOUS). Page-aligned (64KB Wasm pages). File-backed mappings not yet supported. MAP_FIXED not yet supported. |
| `munmap()` | Full | Removes tracked region. Page-aligned address required. |
| `brk()` / `sbrk()` | Partial | Kernel-managed program break. Initial break at 0x01000000. Growing and shrinking supported. Program break inherited on fork/exec. |
| `mprotect()` | Stub | Returns ENOSYS. Wasm linear memory has no page-level protection. |
| `memfd_create()` | Stub | Returns ENOSYS. |

## Directory Operations

| Function | Status | Notes |
|----------|--------|-------|
| `opendir()` | Partial | Host-delegated via DirStream table. Entry-at-a-time iteration. Stores resolved path for rewinddir. |
| `readdir()` | Partial | Returns WasmDirent (d_ino, d_type, d_namlen) + name buffer. Tracks position for telldir/seekdir. |
| `closedir()` | Full | Frees DirStream slot, delegates to host. |
| `rewinddir()` | Full | Closes and reopens directory via stored path. Resets position to 0. |
| `telldir()` | Full | Returns current position counter from DirStream. |
| `seekdir()` | Full | Rewinds and skips entries to reach target position. |
| `mkdir()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. umask applied to mode. |
| `rmdir()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. |
| `chdir()` / `getcwd()` | Partial | Kernel-maintained cwd. chdir validates via host_stat that target is S_IFDIR. getcwd returns ERANGE if buffer too small. |
| `link()` / `unlink()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. |
| `rename()` | Partial | Host-delegated. Both paths resolved via kernel cwd. |
| `stat()` / `lstat()` | Partial | Host-delegated. stat follows symlinks, lstat does not. |
| `chmod()` / `chown()` | Partial | Host-delegated. May be no-op in browser environments. |
| `access()` | Partial | Host-delegated. Checks real filesystem permissions. |
| `realpath()` | Partial | Resolves path against cwd, normalizes `.`/`..`, verifies existence via stat. Intermediate symlink resolution not yet performed (future enhancement). |
| `symlink()` / `readlink()` | Partial | Host-delegated. Symlink target stored as-is, linkpath resolved. |
| `sync()` / `syncfs()` | Stub | Returns 0 (no-op). Filesystem sync managed by host. |
| `sync_file_range()` | Stub | Returns 0 (no-op). |
| `chroot()` | Stub | Returns EPERM. No filesystem namespace isolation. |
| `mount()` / `umount2()` | Stub | Returns EPERM. Future: VFS mount/unmount support. |
| `pivot_root()` | Stub | Returns EPERM. |
| `mknod()` / `mknodat()` | Stub | Returns EPERM. Device node creation not supported. |
| `quotactl()` | Stub | Returns ENOSYS. |
| `renameat2()` | Full | Delegates to renameat. Extra flags parameter ignored. |
| `faccessat2()` | Full | Delegates to faccessat. Extra flags parameter ignored. |
| `fchmodat2()` | Full | Delegates to fchmodat. Extra flags parameter ignored. |
| `getdents()` (legacy) | Full | Delegates to getdents64. |
| `name_to_handle_at()` / `open_by_handle_at()` | Stub | Returns ENOSYS. |

## Socket Operations

| Function | Status | Notes |
|----------|--------|-------|
| `socket()` | Partial | AF_UNIX (kernel-internal) and AF_INET (creation only) supported. SOCK_STREAM and SOCK_DGRAM types. SOCK_NONBLOCK and SOCK_CLOEXEC flags handled. |
| `socketpair()` | Full | AF_UNIX SOCK_STREAM. Bidirectional ring buffers (64KB each). Returns pre-connected pair. |
| `bind()` | Stub | Returns ENOSYS. Requires host network stack for AF_INET. |
| `listen()` | Stub | Returns ENOSYS. Requires host network stack. |
| `accept()` | Stub | Returns ENOSYS. Requires host network stack. |
| `connect()` | Stub | Returns ENOSYS. Requires host network stack. |
| `send()` / `recv()` | Partial | Works for connected Unix domain sockets (via socketpair). MSG_PEEK supported. **Gap:** MSG_WAITALL, MSG_DONTWAIT not supported. |
| `sendto()` / `recvfrom()` | Stub | Returns ENOSYS. Requires host network stack for UDP. |
| `setsockopt()` / `getsockopt()` | Partial | SOL_SOCKET: SO_TYPE, SO_DOMAIN, SO_ERROR, SO_ACCEPTCONN, SO_RCVBUF, SO_SNDBUF readable; SO_REUSEADDR, SO_KEEPALIVE, SO_LINGER, SO_RCVTIMEO, SO_SNDTIMEO, SO_BROADCAST accepted/stored. IPPROTO_TCP: TCP_NODELAY stored. |
| `shutdown()` | Full | SHUT_RD, SHUT_WR, SHUT_RDWR. Properly closes buffer endpoints. |
| `select()` | Partial | Wrapper around poll(). Converts fd_set bitmasks to pollfd array. Timeout supported via polling loop. |
| `poll()` | Partial | Checks readiness for regular files, pipes, and sockets. Timeout supported via polling loop with 1ms sleep intervals. Returns EINTR on pending signals. POLLERR for fully shut down sockets. |
| `ppoll()` | Full | Wraps poll() with atomic signal mask swap: save → set → poll → restore. Timespec converted to timeout_ms in glue layer. |
| `pselect6()` | Full | Wraps select() with atomic signal mask swap. Sigmask extracted from pselect6-style {sigset_t*, size_t} struct in glue layer. |
| `epoll_create1()` | Stub | Returns ENOSYS. Programs fall back to poll(). |
| `epoll_ctl()` | Stub | Returns ENOSYS. Programs fall back to poll(). |
| `epoll_pwait()` | Stub | Returns ENOSYS. Programs fall back to poll(). |
| `epoll_create()` / `epoll_wait()` | Stub | Legacy aliases. Returns ENOSYS. |
| `sendmmsg()` / `recvmmsg()` | Stub | Returns ENOSYS. |

## Time

| Function | Status | Notes |
|----------|--------|-------|
| `time()` | Full | Wrapper around clock_gettime(CLOCK_REALTIME). Returns seconds since epoch. |
| `gettimeofday()` | Full | Wrapper around clock_gettime(CLOCK_REALTIME). Returns (sec, usec) pair. |
| `clock_gettime()` | Full | Host-delegated. CLOCK_REALTIME and CLOCK_MONOTONIC supported. Node.js uses Date.now() and process.hrtime.bigint(). |
| `nanosleep()` | Partial | Host-delegated. Node.js uses Atomics.wait with timeout. Browser may need Asyncify fallback. Validates tv_sec >= 0 and tv_nsec < 1e9. |
| `usleep()` | Full | Converts microseconds to sec+nsec, delegates to host_nanosleep. |
| `clock_settime()` | Stub | Returns EPERM. Cannot set system clock from Wasm. |
| `settimeofday()` | Stub | Returns EPERM. Cannot set system clock from Wasm. |
| `adjtimex()` / `clock_adjtime()` | Stub | Returns EPERM. Cannot adjust system clock from Wasm. |
| `utimes()` | Full | Converts timeval to timespec, delegates to utimensat. |
| `futimesat()` | Full | Like utimes but relative to dirfd. Delegates to utimensat. |

## Scheduler

| Function | Status | Notes |
|----------|--------|-------|
| `sched_getparam()` | Stub | Writes sched_priority=0. Single-threaded Wasm has no scheduling policy. |
| `sched_setparam()` | Stub | Returns 0 (no-op). |
| `sched_getscheduler()` | Stub | Returns 0 (SCHED_OTHER). |
| `sched_setscheduler()` | Stub | Returns 0 (no-op). |
| `sched_get_priority_max()` | Stub | Returns 0. |
| `sched_get_priority_min()` | Stub | Returns 0. |
| `sched_rr_get_interval()` | Stub | Writes 10ms timespec. |
| `sched_setaffinity()` | Stub | Returns 0 (no-op). |
| `sched_getaffinity()` | Stub | Sets bit 0 in cpuset (1 CPU). Returns cpuset size. |
| `sched_yield()` | Stub | Returns 0 (no-op, single-threaded). |

## Event/Notification

| Function | Status | Notes |
|----------|--------|-------|
| `eventfd()` / `eventfd2()` | Stub | Returns ENOSYS. |
| `timerfd_create()` | Stub | Returns ENOSYS. |
| `timerfd_settime()` / `timerfd_gettime()` | Stub | Returns EINVAL. |
| `inotify_init()` / `inotify_init1()` | Stub | Returns ENOSYS. |
| `inotify_add_watch()` / `inotify_rm_watch()` | Stub | Returns EBADF. |
| `fanotify_init()` / `fanotify_mark()` | Stub | Returns ENOSYS. |
| `timer_create()` | Stub | Returns ENOSYS. POSIX per-process timers not implemented. |
| `timer_settime()` / `timer_gettime()` | Stub | Returns ENOSYS. |
| `timer_getoverrun()` / `timer_delete()` | Stub | Returns ENOSYS. |

## IPC (System V & POSIX Message Queues)

| Function | Status | Notes |
|----------|--------|-------|
| `msgget()` / `msgsnd()` / `msgrcv()` / `msgctl()` | Stub | Returns ENOSYS. SysV message queues not implemented. |
| `semget()` / `semop()` / `semctl()` / `semtimedop()` | Stub | Returns ENOSYS. SysV semaphores not implemented. |
| `shmget()` / `shmat()` / `shmdt()` / `shmctl()` | Stub | Returns ENOSYS. SysV shared memory not implemented. |
| `mq_open()` / `mq_unlink()` | Stub | Returns ENOSYS. POSIX message queues not implemented. |
| `mq_timedsend()` / `mq_timedreceive()` | Stub | Returns ENOSYS. |
| `mq_notify()` / `mq_getsetattr()` | Stub | Returns ENOSYS. |

## Extended Attributes

| Function | Status | Notes |
|----------|--------|-------|
| `getxattr()` / `setxattr()` / `removexattr()` / `listxattr()` | Stub | Returns ENOSYS. Extended attributes not supported by host filesystem abstraction. |
| `lgetxattr()` / `lsetxattr()` / `lremovexattr()` / `llistxattr()` | Stub | Returns ENOSYS. |
| `fgetxattr()` / `fsetxattr()` / `fremovexattr()` / `flistxattr()` | Stub | Returns ENOSYS. |

## Terminal / TTY

| Function | Status | Notes |
|----------|--------|-------|
| `isatty()` | Full | Returns 1 for CharDevice fds (stdin/stdout/stderr), ENOTTY for others. |
| `tcgetattr()` / `tcsetattr()` | Partial | Kernel-simulated terminal state (c_iflag, c_oflag, c_cflag, c_lflag, c_cc). Does not affect actual host I/O. TCSANOW/TCSADRAIN/TCSAFLUSH all treated the same. **Gap:** VMIN/VTIME values stored but not interpreted by read(). ICANON flag tracked but no line buffering applied. |
| `ioctl()` | Partial | TIOCGWINSZ and TIOCSWINSZ (terminal). FIONREAD (available bytes for pipe/socket/regular), FIONBIO (toggle O_NONBLOCK), FIOCLEX/FIONCLEX (set/clear FD_CLOEXEC). Generic ioctls work on any fd type; terminal ioctls require CharDevice. |

## Virtual Device Files

| Device | Status | Notes |
|--------|--------|-------|
| `/dev/null` | Full | Read returns EOF (0). Write discards data (returns count). Seek no-op. |
| `/dev/zero` | Full | Read fills buffer with zeros. Write discards data (returns count). |
| `/dev/urandom` / `/dev/random` | Full | Read delegates to `host_getrandom()` (crypto.getRandomValues on host). Write discards. |
| `/dev/full` | Full | Read fills buffer with zeros. Write returns ENOSPC. |
| `/dev/fd/N` | Full | Open-time dup of fd N. Validates target fd exists (EBADF if not). |
| `/dev/stdin` | Full | Alias for `/dev/fd/0`. |
| `/dev/stdout` | Full | Alias for `/dev/fd/1`. |
| `/dev/stderr` | Full | Alias for `/dev/fd/2`. |
| `/dev/tty` | Not yet | Controlling terminal — requires process-group shared state. |
| `/dev/pts/*` | Not yet | Pseudo-terminal pairs — requires cross-process coordination. |
| `/dev/shm/*` | Not yet | POSIX shared memory — requires cross-process SharedArrayBuffer. |

All virtual devices return synthetic `stat()` with `S_IFCHR | 0666`, deterministic inode numbers, and `st_dev=5`. Path interception in kernel before host delegation — no host filesystem changes needed. `access()` returns OK for all virtual devices.

## Environment

| Function | Status | Notes |
|----------|--------|-------|
| `getenv()` | Full | Kernel-managed environment block. Returns value or ENOENT. ERANGE if buffer too small. |
| `setenv()` / `unsetenv()` | Full | Kernel-managed. setenv supports overwrite flag. Rejects empty name or name containing '='. |
| `environ` | Partial | Stored as Vec of KEY=VALUE entries in Process. No C-style char** environ pointer yet. |

## System Information

| Function | Status | Notes |
|----------|--------|-------|
| `uname()` | Full | Returns sysname="wasm-posix", nodename="localhost", release="1.0.0", version="wasm-posix-kernel", machine="wasm32". 5 x 65-byte null-terminated strings. |
| `sysconf()` | Partial | Returns _SC_PAGE_SIZE=65536 (Wasm page), _SC_OPEN_MAX=1024, _SC_NPROCESSORS_ONLN=1, _SC_CLK_TCK=100. Unknown names return EINVAL. |
| `umask()` | Full | Set file creation mask, returns previous mask. Default 0o022. Applied in open() and mkdir(). Masked to 0o777. |
| `getrlimit()` | Full | Returns (soft, hard) resource limits. Defaults: NOFILE=(1024,4096), STACK=(8MB,infinity), others infinity. |
| `setrlimit()` | Partial | Sets resource limits. Validates soft <= hard. RLIMIT_NOFILE enforced via FdTable max_fds sync. RLIMIT_FSIZE enforced in write()/ftruncate() (EFBIG + SIGXFSZ). |
| `getrusage()` | Partial | Returns zeroed rusage struct (144 bytes). RUSAGE_SELF and RUSAGE_CHILDREN supported. No actual resource tracking in Wasm. |
| `pathconf()` | Full | Returns POSIX compile-time constants: _PC_NAME_MAX=255, _PC_PATH_MAX=4096, _PC_PIPE_BUF=4096, _PC_LINK_MAX=14, etc. |
| `fpathconf()` | Full | Same as pathconf() but validates fd exists first. Returns EBADF for invalid fd. |
| `getsockname()` | Partial | Returns AF_UNIX (family=1) for kernel-internal sockets. No real address information. |
| `getpeername()` | Partial | Returns AF_UNIX for connected kernel-internal sockets. Returns ENOTCONN for unconnected. |

---

## Known POSIX Gaps

Systematic audit of all subsystems against POSIX specifications. Gaps are categorized by severity and actionability.

### Critical — Violates POSIX semantics, causes incorrect behavior

(None currently — setitimer/getitimer resolved in Batch 5, signal handler delivery resolved via syscall-boundary checking.)

### High — Missing features that affect common programs

| Gap | Subsystem | Description |
|-----|-----------|-------------|
| **EINTR partially implemented** | all | read, write, recv, poll, select return EINTR when a signal is pending during a blocking wait. close() and other non-blocking syscalls do not check. Tied to signal handler invocation gap. |
| **PIPE_BUF atomicity not enforced** | pipe | Writes ≤ PIPE_BUF (4096) are not guaranteed atomic. POSIX requires no interleaving of concurrent writes ≤ PIPE_BUF. Ring buffer has no boundary tracking. |
| **O_APPEND not atomic** | write | Writes with O_APPEND do not atomically seek-to-end then write. In multi-process scenarios, concurrent O_APPEND writes could interleave. |
| ~~**sigaction() missing sa_flags**~~ | signals | **Resolved.** SA_RESTART supported (auto-restart blocking syscalls). sa_flags and sa_mask stored. SA_SIGINFO/SA_NOCLDWAIT/SA_NOCLDSTOP accepted but not yet acted upon. |
| **No signal queuing** | signals | Pending signals stored as 64-bit bitmask — one bit per signal. Multiple instances of the same signal are coalesced. POSIX real-time signals require queuing. |
| ~~**`*at()` functions with real dirfd**~~ | filesystem | **Resolved.** All *at() syscalls now support real dirfd via stored OFD paths. |
| ~~**No seekdir/telldir/rewinddir**~~ | directory | **Resolved.** DirStream now tracks path and position. rewinddir/telldir/seekdir implemented. |

### Medium — Spec deviations with limited practical impact

| Gap | Subsystem | Description |
|-----|-----------|-------------|
| **RLIMIT_FSIZE partial enforcement** | rlimits | write() and ftruncate() check FSIZE limit (EFBIG + SIGXFSZ). truncate() delegates to ftruncate so also enforced. |
| **setpgid() self-only** | process | Only supports setting own pgid. Setting another process's pgid returns ESRCH. |
| **realpath() no symlink resolution** | filesystem | Normalizes `.`/`..` and verifies existence but does not resolve intermediate symlinks. |
| **Socket options partially no-op** | socket | SO_REUSEADDR, SO_KEEPALIVE, SO_LINGER, SO_BROADCAST, SO_RCVTIMEO, SO_SNDTIMEO, TCP_NODELAY accepted and stored but have no effect on data transfer. |
| **POLLERR partial** | I/O multiplex | poll() reports POLLERR for sockets with both read and write shut down. No POLLERR for other error conditions. |
| **pread/pwrite not multi-process safe** | I/O | Uses save/seek/read/restore pattern — safe in single process but races with shared OFDs across processes. |
| ~~**brk not inherited on fork**~~ | memory | **Resolved.** Program break now serialized/deserialized in fork/exec state. |
| **VMIN/VTIME not interpreted** | terminal | Values stored in c_cc array but read() does not alter behavior based on them. |
| **ICANON no line buffering** | terminal | Flag tracked in c_lflag but no canonical-mode line editing or buffering applied. Host I/O unaffected. |
| **No job control** | terminal | tcgetpgrp()/tcsetpgrp() not implemented. No foreground/background process group distinction. SIGTTIN/SIGTTOU not generated. |
| **readdir() "." and ".." entries** | directory | Presence of `.` and `..` entries depends entirely on host implementation. |
| **No ENFILE** | fd | Only per-process EMFILE limit exists. No system-wide fd limit tracking. |

### Wasm-Inherent — Gaps that cannot be fully resolved in Wasm

| Gap | Subsystem | Reason |
|-----|-----------|--------|
| **mprotect() returns ENOSYS** | memory | Wasm linear memory has no page-level protection. |
| **No file-backed mmap** | memory | Would require host cooperation and shared memory semantics. MAP_FIXED also unsupported. |
| **TCP/UDP sockets** | socket | bind/listen/accept/connect return ENOSYS. Requires host network stack integration. |
| **Setuid/setgid enforcement** | process | Single-user Wasm environment; privilege checks simulated only. |
| **Permission checks** | filesystem | Delegated to host. Kernel does not independently verify file permissions. |
| **getrusage() zeroed** | sysinfo | No actual resource tracking available in Wasm. Returns zero-filled struct. |

### Future Work — Planned for later batches

**Medium-term:**
- PIPE_BUF atomicity enforcement (ring buffer boundary tracking for writes ≤ 4096)
- Multi-process F_SETLKW blocking (currently returns immediately)
- VMIN/VTIME terminal interpretation (read behavior based on c_cc values)
- Guest-initiated fork()/exec() syscalls (currently host-initiated only)
- Full epoll implementation (currently returns ENOSYS; programs fall back to poll)

**Threading stubs (requires multi-threading support):**
- `gettid()` — return actual thread ID from thread table (currently returns pid)
- `set_tid_address()` — store tidptr per-thread; kernel writes 0 + futex-wakes on exit (currently no-op)
- `set_robust_list()` — track robust futex list per-thread; walk on exit (currently no-op)
- `futex()` — hash table mapping (process, uaddr) → wait queue with WAIT/WAKE semantics (currently WAIT→EAGAIN, WAKE→0)
- `clone()` — create new thread sharing address space (not yet implemented)

**Hard / Architectural:**
- File-backed mmap() (requires host cooperation and shared memory semantics)
- Signal queuing for real-time signals (replace 64-bit bitmask with queue)
- True async poll/select (replace polling loop with host-based event notification)

---

## Environment-Specific Tradeoffs

Some POSIX APIs have different implementation strategies depending on the host environment. This section documents those tradeoffs.

### SharedArrayBuffer Required

These features require SharedArrayBuffer (and cross-origin isolation headers in browsers):

| Feature | With SAB | Without SAB |
|---------|----------|-------------|
| Blocking syscalls | `Atomics.wait()` — true blocking | Asyncify yield — cooperative, adds overhead |
| `fcntl()` locking | Kernel-coordinated via atomic ops | postMessage round-trip, higher latency |
| `pipe()` blocking read | Blocks worker until data available | Asyncify unwind/rewind |
| `nanosleep()` | `Atomics.wait()` with timeout | `setTimeout()` via Asyncify |
| Multi-process shared memory | Direct shared linear memory | Not supported; would need serialization |

### Browser vs Node.js

| Feature | Node.js | Browser |
|---------|---------|---------|
| File I/O | Native `fs` module — full POSIX | OPFS (limited), fetch (read-only), or virtual FS |
| `fork()` | `worker_threads` — feasible | Web Workers — feasible but different API |
| `Atomics.wait()` on main thread | Works | Throws — must use workers |
| Network sockets | `net`/`dgram` modules | WebSocket/WebRTC only (no raw sockets) |
| Process signals | `process.on('SIGINT', ...)` | Not available |
| stdin | `process.stdin` | Requires custom input mechanism |

---

## Implementation Priority

1. **Phase 1 (Complete):** File descriptors & basic I/O — open, close, read, write, lseek, dup, dup2, pipe, fstat, fcntl (flags)
2. **Phase 2 (Complete):** Directory operations — stat, lstat, mkdir, rmdir, unlink, link, symlink, readlink, rename, chmod, chown, access, opendir, readdir, closedir, chdir, getcwd
3. **Phase 3a (Complete):** Process identity & lifecycle — getpid, getppid, getuid/geteuid, getgid/getegid, exit/_exit
3b. **Phase 3b (Deferred):** Multi-process — fork, exec, waitpid (requires multi-worker architecture)
4. **Phase 4 (Complete):** Signals — kill, raise, sigaction, sigprocmask. Signal delivery mechanism deferred (needs Asyncify).
5. **Phase 5 (Complete):** fcntl locking — F_GETLK, F_SETLK, F_SETLKW with byte-range granularity
6. **Phase 6 (Complete):** Sockets & I/O multiplexing — socket, socketpair, shutdown, send/recv, getsockopt/setsockopt, poll. TCP stubs (bind/listen/accept/connect return ENOSYS).
7. **Phase 7 (Complete):** Time, TTY, environment — clock_gettime, nanosleep, isatty, getenv/setenv/unsetenv
8. **Phase 8 (Complete):** Memory management — mmap (anonymous), munmap, brk, mprotect (stub)
9. **Phase 9 (Complete):** Polish & gaps — tcgetattr/tcsetattr, ioctl (TIOCGWINSZ/TIOCSWINSZ), signal(), fcntl F_GETOWN/F_SETOWN, MSG_PEEK, O_NONBLOCK pipe enforcement, O_NOFOLLOW, time/gettimeofday/usleep/openat wrappers
10. **Phase 10 (Complete):** Extended POSIX — umask, uname, sysconf, dup3, pipe2, ftruncate, fsync, writev, readv, getrlimit, setrlimit
11. **Phase 11 (Complete):** Final gaps — truncate, fdatasync, fchmod, fchown, getpgrp, setpgid, getsid, setsid, fstatat, unlinkat, mkdirat, renameat
12. **Phase 12 (Complete):** Remaining tractable — faccessat, fchmodat, fchownat, linkat, symlinkat, readlinkat, select, setuid/setgid/seteuid/setegid, getrusage
13a. **Phase 13a (Complete):** Multi-Worker Infrastructure
- ProcessManager with process table and worker lifecycle
- WorkerAdapter abstraction (Node.js worker_threads + mock)
- Worker entry point: kernel initialization in worker thread
- Message protocol for host ↔ worker communication
13b. **Phase 13b (Complete):** Fork & Waitpid
- Binary fork state serialization/deserialization (Rust)
- kernel_get_fork_state / kernel_init_from_fork Wasm exports
- ProcessManager.fork() with state transfer to child worker
- ProcessManager.waitpid() with WNOHANG support
13c. **Phase 13c (Complete):** Cross-Process Pipes
- SharedPipeBuffer class (SharedArrayBuffer ring buffer with atomics)
- Host-delegated pipe support in kernel (host_handle >= 0 routes to host_read/host_write)
- kernel_convert_pipe_to_host Wasm export
- Pipe detection and conversion on fork via ProcessManager
13d. **Phase 13d (Complete):** Cross-Process Signals
- kernel_deliver_signal Wasm export for host-initiated signal injection
- host_kill Wasm import with cross-process routing in sys_kill
- DeliverSignalMessage protocol and ProcessManager.deliverSignal()
- KillRequestMessage: worker → host → target worker signal routing
13e. **Phase 13e (Complete):** Exec
- Exec state serialization: CLOEXEC fd filtering, signal handler reset, pending preservation
- kernel_get_exec_state / kernel_init_from_exec Wasm exports
- host_exec Wasm import and sys_execve syscall
- Worker re-initialization: new kernel instance with exec state in same worker
- ProcessManager.exec() for host-initiated exec
14. **POSIX Compliance Batch 4 (Complete):** ~20 syscalls — tkill, sigpending, getpgid, setreuid/setregid, sysinfo, times, lchown, waitid, plus glue-only stubs
15. **POSIX Compliance Batch 5 (Complete):** ~100+ syscalls
- **Critical fix:** setitimer/getitimer (fixes musl's alarm() which internally calls setitimer)
- **Kernel syscalls:** rt_sigtimedwait, preadv/pwritev, sendfile, statx
- **Scheduler stubs:** sched_getparam/setparam/getscheduler/setscheduler/priorities/affinity (9 syscalls)
- **File I/O extensions:** preadv2/pwritev2, fallocate, copy_file_range, splice/tee/vmsplice, readahead
- **Filesystem stubs:** sync/syncfs, chroot, mount/umount2, mknod/mknodat, renameat2, faccessat2/fchmodat2
- **Time stubs:** clock_settime, settimeofday, adjtimex, utimes/futimesat
- **Process stubs:** fork/vfork/clone (ENOSYS), execve/execveat, personality, unshare/setns
- **Event stubs:** eventfd2, signalfd4, timerfd_*, inotify_*, fanotify_*
- **IPC stubs:** SysV msg/sem/shm (12), POSIX mq (6), ipc multiplexer
- **Extended attributes:** 12 xattr syscalls (all ENOSYS)
- **Remaining:** memfd_create, membarrier, getcpu, splice/tee, POSIX timers, capget/capset, and more

---

## PHP-WASM / WordPress Playground Gap Analysis

Target use case: hosting PHP-WASM (as used by WordPress Playground) on this kernel, replacing Emscripten's POSIX emulation layer. This section tracks what's needed and what's missing.

### Phase A — Foundational (makes kernel viable as a PHP POSIX layer)

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| **`flock()` syscall** | file locking | PHP sessions and SQLite both use whole-file locking via `flock()`. WordPress calls it heavily. Can map to `fcntl` F_SETLK/F_SETLKW internally. | Medium |
| ~~`/dev/urandom` virtual device~~ | VFS | **Done.** `/dev/urandom` and `/dev/random` intercept in kernel, delegate to `host_getrandom()` → `crypto.getRandomValues()`. | Easy |
| ~~`getrandom()` syscall~~ | random | **Done.** Host-delegated to `crypto.getRandomValues()`. | Easy |
| **`putenv()` syscall** | environment | PHP uses `putenv("KEY=VALUE")` extensively. Different semantics from `setenv()` — takes a single `KEY=VALUE` string. | Easy |
| ~~Virtual device files in VFS~~ | VFS | **Done.** `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/full`, `/dev/fd/N`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` all handled in-kernel. PHP-WASM also uses `/request/stdout`, `/request/stderr`, `/request/headers` (not yet supported). | Medium |
| **`initgroups()` stub** | process | ZendAccelerator needs it. Return success (no-op). | Easy |

### Phase B — Networking (enables WordPress HTTP requests + MySQL)

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| **`connect()` for AF_INET** | socket | PHP needs outbound TCP for HTTP requests and database connections. Host-delegated to fetch API bridge (HTTP) or WebSocket-to-TCP proxy (raw TCP). | Hard |
| **`getaddrinfo()` / `gethostbyname()`** | DNS | Required for any network operation. Host-delegated (browser fetch or DNS-over-HTTPS). | Medium |
| **`setsockopt()` expansion** | socket | `SO_KEEPALIVE`, `TCP_NODELAY` at minimum. WordPress Playground patches these for MySQL connectivity. | Easy |
| **Async socket polling bridge** | socket | Bridge between blocking `poll()`/`select()` and async host I/O. Current `Atomics.wait()` approach works in workers. | Medium |

### Phase C — Process management (enables wp-cli, Composer, PHPUnit)

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| **Guest-initiated `fork()`/`exec()`** | process | Allow Wasm user-space code to trigger process spawning via syscall. Currently host-initiated only. | Hard |
| **`proc_open()` compatible semantics** | process | Pipe creation + process spawn + wait. WordPress Playground replaces `proc_open` with custom JS shims. | Hard |
| **Blocking pipe reads with timeout** | pipe | Current pipe blocking depends on SAB. Need proper timeout + EINTR semantics for `proc_open` pipes. | Medium |

### Phase D — Browser persistence + PHP compilation

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| **OPFS filesystem backend** | VFS | Origin Private File System for browser persistence across page loads. WordPress needs this for wp-content, uploads, database. | Medium |
| **PHP compiled with clang → wasm32 + this musl sysroot** | toolchain | Replace Emscripten compilation with direct clang targeting. Requires new minimal PHP SAPI replacing Emscripten's `EM_JS`/`EM_ASYNC_JS` integration. | Very Hard |
| **Emscripten SAPI replacement** | toolchain | PHP-WASM uses a ~2000-line custom C SAPI (`php_wasm.c`) tightly coupled to Emscripten. Would need a new SAPI using this kernel's syscall interface. | Very Hard |

### Architectural Decision: Async/Blocking Bridge

PHP is synchronous but the browser host is async. Two approaches:

| Approach | Pros | Cons |
|----------|------|------|
| **SAB + `Atomics.wait()`** (current) | True blocking, no stack transform overhead, works reliably in Workers | Cannot block browser main thread; PHP must run in Web Worker |
| **Asyncify / JSPI** (Emscripten approach) | Works on main thread | ~4.5s startup with auto-detect, 2x code size, fragile whitelist maintenance |

The `Atomics.wait()` approach is architecturally superior but requires PHP to run in a Web Worker, which is different from current Playground architecture.

### Already Covered for PHP-WASM

These PHP needs are well-handled by the current kernel:
- File I/O: open, close, read, write, lseek, fstat, stat, lstat, ftruncate, fsync
- Directory ops: opendir, readdir, closedir, mkdir, rmdir, rename, unlink
- FD manipulation: dup, dup2, dup3, pipe, pipe2, fcntl (with locking)
- Process identity: getpid, getppid, getuid/geteuid, getgid/getegid, setsid
- Signals: sigaction, sigprocmask, kill, signal, alarm
- Time: clock_gettime, gettimeofday, nanosleep, usleep
- Terminal: isatty, tcgetattr/tcsetattr, ioctl
- Environment: getenv, setenv, unsetenv
- Memory: anonymous mmap, munmap, brk
- Multi-process: fork, exec, waitpid (host-side)
- System info: uname, sysconf, umask, getrlimit/setrlimit

---

## Continuous Testing: musl libc-test Suite

The full musl libc-test suite (functional + regression + math) is run via `scripts/run-libc-tests.sh`. Use `--report` to generate `docs/libc-test-failures.md`.

### Summary (as of 2026-03-17)

| Category | Pass | Fail | Timeout | Build | Total |
|----------|------|------|---------|-------|-------|
| Functional | 46 | 11 | 6 | 0 | 63 |
| Regression | 43 | 12 | 8 | 0 | 63 |
| Math | ~89 | ~110 | 0 | 0 | 199 |

### Known Unfixable Failures

These require features fundamentally unavailable in single-threaded Wasm:

- **Wasm FP exceptions (110 math tests):** WebAssembly has no floating-point exception flags (`fenv.h`). All `fe*` math tests fail. `long double` variants pass because they use software fp128.
- **No pthreads (17+ tests):** `pthread_create`, `pthread_cancel`, `pthread_mutex`, `sem_init`, etc.
- **No fork/vfork (5+ tests):** `daemon-failure`, `fflush-exit`, `spawn`, `vfork`.
- **No exec + /bin/sh (1 test):** `execle-env` requires a real shell.
- **No SysV IPC (3 tests):** `ipc_msg`, `ipc_sem`, `ipc_shm` — ENOSYS by design.
- **No dlopen/TLS (1+ tests):** `tls_get_new-dtv_dso`.
- **No stack switching (1 test):** `sigaltstack` — signal handler runs but Wasm cannot switch stacks.

### Linker Requirements for Signal Handlers

Programs must be linked with two extra flags for signal handler dispatch to work:

- `--table-base=2`: Reserves function table indices 0 (SIG_DFL) and 1 (SIG_IGN) so they don't collide with real C function pointers.
- `--export-table`: Exports `__indirect_function_table` so the host can look up handler functions to call them.
