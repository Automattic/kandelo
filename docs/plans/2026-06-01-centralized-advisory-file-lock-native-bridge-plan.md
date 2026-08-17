# Centralized Advisory File Lock And Native Bridge Plan

Date: 2026-06-01

Status: Kandelo-owned lock authority implemented in Rust on 2026-07-15;
native coordination with programs outside Kandelo remains unimplemented and is
not implied by the current POSIX support claim.

## Context

Kandelo has one supported kernel architecture: a centralized Rust kernel
coordinates process state while JavaScript host adapters provide platform
primitives. Earlier decentralized research paths are not compatibility
targets.

At the time of this design, advisory file locking was split across Rust and
TypeScript:

- Rust parsed `fcntl`/`flock` requests, validated access mode, resolved
  `SEEK_SET`/`SEEK_CUR`/`SEEK_END`, owned process and open-file-description
  context, and released some locks during close/exit cleanup.
- TypeScript owned a `SharedLockTable` for host-backed files, keyed by a path
  hash, so locks were visible to Kandelo workers.
- The kernel called `host_fcntl_lock` for host-backed files.

That split kept platform policy outside the process table and required future
non-JavaScript hosts to reproduce lock semantics. A distinct host hook may
still be valuable: Node can mount native files, and those files may need to
coordinate with native operating-system programs. That external bridge is not
part of Kandelo's current internal lock authority.

## Goals

- Move Kandelo-owned advisory lock state into the centralized Rust kernel.
- Preserve POSIX byte-range `fcntl`, open-file-description (OFD) locks, and BSD
  `flock` mappings already handled by Rust.
- Replace path-hash identity with stable VFS file identity.
- Keep any future host/native lock bridge separate from Kandelo conflict
  decisions.
- Preserve correct browser/memfs behavior without native lock support.
- Keep host hooks out of the syscall hot path except for lock requests that
  genuinely require a native bridge.

## Non-goals

- Do not preserve decentralized research behavior.
- Do not move native operating-system file APIs into Rust WebAssembly.
- Do not require native locking support in browsers.
- Do not implement mandatory locking.
- Do not use string paths as final identity across hard links or renames.
- Do not treat Linux-specific native locking behavior as a general Kandelo
  compatibility goal.

## Current implementation

The July implementation completed the Kandelo-owned portion:

- `ProcessTable` owns the machine-wide `AdvisoryLockManager`.
- Each host-backed file uses exact `(st_dev, st_ino)` identity when available;
  in-kernel files use typed kernel object identity.
- Each open file description has a stable `OfdId` carried across descriptor
  duplication, fork, exec-surviving descriptors, and descriptor transfer.
- Rust owns conflict detection, range replacement/splitting, `F_GETLK`,
  `F_SETLK`, blocking retry state, OFD/flock namespaces, bounded capacity,
  wakeups, and close/process cleanup.
- Node and browser hosts no longer provide a `SharedLockTable` authority.

This solves locking among Kandelo processes. It does not prove that a Kandelo
lock conflicts with a separate native program holding a lock on the same
host-backed inode.

## Design rationale

### Rust-owned Kandelo lock table

The kernel-wide table tracks:

- Stable file identity.
- Lock owner: POSIX process, OFD, or `flock` owner.
- Lock kind: read, write, or unlock operation.
- Normalized byte range after `l_whence` resolution.
- Independent POSIX/OFD and `flock` conflict namespaces where required.

It implements conflict detection, lock replacement, partial unlock,
`F_GETLK`, final-OFD cleanup, and process cleanup. Rust remains the sole source
of truth even if a native bridge is added later.

### Stable VFS file identity

The implemented identity is carried on the open file description:

- Native-backed files use `(st_dev, st_ino)` from the live host handle.
- In-kernel regular-file-like objects use a typed kernel object identifier.
- The identity follows the OFD instead of being recomputed from a pathname.

This is hard-link aware and rename stable where the backend supplies real
device/inode identity. Backends that cannot prove stable identity must expose
that limitation rather than substitute a path hash silently.

### Optional native lock bridge

Any future bridge should be a narrow, versioned host capability called only
for native-lock-capable file identities. It must answer:

- Whether native locking is supported for this file.
- Whether the requested byte-range lock conflicts with an external process.
- Whether the host acquired or mirrored the native state needed for Kandelo's
  aggregate internal state.
- Whether unlock/exit reconciliation completed.

Browser and in-memory hosts would report that no native surface exists; Rust
would continue using its internal table.

### Transaction boundary

For `F_SETLK`, a bridge-enabled future implementation should:

1. Resolve and validate the request.
2. Check Kandelo-internal conflicts.
3. Ask the native bridge to acquire or probe when the file requires it.
4. Commit the Rust table only after native success.
5. Reconcile native state if a later step fails.

For unlock, Rust should update internal state and ask the bridge to reconcile
the aggregate native state for the file.

`F_SETLKW` requires asynchronous retry. Blocking the centralized kernel or a
JavaScript event loop on a native lock is not acceptable. A bridge would need
nonblocking attempts plus Kandelo's blocked-syscall retry/wakeup machinery, or
a dedicated native-lock worker that completes through the same contract.

### Native backend constraints

Node does not expose portable native byte-range locking in its standard file
API. Candidate backends need a separate, focused evaluation:

- POSIX `fcntl` or OFD locks through a native addon or helper process.
- `flock` only where whole-file locking is sufficient.
- Platform-specific Windows locking if that platform becomes in scope.
- An explicit unsupported capability for browser/memfs.

Native POSIX lock ownership is often per native process rather than per file
descriptor; closing one descriptor can release locks held through another.
Because one Node host represents many Kandelo processes, operating-system lock
state cannot replace the Rust conflict table. A bridge must mirror aggregate
native state per stable file identity.

## Migration record

1. **Rust lock-table semantics — implemented.**
   - Covers read/read compatibility, write conflicts, replacement, partial
     unlock, `F_GETLK`, `SEEK_END`, OFD ownership, cleanup, and capacity.
2. **Stable VFS file identity — implemented for current backends.**
   - Uses host device/inode identity and typed kernel object identity.
3. **Kandelo lock authority in Rust — implemented.**
   - Removed TypeScript conflict decisions and path-hash ownership.
4. **Native bridge capability negotiation — not implemented.**
   - Requires an explicit ABI/capability design and Node/browser parity
     treatment before code changes.
5. **Node native locking backend — not implemented.**
   - Requires a dependency and CI strategy plus external-process tests.
6. **Obsolete TypeScript table removal — implemented.**
   - Hosts retain only the platform work still required for ordinary VFS I/O.

## Required evidence for a native bridge

- Existing Rust lock-manager and syscall suites remain green.
- Multiple Kandelo processes coordinate on one file across fork, exec,
  descriptor transfer, rename, and final close.
- Browser/memfs retains correct internal advisory locking without a native
  capability.
- Node tests use an external native process or helper to hold a conflicting
  lock.
- Acquisition failure leaves the Rust table unchanged.
- Commit failure reconciles any native lock already acquired.
- Unlock, process exit, exec, host failure, and kernel teardown do not leak
  native state.
- Performance measurement shows no extra host crossing on non-lock syscalls.

## Open questions

- Should a native bridge receive individual operations or the complete desired
  aggregate lock state for one file identity?
- Should native `F_SETLKW` reuse existing blocked-syscall retry machinery or a
  dedicated native-lock waiter?
- Which Node native-lock mechanism is acceptable for dependencies, supported
  operating systems, and continuous integration?
- What truthful failure should a host return when external native coordination
  is requested but unavailable?
- Should lock state be exposed in diagnostics or procfs?
