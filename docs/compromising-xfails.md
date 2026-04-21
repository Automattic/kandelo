# Compromising XFAILs

XFAIL entries in the test suites that reflect **real kernel-functionality gaps** — not wasm limits, soft-float precision, or test bugs. Each one blocks a class of POSIX software from running without patches. Fixing any target here makes more real-world software runnable.

This file is the counterpart to [wasm-limitations.md](wasm-limitations.md), which documents failures that are genuinely unfixable in wasm. If you're triaging an XFAIL, check there first — only items that *could* be implemented end up here.

## Targets

### 1. Guest-initiated `pthread_create` — *basic path landed*

**Status:** basic `pthread_create` + `thrd_create` now pass. The remaining tests listed here fail for other reasons (cancel-point asm, per-thread signal routing, AIO). Separate targets below cover those.

**Closed tests:** sortix `pthread/pthread_create`, `threads/thrd_create`.

**Still blocked (other gaps):**
- `pthread_cancel`, `pthread_cleanup_pop/push`, `pthread_setcancelstate`, `pthread_cond_wait-cancel_ignored`: need `__syscall_cp_asm` cancel points (see [wasm-limitations.md](wasm-limitations.md) §2).
- `signal/pthread_kill`, `raise-race` (flakey): need per-thread signal routing. Today `pthread_kill` delivers to the process, not the target thread.
- `aio/aio_error`, `aio/aio_fsync`, `aio/aio_read`: musl's AIO internally spawns pthreads, but also needs a real AIO implementation.
- `pthread_create-oom`: wasm linear memory can grow on demand, so `t_memfill` can't reliably exhaust address space.

**Root cause (fixed):** `__NR_exit_group` was aliased to `__NR_exit` (both = 34) in the wasm syscall headers. When a non-main thread called `exit()` / `_Exit()` → `SYS_exit_group`, it emitted syscall 34. The host's channel dispatcher saw syscall 34 from a non-main channel and ran the *thread-exit* path (remove channel only), leaving the main process worker to spin forever. Tests that called `exit(0)` from a spawned thread therefore hung.

**Fix:**
- `musl-overlay/arch/wasm{32,64}posix/bits/syscall.h.in`: give `__NR_exit_group` its own number (387, matching what `host/src/kernel-worker.ts` already expected).
- `crates/kernel/src/wasm_api.rs`: dispatch 387 → `kernel_exit` alongside 34.
- `host/src/node-kernel-worker-entry.ts`: on process exit, terminate surviving thread workers so they don't linger after their parent is gone.

Backward compatible — old user binaries still emit syscall 34 for exit_group and get the existing (main-only) behavior; no `ABI_VERSION` bump required.

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

- **Target 1** (pthread_create): Basic path landed — see the status block in section 1. Remaining sub-gaps (cancel-point asm, per-thread signal routing, AIO, OOM) are separate follow-ups.
- **Target 2** (munmap unmapping): Reclassified to [wasm-limitations.md §6](wasm-limitations.md) — the `munmap/1-*` XFAILs are unfixable in stock wasm. Only pursue Option A (syscall-path EFAULT validation) if defensive hardening against use-after-munmap via syscalls becomes a priority; it will not close the XFAILs.
- **Target 3** (PROCESS_SHARED): "Implement kernel-side shared pthread primitives. Model after `crates/kernel/src/ipc.rs`."
- **Target 4** (EPERM / multi-user): "Add uid/gid to Process struct. Enforce on kill/sched_*. Provide setuid/setgid."
- **Target 5** (pwd database): "Seed /etc/passwd + /etc/group in the default VFS image. Not kernel work."
