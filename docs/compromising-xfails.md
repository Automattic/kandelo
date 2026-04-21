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

**Status (2026-04-21):** Reclassified as a fundamental wasm limitation — see [wasm-limitations.md §6](wasm-limitations.md). The two XFAIL tests (`munmap/1-1`, `munmap/1-2`) dereference a pointer directly (`*ch = 'a'`) after `munmap` and expect SIGSEGV. Wasm linear memory cannot revoke page access once a page has been in-bounds, and no syscall is involved in the failing step, so kernel-side validation cannot flip these to PASS.

This entry is retained below as **optional future hardening work**, not as an XFAIL-closing target. No currently ported software depends on SIGSEGV-on-deref after `munmap`.

**Affected tests (still XFAIL, will remain so):**
- POSIX: `munmap/1-1`, `munmap/1-2` — direct-access tests; unfixable in stock wasm
- libc-test: none directly

**Option A — syscall-path EFAULT validation (optional hardening).** Track unmapped ranges in `Process.memory` after `sys_munmap`. In syscalls that take user pointers (`read`, `write`, `readv`, `writev`, `pread`, `pwrite`, `send*`/`recv*`, `getrandom`, …), validate each pointer+length against the poisoned range table and return `EFAULT` if it lands in an unmapped range — matching Linux's `-EFAULT` behavior for invalid userspace pointers.

- **Benefit:** catches use-after-munmap bugs that reach a syscall (e.g., a library calls `read(fd, freed_buf, n)` into a just-freed arena). Lays infrastructure for future sanitizer-style tooling.
- **Cost:** ~300–500 LoC across `crates/kernel/src/memory.rs` and `syscalls.rs`, plus O(log N) per-syscall lookup on pointer arguments. Does **not** flip `munmap/1-*` to PASS — they dereference directly, not via syscall.
- **When to do it:** Only if a real workload hits use-after-munmap via a syscall, or if defensive hardening becomes a priority. Not currently justified.

**Starting files (if Option A is pursued):**
- `crates/kernel/src/memory.rs` — add a "poisoned ranges" structure separate from the live-mmap range list
- `crates/kernel/src/syscalls.rs` — add `validate_user_ptr(proc, addr, len)` helper; call from each pointer-taking syscall
- `glue/channel_syscall.c` — no changes expected; validation stays kernel-side

**Future wasm-platform path to real fix.** If a wasm proposal ships that permits page-level protection (current candidates: Memory Control `memory.protect`, or Multi-memory combined with compiler fat-pointer support), `munmap/1-*` can be revisited as a real target. See [wasm-limitations.md §6](wasm-limitations.md) for the platform-side analysis.

---

### 3. `PTHREAD_PROCESS_SHARED` — pthread primitives only (DONE). Shared data memory still a gap.

**Status:** Pthread sync primitives (mutex, cond, barrier) with `PTHREAD_PROCESS_SHARED` are now implemented in `crates/kernel/src/pshared.rs`. `pthread_mutexattr_setpshared` and `pthread_barrierattr_setpshared` tests pass. `pthread_condattr_setpshared` remains XFAIL because the test uses `MAP_SHARED|MAP_ANONYMOUS` to share a `state` variable across fork and our wasm model gives each process its own linear memory — a separate architectural gap, not a pthread issue.

**Affected tests still XFAIL:**
- sortix basic: `pthread/pthread_condattr_setpshared`

**To fully close this test:** implement cross-process shared memory for `MAP_SHARED|MAP_ANONYMOUS` after fork. Not trivial: each wasm process has its own `WebAssembly.Memory`; direct loads/stores can't be intercepted without wasm instrumentation. One viable angle is to sync specific shared-region ranges on every syscall (lazy coherence), but that's architecturally significant and out of scope for the pthread-primitives target.

**Starting files (for the remaining gap):**
- `crates/kernel/src/syscalls.rs` — `sys_mmap` (where `MAP_SHARED|MAP_ANONYMOUS` currently falls through to private)
- `host/src/memory-manager.ts` — per-process mmap tracking
- `crates/kernel/src/fork.rs` — fork memory snapshot

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
- **Target 2** (munmap unmapping): Reclassified to [wasm-limitations.md §6](wasm-limitations.md) — the `munmap/1-*` XFAILs are unfixable in stock wasm. Only pursue Option A (syscall-path EFAULT validation) if defensive hardening against use-after-munmap via syscalls becomes a priority; it will not close the XFAILs.
- **Target 3** (PROCESS_SHARED): "Implement kernel-side shared pthread primitives. Model after `crates/kernel/src/ipc.rs`."
- **Target 4** (EPERM / multi-user): "Add uid/gid to Process struct. Enforce on kill/sched_*. Provide setuid/setgid."
- **Target 5** (pwd database): "Seed /etc/passwd + /etc/group in the default VFS image. Not kernel work."
