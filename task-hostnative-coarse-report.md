# host-native coarse-fork-module migration — report

Branch `brandonpayton/rust-first-abi44-reconcile`, worktree
`/Users/brandon/kandelo-abi44-reconcile`. Not pushed (coordinator pushes
forward-only). No amend/force. `.superpowers/` untouched.

## Status: DONE_WITH_CONCERNS

The native (wasmtime) fork driver now drives every fork PHASE — capture-begin,
seal, parent-replay, parent-abort, finish, child-seed (COW + vfork), and
child-reconstruct — through the coarse `fm_parent_*`/`fm_child_*` entries,
binding the guest phase-flip funcrefs into `__wpk_fork_drive_table` and letting
the module `call_indirect` them, exactly as the TS/browser host does. Two
concerns are reported below (reference/GC "unification" and exnref), both with
proof; neither is a regression and both match TS behaviour.

## Commits (this session, on top of the pre-existing parent/child work)

Pre-existing (earlier in this task, already landed green):
- `67b588270` Add coarse `fm_*` TypedFunc handles + drive-table phase-flip bind
- `83e5cbfd9` Parent path coarse (begin/seal/replay/finish)
- `cfebb27ee` Child path coarse (COW + vfork: `fm_child_seed`/`_borrowed` +
  `fm_child_reconstruct`; parent seal appends the JournalImage KFMS record)
- `7472a1b73` (coordinator docs commit — the resume point)

This session:
- `63f42ce9c` Fork: route the gated / failed-child-launch path through the
  coarse `fm_parent_abort` + `fm_parent_finish(1)` (item #1, abort path).
- `d2d00a02f` Docs: record the native exnref fork-capture gap + follow-up
  (item #3).

## Item #1 — ABORT PATH: DONE

Native now mirrors TS `beginAbortReplay`: an unsupported-reference (gated) fork
and a failed child launch (`fork_result < 0`) resume the parent at `fork()`
with its errno via the coarse `fm_parent_abort` (drives guest
`wpk_fork_abort_begin`), finished by `fm_parent_finish(1)` (drives
`wpk_fork_abort_end`). `ForkCoordState` gained an `abort_replay` flag the entry
loop sets and the `Replaying`-phase finish reads (both the main-thread and
worker-thread `kernel_fork` closures). Successful forks stay on
`fm_parent_replay` + `fm_parent_finish(0)`.

Empirical: `smoke_fork_gated_externref_parent_survives` passes with the true
abort path — confirming native's guest supports post-seal `wpk_fork_abort_begin`
from NORMAL state (previously native modeled these as normal-rewind + forced
errno). No fine-grained `fm_begin_abort`/`fm_finish_abort` exist in the native
drive.

`fm_parent_abort_seal` has NO native call site: native has no mid-unwind
`reserve==0` partial-capture path (guest frame reserves go straight to the
module; native does not intercept `reserve==0`). This is a pre-existing native
gap, documented, unchanged — the coarse handle is bound but correctly unused.

## Item #2 — REFERENCE/GC MODEL: already unified; drive is load-bearing (CONCERN)

The maintainer correction's premise ("TS uses guest-pull, native uses an
explicit host-drive; drop native's `fm_build_gc_plan`+`fm_drive_execute`") does
not hold against the code. Native is ALREADY unified with TS:

1. Native already binds the guest-PULL feed imports to the module —
   `__wpk_fork_ref_decode_funcref`→`fm_funcref_ordinal`,
   `__wpk_fork_ref_{vector_get,gc_route,gc_payload_len,gc_load}`→`fm_ref_*`,
   `__wpk_fork_ref_exn_{route,load,cache_index}`→`fm_ref_exn_*`
   (`guest.rs` ~5640-5680) — the exact set TS's `moduleReferenceFeedFlip`
   (`worker-main.ts:3812`) binds.
2. TS is NOT pure guest-pull for GC/exnref: `worker-main.ts:3805-3807` states
   the guest `_gc_allocate`/`_gc_fill` exports "call back into these module
   exports", and `fork-process-continuation.ts` `attachModuleChild` drives them
   via `driveRestoredPlan` → `fm_drive_execute`. So TS host-drives the
   topological GC/exnref reconstruction with the SAME `fm_drive_execute`
   native uses.
3. Funcref/externref ARE pure guest-pull on native today (decoded directly via
   the bound imports; `fm_build_gc_plan` yields a 0-step plan, so
   `fm_drive_execute` is a no-op for them).
4. GC (struct/array/i31) and exnref CANNOT pure-pull under the current, shared,
   non-re-instrumented guest — the guest reads reconstructed GC objects out of
   the anyref transit table (`recipe+1` slots) that the host must populate in
   topological order by driving `_gc_allocate`/`_gc_fill`; the guest's linear
   frame-rewind cannot order that itself.

PROOF (reproduced): temporarily skipping `fm_build_gc_plan`+`fm_drive_execute`
(keeping `fm_begin_reference_replay`) makes `smoke_fork_gc_struct_reconstructs`
fail with:

```
guest entry failed: ... wpk_fork_resume_start: wasm trap:
undefined element: out of bounds table access   (in test_gc_struct)
Error: pump timed out after 30s
```

i.e. the guest reads an unpopulated transit slot. This is not a wasmtime
limitation — it is the guest architecture, identical on TS. The experiment was
reverted; the tree keeps the drive.

Action taken: per the correction's own instruction ("if a kind genuinely cannot
pull, land what can and STOP to report the exact kind + reproduced error"), the
funcref/externref pull path is already in place, and native's
`fm_begin_reference_replay` + `fm_build_gc_plan` + `fm_gc_plan_count` +
`fm_drive_execute` GC/exnref drive is KEPT (it is the same mechanism TS reaches
via `fm_attach_child`/`driveRestoredPlan`). Removing it would break GC on native
and diverge from TS, not unify. `fm_begin_reference_replay` is explicitly an
allowed KEEP; the other three are the load-bearing GC/exnref host-drive.

Note: native cannot swap to TS's folded `fm_attach_child` (`restore_from_arena`)
either — that entry appends `DRIVE_OP_RESTORE`/`FINISH_RESTORE` steps that
`call_indirect` the guest `wpk_fork_module_state_restore`/`_finish` at drive
slots 3/4, which native neither binds nor uses (native harvests static roots at
instantiation rather than using the module-state-restore install path).

## Item #3 — EXNREF: deferred with proof (pre-authorized)

wasmtime 48 is NOT the exnref blocker. The RECONSTRUCT side is fully wired on
native (`fm_ref_exn_*` bound, `_exception_materialize` drive slot bound,
`fm_set_host_exception_owner` available; `smoke_loads_fork_instrumented_guest`
loads+runs the exnref-declaring instrumented guest; `ThrownException` +
`Store::take_pending_exception` work). The maintainer's flagged
"wasmtime can't reconstruct exnref" concern is stale.

The real remaining gap is native's exnref CAPTURE side: the exception-codec
capture imports the guest calls while spilling a live exnref across `fork()` —
`__wpk_fork_ref_exn_{claim,define,broker_encode,lookup,ingress_throw}` — are NOT
bound in `guest.rs` (only the 3 reconstruct imports are), so they fall to
`define_unknown_imports_as_traps`. An exnref-carrying fork would therefore TRAP
during capture (fail loud — a wasm trap ending the guest OS thread — not
silently wrong), rather than reconstruct or cleanly gate.

Not driven empirically because NO exnref-carrying fork fixture exists (current
fixtures cover frames-only, funcref, externref, GC struct/array/i31 — none hold
a live exnref across `fork()`); authoring one + wiring/gating capture is a
substantial separate effort. Documented in `docs/future-improvements.md` with
the follow-up (bind capture imports to a full body or a clean
`mark_unsupported("exnref")` EOPNOTSUPP gate; add an exnref fixture + test).

## Fine-grained `fm_*` CALL count in `guest.rs` drive (before → after)

Before (task start): the drive called the fine-grained lifecycle set
(`fm_begin_unwind`, `fm_finish_unwind`, `fm_serialize_journal_alloc`,
`fm_begin_replay`, `fm_finish_replay`, `fm_begin_child_replay`,
`fm_begin_borrowed_child_replay`) PLUS direct guest phase-flip calls
(`wpk_fork_unwind_begin`/`_end`, `wpk_fork_rewind_begin`/`_end`) PLUS the 4
reference-drive calls — ~11 fine-grained `fm_*` + 4 direct guest calls.

After: the entire lifecycle/phase-flip drive is coarse (8 of the 9 coarse
entries used; `fm_parent_abort_seal` correctly unused). No direct guest
phase-flip calls remain in the drive. Remaining fine-grained `fm_*` drive calls
= 4, all reference-reconstruction:
- `fm_begin_reference_replay` — allowed KEEP (TS calls it too).
- `fm_build_gc_plan` + `fm_gc_plan_count` + `fm_drive_execute` — the GC/exnref
  topological host-drive, proven load-bearing (item #2), identical to TS.

KEEP seeds untouched: `fm_set_format`/`fm_set_resume_catalog`/
`fm_set_activation_gc_codec`. Accessors (`fm_last_errno`, `fm_journal_image_len`,
`fm_stats`, `fm_drive_table_base`) are paired reads, not drives.

## Validation (all inside scripts/dev-shell.sh)

- `cargo test -p host-native --lib --target aarch64-apple-darwin` → 45 passed,
  0 failed, 4 ignored (the 4 ignored = 1 worker-thread N1 residual +
  3 fixture-writers; unchanged).
- `cargo test -p fork-codec --target aarch64-apple-darwin --all-targets` → 442
  passed, 0 failed.
- `cargo test -p fork-module-inject --target aarch64-apple-darwin` → 2 passed.
- `scripts/check-abi-version.sh` → snapshot in sync, ABI_VERSION consistent
  (ABI-neutral; no bump needed; `crates/fork-module` untouched so no module
  rebuild / no `xtask verify-fresh`).
- Did not touch the pre-existing unrelated `fork-dlopen-replay-e2e.test.ts`;
  `smoke_fork_from_thread` remains the intentionally-ignored N1 residual.

## Residue (with proof)

1. `fm_build_gc_plan`/`fm_gc_plan_count`/`fm_drive_execute` remain in native's
   GC/exnref reconstruction drive. PROOF: reproduced GC trap when removed
   (item #2); TS uses the identical `fm_drive_execute` mechanism
   (`worker-main.ts:3805`, `fork-process-continuation.ts` `driveRestoredPlan`).
   Not a native/TS divergence — keeping them IS parity.
2. `fm_parent_abort_seal` unused: native has no mid-unwind `reserve==0`
   partial-capture path (guest reserves go straight to the module; native
   never intercepts `reserve==0`). Pre-existing gap.
3. Exnref CAPTURE unwired (item #3) — documented in
   `docs/future-improvements.md`; current behaviour is fail-loud (capture-import
   trap), not silently wrong.
