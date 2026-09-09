# K13a Grounding — Deleting the dead `kernel_*` exports

> Read-only grounding pass, 2026-09-09. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `brandonpayton/rust-first-abi44-reconcile` (head of PR #1350).
> No code was modified by this pass; this file is its only output.
>
> Companion records: `docs/plans/2026-09-09-rust-first-value-plan.md` (§2
> settled facts), `docs/plans/2026-09-09-whole-kernel-rust-migration-census.md`
> (§10 work items, §12 method). Binding: `docs/agent-guidance/abi.md`,
> `docs/abi-versioning.md`, `docs/agent-guidance/validation.md`.

---

## 0. Headline — two of the "26 dead" are LIVE

**`kernel_time` and `kernel_brk` are not dead.** Both are called from the Rust
channel dispatcher and must **not** be deleted. They are *dispatch-only*
exports and belong in K13b's privatization set, not K13a's deletion set.

| export | live caller | VERIFIED |
|---|---|---|
| `kernel_time` | `crates/kernel/src/wasm_api.rs:3933` — `(66, ChannelResultKind::I64) => ChannelDispatchOutcome::exact(kernel_time())` inside `dispatch_channel_wide_result` | yes |
| `kernel_brk` | `crates/kernel/src/wasm_api.rs:3946` — `.map(\|address\| kernel_brk(address))` for syscall 48 inside `dispatch_channel_wide_result` | yes |

**Why the census missed them.** `dispatch_channel_wide_result`
(`wasm_api.rs:3924-3948`) sits *just above* the line range the census used for
"dispatch-only" attribution (`dispatch_channel_syscall`, 3960–6444). It is a
separate function that `dispatch_channel_syscall` delegates the 64-bit and
process-address results to, so its two direct export calls fell outside the
window.

A second, independent methodological hazard is worth recording because it can
silently produce a "zero callers" answer for *any* name: **`git grep -E '\b…\b'`
matches nothing in this repo.** `git grep`'s ERE engine does not implement
`\b`. Every one of the 26 names returns `0` hits under `-E`, including its own
definition line. `git grep -P '\b…\b'` works correctly. All counts in this
document were produced with `-P`, cross-checked against an unanchored
`grep -rIn` over the whole working tree (tracked *and* untracked files), and
cross-checked against the export section of the built kernel Wasm.

Corrected decomposition of the 336 declared `pub extern "C"` functions
(`grep -c 'pub extern "C" fn' crates/kernel/src/wasm_api.rs` = **336**,
VERIFIED):

| class | census | corrected |
|---|---|---|
| TS-only | 154 | 154 |
| both (TS + dispatch) | 35 | 35 |
| dispatch-only (privatize in K13b) | 117 | **119** |
| **dead (delete in K13a)** | **26** | **24** |
| test-only | 2 | 2 |
| native-only | 1 | 1 |
| `__abi_version` | 1 | 1 |
| total | 336 | 336 |

---

## 1. Verification method

Five independent passes. Each finding below is labelled VERIFIED (a command was
run and its output inspected) or INFERRED (reasoning from inspected code).

1. **Exact word-boundary search over tracked files** —
   `git grep -P '\b<name>\b' -- .` for each of the 28 candidate names
   (26 claimed-dead + 2 test-only). VERIFIED.
2. **Whole-working-tree search including untracked files** —
   `grep -rInE '(<name>|…)' .` excluding `.git`, `node_modules`, `target`,
   `dist`. This is how `run.sh`'s `KERNEL_REQUIRED_EXPORTS` array and the
   untracked `task-*.md` reports were swept in. VERIFIED.
3. **Dynamic / string-constructed access sweep** — `exports[…]` indexing across
   `host/src`, `crates`, `web-libs`, `apps`, `scripts`, `tools`;
   `"kernel_" +` and `` `kernel_${` `` concatenation; `#[export_name]`
   attributes; `concat_idents!` / `paste!` name synthesis in the kernel crate.
   VERIFIED — **no** name in the 28 is reachable by any dynamic path. The only
   two variable-name export lookups in `kernel-worker.ts`
   (`:5646` → `kernel_get_cwd` / `kernel_get_dirfd_path` /
   `kernel_get_fd_path`; `:33798` → `kernel_msqid_ds_bytes` /
   `kernel_shmid_ds_bytes`) select from string literals that a plain grep
   already sees, and none of them names a candidate.
4. **Required/forbidden export policy lists** — the ABI snapshot's
   `host_adapter.required_kernel_exports` (82 entries) and
   `optional_kernel_exports` (4), `run.sh`'s `KERNEL_REQUIRED_EXPORTS` array
   (80 entries), `host/src/binary-resolver.ts`'s `requiredExportsForRelPath`
   (which returns `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` for `kernel.wasm`) and
   `forbiddenExportsForRelPath` (`LEGACY_KERNEL_EXEC_EXPORTS`, 5 entries), and
   the Wasm export names hard-coded in `scripts/wasm-artifact-guards.sh`,
   `scripts/test-wasm-artifact-guards.sh`,
   `scripts/test-install-local-binary-sealed.sh`. VERIFIED — the intersection
   with the 28 is **empty** in every list.
5. **Built-artifact export section** — a minimal Python Wasm section parser over
   `target/wasm32-unknown-unknown/release/kandelo_kernel.wasm` (built
   2026-09-08). 339 exports total, 335 `kernel_*`. All 28 candidates are
   present. VERIFIED. This confirms deletion actually changes the shipped
   artifact and the snapshot, i.e. the work is real subtraction.

---

## 2. Question 1 — is each of the 26 truly unreferenced?

**24 of 26: YES, confirmed dead** (no caller anywhere: not in `crates/`, not in
`host/src`, not in `host/test`, not in `apps/`, not in `web-libs/`, not in
`tests/`, not in `scripts/`, not in `tools/`, not in any `.mjs` harness, not in
any generated file, not through any dynamic lookup).

**2 of 26: NO — `kernel_time` and `kernel_brk` are live.** See §0.

### The 24 confirmed dead

Every one is a thin `pub extern "C"` wrapper whose only textual occurrences in
compiled code are its own definition. `wasm_api.rs` line numbers are the
definition sites.

| # | export | def | superseded by | VERIFIED |
|---|---|---|---|---|
| 1 | `kernel_clear_argv` | 9890 | the token-bound `kernel_process_metadata_{begin,stage,commit,cancel}` transaction (ABI 43 replaces both vectors atomically; clear/push is explicitly forbidden — `docs/abi-versioning.md:833-836`) | yes |
| 2 | `kernel_convert_pipe_to_host` | 7132 | Phase-13c host-delegated pipe conversion; the kernel now owns pipe OFDs across fork | yes |
| 3 | `kernel_get_exit_status` | 10084 | `kernel_get_process_exit_status` / `kernel_get_process_exit_signal` (both required) | yes |
| 4 | `kernel_get_fork_exec_path_pid` | 2614 | centralized exec target (`kernel_exec_target_{prepare,size,read,cancel}` + `kernel_exec_commit`) | yes |
| 5 | `kernel_get_fork_state` | 7120 | fork state never crosses the host boundary any more; `ProcessTable::fork_process_for_caller_with_mode` serializes and deserializes entirely inside Rust (`crates/runtime-core/src/process_table.rs:1063,1074`) | yes |
| 6 | `kernel_get_pipe_ofds` | 7148 | same as #2 | yes |
| 7 | `kernel_getpgid_direct` | 8293 | the inline `SYS_GETPGID` arm at `wasm_api.rs:4104` | yes |
| 8 | `kernel_gettimeofday` | 11371 | `kernel_clock_gettime` via the `SYS_CLOCK_GETTIME` arm at `wasm_api.rs:4482` | yes |
| 9 | `kernel_ipc_shmdt` | 6899 | `kernel_ipc_shmdt_addr` (dispatch arm 346, `wasm_api.rs:5389-5392`) and the ABI 42/43 `…_for_task` / `…_for_process` forms | yes |
| 10 | `kernel_is_fork_child_pid` | 2204 | kernel-owned fork; `kernel_clear_fork_child` survives, the query does not | yes |
| 11 | `kernel_is_signal_blocked` | 2506 | `kernel_pick_signal_target_tid` (required export, same `pick_thread_for_shared_signal` primitive) | yes |
| 12 | `kernel_mmap` | 9942 | `dispatch_channel_mmap` (`wasm_api.rs:3878-3903`) — see §6 | yes |
| 13 | `kernel_mq_is_mqd` | 7109 | `kernel_mq_descriptor_msgsize` (required) and kernel-side mqueue routing | yes |
| 14 | `kernel_mremap` | 9083 | `dispatch_channel_mremap` (`wasm_api.rs:3904-3921`) — see §6 | yes |
| 15 | `kernel_posix_timer_interval_fire` | 13254 | `kernel_posix_timer_fire`, required since ABI 39 (`docs/abi-versioning.md:119-123`) | yes |
| 16 | `kernel_prctl` | 11686 | `kernel_prctl_from_channel`, called from the `SYS_PRCTL` arm at `wasm_api.rs:4989`. `kernel_prctl` is a pure forwarding shim to it | yes |
| 17 | `kernel_rewinddir` | 8182 | musl implements `rewinddir()` in userspace over `lseek` (`libc/musl/src/dirent/rewinddir.c`) | yes |
| 18 | `kernel_rt_sigtimedwait` | 13300 | the inline `SYS_RT_SIGTIMEDWAIT` arm at `wasm_api.rs:4406` (ABI 43 pointer-width aware) | yes |
| 19 | `kernel_seekdir` | 8208 | musl userspace `seekdir()` over `lseek` | yes |
| 20 | `kernel_sendfile` | 12106 | `kernel_sendfile_with_count`, the `SYS_SENDFILE` arm at `wasm_api.rs:294 =>` | yes |
| 21 | `kernel_set_fork_exec` | 12626 | centralized exec target, as #4 | yes |
| 22 | `kernel_set_fork_fd_action` | 12651 | kernel-owned `posix_spawn` file actions via the `SYS_SPAWN` blob | yes |
| 23 | `kernel_telldir` | 8195 | musl userspace `telldir()` (returns `dir->tell`) | yes |
| 24 | `kernel_tgkill` | 8810 | ABI 42 exact-thread delivery through the channel; `docs/abi-versioning.md:333-336` records that `tkill`/`tgkill` became strict `ProcessTable` operations | yes |

**Non-code textual references that survive and are NOT callers** (VERIFIED):

- `abi/snapshot.json` — one entry per export. Regenerated, never hand-edited.
- `docs/plans/2026-03-08-*.md`, `docs/plans/2026-04-26-*.md`,
  `docs/plans/2026-07-25-kernel-scratch-transfer-audit.md` — historical plan
  records. Leave them; they are dated history.
- `docs/posix-status.md:707` — a Phase-13c milestone bullet naming
  `kernel_convert_pipe_to_host` as a shipped export. This file *is*
  authoritative and follows an established "removed in ABI 42" annotation
  style (`:698-700`, `:713`, `:715`). It should get the same treatment.
- `libc/glue/syscall_imports.h` and `libc/glue/syscall_glue.c` — see §2.1.

### 2.1 The legacy libc glue is the one real surprise

`libc/glue/syscall_imports.h` declares `KERNEL_IMPORT(<name>)` —
`__attribute__((import_module("kernel"), import_name(#name)))` — for 14 of the
24, and `libc/glue/syscall_glue.c` calls 10 of them. That looks alarming: it is
a *guest program* importing the kernel's exports directly.

It is not a live path. VERIFIED:

- `libc/glue/channel_syscall.c:15` — *"This file replaces syscall_glue.c — no
  kernel.\* Wasm imports are used."*
- `sdk/src/bin/cc.ts:357` links **only** `channel_syscall.c` into every SDK
  program. `syscall_glue.c` appears in no build script, no `build.rs`, no
  Makefile, no `.sh`, and no `.toml` anywhere in the repo.
- `sdk/test/cc.test.ts:41` positively asserts that a compile invocation's
  argument list `not.toContain('syscall_glue.c')`, and `:49` asserts it does
  contain `channel_syscall.c`.
- `crates/host-native/src/guest.rs:5417-5418` records the same fact in a
  comment: the *current* glue "replaced `syscall_glue.c`".

So these two files are uncompiled legacy sources. They are still **read** by
`host/test/kernel-scratch-contract.test.ts` (`:118-125`), which uses them as an
"obsolete export must not reappear anywhere" corpus — see §7.2. Their
per-export touch matrix:

| export | `syscall_imports.h` | `syscall_glue.c` |
|---|---|---|
| `kernel_convert_pipe_to_host` | 2 lines (`:25-26`) | — |
| `kernel_get_fork_state` | 2 (`:22-23`) | — |
| `kernel_gettimeofday` | 2 (`:285-286`) | 2 (`:753`, `:758`) |
| `kernel_ipc_shmdt` | 2 (`:767-768`) | 2 (`:1811`, `:1854`) |
| `kernel_mmap` | 2 (`:335-336`) | 1 (`:834`) |
| `kernel_mremap` | 2 (`:349-350`) | 1 (`:1226`) |
| `kernel_prctl` | 2 (`:466-467`) | 1 (`:1364`) |
| `kernel_rewinddir` | 2 (`:174-175`) | 1 (`:584`) |
| `kernel_rt_sigtimedwait` | 2 (`:261-262`) | 1 (`:1527`) |
| `kernel_seekdir` | 2 (`:180-181`) | 1 (`:592`) |
| `kernel_sendfile` | 2 (`:376-377`) | 1 (`:1540`) |
| `kernel_set_fork_exec` | 2 (`:436-437`) | — |
| `kernel_set_fork_fd_action` | 2 (`:440-441`) | — |
| `kernel_telldir` | 2 (`:177-178`) | 1 (`:588`) |
| the other 10 dead exports | 0 | 0 |

`kernel_brk` and `kernel_time` also appear in both files. Since those two
exports survive K13a, their glue lines are untouched by this item.

---

## 3. Question 2 — host-native, `.mjs` harnesses

**None of the 28 is referenced from `crates/host-native` or from any `.mjs`
file.** VERIFIED two ways.

- Direct: the exhaustive `git grep -P` and the whole-tree `grep -rIn` return no
  hit under `crates/host-native/` or in any of the 21 tracked `.mjs` files
  (`crates/fork-module/tests/harness{,-capture}.mjs`,
  `benchmarks/measure-fork-memory-components.mjs`,
  `apps/browser-demos/browser-*.mjs`, `scripts/*.mjs`,
  `tools/mkrootfs/bin/mkrootfs.mjs`, `host/test/fixtures/*.mjs`).
- Enumerated: every string literal passed to `get_typed_func` / `get_func` /
  `get_export` in `crates/host-native/src/*.rs` was extracted (34 distinct
  names). The list is disjoint from the 28. This is the same method that
  originally surfaced `kernel_exec_target_resolve_shebang` as host-native-only,
  so the precedent is covered.

`EXPECTED_HOST_IMPORT_COUNT = 84` (`crates/host-native/src/lib.rs:77`, asserted
at `:414`) counts **host imports into the kernel**, not kernel exports. Deleting
exports cannot move it. VERIFIED by reading both sites.

---

## 4. Question 3 — required-exports lists

**No candidate appears in any required or forbidden export list.** VERIFIED.

| list | source | size | intersection with the 28 |
|---|---|---|---|
| `host_adapter.required_kernel_exports` | `abi/snapshot.json` (Rust-owned, generated) | 82 | **∅** |
| `host_adapter.optional_kernel_exports` | same | 4 | **∅** |
| `KERNEL_REQUIRED_EXPORTS` | `run.sh:194-273` | 80 | **∅** |
| `requiredExportsForRelPath("kernel.wasm")` | `host/src/binary-resolver.ts:2827-2830` → `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` (generated from the snapshot) | 82 | **∅** |
| `EXECUTABLE_PROGRAM_REQUIRED_EXPORTS` | `binary-resolver.ts:2832-2835` | `wpk_fork_*` program exports | **∅** |
| `LEGACY_KERNEL_EXEC_EXPORTS` (forbidden on `kernel.wasm`) | `binary-resolver.ts:2841-2847` | 5 | **∅** |
| export names in `scripts/wasm-artifact-guards.sh`, `scripts/test-wasm-artifact-guards.sh`, `scripts/test-install-local-binary-sealed.sh` | shell literals | 15 | **∅** |

Two names appear in the snapshot's required list but not in `run.sh`'s array
(`kernel_exec_target_shebang`, `kernel_spawn_blob_decode`); the reverse
difference is empty. That drift is pre-existing and unrelated to K13a — noted
only so a reader does not attribute it to this change.

---

## 5. Question 4 — the ABI procedure. **No `ABI_VERSION` bump.**

### 5.1 The governing rule

`docs/abi-versioning.md` lists the additive changes that may keep an
`ABI_VERSION` (`:136-153`). Only *adding* a kernel Wasm export is listed:

> - Adding a new kernel-wasm export while leaving every existing export's
>   kind, signature, type, mutability, and tracked value unchanged.

Removal is not on that list, so within a *published* epoch removing 24 exports
would be an incompatible change requiring a bump. But the epoch here is not
published, and the document states the rule for that case three times, most
directly at `docs/abi-versioning.md:790-794`:

> ABI 43 has not been published as a compatibility epoch. The retry-token,
> large-transfer, fatal-lifetime, positioned-I/O, and append corrections amend
> that same pending ABI-43 contract and snapshot. **They do not justify
> inventing ABI 44 merely to preserve an unreleased draft**, and they must not
> be hidden under released ABI 42.

Reinforced at `:691-693` (an *incompatible-shaped* export-set change folded
into the unpublished epoch "without inventing ABI 44 or permitting a fallback"),
at `:803-805` ("preserving the earlier draft would not justify creating ABI
44"), and at `:815-817`.

**Ruling: K13a amends the still-unpublished ABI 44 contract. Regenerate
`abi/snapshot.json`; leave `ABI_VERSION = 44`.**

### 5.2 The mechanical check agrees — VERIFIED, not inferred

`crates/shared/src/lib.rs:120` is `pub const ABI_VERSION: u32 = 44`;
`origin/main` is `43` (`crates/shared/src/lib.rs:114` on main). `abi/snapshot.json`
already carries `"abi_version": 44`.

`scripts/check-abi-version.sh:89-124` computes `version_bumped` from
`git diff origin/main -- crates/shared/src/lib.rs | grep -E '^\+pub const
ABI_VERSION: u32 = '`. That already matches on this branch, so
`version_bumped=1`, and the incompatibility classifier
(`xtask dump-abi --classify-compat`) at `:109-117` **only runs when
`snapshot_changed == 1 && version_bumped == 0`**. It will not run, and it will
not object.

The script's own summary line for this case (`:126-127`) is
`"abi: snapshot changed and ABI_VERSION was bumped."` — the correct outcome.

**STRONG DOUBT flag:** if anyone proposes bumping to ABI 45 for this deletion,
that contradicts `docs/abi-versioning.md:790-794` and `:803-805` directly. An
unreleased epoch is amended, not superseded. Do not bump.

### 5.3 Snapshot regeneration is generated, never hand-edited

`scripts/check-abi-version.sh:36-49` builds
`target/wasm32-unknown-unknown/release/kandelo_kernel.wasm` with
`cargo build --release -p kandelo -Z build-std=core,alloc` *first* — "so stale
binaries can't defeat the check" — then runs `cargo run -p xtask -- dump-abi
--kernel-wasm <that path>`. `abi/snapshot.json`'s `kernel_exports` array is
parsed straight out of that Wasm. Editing the JSON by hand would be caught by
`--check` on the next run.

### 5.4 Documentation obligation

`docs/abi-versioning.md` has **no ABI 44 section** (VERIFIED: `grep -n "ABI 44"`
returns only the four *negative* mentions in the ABI 43 text). The epoch was
bumped in `84c3efe72` ("Transport: Flip non-blocking syscalls to opaque
records… (ABI 44, Phase-2 Option A)") and is described only in campaign plans.

Per the Build/Docs contract ("Documentation is part of the platform contract"),
K13a should not silently remove 24 snapshotted exports with no durable record.
See §8, NEEDS-DEFER-DECISION D2, for the scope question.

---

## 6. Question 6 — is anything dead because of an *incomplete* migration?

**No.** Every one of the 24 has a live successor path, and each successor was
read, not assumed. The two flagged as surprising resolve cleanly:

### `kernel_mmap` — no gap; strictly worse than the live path

`kernel_mmap(addr, len, prot, flags, fd, offset_lo, offset_hi)`
(`wasm_api.rs:9942-9967`) and `dispatch_channel_mmap`
(`wasm_api.rs:3878-3903`) both call `syscalls::sys_mmap` and both call
`ensure_memory_covers` for non-`PROT_NONE` results. The differences all favor
the dispatch path:

- `dispatch_channel_mmap` runs `validate_channel_scratch_arguments(46, …)`,
  `checked_mmap_byte_offset`, `checked_channel_process_address` and
  `checked_channel_process_size` — the ABI 43 capacity/ownership proofs.
  `kernel_mmap` does none of that; it takes raw `usize` from an importer.
- `kernel_mmap` collapses **every** error to `MAP_FAILED`
  (`Err(_) => wasm_posix_shared::mmap::MAP_FAILED`), discarding errno.
  `dispatch_channel_mmap` returns `Result<usize, Errno>` and the caller
  publishes the real errno. Under POSIX, `mmap` must set `errno`; the export
  cannot. Keeping it is keeping a POSIX-incorrect entry point alive.

`SYS_MMAP` (46) is served: `dispatch_channel_wide_result` routes
`(46, ChannelResultKind::ProcessAddress)` to `dispatch_channel_mmap`
(`wasm_api.rs:3936-3938`). VERIFIED.

### `kernel_mremap` — same shape

`kernel_mremap` (`:9083-9098`) and `dispatch_channel_mremap` (`:3904-3921`) both
call `syscalls::sys_mremap`. `SYS_MREMAP` (126) is routed at `:3944-3946`.
`kernel_mremap` encodes errors as `(-(e as i32)) as usize`, an
errno-in-an-address representation with no ABI-43 argument validation. VERIFIED.

**Conclusion: `kernel_mmap`/`kernel_mremap` being uncalled is the *expected*
end-state of the channel migration, not a gap.** They are direct-import
survivors from the `syscall_glue.c` era. Deleting them removes two unvalidated
back doors into the address-space allocator.

### The other two worth stating explicitly

- **`kernel_gettimeofday` (`SYS_GETTIMEOFDAY` = 67) has no dispatch arm** —
  I checked, and 67 is genuinely absent from `dispatch_channel_syscall`.
  That is **not** a reachable gap: musl's `gettimeofday()`
  (`libc/musl/src/time/gettimeofday.c`) is a pure userspace wrapper over
  `clock_gettime(CLOCK_REALTIME)`, and the only path that would issue
  `SYS_gettimeofday` is `clock_gettime.c:86-90`, guarded by
  `r == -ENOSYS` from `SYS_clock_gettime`. `SYS_CLOCK_GETTIME` (40) *is*
  dispatched (`wasm_api.rs:4482`), so the fallback never fires. VERIFIED by
  reading both musl sources and the dispatch arm. (`__NR_gettimeofday_time32`
  *is* defined for wasm32posix at
  `libc/musl-overlay/arch/wasm32posix/bits/syscall.h.in:359`, so the `#ifdef`
  is live — the guard that keeps it unreachable is the `-ENOSYS` test, not the
  macro.)
- **`kernel_get_fork_state`** is dead because the migration *finished*: the
  fork wire image never crosses into the host any more.
  `ProcessTable::fork_process_for_caller_with_mode` calls
  `serialize_fork_state_with_growing_buffer`
  (`crates/runtime-core/src/process_table.rs:390-408, 1063`) and
  `crate::fork::deserialize_allocated_fork_state` (`:1074`) inside Rust.
  `crate::fork::serialize_fork_state` therefore stays live via that wrapper.
  VERIFIED.

### One follow-on to record (not a blocker)

Deleting `kernel_posix_timer_interval_fire` leaves
`Process::note_legacy_posix_timer_interval_fire`
(`crates/runtime-core/src/process.rs:1945`) with **only test callers**
(`process.rs:2970,2974,2976`). It is `pub`, so Rust emits no `dead_code`
warning; it will simply be unused production code. That is K13b/K3 cleanup
territory, listed here so it is not lost. INFERRED from the call graph
(VERIFIED that those are the only four references).

---

## 7. Question 5 — the two test-only exports

### 7.1 What the tests actually assert

`kernel_get_stack_pointer` (`wasm_api.rs:1430-1436`) returns
`&sentinel as *const u32 as usize` for a stack local — an *approximation* of the
Wasm shadow-stack pointer, as its own doc comment says ("Read the approximate
Wasm stack pointer for debugging").

`kernel_reap_process(pid)` (`wasm_api.rs:1993-1996`) forwards to
`reap_process_and_cleanup`. The production reap export is
`kernel_reap_exited_child(parent_pid, child_pid)` (`:2453`, in the required
set), which calls the same helper (`:2458`). `kernel_reap_process` exists only
because the test creates parentless processes with `kernel_create_process()`.

Both tests run the identical probe on both hosts:

- `host/test/reusable-kernel-export-stack.test.ts` (Node/Vitest)
- `apps/browser-demos/test/fixtures/reusable-kernel-export-stack-worker.ts`
  (browser worker fixture)

The probe: instantiate the real `kernel.wasm`, record a baseline SP, then run
**4,096** iterations of `create_process` → `set_current_tid` →
`commit_process_exit` → `reap_process`, asserting the SP returns to baseline
after every one of the four steps. It is a **shadow-stack leak regression
guard** for the reusable kernel instance — the exact invariant
`docs/abi-versioning.md:245-250` describes ("its normal epilogue restores the
kernel shadow stack and clears that binding").

The Node test reaches the raw instance through
`createWasmPosixKernelTestHarness`'s module-secret engine hook
(`reusable-kernel-export-stack.test.ts:31-49`), explicitly documented as
test-only access; production sees only the gated facade.

### 7.2 What a Rust-side equivalent would look like

A `cargo test` unit test **cannot** express this: workspace Rust tests run on
the host target (x86_64/aarch64), where there is no Wasm shadow stack. The
invariant only exists in the Wasm instance.

The honest Rust home is a **`crates/host-native` integration test** driving
`kernel.wasm` through wasmtime — the same engine that already calls
`kernel_create_process_with_stdio`, `kernel_commit_process_exit` and
`kernel_reap_exited_child`. Two shapes:

- **(R1) Read the real global.** Link the kernel with
  `-Wl,--export=__stack_pointer` and read it as a `wasmtime::Global`. This is
  *more* truthful than today's test — it observes the actual shadow-stack
  pointer instead of the address of a stack local — and it removes a
  `kernel_*` **function** export, which is the V4 unit. It adds one global to
  `kernel_exports` in the snapshot. Whether a mutable toolchain global belongs
  in the ABI surface is a judgment call: `export_deny.deny_exact` currently
  filters `__data_end`, `__heap_base`, etc., so `__stack_pointer` would need a
  deliberate decision to filter or to track.
- **(R2) Keep the probe, drop the extra reap export.** Delete
  `kernel_reap_process` only, and rewrite both harnesses to
  `kernel_fork_process` a child from a parent and reap it with the required
  `kernel_reap_exited_child`. `kernel_get_stack_pointer` stays until R1 lands.

### 7.3 Recommendation

**Do not fold the test-only pair into K13a.** Concretely:

1. K13a deletes exactly the **24**. It stays a pure, mechanically verifiable
   subtraction with no test rewrite and no linker-flag change.
2. `kernel_reap_process` → **delete via R2**, in K13b. Cost is bounded: two
   harness rewrites (`host/test/reusable-kernel-export-stack.test.ts`,
   `apps/browser-demos/test/fixtures/reusable-kernel-export-stack-worker.ts`)
   plus removing one allowance from
   `host/test/kernel-scratch-contract.test.ts:617-619`.
3. `kernel_get_stack_pointer` → **replace via R1**, in K13b, *if* the
   maintainer accepts `__stack_pointer` as a tracked snapshot global. The
   campaign rule ("tests live where the primitives live") points at R1, but the
   primitive here is a Wasm engine property, so the test must stay in a
   Wasm-driving harness either way. **Deleting the export without R1 would
   delete the regression guard**, and the census (§6) classifies exactly this
   kind of cross-host Wasm behavior test as "stays TS". Do not trade it away
   for an export count.

This is recorded as **NEEDS-DEFER-DECISION D1** in §8 — the maintainer decides,
not me.

**Blast radius note that applies to any of these edits:**
`host/test/kernel-scratch-contract.test.ts` treats an *unused* allowance as a
failure (`host/test/support/wasm-memory-write-audit.ts:8433-8435` pushes
`` `stale audit allowance: ${allowance.key}` `` into `formatAuditFailures`,
asserted `toEqual([])` at `kernel-scratch-contract.test.ts:1785`). Rewriting a
fixture without removing its allowance rows fails the audit. VERIFIED.

### 7.4 A ready-made retirement pattern already exists

`host/test/kernel-scratch-contract.test.ts:1820-1850` already implements the
exact contract K13a wants, for a previous batch of retired raw exports. For
each obsolete name it asserts **all four**:

1. `kernelWasmApiSource` does not match
   `#[unsafe(no_mangle)] pub extern "C" fn <name>\b`
2. `legacySyscallImportsSource` (`libc/glue/syscall_imports.h`) does not match
   `\b<name>\b`
3. `legacySyscallGlueSource` (`libc/glue/syscall_glue.c`) does not match
   `\b<name>\b`
4. `abiKernelExportNames.has(<name>) === false` — parsed from
   `abi/snapshot.json`, with an explicit comment that prefix-related live
   exports must neither false-fail nor mask an exact obsolete name

**Extending that list with the 24 is the right way to make K13a permanent** —
and note that assertions 2 and 3 *require* removing the legacy glue lines, which
is why the glue edit is in scope (§8, D3).

---

## 8. NEEDS-DEFER-DECISION

Nothing below is self-deferred. Each is a maintainer call.

### D1 — the two test-only exports

- **What.** Whether `kernel_get_stack_pointer` and `kernel_reap_process` are
  deleted now (in K13a) or in K13b via R1/R2.
- **Why it's a decision.** They are load-bearing for a real cross-host
  shadow-stack leak regression guard that runs on both Node and browser.
  Deleting them now means either deleting the guard or rewriting two harnesses
  and (for the SP) adding a linker export and a snapshot global in the same
  change.
- **Cost now.** K13a stops being a pure subtraction: 2 harness rewrites, 4
  allowance-row deletions, 1 linker-flag change, 1 `export_deny` judgment, and
  the browser Playwright fixture must be re-run to prove parity.
- **Cost later.** Two exports linger in the snapshot for the length of K13b.
  Zero correctness cost; the exports are inert in production.
- **Recommendation.** Defer to K13b. Take R2 for `kernel_reap_process`
  (cheap, no ABI move) and R1 for `kernel_get_stack_pointer` (better test, one
  ABI decision). Keep K13a mechanical.

### D2 — documenting the ABI 44 epoch

- **What.** `docs/abi-versioning.md` has no ABI 44 section at all, even though
  `ABI_VERSION` is 44 on this branch. Does K13a open that section, or append to
  an existing campaign plan and leave the reference doc for a later item?
- **Why it's a decision.** Opening the section is a small doc edit but it
  implicitly commits to keeping every ABI-44 change recorded there from now on,
  and the campaign is still adding incompatible changes to this epoch.
- **Cost now.** ~20 lines of `docs/abi-versioning.md` plus a one-line
  annotation in `docs/posix-status.md:707` for
  `kernel_convert_pipe_to_host`.
- **Cost later.** ABI 44 approaches publication with its contract scattered
  across `docs/plans/*`, which is exactly the state
  `docs/abi-versioning.md` exists to prevent.
- **Recommendation.** Open the section in K13a with a single "removed exports"
  paragraph, and let subsequent K items append. Cheap now, and it makes the
  epoch's contract cumulative rather than reconstructed at the end.

### D3 — how far to cut the legacy libc glue

Three options, and the maintainer picks one:

- **(a) Export + snapshot only.** Leave `syscall_imports.h` / `syscall_glue.c`
  untouched. *Cost:* the §7.4 retirement assertions cannot be extended (they
  check both glue files), so the deletion gets no permanent guard. Stale
  `import_name` declarations for exports that no longer exist stay in the tree
  — precisely the "stale ABI artifact" shape `docs/agent-guidance/abi.md:55-59`
  says should fail loudly.
- **(b) Surgical glue edit (recommended).** Delete the 14 `KERNEL_IMPORT` +
  prototype pairs from `syscall_imports.h` and the 10 call sites'
  `syscall_glue.c` arms (making each removed arm return `-ENOSYS` rather than
  silently vanishing, so the file stays internally coherent). Then extend the
  §7.4 list with all 24 names. *Cost:* a contained edit to two uncompiled
  files; no build effect (VERIFIED that neither file is compiled by anything);
  the guard becomes permanent.
- **(c) Delete `syscall_glue.c` and `syscall_imports.h` outright.** They are
  provably not compiled and are fully superseded by `channel_syscall.c`. This
  is the biggest V4 subtraction available here (~104 KB of dead C). *Cost:*
  `host/test/kernel-scratch-contract.test.ts` reads both files at `:118-125`
  and asserts against them at `:1642-1655` and `:1840-1845`; those assertions
  would need rehoming or deleting, which is a bigger review than K13a's
  purpose. Genuinely out of K13a's stated scope.
- **Recommendation.** (b) for K13a; propose (c) as its own small item.

### D4 — reclassifying `kernel_time` / `kernel_brk`

- **What.** They move from K13a's delete set into K13b's privatize set. The
  census's §2 "Settled facts" and §12 method paragraph both state 26 dead / 117
  dispatch-only.
- **Why it's a decision.** Both documents are marked "settled facts — do not
  re-derive". Correcting them is right, but overwriting a durable record is the
  maintainer's call on form.
- **Cost now.** A two-number correction in each of
  `docs/plans/2026-09-09-rust-first-value-plan.md` (§2) and
  `docs/plans/2026-09-09-whole-kernel-rust-migration-census.md` (§10 K13 row,
  §12 method paragraph), plus one sentence naming
  `dispatch_channel_wide_result` and the `git grep -E '\b'` hazard so the next
  reader does not repeat either.
- **Cost later.** A future K13b pass reads "117 dispatch-only" and either finds
  119 (confusing) or trusts 117 and mis-scopes.
- **Recommendation.** Correct both documents in the same commit as the code
  deletion, citing this file.

---

## 9. Implementation plan

### Step 1 — remove the 24 exports

`crates/kernel/src/wasm_api.rs`, delete each `#[unsafe(no_mangle)] pub extern
"C" fn` item **and its doc comment**, at these definition lines (descending, so
earlier deletions do not shift later ones):

```
13300 kernel_rt_sigtimedwait      13254 kernel_posix_timer_interval_fire
12651 kernel_set_fork_fd_action   12626 kernel_set_fork_exec
12106 kernel_sendfile             11686 kernel_prctl
11371 kernel_gettimeofday         10084 kernel_get_exit_status
 9942 kernel_mmap                  9890 kernel_clear_argv
 9083 kernel_mremap                8810 kernel_tgkill
 8293 kernel_getpgid_direct        8208 kernel_seekdir
 8195 kernel_telldir               8182 kernel_rewinddir
 7148 kernel_get_pipe_ofds         7132 kernel_convert_pipe_to_host
 7120 kernel_get_fork_state        7109 kernel_mq_is_mqd
 6899 kernel_ipc_shmdt             2614 kernel_get_fork_exec_path_pid
 2506 kernel_is_signal_blocked     2204 kernel_is_fork_child_pid
```

**Do not touch `kernel_time` (`:11357`) or `kernel_brk` (`:9986`).**

### Step 2 — legacy glue (pending D3; plan assumes option (b))

- `libc/glue/syscall_imports.h`: remove the 14 `KERNEL_IMPORT(<name>)` +
  prototype pairs listed in §2.1.
- `libc/glue/syscall_glue.c`: remove the 10 call sites listed in §2.1, leaving
  each affected `switch` arm returning `-ENOSYS` so the (uncompiled) file stays
  coherent and honest about what no longer exists.

### Step 3 — make the removal permanent

Extend the obsolete-export list in
`host/test/kernel-scratch-contract.test.ts:1820-1850` with all 24 names. It
already asserts absence from `wasm_api.rs`, both glue files, and
`abi/snapshot.json` — exactly the four places a name could come back.

### Step 4 — docs (pending D2 / D4)

- `docs/abi-versioning.md`: an ABI 44 section recording the removal and why no
  bump follows (cite `:790-794`).
- `docs/posix-status.md:707`: annotate `kernel_convert_pipe_to_host` as removed,
  matching the existing "removed in ABI 42" style at `:698-700` and `:713`.
- `docs/plans/2026-09-09-rust-first-value-plan.md` §2 and
  `docs/plans/2026-09-09-whole-kernel-rust-migration-census.md` §10/§12:
  26 → 24 dead, 117 → 119 dispatch-only, with the §0 explanation.

### Step 5 — regenerate the snapshot

```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
```

Expect **exactly 24** removed `kernel_exports` entries and no other section
changed. Leave `ABI_VERSION = 44`. Anything else in the diff means Step 1
removed more than intended — stop and investigate rather than committing it.

### Step 6 — refresh dependent artifacts

The snapshot build writes `target/wasm32-unknown-unknown/release/kandelo_kernel.wasm`.
`local-binaries/kernel.wasm` is what the resolver prefers, so refresh it before
running any suite that boots a kernel:

```bash
cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm local-binaries/kernel.wasm
scripts/dev-shell.sh cargo run -p xtask -- verify-fresh
```

---

## 10. Validation commands

Fresh-worktree provisioning first if any artifact is missing
(`docs/agent-guidance/validation.md:70-140`) — this is provisioning, not a
blocker:

```bash
git submodule update --init --recursive
npm ci && (cd host && npm ci)
scripts/dev-shell.sh ./run.sh setup
scripts/dev-shell.sh bash scripts/build-programs.sh
scripts/dev-shell.sh bash scripts/fetch-binaries.sh
```

Then, in order:

```bash
# 1. Kernel compiles with the 24 items gone (fast failure signal).
scripts/dev-shell.sh cargo build --release -p kandelo -Z build-std=core,alloc

# 2. ABI: regenerate, inspect, verify. Step 5 above, then:
scripts/dev-shell.sh bash scripts/check-abi-version.sh
#    Expect: "abi: snapshot changed and ABI_VERSION was bumped."

# 3. Build freshness.
scripts/dev-shell.sh cargo run -p xtask -- verify-fresh

# 4. Workspace Rust tests.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
scripts/dev-shell.sh cargo test --workspace --exclude xtask --target "$HOST_TARGET"
scripts/dev-shell.sh cargo test -p xtask --target "$HOST_TARGET"

# 5. Host/runtime tests — this is where the export-policy and audit
#    assertions live (kernel-scratch-contract, wasm-memory-write-audit,
#    reusable-kernel-export-stack).
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest

# 6. Browser host — the reusable-kernel-export-stack browser fixture and the
#    artifact-policy path both run here.
cd apps/browser-demos && npx playwright test --grep-invert "@slow" --project=chromium

# 7. Conformance. Required by the validation contract because this change
#    touches the kernel's Wasm export surface and ABI-adjacent artifacts.
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh libc
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh posix
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh sortix
```

Two suites are not optional here even though the change looks like pure
subtraction, because both would catch the failure mode that matters — a
deleted export turning out to be reachable:

- **libc/posix/sortix**, because `syscall_imports.h` proves these names were
  once a *guest-visible* import surface. If any program artifact in the tree
  were still linked against the legacy glue, it would fail to instantiate with
  a missing-import error, and only a suite that actually boots programs would
  show it. (INFERRED that none is: no build path compiles `syscall_glue.c`.
  The suites are how that inference is converted to evidence.)
- **browser**, because `docs/agent-guidance/validation.md:14-17` is explicit
  that a passing Node/Vitest path does not prove browser behavior, and the
  browser host validates `kernel.wasm` against
  `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` on its own path.

Performance was not measured and no performance claim is made. Removing 24
uncalled exports has no hot-path effect that this pass measured.

---

## 11. Confidence ledger

**VERIFIED (a command was run, its output inspected):**

- 336 `pub extern "C" fn` in `wasm_api.rs`; 335 `kernel_*` exports in the built
  kernel Wasm; all 28 candidates present in that artifact.
- `kernel_time` and `kernel_brk` have live Rust callers at `wasm_api.rs:3933`
  and `:3946`.
- The other 24 have no reference anywhere in the working tree — tracked or
  untracked — outside their own definitions, `abi/snapshot.json`, historical
  `docs/`, and the uncompiled legacy glue.
- `git grep -E '\b…\b'` matches nothing in this repo; `-P` works.
- No candidate is in any required/optional/forbidden export list (7 lists
  checked).
- No candidate is reachable via dynamic export indexing, string concatenation,
  `#[export_name]`, or macro name synthesis.
- No candidate appears in `crates/host-native` or in any `.mjs` file.
- `ABI_VERSION` is 44 here, 43 on `origin/main`; `check-abi-version.sh` skips
  the incompatibility classifier when a bump is already present.
- `syscall_glue.c` is compiled by nothing; `sdk/src/bin/cc.ts:357` links only
  `channel_syscall.c`; `sdk/test/cc.test.ts:41` asserts the exclusion.
- The unused-allowance failure mode in
  `host/test/support/wasm-memory-write-audit.ts:8433-8435`.
- `SYS_CLOCK_GETTIME` (40) is dispatched, so musl's `SYS_gettimeofday`
  fallback is unreachable.

**INFERRED (read the code, did not execute it):**

- That deleting the 24 leaves `wasm_api.rs` compiling. Every one is a leaf
  wrapper over a helper that has other live callers
  (`kernel_ipc_shmdt_for_process`, `kernel_prctl_from_channel`,
  `serialize_fork_state`, `reap_process_and_cleanup`, `sys_mmap`,
  `sys_mremap`), so nothing should become unreachable. Step 1 of §10 is what
  converts this to evidence.
- That no shipped program artifact imports these names from module `"kernel"`.
  Nothing compiles the legacy glue, but no artifact was disassembled to confirm
  it. The libc/posix/sortix suites are the evidence.
- That `Process::note_legacy_posix_timer_interval_fire` becomes test-only
  after the deletion.

**NOT EXAMINED:** whether any *package archive* in the local content-addressed
cache was built against the legacy direct-import glue. Those are ABI-stamped
and would be rebuilt on an ABI change anyway; ABI 44 is unreleased, so this is
moot for this epoch, but it is not something this pass checked.
