# Non-forking `posix_spawn` syscall — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a host-intercepted SYS_SPAWN that constructs a fresh child process without going through fork, so `popen` / `system` / backticks / direct `posix_spawn` no longer pay the fork-instrument unwind cost.

**Architecture:** Mirror the host-intercepted SYS_FORK pattern. New `SYS_SPAWN = 214` is intercepted in `host/src/kernel-worker.ts`, parses a marshalled blob (argv + envp + file actions + attrs) from caller memory, calls a new kernel export `kernel_spawn_process(parent_pid, blob_ptr, blob_len) -> i32` that allocates a child pid, builds the `Process`, applies attrs and file actions to the child's fd table, and returns the pid. Host then launches a fresh process worker for that pid via a new `onSpawn` callback (parallel implementations in Node and Browser host adapters). PATH search lives in the libc overlay (`posix_spawnp.c`).

**Tech Stack:** Rust kernel (no_std on wasm32/64), TypeScript host (kernel-worker.ts, node-kernel-host.ts, browser-kernel.ts), musl-overlay C.

**Reference:** [docs/plans/2026-05-04-non-forking-posix-spawn-design.md](2026-05-04-non-forking-posix-spawn-design.md). One correction vs. the design doc: SYS_SPAWN is host-intercepted (like SYS_FORK), so it lives as a `pub const` in `crates/shared/src/lib.rs::abi` — **not** in the `Syscall` enum.

---

## Task 0: Confirm clean baseline

**Files:** none.

**Step 1: Verify the working tree state**

Run from the worktree root:
```bash
git status --short
git log --oneline -3
```
Expected:
- HEAD is `ce11cfd65` (the design-doc commit) on branch `non-forking-posix_spawn-syscall-implementation`, rebased onto current `origin/main` (`58e0675a9`).
- Working tree may have a dirty `package-lock.json` (auto-name from worktree creation) and `os-test` submodule edits — both pre-existing, leave alone.

**Step 2: Verify the 5 mandatory suites are green at baseline**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -20
```
Expected: 539+ tests pass, 0 failures.

```bash
bash scripts/check-abi-version.sh
```
Expected: exit 0, "ABI snapshot is in sync".

(Skip vitest / libc-test / posix-test for the baseline — too slow; run them at the end.)

If anything is unexpectedly red, **stop and investigate**. Do not proceed.

---

## Task 1: Add SYS_SPAWN constant + bump ABI_VERSION

**Files:**
- Modify: `crates/shared/src/lib.rs` (the `pub mod abi` block, around line 897, and `ABI_VERSION` at line 20)

**Why this comes first:** All downstream code (glue, host, kernel) needs the constant. Bumping `ABI_VERSION` together keeps the snapshot consistent at every commit boundary.

**Step 1: Edit `crates/shared/src/lib.rs`**

Bump `ABI_VERSION`:
```rust
pub const ABI_VERSION: u32 = 8;
```

Inside `pub mod abi`, after `ABI_VALUE_CAPTURE_PREFIXES`, add:
```rust
/// Host-intercepted syscall numbers (caught by `host/src/kernel-worker.ts`
/// before reaching the kernel's syscall dispatcher). The kernel never sees
/// these on the channel — the host calls the corresponding `kernel_*`
/// export directly.
///
/// These exist outside the [`crate::Syscall`] enum because that enum is for
/// kernel-dispatched syscalls only. Adding/removing a value here is an ABI
/// change and requires bumping [`crate::ABI_VERSION`].
pub mod host_intercepted {
    /// Non-forking `posix_spawn` (this kernel's invention; no Linux equivalent).
    /// Host calls `kernel_spawn_process`. See
    /// `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`.
    pub const SYS_SPAWN: u32 = 214;

    /// Documented for completeness — also defined in
    /// `glue/channel_syscall.c` and `host/src/kernel-worker.ts`.
    pub const SYS_EXECVE: u32 = 211;
    pub const SYS_FORK: u32 = 212;
    pub const SYS_VFORK: u32 = 213;
    pub const SYS_EXECVEAT: u32 = 386;
}
```

**Step 2: Regenerate ABI snapshot**

```bash
bash scripts/check-abi-version.sh update
```
Expected: rebuilds kernel wasm, regenerates `abi/snapshot.json`. Then:
```bash
git diff abi/snapshot.json
```
Expected: snapshot adds the new `host_intercepted` mod entries; `ABI_VERSION` field bumps to 8. No other changes.

**Step 3: Verify check-abi-version passes**

```bash
bash scripts/check-abi-version.sh
```
Expected: exit 0.

**Step 4: Commit**

```bash
git add crates/shared/src/lib.rs abi/snapshot.json
git commit -m "abi: reserve SYS_SPAWN=214 + bump ABI_VERSION 7->8

Adds shared::abi::host_intercepted module documenting the host-intercepted
syscall numbers. SYS_SPAWN is the new non-forking spawn primitive; the
existing fork/exec/vfork numbers are added for completeness.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add SYS_SPAWN define to glue

**Files:**
- Modify: `glue/channel_syscall.c` (near the existing `#define SYS_FORK 212` at line 134)

**Step 1: Edit `glue/channel_syscall.c`**

Find the block:
```c
#define SYS_FORK  212
#define SYS_VFORK 213
```
Append:
```c
#define SYS_SPAWN 214  /* non-forking posix_spawn — see docs/plans/2026-05-04-non-forking-posix-spawn-design.md */
```

No dispatcher code change needed — generic 6-arg dispatch handles it.

**Step 2: Verify glue still builds**

```bash
bash build.sh 2>&1 | tail -5
```
Expected: build completes; sysroot regenerated; no errors.

**Step 3: Commit**

```bash
git add glue/channel_syscall.c
git commit -m "glue: define SYS_SPAWN=214 for non-forking posix_spawn

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add fork_count field to Process

**Files:**
- Modify: `crates/kernel/src/process.rs` (Process struct around line 260, constructor around line 346)
- Test: `crates/kernel/src/process.rs` (existing `#[cfg(test)]` block)

**Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block at the bottom of `crates/kernel/src/process.rs`:
```rust
#[test]
fn fork_count_starts_at_zero() {
    let proc = Process::new(1);
    assert_eq!(proc.fork_count(), 0);
}
```

**Step 2: Run test to verify it fails**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib fork_count_starts_at_zero
```
Expected: FAIL with "no method named `fork_count`".

**Step 3: Implement**

In `crates/kernel/src/process.rs`, in the `pub struct Process { ... }` block (after `pub fd_table: FdTable,` around line 262), add:
```rust
/// Counts how many times this process has called fork() (parent side, on success).
/// Read-only from outside the kernel via `kernel_get_fork_count`.
/// Used as a regression guardrail by the spawn test suite to confirm
/// non-forking spawn doesn't sneak through the fork path.
fork_count: u64,
```

In `Process::new` (around line 340), initialize:
```rust
fork_count: 0,
```

Add a getter on `impl Process`:
```rust
pub fn fork_count(&self) -> u64 { self.fork_count }
pub(crate) fn increment_fork_count(&mut self) { self.fork_count += 1; }
```

**Step 4: Run test to verify it passes**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib fork_count_starts_at_zero
```
Expected: PASS.

**Step 5: Run full suite to confirm no regressions**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: same pass count as baseline + 1.

**Step 6: Commit**

```bash
git add crates/kernel/src/process.rs
git commit -m "kernel(process): add per-process fork_count

Used as a regression guardrail by the upcoming non-forking spawn tests.
Read-only outside the kernel; getter exposed via kernel_get_fork_count
in a follow-up commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Bump fork_count in ProcessTable::fork_process

**Files:**
- Modify: `crates/kernel/src/process.rs` (the `fork_process` method — find it via `grep -n 'fn fork_process'`)
- Test: same file

**Step 1: Write the failing test**

Add to the test block:
```rust
#[test]
fn fork_count_bumps_on_successful_fork() {
    let mut table = ProcessTable::new();
    table.create(1).unwrap();
    table.fork_process(1, 2).unwrap();
    let parent = table.get(1).unwrap();
    assert_eq!(parent.fork_count(), 1);
    table.fork_process(1, 3).unwrap();
    assert_eq!(table.get(1).unwrap().fork_count(), 2);
}
```

If `ProcessTable::create` / `ProcessTable::new` don't exist with those exact signatures, adapt the test to use whatever the existing tests in this file use (search the file for the existing test patterns first).

**Step 2: Run to verify it fails**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib fork_count_bumps_on_successful_fork
```
Expected: FAIL (counter stays 0).

**Step 3: Implement**

In `ProcessTable::fork_process`, on the success path (after the child is inserted, before returning `Ok(())`), call `parent.increment_fork_count()` on the parent process. Find the parent via `self.get_mut(parent_pid)`. Be careful: the existing code may have already released a `&mut` to the parent (because of the child clone). If so, re-borrow at the very end.

**Step 4: Run test to verify it passes**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib fork_count_bumps_on_successful_fork
```
Expected: PASS.

**Step 5: Run full suite**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: full suite still green.

**Step 6: Commit**

```bash
git add crates/kernel/src/process.rs
git commit -m "kernel(process): increment fork_count on successful fork_process

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Expose fork_count via `kernel_get_fork_count` export

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs` (near `kernel_fork_process` at line 1070)

**Step 1: Implement**

After the `kernel_fork_process` function in `wasm_api.rs`, add:
```rust
/// Returns the per-process fork counter (parent side, incremented on
/// successful fork). Used by the non-forking spawn test suite as a
/// regression guardrail. Returns u64::MAX as a sentinel if the pid does
/// not exist (so callers can distinguish "no process" from "0 forks").
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_count(pid: u32) -> u64 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => proc.fork_count(),
        None => u64::MAX,
    }
}
```

**Step 2: Regenerate ABI snapshot and verify**

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
```
Expected: only addition is the new `kernel_get_fork_count` export.

```bash
bash scripts/check-abi-version.sh
```
Expected: exit 0 (ABI_VERSION=8 already accommodates this).

**Step 3: Run cargo tests to confirm clean build**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: still green.

**Step 4: Commit**

```bash
git add crates/kernel/src/wasm_api.rs abi/snapshot.json
git commit -m "kernel(wasm_api): export kernel_get_fork_count(pid)

Read-only access to per-process fork counter. Used by upcoming
non-forking spawn tests to assert that spawn doesn't increment the
counter (i.e., doesn't fall back to the fork path).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Define SpawnAttrs and FileAction types in kernel

**Files:**
- Create: `crates/kernel/src/spawn.rs`
- Modify: `crates/kernel/src/lib.rs` (add `pub mod spawn;`)

**Step 1: Create `crates/kernel/src/spawn.rs`**

```rust
//! Non-forking spawn — types shared between the syscall handler
//! (host-side blob parsing in kernel-worker.ts) and the kernel's
//! `ProcessTable::spawn_child` implementation.
//!
//! See `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`.

use crate::shared_imports::*;

/// Bit flags from `posix_spawnattr_t::__flags`. Values match POSIX.
pub mod attr_flags {
    pub const SETPGROUP:  u32 = 0x02;
    pub const SETSIGMASK: u32 = 0x08;
    pub const SETSIGDEF:  u32 = 0x10;
    pub const SETSID:     u32 = 0x80;
}

#[derive(Debug, Clone, Copy)]
pub struct SpawnAttrs {
    pub flags: u32,
    pub pgrp: i32,
    /// 64-bit signal mask (musl uses `unsigned long mask[128/sizeof(long)/8]`
    /// but we only need the first 64 bits — signals 1..64).
    pub sigdef: u64,
    pub sigmask: u64,
}

impl SpawnAttrs {
    pub const fn empty() -> Self {
        Self { flags: 0, pgrp: 0, sigdef: 0, sigmask: 0 }
    }
}

/// One file action from a `posix_spawn_file_actions_t`. Path strings (for
/// Open / Chdir) live in a separate string pool — this type carries the
/// already-resolved bytes.
#[derive(Debug, Clone)]
pub enum FileAction {
    /// FDOP_OPEN: open `path` with `oflag`/`mode`, dup to `fd`, close intermediate.
    Open  { fd: i32, path: alloc::vec::Vec<u8>, oflag: i32, mode: u32 },
    /// FDOP_CLOSE: `close(fd)`. Errors are ignored (POSIX behavior).
    Close { fd: i32 },
    /// FDOP_DUP2: `dup2(srcfd, fd)`. If `srcfd == fd`, clear FD_CLOEXEC.
    Dup2  { srcfd: i32, fd: i32 },
    /// FDOP_CHDIR: `chdir(path)` in the child's view.
    Chdir { path: alloc::vec::Vec<u8> },
    /// FDOP_FCHDIR: `fchdir(fd)` in the child's view.
    Fchdir { fd: i32 },
}
```

You may need to import `alloc` and adapt to whatever no_std setup the kernel uses. Look at the top of an existing kernel module (e.g. `crates/kernel/src/fork.rs`) for the right pattern.

**Step 2: Wire the module**

In `crates/kernel/src/lib.rs`, add `pub mod spawn;` next to the other `pub mod` lines.

**Step 3: Build to verify**

```bash
cargo build -p wasm-posix-kernel --target aarch64-apple-darwin 2>&1 | tail -10
```
Expected: clean build.

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: still green.

**Step 4: Commit**

```bash
git add crates/kernel/src/spawn.rs crates/kernel/src/lib.rs
git commit -m "kernel(spawn): define SpawnAttrs and FileAction types

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Implement ProcessTable::spawn_child (no-actions, no-attrs path)

**Files:**
- Modify: `crates/kernel/src/process.rs` (impl ProcessTable)
- Test: `crates/kernel/src/process.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn spawn_child_basic_inherits_cwd_and_returns_pid() {
    use crate::spawn::{SpawnAttrs, FileAction};
    let mut table = ProcessTable::new();
    table.create(1).unwrap();
    table.get_mut(1).unwrap().set_cwd(b"/tmp".to_vec());

    let child_pid = table.spawn_child(
        1,
        &[b"/bin/echo".as_slice(), b"hi".as_slice()],
        &[b"PATH=/bin".as_slice()],
        &[],
        &SpawnAttrs::empty(),
    ).expect("spawn_child");

    assert_ne!(child_pid, 1, "child pid must differ from parent");
    let child = table.get(child_pid).unwrap();
    assert_eq!(child.cwd(), b"/tmp", "child inherits parent cwd");
    // Critical: spawn must NOT fall back to fork — fork_count must not bump.
    assert_eq!(table.get(1).unwrap().fork_count(), 0);
}
```

(Adjust `set_cwd`/`cwd()` to whatever accessors actually exist on `Process`. Search the file first.)

**Step 2: Run to verify it fails**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib spawn_child_basic_inherits_cwd_and_returns_pid
```
Expected: FAIL ("no method `spawn_child`").

**Step 3: Implement (no actions / no attrs)**

In `impl ProcessTable`, add:
```rust
pub fn spawn_child(
    &mut self,
    parent_pid: u32,
    argv: &[&[u8]],
    envp: &[&[u8]],
    file_actions: &[crate::spawn::FileAction],
    attrs: &crate::spawn::SpawnAttrs,
) -> Result<u32, Errno> {
    // 1. Look up parent (read-only borrow of inheritable state).
    let parent_snapshot = {
        let parent = self.get(parent_pid).ok_or(Errno::ESRCH)?;
        ParentInherit {
            cwd: parent.cwd().to_vec(),
            umask: parent.umask(),
            uid: parent.uid(),
            gid: parent.gid(),
            // ... whatever else fork inherits — match fork_process exactly
        }
    };

    // 2. Allocate next-free pid.
    let child_pid = self.allocate_pid();

    // 3. Build child Process with inherited state.
    let mut child = Process::new(child_pid);
    child.set_cwd(parent_snapshot.cwd);
    child.set_umask(parent_snapshot.umask);
    // ... etc.
    child.set_parent_pid(parent_pid);

    // 4. Clone fd table from parent (same OFD-refcount semantics as fork).
    {
        let parent = self.get(parent_pid).unwrap();
        child.fd_table = parent.fd_table.clone_for_child();  // adapt to actual API
    }

    // 5. Snapshot argv/envp on child (for /proc/<pid>/cmdline).
    child.set_argv_snapshot(argv.iter().map(|s| s.to_vec()).collect());
    child.set_envp_snapshot(envp.iter().map(|s| s.to_vec()).collect());

    // 6. Apply attrs in POSIX order — STUB for now, TODO Task 9.
    let _ = (file_actions, attrs);

    // 7. Insert child into table.
    self.insert(child)?;
    Ok(child_pid)
}

fn allocate_pid(&mut self) -> u32 {
    // Smallest unused pid >= 2.
    let mut p = 2u32;
    while self.contains(p) { p += 1; }
    p
}
```

You will likely need helpers (`set_argv_snapshot`, `set_envp_snapshot`, `clone_for_child`, `contains`, `insert`) that don't exist. Add the minimal versions needed. Match the existing fork code patterns.

**Step 4: Run test to verify it passes**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib spawn_child_basic_inherits_cwd_and_returns_pid
```
Expected: PASS.

**Step 5: Full suite**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: green.

**Step 6: Commit**

```bash
git add crates/kernel/src/process.rs
git commit -m "kernel(process): implement ProcessTable::spawn_child stub

Inherits cwd/umask/uid/gid + clones fd table. File actions and attrs are
applied in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Apply file actions in spawn_child

**Files:**
- Modify: `crates/kernel/src/process.rs` (the stubbed `// 6.` block in `spawn_child`)
- Test: `crates/kernel/src/process.rs`

**Step 1: Write the failing tests (one per action)**

```rust
#[test]
fn spawn_child_applies_close_action() {
    use crate::spawn::{SpawnAttrs, FileAction};
    let mut table = ProcessTable::new();
    table.create(1).unwrap();
    // open fd 5 in parent (use whatever helper your tests use to inject an fd).
    let parent_fd = open_test_fd(&mut table, 1);
    let child = table.spawn_child(
        1, &[b"a".as_slice()], &[],
        &[FileAction::Close { fd: parent_fd }],
        &SpawnAttrs::empty(),
    ).unwrap();
    assert!(table.get(child).unwrap().fd_table.get(parent_fd).is_none());
}

#[test]
fn spawn_child_applies_dup2_action() { /* analogous */ }

#[test]
fn spawn_child_applies_open_action_creates_fd_at_target() { /* analogous */ }

#[test]
fn spawn_child_applies_chdir_action_changes_child_cwd_only() {
    let mut table = ProcessTable::new();
    table.create(1).unwrap();
    table.get_mut(1).unwrap().set_cwd(b"/tmp".to_vec());
    let child = table.spawn_child(
        1, &[b"a".as_slice()], &[],
        &[FileAction::Chdir { path: b"/var".to_vec() }],
        &SpawnAttrs::empty(),
    ).unwrap();
    assert_eq!(table.get(child).unwrap().cwd(), b"/var");
    assert_eq!(table.get(1).unwrap().cwd(), b"/tmp", "parent cwd unchanged");
}

#[test]
fn spawn_child_action_failure_drops_child_returns_errno() {
    let mut table = ProcessTable::new();
    table.create(1).unwrap();
    // close on a closed fd is OK per POSIX (ignored). Use chdir to nonexistent
    // path — that's the error case we want to assert on.
    let err = table.spawn_child(
        1, &[b"a".as_slice()], &[],
        &[FileAction::Chdir { path: b"/does/not/exist".to_vec() }],
        &SpawnAttrs::empty(),
    ).unwrap_err();
    assert_eq!(err, Errno::ENOENT);
    // Child must not be left in the table.
    assert_eq!(table.iter_pids().filter(|p| *p > 1).count(), 0);
}
```

**Step 2: Run to verify they fail**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib spawn_child_applies_
```
Expected: all FAIL.

**Step 3: Implement**

Replace the stub `// 6.` block with file-action application. Apply in **forward** order (matches POSIX). For each action operate on `child.fd_table` (and `child` cwd/etc); never on the parent. On failure, return the errno — `child` falls out of scope without being inserted (since insert hasn't happened yet — make sure step 7 runs only after the loop succeeds).

```rust
for action in file_actions {
    use crate::spawn::FileAction::*;
    match action {
        Close { fd } => { let _ = child.fd_table.close(*fd); }   // POSIX: errors ignored
        Dup2 { srcfd, fd } => {
            if srcfd == fd {
                child.fd_table.clear_cloexec(*fd).map_err(|_| Errno::EBADF)?;
            } else {
                child.fd_table.dup2(*srcfd, *fd)?;
            }
        }
        Open { fd, path, oflag, mode } => {
            // Resolve path against child's *current* cwd (which a prior
            // Chdir action may have updated).
            let opened = open_in_child(&mut child, path, *oflag, *mode)?;
            if opened != *fd {
                child.fd_table.dup2(opened, *fd)?;
                let _ = child.fd_table.close(opened);
            }
        }
        Chdir { path } => { do_chdir_in_child(&mut child, path)?; }
        Fchdir { fd } => { do_fchdir_in_child(&mut child, *fd)?; }
    }
}
```

You will need to factor `open_in_child`, `do_chdir_in_child`, `do_fchdir_in_child` — they should reuse the same VFS code that `sys_open` / `sys_chdir` / `sys_fchdir` use, but operating on a `Process` reference rather than via the syscall path. If those helpers don't exist as factored functions, extract them in this same task.

**Step 4: Run tests to verify they pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib spawn_child_applies_
```
Expected: PASS.

**Step 5: Full suite**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: green.

**Step 6: Commit**

```bash
git add crates/kernel/src/process.rs
git commit -m "kernel(process): apply spawn file actions in forward order

Mutates only the child's fd table and cwd; parent state untouched.
Failure drops the child without inserting into ProcessTable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Apply spawn attrs (SETSID, SETPGROUP, SETSIGMASK, SETSIGDEF)

**Files:**
- Modify: `crates/kernel/src/process.rs` (`spawn_child`)
- Test: same

**Step 1: Write failing tests**

```rust
#[test]
fn spawn_child_setpgroup_lands_in_requested_pgrp() {
    use crate::spawn::{SpawnAttrs, attr_flags};
    let mut table = ProcessTable::new();
    table.create(1).unwrap();
    let attrs = SpawnAttrs {
        flags: attr_flags::SETPGROUP,
        pgrp: 0,  // POSIX: 0 means "child becomes pgrp leader" — child_pid
        sigdef: 0, sigmask: 0,
    };
    let cpid = table.spawn_child(1, &[b"a".as_slice()], &[], &[], &attrs).unwrap();
    assert_eq!(table.get(cpid).unwrap().pgrp(), cpid);
}

#[test]
fn spawn_child_setsid_makes_session_leader() { /* analogous */ }

#[test]
fn spawn_child_setsigmask_overrides_inherited_mask() { /* analogous */ }

#[test]
fn spawn_child_setsigdef_resets_named_handlers_to_default() { /* analogous */ }
```

**Step 2: Run to fail**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib spawn_child_set
```
Expected: all FAIL.

**Step 3: Implement**

Insert the attr block **before** the file-actions block (POSIX order):
```rust
// Apply attrs in POSIX order: SETSID, SETPGROUP, SETSIGMASK, SETSIGDEF.
use crate::spawn::attr_flags;
if attrs.flags & attr_flags::SETSID != 0 {
    child.become_session_leader();   // sets sid = pgrp = pid; releases ctty
}
if attrs.flags & attr_flags::SETPGROUP != 0 {
    let target = if attrs.pgrp == 0 { child.pid } else { attrs.pgrp as u32 };
    child.set_pgrp(target);
}
if attrs.flags & attr_flags::SETSIGMASK != 0 {
    child.set_signal_mask(attrs.sigmask);
}
if attrs.flags & attr_flags::SETSIGDEF != 0 {
    for sig in 1..=64u8 {
        if (attrs.sigdef >> (sig - 1)) & 1 == 1 {
            child.reset_signal_handler(sig);
        }
    }
}
```

Adapt method names to whatever your `Process` exposes. If a needed accessor doesn't exist, add it.

**Step 4: Run tests + full suite**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib spawn_child_set
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: green.

**Step 5: Commit**

```bash
git add crates/kernel/src/process.rs
git commit -m "kernel(process): apply posix_spawn attrs in spawn_child

POSIX order: SETSID -> SETPGROUP -> SETSIGMASK -> SETSIGDEF, before
file actions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Add `kernel_spawn_process` export with blob parsing

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs` (after `kernel_fork_process` at line 1070)
- Modify: `crates/kernel/src/spawn.rs` (add a blob parser)

**Step 1: Add blob parser in `spawn.rs`**

```rust
/// Parses a SYS_SPAWN blob (laid out per
/// docs/plans/2026-05-04-non-forking-posix-spawn-design.md Section 1).
/// Caller passes the raw bytes (host has already copied from caller memory
/// to kernel scratch).
///
/// Returns ParsedBlob with borrowed slices into `bytes` (zero-copy for argv/
/// envp/path strings — caller keeps `bytes` alive until spawn_child returns).
pub struct ParsedBlob<'a> {
    pub argv: alloc::vec::Vec<&'a [u8]>,
    pub envp: alloc::vec::Vec<&'a [u8]>,
    pub file_actions: alloc::vec::Vec<FileAction>,
    pub attrs: SpawnAttrs,
}

pub fn parse_blob(bytes: &[u8]) -> Result<ParsedBlob<'_>, crate::shared_imports::Errno> {
    // Header (40 bytes): argc, envc, n_actions, attr_flags, pgrp, _pad,
    // sigdef, sigmask. Validate sizes ferociously — this is the trust
    // boundary between a user process and the kernel.
    // ... (concrete parsing — return EINVAL on any out-of-bounds read)
}
```

Implement carefully. Use `bytes.get(off..off+n)` and bail with `Errno::EINVAL` on any `None`. Validate `path_off + path_len <= strings_region_len` before slicing.

**Step 2: Add unit tests for the parser**

```rust
#[test]
fn parse_blob_basic_round_trip() { /* construct a blob, parse it, assert fields */ }

#[test]
fn parse_blob_rejects_short_header() { /* truncated bytes -> EINVAL */ }

#[test]
fn parse_blob_rejects_action_path_out_of_bounds() { /* malicious offsets -> EINVAL */ }
```

Run them — they should fail until parser is implemented, then pass.

**Step 3: Add `kernel_spawn_process` export**

In `wasm_api.rs` after `kernel_fork_process`:
```rust
/// Non-forking spawn (centralized mode). Parses the SYS_SPAWN blob from
/// kernel scratch memory, allocates a child pid, builds the child Process
/// with attrs and file actions applied, and inserts it into the
/// ProcessTable. Returns the allocated child pid on success, negated errno
/// on failure.
///
/// The host (kernel-worker.ts handleSpawn) is responsible for copying the
/// blob to scratch and launching the actual process worker after this
/// call returns.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_spawn_process(parent_pid: u32, blob_ptr: usize, blob_len: usize) -> i32 {
    // SAFETY: caller guarantees blob_ptr..blob_ptr+blob_len lives inside
    // the kernel's linear memory and stays valid for this call.
    let bytes = unsafe { core::slice::from_raw_parts(blob_ptr as *const u8, blob_len) };
    let parsed = match crate::spawn::parse_blob(bytes) {
        Ok(p) => p,
        Err(e) => return -(e as i32),
    };
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.spawn_child(parent_pid, &parsed.argv, &parsed.envp, &parsed.file_actions, &parsed.attrs) {
        Ok(child_pid) => child_pid as i32,
        Err(e) => -(e as i32),
    }
}
```

**Step 4: Regenerate ABI snapshot**

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
```
Expected: only addition is `kernel_spawn_process` export.

```bash
bash scripts/check-abi-version.sh
```
Expected: exit 0.

**Step 5: Full suite**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: green.

**Step 6: Commit**

```bash
git add crates/kernel/src/spawn.rs crates/kernel/src/wasm_api.rs abi/snapshot.json
git commit -m "kernel(spawn): export kernel_spawn_process + blob parser

Trust-boundary parser bails with EINVAL on any malformed input. Exposes
the single export the host calls from handleSpawn (next commit).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Add `onSpawn` callback type + `handleSpawn` in kernel-worker.ts

**Files:**
- Modify: `host/src/kernel-worker.ts` (callbacks interface near line 627; main switch near line 1707; new method after `handleFork`)

**Step 1: Add the callback type**

In the `KernelWorkerCallbacks` interface, after `onExec`:
```ts
/**
 * Launch a fresh process worker for an already-allocated child pid.
 * Called by handleSpawn after the kernel has constructed the child
 * Process descriptor in its ProcessTable. The callback resolves the
 * program bytes for `path`, instantiates a new worker registered under
 * `childPid`, and resolves with 0 on success or negative errno on
 * failure (e.g., -ENOENT if path doesn't resolve).
 *
 * Distinct from onExec: onSpawn never replaces the calling worker.
 */
onSpawn?: (childPid: number, path: string, argv: string[], envp: string[]) => Promise<number>;
```

Add the syscall constant near the other `SYS_*` defs (around line 60):
```ts
const SYS_SPAWN = 214;
```

**Step 2: Wire dispatch in the syscall switch**

Find the existing fork dispatch block (around line 1707):
```ts
if (syscallNr === SYS_FORK || syscallNr === SYS_VFORK) {
  this.handleFork(channel, origArgs);
  ...
}
```
Add immediately after:
```ts
if (syscallNr === SYS_SPAWN) {
  this.handleSpawn(channel, origArgs);
  return;
}
```

**Step 3: Implement `handleSpawn`**

After `handleFork` (~line 4923), add:
```ts
/**
 * Handle SYS_SPAWN: read the marshalled blob from caller memory, copy it
 * to kernel scratch, call kernel_spawn_process to allocate a child pid
 * and build the child Process, then call onSpawn to launch the worker.
 *
 * On success: writes the allocated childPid through pid_out_ptr in caller
 * memory, completes the channel with 0.
 * On kernel error: completes channel with the errno; no host worker
 * created.
 * On worker-launch failure: rolls back the kernel-side Process via
 * kernel_remove_process, completes channel with the errno.
 */
private handleSpawn(channel: ChannelInfo, origArgs: number[]): void {
  const parentPid = channel.pid;
  const pathPtr = origArgs[0];
  const pathLen = origArgs[1];
  const blobPtr = origArgs[2];
  const blobLen = origArgs[3];
  const pidOutPtr = origArgs[4];

  // 1. Read path from caller memory.
  const processMem = new Uint8Array(channel.memory.buffer);
  const pathBytes = processMem.slice(pathPtr, pathPtr + pathLen);
  let path = new TextDecoder().decode(pathBytes);
  if (path && !path.startsWith("/")) {
    path = this.resolveExecPathAgainstCwd(parentPid, path);
  }

  // 2. Copy blob from caller memory to kernel scratch.
  const blobBytes = processMem.slice(blobPtr, blobPtr + blobLen);
  const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
  kernelMem.set(blobBytes, this.scratchOffset);
  // Reserve scratch space for the blob during this syscall — note offset
  // and total size for the kernel call.

  // 3. Decode argv/envp out of the blob host-side too (we need them as
  //    string[] for onSpawn). Cheaper than asking the kernel to call back
  //    out for them. Reuse the same blob-format helpers from the kernel
  //    if available, or implement a minimal TS decoder.
  const { argv, envp } = decodeSpawnBlobStrings(blobBytes);

  // 4. Call kernel to allocate child pid + build descriptor.
  const kernelSpawn = this.kernelInstance!.exports.kernel_spawn_process as
    (parentPid: number, blobPtr: bigint, blobLen: number) => number;
  const result = kernelSpawn(parentPid, BigInt(this.scratchOffset), blobLen);
  if (result < 0) {
    this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, (-result) >>> 0);
    return;
  }
  const childPid = result >>> 0;

  // 5. Bump nextChildPid watermark so fork's host-side allocator won't collide.
  if (childPid >= this.nextChildPid) this.nextChildPid = childPid + 1;

  // 6. Track parent-child for waitpid.
  this.childToParent.set(childPid, parentPid);
  let children = this.parentToChildren.get(parentPid);
  if (!children) { children = new Set(); this.parentToChildren.set(parentPid, children); }
  children.add(childPid);

  if (!this.callbacks.onSpawn) {
    // Roll back kernel descriptor — no one will launch the worker.
    const removeProcess = this.kernelInstance!.exports.kernel_remove_process as
      (pid: number) => number;
    removeProcess(childPid);
    this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 38);  // ENOSYS
    return;
  }

  // 7. Launch the worker async; complete channel when done.
  this.callbacks.onSpawn(childPid, path, argv, envp).then((rc) => {
    if (rc < 0) {
      const removeProcess = this.kernelInstance!.exports.kernel_remove_process as
        (pid: number) => number;
      removeProcess(childPid);
      this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, (-rc) >>> 0);
      return;
    }
    // Write pid through pid_out_ptr in caller memory.
    if (pidOutPtr !== 0) {
      const view = new DataView(channel.memory.buffer);
      view.setInt32(pidOutPtr, childPid, true);
    }
    this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, 0, 0);
  }).catch((err) => {
    console.error(`[kernel] spawn error for parent ${parentPid}:`, err);
    const removeProcess = this.kernelInstance!.exports.kernel_remove_process as
      (pid: number) => number;
    removeProcess(childPid);
    this.completeChannel(channel, SYS_SPAWN, origArgs, undefined, -1, 5);  // EIO
  });
}
```

`decodeSpawnBlobStrings` — implement as a small private helper next to handleSpawn that parses just argv/envp out of the blob (offsets table → strings region). Don't duplicate the action/attr parsing here; the kernel already does that.

**Step 4: Verify type-check**

```bash
cd host && npx tsc --noEmit 2>&1 | tail -20
```
Expected: no errors.

**Step 5: Commit**

```bash
cd ..
git add host/src/kernel-worker.ts
git commit -m "host(kernel-worker): handleSpawn for SYS_SPAWN dispatch

Reads blob from caller memory, calls kernel_spawn_process for the kernel-
side descriptor, then onSpawn for the worker launch. Rolls back the
kernel descriptor on worker-launch failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Wire `onSpawn` in Node host

**Files:**
- Modify: `host/src/node-kernel-worker-entry.ts` (handleExec around line 338; pass onSpawn to CentralizedKernelWorker around line 168)
- Modify: `host/src/node-kernel-host.ts` (handle the new spawn_request message; ~line 242)
- Modify: `host/src/node-kernel-protocol.ts` (add new message types)

**Step 1: Add protocol message types**

In `node-kernel-protocol.ts`, alongside `resolve_exec` / `resolve_exec_response`:
```ts
export interface SpawnRequestMessage {
  type: "spawn_request";
  childPid: number;
  path: string;
  argv: string[];
  envp: string[];
}

export interface SpawnResponseMessage {
  type: "spawn_response";
  childPid: number;
  result: number;  // 0 = success, negative = errno
}
```
Add to the union types as appropriate.

**Step 2: Implement `handleSpawn` in `node-kernel-worker-entry.ts`**

Mirror `handleExec`:
```ts
async function handleSpawn(
  childPid: number, path: string, argv: string[], envp: string[],
): Promise<number> {
  const resolved = await resolveExec(path);
  if (!resolved) return -2;  // ENOENT
  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pendingSpawns.set(requestId, resolve);
    post({ type: "spawn_request", requestId, childPid, path, argv, envp, bytes: resolved });
  });
}
```
Wire it as `onSpawn: handleSpawn` in the `new CentralizedKernelWorker(...)` callbacks block (around line 168).

**Step 3: Handle `spawn_request` in `node-kernel-host.ts`**

After the `resolve_exec` case:
```ts
case "spawn_request": {
  const { requestId, childPid, path, argv, envp, bytes } = msg;
  // Launch a fresh worker, registered under childPid. Mirrors the
  // post-fork worker launch path but with provided bytes (no clone).
  this.launchProcessWorker(childPid, bytes, argv, envp).then(() => {
    workerPort.postMessage({ type: "spawn_response", requestId, childPid, result: 0 });
  }).catch((err) => {
    console.error(`[node-host] spawn launch failed:`, err);
    workerPort.postMessage({ type: "spawn_response", requestId, childPid, result: -5 });  // EIO
  });
  break;
}
```
You will need `launchProcessWorker(pid, bytes, argv, envp)` — find the closest existing helper (the post-fork worker spawn path) and refactor it into a callable. Pass `argv`/`envp` so the new worker's `_start` setup can pick them up the same way exec does.

**Step 4: Plumb `spawn_response`**

In the existing message-handling switch in `node-kernel-worker-entry.ts`:
```ts
case "spawn_response": {
  const resolver = pendingSpawns.get(msg.requestId);
  if (resolver) { pendingSpawns.delete(msg.requestId); resolver(msg.result); }
  break;
}
```

**Step 5: Type-check**

```bash
cd host && npx tsc --noEmit 2>&1 | tail -10
```
Expected: clean.

**Step 6: Commit**

```bash
cd ..
git add host/src/node-kernel-protocol.ts host/src/node-kernel-worker-entry.ts host/src/node-kernel-host.ts
git commit -m "host(node): wire onSpawn through node-kernel-host launch path

Adds spawn_request / spawn_response messages parallel to exec resolve.
Reuses the post-fork worker launch path with explicit (argv, envp).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Wire `onSpawn` in Browser host

**Files:**
- Modify: `examples/browser/lib/browser-kernel.ts`
- Possibly: `host/src/browser.ts`, `host/src/worker-adapter-browser.ts`, `host/src/worker-entry-browser.ts`

**Why this is its own task:** Per CLAUDE.md "Two hosts" section, browser and Node have parallel implementations. A Node-only fix leaves the browser broken — the brk-base PR #388 hit this exact regression.

**Step 1: Find the browser-side parallel**

```bash
grep -n "onExec\|onClone\|onFork" examples/browser/lib/browser-kernel.ts host/src/browser.ts host/src/worker-*-browser.ts host/src/worker-entry-browser.ts 2>/dev/null
```
Identify where exec / clone / fork callbacks are wired and how the browser launches process workers.

**Step 2: Mirror the Node `handleSpawn` in browser-kernel.ts**

Add `onSpawn: async (childPid, path, argv, envp) => { ... }` that:
- Resolves `path` to bytes (via the browser's existing program-bytes lookup — same as `onExec`)
- Spawns a Web Worker registered under `childPid`
- Returns 0 on success / negative errno

Reuse the same worker-creation helper that fork uses on the browser side; do NOT replace any existing worker.

**Step 3: Type-check + smoke build**

```bash
cd host && npx tsc --noEmit 2>&1 | tail -10
cd .. && bash build.sh 2>&1 | tail -5
```
Expected: clean.

**Step 4: Commit**

```bash
git add examples/browser/lib/browser-kernel.ts host/src/browser.ts host/src/worker-*-browser.ts host/src/worker-entry-browser.ts
git commit -m "host(browser): wire onSpawn parallel to Node host

Per CLAUDE.md two-hosts policy: spawn/fork/exec/clone all need parallel
browser implementations. Reuses the browser's worker-creation path,
doesn't replace any existing worker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Wire `onSpawn` in run-example.ts

**Files:**
- Modify: `host/src/run-example.ts`

**Step 1: Find where onExec is wired**

```bash
grep -n "onExec\|onFork\|onClone\|builtin.*program\|exec resolver" host/src/run-example.ts
```

**Step 2: Add `onSpawn` to the callbacks block**

Mirror `onExec`: same builtin program map, same fs lookup. The implementation is essentially the Node-host worker-launch logic but called inline (run-example.ts is a node-test harness).

**Step 3: Type-check**

```bash
cd host && npx tsc --noEmit 2>&1 | tail -5
```

**Step 4: Commit**

```bash
cd ..
git add host/src/run-example.ts
git commit -m "host(run-example): wire onSpawn for centralized test harness

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Rewrite `posix_spawn.c` to call SYS_SPAWN

**Files:**
- Modify: `musl-overlay/src/process/wasm32posix/posix_spawn.c` (full rewrite)

**Step 1: Replace the file**

Drop the fork+exec body. New body per design Section 4:
1. Walk `posix_spawn_file_actions_t` to count actions and total path bytes.
2. `alloca` a contiguous blob: header (40 bytes) + argv-offset table + envp-offset table + action records (28 bytes each) + strings region.
3. Fill header (`argc`, `envc`, `n_actions`, `attr_flags`, `pgrp`, padding, `sigdef`, `sigmask`).
4. Pack argv/envp string offsets + copy strings.
5. Walk fdop list **forward** order, emit one 28-byte record per action.
6. `__syscall6(SYS_SPAWN, path, path_len, blob, blob_len, &pid_out, 0)`.
7. Negative ret → return `-ret` as the function's value (POSIX: returns errno directly, doesn't set errno).
8. Zero ret → `*res = pid_out`; return 0.

The complete C source is non-trivial (~150 lines); write it to match the conventions of the existing wasm32posix overlays. Use `__syscall6` from musl's syscall_arch.h.

**Step 2: Build the sysroot**

```bash
bash build.sh 2>&1 | tail -10
```
Expected: clean build.

**Step 3: Commit**

```bash
git add musl-overlay/src/process/wasm32posix/posix_spawn.c
git commit -m "musl-overlay: rewrite posix_spawn to call SYS_SPAWN directly

No fork / no exec. Marshals argv + envp + file actions + attrs into a
contiguous blob and issues a single SYS_SPAWN syscall.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Add `posix_spawnp.c` (PATH search in libc)

**Files:**
- Create: `musl-overlay/src/process/wasm32posix/posix_spawnp.c`

**Step 1: Create the file**

```c
/*
 * posix_spawnp() for wasm32posix — PATH search lives in libc, then delegates
 * to plain posix_spawn() with the resolved absolute path.
 *
 * See docs/plans/2026-05-04-non-forking-posix-spawn-design.md (Q1 Option A).
 */
#define _GNU_SOURCE
#include <spawn.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>

int posix_spawnp(pid_t *restrict res, const char *restrict file,
    const posix_spawn_file_actions_t *fa,
    const posix_spawnattr_t *restrict attr,
    char *const argv[restrict], char *const envp[restrict])
{
    /* Containing slash → no PATH search, plain spawn. */
    if (!file) return EINVAL;
    if (strchr(file, '/'))
        return posix_spawn(res, file, fa, attr, argv, envp);

    const char *path = getenv("PATH");
    if (!path) path = "/usr/local/bin:/bin:/usr/bin";

    /* Walk PATH entries; try each. Match __execvpe's EACCES-defer rule. */
    int saw_eacces = 0;
    char buf[4096];
    const char *p = path;
    while (*p) {
        const char *colon = strchr(p, ':');
        size_t len = colon ? (size_t)(colon - p) : strlen(p);
        if (len == 0) {
            /* empty entry == "." per POSIX */
            buf[0] = '.'; buf[1] = '/'; len = 2;
        } else {
            if (len + 1 + strlen(file) + 1 > sizeof(buf)) {
                p = colon ? colon + 1 : p + len;
                continue;
            }
            memcpy(buf, p, len);
            buf[len] = '/';
            len += 1;
        }
        strcpy(buf + len, file);

        int rc = posix_spawn(res, buf, fa, attr, argv, envp);
        switch (rc) {
        case 0:        return 0;
        case ENOENT:
        case ENOTDIR:  break;          /* try next */
        case EACCES:   saw_eacces = 1; break;
        default:       return rc;       /* hard error */
        }
        if (!colon) break;
        p = colon + 1;
    }
    return saw_eacces ? EACCES : ENOENT;
}
```

**Step 2: Confirm musl picks it up**

```bash
bash build.sh 2>&1 | grep -i "posix_spawnp\|spawnp" | head -5
```
The sysroot rebuild should compile the new file.

**Step 3: Commit**

```bash
git add musl-overlay/src/process/wasm32posix/posix_spawnp.c
git commit -m "musl-overlay: posix_spawnp does PATH search in libc

Walks PATH and calls posix_spawn with the resolved absolute path. Keeps
PATH-search policy in libc (matches what __execvpe does for fork-exec).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Build a small spawn test program

**Files:**
- Create: `examples/spawn-smoke.c`
- Modify: `scripts/build-programs.sh` (add the new program if it has an explicit list)

**Step 1: Create the test program**

```c
/* examples/spawn-smoke.c — exercise posix_spawn from a user process. */
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>
#include <string.h>

extern char **environ;

int main(int argc, char **argv) {
    const char *child_path = (argc > 1) ? argv[1] : "/bin/echo";
    char *child_argv[] = { (char *)child_path, "spawned-ok", NULL };
    pid_t pid;
    int rc = posix_spawn(&pid, child_path, NULL, NULL, child_argv, environ);
    if (rc != 0) {
        fprintf(stderr, "posix_spawn: %s\n", strerror(rc));
        return 1;
    }
    int status;
    if (waitpid(pid, &status, 0) < 0) { perror("waitpid"); return 2; }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "child exited %d (signal %d)\n",
                WEXITSTATUS(status), WTERMSIG(status));
        return 3;
    }
    printf("OK\n");
    return 0;
}
```

**Step 2: Build it**

```bash
scripts/build-programs.sh 2>&1 | grep -i spawn
```
Expected: `spawn-smoke.wasm` produced under the standard examples build dir.

**Step 3: Commit**

```bash
git add examples/spawn-smoke.c scripts/build-programs.sh
git commit -m "examples: spawn-smoke.c minimal posix_spawn test program

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Vitest — basic spawn flow + fork-counter regression check

**Files:**
- Create: `host/test/centralized-spawn.test.ts`

**Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";  // existing helper

describe("non-forking posix_spawn", () => {
  it("runs spawn-smoke and the parent's fork count is 0", async () => {
    const result = await runCentralizedProgram({
      program: "spawn-smoke.wasm",
      args: ["/bin/echo"],
      assertExitCode: 0,
      // NEW helper-level assertion (see step 2 if not already present):
      assertParentForkCountAfter: 0,
    });
    expect(result.stdout).toContain("OK");
    expect(result.parentForkCount).toBe(0);  // GUARDRAIL
  });
});
```

**Step 2: Extend the helper to expose parent fork count**

In `host/test/centralized-test-helper.ts`, after the program runs, query
`kernel.kernelInstance.exports.kernel_get_fork_count(parentPid)` and surface
on the result object.

**Step 3: Run**

```bash
cd host && npx vitest run centralized-spawn 2>&1 | tail -10
```
Expected: PASS with `parentForkCount === 0`.

If `parentForkCount > 0`, the spawn path is silently falling back to fork — investigate before continuing.

**Step 4: Commit**

```bash
cd ..
git add host/test/centralized-spawn.test.ts host/test/centralized-test-helper.ts
git commit -m "host(test): basic spawn flow + fork-counter regression guardrail

Asserts parent's kernel_get_fork_count delta is 0 across a posix_spawn —
this is the load-bearing test that catches a regression to the fork
path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Vitest — popen / system / spawnp / file actions / SETPGROUP

**Files:**
- Modify: `host/test/centralized-spawn.test.ts` (add cases)
- Create: `examples/spawn-popen-smoke.c`, `examples/spawn-spawnp-smoke.c`, `examples/spawn-fileactions-smoke.c`, `examples/spawn-setpgroup-smoke.c`

**Step 1: For each scenario:**

Write a small C program that exercises the API; add it to `scripts/build-programs.sh`; add a vitest case that runs it and asserts:
- exit code 0
- expected stdout
- `parentForkCount === 0` (still the regression guardrail)

Scenarios:
- `popen("/bin/echo hi", "r")` then `pclose` → reads "hi", returns 0
- `system("/bin/true")` → returns 0
- `posix_spawnp("dash", ...)` → finds /usr/bin/dash via PATH, runs it
- `posix_spawn` with `addopen` + `dup2` to set up child stdin from a file
- `posix_spawn` with `POSIX_SPAWN_SETPGROUP` then `getpgid(child_pid)` returns the requested pgrp

**Step 2: Run**

```bash
cd host && npx vitest run centralized-spawn 2>&1 | tail -20
```
Expected: all PASS.

**Step 3: Commit**

```bash
cd ..
git add examples/spawn-*.c scripts/build-programs.sh host/test/centralized-spawn.test.ts
git commit -m "test(spawn): popen, system, spawnp, file actions, SETPGROUP coverage

All cases assert parent fork count remains 0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 20: Browser-host test parity

**Files:**
- Modify: `host/test/browser-worker-adapter.test.ts` or `examples/browser/test/`

**Why:** CLAUDE.md two-hosts policy. A Node-only test does not protect the browser path.

**Step 1: Find the closest existing browser test**

```bash
ls host/test/browser-* examples/browser/test/ 2>/dev/null
```

**Step 2: Add a single browser test for spawn-smoke**

Mirror the Node test but use the browser host adapter. Asserts the same fork-counter delta.

**Step 3: Run**

```bash
cd host && npx vitest run browser-worker-adapter 2>&1 | tail -10
```
Expected: PASS.

**Step 4: Commit**

```bash
cd ..
git add host/test/browser-worker-adapter.test.ts examples/browser/test/
git commit -m "test(browser): spawn parity test on the browser host

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 21: Documentation updates

**Files:**
- Modify: `docs/posix-status.md`
- Modify: `docs/architecture.md`

**Step 1: posix-status**

In the relevant table/section, change posix_spawn's status to note that it's now non-forking (kernel-level SYS_SPAWN, no fork-instrument unwind).

**Step 2: architecture**

In the syscall + process model section, add a paragraph on SYS_SPAWN: host-intercepted, parses a marshalled blob (argv/envp/file_actions/attrs), kernel allocates the child pid via `kernel_spawn_process`, host launches a fresh worker via `onSpawn`. Reference the design doc.

**Step 3: Commit**

```bash
git add docs/posix-status.md docs/architecture.md
git commit -m "docs: SYS_SPAWN non-forking spawn architecture + status

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 22: Final verification — run all 5 mandatory suites

**Files:** none (read-only verification).

Per CLAUDE.md, ALL of these must pass before claiming done. Run them in order; if any fails, stop and fix.

**Step 1: Cargo**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -10
```
Expected: 539+ pass, 0 failures (plus the new spawn unit tests).

**Step 2: Vitest**

```bash
cd host && npx vitest run 2>&1 | tail -20
cd ..
```
Expected: all files pass.

**Step 3: musl libc-test**

```bash
scripts/run-libc-tests.sh 2>&1 | tail -20
```
Expected: 0 unexpected FAILs. XFAIL/TIME OK. The musl `posix_spawn` test must move from XFAIL/FAIL (if it was) to PASS, OR remain whatever it was if it doesn't exercise our path.

**Step 4: Open POSIX Test Suite**

```bash
scripts/run-posix-tests.sh 2>&1 | tail -20
```
Expected: 0 FAIL. UNRES/SKIP OK. posix_spawn / posix_spawnp directories must hold or improve.

**Step 5: ABI snapshot**

```bash
bash scripts/check-abi-version.sh
```
Expected: exit 0.

**Step 6: Optional benchmark — measure the win**

```bash
npx tsx benchmarks/run.ts --suite=process-lifecycle --rounds=3 2>&1 | tail -20
```
Compare popen/system/spawn timings to a pre-change baseline (`git stash` the implementation, rerun, compare). Expected: substantial improvement (the whole point of this work).

---

## Task 23: Open the PR

**Step 1: Push the branch**

```bash
git push -u origin non-forking-posix_spawn-syscall-implementation
```

**Step 2: Open PR**

```bash
gh pr create --title "feat(kernel): non-forking SYS_SPAWN; ABI 7->8" --body "$(cat <<'EOF'
## Summary

- New host-intercepted `SYS_SPAWN = 214` syscall: `popen`, `system`, backticks, and direct `posix_spawn`/`posix_spawnp` no longer go through fork. Eliminates the parent-memory copy and fork-instrument unwind on every shell-out.
- `posix_spawnp` does PATH search in libc, then calls plain `posix_spawn` with the resolved absolute path (matches what `__execvpe` does for fork-exec).
- All four POSIX spawn attributes are marshalled in the blob and applied kernel-side (`SETSIGDEF` / `SETSID` / `SETPGROUP` / `SETSIGMASK`).
- Per-process `fork_count` exposed via `kernel_get_fork_count(pid)` — used by every spawn test as a regression guardrail (asserts the parent's count doesn't bump across a spawn).
- ABI bump 7 → 8: new `kernel_spawn_process` + `kernel_get_fork_count` exports; new `shared::abi::host_intercepted::SYS_SPAWN = 214` constant.
- Both host adapters (Node + Browser) wired with parallel `onSpawn` callbacks per CLAUDE.md two-hosts policy.

## Out of scope (explicit non-goals)

- `pcntl_fork()` / FPM master→worker fork (still need parent-memory copy semantics).
- `vfork()` (could be routed through SYS_SPAWN later; not needed for popen/system).
- Any PHP work.
- Cleaning up the host-side `nextChildPid` allocator wart (worked around by reading the kernel-allocated pid).

## Design

[docs/plans/2026-05-04-non-forking-posix-spawn-design.md](docs/plans/2026-05-04-non-forking-posix-spawn-design.md)

## Test plan

- [x] `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` — green, includes new spawn unit tests
- [x] `cd host && npx vitest run` — green, includes `centralized-spawn.test.ts` + browser parity
- [x] `scripts/run-libc-tests.sh` — 0 unexpected FAIL
- [x] `scripts/run-posix-tests.sh` — 0 FAIL
- [x] `bash scripts/check-abi-version.sh` — clean (ABI bumped 7 → 8)
- [x] Each spawn test asserts `kernel_get_fork_count(parentPid) === 0` — guardrail against silent regression to the fork path

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Done.** The PR is the merge gate; CI runs the suites again on the PR branch.
