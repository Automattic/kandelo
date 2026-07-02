# Phase 3: Process Management Implementation Plan

**Goal:** Add basic process identity and lifecycle APIs. Defer fork/exec/waitpid to Phase 3b.

**Architecture:** Process struct extended with identity fields (ppid, uid, gid) and lifecycle state. Exit cleans up all resources. This phase predates the shared process table used by the current kernel.

---

## Design Decisions & POSIX Tradeoffs

### Decision 1: Phase Split
**Chosen:** Implement getpid/getppid/getuid/getgid/exit now, defer fork/exec/waitpid.
**Rationale:** fork requires Wasm linear memory snapshots + multi-worker coordination. exec requires dynamic module loading. waitpid requires cross-worker IPC. These are all massive architectural changes. Meanwhile, many programs need getpid/getuid for basic operation.
**Alternative:** Implement full process management. Would require: process table in SharedArrayBuffer, worker spawning from TypeScript host, memory serialization/deserialization, and Atomics-based parent-child synchronization. Documented for Phase 3b.

### Decision 2: UID/GID Simulation
**Chosen:** Simulated single-user environment. Default uid=1000, gid=1000 (matching typical Linux defaults). Configurable at kernel_init time.
**Rationale:** Wasm has no OS-level user concept. Using 0 (root) could mislead programs. Using 1000 matches typical unprivileged user expectations.
**Alternative:** Always return 0 (root). Simpler but may cause programs to behave differently (e.g., skipping permission checks). Could add a configuration option later to select root vs. unprivileged simulation.
**Browser tradeoff:** Same simulated values in all environments. Programs that truly need user isolation should use the host's mechanism.

### Decision 3: exit() Behavior
**Chosen:** Cleanup all fds, close all dir streams, set process state to Exited, store exit status. The Wasm instance effectively becomes inert after exit — subsequent syscalls return ESRCH.
**Rationale:** Matches POSIX _exit() behavior (immediate cleanup, no atexit handlers). The C library's exit() can call atexit handlers in userspace before calling _exit().
**Alternative:** Could trap (unreachable) on exit. Simpler but doesn't allow the host to read exit status. Chosen approach is more useful for integration.

### Decision 4: Process State
**Chosen:** Simple enum: Running, Exited. No Stopped/Zombie states yet (those require signals and waitpid).
**Alternative:** Full POSIX process states. Deferred to Phase 3b when waitpid is implemented.
