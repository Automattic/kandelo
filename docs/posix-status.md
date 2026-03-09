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
| `open()` | Partial | Host-delegated. O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_NONBLOCK, O_CLOEXEC, O_DIRECTORY, O_NOFOLLOW flags handled. umask applied to mode on O_CREAT. |
| `openat()` | Partial | AT_FDCWD delegates to open(). Absolute paths handled. Relative paths with non-AT_FDCWD dirfd return ENOSYS (requires directory path resolution). |
| `close()` | Partial | Ref-counted OFD cleanup. Host handle closed when last ref dropped. EINTR not yet handled. |
| `read()` | Partial | Host-delegated for files. Pipe/socket reads from kernel ring buffer. Short reads permitted. O_NONBLOCK returns EAGAIN when no data available. |
| `pread()` | Partial | Host-delegated via seek-read-restore. Not atomic (single-threaded safe only). Rejects pipes/sockets with ESPIPE. |
| `write()` | Partial | Host-delegated for files. Pipe writes to kernel ring buffer. EPIPE on closed read end. O_APPEND seek-to-end not yet atomic. |
| `pwrite()` | Partial | Host-delegated via seek-write-restore. Not atomic (single-threaded safe only). Rejects pipes/sockets with ESPIPE. |
| `lseek()` | Full | SEEK_SET, SEEK_CUR, SEEK_END all implemented. SEEK_END delegates to host for file size calculation. |
| `dup()` | Full | Lowest available fd. FD_CLOEXEC cleared. Shares OFD with original. |
| `dup2()` | Full | Atomic close-and-dup. Same-fd no-op. FD_CLOEXEC cleared. |
| `dup3()` | Full | Like dup2 but returns EINVAL if oldfd==newfd. Supports O_CLOEXEC flag. |
| `pipe()` | Partial | Kernel-space ring buffer (64KB). PIPE_BUF=4096. O_NONBLOCK enforced (EAGAIN). Cross-process pipes via SharedArrayBuffer after fork. Blocking read/write not yet implemented. |
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
| `fstatat()` | Partial | AT_FDCWD delegates to stat/lstat. AT_SYMLINK_NOFOLLOW supported. Relative paths with real dirfd return ENOSYS. |
| `unlinkat()` | Partial | AT_FDCWD delegates to unlink/rmdir. AT_REMOVEDIR flag supported. |
| `mkdirat()` | Partial | AT_FDCWD delegates to mkdir. umask applied. |
| `renameat()` | Partial | Both dirfds must be AT_FDCWD or paths absolute. |
| `faccessat()` | Partial | AT_FDCWD delegates to access(). Absolute paths handled. Relative paths with real dirfd return ENOSYS. |
| `fchmodat()` | Partial | AT_FDCWD delegates to chmod(). AT_SYMLINK_NOFOLLOW accepted. Relative paths with real dirfd return ENOSYS. |
| `fchownat()` | Partial | AT_FDCWD delegates to chown(). Relative paths with real dirfd return ENOSYS. |
| `linkat()` | Partial | Both dirfds must be AT_FDCWD or paths absolute. |
| `symlinkat()` | Partial | Target stored as-is. AT_FDCWD for linkpath dirfd only. Relative paths return ENOSYS. |
| `readlinkat()` | Partial | AT_FDCWD delegates to readlink(). Relative paths with real dirfd return ENOSYS. |

## fcntl()

| Command | Status | Notes |
|---------|--------|-------|
| `F_DUPFD` | Full | Lowest fd >= arg. FD_CLOEXEC cleared. |
| `F_DUPFD_CLOEXEC` | Full | Atomic dup + set FD_CLOEXEC. |
| `F_GETFD` | Full | Returns FD_CLOEXEC flag. |
| `F_SETFD` | Full | Sets FD_CLOEXEC flag. Per-fd, not per-OFD. |
| `F_GETFL` | Full | Returns status flags + access mode. Use O_ACCMODE mask. |
| `F_SETFL` | Full | Only O_APPEND, O_NONBLOCK modifiable. Access mode bits preserved. |
| `F_GETLK` | Full | Advisory record locking. Returns blocking lock info or F_UNLCK if no conflict. |
| `F_SETLK` | Full | Non-blocking lock acquisition. Returns EAGAIN on conflict. Read/write access mode validated. |
| `F_SETLKW` | Partial | Blocking lock acquisition. In single-process mode, behaves like F_SETLK (no contention possible). Multi-process blocking deferred to Phase 3b. |
| `F_GETOWN` | Full | Returns async I/O owner PID from OFD. Default 0. |
| `F_SETOWN` | Full | Sets async I/O owner PID on OFD. SIGIO delivery deferred to signal delivery phase. |

## Process Management

| Function | Status | Notes |
|----------|--------|-------|
| `fork()` | Partial | Host-side ProcessManager.fork() serializes kernel state from parent worker, deserializes in child worker. Binary format covers process scalars, FD/OFD tables, signals, environment, CWD, rlimits, terminal. No Wasm-internal fork syscall yet (host-initiated only). |
| `exec()` | Planned | Load new Wasm module into existing process context. Deferred to Phase 13e. |
| `waitpid()` | Partial | Host-side ProcessManager.waitpid() with WNOHANG support. Reaps zombie processes. No Wasm-internal waitpid syscall yet (host-initiated only). |
| `exit()` / `_exit()` | Partial | Closes all fds and dir streams, sets ProcessState::Exited. No parent notification yet (needs waitpid). |
| `getpid()` | Full | Returns pid from Process struct. |
| `getppid()` | Full | Returns ppid (0 for init process). |
| `getuid()` / `geteuid()` | Full | Simulated; defaults to uid=1000. Configurable at init. |
| `getgid()` / `getegid()` | Full | Simulated; defaults to gid=1000. Configurable at init. |
| `setuid()` / `seteuid()` | Full | Simulated. setuid sets both uid and euid. seteuid sets only euid. No privilege checks. |
| `setgid()` / `setegid()` | Full | Simulated. setgid sets both gid and egid. setegid sets only egid. No privilege checks. |
| `getpgrp()` | Full | Returns process group ID (simulated, defaults to pid). |
| `setpgid()` | Full | Sets process group ID. pid=0 means self. pgid=0 means use target pid. |
| `getsid()` | Full | Returns session ID (simulated, defaults to pid). pid=0 means self. |
| `setsid()` | Full | Creates new session. Sets sid=pid, pgid=pid. Returns new session ID. |

## Signals

| Function | Status | Notes |
|----------|--------|-------|
| `kill()` | Partial | Marks signal as pending. sig=0 validity check. Cross-process delivery via host_kill import and ProcessManager.deliverSignal(). |
| `signal()` | Full | Legacy API. Returns previous handler. Wraps sigaction() semantics. SIGKILL/SIGSTOP immutable. |
| `sigaction()` | Partial | Sets handler disposition (SIG_DFL, SIG_IGN, or function pointer). SIGKILL/SIGSTOP immutable. Actual handler invocation deferred (requires Asyncify or syscall-entry checking). |
| `sigprocmask()` | Full | Block/unblock/setmask operations on 64-bit signal mask. SIGKILL and SIGSTOP cannot be blocked per POSIX. |
| `sigsuspend()` | Planned | Requires blocking + signal delivery mechanism. |
| `raise()` | Full | Equivalent to kill(getpid(), sig). |
| `alarm()` | Planned | Timer-based SIGALRM. Requires host timer integration. |

## Memory Management

| Function | Status | Notes |
|----------|--------|-------|
| `mmap()` | Partial | Anonymous mappings only (MAP_ANONYMOUS). Page-aligned (64KB Wasm pages). File-backed mappings not yet supported. MAP_FIXED not yet supported. |
| `munmap()` | Full | Removes tracked region. Page-aligned address required. |
| `brk()` / `sbrk()` | Partial | Kernel-managed program break. Initial break at 0x01000000. Only increases supported; shrinking not yet implemented. |
| `mprotect()` | Stub | Returns ENOSYS. Wasm linear memory has no page-level protection. |

## Directory Operations

| Function | Status | Notes |
|----------|--------|-------|
| `opendir()` | Partial | Host-delegated via DirStream table. Entry-at-a-time iteration. |
| `readdir()` | Partial | Returns WasmDirent (d_ino, d_type, d_namlen) + name buffer. |
| `closedir()` | Full | Frees DirStream slot, delegates to host. |
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

## Socket Operations

| Function | Status | Notes |
|----------|--------|-------|
| `socket()` | Partial | AF_UNIX (kernel-internal) and AF_INET (creation only) supported. SOCK_STREAM and SOCK_DGRAM types. SOCK_NONBLOCK and SOCK_CLOEXEC flags handled. |
| `socketpair()` | Full | AF_UNIX SOCK_STREAM. Bidirectional ring buffers (64KB each). Returns pre-connected pair. |
| `bind()` | Stub | Returns ENOSYS. Requires host network stack for AF_INET. |
| `listen()` | Stub | Returns ENOSYS. Requires host network stack. |
| `accept()` | Stub | Returns ENOSYS. Requires host network stack. |
| `connect()` | Stub | Returns ENOSYS. Requires host network stack. |
| `send()` / `recv()` | Partial | Works for connected Unix domain sockets (via socketpair). MSG_PEEK supported for non-consuming reads. |
| `sendto()` / `recvfrom()` | Stub | Returns ENOSYS. Requires host network stack for UDP. |
| `setsockopt()` / `getsockopt()` | Partial | SOL_SOCKET level: SO_TYPE, SO_DOMAIN, SO_ERROR, SO_ACCEPTCONN, SO_RCVBUF, SO_SNDBUF readable. SO_REUSEADDR, SO_KEEPALIVE accepted (no-op). |
| `shutdown()` | Full | SHUT_RD, SHUT_WR, SHUT_RDWR. Properly closes buffer endpoints. |
| `select()` | Partial | Wrapper around poll(). Converts fd_set bitmasks to pollfd array. Timeout ignored (non-blocking only). |
| `poll()` | Partial | Checks readiness for regular files, pipes, and sockets. Timeout ignored (non-blocking only). |

## Time

| Function | Status | Notes |
|----------|--------|-------|
| `time()` | Full | Wrapper around clock_gettime(CLOCK_REALTIME). Returns seconds since epoch. |
| `gettimeofday()` | Full | Wrapper around clock_gettime(CLOCK_REALTIME). Returns (sec, usec) pair. |
| `clock_gettime()` | Full | Host-delegated. CLOCK_REALTIME and CLOCK_MONOTONIC supported. Node.js uses Date.now() and process.hrtime.bigint(). |
| `nanosleep()` | Partial | Host-delegated. Node.js uses Atomics.wait with timeout. Browser may need Asyncify fallback. Validates tv_sec >= 0 and tv_nsec < 1e9. |
| `usleep()` | Full | Converts microseconds to sec+nsec, delegates to host_nanosleep. |

## Terminal / TTY

| Function | Status | Notes |
|----------|--------|-------|
| `isatty()` | Full | Returns 1 for CharDevice fds (stdin/stdout/stderr), ENOTTY for others. |
| `tcgetattr()` / `tcsetattr()` | Partial | Kernel-simulated terminal state (c_iflag, c_oflag, c_cflag, c_lflag, c_cc). Does not affect actual host I/O. TCSANOW/TCSADRAIN/TCSAFLUSH all treated the same. |
| `ioctl()` (TIOC*) | Partial | TIOCGWINSZ and TIOCSWINSZ supported. Default 24x80. Other ioctls return ENOTTY. |

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
| `setrlimit()` | Full | Sets resource limits (advisory, not enforced). Validates soft <= hard. |
| `getrusage()` | Partial | Returns zeroed rusage struct (144 bytes). RUSAGE_SELF and RUSAGE_CHILDREN supported. No actual resource tracking in Wasm. |

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
