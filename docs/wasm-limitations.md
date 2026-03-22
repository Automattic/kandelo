# Fundamental WebAssembly Limitations

The wasm-posix-kernel aims to run existing systems software on WebAssembly with minimal changes (see [posix-status.md](posix-status.md) for project vision). The limitations below are inherent to the WebAssembly platform, not design choices — they represent the boundaries of what Wasm can express today.

## 1. No Guest-Initiated Thread Creation (18 tests)

WebAssembly has no native `pthread_create` equivalent. Wasm threads require SharedArrayBuffer + Web Workers, orchestrated entirely by the host.

**Kernel infrastructure exists:** `sys_clone` allocates thread IDs and stores ThreadInfo (stack ptr, TLS ptr, ctid ptr) in the process. `sys_futex` supports WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAKE_OP operations. `set_tid_address` stores tidptr per-thread. The kernel side is ready for host-managed thread Workers.

**Missing:** Host-side Worker spawning (`onClone` callback in `CentralizedKernelWorker`), shared Memory between parent and child Workers, thread entry point, TLS initialization via `__wasm_init_tls`.

**Affected tests (functional):** `pthread_cancel`, `pthread_cancel-points`, `pthread_cond`, `pthread_mutex`, `pthread_robust`, `pthread_tsd`, `sem_init`, `sem_open`, `tls_init`
**Affected tests (regression):** `pthread_exit-cancel`, `pthread_rwlock-ebusy`, `raise-race`, `pthread_cond-smasher`, `pthread_create-oom`, `pthread_once-deadlock`, `pthread-robust-detach`, `tls_get_new-dtv`

**Future path:** Host-managed Web Worker pool where the kernel requests thread creation from the host, which spawns a new Worker sharing the same Memory. Channel allocation for each thread's syscall dispatch.

## 2. Limited fork() — Asyncify-Based

Guest-initiated `fork()` is implemented using Asyncify to snapshot and restore Wasm execution state. The child process runs in a new Worker with copied linear memory. `posix_spawn` (fork+exec) works for launching child programs.

`vfork()`, `popen()`, `spawn`, `daemon-failure`, `fflush-exit`, and `pthread_exit-dtor` all pass. The remaining limitation is that `vfork()` falls back to regular fork (no shared address space semantics).

**No remaining test failures** from fork limitations alone.

## 3. No `__syscall_cp_asm` — Cancellation Points

musl's pthread cancellation uses architecture-specific assembly (`__syscall_cp_asm`) to atomically check for cancellation and enter a syscall. No Wasm equivalent exists — Wasm has no way to interrupt execution mid-function.

**Affected tests:** `pthread_cancel-sem_wait`, `pthread_cond_wait-cancel_ignored` (also blocked by limitation #1)

**Future path:** Custom musl overlay that replaces `__syscall_cp_asm` with a C-level cancellation check. Would still need thread support (limitation #1) to be useful.

## 4. No Alternate Signal Stack (1 test)

`sigaltstack` requires switching the execution stack to a different memory region. Wasm's stack is managed by the engine and cannot be redirected. We accept the `sigaltstack` call but signal handlers always run on the main stack.

**Affected test:** `sigaltstack`

**Future path:** None feasible — Wasm stack is opaque to user code.

## 5. No FP Exception Flags or Alternate Rounding Modes

Wasm floating-point is non-trapping IEEE 754 with a fixed round-to-nearest mode. There is no hardware support for FP exception flags (`FE_INVALID`, `FE_DIVBYZERO`, etc.) or alternate rounding modes (`FE_DOWNWARD`, `FE_UPWARD`, `FE_TOWARDZERO`). Our `bits/fenv.h` reflects this: only `FE_TONEAREST` and `FE_ALL_EXCEPT 0` are defined.

This means `fesetround()`, `fegetround()`, `feraiseexcept()`, etc. are functional but limited — only round-to-nearest is available, and exception flags are always zero. Math test suites that test alternate rounding modes will skip those entries (undefined mode constants map to `-1`, which test harnesses treat as "skip").

**Impact:** No test failures — math tests correctly skip non-RN rounding checks.

## 6. OOM / Resource Exhaustion (2 tests)

Tests that deliberately exhaust resources (malloc until OOM) can trigger issues because Wasm memory growth behaves differently from native. Memory limits are now enforced (RLIMIT_AS), and most OOM tests pass. Two remain:

**Affected tests (regression):** `malloc-brk-fail`, `malloc-oom`

These tests expect specific brk/mmap failure semantics that differ in Wasm's linear memory model (brk and mmap regions are separate; `memory.grow` failure doesn't perfectly map to native OOM signaling).

## 7. setjmp Timeout (1 test)

The `setjmp` functional test hangs. Our Asyncify-based setjmp/longjmp implementation works for basic cases but the comprehensive libc-test triggers an infinite loop or stack overflow.

**Affected test (functional):** `setjmp`

## 8. musl Math Precision (14 tests)

These are musl's own ULP precision issues in round-to-nearest mode, not caused by our Wasm environment. The failing functions (`acosh`, `asinh`, `erfc`, `j0`, `jn`, `jnf`, `lgamma`, `lgammaf_r`, `lgammaf`, `sinh`, `tgamma`, `y0`, `y0f`, `ynf`) exceed the 1.5 ULP error tolerance in specific edge cases. These same failures occur on native musl builds on some architectures.

**Impact:** Not Wasm-specific. Would require patching musl's math implementations.

## 9. Missing Infrastructure (not Wasm limitations)

These failures are fixable but require specific features:

| Test | Needs | Priority |
|------|-------|----------|
| `execle-env` | `/bin/sh` binary (e.g., dash or mrsh compiled to Wasm) | Medium |
| `socket` | UDP bind/sendto/recvfrom + TCP listen/accept (loopback) | Medium |
| `ipc_msg`, `ipc_sem`, `ipc_shm` | SysV IPC (msgget, semget, shmget) | Low |

## 10. Summary: What Cannot Be Implemented in Wasm

| Feature | Why |
|---------|-----|
| `mprotect()` | Wasm linear memory has no page-level protection |
| `sigaltstack` (functional) | Wasm stack is engine-managed, opaque — cannot redirect to alternate stack |
| FP exceptions / alternate rounding | Wasm FP is non-trapping IEEE 754 with fixed round-to-nearest mode |
| `getrusage()` with real data | No CPU/memory tracking available in Wasm runtime |
| `mremap()` | Wasm memory can only grow, not remap regions |
| Raw server sockets (browser) | Web sandbox prevents listening on ports |
| `dlopen()` / `dlsym()` | Wasm component model may enable this in future |

## 11. Deferred Items (Not Impossible, Future Work)

| Feature | Notes |
|---------|-------|
| Cancellation points (`__syscall_cp_asm`) | Could implement via musl overlay with C-level cancellation check; needs threading first |
| Real setuid/setgid enforcement | Could add privilege model; low priority |
| File-backed `mmap(MAP_SHARED, fd)` | Architecturally complex, needs host cooperation |
| UDP sendto/recvfrom | Needs host dgram socket backend |
| POSIX timers (timer_create) | Medium effort, signal delivery on expiration |
| sem_open | Requires file-backed mmap or musl overlay |
| ENFILE system-wide fd tracking | Trivial in centralized mode (single ProcessTable) |

## Current Test Results (2026-03-18)

| Suite | Pass | Fail | Timeout | Total |
|-------|------|------|---------|-------|
| Functional | 49 | 5 | 9 | 63 |
| Regression | 46 | 6 | 10 | 62 |
| Math | 185 | 14 | 0 | 199 |
| **Total** | **280** | **25** | **19** | **324** |

Pass rate: **86%** (280/324). Non-passing tests are accounted for in this document and in `docs/libc-test-failures.md`.
