# Compromising XFAILs

XFAIL entries in the test suites that reflect **real kernel-functionality gaps** — not wasm limits, soft-float precision, or test bugs. Each one blocks a class of POSIX software from running without patches. Fixing any target here makes more real-world software runnable.

This file is the counterpart to [wasm-limitations.md](wasm-limitations.md), which documents failures that are genuinely unfixable in wasm. If you're triaging an XFAIL, check there first — only items that *could* be implemented end up here.

## Targets

### 1. Guest-initiated `pthread_create` — *basic path + deferred cancellation landed*

**Status:** basic `pthread_create` + `thrd_create` pass. Deferred cancellation (pthread_cancel, cleanup handlers, setcancelstate, cond_wait-cancel) is now implemented — see below. The remaining tests listed here fail for other reasons (per-thread signal routing, AIO, async-only cancel).

**Closed tests (2026-04-21, deferred cancellation):**
- sortix `pthread/pthread_cancel`, `pthread/pthread_cleanup_pop`, `pthread/pthread_cleanup_push`, `pthread/pthread_setcancelstate`
- libc-test `pthread_cond_wait-cancel_ignored`

**How deferred cancellation works:** Stock musl dispatches cancellation-point syscalls through `__syscall_cp_asm` + SIGCANCEL (interrupt the syscall, rewrite the PC to `__cp_cancel`). Wasm has neither signal-based preemption nor PC rewrite, so we implement deferred cancellation on the guest side and a one-shot wake syscall on the host side:

- `musl-overlay/src/thread/wasm32posix/pthread_cancel.c` provides `pthread_cancel`, `__cancel`, `__testcancel`, and `__syscall_cp_check` (the moral equivalent of `__syscall_cp_asm` + `__syscall_cp_c` in one function). The overlay reuses musl's existing per-thread `pthread_t->cancel` atomic field as the pending-cancel flag — no new channel slot or TLS global needed.
- `musl-overlay/src/thread/wasm32posix/pthread_testcancel.c` strips the weak `dummy __testcancel` alias so wasm-ld can't accidentally pull the weak over our strong definition.
- `glue/channel_syscall.c::__syscall_cp` calls `__testcancel()` before each cancellation-point syscall and `__syscall_cp_check(r)` after, handling the three cancel states (ENABLE → pthread_exit, MASKED → synthesize -ECANCELED, DISABLE → pass-through) the way stock musl's asm does.
- `pthread_cancel(t)` atomically sets `t->cancel = 1` and issues a new `SYS_THREAD_CANCEL` syscall so the host can wake a blocked target. The host (`kernel-worker.ts::handleThreadCancel`) notifies any in-flight futex wait (via `Atomics.notify` on the futex address), clears pipe/poll/select retry registrations, and arms a `pendingCancels` flag so a wait that hasn't entered its blocking state yet still short-circuits with -EINTR on entry.
- `SYS_THREAD_CANCEL = 415` is a new host-handled syscall number; this PR bumps `ABI_VERSION` to 4 because the kernel/guest contract now depends on it.

**Async cancellation (`PTHREAD_CANCEL_ASYNCHRONOUS`) is out of scope.** Wasm cannot preempt a running thread mid-computation, so a target that never enters a cancellation-point syscall cannot be cancelled. The libc-test `pthread_cancel` functional test (which starts with an async-cancel + busy-loop subcase) therefore remains XFAIL — its deferred-cancel subcases would pass, but there is no harness-level partial PASS.

**Still blocked (other gaps):**
- libc-test functional `pthread_cancel`: first subcase uses `PTHREAD_CANCEL_ASYNCHRONOUS` + busy loop (see the async-cancel note above). Subsequent deferred-cancel subcases would pass, but the harness reports a whole-test failure.
- Sortix `pthread/pthread_setcanceltype` was previously listed here as out-of-scope (it does try `PTHREAD_CANCEL_ASYNCHRONOUS`), but in practice the compiler dead-code-eliminates its busy loop and the worker returns quickly enough that deferred cancellation still produces `PTHREAD_CANCELED` from `pthread_join`. Unxfail'd 2026-04-22.
- `pthread_create-oom`: **not a kernel gap** — see "Not compromising" table below. The kernel correctly caps address space and `pthread_create` returns `EAGAIN` when `mmap` fails; the test's `t_memfill` setup sequence (specifically the `while (malloc(1));` drain) doesn't terminate within the 30 s timeout in our 1 GiB wasm arena.

**Closed:**
- `signal/pthread_kill`, `raise-race`: **per-thread signal routing landed.** `ThreadInfo` now carries its own pending/blocked/rt_queue; `tkill`/`tgkill` deliver to the target thread's directed queue; `pthread_sigmask` / `sigsuspend` / `ppoll` / `pselect` / `sigtimedwait` all operate on the calling thread's state via `kernel_set_current_tid`.

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

### 6. Per-thread signal masks (blocks AIO and `pthread_kill`) — *CLOSED*

**Status (landed in this PR):** Per-thread `blocked` / `pending` / `rt_queue` now live on `ThreadInfo`. `kernel_set_current_tid` lets `sigprocmask`, `sigsuspend`, `ppoll`, `pselect6`, `sigtimedwait` operate on the calling thread's state. `tkill`/`tgkill` write into the target thread's directed pending queue rather than the shared process queue. `ABI_VERSION` bumped to 4 (new kernel exports — see `abi/snapshot.json`).

**Closed tests:** libc-test `regression/raise-race` (previously flakey XFAIL; now passes — timing-slow so it can appear as `TIME` on heavily-loaded runs, still acceptable per `CLAUDE.md`), sortix `signal/pthread_kill`, sortix `basic/aio/aio_fsync`, sortix `basic/aio/aio_read`, sortix `basic/aio/aio_error` (after `sys_pread` / `sys_pwrite` reject negative offsets with `EINVAL`, 2026-04-22 — the test's `aio_write(offset=-9000)` used to surface the host's seek error as `EIO`).

The original gap analysis (preserved below for the historical record) matches what was landed.

**Gap:** `SignalState` in `crates/kernel/src/signal.rs` is per-process — `blocked` and `pending` are shared across all threads in a process. POSIX requires each thread to have its own signal mask. This single-mask model is load-bearing for signal-heavy code like musl's AIO and `pthread_kill`.

**Affected tests:**
- sortix basic: `aio/aio_error`, `aio/aio_fsync`, `aio/aio_read`, `signal/pthread_kill`, `signal/raise-race` (flakey).

**Spike results (2026-04-21, branch `aio-spike`):**

The previous XFAIL comment said AIO was blocked on guest `pthread_create`. That blocker is gone (PR #325 / target 1 above): AIO worker threads spawn and run their `pread`/`pwrite`/`fsync` calls correctly, and `rt_sigqueueinfo` from the worker does set the pending bit for SIGUSR1 on the shared process signal state.

What breaks is delivery. Traced flow on `aio_read` test:

1. Main blocks SIGUSR1, calls `aio_read`, enters `sigsuspend(&oldset)` → EAGAIN retry loop.
2. AIO worker thread runs. Before and after `pread`, musl calls `sigprocmask` to block/restore *all* signals ("All aio worker threads run with all signals blocked permanently" — `src/aio/aio.c`).
3. Because the kernel's mask is process-wide, these `sigprocmask` calls overwrite the main thread's temp sigsuspend mask.
4. Worker calls `rt_sigqueueinfo(getpid(), SIGUSR1, ...)` → kernel raises SIGUSR1 → `pending |= 0x200`, `action = Handler(3)`, state stays `Running` (good).
5. On the worker's **next** syscall completion, the host runs `dequeueSignalForDelivery(worker_channel)`. `kernel_dequeue_signal` sees SIGUSR1 is pending and (from the worker's perspective) deliverable under the now-unblocked process mask, so it dequeues it and writes delivery info into the *worker's* channel `CH_DATA`. The worker's glue then runs the `SIGUSR1` handler inside the worker thread.
6. Main's sigsuspend keeps retrying with `pending=0x0` forever; alarm(1) fires; test exits with 128+SIGALRM=142.

Verified by adding `debug_log` calls in `kernel_kill_with_value`, `sys_sigsuspend`, and `sys_sigprocmask`:

```
[k] kill_wv after: pending=0x200 result=0 action=Handler(3)
[k] kill_wv post-deliver: pending=0x200 state=Running
[ks] syscallNr=208 off=<worker>  -- rt_sigreturn on worker
[k] sigprocmask how=2 ... pending_before=0x0   ← pending cleared between the two lines
[k] sigsuspend: mask=0x0 blocked=0x0 pending=0x0 deliverable=0x0  ← main never sees it
```

If the caller inserts even a short `nanosleep` between `aio_read` and `sigsuspend`, SIGUSR1 gets delivered correctly to main because main is running at the moment delivery picks a thread. Sortix's test has no such delay, so it's the realistic failure mode.

**Fix approach:**

1. Move `blocked` and `sigsuspend_saved_mask` off `SignalState` / `Process` and onto `ThreadInfo` (or a new per-thread slot keyed by `(pid, tid)`). Keep `pending` and `rt_queue` process-wide — signals are generated at the process, not the thread.
2. `get_process()` plus the current channel must surface the *current thread*, so that `sys_sigprocmask` / `sys_sigsuspend` / `sys_rt_sigpending` read-and-write the caller's own `blocked` mask. Centralized mode already threads `channel.pid` through `kernel_set_current_pid`; add a similar `set_current_tid` and read it in those syscalls.
3. Signal delivery logic (`kernel_dequeue_signal`, `deliver_pending_signals`) must pick a thread whose `blocked` mask does *not* block the signal, with a preference for a thread currently parked in `sigsuspend`/`sigtimedwait`/`pselect6`/`ppoll` on that signal. Today we just dequeue into whichever channel next completes a syscall — that's what sends the AIO signal to the worker.
4. `sys_pthread_kill(tid, sig)` should target a specific thread's pending queue rather than the process-wide queue.
5. Fork: a single thread survives fork; only that thread's mask is inherited. Existing code resets the process mask on fork (`kernel_reset_signal_mask`) — needs to become per-thread.

Non-trivial refactor. Estimated ~600–900 LoC across `signal.rs`, `process.rs`, `wasm_api.rs`, `syscalls.rs`, plus matching host-side `currentHandleTid` plumbing in `kernel-worker.ts`. All existing tests that exercise the single-threaded path must continue to pass — the main thread's mask semantics are load-bearing for nginx, PHP-FPM, MariaDB signal handling, etc.

**Starting files:**
- `crates/kernel/src/signal.rs` — `SignalState` split: per-thread (`blocked`, saved masks) vs per-process (`pending`, `rt_queue`, `actions`).
- `crates/kernel/src/process.rs` — `ThreadInfo` struct: add `blocked`, `sigsuspend_saved_mask`, per-thread alt-stack depth (already multi-thread capable?).
- `crates/kernel/src/wasm_api.rs` — sigprocmask/sigsuspend/rt_sigpending must look up the current thread; `kernel_dequeue_signal` must choose a thread whose mask permits the signal.
- `host/src/kernel-worker.ts` — add `currentHandleTid` alongside `currentHandlePid`; plumb it into `set_current_tid` before every `kernel_handle_channel` call.
- Reference: `host/src/kernel-worker.ts` line ~4869 (`callbacks.onClone(..., channel.memory)`) — thread channels are already per-tid; the channel→tid mapping is the hook to add.

**Why AIO does not need its own target.** Once per-thread masks work, stock musl AIO passes the three sortix tests unmodified. No AIO-specific code is required in our kernel. Any attempt to "implement AIO natively" (kernel io_uring shim, etc.) would be wasted effort — the bug is strictly in the signal subsystem.

---

## Not compromising (documented for completeness)

These XFAILs are **not** kernel-functionality gaps — don't put effort into them:

| XFAIL class | Why |
|---|---|
| 14 math tests (`acosh`, `asinh`, `j0`, …) | Soft-float 1-2 ULP precision, no hardware FE_*. Wasm limit — see [wasm-limitations.md §3](wasm-limitations.md). |
| `malloc-brk-fail`, `malloc-oom`, `setenv-oom` | OOM semantics differ in wasm linear memory. Can't reproduce real OOM. |
| `pthread_create-oom` | `pthread_create` itself correctly returns `EAGAIN` — verified empirically: after `t_vmfill` exhausts the ~1 GiB address-space cap, `mmap` of the stack region fails and musl's `__pthread_create` translates that to `EAGAIN`. A standalone variant of the test that drops the `t_memfill` preamble and invokes `pthread_create` directly after exhausting mmap space passes. The XFAIL is caused by `t_memfill`'s `while (malloc(1));` drain, which is meant to exhaust "libc reserves": on Linux with a small address space this returns `NULL` quickly, but with our 1 GiB wasm cap mallocng has enough pre-mapped small-slab space that the drain keeps returning non-NULL for billions of iterations — long past the 30 s per-test timeout, so the harness kills the test before it ever reaches the `pthread_create` call. Lowering `--max-memory` does not help: caps below 1 GiB collide with `MMAP_BASE` (64 MiB) and make the drain hang even sooner, while 1 GiB is required for the test program itself to load. No kernel change would fix this — the kernel's memory cap and `pthread_create` path are already correct; the test encodes a host-OS assumption that doesn't hold in wasm. |
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
