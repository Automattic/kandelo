# Fundamental WebAssembly Limitations

Failures that cannot be fixed without major architectural changes or Wasm spec extensions.

## 1. No Guest-Initiated Thread Creation (12 tests)

WebAssembly has no native `pthread_create` equivalent. Wasm threads require SharedArrayBuffer + Web Workers, orchestrated entirely by the host. The kernel returns ENOSYS for `clone`/`pthread_create` syscalls from guest code.

**Affected tests (functional):** `pthread_cancel`, `pthread_cancel-points`, `pthread_cond`, `pthread_mutex`, `pthread_robust`, `pthread_tsd`, `sem_init`, `sem_open`, `tls_init`
**Affected tests (regression):** `pthread_exit-cancel`, `pthread_rwlock-ebusy`, `raise-race`, `pthread_cond-smasher`, `pthread_create-oom`, `pthread_once-deadlock`, `pthread-robust-detach`, `tls_get_new-dtv`

**Future path:** Host-managed Web Worker pool where the kernel requests thread creation from the host, which spawns a new Worker sharing the same memory. Requires significant host-side orchestration.

## 2. No Guest-Initiated fork() (6 tests)

`fork()` requires duplicating the entire Wasm linear memory and execution state (call stack, locals, globals). Wasm provides no mechanism to snapshot or clone execution state. Our multi-process support is host-initiated only (host spawns new workers with fresh instances).

**Affected tests (functional):** `vfork`, `popen`, `spawn`
**Affected tests (regression):** `daemon-failure`, `fflush-exit`, `pthread_exit-dtor`

**Future path:** Copy-on-write memory via host-side memory mapping. Still can't clone the Wasm call stack — would need a "fork-at-main" approach where the child starts fresh with copied memory.

## 3. No `__syscall_cp_asm` — Cancellation Points (4 tests)

musl's pthread cancellation uses architecture-specific assembly (`__syscall_cp_asm`) to atomically check for cancellation and enter a syscall. No Wasm equivalent exists — Wasm has no way to interrupt execution mid-function.

**Affected tests:** `pthread_cancel-sem_wait`, `pthread_cond_wait-cancel_ignored`, `pthread_cancel`, `pthread_cancel-points`

**Future path:** Custom musl overlay that replaces `__syscall_cp_asm` with a C-level cancellation check. Would still need thread support (limitation #1) to be useful.

## 4. No Alternate Signal Stack (1 test)

`sigaltstack` requires switching the execution stack to a different memory region. Wasm's stack is managed by the engine and cannot be redirected. We accept the `sigaltstack` call but signal handlers always run on the main stack.

**Affected test:** `sigaltstack`

**Future path:** None feasible — Wasm stack is opaque to user code.

## 5. Hangs on OOM / Resource Exhaustion (8 tests)

Tests that deliberately exhaust resources (malloc until OOM, create threads until failure) hang because Wasm's `memory.grow` doesn't properly signal failure in all musl code paths, and single-threaded execution means spinning loops never yield.

**Affected tests (regression):** `flockfile-list`, `malloc-brk-fail`, `malloc-oom`, `setenv-oom`

**Future path:** Better `brk`/`mmap` failure handling; wasm memory growth limits; host-side timeout and interruption mechanism.

## 6. Missing Infrastructure (not Wasm limitations)

These failures are fixable but require specific features:

| Test | Needs | Priority |
|------|-------|----------|
| `execle-env` | `/bin/sh` binary (e.g., dash or mrsh compiled to Wasm) | Medium |
| `socket` | UDP bind/sendto/recvfrom + TCP listen/accept (loopback) | Medium |
| `ipc_msg`, `ipc_sem`, `ipc_shm` | SysV IPC (msgget, semget, shmget) | Low |

## Current Test Results (2026-03-17)

| Suite | Pass | Fail | Timeout | Total |
|-------|------|------|---------|-------|
| Functional | 47 | 10 | 6 | 63 |
| Regression | 43 | 11 | 8 | 62 |
| **Total** | **90** | **21** | **14** | **125** |

Pass rate: **72%** (90/125). All 35 non-passing tests are accounted for in this document.
