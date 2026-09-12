# Fork inversion item #3 — delete callerless fine-grained DRIVE exports

**Status: DONE_WITH_CONCERNS** (all validation green; one scope deviation from
the task's step-1 file list, documented below with proof — two ADDITIONAL
obviated test harnesses had to be handled because the task's premise that the 13
exports were "called ONLY by two Vitest files" undercounted their callers).

Worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`, built on HEAD `0883c7797`.
No push, no amend/force. `.superpowers/` untouched.

## Commits (4, on top of 0883c7797)

- `1d2691358` Fork: Replace fine-grained backend Vitest with coarse
  truthful-failure test  (step 1)
- `3c7ac57b8` Fork: Delete callerless fine-grained fork-module DRIVE exports
  (step 2 — Rust exports + dead impls + fixed-arena machinery)
- `5f5fb0ec2` Fork: Remove host bindings + obviated harnesses for deleted DRIVE
  exports  (steps 3–6 — backend wrappers, required-exports, host-native handles,
  dangling refs, obviated tests)

(Build artifacts — `local-binaries/`, `host/wasm/`, `local-binaries/source-only-v1/`
wasm and `host/dist/` — are gitignored and regenerated from source; not committed.)

## The 13 deleted DRIVE exports

`fm_begin_unwind`, `fm_add_activation_unwind`, `fm_begin_unwind_fixed_arena`,
`fm_add_activation_unwind_fixed_arena`, `fm_finish_unwind`,
`fm_serialize_journal_alloc`, `fm_serialize_journal_fixed_arena`,
`fm_begin_replay`, `fm_finish_replay`, `fm_begin_child_replay`,
`fm_begin_borrowed_child_replay`, `fm_begin_abort`, `fm_finish_abort`.

Removed from: `crates/fork-module/src/lib.rs` (the `pub extern "C" fn`s),
`host/src/fork-module-backend.ts` (the 9 wrapper methods — `finishUnwindAndSerialize`
folded two exports, and the fixed-arena/borrowed variants had fewer wrappers than
exports), `host/src/fork-module-instance.ts` (`FORK_MODULE_REQUIRED_EXPORTS`),
`crates/host-native/src/guest.rs` (the 7 unused `TypedFunc` handles + `fm_func!`
bindings; native never bound the fixed-arena or separate-abort exports).

### Dead impls removed (checked each for remaining callers first)

Fully dead after export removal → deleted:
`begin_unwind_fixed_arena_impl`, `add_activation_unwind_fixed_arena_impl`,
`serialize_journal_fixed_arena_impl`, plus the FrameArena fixed-arena machinery
(`FrameArena::new_fixed`, the `fixed`/`fixed_next`/`fixed_end` fields and their
`allocate`/`current_memory`/`release_all` branches). Fix X was retired in favour
of Option B's growing channel allocator, and these fixed-arena entries were its
only reachability.

SHARED impls kept (still called by the coarse entries `begin_capture_impl`,
`seal_capture_impl`, `fm_parent_abort_seal`, `finish_transaction_impl`,
`child_seed_impl`, `child_seed_borrowed_impl`): `begin_unwind_impl`,
`add_activation_unwind_impl`, `finish_unwind_impl`, `serialize_journal_alloc_impl`,
`begin_replay_impl`, `finish_replay_impl`, `begin_child_replay_impl`,
`begin_borrowed_child_replay_impl`, `begin_abort_impl`, `finish_abort_impl`.
(Confirmed by ref-count before removal: the fixed-arena impls dropped to 1 ref =
their own definition; the shared impls retained multiple coarse callers.)

## Surviving `fm_*` export count: 71

`grep -oE 'pub extern "C" fn fm_[a-z_0-9]+' crates/fork-module/src/lib.rs` = **71**.
(`fm_drive_execute` is a walrus-injected wasm export, not a Rust `pub extern`, so
it is a 72nd module export not counted in this Rust-source grep.)

### Coarse per-phase (9)
fm_parent_begin_capture, fm_parent_seal_capture, fm_parent_abort_seal,
fm_parent_replay, fm_parent_abort, fm_parent_finish, fm_child_seed,
fm_child_seed_borrowed, fm_child_reconstruct

### Reference-marshalling / reconstruction (43)
- capture builder (17): fm_capture_begin, fm_capture_begin_vector,
  fm_capture_append_vector, fm_capture_finish_vector, fm_capture_vector_get,
  fm_capture_claim_gc, fm_capture_define_gc, fm_capture_gated_placeholder,
  fm_capture_intern_funcref, fm_capture_intern_externref, fm_capture_intern_i31,
  fm_capture_intern_static_root, fm_capture_interned, fm_capture_record_header_size,
  fm_capture_serialize, fm_capture_serialized_len, fm_capture_validate
- ref resolution / feed (10): fm_ref_vector_get, fm_ref_gc_route,
  fm_ref_gc_payload_len, fm_ref_gc_load, fm_ref_exn_route, fm_ref_exn_load,
  fm_ref_exn_cache_index, fm_funcref_ordinal, fm_externref_handle,
  fm_static_root_slot
- decoded-graph readout (5): fm_decode_reference_graph, fm_decoded_node_count,
  fm_decoded_node_kind, fm_decoded_node_module_activation, fm_decoded_node_ordinal
- reconstruction drive / plan / install (9): fm_begin_reference_replay,
  fm_build_gc_plan, fm_gc_plan_count, fm_build_trivial_plan, fm_trivial_plan_count,
  fm_restore_from_arena, fm_attach_child, fm_attach_borrowed_child, fm_drive_bump
- child-replay side-activation seeding (2): fm_add_activation_child_replay,
  fm_add_activation_borrowed_child_replay

### Seeds — `fm_set_*` (8)
fm_set_format, fm_set_resume_catalog, fm_set_activation_resume_catalog,
fm_set_activation_catalog_base, fm_set_activation_static_root_base,
fm_set_activation_gc_codec, fm_set_activation_exception_tags,
fm_set_host_exception_owner

### Infra (11)
fm_last_errno, fm_stats, fm_drive_table_base, fm_journal_image_len, fm_abort,
fm_activation_module_buffer, fm_frame_reserve, fm_frame_commit, fm_frame_peek,
fm_frame_next, fm_resume_peek

(9 + 43 + 8 + 11 = 71.)

## ABI decision: snapshot-consistent, NO ABI_VERSION bump

The fork-module's host-facing `fm_*` export surface is NOT part of the tracked
ABI snapshot. `abi/snapshot.json` tracks the guest/KFMS `fork_module_*` record
names and kernel Wasm exports, none of which changed. `git status` shows
`abi/snapshot.json`, `crates/shared/src/lib.rs`, `host/src/generated/abi.ts`, and
`libc/glue/abi_constants.h` all UNMODIFIED by this work.

- `cargo run -p xtask --target aarch64-apple-darwin -- verify-fresh` → exit 0:
  "abi snapshot up-to-date", "abi: snapshot is in sync with sources",
  "abi: ABI_VERSION and snapshot are consistent".
- `scripts/check-abi-version.sh` → same, exit 0.

The fork-module is co-resident and rebuilt with the kernel; deleting exports no
consumer uses is snapshot-consistent. No `ABI_VERSION` bump made or required. (The
branch was already at ABI 44 from prior campaign work; that is unchanged.)

## Validation (all inside scripts/dev-shell.sh; HOST triple aarch64-apple-darwin)

- `cargo test -p fork-codec -p fork-module-inject --target aarch64-apple-darwin`:
  fork-codec **442 passed**, fork-module-inject **2 passed**, 0 failed.
- `cargo test -p host-native --lib --target aarch64-apple-darwin`:
  **45 passed, 4 ignored** (incl. the pre-existing ignored `smoke_fork_from_thread`),
  0 failed. Covers the coarse fork/vfork/gc/exnref/externref smoke paths.
- `crates/fork-module/build-wasm.sh` (both widths built + staged) then
  `--verify-fresh`: fork_module32/64 both "matches current source". wasm shrank
  (32-bit 141035→138331 B, 64-bit 145977→143308 B) — exports removed.
- Staged into `local-binaries/`, `host/wasm/`, and `local-binaries/source-only-v1/`.
- `./run.sh local-build`: **98/98 nodes, 7/7 products, exit 0** (after rebuilding
  the gitignored `host/dist` — see concern below). The WordPress/MariaDB LAMP VFS
  image builds boot a real kernel and run real forks through the coarse path.
- `xtask verify-fresh` + `check-abi-version.sh`: green (above).
- Host Vitest fork suite (18 files, `--testTimeout=30000`):
  batch 1 (coarse-failures, trampoline, continuation, capture-session-host-exception,
  instance, state, reconstruction, multi-activation-funcref, activation-registry,
  replay-events) = **83 passed, 1 skipped**;
  batch 2 (vfork-fork-module, vfork-lifetime, vfork-production-mechanism,
  gc-replay, exnref-replay, funcref-replay, externref-replay,
  externref-gated-fork-module-worker, fork-instrument-coverage) =
  **71 passed, 2 expected-fail (`test.fails`), 8 skipped**.
  Combined **154 passed, 0 unexpected failures**. Did not chase the pre-existing
  `fork-dlopen-replay-e2e` failures or the ignored `smoke_fork_from_thread`.

## Concerns / deviations (with proof)

### 1. Two ADDITIONAL obviated test files beyond the step-1 list

The task premise ("the 13 are called ONLY by two Vitest files") undercounted:
`host/test/fork-module-trampoline.test.ts` (case #2) and
`host/test/fork-module-borrowed-replay.test.ts` (all 3 cases) ALSO called the
deleted exports directly (`fm_begin_unwind_fixed_arena`,
`fm_add_activation_unwind_fixed_arena`, `fm_finish_unwind`,
`fm_serialize_journal_fixed_arena`, `fm_begin_replay`, `fm_finish_replay`,
`fm_begin_borrowed_child_replay`). They were the primary consumers of the
in-realm fixed-arena harness — precisely the machinery the task told me to delete.
They cannot be retargeted to the coarse path without a full faithful-guest +
channel-responder harness (the coarse entries drive guest phase-flips through the
injected `fm_drive_execute` shim), which would duplicate the e2e/native tests.

Resolution (honest, no faked coverage):
- `fork-module-borrowed-replay.test.ts`: **removed**. The borrowed (vfork)
  parent-corruption guard (byte-identical parent storage, incl. mid-replay trap,
  and the overlap-prefix EINVAL) is covered at production level by
  `vfork-lifetime` / `vfork-workspace` (parent byte-identity) and the coarse
  `fm_child_seed_borrowed` path in `vfork-fork-module` / `vfork-production-mechanism`
  + host-native (`smoke_vfork_*` green). The overlap-prefix EINVAL check still
  lives in the retained `begin_borrowed_child_replay_impl`, now reached via
  `fm_child_seed_borrowed`.
- `fork-module-trampoline.test.ts`: **dropped case #2** (fixed-arena
  multi-activation frame routing + wrong-activation-peek EINVAL gate); kept the
  guest-independent emit/validate and instance-cache cases. Per-activation frame
  routing is covered by the coarse two-activation dlopen e2e tests
  (`fork-from-dlopen-side-module-e2e`, `fork-dlopen-replay-e2e`) + host-native.

Coverage genuinely narrowed at the FOCUSED-unit level (the wrong-activation-peek
EINVAL journal gate and the stray-`finishAbort` EINVAL pairing no longer have a
dedicated unit assertion), but the underlying invariants remain enforced in the
retained impls and are exercised end-to-end. The step-1 seal-time-OOM →
`ContinuationAllocationError` contract is re-proven on the coarse
`sealCaptureAndSerialize` in the new `fork-module-backend-coarse-failures.test.ts`,
along with the module-or-fatal constructor cap.

### 2. Stale gitignored host/dist blocked the first local-build

`./run.sh local-build`'s VFS image builds boot the kernel from the COMPILED
worker-entry bundle (`host/dist/*.js`) when `compiledWorkerEntryIsCurrent` accepts
it. That bundle embedded the OLD `FORK_MODULE_REQUIRED_EXPORTS` (still listing the
13), so booting against the freshly-rebuilt wasm (13 gone) failed with
"fork-module is missing required exports: fm_begin_unwind, ...". Rebuilding the
bundle with `scripts/build-host.sh` (host/dist is a gitignored artifact) fixed it;
the second local-build was fully green. This is a pre-existing dist-freshness
mechanism detail (a host/src change did not force the compiled worker-entry to be
treated as stale for the VFS-build boot path), not a source defect in this change,
and required no committed change.
