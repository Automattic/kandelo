# Rust-First Phase 1: runtime-core Crate Split — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (inline, with
> checkpoints) for this plan. This is a single delicate sequential
> refactor (a crate extraction), NOT parallelizable independent tasks, so
> per-task fresh subagents would risk reporting broken intermediate
> states. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extract the engine-agnostic POSIX runtime out of
`crates/kernel` into a new `crates/runtime-core` library, leaving
`crates/kernel` as the thin Wasm FFI shell, with no behavior change.

**Architecture:** `crates/runtime-core` holds every POSIX subsystem
module and the `HostIO` capability trait (re-exported as
`HostCapabilities`). `crates/kernel` keeps only `wasm_api.rs` (the
`WasmHostIO: HostIO` impl that declares the `env` Wasm imports), the
`dlmalloc` global allocator, and the panic handler; it depends on
`runtime-core`. `crates/host-native` (a later phase) will depend on
`runtime-core` directly.

**Tech Stack:** Rust, `no_std` on wasm / std on native (cfg-gated),
Cargo workspace, `build.sh` (builds `kandelo-kernel.wasm`), `cargo test
--workspace`.

**Spec:** `docs/plans/2026-08-25-rust-first-runtime-design.md`

## Global Constraints

- No behavior change. This is a pure refactor; `abi/snapshot.json` and
  the built `kernel.wasm` exports must be unchanged.
- The `#[global_allocator]` and `#[panic_handler]` stay in the final
  cdylib crate (`crates/kernel`), never in the `runtime-core` rlib.
- `runtime-core` MUST NOT depend on `crates/kernel` (no back-reference to
  `wasm_api`). Dependency is one-way: kernel → runtime-core.
- Preserve the `cfg(any(target_arch = "wasm32", target_arch = "wasm64"))`
  `no_std`/`no_main` gating.
- Verify via `scripts/dev-shell.sh`. Rebuild `kernel.wasm` before
  claiming the build is intact. Node/browser parity is unaffected (no TS
  change in this phase) but Vitest must still pass since it loads
  `kernel.wasm`.
- Keep the trait name `HostIO` (645+ call sites); add
  `pub use HostIO as HostCapabilities;` rather than renaming in this
  phase.

---

### Task 0: Confirm one-way dependency direction

**Files:** none (investigation gate).

- [ ] **Step 1: Verify no core module references `wasm_api`**

Run:
```bash
rg -n 'wasm_api' crates/kernel/src --glob '!crates/kernel/src/wasm_api.rs'
```
Expected: no hits (or only comments). If a core module references
`crate::wasm_api::…`, that symbol must first be moved out of `wasm_api.rs`
into a core module before the split; note it and handle before Task 2.

- [ ] **Step 2: Inventory the modules to move**

Run:
```bash
rg -n '^\s*(pub |pub\(crate\) )?mod ' crates/kernel/src/lib.rs
```
Expected: the module list. Everything except `wasm_api` (and the inline
`mod wasm` allocator) moves to `runtime-core`. Record the list.

- [ ] **Step 3: Capture the green baseline**

Run:
```bash
scripts/dev-shell.sh cargo test --workspace --exclude xtask \
  --target $(rustc -vV | awk '/^host/{print $2}') 2>&1 | tail -20
```
Expected: PASS. This is the invariant Task 5 must restore.

---

### Task 1: Scaffold the `runtime-core` crate

**Files:**
- Create: `crates/runtime-core/Cargo.toml`
- Create: `crates/runtime-core/src/lib.rs` (temporary placeholder)
- Modify: root `Cargo.toml` (workspace members) if members are listed
  explicitly

**Interfaces:**
- Produces: crate `runtime_core` (lib name `runtime_core`), depending on
  `wasm-posix-shared` and (wasm-only) nothing else; `spin` as needed.

- [ ] **Step 1: Write `crates/runtime-core/Cargo.toml`**

```toml
[package]
name = "runtime-core"
version.workspace = true
edition.workspace = true

[lib]
name = "runtime_core"
crate-type = ["rlib"]

[dependencies]
spin = { version = "=0.12.2", default-features = false, features = ["mutex", "spin_mutex"] }
wasm-posix-shared = { path = "../shared" }
```

- [ ] **Step 2: Write a placeholder `crates/runtime-core/src/lib.rs`**

```rust
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
extern crate alloc;
extern crate wasm_posix_shared;
```

- [ ] **Step 3: Ensure the workspace includes the crate**

If root `Cargo.toml` lists `members` explicitly, add
`"crates/runtime-core"`. If it globs `crates/*`, no change.

- [ ] **Step 4: Verify it builds**

Run:
```bash
scripts/dev-shell.sh cargo build -p runtime-core \
  --target $(rustc -vV | awk '/^host/{print $2}') 2>&1 | tail -5
```
Expected: PASS (empty crate compiles).

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/Cargo.toml crates/runtime-core/src/lib.rs Cargo.toml
git commit -m "Kernel: Scaffold runtime-core crate for the Rust-first split"
```

---

### Task 1b: Untangle core → `wasm_api` back-references (pre-refactor)

Task 0 found the dependency is not one-way. Fix it BEFORE the move so
`runtime-core` never needs to call back into `crates/kernel`.

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs` (remove 6 helpers), lines
  ~1099-1163: `procfs_all_pids`, `procfs_generate_for_pid`,
  `procfs_readlink_for_pid`, `procfs_has_fd_for_pid`,
  `procfs_fstat_for_pid`, `procfs_getdents64_for_pid`.
- Modify: `crates/kernel/src/procfs.rs` (new home for the 6 helpers) and
  its callers; `crates/kernel/src/syscalls.rs` (repoint call sites).
- Modify: `crates/kernel/src/channel_scratch.rs`,
  `crates/kernel/src/syscalls.rs` — relocate the `include_str!(
  "wasm_api.rs")` source-guard tests to a kernel-side test.

**Interfaces:**
- Produces: `crate::procfs::procfs_all_pids()` etc. (core-owned), reading
  `crate::process_table::GLOBAL_PROCESS_TABLE` directly instead of the
  `wasm_api` `PROCESS_TABLE` alias. Rename any that collide with an
  existing `procfs::` name (e.g. the existing
  `procfs::procfs_getdents64_for_pid(table, …)` — name the moved wrapper
  `procfs_getdents64_for_current_realm_pid` or fold it into the existing
  fn).

- [ ] **Step 1:** Move the 6 helpers into `procfs.rs`, replacing
  `PROCESS_TABLE.0.get()` with
  `crate::process_table::GLOBAL_PROCESS_TABLE.0.get()` (confirm the field
  is reachable; make it `pub(crate)` if needed). Resolve the
  `procfs_getdents64_for_pid` name collision.

- [ ] **Step 2:** Repoint callers: `crate::wasm_api::procfs_*` →
  `crate::procfs::procfs_*` in `procfs.rs` and `syscalls.rs`.

- [ ] **Step 3:** Move the two `include_str!("wasm_api.rs")` guard tests
  out of `channel_scratch.rs`/`syscalls.rs` into a kernel test module
  (they assert shell-source properties, so they belong with the shell).

- [ ] **Step 4: Verify green**

Run:
```bash
scripts/dev-shell.sh cargo test --workspace --exclude xtask \
  --target $(rustc -vV | awk '/^host/{print $2}') 2>&1 | tail -20
```
Expected: PASS. Re-run the Task 0 Step 1 grep — it must now report no
non-comment `crate::wasm_api::` references from core modules.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Kernel: Move cross-process procfs helpers into core ahead of the split"
```

---

### Task 2: Move core modules into `runtime-core`

**Files:**
- Move (git mv): every `crates/kernel/src/<mod>.rs` and `dri/` subtree
  EXCEPT `wasm_api.rs`, into `crates/runtime-core/src/`.
- Rewrite: `crates/runtime-core/src/lib.rs` to declare the moved modules,
  plus the `debug_log` and `current_time_secs` helpers (with their
  wasm/native cfg branches) moved from `crates/kernel/src/lib.rs`.

**Interfaces:**
- Produces: `runtime_core::process::HostIO`, `runtime_core::syscalls::…`,
  and all other subsystem paths, plus `runtime_core::debug_log` and
  `runtime_core::current_time_secs`.

- [ ] **Step 1: git mv the module files** (all core `.rs` + the `dri/`
  directory; NOT `wasm_api.rs`, NOT the inline allocator/panic — those are
  in `lib.rs` and stay with the shell).

```bash
cd crates/kernel/src
for f in audio blocked_retry channel_result channel_scratch credentials \
  descriptor_backing devfs exec_target fd fifo fork ipc ipc_wire lock \
  memory mouse mqueue ofd path complete_copy pipe process \
  process_snapshot_wire process_table process_wire procfs pshared pty \
  scratch_alloc signal socket socket_wire spawn syscalls terminal \
  transfer unix_socket wakeup; do
  git mv "$f.rs" ../../runtime-core/src/"$f.rs"
done
git mv dri ../../runtime-core/src/dri
```

- [ ] **Step 2: Rewrite `crates/runtime-core/src/lib.rs`** to hold the
  module declarations (copied verbatim from the kernel `lib.rs` module
  block, minus `wasm_api`) plus `debug_log`/`current_time_secs` (moved
  from kernel `lib.rs` with their existing cfg branches). Keep
  `#![cfg_attr(..., no_std)]`, `extern crate alloc;`,
  `extern crate wasm_posix_shared;`. Do NOT include `#![no_main]`,
  `#[global_allocator]`, `#[panic_handler]`, or `mod wasm`.

- [ ] **Step 3: Add the trait alias** at the end of `runtime-core`
  `lib.rs`:

```rust
pub use process::HostIO;
pub use process::HostIO as HostCapabilities;
```

- [ ] **Step 4: Build runtime-core natively**

Run:
```bash
scripts/dev-shell.sh cargo build -p runtime-core \
  --target $(rustc -vV | awk '/^host/{print $2}') 2>&1 | tail -30
```
Expected: PASS. Fix any `pub(crate)` visibility that now needs to be
`pub` for cross-module use within the crate (unlikely — same crate) or
any stray `crate::wasm_api` reference surfaced from Task 0.

- [ ] **Step 5: Run runtime-core unit tests** (the moved `#[cfg(test)]`
  modules, including `MockHostIO`)

Run:
```bash
scripts/dev-shell.sh cargo test -p runtime-core \
  --target $(rustc -vV | awk '/^host/{print $2}') 2>&1 | tail -20
```
Expected: the same tests that passed in the kernel crate now pass here.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Kernel: Move POSIX subsystems into runtime-core"
```

---

### Task 3: Reduce `crates/kernel` to the Wasm shell

**Files:**
- Modify: `crates/kernel/Cargo.toml` — add `runtime-core` dependency.
- Modify: `crates/kernel/src/lib.rs` — remove the moved module decls and
  helpers; keep `#![no_std]`/`#![no_main]` gating, `mod wasm`
  (allocator + panic), and `pub mod wasm_api`; re-export runtime-core.
- Modify: `crates/kernel/src/wasm_api.rs` — repoint `crate::…` references
  for moved items to `runtime_core::…`.

**Interfaces:**
- Consumes: `runtime_core::*` (all subsystem paths, `HostIO`,
  `debug_log`, `current_time_secs`).
- Produces: unchanged `kandelo_kernel` cdylib exports.

- [ ] **Step 1: Add the dependency** to `crates/kernel/Cargo.toml`:

```toml
[dependencies]
runtime-core = { path = "../runtime-core" }
spin = { version = "=0.12.2", default-features = false, features = ["mutex", "spin_mutex"] }
wasm-posix-shared = { path = "../shared" }

[target.'cfg(any(target_arch = "wasm32", target_arch = "wasm64"))'.dependencies]
dlmalloc = { version = "0.2.14", default-features = false }
```

- [ ] **Step 2: Rewrite `crates/kernel/src/lib.rs`** to keep only:
  `#![cfg_attr(..., no_std/no_main)]`, `extern crate alloc;`,
  `pub use runtime_core;` (and `pub use runtime_core::*;` if downstream
  expects flat paths), `#[cfg(wasm)] pub mod wasm_api;`, and the
  `#[cfg(wasm)] mod wasm` allocator/panic block. Remove the module decls
  and the `debug_log`/`current_time_secs` definitions now living in
  runtime-core (re-export them: `pub use runtime_core::{debug_log,
  current_time_secs};` if `wasm_api.rs` calls `crate::debug_log`).

- [ ] **Step 3: Repoint `wasm_api.rs`** — change references to moved
  items from `crate::<mod>::…` to `runtime_core::<mod>::…` (e.g.
  `crate::process::HostIO` → `runtime_core::process::HostIO`,
  `crate::syscalls::…` → `runtime_core::syscalls::…`). Do this by
  compiling and fixing each error.

Run (iterate until clean):
```bash
scripts/dev-shell.sh cargo build -p kandelo \
  --target $(rustc -vV | awk '/^host/{print $2}') 2>&1 | tail -40
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Kernel: Reduce kernel crate to the Wasm FFI shell over runtime-core"
```

---

### Task 4: Rebuild the kernel Wasm and confirm ABI unchanged

**Files:** none (verification).

- [ ] **Step 1: Build the kernel wasm**

Run:
```bash
scripts/dev-shell.sh bash build.sh 2>&1 | tail -20
```
Expected: PASS; `local-binaries/kernel.wasm` regenerated.

- [ ] **Step 2: Confirm ABI snapshot unchanged**

Run:
```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh 2>&1 | tail -20
```
Expected: PASS with no snapshot diff (pure refactor changes no ABI).

- [ ] **Step 3: Confirm exports unchanged** (spot-check the export count)

Run:
```bash
git diff --stat abi/snapshot.json
```
Expected: no change to `abi/snapshot.json`.

---

### Task 5: Full workspace + host validation (restore the baseline)

**Files:** none (verification + commit of any generated artifacts).

- [ ] **Step 1: Workspace tests**

Run:
```bash
scripts/dev-shell.sh cargo test --workspace --exclude xtask \
  --target $(rustc -vV | awk '/^host/{print $2}') 2>&1 | tail -20
```
Expected: PASS — identical to the Task 0 baseline.

- [ ] **Step 2: xtask (ABI generation) tests**

Run:
```bash
scripts/dev-shell.sh cargo test -p xtask \
  --target $(rustc -vV | awk '/^host/{print $2}') 2>&1 | tail -20
```
Expected: PASS.

- [ ] **Step 3: Host Vitest (loads kernel.wasm)**

Run:
```bash
cd host && npx vitest run 2>&1 | tail -30
```
Expected: PASS — proves the rebuilt shell kernel behaves identically.

- [ ] **Step 4: Commit any regenerated artifacts** (only if changed)

```bash
git add -A
git commit -m "Kernel: Record runtime-core split validation artifacts" || true
```

---

## Self-Review

- **Spec coverage:** implements the design's crate-layout target
  (`crates/runtime-core` + `crates/kernel` shell + `HostCapabilities`)
  for Phase 1. Later phases (transport, native host, blocking, VFS, fork)
  are separate plans.
- **Placeholders:** none; module list and commands are concrete.
- **Type consistency:** trait is `HostIO` throughout; alias
  `HostCapabilities` added, not a rename.
- **Risk:** the delicate step is Task 3 Step 3 (repointing `wasm_api.rs`);
  it is compiler-driven, so errors are surfaced, not silent.
