# Phase 12: Remaining Tractable POSIX APIs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the last set of POSIX APIs that are tractable without multi-worker, Asyncify, or host network stack.

**Tech Stack:** Rust (no_std compatible), wasm32-unknown-unknown target

**Test command:** `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo`

---

## Task 1: Add remaining *at() variants (faccessat, fchmodat, fchownat, linkat, symlinkat, readlinkat)

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_faccessat, sys_fchmodat, sys_fchownat, sys_linkat, sys_symlinkat, sys_readlinkat
- Modify: `crates/shared/src/lib.rs` — add syscall numbers
- Modify: `crates/kernel/src/wasm_api.rs` — add exports

**Implementation:**
All follow the established *at() pattern:
- If dirfd == AT_FDCWD: delegate to the non-at version
- If path is absolute: ignore dirfd, delegate to non-at version
- Otherwise: return ENOSYS (directory fd path resolution deferred)

Special cases:
- linkat has two dirfds (olddirfd, newdirfd) — both must be AT_FDCWD or paths absolute
- symlinkat: target path is not resolved, linkdirfd applies only to linkpath
- fchmodat/fchownat: AT_SYMLINK_NOFOLLOW flag support (delegates to lstat-based check)

## Task 2: Add select() as wrapper around poll()

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_select
- Modify: `crates/shared/src/lib.rs` — add syscall number, FD_SETSIZE constant
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_select export

**Implementation:**
select(nfds, readfds_bits, writefds_bits, exceptfds_bits, timeout) -> number ready

At the wasm_api level:
1. Parse fd_set bitmasks from Wasm memory (128 bytes each = 1024 bits)
2. Build pollfd array: for each set bit in readfds/writefds/exceptfds, create pollfd entry
3. Call existing sys_poll
4. Convert revents back to fd_set format
5. Return count of ready fds

fd_set operations:
- FD_ISSET(fd, set) = (set[fd/8] >> (fd%8)) & 1
- FD_SET(fd, set) = set[fd/8] |= (1 << (fd%8))
- FD_CLR(fd, set) = set[fd/8] &= !(1 << (fd%8))
- FD_ZERO(set) = memset(set, 0, 128)

## Task 3: Add setuid/setgid/seteuid/setegid (simulated)

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_setuid, sys_setgid, sys_seteuid, sys_setegid
- Modify: `crates/shared/src/lib.rs` — add syscall numbers
- Modify: `crates/kernel/src/wasm_api.rs` — add exports

**Implementation:**
These are simulated, matching the existing getuid/getgid pattern:
- setuid(uid): proc.uid = uid; proc.euid = uid
- setgid(gid): proc.gid = gid; proc.egid = gid
- seteuid(euid): proc.euid = euid
- setegid(egid): proc.egid = egid

No privilege checking (no real privilege separation in Wasm).

## Task 4: Add getrusage (simulated)

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_getrusage
- Modify: `crates/shared/src/lib.rs` — add syscall number, RUSAGE_SELF/RUSAGE_CHILDREN constants
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_getrusage export

**Implementation:**
getrusage returns resource usage statistics. The Wasm runtime currently has limited resource accounting, so most values are zero. We can populate:
- ru_utime: delegate to host clock (CLOCK_MONOTONIC elapsed since process start)
- ru_stime: 0 (no kernel time tracking)
- All other fields: 0

The rusage struct in Wasm memory (repr(C)):
- ru_utime: {tv_sec: i64, tv_usec: i64} (16 bytes)
- ru_stime: {tv_sec: i64, tv_usec: i64} (16 bytes)
- 14 more i64 fields (all 0): maxrss, ixrss, idrss, isrss, minflt, majflt, nswap, inblock, oublock, msgsnd, msgrcv, nsignals, nvcsw, nivcsw (112 bytes)
Total: 144 bytes

## Task 5: Update docs and TypeScript wrappers

Update posix-status.md and host/src/kernel.ts.
