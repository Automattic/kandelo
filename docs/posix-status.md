# POSIX API Compliance Status

**Vision:** A POSIX-compliant kernel for WebAssembly that runs and coordinates multiple Wasm-based processes. The goal is to take existing systems software and run it on this kernel with minimal changes — ideally none. Full POSIX compliance is the default; developers can optionally trade compliance for simplicity or performance.

This document tracks the implementation status of POSIX APIs in Kandelo. It is organized by subsystem and updated as features are implemented.

**Legend:**
- **Full** — Fully implemented per POSIX spec
- **Partial** — Implemented with documented limitations
- **Stub** — Returns ENOSYS or placeholder
- **Planned** — Not yet started, on roadmap
- **N/A** — Not applicable to Wasm environment

---

## Architecture: Shared Kernel Model

Kandelo uses a single kernel Wasm instance that holds a `ProcessTable` and serves all process workers via channel IPC (`Atomics.waitAsync`).

**Key properties:**
- **Single kernel instance** with a `ProcessTable` mapping PIDs to `Process` structs
- **Process workers** communicate with the kernel via channel IPC — each process/thread has a channel region in shared memory, and the kernel services syscalls one at a time from the JS event loop
- **Cross-process shared state** uses kernel-global or host-coordinated
  backings where implemented. Pipes, locks, IPC objects, sockets, and selected
  stateful descriptors retain one backing across fork; ordinary regular-file
  OFD seek positions and status flags are still copied per process.
- **Serialized syscall execution** — the kernel handles one syscall at a time, which provides natural atomicity for operations like O_APPEND writes and PIPE_BUF-sized pipe writes
- **Signal delivery** across processes is direct — the kernel can write to any process's pending signal mask

**Key kernel-side APIs:**
- `kernel_create_process(pid)` — register a new process
- `kernel_fork_process(parent, child)` — fork state from parent to child (fd table, OFDs, signals, etc.)
- `kernel_remove_process(pid)` — clean up on exit
- `kernel_handle_channel(offset, pid)` — dispatch a syscall from a process's channel

---

## File Descriptors & I/O

| Function | Status | Notes |
|----------|--------|-------|
| `open()` | Partial | Host-delegated. O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_NONBLOCK, O_CLOEXEC, O_DIRECTORY, O_NOFOLLOW flags handled. umask applied to mode on O_CREAT. Virtual device interception (`/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/full`, `/dev/fd/N`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`). |
| `openat()` | Full | AT_FDCWD delegates to open(). Absolute paths handled. Real dirfd supported via stored OFD paths. |
| `close()` | Partial | Ref-counted OFD cleanup. Host handle closed when last ref dropped. Releases all fcntl advisory locks on the file (POSIX-compliant). EINTR not yet handled. |
| `read()` | Partial | Host-delegated for files. Pipe/socket reads from kernel ring buffer with blocking when empty (EINTR on signal). Short reads permitted. O_NONBLOCK returns EAGAIN. |
| `pread()` | Partial | Host-delegated via seek-read-restore. Not atomic (single-threaded safe only). Rejects pipes/sockets with ESPIPE. |
| `write()` | Partial | Host-delegated for files. Pipe writes to kernel ring buffer with blocking when full (EINTR on signal). EPIPE + SIGPIPE on closed read end (POSIX-compliant). O_APPEND seeks to end before write. For regular files and memfds, RLIMIT_FSIZE is calculated once per logical operation: a crossing operation returns the prefix that fits without a signal; a later non-empty operation with no room fails with EFBIG and generates thread-directed SIGXFSZ. |
| `pwrite()` | Partial | Host-delegated via seek-write-restore. Not atomic (single-threaded safe only). Rejects pipes/sockets with ESPIPE. Uses the same operation-wide RLIMIT_FSIZE rule as write without changing the OFD cursor. |
| `lseek()` | Full | SEEK_SET, SEEK_CUR, SEEK_END all implemented. SEEK_END delegates to host for file size calculation. A seek whose resulting offset would be negative fails with EINVAL without changing the open-file-description offset; arithmetic or host-number overflow fails with EOVERFLOW. |
| `dup()` | Full | Lowest available fd. FD_CLOEXEC cleared. Shares OFD with original. |
| `dup2()` | Full | Atomic close-and-dup. Same-fd no-op. FD_CLOEXEC cleared. |
| `dup3()` | Full | Like dup2 but returns EINVAL if oldfd==newfd. Supports O_CLOEXEC flag. |
| `pipe()` | Partial | Kernel-space ring buffer (64KB). PIPE_BUF=4096 atomicity is guaranteed by serialized kernel syscalls. O_NONBLOCK returns EAGAIN. Forked descriptors retain the same global pipe backing even though their per-process OFD metadata is copied. |
| `pipe2()` | Full | Like pipe with O_NONBLOCK and O_CLOEXEC flag support. |
| `readv()` | Full | Scatter read. Iterates over iovec array calling sys_read for each buffer. Stops on short read or EOF. |
| `writev()` | Full | Gather write. Enforces aggregate count and RLIMIT_FSIZE once across the full iovec operation, including host scratch-buffer decomposition, then stops on a short underlying write. |
| `fstat()` | Partial | Host-delegated for regular files. Pipe returns S_IFIFO | 0o600. Full struct stat populated. |
| `ftruncate()` | Partial | Host-delegated for regular files, with in-kernel memfd support. Requires write access, validates length >= 0, rejects non-regular fds, and enforces RLIMIT_FSIZE before changing either backing. |
| `fsync()` | Partial | Host-delegated for regular files. Rejects non-regular fds (pipes, sockets). |
| `fdatasync()` | Partial | Alias for fsync(). No metadata distinction in Wasm environment. |
| `truncate()` | Partial | Path-based. Opens file O_WRONLY, calls ftruncate, closes. |
| `fchmod()` | Partial | Regular files and directories update VFS metadata. Rejects pipes/sockets. Node host-backed files never receive native mode changes after creation. |
| `fchown()` | Partial | Regular files and directories update VFS metadata. `(uid_t)-1` and `(gid_t)-1` preserve the corresponding current ID without bypassing descriptor, authorization, or backend-error checks. Actual changes remain restricted to effective uid 0; the current owner may issue the raw `(-1, -1)` no-change request. Kernel-owned non-file descriptors still accept the call as a no-op, and Node host-backed ownership changes stay virtual. |
| `preadv()` | Full | Scatter-gather read at offset. Iterates iovec entries calling pread for each. Stops on short read or EOF. |
| `pwritev()` | Full | Scatter-gather write at offset. Enforces aggregate count and RLIMIT_FSIZE once across the full iovec operation, then stops on a short underlying write. |
| `preadv2()` / `pwritev2()` | Partial | Delegates to preadv/pwritev. Extra flags parameter ignored. |
| `sendfile()` | Full | Emulated with read+write loop (no zero-copy in Wasm). Supports an optional positioned input offset. The output RLIMIT_FSIZE budget is fixed before input is consumed, so a limit-induced short transfer advances the input only by the returned count. |
| `fallocate()` | Partial | Mode 0 extends through ftruncate when needed, including RLIMIT_FSIZE enforcement; allocation guarantees and nonzero modes are not implemented. |
| `copy_file_range()` | Full | Emulated with pread+pwrite loop. Supports optional offsets for both input and output fds. The output RLIMIT_FSIZE budget is fixed before input is consumed. |
| `splice()` | Full | Emulated through the copy loop with optional offsets. The output RLIMIT_FSIZE budget is fixed before input is consumed. |
| `tee()` / `vmsplice()` | Stub | Returns ENOSYS. |
| `readahead()` | Stub | Returns 0 (no-op advisory). |
| `fstatat()` | Full | AT_FDCWD delegates to stat/lstat. AT_SYMLINK_NOFOLLOW supported. Real dirfd supported via stored OFD paths. |
| `statx()` | Full | Delegates to fstatat, fills statx struct (256 bytes) from WasmStat. STATX_BASIC_STATS mask. |
| `unlinkat()` | Full | AT_FDCWD delegates to unlink/rmdir. AT_REMOVEDIR flag supported. Real dirfd supported. |
| `mkdirat()` | Full | AT_FDCWD delegates to mkdir. umask applied. Real dirfd supported. |
| `renameat()` | Full | Both dirfds supported (AT_FDCWD, absolute, or real dirfd). |
| `faccessat()` | Full | AT_FDCWD delegates to access(). Absolute paths and real dirfd supported. |
| `fchmodat()` | Full | AT_FDCWD delegates to chmod(). AT_SYMLINK_NOFOLLOW accepted. Real dirfd supported. |
| `fchownat()` | Partial | AT_FDCWD and real dirfds are supported, including unchanged-ID sentinels. The final symlink is followed by default and changed directly with `AT_SYMLINK_NOFOLLOW`. Unsupported flags, including `AT_EMPTY_PATH`, return EINVAL. Actual ownership changes remain restricted to effective uid 0. |
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
| `F_SETLKW` | Partial | Blocking lock acquisition. Host-backed locks and in-kernel fallback locks are coordinated across processes; blocking conflicts use an internal EAGAIN retry path in the host worker until the lock is available. No deadlock detection. |
| `F_GETOWN` | Full | Returns async I/O owner PID from OFD. Default 0. |
| `F_SETOWN` | Full | Sets async I/O owner PID on OFD. SIGIO delivery deferred to signal delivery phase. |

## Process Management

| Function | Status | Notes |
|----------|--------|-------|
| `fork()` | Partial | The kernel copies process state and the host starts a child Worker with copied Memory. Initial launch mirrors the environment into kernel-owned process state; fork copies that metadata while instrumented rewind preserves the live libc `environ` in copied Memory, and `execve()` replaces both from its supplied `envp`. `wasm-fork-instrument` resumes the child at the call site with preserved stack locals and mutable globals. Main-thread and pthread fork are supported, as is the documented direct main-to-one-side-module path; nested/opaque cross-side callbacks and fork from a pthread inside a side module remain unsupported. Pipes, sockets, PTYs, eventfd/timerfd/signalfd, memfd, procfs snapshots, and shared mappings retain their existing backings; signal and wait lifecycle state is copied/coordinated by the kernel. Ordinary regular-file OFD seek positions/status flags are still copied rather than shared. See [fork-instrumentation.md](fork-instrumentation.md) and the known OFD gap below. |
| `exec()` | Partial | Kernel-initiated via SYS_EXECVE (syscall 211). The host preflights the module, ABI, replacement memory, caller, deferred file actions, and a 4 MiB combined argv/environment representation (strings, terminators, and pointer entries) before replacing the image in place; individual strings are limited to 64 KiB and oversize returns `E2BIG` without truncation. Preserves PID, non-CLOEXEC fds and their exact kernel-backed object state, new argv/envp (including an explicitly empty environment), CWD, the calling pthread's signal mask and directed queue, terminal queues, and `alarm()`/`ITIMER_REAL`; closes directory streams, deletes `timer_create()` timers, publishes and detaches old mappings, terminates sibling threads, and resets the program break before installing the new `__heap_base`. File mappings retain a stable writeback handle even after their original fd closes. Remaining gaps: POSIX message-queue descriptors are not process-owned and therefore cannot yet be closed on exec; epoll registrations track numeric fds rather than OFD identity, so close/dup and same-number replacement cases are incomplete; and main-thread-directed signals share the process-pending queue and therefore cannot be distinguished from process-directed signals when a worker pthread execs. |
| `waitpid()` | Full | Kernel-internal: blocks parent until child exits (WNOHANG supported). Reaps zombie processes. Supports pid>0 (specific child), pid=-1 (any child), pid=0 (same pgid), pid<-1 (specific pgid). Returns normal-exit status with WIFEXITED/WEXITSTATUS and signal-death status with WIFSIGNALED/WTERMSIG. |
| `exit()` / `_exit()` | Full | Closes all fds and dir streams, releases locks and mapping/backing ownership, and retains the low eight status bits. Normal codes 128–255 remain distinct from signal termination, which is stored separately. SIGCHLD is delivered to the parent and zombie state remains until `waitpid()` reaps it. |
| `getpid()` | Full | Returns pid from Process struct. |
| `getppid()` | Full | Returns ppid (0 for init process). |
| `getuid()` / `geteuid()` | Full | Simulated; defaults to uid=0 (root). Configurable via setuid/seteuid. |
| `getgid()` / `getegid()` | Full | Simulated; defaults to gid=0 (root). Configurable via setgid/setegid. |
| `setuid()` / `seteuid()` | Full | POSIX semantics (no saved-set-uid tracked). As root: setuid sets both uid and euid; seteuid sets any euid. Non-root: setuid only to own uid; seteuid only to own ruid. Returns EPERM otherwise. |
| `setgid()` / `setegid()` | Full | POSIX semantics mirroring setuid — gated on euid==0 for privileged changes. Returns EPERM for non-root trying to change to a foreign gid. |
| `getpriority()` / `setpriority()` | Partial | Stores a per-process nice value; WebAssembly has no host CPU scheduler to apply it to. Linux-compatible `/proc/<pid>/stat` exposes scheduler priority in field 18 and nice in field 19. Procfs metadata operations reject missing or reaped PID scopes. |
| `getpgrp()` | Full | Returns process group ID (simulated, defaults to pid). |
| `setpgid()` | Partial | Sets process group ID. pid=0 means self. pgid=0 means use target pid. Only supports setting own pgid; other processes return ESRCH. |
| `getsid()` | Full | Returns session ID (simulated, defaults to pid). pid=0 means self. |
| `setsid()` | Full | Creates new session. Sets sid=pid, pgid=pid. Returns new session ID. Returns EPERM if already session leader (POSIX-compliant). |
| `prctl()` | Partial | PR_SET_NAME and PR_GET_NAME store/retrieve thread name (16 bytes). All other operations return success (no-op). Syscall number fixed to 223 (Batch 3). |
| `gettid()` | Partial | Returns pid for the main thread and the host-bound worker TID for pthread workers. Remaining limitation: this is Linux-compatible rather than POSIX-standard, and not all signal/thread APIs consume TID-specific state yet. |
| `set_tid_address()` | Partial | Returns the calling TID and stores the clear-TID pointer for thread exit notification. Host thread cleanup writes 0 and futex-wakes the address for normal pthread exit and forced cleanup paths. Robust-list handling remains deferred. |
| `set_robust_list()` | Stub | No-op. Robust futex list tracking deferred until threading is fully tested. |
| `futex()` | Partial | FUTEX_WAIT, FUTEX_WAKE, FUTEX_REQUEUE, FUTEX_CMP_REQUEUE, and FUTEX_WAKE_OP operate on one process's shared memory. Main-process WAIT uses host `Atomics.waitAsync`; pthread workers use direct `Atomics.wait`. Separate processes have separate `SharedArrayBuffer` objects, so these operations do not wake or synchronize a peer PID even when the futex word lies in a host-coordinated MAP_SHARED mapping. |
| `execve()` | Partial | Delegates to the in-place `exec()` path and has the same remaining descriptor/signal/mapping limitations described above. |
| `execveat()` | Partial | SYS_EXECVEAT (386). Resolves fd path via `kernel_get_fd_path`, supports AT_EMPTY_PATH for `fexecve()`, and resolves relative paths against process CWD; otherwise has the same remaining `exec()` limitations. |
| `fork()` (syscall) | Partial | Glue traps through channel IPC; the kernel copies process state, the host starts a child Worker, and `wasm-fork-instrument` replays the supported call stack so parent/child receive the POSIX return values. The side-module and ordinary-OFD limitations in the main `fork()` row still apply. |
| `vfork()` | Partial | Alias for `fork()` and therefore has the same continuation/OFD limitations; it does not provide distinct vfork address-space semantics. |
| `posix_spawn()` | Full | **Non-forking implementation** (this kernel's invention; no Linux equivalent). Glue issues `SYS_SPAWN` (500) with a marshalled blob (argv + envp + file actions + spawn attrs). Host parses the blob, calls `kernel_spawn_process` to allocate a child pid + build the child Process descriptor, then invokes `onSpawn` to launch a fresh Worker. No fork, no `wpk_fork_*` rewind, no exec replay. Supports POSIX_SPAWN_SETSID / SETPGROUP / SETSIGMASK / SETSIGDEF and FDOP_OPEN / CLOSE / DUP2 / CHDIR / FCHDIR. SIG_IGN dispositions persist across the implicit exec; custom handlers reset to SIG_DFL (POSIX exec semantics). Regression-guarded: `kernel_get_fork_count` exposes a per-process counter the test suite asserts is unchanged across SYS_SPAWN. See `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`. |
| `posix_spawnp()` | Full | PATH search lives in libc (`libc/musl-overlay/src/process/wasm32posix/posix_spawnp.c`); resolves the absolute path then delegates to `posix_spawn()`. Empty PATH entries treated as `.`; defers EACCES per `__execvpe` policy. |
| `clone()` | Partial | Thread-style clone (CLONE_VM\|CLONE_THREAD) supported. The kernel allocates the TID, and the host spawns a thread Worker sharing the parent's Memory. Normal pthread return, pthread_exit, and cancellation cleanup remain per-thread and wake join/clear-TID waiters; uncaught fatal Wasm traps in a pthread worker terminate the whole process with signal-style wait status. |
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
| `syslog()` | Partial | `SYS_SYSLOG` (kernel-log control) returns 0. Kandelo does not currently provide a `/dev/log` datagram receiver; AF_UNIX datagram connect therefore exposes the missing endpoint instead of silently discarding messages. |
| `capget()` / `capset()` | Stub | Returns EPERM. No capabilities model. |
| `vhangup()` | Stub | Returns EPERM. |
| `sethostname()` / `setdomainname()` | Stub | Returns EPERM. |
| `init_module()` / `delete_module()` | Stub | Returns EPERM. No kernel module support. |
| `ioperm()` / `iopl()` | Stub | Returns EPERM. No I/O port access. |
| `remap_file_pages()` | Stub | Returns ENOSYS. |
| `getcontext()` / `setcontext()` / `makecontext()` / `swapcontext()` | Unsupported | Userspace stack-switching primitives, deprecated in POSIX.1-2008, not planned. See the "ucontext API unsupported" row under [Wasm-Inherent gaps](#wasm-inherent--gaps-that-cannot-be-fully-resolved-in-wasm) for rationale. |
| `fork()` called from a C++/Ruby exception catch handler | Full | B1 stages 1+2 + Phase 6 catch-handler resume machinery (per-arm scratch space in the save buffer, multi-arm rewind dispatch, `$capture`-block emission, rewind-throw stub via `_wpk_fork_exnref_stash`) close fork-from-plain-catch under **modern wasm-EH lowering** (`try_table` / `catch_ref` / `throw_ref`). The fierce-wire mega-PR (PR #307) commit 9 + 2026-05-14 followup flipped the SDK + libcxx (revision 4) to modern EH explicitly (LLVM 21's `-wasm-use-legacy-eh` defaults to `true`, so removing the prior `=true` override silently kept legacy lowering — the explicit `=false` is required). Test coverage in `host/test/fork-instrument-coverage.test.ts`: C-02 fork-in-catch, C-03 multi-arm catch, C-04 throw-from-outside, C-05 modern EH single typed catch, C-06 modern multi-target `*_ref`, C-07 modern multi-arm plain, C-10 fork in both try body + handler, C-11 post-catch fork (SpiderMonkey-spike test (b)), S-08 throw-from-outside + fork-in-catch — all 9 PASS. Combined with C-01 (fork-in-try-body), the catch-handler coverage is comprehensive for both legacy-EH-pattern and modern-EH-pattern C++. Funcref/externref catch operands (A4) remain on the not-yet-supported list — see [docs/fork-instrumentation.md §Not guaranteed](fork-instrumentation.md#not-guaranteed-unsupported-patterns). |

## Signals

| Function | Status | Notes |
|----------|--------|-------|
| `kill()` | Partial | Marks signal as pending. sig=0 validity check. Cross-process delivery via host_kill import and ProcessManager.deliverSignal(). Pending signals delivered at syscall boundaries. POSIX EPERM enforced: unprivileged processes cannot signal a target whose real/effective uid does not match their own. A virtual init (pid 1, uid 0) is auto-registered so `kill(1, ...)` resolves; target 4 in compromising-xfails.md. |
| `signal()` | Full | Legacy API. Returns previous handler. Wraps sigaction() semantics. SIGKILL/SIGSTOP immutable. |
| `sigaction()` | Full | Sets handler disposition (SIG_DFL, SIG_IGN, or function pointer) plus sa_flags and sa_mask. SIGKILL/SIGSTOP immutable. SA_RESTART supported: blocking read/write/recv/poll auto-restart instead of returning EINTR. SA_SIGINFO: flags passed to host so handler is called as `handler(signum, siginfo_ptr, ucontext_ptr)`. SA_NOCLDWAIT auto-reaps children and suppresses SIGCHLD. SA_NOCLDSTOP stored but not yet acted upon (no job control). SIG_IGN discards pending signals; SIG_DFL discards pending signals for signals whose default action is "ignore" (e.g., SIGCHLD). **Note:** Programs must be linked with `--table-base=3 --export-table` so the host can dispatch handlers from the user program's function table (indices 0/1 reserved for SIG_DFL/SIG_IGN, index 2 reserved for `__main_void`). |
| `sigprocmask()` | Full | Block/unblock/setmask operations on 64-bit signal mask. SIGKILL and SIGSTOP cannot be blocked per POSIX. |
| `sigsuspend()` | Full | Atomically replaces signal mask and blocks until deliverable signal arrives. Uses SharedArrayBuffer + Atomics.wait/notify for cross-thread wake. Always returns EINTR. |
| `pause()` | Full | Suspends until a signal is delivered. Delegates to sigsuspend with current mask. Always returns EINTR. |
| `raise()` | Full | Equivalent to kill(getpid(), sig). |
| `alarm()` | Full | Sets SIGALRM timer via host setTimeout. Returns previous remaining seconds. alarm(0) cancels. Not inherited by fork; preserved across exec. |
| `setitimer()` | Full | ITIMER_REAL: sets alarm deadline + interval via host_set_alarm. ITIMER_VIRTUAL/ITIMER_PROF: no-op (no CPU time tracking). Fixes musl's alarm() which internally calls setitimer. |
| `getitimer()` | Full | ITIMER_REAL: returns stored interval + remaining time from deadline. ITIMER_VIRTUAL/ITIMER_PROF: returns zero. |
| `sigtimedwait()` | Full | Checks pending signals in mask, dequeues lowest. Returns si_signo, si_code (SI_USER/SI_QUEUE), and si_value in siginfo_t. Polls with 1ms sleep on timeout. Returns EAGAIN on timeout. |
| `sigqueue()` / `rt_sigqueueinfo()` | Full | Sends signal with si_value. RT signals (32-63) are queued with FIFO ordering; standard signals (1-31) coalesced. si_code set to SI_QUEUE (-1). |
| `rt_sigreturn()` | Stub | Returns 0. Signal trampoline handled by host. |
| `signalfd()` / `signalfd4()` | Full | Creates a descriptor whose mask is held in a refcounted kernel-global backing, shared across inherited descriptors and retained by non-CLOEXEC exec. Reads return 128-byte `signalfd_siginfo` records for matching pending signals; poll readiness is supported. |

## Memory Management

| Function | Status | Notes |
|----------|--------|-------|
| `mmap()` | Partial | Anonymous, regular-file `MAP_PRIVATE`, and regular-file `MAP_SHARED` mappings use 64 KiB Wasm pages. `MAP_FIXED` replaces the complete rounded page range; a usable non-fixed hint is rounded down and preferred without replacing occupied mappings. Anonymous and regular-file shared mappings inherited by fork converge at syscall boundaries through a host-owned backing, not immediately on direct loads/stores. Regular-file sharing requires stable backend device/inode identity and retains the original open host handle, so mapping remains valid after the guest fd closes or its pathname is unlinked or renamed. In-kernel memfd and identity-less backends (currently OPFS) return `ENOTSUP` for `MAP_SHARED`; `MAP_PRIVATE` still works. Bytes beyond EOF are zero-filled/dropped instead of delivering Linux `SIGBUS`, and external host writers are not detected. |
| `msync()` | Partial | Publishes the calling process's changed bytes and writes dirty regular-file pages through the stable mapping handle; `MAP_PRIVATE` remains private. Writeback is clipped to the current file size and reports `EIO` on a coherence/writeback failure. `MS_SYNC` versus `MS_ASYNC` scheduling is not distinguished, and visibility between processes is not immediate between syscalls. |
| `shm_open()` / `shm_unlink()` | Partial | musl maps names to `/dev/shm/` files (with the Node/macOS host rewrite). The resulting regular-file `MAP_SHARED` mappings work across fork and independent fds at syscall boundaries, subject to the file-mapping, futex, and EOF limitations in this section. |
| `munmap()` | Full | Removes tracked regions. The address must be 64KB-page-aligned; the length is rounded up to the next Wasm page. Partial munmap supports front trim, back trim, and middle split, including matching host-side MAP_SHARED tracking. |
| `mremap()` | Partial | Supports page-rounded shrink, in-place growth, and `MREMAP_MAYMOVE`; other flags are rejected. The host moves/resizes matching anonymous and file-shared tracking and preloads a file expansion before the destructive kernel step. Wasm cannot revoke the old bytes after a move, just as `munmap()` cannot make later direct access fault. |
| `brk()` / `sbrk()` | Partial | Kernel-managed program break. Initial break installed by host from the program's `__heap_base` export via `kernel_set_brk_base` (16MB hardcoded fallback for binaries without `__heap_base`). Growing and shrinking supported. Inherited on `fork`; **reset** on `exec` and re-installed from the new program's `__heap_base` (POSIX-correct). |
| `mprotect()` | Partial | Wasm cannot enforce page protection on direct memory access. A successful write upgrade validates that an overlapping file-shared mapping has a lifetime-stable writable handle and marks the whole tracked interval writeback-eligible; that eligibility remains monotonic after a later downgrade. Other protection effects are not enforced. |
| `memfd_create()` | Full | In-kernel anonymous file backed by a refcounted global object whose contents and cursor survive fork/spawn and non-CLOEXEC exec. MFD_CLOEXEC and MFD_ALLOW_SEALING flags are supported. `MAP_PRIVATE` population works; `MAP_SHARED` deliberately returns `ENOTSUP` until memfd has a coherent mapping bridge. |

## Directory Operations

Pathname syscalls walk components in the kernel's global namespace before
dispatching the resolved path to rootfs, a host-backed mount, procfs, devfs, or
an AF_UNIX pathname. This preserves `.` and `..` until the preceding component
has been checked, follows relative and absolute symlinks across mount
boundaries, enforces the 40-link limit, and gives a trailing slash its required
directory semantics. Cwd and directory OFDs still retain canonical pathnames
rather than stable directory identities: rename/unlink followed by recreation
can therefore make `getcwd()`, `fchdir()`, or a dirfd-relative operation refer
to a different directory than the original OFD.

| Function | Status | Notes |
|----------|--------|-------|
| `opendir()` | Partial | Host-delegated via DirStream table. Entry-at-a-time iteration. Stores resolved path for rewinddir. |
| `readdir()` | Full | Returns WasmDirent (d_ino, d_type, d_namlen) + name buffer. Synthesizes "." and ".." entries before host entries. Tracks position for telldir/seekdir. |
| `closedir()` | Full | Frees DirStream slot, delegates to host. |
| `rewinddir()` | Full | Closes and reopens directory via stored path. Resets position to 0. |
| `telldir()` | Full | Returns current position counter from DirStream. |
| `seekdir()` | Full | Rewinds and skips entries to reach target position. |
| `mkdir()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. umask applied to mode. |
| `rmdir()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. |
| `chdir()` / `getcwd()` | Partial | `chdir()` resolves components and symlinks across mounts, verifies search permissions and a directory target, and stores the canonical physical pathname. Initial process cwd uses the same validation after child credentials are installed. `getcwd()` validates that spelling and returns ERANGE if the buffer is too small, but cwd remains pathname-backed rather than a stable directory identity after rename/unlink. |
| `link()` / `unlink()` | Partial | Host-delegated. Relative paths resolved via kernel cwd. |
| `rename()` | Partial | Host-delegated. Both paths resolved via kernel cwd. |
| `stat()` / `lstat()` | Partial | Host-delegated. stat follows symlinks, lstat does not. Registered AF_UNIX pathname sockets preserve the backing VFS inode's uid, gid, permissions, timestamps, and link count while reporting `S_IFSOCK`. |
| `chmod()` / `chown()` / `lchown()` | Partial | VFS metadata updates. `chown()` follows the final symlink; `lchown()` changes the link itself, including dangling links. Ownership calls preserve either unchanged-ID sentinel, validate the selected object and authorization before delegating even same-value requests, restrict actual changes to effective uid 0, and permit raw `(-1, -1)` only to the selected object's owner or root. Owner group changes and supplementary-group authorization remain incomplete. Node host-backed files receive native mode only at file/directory creation; later mode changes and all ownership changes stay virtual. Browser memory-backed mounts store metadata in the VFS. OPFS has neither symlinks nor ownership metadata, so its existing ownership operations are no-ops. |
| `access()` | Partial | Resolves the pathname component-wise and checks traversal plus target permissions with real credentials. `faccessat(..., AT_EACCESS)` selects effective credentials. Supplementary-group authorization remains incomplete. |
| `realpath()` | Full | Uses the global component walker against cwd, including mount crossings and relative or absolute symlinks; `missing/..` fails instead of being collapsed lexically, trailing slash requires a directory, and more than 40 symlinks returns ELOOP. |
| `symlink()` / `readlink()` | Partial | Host-delegated. Symlink target stored as-is, linkpath resolved. |
| `sync()` / `syncfs()` | Stub | Returns 0 (no-op). Filesystem sync managed by host. |
| `sync_file_range()` | Stub | Returns 0 (no-op). |
| `chroot()` | Stub | Returns EPERM. No filesystem namespace isolation. |
| `mount()` / `umount2()` | Stub | Returns EPERM. Future: VFS mount/unmount support. |
| `pivot_root()` | Stub | Returns EPERM. |
| `mknod()` / `mknodat()` | Partial | S_IFREG and S_IFIFO file types supported (creates regular file via host). Device nodes (S_IFCHR, S_IFBLK) return EPERM. |
| `quotactl()` | Stub | Returns ENOSYS. |
| `renameat2()` | Full | Delegates to renameat. Extra flags parameter ignored. |
| `faccessat2()` | Full | Delegates to faccessat. Extra flags parameter ignored. |
| `fchmodat2()` | Full | Delegates to fchmodat. Extra flags parameter ignored. |
| `getdents()` (legacy) | Full | Delegates to getdents64. |
| `name_to_handle_at()` / `open_by_handle_at()` | Stub | Returns ENOSYS. |

## Linux-Compatible Device Extensions

These interfaces are intentionally Linux-shaped rather than POSIX. They live
in the kernel because they are device and process-lifecycle contracts, not demo
shortcuts.

| Interface | Status | Notes |
|-----------|--------|-------|
| `/dev/dri/renderD128` | Partial | Render-node subset for `libdrm`, GBM, EGL, and GLES. GEM handles are fd-local. BO mmap offsets must come from `DRM_IOCTL_MODE_MAP_DUMB` on the same open file description. GLIO command buffers live in process memory and are unbound on `munmap`, `exec`, `exit`, and final fd close. |
| `/dev/dri/card0` | Partial | Single virtual KMS device with one connector, encoder, and CRTC. Supports dumb buffers, `ADDFB2`/`RMFB`, DRM master, `SET_CRTC`, `PAGE_FLIP`, vblank event reads, and host-provided mode info for the attached KMS canvas. Multi-head, real display probing, PRIME dma-buf fds, and hardware acceleration are out of scope for v1. |
| Sysroot graphics libraries | Partial | `scripts/build-musl.sh` builds `libdrm.a`, `libgbm.a`, `libEGL.a`, and `libGLESv2.a` into `sysroot/lib` with pkg-config files. Packages consume these via `wasm32posix-pkg-config`; the libraries are not standalone package outputs. |

## Socket Operations

| Function | Status | Notes |
|----------|--------|-------|
| `socket()` | Partial | AF_UNIX, AF_INET, and AF_INET6 support SOCK_STREAM and SOCK_DGRAM. SOCK_NONBLOCK and SOCK_CLOEXEC flags are handled. AF_INET6 is limited to local `::`/`::1` routes; external and virtual-network IPv6 transports are not implemented. AF_INET SOCK_DGRAM uses kernel queues for loopback and a HostIO backend for routed virtual IPv4; external raw UDP is not exposed directly to userspace. |
| `socketpair()` | Full | AF_UNIX SOCK_STREAM. Bidirectional ring buffers (64KB each). Returns pre-connected pair. |
| `bind()` | Partial | AF_UNIX pathname and Linux abstract-namespace addresses, AF_INET TCP host-backed bind/listen, and AF_INET UDP in-kernel bind for INADDR_ANY, loopback, and broadcast addresses. AF_UNIX pathname bind resolves to a canonical namespace path and creates a VFS inode with mode `0777 & ~umask`; `stat`/`lstat`/`fstatat`, `chmod`, and `chown` share that inode metadata, and the socket metadata remains until unlink after the final close. Ordinary pathname rename rekeys the socket registry, including replacement of a stale destination registration; hard-link identity is not tracked. Abstract addresses create no VFS inode and become reusable after their final inherited owner closes. AF_INET6 accepts `::` and `::1`; stream and datagram binds use machine-wide conflict tables, and a non-`IPV6_V6ONLY` wildcard stream bind also reserves the IPv4 wildcard port. The browser local virtual-network backend supports AF_INET TCP/UDP binds between attached Kandelo machines, not IPv6. |
| `listen()` | Partial | AF_INET TCP delegates to the active HostIO networking backend, including Node `net` and the browser local virtual-network backend. AF_UNIX stream listen is implemented. AF_INET, AF_INET6, and AF_UNIX listeners inherited by fork share one accept queue, so any surviving pre-fork worker can accept each connection once. AF_INET6 `::`/`::1` loopback listeners support same- and cross-process connections; external and virtual IPv6 listeners do not. Datagram listen rejects as unsupported. |
| `accept()` / `accept4()` | Partial | AF_INET TCP delegates to the active HostIO networking backend; AF_UNIX and AF_INET6 loopback streams return connected sockets from the shared kernel queue. A dual-stack IPv6 listener reports IPv4 peers as IPv4-mapped `sockaddr_in6`. Linux-style accept does not inherit O_NONBLOCK; accept4 applies SOCK_NONBLOCK and SOCK_CLOEXEC explicitly and rejects other flags before consuming a pending connection. Datagram accept rejects as unsupported. |
| `connect()` | Partial | AF_UNIX streams support same- and cross-process pathname or abstract-namespace listeners; pathname lookup uses the same canonical component walker as bind, including cross-process retries. AF_UNIX datagrams deliver to a registered peer only within the same process; a missing, wrong-type, or cross-process peer returns ECONNREFUSED until machine-wide datagram routing exists. AF_INET TCP is host-backed and works over Node external TCP or the browser local virtual-network backend. AF_INET UDP connect stores the peer, auto-binds an ephemeral local port when needed, filters receives to the connected peer, and supports AF_UNSPEC unconnect. AF_INET6 streams support same- and cross-process `::1`; AF_INET6 datagrams are process-local and report `IPV6_V6ONLY=1` because dual-stack datagram routing is not implemented. Non-loopback IPv6 fails with EADDRNOTAVAIL for streams and ENETUNREACH for datagrams. External raw UDP also returns ENETUNREACH without another HostIO transport. |
| `send()` / `recv()` | Partial | Unix domain streams and datagrams, AF_INET/AF_INET6 TCP streams, and connected AF_INET/AF_INET6 UDP preserve their socket-family addressing and datagram boundaries. TCP send/recv works over Node external TCP and the local virtual-network backend. Datagram MSG_PEEK and MSG_DONTWAIT are handled through recvfrom. Normal TCP close drains queued bytes before FIN and EOF; no transport invents a fixed post-FIN write count. A send rejected by a closed/reset stream returns EPIPE and raises SIGPIPE, while direct host/virtual handles may preserve ECONNRESET; accepted pipe-bridged resets currently surface as EOF/EPIPE. MSG_NOSIGNAL suppresses SIGPIPE without changing the errno. |
| `sendto()` / `recvfrom()` | Partial | AF_INET, AF_INET6, and AF_UNIX datagrams support connected and unconnected send, receive queues, and connected-peer filtering. IPv4/IPv6 return sender addresses; AF_UNIX currently returns only the family. IPv4 limited-broadcast sends to `255.255.255.255` require `SO_BROADCAST` and fail with `EACCES` without it; enabling the option passes that permission gate, after which the send reaches the active routing/backend boundary. Kandelo does not itself model broadcast delivery. On AF_INET, AF_INET6, and AF_UNIX datagrams, Linux's input `MSG_TRUNC` extension returns the full datagram length while copying at most the caller's buffer; ordinary consume/`MSG_PEEK` behavior is unchanged. IPv4/IPv6 UDP receive queues hold 128 datagrams and drop a new arrival once full, preserving the accepted queue's order; `SO_RCVBUF` requests do not size that fixed queue, and `getsockopt` reports the fixed default capacity. AF_UNIX uses the same bound but preserves reliable delivery: a full queue blocks a blocking send through host retry and returns EAGAIN for `O_NONBLOCK`/`MSG_DONTWAIT`; capacity, association, shutdown, close, and pathname changes wake blocked sends and writable readiness waits to observe capacity or the new immediate error. In-kernel IPv4/IPv6 loopback, AF_UNIX datagram, and IPv4 multicast delivery currently reaches sockets in the sender's process only; machine-wide cross-process datagram routing remains unimplemented. Fork preserves kernel-local bind reservations and lookup ownership, but it does not yet share or transfer a host-backed UDP registration. The `10.88.*` LocalVirtualNetwork path can route IPv4 datagrams between attached Kandelo machines through HostIO for the process that registered the endpoint. IPv4 multicast supports interface selection, loop suppression, membership, and source filtering only; IPv6 multicast and external raw UDP are not implemented. |
| `sendmsg()` / `recvmsg()` | Partial | Minimal first-iovec wrappers are implemented. Input `MSG_TRUNC` reaches the datagram receive behavior above, but `recvmsg()` does not yet populate output `msg_flags`, including `MSG_TRUNC`. |
| `setsockopt()` / `getsockopt()` | Partial | SOL_SOCKET exposes SO_TYPE, SO_DOMAIN, SO_ERROR, SO_ACCEPTCONN, SO_RCVBUF, and SO_SNDBUF; SO_REUSEADDR affects UDP bind conflicts. `SO_RCVBUF`/`SO_SNDBUF` requests are accepted and stored but do not resize kernel queues or pipe buffers; `getsockopt()` reports the fixed default. `SO_BROADCAST` controls only the IPv4 limited-broadcast permission gate and does not provide broadcast delivery. SO_LINGER uses `struct linger`; its disabled form is stored, while enabling timed or reset-style linger returns EOPNOTSUPP until every transport supports the close mode. SO_BINDTODEVICE validates `lo`/`eth0`, supports empty-name unbind, and constrains bind/connect/send routing. TCP_CONGESTION uses a string layout and accepts only the modeled `cubic` policy; selecting unimplemented algorithms fails. IPv4 multicast membership/source-filter options drive process-local loopback delivery. IPV6_V6ONLY controls pre-bind stream dual-stack behavior; AF_INET6 datagrams truthfully remain V6-only. Other accepted IPv6 multicast options are stored but do not provide IPv6 multicast transport. |
| `shutdown()` | Partial | SHUT_RD, SHUT_WR, and SHUT_RDWR transitions are idempotent within a process and release each owned pipe/host reference once. UDP write shutdown returns EPIPE on datagram send; read shutdown is EOF-like for recv/poll. Sending to a read-shut AF_UNIX datagram peer returns EPIPE (and SIGPIPE unless MSG_NOSIGNAL is used), and the transition wakes blocked sends/readiness waits. Fork-inherited sockets still clone shutdown flags per process instead of sharing one socket-wide shutdown state, and the external host ABI has no half-shutdown operation. |
| `select()` | Partial | Wrapper around poll(). Converts fd_set bitmasks to pollfd array. Timeout supported via a host retry loop. A caught signal interrupts a would-block retry, including the no-fd sleep path, with EINTR; ignored signals leave it parked and a concurrently ready result is preserved. |
| `poll()` | Partial | Checks readiness for regular files, pipes, and sockets. UDP poll reports queued datagrams, connected-peer filtering, EOF-like read shutdown, write-shutdown hangup, and pending socket errors. Timeout supported via polling loop with 1ms sleep intervals. Returns EINTR on pending signals. |
| `ppoll()` | Full | Wraps poll() with atomic signal mask swap: save → set → poll → restore. Timespec converted to timeout_ms in glue layer. |
| `pselect6()` | Partial | Wraps select() with an atomic signal-mask swap across the host retry loop. The pselect6-style `{sigset_t *, size_t}` argument supplies the mask; timeout precision is rounded to host milliseconds. Caught signals interrupt a would-block retry with EINTR after the temporary mask is restored. |
| `epoll_create1()` | Full | Creates epoll instance with per-process interest list. EPOLL_CLOEXEC flag supported. |
| `epoll_ctl()` | Full | EPOLL_CTL_ADD, EPOLL_CTL_MOD, EPOLL_CTL_DEL. Stores interest set with events + data. |
| `epoll_pwait()` | Full | Builds pollfd from interest set, delegates to poll, maps results back to epoll_event structs. Optional signal mask swap. |
| `epoll_create()` / `epoll_wait()` | Full | Legacy aliases. epoll_create ignores size param. epoll_wait delegates to epoll_pwait with null sigmask. |
| `sendmmsg()` / `recvmmsg()` | Stub | Returns ENOSYS. |

## Time

| Function | Status | Notes |
|----------|--------|-------|
| `time()` | Full | Wrapper around clock_gettime(CLOCK_REALTIME). Returns seconds since epoch. |
| `gettimeofday()` | Full | Wrapper around clock_gettime(CLOCK_REALTIME). Returns (sec, usec) pair. |
| `clock_gettime()` | Partial | Host-delegated. `CLOCK_REALTIME` and `CLOCK_MONOTONIC` are supported. Linux `CLOCK_REALTIME_COARSE` and `CLOCK_MONOTONIC_COARSE` requests use the corresponding host clock as an equivalent fallback because Kandelo hosts do not expose separate coarse sources. `CLOCK_BOOTTIME` is a monotonic-equivalent fallback because Kandelo hosts do not expose suspend accounting. The process/thread CPU clocks currently report elapsed monotonic time rather than authoritative CPU usage. Linux-style encoded process CPU clock IDs must be negative; malformed positive encodings are rejected with `EINVAL` (which musl's `clock_getcpuclockid()` maps to `ESRCH`). Node.js uses `Date.now()` and `process.hrtime.bigint()`; browsers use `Date.now()` and `performance.now()`. |
| `nanosleep()` | Partial | Host-delegated. Node.js uses Atomics.wait with timeout. Browser support requires a worker context that can block with Atomics.wait. Validates tv_sec >= 0 and tv_nsec < 1e9. |
| `usleep()` | Full | Converts microseconds to sec+nsec, delegates to host_nanosleep. |
| `clock_settime()` | Stub | Returns EPERM. Cannot set system clock from Wasm. |
| `settimeofday()` | Stub | Returns EPERM. Cannot set system clock from Wasm. |
| `adjtimex()` / `clock_adjtime()` | Stub | Returns EPERM. Cannot adjust system clock from Wasm. |
| `utimes()` | Full | Converts timeval to timespec, delegates to utimensat. |
| `futimesat()` | Full | Like utimes but relative to dirfd. Delegates to utimensat. |

## Scheduler

| Function | Status | Notes |
|----------|--------|-------|
| `sched_getparam()` | Stub | Writes sched_priority=0. Single-threaded Wasm has no scheduling policy. Returns EPERM when the caller's effective uid doesn't match the target's. |
| `sched_setparam()` | Stub | Returns 0 (no-op). Returns EPERM for cross-user targets. |
| `sched_getscheduler()` | Stub | Returns 0 (SCHED_OTHER). Returns EPERM for cross-user targets. |
| `sched_setscheduler()` | Stub | Returns 0 (no-op). Returns EPERM for cross-user targets. |
| `sched_get_priority_max()` | Stub | Returns 0. |
| `sched_get_priority_min()` | Stub | Returns 0. |
| `sched_rr_get_interval()` | Stub | Writes 10ms timespec. |
| `sched_setaffinity()` | Stub | Returns 0 (no-op). |
| `sched_getaffinity()` | Stub | Sets bit 0 in cpuset (1 CPU). Returns cpuset size. |
| `sched_yield()` | Stub | Returns 0 (no-op, single-threaded). |

## Event/Notification

| Function | Status | Notes |
|----------|--------|-------|
| `eventfd()` / `eventfd2()` | Full | A refcounted kernel-global u64 counter is shared by inherited descriptors across fork/spawn and survives exec unless CLOEXEC. read returns the counter (or 1 for EFD_SEMAPHORE); write adds to it. EFD_NONBLOCK/EFD_CLOEXEC and poll readiness are supported. |
| `timerfd_create()` | Full | Creates a refcounted kernel-global timerfd backing with CLOCK_REALTIME or CLOCK_MONOTONIC. Inherited descriptors observe the same timer and expiration count; non-CLOEXEC state survives exec. TFD_NONBLOCK and TFD_CLOEXEC are supported. |
| `timerfd_settime()` / `timerfd_gettime()` | Full | Arms/disarms the shared timerfd backing with interval and initial expiration. TFD_TIMER_ABSTIME is supported; read returns the shared expiration count and poll reports POLLIN when expired. |
| `inotify_init()` / `inotify_init1()` | Stub | Returns ENOSYS. |
| `inotify_add_watch()` / `inotify_rm_watch()` | Stub | Returns EBADF. |
| `fanotify_init()` / `fanotify_mark()` | Stub | Returns ENOSYS. |
| `timer_create()` | Partial | `CLOCK_REALTIME`, `CLOCK_MONOTONIC`, and monotonic-equivalent `CLOCK_BOOTTIME`, with `SIGEV_SIGNAL` or `SIGEV_NONE`. `SIGEV_THREAD` and Linux-specific `SIGEV_THREAD_ID` return `ENOTSUP`. The timer syscall carries a 32-bit `sival_int`; wasm64 pointer-valued `sigev_value` is not supported. |
| `timer_settime()` / `timer_gettime()` | Partial | Absolute (TIMER_ABSTIME) and relative timers and automatic interval rearming use host timers with millisecond granularity. `timer_gettime()` and `timer_settime()`'s old-value result currently report the last configured value rather than decreasing remaining time. |
| `timer_getoverrun()` | Full | Tracks overrun count when signal is still pending at next interval fire. Reset on successful signal delivery. |
| `timer_delete()` | Full | Cancels timer and removes from per-process table. |

## IPC (System V & POSIX Message Queues)

| Function | Status | Notes |
|----------|--------|-------|
| `msgget()` / `msgsnd()` / `msgrcv()` / `msgctl()` | Full | Host-side SysV message queues via SharedIpcTable. Key-based creation, blocking send/recv with message types, IPC_STAT/IPC_SET/IPC_RMID control. |
| `semget()` / `semop()` / `semctl()` / `semtimedop()` | Full | Host-side SysV semaphore sets. Atomic multi-semaphore operations, SEM_UNDO support, IPC_STAT/SETVAL/GETVAL/SETALL/GETALL. |
| `shmget()` / `shmat()` / `shmdt()` / `shmctl()` | Partial | Host-side SysV shared-memory segments support IPC_STAT/IPC_RMID, fork inheritance, and exact attach/detach accounting. Separate process memories merge changed attachment bytes and import peer changes at syscall boundaries. Direct stores are not immediately visible and cross-process futex synchronization over an attachment is unsupported. |
| `ftok()` | Full | Standard ftok algorithm using stat inode + proj_id. |
| `mq_open()` / `mq_close()` / `mq_unlink()` | Full | Host-side POSIX message queues via PosixMqueueTable. O_CREAT/O_EXCL/O_RDONLY/O_WRONLY/O_RDWR/O_NONBLOCK. Descriptor range 0x40000000+. |
| `mq_timedsend()` / `mq_timedreceive()` | Full | Priority-ordered message delivery. Blocking with timeout support. O_NONBLOCK returns EAGAIN. |
| `mq_notify()` | Full | SIGEV_SIGNAL notification on message arrival to empty queue. One registration per queue. |
| `mq_getattr()` / `mq_setattr()` | Full | Get/set queue attributes (mq_flags, mq_maxmsg, mq_msgsize, mq_curmsgs). |

## Extended Attributes

| Function | Status | Notes |
|----------|--------|-------|
| `getxattr()` / `setxattr()` / `removexattr()` / `listxattr()` | Stub | Returns ENOSYS. Extended attributes not supported by host filesystem abstraction. |
| `lgetxattr()` / `lsetxattr()` / `lremovexattr()` / `llistxattr()` | Stub | Returns ENOSYS. |
| `fgetxattr()` / `fsetxattr()` / `fremovexattr()` / `flistxattr()` | Stub | Returns ENOSYS. |

## Terminal / TTY

| Function | Status | Notes |
|----------|--------|-------|
| `isatty()` | Full | Returns 1 for CharDevice, PtyMaster, and PtySlave fds; ENOTTY for others. |
| `tcgetattr()` / `tcsetattr()` | Full | Full termios support on CharDevice and PTY fds. c_iflag, c_oflag, c_cflag, c_lflag, c_cc. TCSANOW/TCSADRAIN/TCSAFLUSH all treated the same. ICANON mode: line buffering with VERASE (backspace), VKILL (^U), VEOF (^D) editing. ICRNL/INLCR/IGNCR input processing. ECHO/ECHOE/ECHOK/ECHONL output. VMIN/VTIME values accessible for raw mode. Uses musl's 60-byte termios layout. |
| `ioctl()` | Full | 16 terminal ioctls: TCGETS/TCSETS/TCSETSW/TCSETSF (termios), TIOCGPTN (PTY number), TIOCSPTLCK (unlock PTY), TIOCGPGRP/TIOCSPGRP (foreground pgid), TIOCGWINSZ/TIOCSWINSZ (window size + SIGWINCH), TCSBRK/TCXONC/TCFLSH, TIOCGSID/TIOCSCTTY/TIOCNOTTY (session/controlling terminal). Generic: FIONREAD, FIONBIO, FIOCLEX/FIONCLEX, FIOASYNC. Works on CharDevice, PtyMaster, and PtySlave fds. |
| `posix_openpt()` | Full | Opens `/dev/ptmx`, allocates PTY pair, returns master fd. |
| `grantpt()` / `unlockpt()` | Full | `grantpt()` is a no-op (no permissions to set). `unlockpt()` clears the lock flag on the PTY pair. |
| `ptsname()` | Full | Returns `/dev/pts/N` path for the slave side. |
| `ttyname()` | Full | Via `/proc/self/fd/N` readlink on PTY slave fds. |
| `tcgetsid()` | Full | Via TIOCGSID ioctl. Returns session ID of the controlling terminal. |
| `tcgetpgrp()` / `tcsetpgrp()` | Full | Via TIOCGPGRP/TIOCSPGRP ioctls. Gets/sets foreground process group. |

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
| `/dev/tty` | Partial | Uses the first open PTY-slave OFD as the current controlling-terminal heuristic. When none is open, it currently falls back to fd 0 rather than returning ENXIO; `pathconf()` follows that same OFD selection and therefore does not advertise terminal variables for the captured, pipe-backed case. |
| `/dev/ptmx` | Full | PTY master multiplexer. `open()` allocates a new PTY pair, returns master fd. |
| `/dev/pts/*` | Full | PTY slave devices. `posix_openpt()` + `grantpt()` + `unlockpt()` + `ptsname()`. Full line discipline, canonical/raw mode, OPOST/ONLCR, 16 terminal ioctls. |
| `/dev/fb0` | Full | Linux fbdev framebuffer. Single-open (`EBUSY` for second opener). 640×400 BGRA32 packed-pixel. ioctls: `FBIOGET_VSCREENINFO`, `FBIOGET_FSCREENINFO`, `FBIOPAN_DISPLAY` (no-op success), `FBIOPUT_VSCREENINFO` (validates geometry). `mmap` returns a region in process memory and notifies the host (`bind_framebuffer` callback) so the browser canvas can mirror pixels. `munmap`/`exit`/`exec` discard the image mapping; a surviving fd retains device ownership across exec. Ownership is released after both the final fd and any live mapping are gone, since a mapping remains valid after `close()`. Linux-VT keyboard ioctls (`KDGKBTYPE`/`KDGKBMODE`/`KDSKBMODE`) accepted with sensible defaults so fbDOOM-style software works unmodified. |
| `/dev/input/mice` | Full | Linux `mousedev` PS/2 mouse stream. Single-open (`EBUSY` for second pid). 3-byte packets: byte0 button bits + sign/overflow flags, bytes 1..2 signed dx/dy with positive-up dy. Host pushes events via `kernel_inject_mouse_event(dx, dy, buttons)`; the kernel buffers up to 4096 packets (whole-packet drop on overflow). `read()` drains queued bytes; returns `EAGAIN` when empty. `poll()` reports `POLLIN` only when bytes are queued. Ownership and queued packets survive exec with a non-CLOEXEC fd; last close or exit releases and clears them. No IMPS/2 wheel protocol, no `evdev`/`/dev/input/eventN`. |
| `/dev/dsp` | Full (write-only) | OSS-style PCM audio sink. Single-open (`EBUSY` for second pid). `write()` accepts interleaved 16-bit-LE PCM and buffers it in a 256 KiB ring; the host drains via the `kernel_drain_audio` wasm export and feeds a Web Audio `AudioContext`. ioctls: `SNDCTL_DSP_RESET`, `SNDCTL_DSP_SYNC`, `SNDCTL_DSP_SPEED` (clamp 4000–192000 Hz), `SNDCTL_DSP_STEREO` / `SNDCTL_DSP_CHANNELS` (1 or 2), `SNDCTL_DSP_SETFMT` (only `AFMT_S16_LE`), `SNDCTL_DSP_GETFMTS`, `SNDCTL_DSP_SETFRAGMENT` (accept-and-acknowledge). On overflow drops the *oldest whole frame* — never tears L/R alignment. Ownership and queued samples survive exec with a non-CLOEXEC fd; last close or exit releases and flushes them. `read()` returns 0 (EOF-like). `poll()` reports `POLLOUT` always, never `POLLIN`. No record path, no `mmap`-based zero-copy; DOOM's mixer is in user space. |
| `/dev/shm/*` | Partial | POSIX shm objects are regular files used by `shm_open()`. Stable-identity backends support host-coordinated `MAP_SHARED` across processes at syscall boundaries; this is not immediate shared linear memory and does not make process-shared futexes work. |

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
| `uname()` | Full | Returns sysname="wasm-posix", nodename="localhost", release="1.0.0", version="kandelo", machine="wasm32". 5 x 65-byte null-terminated strings. |
| `sysconf()` | Partial | Handles _SC_CHILD_MAX, _SC_CLK_TCK=100, _SC_PAGE_SIZE=65536, _SC_OPEN_MAX=1024, _SC_NPROCESSORS_ONLN=1, _SC_NPROCESSORS_CONF=1, _SC_MONOTONIC_CLOCK=1, _SC_THREAD_SAFE_FUNCTIONS=1, plus 100+ POSIX.1-2024 constants via musl overlay. Unknown names return EINVAL. |
| `umask()` | Full | Set file creation mask, returns previous mask. Default 0o022. Applied in open() and mkdir(). Masked to 0o777. |
| `getrlimit()` | Full | Returns (soft, hard) resource limits. Defaults: NOFILE=(1024,4096), STACK=(8MB,infinity), others infinity. |
| `setrlimit()` | Partial | Sets resource limits and validates soft <= hard. RLIMIT_NOFILE updates the fd-table ceiling. RLIMIT_FSIZE covers regular-file and memfd write/pwrite, vectored, transfer, truncate, and mode-0 fallocate paths with partial-to-limit results and thread-directed SIGXFSZ only when no byte can be written. Other resource limits remain advisory or unsupported. |
| `getrusage()` | Partial | Returns zeroed rusage struct (144 bytes). RUSAGE_SELF and RUSAGE_CHILDREN supported. No actual resource tracking in Wasm. |
| `pathconf()` | Partial | Resolves the real namespace path and queries the selected backend. The common resolver enforces byte-based `_PC_NAME_MAX=255`, `_PC_PATH_MAX=4096` for caller and symlink-substituted pathnames (including the terminating NUL), and `_PC_NO_TRUNC=1`; a relative pathname is not charged for the process's internal absolute CWD prefix. `_PC_CHOWN_RESTRICTED=1` reflects the kernel authorization gate. Regular files report thread-backed AIO support. Symlink and timestamp answers reflect the backend (HostFS/MemoryFS timestamps are millisecond-granularity; OPFS reports indeterminate). Invalid names and unsupported file-type associations return EINVAL; valid indeterminate or unsupported options return -1 without changing errno. |
| `fpathconf()` | Partial | Uses the live OFD/backend identity rather than a remembered pathname, so renamed or unlinked open files remain queryable. Invalid fds return EBADF. Kernel pipes report `_PC_PIPE_BUF=4096`; host-backed captured stdio leaves it indeterminate because atomicity through that boundary is not yet proven. Terminal buffers are currently unbounded, `_PC_VDISABLE=0`, and socket maximum buffering is indeterminate. |
| `getsockname()` | Partial | Returns stored local addresses for AF_UNIX and AF_INET/AF_INET6 stream or datagram sockets. UDP ephemeral ports, loopback/INADDR_ANY binds, and accepted INADDR_ANY connect outcomes are covered by Sortix UDP tests. External-route local address selection remains unsupported without a HostIO networking backend. |
| `getpeername()` | Full | Returns stored peer address for connected sockets. Returns ENOTCONN for unconnected. |

---

## Known POSIX Gaps

Systematic audit of all subsystems against POSIX specifications. Gaps are categorized by severity and actionability.

### Critical — Violates POSIX semantics, causes incorrect behavior

| Gap | Subsystem | Description |
|-----|-----------|-------------|
| **fork siblings have independent ordinary-file OFD metadata** | fork / fd | POSIX requires the parent and child descriptors to refer to one open file description. Kandelo now retains exact global backings for pipes, sockets, PTYs, eventfd/timerfd/signalfd, memfd, and procfs snapshots, but it still deep-copies ordinary regular-file seek positions, status flags, and owners with the per-process `OfdTable`. Workloads that coordinate through one inherited regular fd can therefore observe divergent offsets or flags. The global-OFD redesign remains tracked in [future-improvements.md](future-improvements.md). |

### High — Missing features that affect common programs

| Gap | Subsystem | Description |
|-----|-----------|-------------|
| **EINTR partially implemented** | all | read, write, recv, poll, select return EINTR when a signal is pending during a blocking wait. close() and other non-blocking syscalls do not check. Tied to signal handler invocation gap. |
| **PIPE_BUF guarantee at host-backed stdio boundary** | pipe / host | In-kernel pipes guarantee atomic writes through 4096 bytes and report that value from `fpathconf()`. Captured stdio uses host-backed pipe OFDs; its callback/native-write boundary has not been proven all-or-nothing through the compile-time `PIPE_BUF` value, so `fpathconf()` reports the limit as indeterminate. Do not treat the global `<limits.h>` promise as fully reconciled until that boundary is enforced or stdio is modeled differently. |
| ~~**O_APPEND not atomic**~~ | write | **Resolved.** Syscalls are serialized through the kernel, so seek-to-end + write cannot be interrupted by another process. |
| ~~**sigaction() missing sa_flags**~~ | signals | **Resolved.** SA_RESTART supported (auto-restart blocking syscalls). sa_flags and sa_mask stored. SA_SIGINFO handler delivery with siginfo_t. SA_NOCLDWAIT auto-reaps children. SA_NOCLDSTOP accepted but not acted upon (no job control). |
| ~~**No signal queuing**~~ | signals | **Resolved.** RT signals (32-63) are now queued in a VecDeque; standard signals (1-31) remain coalesced per POSIX. |
| ~~**`*at()` functions with real dirfd**~~ | filesystem | **Resolved.** All *at() syscalls now support real dirfd via stored OFD paths. |
| ~~**No seekdir/telldir/rewinddir**~~ | directory | **Resolved.** DirStream now tracks path and position. rewinddir/telldir/seekdir implemented. |

### Medium — Spec deviations with limited practical impact

| Gap | Subsystem | Description |
|-----|-----------|-------------|
| ~~**RLIMIT_FSIZE partial enforcement**~~ | rlimits | **Resolved for implemented write and size-changing operations.** Scalar, vectored, host-chunked, transfer, regular-file, memfd, truncate, and mode-0 fallocate paths share one operation-boundary contract. Pipes, terminals, sockets, and other non-size-bearing objects remain unaffected. |
| **setpgid() self-only** | process | Only supports setting own pgid. Setting another process's pgid returns ESRCH. |
| ~~**realpath() no symlink resolution**~~ | filesystem | **Resolved.** Now resolves symlinks via iterative lstat/readlink with ELOOP after 40 resolutions. |
| **Socket options partially no-op** | socket | `SO_REUSEADDR` affects UDP bind conflicts, and `SO_BROADCAST` enforces the IPv4 limited-broadcast permission gate, but actual broadcast delivery remains unavailable. `SO_RCVBUF` and `SO_SNDBUF` are accepted/stored without resizing queues or pipe buffers; `getsockopt()` reports the fixed default. `SO_KEEPALIVE`, `SO_RCVTIMEO`, `SO_SNDTIMEO`, and `TCP_NODELAY` remain accepted/stored with limited or no data-path effect. Enabled `SO_LINGER` is rejected rather than stored as a no-op. |
| **POLLERR partial** | I/O multiplex | poll() reports UDP pending socket errors and stream shutdown/error cases. Some edge cases remain implementation-defined. |
| **pread/pwrite not multi-process safe** | I/O | Uses save/seek/read/restore pattern — safe only when no other process shares the OFD, but races with shared OFDs across processes. |
| ~~**brk not inherited on fork**~~ | memory | **Resolved.** Program break serialized/deserialized in fork state. (`exec` reset is intentional per POSIX; host re-installs from new program's `__heap_base`.) |
| ~~**VMIN/VTIME not interpreted**~~ | terminal | **Partially resolved.** VMIN/VTIME values accessible via TerminalState methods. Full VMIN/VTIME read semantics for raw mode are approximated. |
| ~~**ICANON no line buffering**~~ | terminal | **Resolved.** ICANON mode now buffers input with line editing: VERASE (backspace), VKILL (^U), VEOF (^D). ICRNL/INLCR/IGNCR input processing and ECHO/ECHOE/ECHOK/ECHONL echo handling. |
| ~~**No job control**~~ | terminal | **Partially resolved.** tcgetpgrp()/tcsetpgrp() implemented via TIOCGPGRP/TIOCSPGRP ioctls. SIGTTIN/SIGTTOU not yet generated. |
| ~~**readdir() "." and ".." entries**~~ | directory | **Resolved.** Kernel now synthesizes "." and ".." entries before host entries. |
| **No ENFILE** | fd | Only per-process EMFILE limit exists. No system-wide fd limit tracking. |

### Wasm-Inherent — Gaps that cannot be fully resolved in Wasm

| Gap | Subsystem | Reason |
|-----|-----------|--------|
| **mprotect() is a no-op** | memory | Returns success but does not enforce. Wasm linear memory has no page-level protection. |
| **No immediate cross-process shared-memory or futex semantics** | memory | Anonymous, SysV, and stable-identity regular-file shared mappings now merge and refresh across processes at syscall boundaries. They are not one physical linear memory: direct stores remain private until a syscall, a peer spinning only on loads sees no update, and futex WAIT/WAKE targets only the caller's process `SharedArrayBuffer`. Process-shared pthread locks and PHP opcache's normal shared-memory locking model therefore remain unsupported. The PHP package rejects its normal SHM mode and supports only explicitly configured `opcache.file_cache_only=1`; otherwise FPM workers would observe divergent cache and lock state. memfd `MAP_SHARED`, current OPFS file mappings, Linux `SIGBUS` on access beyond EOF, and detection of external host writes also remain gaps. |
| **External raw UDP routes** | socket | AF_INET SOCK_DGRAM has POSIX-style in-kernel loopback/virtual semantics, but browsers cannot expose raw UDP and Node raw UDP is not yet wired behind HostIO. Non-loopback UDP routes currently return ENETUNREACH unless a future host backend/proxy handles them. |
| **Setuid/setgid enforcement** | process | Single-user Wasm environment; privilege checks simulated only. |
| **Permission checks** | filesystem | Delegated to host. Kernel does not independently verify file permissions. |
| **getrusage() zeroed** | sysinfo | No actual resource tracking available in Wasm. Returns zero-filled struct. |
| **ucontext API unsupported** | process | `makecontext()`, `swapcontext()`, `getcontext()`, `setcontext()` are userspace stack-switching primitives. Supporting them would require `wasm-fork-instrument`-style compile-time instrumentation extended to general stack-switching for every program that uses them — we already do this narrowly for `fork()` (see [fork-instrumentation.md](fork-instrumentation.md) and `plans/2026-04-20-fork-instrumentation-design.md`), but generalising the same machinery to ucontext multiplies the instrumentation surface for a feature **deprecated in POSIX.1-2008** and effectively unused in modern code. Programs needing coroutines implement their own at the runtime level (Erlang/BEAM, Ruby fibers, Python `greenlet`). |

### Future Work — Remaining items

**Threading:**
- `clone()` — CLONE_VM|CLONE_THREAD: kernel allocates TID, host spawns thread Worker sharing parent's Memory. TLS initialization via `__wasm_thread_init` export.
- `gettid()` — returns actual TID for threads, pid for main thread
- `set_tid_address()` — stores tidptr; kernel writes 0 + futex-wakes on thread exit (CLONE_CHILD_CLEARTID)
- `futex()` — WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAKE_OP are implemented within one process; cross-process waits/wakes remain unsupported even over a coordinated shared mapping
- `pthread_create` — works via clone(). Basic pthreads tested (mutex, join). Normal thread return, `pthread_exit`, and cancellation cleanup are per-thread; uncaught fatal Wasm traps in a pthread worker are process-fatal and visible to parent `waitpid()` as signal termination. Cancellation remains limited; see the Wasm-inherent gaps below.

**Hard / Architectural:**
- Immediate cross-process MAP_SHARED visibility and process-shared futexes (would require one addressable shared backing or an equivalent wake protocol across process workers)
- True async poll/select (replace polling loop with host-based event notification)
- SA_NOCLDSTOP behavior (the flag is stored but stop notifications/job control are not implemented)
- Full VMIN/VTIME raw mode semantics (timer-based timeout)

**Shared-kernel advantages (already free):**
- O_APPEND atomicity (serialized syscalls)
- PIPE_BUF atomicity (serialized syscalls)
- Cross-process pipe/socket/PTY and eventfd/timerfd/signalfd/memfd/procfs backing identity across inherited descriptors
- Signal delivery across processes is direct

---

## Environment-Specific Tradeoffs

Some POSIX APIs have different implementation strategies depending on the host environment. This section documents those tradeoffs.

### SharedArrayBuffer Required

These features require SharedArrayBuffer (and cross-origin isolation headers in browsers):

| Feature | With SAB | Without SAB |
|---------|----------|-------------|
| Blocking syscalls | `Atomics.wait()` — true blocking | Not supported without a worker/blocking bridge |
| `fcntl()` locking | Kernel-coordinated via atomic ops | postMessage round-trip, higher latency |
| `pipe()` blocking read | Blocks worker until data available | Not supported without a worker/blocking bridge |
| `nanosleep()` | `Atomics.wait()` with timeout | Not supported without a worker/blocking bridge |
| Multi-process shared memory | Host-coordinated merge/import at syscall boundaries; not direct shared pages or cross-process futexes | Not supported without the worker/channel SAB runtime |

### Browser vs Node.js

| Feature | Node.js | Browser |
|---------|---------|---------|
| File I/O | Native `fs` module for data and creation modes; VFS-only post-creation mode/ownership metadata | OPFS (limited), fetch (read-only), or virtual FS |
| `fork()` | `worker_threads` — feasible | Web Workers — feasible but different API |
| `Atomics.wait()` on main thread | Works | Throws — must use workers |
| Network sockets | TCP via `net` backend plus in-kernel/virtual UDP; raw external UDP not yet wired behind HostIO | Local virtual TCP/UDP works between browser Kandelo machines; external networking still requires WebSocket/WebRTC/proxy backends because browsers expose no raw sockets |
| Process signals | `process.on('SIGINT', ...)` | Not available |
| stdin | `process.stdin` | Requires custom input mechanism |

---

## Implementation Priority

1. **Phase 1 (Complete):** File descriptors & basic I/O — open, close, read, write, lseek, dup, dup2, pipe, fstat, fcntl (flags)
2. **Phase 2 (Complete):** Directory operations — stat, lstat, mkdir, rmdir, unlink, link, symlink, readlink, rename, chmod, chown, access, opendir, readdir, closedir, chdir, getcwd
3. **Phase 3a (Complete):** Process identity & lifecycle — getpid, getppid, getuid/geteuid, getgid/getegid, exit/_exit
3b. **Phase 3b (Deferred):** Multi-process — fork, exec, waitpid (requires multi-worker architecture)
4. **Phase 4 (Complete):** Signals — kill, raise, sigaction, sigprocmask. Signal delivery mechanism deferred.
5. **Phase 5 (Complete):** fcntl locking — F_GETLK, F_SETLK, F_SETLKW with byte-range granularity
6. **Phase 6 (Complete):** Sockets & I/O multiplexing — socket, socketpair, shutdown, send/recv, getsockopt/setsockopt, poll, epoll. AF_INET TCP via host-backed networking (Node `net` and browser local virtual network). AF_INET UDP is partial: in-kernel loopback/local virtual datagrams are implemented; external raw UDP remains a HostIO/backend task.
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
13e. **Phase 13e (historical milestone complete; current conformance remains Partial):** Exec
- In-place centralized exec: CLOEXEC filtering, signal disposition reset, pending-queue preservation
- Legacy kernel_get_exec_state / kernel_init_from_exec Wasm exports (scheduled for ABI cleanup)
- host_exec Wasm import and sys_execve syscall
- Worker re-initialization against the continuing centralized kernel Process
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
| ~~`flock()` syscall~~ | file locking | **Done.** Mapped to fcntl F_SETLK/F_SETLKW internally. LOCK_SH, LOCK_EX, LOCK_UN, LOCK_NB all supported. | ~~Medium~~ |
| ~~`/dev/urandom` virtual device~~ | VFS | **Done.** `/dev/urandom` and `/dev/random` intercept in kernel, delegate to `host_getrandom()` → `crypto.getRandomValues()`. | ~~Easy~~ |
| ~~`getrandom()` syscall~~ | random | **Done.** Host-delegated to `crypto.getRandomValues()`. | ~~Easy~~ |
| ~~`putenv()` syscall~~ | environment | **Done.** Parses `KEY=VALUE` string, delegates to setenv. | ~~Easy~~ |
| ~~Virtual device files in VFS~~ | VFS | **Done.** `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/full`, `/dev/fd/N`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` all handled in-kernel. | ~~Medium~~ |
| ~~`initgroups()` stub~~ | process | **Done.** musl's initgroups() calls setgroups(), which is a no-op stub. | ~~Easy~~ |

### Phase B — Networking (enables WordPress HTTP requests + MySQL)

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| ~~`connect()` for AF_INET~~ | socket | **Done.** Host-delegated TCP networking. bind/listen/accept/connect/send/recv all functional. Node.js backend uses `net` module; browser backend uses fetch for HTTP. | ~~Hard~~ |
| ~~`getaddrinfo()` / `gethostbyname()`~~ | DNS | **Done.** Host-delegated via `host_getaddrinfo` import. Returns AF_INET sockaddr_in. `/etc/hosts` is served from the canonical `rootfs.vfs` mount at `/` for localhost resolution. | ~~Medium~~ |
| ~~`setsockopt()` expansion~~ | socket | **Done.** SO_KEEPALIVE, TCP_NODELAY, SO_REUSEADDR, disabled SO_LINGER state, and many more are represented; enabled SO_LINGER remains explicitly unsupported. | ~~Easy~~ |
| ~~Async socket polling bridge~~ | socket | **Done.** poll/select/epoll all work with socket fds. The kernel checks readiness inline. | ~~Medium~~ |

### Phase C — Process management (enables wp-cli, Composer, PHPUnit)

| Gap | Subsystem | Description | Difficulty |
|-----|-----------|-------------|------------|
| ~~Guest-initiated `fork()`~~ | process | **Done.** fork() works as a kernel syscall. Children re-execute from `_start` with forked state. Cross-process pipes and signals functional. | ~~Hard~~ |
| ~~**Guest-initiated `exec()`**~~ | process | **Done.** exec() wired as SYS_EXECVE (syscall 211). Host `handleExec` reads path/argv/envp from process memory, calls `onExec` callback. Fork+exec tested. | ~~Hard~~ |
| ~~Blocking pipe reads with timeout~~ | pipe | **Done.** Pipes support blocking reads/writes with EINTR on signal delivery. O_NONBLOCK returns EAGAIN. | ~~Medium~~ |

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
| **JSPI or promise-driven bridge** | Could work on main thread in future designs | Requires a different host/runtime contract and does not cover fork continuation |

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
- Multi-process: fork (kernel syscall), exec (host-initiated), waitpid (kernel syscall)
- Networking: AF_INET TCP (connect, bind, listen, accept, send, recv), getaddrinfo
- Dynamic linking: dlopen, dlsym, dlclose, dlerror (Wasm dylink)
- POSIX timers: partial `SIGEV_SIGNAL`/`SIGEV_NONE` timer_create, timer_settime,
  timer_gettime, timer_delete. The PHP package imports a cooperative Wasm host
  hook because native `SIGEV_THREAD_ID` delivery is unavailable; that package
  cannot instantiate until the corresponding host-runtime hook lands in the
  same platform batch.
- System info: uname, sysconf, umask, getrlimit/setrlimit

---

## Continuous Testing: musl libc-test Suite

The full musl libc-test suite (functional + regression + math) is run via `scripts/run-libc-tests.sh`. Use `--report` to generate `docs/libc-test-failures.md`.

### Summary (as of 2026-04-04)

All tests pass (0 unexpected failures). XFAIL (expected failures) and TIME (timeouts) are acceptable. Run `scripts/run-libc-tests.sh` for current results.

### Known Unfixable Failures

These require features fundamentally unavailable in the Wasm architecture:

- **Wasm FP exceptions (110 math tests):** WebAssembly has no floating-point exception flags (`fenv.h`). All `fe*` math tests fail. `long double` variants pass because they use software fp128.
- **No pthread_cancel:** Wasm has no async cancellation mechanism or cancel-point assembly. `pthread_create` works; `pthread_cancel` does not.
- **No dlopen/TLS:** `tls_get_new-dtv_dso` requires loading a shared library with TLS at runtime.

### Linker Requirements for Signal Handlers

Programs must be linked with two extra flags for signal handler dispatch to work:

- `--table-base=3`: Reserves function table indices 0 (SIG_DFL), 1 (SIG_IGN), and 2 (`__main_void` wrapper) so they don't collide with real C function pointers.
- `--export-table`: Exports `__indirect_function_table` so the host can look up handler functions to call them.

### C++ exception support

C++ programs that throw exceptions work end-to-end (commit `9482326ef`).
Itanium-EH unwinding uses LLVM `libunwind` statically bundled into
`libc++abi.a` via the libcxx package (`packages/registry/libcxx/`,
`LIBCXXABI_USE_LLVM_UNWINDER` + `LIBCXXABI_STATICALLY_LINK_UNWINDER_IN_STATIC_LIBRARY`),
so consumers link `-lc++ -lc++abi` and `_Unwind_*` resolves internally —
no separate `-lunwind`. clang must be invoked with `-fwasm-exceptions`;
without it catch handlers are dead-code-eliminated and `throw` hangs.

Regression gate: `programs/cpp_throw_test.cpp` exercises throw → catch
in a single program; `host/test/cpp-throw-test.test.ts` runs it via the
kernel harness. The gap was first surfaced by the SpiderMonkey EH
spike (see external `memory/spidermonkey-spike-eh-toolchain-gap.md`).
