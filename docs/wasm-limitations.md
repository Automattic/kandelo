# Fundamental WebAssembly Limitations

Kandelo aims to run existing systems software on WebAssembly with minimal changes (see [posix-status.md](posix-status.md) for project vision). The limitations below are inherent to the WebAssembly platform, not design choices — they represent the boundaries of what Wasm can express today.

## 1. No Native Thread-Creation Instruction

WebAssembly has no instruction that starts a thread. Every Kandelo thread exists because the host created a worker (a Web Worker in the browser, a `worker_threads` worker under Node) that instantiates the program module against the *same* `WebAssembly.Memory` as its parent. SharedArrayBuffer and that host orchestration are structural requirements, not a stage the platform will grow out of.

**Guest `pthread_create` does work — this is not a missing API.** The full path is wired end to end:

- musl's `pthread_create` calls `__clone`, which `libc/musl-overlay/src/thread/wasm32posix/clone.c` routes to the `kernel_clone` wasm import (16-byte-realigning the child stack pointer, because wasm codegen assumes that alignment at function entry).
- `libc/musl-overlay/src/thread/wasm32posix/__set_thread_area.c` returns 0, which is what makes `__init_tp()` set `libc.can_do_threads = 1`.
- `kernel_clone` reaches the kernel's `sys_clone` (`CLONE_VM|CLONE_THREAD`), which allocates the TID from the global PID/TID sequence; the host `onClone` callback — wired in both `host/src/node-kernel-worker-entry.ts` and `host/src/browser-kernel-worker-entry.ts` — spawns the thread worker (`centralizedThreadWorkerMain` in `host/src/worker-main.ts`, with its own syscall channel and TLS block), which calls the program's exported `__wasm_thread_init` to install the thread pointer before invoking the thread function through `__indirect_function_table`.

Repository programs call `pthread_create` directly (`programs/fork-from-thread.c`, `programs/posix-timer-thread.c`, `examples/pthread-normal-exit.c`), musl's own `timer_create` overlay uses it internally, MariaDB runs 5 threads, and the sortix `basic/pthread/pthread_create` conformance test passes on Node.

**What the limitation costs in practice:** thread creation is a host round trip that must start a worker and reserve a per-thread control slot, so it is far more expensive than a native `clone`, and the number of live threads per process is bounded by the slot budget the executable declares through `__wasm_posix_thread_slots` (see [sdk-guide.md](sdk-guide.md)) rather than by memory alone.

**Affected libc-tests:** none. `pthread_create-oom`, which checks that `pthread_create` fails with `EAGAIN` once memory is exhausted, passes.

## 2. No Preemption — Asynchronous Thread Cancellation

Stock musl implements `pthread_cancel` with `SIGCANCEL` plus an architecture-specific assembly trampoline (`__syscall_cp_asm` / `__cp_begin` / `__cp_end` / `__cp_cancel`): the signal handler interrupts a blocked syscall and rewrites the instruction pointer to the cancel path. Wasm has neither signal-based preemption nor instruction-pointer rewrite.

**That mechanism was replaced, not left absent.** Kandelo implements *deferred* cancellation — cancellation delivered at cancellation points — and it works:

- `libc/musl-overlay/src/thread/wasm32posix/pthread_cancel.c` provides `pthread_cancel`, `__cancel`, `__testcancel`, `__syscall_cp_cancel_preflight`, `__syscall_cp_check`, and `__syscall_cp_cancel_wake_allowed`. It reuses musl's existing atomic per-thread `pthread_t->cancel` field as the pending-cancel flag.
- `libc/musl-overlay/src/thread/wasm32posix/pthread_testcancel.c` drops stock musl's weak `__testcancel` dummy, which wasm-ld could otherwise pull out of the archive ahead of the strong definition — that archive-ordering accident silently disabled cancellation before it was fixed.
- `libc/glue/channel_syscall.c::__syscall_cp` calls the preflight before the blocking dispatch and `__syscall_cp_check(r)` after it, handling all three cancel states the way the stock assembly does: ENABLE exits through `pthread_exit(PTHREAD_CANCELED)`, MASKED synthesizes `-ECANCELED` so a condition wait can reacquire its mutex first, DISABLE leaves the operation live.
- `SYS_THREAD_CANCEL` (415, `crates/shared/src/lib.rs` → `host/src/generated/abi.ts`) is a host-intercepted syscall that wakes a target already blocked in a cancellation point, but only when that exact request advertised `REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED` — so a target in `PTHREAD_CANCEL_DISABLE` keeps its operation and its deadline intact while the cancel stays pending.

Cleanup handlers, `pthread_setcancelstate`, and the `pthread_cond_wait` cancellation handoff all work on top of that.

**The residual limit is preemption.** `PTHREAD_CANCEL_ASYNCHRONOUS` promises that a thread can be cancelled at an arbitrary point in its own computation. Wasm cannot interrupt a running thread mid-function, so a target that never reaches a cancellation point cannot be cancelled at all. `pthread_cancel` still records the pending flag for such a thread, and it will be cancelled if it later enters a cancellation-point syscall — but an async cancel of a pure-CPU loop never takes effect.

**Affected libc-tests:** functional `pthread_cancel` — its first subcase async-cancels a thread parked in `for (;;)`, so that thread never exits, `pthread_join` never returns, and the per-test timeout kills the run. Splitting the test confirms the boundary: a build carrying only its two cleanup-handler subcases (which block in `sleep(3)`, a real cancellation point) passes in under a second, while a build carrying only the async subcase hangs. `pthread_cancel-points` and `pthread_cond_wait-cancel_ignored` both pass.

## 3. No FP Exception Flags or Alternate Rounding Modes

Wasm floating-point is non-trapping IEEE 754 with a fixed round-to-nearest mode. There is no hardware support for FP exception flags (`FE_INVALID`, `FE_DIVBYZERO`, etc.) or alternate rounding modes (`FE_DOWNWARD`, `FE_UPWARD`, `FE_TOWARDZERO`).

**Impact:** 14 math libc-tests fail ULP precision checks (`acosh`, `asinh`, `erfc`, `j0`, `jn`, `jnf`, `lgamma`, `lgammaf_r`, `lgammaf`, `sinh`, `tgamma`, `y0`, `y0f`, `ynf`). These are musl's own precision issues in round-to-nearest mode, not caused by Wasm.

## 4. OOM / Resource Exhaustion

Memory limits are enforced (`RLIMIT_AS`), and the libc-test out-of-memory checks for `malloc`, `setenv`, and `pthread_create` (`malloc-oom`, `setenv-oom`, `pthread_create-oom`) pass. Until 2026-09-25 all three were listed here as Wasm limits; they had been XFAIL because the libc-test harness compiled `t_memfill()` to return -1 unconditionally, so they failed in setup with "memfill failed" before testing anything (fixed 2026-09-25 with `-fno-builtin-malloc`).

**Affected libc-tests:** `malloc-brk-fail`, because of page size rather than out-of-memory behavior. The test fills memory, unmaps a fixed 64 KiB hole, and expects `malloc(10000)` to fit in it. On the 4 KiB-page systems it was written for that hole is 16 pages; here it is one, because Kandelo's page size is WebAssembly's 64 KiB page. With `brk` unavailable, musl's allocator needs three pages for a first small allocation — measured: holes of one or two pages fail, three or more succeed, and a direct `mmap` reuses the hole correctly in every case. At the test's intended 16-page geometry it passes. POSIX does not promise that 64 KiB is many pages.

## 5. No dlopen for TLS

Dynamic loading of shared Wasm modules works (`host/src/dylink.ts`), but the `tls_get_new-dtv` libc-test requires TLS management across dynamically loaded modules, which is not supported.

**Affected libc-tests:** `tls_get_new-dtv`

## 6. No Page-Level Memory Revocation (`munmap` direct-access SIGSEGV)

`munmap()` cannot make a previously mapped page fault on *direct* pointer access. Wasm linear memory only grows — there is no mechanism to revoke byte-range access, punch holes, or restore trap-on-access semantics for pages that were once in-bounds.

Kernel-side `sys_munmap` correctly updates the MemoryManager range tracking (so allocator bookkeeping stays honest and the same address can be reused by a future `mmap`), but the underlying wasm bytes remain readable and writable. A guest program that relies on SIGSEGV-on-access-after-munmap — stack guard pages, JIT scratch poisoning, ASan-style poisoning, memory sanitizers — does not observe the fault.

**Affected POSIX tests:** `munmap/1-1`, `munmap/1-2` — both dereference a pointer directly (`*ch = 'a'`) after `munmap` and expect SIGSEGV. No syscall is involved in the failing step, so kernel-side EFAULT validation cannot help them.

**Why this is a wasm limit, not a kernel gap:** C pointer dereferences compile to `i32.store`/`i32.load` instructions against a statically-chosen memory index. The runtime has no hook to check addresses against a kernel-maintained "unmapped" set before the instruction executes. Making `*ptr = val` trap requires either compiler-level instrumentation of every load/store (expensive and toolchain-specific) or a wasm platform feature that doesn't exist today.

**Future wasm-platform possibilities:** Any of the following *could* eventually close this gap:

- **Memory Control proposal** (github.com/WebAssembly/memory-control, Phase 1) — investigating page-level memory operations. A `memory.protect` op with trap-on-access semantics would be sufficient. The already-discussed `memory.discard` (zero pages but leave them readable) is *not* sufficient on its own.
- **Multi-memory + compiler fat-pointer support** — allocating each mmap region in its own wasm memory would let the runtime trap accesses to memories that have been "retired," but only if the compiler emits the correct `memory.idx` for every load/store derived from an mmap'd pointer. Clang's wasm targets compile C pointers to a single memory index chosen at compile time; dynamic memory-index selection from a pointer value is not expressible today and would require fat-pointer or pointer-provenance support in the toolchain. Multi-memory alone does not solve this.
- **Trap-on-memory-access exception handling** — would permit host-resumable handling of out-of-bounds traps, enabling SIGSEGV delivery from the kernel. Not a proposal.

Until one of those ships, this remains a fundamental wasm limitation. The kernel's optional syscall-path EFAULT validation (defensive hardening, described in [compromising-xfails.md §2](compromising-xfails.md)) does not flip these XFAIL entries.

## 7. Separate Process Memories Are Not Immediate Shared Memory

Each Kandelo process owns a different WebAssembly `Memory`. Fork copies the
parent's bytes into a new shared memory for the child; it does not create one
linear memory that both PIDs can address. Kandelo therefore coordinates
anonymous `MAP_SHARED`, SysV SHM, and stable-identity regular-file mappings at
syscall boundaries: changed bytes are merged into a host-owned backing and peer
updates are imported when a process next enters the kernel.

That closes file/data handoff cases but is not equivalent to shared physical
pages. Direct stores are not visible to another PID until a syscall boundary,
and a peer that only spins on loads does not import the update. Futex WAIT/WAKE
also operates on the caller's own `SharedArrayBuffer`, so process-shared
pthread mutexes and similar lock protocols remain unsupported. Threads created
with `CLONE_VM` do share one memory and are not subject to this cross-process
boundary.

Regular-file `MAP_SHARED` has further explicit limits. The backend must provide
stable device/inode identity. Node and mounted VFS backends provide exact
live-handle identity, and OPFS assigns session-scoped inode tokens that remain
stable across simultaneous opens, rename, and unlink-while-open. A backend that
cannot prove such identity is rejected with `ENOTSUP`. In-kernel memfds also
return `ENOTSUP` for shared mappings until they have a mapping bridge. Bytes
beyond EOF are zero-filled or dropped rather than raising Linux's `SIGBUS`, and
changes made by an external host writer do not invalidate Kandelo's page cache.
`MAP_PRIVATE` is unaffected by the identity and memfd restrictions.

## 8. Summary: What Cannot Be Implemented in Wasm

| Feature | Why |
|---------|-----|
| `mprotect()` | Wasm linear memory has no page-level protection (returns success as no-op) |
| `munmap()` SIGSEGV-on-deref | Wasm linear memory cannot revoke page access — see §6 |
| FP exceptions / alternate rounding | Wasm FP is non-trapping IEEE 754 with fixed round-to-nearest mode |
| `getrusage()` with real data | No CPU/memory tracking available in Wasm runtime |
| Immediate cross-process `MAP_SHARED` + futex | Distinct process memories cannot directly address or wake on one another's bytes; Kandelo provides syscall-boundary data coherence instead |
| Raw server sockets (browser) | Web sandbox prevents listening on ports |
| Native thread creation | No wasm instruction starts a thread; guest `pthread_create` works, but only because the host spawns a worker per thread — see §1 |
| `PTHREAD_CANCEL_ASYNCHRONOUS` | Wasm cannot preempt a running thread, so a target that never reaches a cancellation point cannot be cancelled. Deferred cancellation at cancellation points does work — see §2 |

## What IS Implemented (previously listed as impossible)

| Feature | Status |
|---------|--------|
| `fork()` | `wasm-fork-instrument` resumes supported main-thread, pthread, and direct main-to-one-side-module stacks; nested/opaque cross-side and pthread-inside-side-module paths remain unsupported |
| `sigaltstack` | Shadow stack swap via inline asm (PR #174) |
| `dlopen()` / `dlsym()` | Dynamic Wasm module linker (host/src/dylink.ts) |
| `exec()` | In-place host-side replacement with CWD resolution and stable mapping writeback handles; remaining descriptor and signal-attribution gaps are tracked in [posix-status.md](posix-status.md) |
| `mremap()` | Kernel range bookkeeping and in-memory move/grow/shrink are implemented; old bytes cannot be revoked after a move, for the same reason as `munmap()` |
| `posix_spawn()` | Non-forking host-side spawn with CWD resolution and file actions |
| SysV IPC | Host-side handlers (PR #146) |
| POSIX mqueues | Host-side handlers (PR #147) |
| POSIX timers | setitimer/getitimer (PR #148) |
| `sem_open` | Implemented |
| PTY / terminal | Full pseudoterminal with line discipline (PR #181) |
| Threads via `pthread_create` / `clone()` | Host-managed workers sharing the parent `Memory`, MariaDB runs 5 threads (PR #88) |
| Deferred `pthread_cancel` | Cancellation at cancellation points, cleanup handlers, `pthread_setcancelstate`, and the `pthread_cond_wait` handoff — see §2 |
| OPFS filesystem | Browser persistence includes exact `u64` stat identity, session-scoped inode tokens, simultaneous-open unification, and live-handle identity across supported rename/unlink operations; browsers missing the required identity or move primitives fail at that explicit boundary |

## Current libc-test Results (2026-09-25, Node)

306 pass, 0 unexpected failures, 17 expected failures (XFAIL), out of 324:
- 14 math precision (musl ULP issues)
- 1 page-size geometry (malloc-brk-fail — assumes 4 KiB pages; see §4)
- 1 asynchronous cancellation (pthread_cancel — deferred cancellation passes; see §2)
- 1 dynamic TLS (tls_get_new-dtv)
