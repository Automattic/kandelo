# Non-forking `posix_spawn` syscall — design

**Date:** 2026-05-04
**Status:** Design validated, ready for implementation planning
**Branch:** `non-forking-posix_spawn-syscall-implementation`
**ABI bump:** 7 → 8

## Goal

Add a kernel-level non-forking spawn primitive so `popen`, `system`, exec from
backticks, and direct `posix_spawn`/`posix_spawnp` calls no longer go through
`fork()`. POSIX explicitly permits non-forking implementations of `posix_spawn`
— that's the reason the API exists — so this is a conformant change.

Today these all chain through musl's `posix_spawn` → `__clone` → kernel fork,
which means a copy of parent linear memory plus a fork-instrument unwind on
every shell-out.

## Why now

Standalone improvement. Also unblocks downstream work: extensions loaded via
`dlopen` in PHP can safely call `popen`/`system` once spawn no longer forks.

## Decisions locked during design review

1. **PATH search lives in libc.** `posix_spawnp` walks `PATH` itself, calls
   plain `posix_spawn` with the resolved absolute path. The kernel ABI takes
   one resolved path. Matches what `__execvpe` already does for fork-based
   exec; keeps PATH-search policy in libc.
2. **`posix_spawn` attributes are marshalled in the same SYS_SPAWN blob and
   applied kernel-side before launching the worker.** Covers
   `POSIX_SPAWN_SETSIGDEF`, `POSIX_SPAWN_SETSID`, `POSIX_SPAWN_SETPGROUP`,
   `POSIX_SPAWN_SETSIGMASK`. Adds ~24 bytes per spawn; avoids a behavior
   regression for shells/daemons that set up sessions or process groups.
3. **Per-process fork counter on the kernel-side `Process`, exposed via
   `kernel_get_fork_count(pid) -> u64`.** This is the regression guardrail —
   without it, a future change that quietly routes spawn back through fork
   would pass all functional tests. Kernel-owned, kernel-readable only; never
   mapped into process memory.
4. **The kernel owns the child's process descriptor.** The wire-format blob
   in caller memory is a transient serialization of the *request*, not the
   descriptor. After SYS_SPAWN returns, the parent's libc frees the blob; the
   child's pid/ppid/pgid/sid/fd table/cwd/signal state/argv-envp snapshot
   live in the kernel's `ProcessTable`, keyed by pid. The child's wasm
   memory holds none of this.
5. **`ProcessTable::spawn_child` allocates the child pid internally.** Pid
   allocation belongs to the kernel, not the host. The host updates its
   `nextChildPid` watermark from the kernel's returned pid to keep fork's
   existing host-side pid allocator conflict-free until that path is similarly
   cleaned up.
6. **No host-side TCP-listener-target or epoll-interest inheritance for
   spawn.** Those exist for nginx-class users that intentionally share a
   listening socket across forked workers — they use `fork()` directly because
   they want shared parent memory. The spawn audience (`popen`, `system`,
   backticks, CLI launches) does not pass listening sockets. The kernel-side
   fd table cloning is structurally sufficient for POSIX semantics; if a
   future caller really does pass a listening fd through spawn without
   `FD_CLOEXEC`, we extend the host bookkeeping then.

## Out of scope

- `pcntl_fork()` and FPM master→worker fork. Those genuinely need
  parent-memory copy semantics; spawn doesn't replace them.
- Any PHP work. Purely kernel + musl.
- `vfork()`. musl can route `vfork` through SYS_SPAWN later; not needed for
  the popen/system path.
- Cleaning up the host-side `nextChildPid` allocator wart. Out of scope; we
  work around it for spawn by reading the kernel-allocated pid back.

## Section 1 — Syscall ABI

Add `Spawn = 141` to the `Syscall` enum in `crates/shared/src/lib.rs`
(next free after `Getaddrinfo = 140`). Update `Syscall::from_u32`. Bump
`ABI_VERSION` from `7` to `8` in the **same commit** and regenerate
`abi/snapshot.json`.

### Channel args (6 × i64, existing convention)

```
arg0 = path_ptr        // const char* path (caller memory) — already PATH-resolved
arg1 = path_len
arg2 = blob_ptr        // packed argv + envp + file_actions + attrs blob (caller memory)
arg3 = blob_len
arg4 = pid_out_ptr     // pid_t* — kernel writes child pid here on success
arg5 = 0               // reserved (headroom for a future flags param without ABI bump)
```

Returns a single `i32`: 0 = success, negative errno on failure.

### Blob layout (single contiguous record, little-endian)

```
header  { argc:u32, envc:u32, n_actions:u32, attr_flags:u32,
          pgrp:i32, _pad:u32, sigdef:u64, sigmask:u64 }   // 40 bytes
argv_offsets:    u32 × argc                               // offsets into strings[]
envp_offsets:    u32 × envc
actions:         action_record × n_actions                // 28 bytes each
strings:         u8[]                                     // packed null-terminated
```

`action_record = { op:u32, fd:i32, newfd:i32, path_off:u32, path_len:u32, oflag:i32, mode:u32 }`
covering FDOP_OPEN, FDOP_CLOSE, FDOP_DUP2, FDOP_CHDIR, FDOP_FCHDIR. Strings
(open paths, chdir paths) interned in `strings[]` at `path_off`.

`attr_flags` mirrors POSIX: `SETSIGDEF=0x10`, `SETSID=0x80`,
`SETPGROUP=0x02`, `SETSIGMASK=0x08`. `pgrp/sigdef/sigmask` are unused unless
the corresponding flag bit is set.

The blob is a transient request: the kernel copies it to scratch like every
other syscall, parses it once, and never references it again. The descriptor
the kernel constructs for the child lives in `ProcessTable`.

## Section 2 — Kernel side

### `ProcessTable::spawn_child`

In `crates/kernel/src/process.rs`:

```rust
impl ProcessTable {
    pub fn spawn_child(
        &mut self,
        parent_pid: u32,
        argv: &[&[u8]], envp: &[&[u8]],
        file_actions: &[FileAction], attrs: &SpawnAttrs,
    ) -> Result<u32, Errno>   // Ok(child_pid)
}
```

Steps in order:

1. Allocate a new pid (smallest unused) for the child. Construct `Process`,
   parented to `parent_pid`. Inherit cwd, umask, real/effective uid/gid,
   controlling tty, signal mask (unless `SETSIGMASK` overrides), signal
   dispositions (unless `SETSIGDEF` overrides).
2. Clone parent's fd table with the same OFD-refcount semantics fork uses.
   Reuse the helper `kernel_fork_process` calls — extract to
   `Process::clone_fd_table_from(parent)` if not already factored.
3. Apply attrs in POSIX order: `SETSID` → `SETPGROUP` → `SETSIGMASK` →
   `SETSIGDEF`. Failure on any → return errno; child descriptor is dropped;
   parent gets that errno from SYS_SPAWN.
4. Apply file actions in **forward** order against the *child's* fd table
   only. Open paths resolve against the child's (potentially mid-update)
   cwd. Failure → drop child, return errno.
5. Store argv/envp snapshot on the child `Process` (for `/proc/<pid>/cmdline`
   parity with exec).
6. Insert child into `ProcessTable`. Return child pid.

### Syscall handler

In `crates/kernel/src/syscalls.rs`: `handle_spawn(channel, parent_pid)` —
copies blob from caller memory to scratch, parses header + actions + strings,
calls `ProcessTable::spawn_child`, then signals the host via the existing
host-callback mechanism. The host callback is what actually launches the
worker (Section 3); the kernel-side syscall returns success only after the
host confirms the worker is up.

### Fork counter

Add `fork_count: AtomicU64` to `Process`. Increment inside
`kernel_fork_process` (parent side, after success). Expose via new export
`kernel_get_fork_count(pid: u32) -> u64`. Read-only from outside the kernel;
never mapped into process memory.

### New kernel exports introduced

- `kernel_spawn_process(parent_pid, blob_ptr, blob_len) -> i32` — returns
  allocated child pid on success, negated errno on failure.
- `kernel_get_fork_count(pid: u32) -> u64` — Q3 regression guardrail.

Both picked up by ABI snapshot.

## Section 3 — Host side

### Callback type

Add to `KernelWorkerCallbacks` in `host/src/kernel-worker.ts`:

```ts
onSpawn?: (childPid: number, path: string, argv: string[], envp: string[]) => Promise<number>;
```

Returns 0 on worker-launch success, negative errno on failure. Mirrors
`onExec` shape but creates a fresh worker instead of replacing one.

### `handleSpawn(channel, origArgs)` in `kernel-worker.ts`

1. Read blob from caller memory at `origArgs[2]` for `origArgs[3]` bytes;
   copy into kernel scratch.
2. Read `path` C-string from caller memory at `origArgs[0]/[1]`.
3. Resolve relative `path` against the parent's CWD (reuse
   `resolveExecPathAgainstCwd`).
4. Call `kernel_spawn_process(parentPid, blobScratchPtr, blobLen)`. Returns
   `childPid` or `-errno`.
5. On kernel error → complete channel with that errno, no host worker
   created.
6. On success → bump `nextChildPid = max(nextChildPid, childPid + 1)` to keep
   fork's host-side allocator conflict-free.
7. Track parent-child relationship for waitpid:
   `childToParent.set(childPid, parentPid)` and append to
   `parentToChildren[parentPid]`.
8. Call `onSpawn(childPid, path, argv, envp)`.
   - Success → write `childPid` through `pid_out_ptr` in caller memory,
     complete channel with return 0.
   - Failure (e.g., bytes not found, worker launch failed) →
     `kernel_remove_process(childPid)` to undo the kernel descriptor,
     complete channel with `-errno`.

### Wiring

- `host/src/node-kernel-worker-entry.ts`: add `handleSpawn(childPid, path,
  argv, envp)` analogous to `handleExec` — calls `resolveExec(path)` to get
  bytes, posts a new `spawn_request` host-message to the main thread to
  register and launch a fresh process worker under that pid (same per-process
  worker creation path as today; just doesn't replace an existing one).
- `host/src/browser-kernel.ts`: add `onSpawn` that calls the existing
  per-process worker creation path with a freshly-allocated worker, no
  replacement of any current worker.
- `host/src/run-example.ts`: wire `onSpawn` to the same builtin program map /
  filesystem lookup `onExec` uses today.

### Wire protocol

`resolve_exec` is reused for bytes lookup — no new resolution message type.
A new `spawn_request` host-side message is needed because the existing
exec-replacement message tears down the calling worker; spawn must not.

## Section 4 — Musl overlay

### `musl-overlay/src/process/wasm32posix/posix_spawn.c` — full rewrite

Drop the `fork() + exec` body. New body:

1. Walk `posix_spawn_file_actions_t` (musl's `struct fdop` linked list) once
   to count actions and total path-string bytes.
2. Stack-allocate (or `alloca`) a contiguous blob: header (40 bytes) +
   argv-offset table + envp-offset table + action records (28 bytes each) +
   strings region.
3. Fill header: `argc`/`envc` from `argv`/`envp` argument arrays,
   `n_actions`, plus the four attr fields (`attr_flags`, `pgrp`, `sigdef`,
   `sigmask`) copied straight from the `posix_spawnattr_t`.
4. Pack argv and envp string pointers as offsets into the strings region;
   copy strings packed and NUL-terminated.
5. Walk the fdop list a second time, in **forward** order (kernel applies in
   array order, matching POSIX); emit one 28-byte record per action with
   op/fd/newfd/path-offset/path-length/oflag/mode.
6. Single `__syscall` for `SYS_SPAWN` with
   `(path_ptr, path_len, blob_ptr, blob_len, pid_out_ptr, 0)`.
7. Negative return → return `-ret` as the function's return value (POSIX:
   `posix_spawn` returns the errno directly, doesn't set `errno`).
8. Zero return → `*res = pid_out`; return 0.

The supplied `path` is used verbatim — already absolute by the time it
reaches plain `posix_spawn` (PATH search happens in `posix_spawnp`).

### `musl-overlay/src/process/wasm32posix/posix_spawnp.c` — new file

Replaces musl's stock implementation. Per Q1 Option A: do the PATH walk in
libc, call `posix_spawn` with the resolved absolute path. If `path` contains
`/`, skip PATH lookup and pass through. If lookup fails on every entry, fall
through to plain `posix_spawn(path, ...)` which will return ENOENT. Skip
files that exist but aren't executable (EACCES handling matches
`__execvpe`).

### Files retained / removed

- Existing `posix_spawn_file_actions_*.c` and `posix_spawnattr_sched.c`
  overlay files stay — they manipulate libc-side opaque structs, no kernel
  involvement.
- `glue/channel_syscall.c`: add `#define SYS_SPAWN 141`. No special-case
  needed — generic 6-arg dispatch handles it. The existing
  `SYS_FORK`/`SYS_VFORK` special path stays for plain `fork()`/`vfork()`.

## Section 5 — Testing & verification

### ABI bump (mandatory in same commit as syscall add)

- `crates/shared/src/lib.rs`: `Spawn = 141` enum variant + `from_u32` arm;
  `ABI_VERSION: u32 = 8`.
- `bash scripts/check-abi-version.sh update`, inspect `git diff
  abi/snapshot.json`. Expect: new syscall, two new exports
  (`kernel_spawn_process` + `kernel_get_fork_count`), ABI version field.

### Five mandatory suites (CLAUDE.md)

1. `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` —
   add unit tests for `ProcessTable::spawn_child`: basic spawn, file-action
   ordering, attr application, ENOENT propagation, fd inherit, fork-counter
   unaffected.
2. `cd host && npx vitest run` — new test
   `host/test/centralized-spawn.test.ts`: spawn a small program, verify
   exit status via `wait`, verify fd inheritance + addopen+dup2 file action.
   **Plus the Q3 regression guardrail**: spawn a program, then call
   `kernel_get_fork_count(parentPid)` before and after — assert delta == 0.
3. `scripts/run-libc-tests.sh` — must include musl's `posix_spawn` test
   case, no new FAILs (XFAIL/TIME acceptable).
4. `scripts/run-posix-tests.sh` — Open POSIX Test Suite's `posix_spawn` and
   `posix_spawnp` directories must hold or improve.
5. `bash scripts/check-abi-version.sh` — verifies snapshot in sync with
   version.

### Targeted regression tests (vitest, beyond the fork-counter check)

- `popen("ls")` runs, `pclose` returns 0, fork counter unchanged.
- `system("true")` returns 0, fork counter unchanged.
- `posix_spawnp("dash", ...)` finds `/usr/bin/dash` via PATH, runs.
- `posix_spawn` with `POSIX_SPAWN_SETPGROUP` lands the child in the
  requested pgrp.
- `posix_spawn` with addopen+dup2 sets up child stdin from a file.

### Documentation updates

- `docs/posix-status.md` — note `posix_spawn` no longer forks.
- `docs/architecture.md` — add SYS_SPAWN to the syscall + process model
  section.
- `docs/abi-versioning.md` — already references the snapshot/version
  pairing; no change unless we add a "non-forking process creation"
  subsection.
