# Fundamental WebAssembly Limitations

Failures that cannot be fixed without major architectural changes or Wasm spec extensions.

## 1. No Guest-Initiated Thread Creation (12 tests)

WebAssembly has no native `pthread_create` equivalent. Wasm threads require SharedArrayBuffer + Web Workers, orchestrated entirely by the host. The kernel returns ENOSYS for `clone`/`pthread_create` syscalls from guest code.

**Affected tests:** `pthread_cancel`, `pthread_cancel-points`, `pthread_cond`, `pthread_tsd`, `sem`, `tls_align`, `tls_init`, `tls_local_exec`, `pthread_exit-cancel`, `pthread_rwlock-ebusy`, `raise-race`, `pthread_cond-smasher`

**Future path:** Host-managed Web Worker pool where the kernel requests thread creation from the host, which spawns a new Worker sharing the same memory. Requires significant host-side orchestration.

## 2. No Guest-Initiated fork() (6 tests)

`fork()` requires duplicating the entire Wasm linear memory and execution state (call stack, locals, globals). Wasm provides no mechanism to snapshot or clone execution state. Our multi-process support is host-initiated only (host spawns new workers with fresh instances).

**Affected tests:** `daemon-failure`, `fflush-exit`, `pthread_exit-dtor`, `vfork`, `popen`, `wordexp`

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

**Affected tests:** `flockfile-list`, `malloc-brk-fail`, `malloc-oom`, `pthread_create-oom`, `pthread_once-deadlock`, `pthread-robust-detach`, `setenv-oom`, `tls_get_new-dtv`, `crypt`

**Future path:** Better `brk`/`mmap` failure handling; wasm memory growth limits; host-side timeout and interruption mechanism.
