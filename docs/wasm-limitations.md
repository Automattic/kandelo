# Fundamental WebAssembly Limitations

Kandelo aims to run existing systems software on WebAssembly with minimal changes (see [posix-status.md](posix-status.md) for project vision). The limitations below are inherent to the WebAssembly platform, not design choices — they represent the boundaries of what Wasm can express today.

## 1. No Guest-Initiated Thread Creation

WebAssembly has no native `pthread_create` equivalent. Wasm threads require SharedArrayBuffer + Web Workers, orchestrated entirely by the host.

**Kernel infrastructure exists:** `sys_clone` with `CLONE_VM|CLONE_THREAD` creates threads via the host `onClone` callback. Thread workers run `centralizedThreadWorkerMain` with dedicated channel + TLS. MariaDB successfully runs 5 threads. The `pthread_create` musl entry point is not wired up — thread creation is only available via the kernel's clone syscall.

**Affected libc-tests:** `pthread_cancel`, `pthread_cond_wait-cancel_ignored`, `pthread_create-oom`, `raise-race`

## 2. No `__syscall_cp_asm` — Cancellation Points

musl's pthread cancellation uses architecture-specific assembly (`__syscall_cp_asm`) to atomically check for cancellation and enter a syscall. No Wasm equivalent exists — Wasm has no way to interrupt execution mid-function.

**Affected libc-tests:** `pthread_cancel`, `pthread_cond_wait-cancel_ignored`

## 3. No FP Exception Flags or Alternate Rounding Modes

Wasm floating-point is non-trapping IEEE 754 with a fixed round-to-nearest mode. There is no hardware support for FP exception flags (`FE_INVALID`, `FE_DIVBYZERO`, etc.) or alternate rounding modes (`FE_DOWNWARD`, `FE_UPWARD`, `FE_TOWARDZERO`).

**Impact:** 14 math libc-tests fail ULP precision checks (`acosh`, `asinh`, `erfc`, `j0`, `jn`, `jnf`, `lgamma`, `lgammaf_r`, `lgammaf`, `sinh`, `tgamma`, `y0`, `y0f`, `ynf`). These are musl's own precision issues in round-to-nearest mode, not caused by Wasm.

## 4. OOM / Resource Exhaustion

Tests that deliberately exhaust resources behave differently in Wasm's linear memory model. Memory limits are enforced (RLIMIT_AS), and most OOM tests pass.

**Affected libc-tests:** `malloc-brk-fail`, `malloc-oom`, `setenv-oom`

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
| Guest-initiated `pthread_create` | Wasm threads require host orchestration via Web Workers |
| `pthread_cancel` | No architecture-specific `__syscall_cp_asm` for Wasm |

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
| Threads via `clone()` | Host-managed Web Workers, MariaDB runs 5 threads (PR #88) |
| OPFS filesystem | Browser persistence includes exact `u64` stat identity, session-scoped inode tokens, simultaneous-open unification, and live-handle identity across supported rename/unlink operations; browsers missing the required identity or move primitives fail at that explicit boundary |

## Current libc-test Results (2026-04-05)

0 unexpected failures, 20 expected failures (XFAIL):
- 14 math precision (musl ULP issues)
- 3 OOM behavior (malloc-brk-fail, malloc-oom, setenv-oom)
- 1 threading (pthread_create-oom)
- 1 cancellation (pthread_cancel)
- 1 dynamic TLS (tls_get_new-dtv)
