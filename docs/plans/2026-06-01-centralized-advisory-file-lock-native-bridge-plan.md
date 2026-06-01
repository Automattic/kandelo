# Centralized Advisory File Lock And Native Bridge Plan

Date: 2026-06-01

## Context

Kandelo has only one supported kernel architecture: a centralized Rust kernel
coordinating process state while JS host adapters provide platform primitives.
Earlier decentralized/research paths are not compatibility targets.

Advisory file locking is currently split across Rust and TypeScript:

- Rust parses `fcntl`/`flock` requests, validates access mode, resolves
  `SEEK_SET`/`SEEK_CUR`/`SEEK_END`, owns process/OFD context, and releases some
  locks during close/exit cleanup.
- TS owns a `SharedLockTable` for host-backed files, keyed by a path hash, so
  cross-process Kandelo locks are visible to all workers.
- The kernel calls `host_fcntl_lock` for host-backed files.

That keeps important policy outside the process table and makes future
non-JS host adapters reimplement the same lock-table semantics. At the same
time, a host hook remains valuable: Node hosts can mount native files through
Kandelo's VFS, and those files should eventually coordinate with native OS
programs using OS-level advisory locks.

## Goals

- Move Kandelo-owned advisory lock state into Rust centralized kernel state.
- Preserve support for POSIX byte-range `fcntl`, OFD locks, and BSD `flock`
  mappings already handled by Rust.
- Replace path-hash identity with a stable VFS file identity contract.
- Keep a host/native lock bridge so Node-backed VFS files can reject or acquire
  locks that conflict with native OS processes.
- Make browser/memfs hosts work without native lock support.
- Keep host hooks out of the syscall hot path except for actual lock requests.

## Non-Goals

- Do not preserve earlier decentralized/research behavior.
- Do not move native OS file APIs into Rust Wasm.
- Do not require native locking support in browser hosts.
- Do not implement mandatory locking.
- Do not rely on string paths as the final identity for hard links or renames.

## Current Risk

Path hashes are not a stable file identity. They miss hard-link equivalence,
can become stale across rename, and are vulnerable to collision. A correct
kernel-owned lock table needs identity from the VFS layer, not only the path
used for open.

Native POSIX locks also have surprising ownership rules. Classic `fcntl`
record locks are often per native process, not per file descriptor; closing a
native fd can release locks for that file held by the process. A Node host
acting on behalf of many Kandelo processes cannot treat OS locks as the only
source of truth. Rust must still own Kandelo-internal conflict detection, and
the host bridge must mirror or probe native state carefully.

## Proposed Shape

### 1. Rust-Owned Kandelo Lock Table

Add a kernel-wide advisory lock table, likely owned by `ProcessTable` or an
adjacent kernel resource table. It should track:

- Stable file identity.
- Lock owner: POSIX pid owner or OFD owner.
- Lock kind: read, write, unlock.
- Byte range after `l_whence` resolution.
- Source syscall family: `fcntl`, OFD lock, or `flock` mapping if needed for
  cleanup/debugging.

The table should implement conflict detection, lock replacement, unlock range
splitting/removal, `F_GETLK` reporting, close cleanup, exec cleanup where
applicable, and process-exit cleanup.

### 2. Stable VFS File Identity

Define a versioned identity passed from host VFS adapters to the kernel for
open files. Preferred shape:

- Mount/backend id.
- File id from backend metadata, ideally `(st_dev, st_ino)` for native files.
- Optional generation/version where a backend can provide one.
- Fallback resolved path only for backends that cannot expose a stable id.

The kernel should store this identity on the OFD at open time. Host adapters
must document whether their identities are hard-link aware and rename stable.

### 3. Native Lock Bridge Capability

Keep `host_fcntl_lock` or replace it with a narrower, versioned host hook that
is called only for native-lock-capable identities. The hook should answer:

- Is native locking supported for this file identity?
- Can a requested read/write byte-range lock be acquired without conflicting
  with native OS processes?
- Has the host acquired or mirrored the native lock needed for Kandelo's
  aggregate internal lock state?
- Can the host release or reconcile the native lock when Kandelo unlocks or
  exits?

For browser/memfs hosts, the hook can report unsupported and Rust should rely
only on the internal Kandelo lock table.

### 4. Transaction Boundary

For `F_SETLK`, Rust should:

1. Resolve/validate the requested lock.
2. Check Kandelo-internal conflicts.
3. Ask the native bridge to acquire/probe if the file identity requires native
   coordination.
4. Commit the Rust lock table only after native bridge success.
5. Roll back/reconcile native state if a later step fails.

For `F_UNLCK`, Rust should update the internal table and ask the native bridge
to release or reconcile the aggregate native locks for that file.

`F_SETLKW` needs a separate wait design. Blocking the centralized kernel or a
JS event loop on a native lock is not acceptable. Prefer nonblocking attempts
plus a host retry/wakeup path, or an async native-lock worker that completes
through the existing blocked-syscall machinery.

### 5. Native Bridge Backend Strategy

Do not assume Node has portable native locking built in. Evaluate backend
options separately:

- POSIX `fcntl`/OFD locks via native addon or helper process.
- `flock` where byte-range locking is not required.
- Platform-specific Windows locking if needed later.
- No-op unsupported capability for browser/memfs.

Because native lock ownership semantics can be per-process, the bridge should
maintain a host-side mirror of aggregate native locks per file identity. It
must not let OS lock state replace Rust's internal Kandelo conflict table.

## Migration Slices

1. **Design and tests for Rust lock table semantics.**
   - Add Rust tests for read/read compatibility, write conflicts,
     replacement, partial unlock, `F_GETLK`, `SEEK_END`, OFD owner reporting,
     close cleanup, and process-exit cleanup.
   - No host behavior change.

2. **Introduce stable VFS file identity.**
   - Extend the host/kernel file metadata contract so open OFDs carry stable
     identity.
   - Use existing `st_dev`/`st_ino` where valid.
   - Add tests for hard links, rename, and fallback identity behavior.

3. **Move Kandelo lock table into Rust.**
   - Route host-backed file locking through the Rust table.
   - Remove TS `SharedLockTable` conflict decisions once parity tests pass.
   - Keep host hook disabled or advisory-only in this slice.

4. **Add native bridge capability negotiation.**
   - Extend the host adapter manifest or VFS capability metadata with native
     locking support.
   - Define return codes and transaction semantics for the hook.
   - Add Node tests with an unsupported/no-op bridge first.

5. **Implement Node native locking backend.**
   - Choose backend technology after a focused spike.
   - Add integration tests that verify conflicts with a native process or
     helper holding a lock.
   - Verify cleanup on Kandelo process exit and host teardown.

6. **Remove obsolete TS lock-table code.**
   - Delete `SharedLockTable` only after Rust table and native bridge behavior
     cover the current tests.
   - Keep only host native-lock backend code and minimal VFS capability glue.

## Required Tests

- Rust lock-table unit tests for all conflict/replacement/unlock cases.
- Rust syscall tests for `fcntl`, OFD locks, and `flock` mappings.
- Host integration tests for multiple Kandelo processes locking the same file.
- VFS identity tests covering hard links and rename where backends support them.
- Browser/memfs tests proving unsupported native locking still preserves
  Kandelo-internal advisory locks.
- Node native-bridge tests with an external native process/helper holding a
  conflicting lock.
- Exit/close/exec cleanup regressions.

## Open Questions

- Should native bridge calls receive individual lock operations or a full
  desired aggregate lock snapshot for a file identity?
- Should `F_SETLKW` use existing blocked-syscall retry machinery or a dedicated
  native-lock waiter?
- Which Node native-locking mechanism is acceptable for project dependencies
  and CI?
- What identity fallback is acceptable for backends without stable inode-like
  metadata?
- How should lock state be surfaced in diagnostics or procfs, if at all?
