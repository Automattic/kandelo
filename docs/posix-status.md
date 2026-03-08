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
| `open()` | Partial | Host-delegated. O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_NONBLOCK, O_CLOEXEC, O_DIRECTORY flags handled. O_NOFOLLOW not yet supported. |
| `openat()` | Partial | AT_FDCWD delegates to open(). Absolute paths handled. Relative paths with non-AT_FDCWD dirfd return ENOSYS (requires directory path resolution). |
| `close()` | Partial | Ref-counted OFD cleanup. Host handle closed when last ref dropped. EINTR not yet handled. |
| `read()` | Partial | Host-delegated for files. Pipe reads from kernel ring buffer. Short reads permitted. O_NONBLOCK not yet enforced. |
| `pread()` | Partial | Host-delegated via seek-read-restore. Not atomic (single-threaded safe only). Rejects pipes/sockets with ESPIPE. |
| `write()` | Partial | Host-delegated for files. Pipe writes to kernel ring buffer. EPIPE on closed read end. O_APPEND seek-to-end not yet atomic. |
| `pwrite()` | Partial | Host-delegated via seek-write-restore. Not atomic (single-threaded safe only). Rejects pipes/sockets with ESPIPE. |
| `lseek()` | Full | SEEK_SET, SEEK_CUR, SEEK_END all implemented. SEEK_END delegates to host for file size calculation. |
| `dup()` | Full | Lowest available fd. FD_CLOEXEC cleared. Shares OFD with original. |
| `dup2()` | Full | Atomic close-and-dup. Same-fd no-op. FD_CLOEXEC cleared. |
| `pipe()` | Partial | Kernel-space ring buffer (64KB). PIPE_BUF=4096. Blocking read/write not yet implemented (needs cross-worker IPC). |
| `fstat()` | Partial | Host-delegated for regular files. Pipe returns S_IFIFO | 0o600. Full struct stat populated. |

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
| `F_GETOWN` | Planned | Requires signals subsystem. |
| `F_SETOWN` | Planned | Requires signals subsystem. |

## Process Management

| Function | Status | Notes |
|----------|--------|-------|
| `fork()` | Planned | Requires Wasm linear memory snapshot + multi-worker coordination. Deferred to Phase 3b. |
| `exec()` | Planned | Load new Wasm module into existing process context. Deferred to Phase 3b. |
| `waitpid()` | Planned | Requires cross-worker IPC. Deferred to Phase 3b. |
| `exit()` / `_exit()` | Partial | Closes all fds and dir streams, sets ProcessState::Exited. No parent notification yet (needs waitpid). |
| `getpid()` | Full | Returns pid from Process struct. |
| `getppid()` | Full | Returns ppid (0 for init process). |
| `getuid()` / `geteuid()` | Full | Simulated; defaults to uid=1000. Configurable at init. |
| `getgid()` / `getegid()` | Full | Simulated; defaults to gid=1000. Configurable at init. |

## Signals

| Function | Status | Notes |
|----------|--------|-------|
| `kill()` | Partial | Marks signal as pending. sig=0 validity check. Single-process only (no cross-process delivery yet). |
| `signal()` | Planned | Legacy API. Use sigaction() instead. |
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
| `mkdir()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. |
| `rmdir()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. |
| `chdir()` / `getcwd()` | Partial | Kernel-maintained cwd. chdir validates via host_stat that target is S_IFDIR. getcwd returns ERANGE if buffer too small. |
| `link()` / `unlink()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. |
| `rename()` | Partial | Host-delegated. Both paths resolved via kernel cwd. |
| `stat()` / `lstat()` | Partial | Host-delegated. stat follows symlinks, lstat does not. |
| `chmod()` / `chown()` | Partial | Host-delegated. May be no-op in browser environments. |
| `access()` | Partial | Host-delegated. Checks real filesystem permissions. |
| `realpath()` | Planned | Can be userspace with readlink + getcwd. |
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
| `send()` / `recv()` | Partial | Works for connected Unix domain sockets (via socketpair). Delegates to read/write. MSG_PEEK not yet implemented. |
| `sendto()` / `recvfrom()` | Stub | Returns ENOSYS. Requires host network stack for UDP. |
| `setsockopt()` / `getsockopt()` | Partial | SOL_SOCKET level: SO_TYPE, SO_DOMAIN, SO_ERROR, SO_ACCEPTCONN, SO_RCVBUF, SO_SNDBUF readable. SO_REUSEADDR, SO_KEEPALIVE accepted (no-op). |
| `shutdown()` | Full | SHUT_RD, SHUT_WR, SHUT_RDWR. Properly closes buffer endpoints. |
| `select()` / `poll()` | Partial | poll() implemented. Checks readiness for regular files, pipes, and sockets. Timeout ignored (non-blocking only). select() can be userspace on top of poll(). |

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
| `tcgetattr()` / `tcsetattr()` | Planned | Virtual terminal state in kernel. |
| `ioctl()` (TIOC*) | Planned | Terminal ioctls only. |

## Environment

| Function | Status | Notes |
|----------|--------|-------|
| `getenv()` | Full | Kernel-managed environment block. Returns value or ENOENT. ERANGE if buffer too small. |
| `setenv()` / `unsetenv()` | Full | Kernel-managed. setenv supports overwrite flag. Rejects empty name or name containing '='. |
| `environ` | Partial | Stored as Vec of KEY=VALUE entries in Process. No C-style char** environ pointer yet. |

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
