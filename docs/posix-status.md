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
| `openat()` | Planned | Same as open() with AT_FDCWD and relative fd support. |
| `close()` | Partial | Ref-counted OFD cleanup. Host handle closed when last ref dropped. EINTR not yet handled. |
| `read()` | Partial | Host-delegated for files. Pipe reads from kernel ring buffer. Short reads permitted. O_NONBLOCK not yet enforced. |
| `pread()` | Planned | Read at offset without modifying file position. |
| `write()` | Partial | Host-delegated for files. Pipe writes to kernel ring buffer. EPIPE on closed read end. O_APPEND seek-to-end not yet atomic. |
| `pwrite()` | Planned | Write at offset without modifying file position. |
| `lseek()` | Partial | SEEK_SET, SEEK_CUR implemented. SEEK_END returns ENOSYS (needs host file size query). |
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
| `F_GETLK` | Planned | Advisory record locking. Requires kernel lock table. |
| `F_SETLK` | Planned | Non-blocking lock acquisition. |
| `F_SETLKW` | Planned | Blocking lock acquisition. Requires cross-worker coordination. |
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
| `mmap()` | Planned | Can map to Wasm linear memory regions. Anonymous mappings simpler than file-backed. |
| `munmap()` | Planned | |
| `brk()` / `sbrk()` | Planned | Often handled by guest libc (dlmalloc). May not need kernel support. |
| `mprotect()` | N/A | Wasm linear memory has no page-level protection. |

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
| `socket()` | Planned | Requires host network stack. |
| `bind()` | Planned | |
| `listen()` | Planned | |
| `accept()` | Planned | |
| `connect()` | Planned | |
| `send()` / `recv()` | Planned | |
| `sendto()` / `recvfrom()` | Planned | |
| `setsockopt()` / `getsockopt()` | Planned | |
| `shutdown()` | Planned | |
| `select()` / `poll()` | Planned | Kernel-space fd readiness tracking. |

## Time

| Function | Status | Notes |
|----------|--------|-------|
| `time()` | Planned | Host-delegated. |
| `gettimeofday()` | Planned | Host-delegated. |
| `clock_gettime()` | Planned | Host-delegated. |
| `nanosleep()` | Planned | Atomics.wait with timeout, or setTimeout fallback. |
| `usleep()` | Planned | |

## Terminal / TTY

| Function | Status | Notes |
|----------|--------|-------|
| `isatty()` | Planned | Check if fd references a char device. |
| `tcgetattr()` / `tcsetattr()` | Planned | Virtual terminal state in kernel. |
| `ioctl()` (TIOC*) | Planned | Terminal ioctls only. |

## Environment

| Function | Status | Notes |
|----------|--------|-------|
| `getenv()` | Planned | Userspace with kernel-provided initial environment. |
| `setenv()` / `unsetenv()` | Planned | Userspace. |
| `environ` | Planned | |

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
5. **Phase 5 (Next):** fcntl locking — F_GETLK, F_SETLK, F_SETLKW
6. **Phase 6:** Sockets — socket, bind, listen, accept, connect
7. **Phase 7:** Time, TTY, environment
8. **Phase 8:** Memory management — mmap (anonymous), brk
