# Item #4: Prune/migrate the Node `.mjs` fork-module harnesses off the 13 deleted fork-DRIVE exports

Status: **DONE**

Branch `brandonpayton/rust-first-abi44-reconcile`, worktree
`/Users/brandon/kandelo-abi44-reconcile`, built on HEAD `5e75adf79`.
Not pushed; no amend/force; `.superpowers/` untouched.

## Commits (on top of 5e75adf79)

- `7b5bba3fd` Test: Remove fine-grained multi-activation fork-module Node harnesses
- `0883c7797` Test: Prune fork-module co-residency harness to retained-surface only

## Key structural finding (why re-express-at-coarse was infeasible for these harnesses)

The three fine-grained harnesses drove the module's **in-realm, no-servicer
fixed-arena primitives** (`fm_begin_unwind_fixed_arena`,
`fm_add_activation_unwind_fixed_arena`, `fm_serialize_journal_fixed_arena`) plus
the non-fixed `fm_finish_unwind` / `fm_begin_replay` / `fm_finish_replay` /
`fm_begin_abort` / `fm_finish_abort` / `fm_begin_child_replay` /
`fm_add_activation_child_replay`. These exist *specifically* for a
single-threaded bare-Node harness with no host servicer and no guest.

The coarse `fm_parent_*`/`fm_child_*` entries they would migrate to CANNOT run
in bare Node:

- `begin_capture_impl` / `seal_capture_impl` call `channel_mmap`, which blocks on
  `memory_atomic_wait32(...CH_PENDING...)` until a **host servicer thread** wakes
  it (`crates/fork-module/src/lib.rs` ~L1772, L2554). There is **no** coarse
  fixed-arena variant.
- Every coarse entry (`fm_parent_begin_capture`, `fm_parent_seal_capture`,
  `fm_parent_replay`, `fm_child_reconstruct`, `fm_parent_finish`) drives the
  guest continuation via `call_indirect` over `__wpk_fork_drive_table` (the
  injector-wired `fm_drive_execute` shim) — i.e. it needs a real guest bound into
  the drive table.

Providing a servicer worker + a guest drive table in JS would re-implement, in
Node, exactly what `crates/host-native` already does in Rust via wasmtime and
what the production TS worker does live. That is the opposite of "migrate tests
to where the primitives live." So the correct disposition per the directive was
to migrate/verify coverage in Rust (fork-codec) and prune the .mjs.

## Per-harness disposition

| Harness | Called any of the 13? | Disposition |
|---|---|---|
| `harness.mjs` (was 828 lines) | yes (`fm_begin_unwind_fixed_arena` via a helper, `fm_finish_unwind`, `fm_begin_replay`, `fm_finish_replay`, `fm_begin_abort`, `fm_finish_abort`, `fm_serialize_journal_fixed_arena`, `fm_begin_child_replay`) | **pruned-to-retained-surface** (~300 lines). Kept the V8 co-residency proof (sentinel-fill low memory, instantiate PIE module at HIGH `__memory_base`, assert sentinel byte-for-byte intact after instantiation *and* after retained coordinator calls) + retained surface `fm_set_format`, `fm_externref_handle` trap, `fm_stats` inert counters. Removed `runMultiChunk`/`runStress`/`runAbortCycle`/`runAbortCorruption`/`forkRoundTrip`. Dropped the 13 from the export-presence assertion. |
| `harness-multi-activation.mjs` (277 lines) | yes | **removed-as-redundant** (fully covered by fork-codec; no retained-surface value; can't be coarse in bare Node). |
| `harness-multi-activation-child.mjs` (377 lines) | yes | **removed-as-redundant** (same; also was never wired into any runner). |
| `fork-trampoline.mjs` (212 lines) | no (pure wasm-byte emitter) | **removed** — orphaned once its only two consumers (the two harnesses above) were removed. Production port `host/src/fork-module-trampoline.ts` + its test `host/test/fork-module-trampoline.test.ts` remain. |
| `harness-capture.mjs` (318 lines) | no (only retained `fm_capture_*`/`fm_ref_*` marshalling) | **kept unchanged** — retained marshalling surface; unique V8 compiled-module coverage. |

Also updated: `crates/fork-module/build-wasm.sh` `--run` block (dropped the
multi-activation invocation, added a comment explaining the coverage move) and a
dangling doc-comment reference in `crates/fork-module/src/lib.rs`.

## Coverage verification (where the primitives now live — no new Rust tests needed)

Every behavior the removed/pruned drive exercised is already covered in
`crates/fork-codec` (442 tests, all passing):

- **Multi-chunk + 5000-frame writer round trips** — `linked_frames_writer.rs`:
  `round_trip_multi_chunk_decodes_to_written_frames`,
  `chain_of_5000_frames_round_trips`, `grows_past_the_old_four_mib_cap`,
  `rejects_reserve_before_begin_unwind`.
- **Tail-first rewind order, corrupted-node rejection, wrong-activation
  anti-aliasing** — `rewind_driver.rs`:
  `closed_loop_drives_full_chain_in_rewind_order`,
  `peek_rejects_tail_node_corrupted_after_attach` (the exact analogue the pruned
  `runAbortCorruption` cited), `drive_peek_rejects_wrong_activation`,
  `next_past_end_errs`, `peek_on_empty_continuation_errs`.
- **Parent/child journal + ascending per-activation resume slots + KFRE
  child-seed + abort pairing** — `replay_journal.rs`:
  `parent_path_matches_ts_journal_and_slots`,
  `child_path_matches_ts_journal_and_slots`,
  `serialize_image_seeds_child_journal_identically`,
  `register_assigns_sorted_ascending_slots`, `consume_activation_mismatch_errs`,
  `require_selected_event_wrong_activation_errs`,
  `begin_parent_replay_requires_sealed`, `finish_replay_with_unconsumed_errs`,
  `abort_returns_to_idle_and_allows_recapture`.
- **KFRE image encode/decode** — `replay_events.rs`:
  `encode_then_decode_image_round_trips`, `decodes_two_segment_wire_in_capture_order`,
  `decode_image_rejects_*`.
- **Resume-catalog decode/validation** — `catalogs.rs`:
  `decodes_resume_fixture_field_for_field`, `rejects_resume_*`,
  `accepts_empty_resume_catalog`.

Compiled-module co-residency + coordinator execution in a real engine is proven
in `crates/host-native` (`fork_module_tests::smoke_instantiates_fork_module`,
wasmtime) and, for the retained marshalling surface, still in `harness-capture.mjs`
(V8). No Rust tests were added — the coverage already exists.

## host/src callers of the 13 — none to migrate

All direct `exports.fm_*` calls to the 13 in `host/src` are inside the wrapper
method DEFINITIONS in `host/src/fork-module-backend.ts` (item #3's domain — left
intact). No LIVE code calls those fine wrappers:

- Live `beginParentReplay()` / `finishReplay()` callers
  (`fork-process-continuation.ts`, `fork-activation-registry.ts`, `worker-main.ts`,
  `fork-table-snapshot.ts`) target `ForkReferenceCaptureSurface` / the
  reference-model registry (the RETAINED reference floor), not the backend fine
  wrappers, and do not reach the 13.
- The 13 export NAMES also appear as string literals in
  `FORK_MODULE_REQUIRED_EXPORTS` (`host/src/fork-module-instance.ts`) — that is the
  export declaration surface (item #3 territory), not a call.

## Grep proof (completion criterion)

Call-shaped occurrences of the 13, in `crates/fork-module/tests/*.mjs` and
`host/src/**`, excluding the wrapper definitions in `fork-module-backend.ts`:

```
$ grep -rnE "\.(fm_begin_unwind|fm_add_activation_unwind|fm_begin_unwind_fixed_arena|\
fm_add_activation_unwind_fixed_arena|fm_finish_unwind|fm_serialize_journal_alloc|\
fm_serialize_journal_fixed_arena|fm_begin_replay|fm_finish_replay|fm_begin_child_replay|\
fm_begin_borrowed_child_replay|fm_begin_abort|fm_finish_abort)\(" \
  crates/fork-module/tests/*.mjs host/src/ | grep -vE "^host/src/fork-module-backend\.ts:"
=> ZERO CALLS
```

(The only remaining textual references in the .mjs are prose comments in
`harness.mjs` documenting what was removed and where the coverage moved.)

## Validation run (host triple, inside scripts/dev-shell.sh)

- `node crates/fork-module/tests/harness.mjs host/wasm/fork_module32.wasm` — PASS (pruned)
- `node crates/fork-module/tests/harness-capture.mjs host/wasm/fork_module32.wasm` — PASS
- `cargo test -p fork-codec --target aarch64-apple-darwin` — **442 passed**, 0 failed
- `cargo test -p host-native --lib --target aarch64-apple-darwin` — **45 passed**, 4 ignored, 0 failed
- `cargo test -p fork-module-inject --target aarch64-apple-darwin` — **2 passed**
- `scripts/check-abi-version.sh` — consistent (snapshot in sync, ABI_VERSION consistent)

No wasm rebuild was needed: the pruned/kept harnesses call only exports present
in the current build, and no ABI-bearing artifact changed.

## Concerns / required item #3 follow-ups (WITH PROOF)

1. **Two host/test TS harnesses call the backend fine wrappers that item #3
   deletes** — they are the TS analogues of the removed .mjs and are OUTSIDE this
   task's completion criterion (`.mjs` + `host/src`), so they were left intact
   (the wrappers still exist until item #3). Item #3 must remove/migrate them
   when it deletes the wrappers, or they will fail to compile/run:
   - `host/test/fork-module-backend-multi-activation.test.ts` — `backend.beginUnwind()`,
     `.addActivationUnwind()`, `.finishUnwindAndSerialize()`, `.beginParentReplay()`,
     `.finishReplay()`, `childBackend.beginChildReplay()`.
   - `host/test/fork-module-backend-abort.test.ts` — `backend.beginUnwind()`,
     `.addActivationUnwind()`, `.finishUnwindAndSerialize()`, `.beginAbort()`,
     `.finishAbort()`.
   (The other `beginParentReplay`/`finishReplay` callers in host/test —
   fork-activation-registry, fork-capture-session-host-exception,
   fork-exception-provider, fork-replay-events — target the retained
   reference-model methods, verified: no `ForkModuleContinuationBackend`
   fine-wrapper calls, so they are NOT affected.)

2. **`FORK_MODULE_REQUIRED_EXPORTS` lists the 13 names** in
   `host/src/fork-module-instance.ts`. Item #3 must drop those 13 entries when it
   deletes the exports, otherwise the post-deletion module will fail the
   required-export presence assertion at instantiation.

3. **Lost sub-proof (bounded, acceptable):** the pruned `harness.mjs` no longer
   asserts the sentinel is intact after a *full fork drive* (that drive required
   the deletable primitives and cannot run in bare Node post-deletion). The
   remaining V8 proof (sentinel intact after instantiation's passive-segment
   relocation + retained coordinator writes) plus host-native's wasmtime
   `smoke_instantiates_fork_module` (co-resident instantiation + `fm_set_format`
   execution, region within `max_addr`) together preserve the co-residency
   invariant. If a full-drive V8 co-residency proof is still wanted, it belongs in
   a serviced host test (host/test TS worker or a host-native wasmtime driver
   test), not a bare-Node harness.
