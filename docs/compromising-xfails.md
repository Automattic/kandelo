# Compromising XFAILs

XFAIL entries in the test suites that reflect **real kernel-functionality gaps** — not wasm limits, soft-float precision, or test bugs. Each one blocks a class of POSIX software from running without patches. Fixing any target here makes more real-world software runnable.

This file is the counterpart to [wasm-limitations.md](wasm-limitations.md), which documents failures that are genuinely unfixable in wasm. If you're triaging an XFAIL, check there first — only items that *could* be implemented end up here.

## Targets

### 1. Guest-initiated `pthread_create`

**Gap:** musl's `pthread_create` entry point isn't wired to `sys_clone`. Only kernel-initiated threads (via the host `onClone` callback invoked from inside `sys_clone`) work today — MariaDB's 5 threads, for example. Programs that call `pthread_create` directly from guest code fail.

**Affected tests:**
- libc-test: `pthread_cancel`, `pthread_cond_wait-cancel_ignored`, `pthread_create-oom`, `raise-race`
- sortix basic: `pthread/pthread_create`, `pthread/pthread_cancel`, `pthread/pthread_cleanup_pop`, `pthread/pthread_cleanup_push`, `pthread/pthread_setcancelstate`, `signal/pthread_kill`, `threads/thrd_create`
- sortix basic AIO: `aio/aio_error`, `aio/aio_fsync`, `aio/aio_read` (musl AIO internally creates pthreads)

**Fix approach:** Wire musl's `pthread_create` to issue `sys_clone(CLONE_VM|CLONE_THREAD|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID)` with a pthread-style stack and entry. The kernel's `sys_clone` + host `onClone` already spin up a worker with its own channel + TLS; what's missing is the glue from the pthread API to that syscall. See PR #88 for the existing clone-based threading path.

**Starting files:**
- `musl-overlay/src/thread/wasm32posix/clone.c` — existing clone glue
- `glue/channel_syscall.c` — syscall dispatcher
- `crates/kernel/src/syscalls.rs` — `sys_clone` and fork handling
- `host/src/kernel-worker.ts` — `onClone` host callback
- `musl/src/thread/pthread_create.c` — reference implementation (what we need to override or adapt)

Related: `pthread_cancel` additionally needs `__syscall_cp_asm` (see wasm-limitations.md §2) — partial support is possible without cancel points.

---

### 2. `munmap` real page unmapping

**Gap:** `munmap` is effectively a no-op. Wasm linear memory can't have holes punched in it at the VM level. Programs that unmap a region and expect dereferencing it to fault (stack guard pages, JIT scratch regions, memory sanitizers) don't see the expected SIGSEGV.

**Affected tests:**
- POSIX: `munmap/1-1`, `munmap/1-2`
- libc-test: covered by the fork-mmap serialization logic, but no direct test

**Fix approach:** Simulate at the kernel/glue layer. Kernel tracks "unmapped" address ranges; a validator runs on guest accesses to raise SIGSEGV synthetically. Detection options:
- Instrument loads/stores at wasm-opt time to check against a range table (expensive).
- Use `mprotect`-style flag bits in a shadow page table and validate in memcpy/memset/read/write glue (only catches syscall-path accesses).
- Accept partial support: guarantee fault-on-access only through syscalls, document that direct pointer deref won't fault.

Likely partial at best, but even syscall-path validation would unblock some test suites.

**Starting files:**
- `crates/kernel/src/syscalls.rs` — `sys_mmap`, `sys_munmap`
- `host/src/memory-manager.ts` — MemoryManager (mmap range tracking)
- `glue/channel_syscall.c` — memcpy/read/write paths that could validate

---

### 3. `PTHREAD_PROCESS_SHARED`

**Gap:** pthread sync primitives (mutex, cond, rwlock, barrier) with `PTHREAD_PROCESS_SHARED` attribute aren't supported. `pthread_mutexattr_setpshared(attr, PTHREAD_PROCESS_SHARED)` returns `ENOTSUP` or silently succeeds but the primitive doesn't actually synchronize across processes.

**Affected tests:**
- sortix basic: `pthread/pthread_barrierattr_setpshared`, `pthread/pthread_condattr_setpshared`, `pthread/pthread_mutexattr_setpshared`

**Fix approach:** Kernel-side shared sync structures, addressable by shm key or mapped filename. Similar pattern to SysV semaphores (see `crates/kernel/src/ipc.rs`). The mutex itself lives in kernel state, not in shared wasm memory; syscalls serialize lock/unlock. Less urgent — multi-process coordination today uses SysV IPC, pipes, or file locks.

**Starting files:**
- `crates/kernel/src/ipc.rs` — SysV sem_* precedent
- `musl-overlay/src/thread/wasm32posix/pthread_mutex_init.c`
- `musl-overlay/src/thread/wasm32posix/pthread_mutexattr_setprotocol.c` (similar ENOTSUP gate pattern)

---

### 4. Multi-user permission model (EPERM)

**Gap:** No uid/gid access-control model. Every process runs as the same effective user. Syscalls that are supposed to return EPERM when acting on a process owned by a different user (`kill(pid_of_root, ...)` from a non-root process) don't.

**Affected tests:**
- POSIX: `kill/2-2`, `kill/3-1`, `sched_getparam/6-1`, `sched_getscheduler/7-1`

**Fix approach:** Track `uid/euid/gid/egid` per process in the kernel `Process` struct. Enforce permission checks on cross-process operations (kill, sched_setparam, ptrace, etc.). Provide `setuid/setgid/seteuid/setegid` syscalls. A minimal `/etc/passwd` in the VFS makes `getpwnam` work (target 5 below).

**Starting files:**
- `crates/kernel/src/process.rs` — Process struct (add uid/gid fields)
- `crates/kernel/src/syscalls.rs` — `sys_kill`, `sys_sched_*`, add `sys_setuid/setgid`
- `glue/channel_syscall.c` — syscall plumbing

---

### 5. `pwd.h` / passwd database

**Gap:** `getpwnam`, `getpwuid`, and passwd-database parsing don't have any entries to return. Not strictly a kernel gap — it's VFS content plus musl's NSS wiring.

**Affected tests:**
- POSIX: `mlock/12-1`, `sigqueue/3-1`, `sigqueue/12-1` (listed as needs-pwd.h in current XFAIL comments)

**Fix approach:** Ensure musl's `getpwnam`/`getpwuid` implementations are linked (they read `/etc/passwd`). Populate a minimal `/etc/passwd` in the default VFS image:
```
root:x:0:0:root:/root:/bin/sh
nobody:x:65534:65534:nobody:/:/sbin/nologin
```
And a matching `/etc/group`. Low-risk change — pure userspace + VFS.

**Starting files:**
- `host/src/filesystem/` — VFS population
- `scripts/build-programs.sh` or `build.sh` — where default VFS entries get seeded
- `musl/src/passwd/` — reference for what `getpwnam` expects

---

## Not compromising (documented for completeness)

These XFAILs are **not** kernel-functionality gaps — don't put effort into them:

| XFAIL class | Why |
|---|---|
| 14 math tests (`acosh`, `asinh`, `j0`, …) | Soft-float 1-2 ULP precision, no hardware FE_*. Wasm limit — see [wasm-limitations.md §3](wasm-limitations.md). |
| `malloc-brk-fail`, `malloc-oom`, `setenv-oom` | OOM semantics differ in wasm linear memory. Can't reproduce real OOM. |
| `pthread_cancel` cancel-point subset | Needs `__syscall_cp_asm` — no wasm equivalent. |
| `tls_get_new-dtv` | DTV management across dlopened modules. Out of scope. |
| `strings/ffsll` (sortix) | Wasm32 test bug: `long` (32-bit) vs `long long` (64-bit) constant mismatch. |
| `devctl/*` (sortix) | Sortix-specific syscall, not in musl. |
| `sched_get_priority_max/min` 1-3 (POSIX SKIP) | Requires SCHED_SPORADIC, essentially unused. |

---

## How to prompt a new session to work on a target

Paste one of the following into a fresh Claude Code session in this repo:

**Short form:**
> Work on target N from `docs/compromising-xfails.md`. Check the current status of the affected tests, read the fix approach, and attempt the fix. Branch → tests → PR → merge.

**Expanded form (recommended):**
> I want to close target N from `docs/compromising-xfails.md`. Before writing any code:
> 1. Read the target section in full.
> 2. Run the relevant test suite to confirm the XFAILs still reproduce (`scripts/run-libc-tests.sh` / `scripts/run-posix-tests.sh` / `scripts/run-sortix-tests.sh --all`).
> 3. Read the starting files listed in the target.
> 4. Propose an approach and flag any trade-offs.
>
> Then implement: create a branch, write the change, run all 5 test suites (cargo / vitest / libc-test / POSIX / sortix), open a PR, and merge via PR. Don't push to main. If the XFAIL now passes, move it off the expected-fail list in the relevant `scripts/run-*-tests.sh`.

**For each target specifically:**

- **Target 1** (pthread_create): "Wire musl pthread_create through sys_clone. PR #88 already did the kernel side."
- **Target 2** (munmap unmapping): "Prototype partial munmap-fault simulation — syscall-path validation only is acceptable."
- **Target 3** (PROCESS_SHARED): "Implement kernel-side shared pthread primitives. Model after `crates/kernel/src/ipc.rs`."
- **Target 4** (EPERM / multi-user): "Add uid/gid to Process struct. Enforce on kill/sched_*. Provide setuid/setgid."
- **Target 5** (pwd database): "Seed /etc/passwd + /etc/group in the default VFS image. Not kernel work."
