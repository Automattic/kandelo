# Phase 11: Final Tractable POSIX Gaps

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement remaining POSIX APIs that are tractable without multi-worker or Asyncify.

**Tech Stack:** Rust (no_std compatible), wasm32-unknown-unknown target

**Test command:** `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`

---

## Task 1: Add truncate, fdatasync, fchmod, fchown

**Files:**
- Modify: `crates/kernel/src/process.rs` — add host_fchmod, host_fchown to HostIO
- Modify: `crates/kernel/src/syscalls.rs` — add sys_truncate, sys_fdatasync, sys_fchmod, sys_fchown
- Modify: `crates/shared/src/lib.rs` — add syscall numbers
- Modify: `crates/kernel/src/wasm_api.rs` — add exports + WasmHostIO impls

**Implementation:**
- truncate(path, length): open(path, O_WRONLY) → ftruncate(fd, length) → close(fd)
- fdatasync(fd): alias to sys_fsync (no metadata distinction in Wasm)
- fchmod(fd, mode): validate fd is regular file, delegate to new host_fchmod(handle, mode)
- fchown(fd, uid, gid): validate fd is regular file, delegate to new host_fchown(handle, uid, gid)

## Task 2: Add process group and session APIs (simulated)

**Files:**
- Modify: `crates/kernel/src/process.rs` — add pgid, sid to Process
- Modify: `crates/kernel/src/syscalls.rs` — add sys_getpgrp, sys_setpgid, sys_getsid, sys_setsid
- Modify: `crates/shared/src/lib.rs` — add syscall numbers
- Modify: `crates/kernel/src/wasm_api.rs` — add exports

**Implementation:**
- getpgrp(): return proc.pgid (default = proc.pid)
- setpgid(pid, pgid): if pid == 0 or pid == proc.pid, set proc.pgid = pgid (or proc.pid if pgid == 0)
- getsid(pid): if pid == 0 or pid == proc.pid, return proc.sid
- setsid(): set proc.sid = proc.pid, proc.pgid = proc.pid, return proc.sid

## Task 3: Add *at() variants (fstatat, unlinkat, mkdirat, renameat)

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_fstatat, sys_unlinkat, sys_mkdirat, sys_renameat
- Modify: `crates/shared/src/lib.rs` — add syscall numbers + AT_REMOVEDIR constant
- Modify: `crates/kernel/src/wasm_api.rs` — add exports

**Implementation:**
All *at() variants follow the same pattern as openat():
- If dirfd == AT_FDCWD: delegate to the non-at version with path resolved via cwd
- If path is absolute: ignore dirfd, delegate to non-at version
- Otherwise: return ENOSYS (directory fd path resolution deferred)

## Task 4: Update docs and TypeScript wrappers

Update posix-status.md and host/src/kernel.ts.
