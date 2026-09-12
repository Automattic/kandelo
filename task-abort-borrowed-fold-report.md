# FOLD A (abort-replay-begin) + FOLD B (borrowed vfork child-seed) — report

Status: **DONE**

Branch: `brandonpayton/rust-first-abi44-reconcile`
Base HEAD at start: `ada5850f9`
New commit: `adf6903a6`

## Summary

The TS-production control-flow inversion for fork is complete: the only
remaining fine-grained `backend.<method>` call in orchestration is the
proven genuine seed `setActivationResumeCatalog`.

### FOLD A — abort-replay-begin: ALREADY LANDED (no code change needed)

FOLD A was already folded in an ancestor of the starting HEAD, commit
`8a192b237` ("Fork: Route parent replay/abort through the coarse module
entries"). `beginModuleAbortReplay` already drives the coarse
`backend.parentAbort()` (which internally begins the abort and
`call_indirect`s each activation's `wpk_fork_abort_begin`), NOT the
fine-grained `backend.beginAbort()` + per-activation loop the task brief
described. The task brief's line references (486-488) were stale: line 487
was only a comment still naming `backend.beginAbort()`.

The one change I made for FOLD A was correcting that stale comment in
`beginModuleCaptureAbort` to name `backend.parentAbort()`. There was no live
`backend.beginAbort()` call to remove.

Proof it was pre-landed:
- `git merge-base --is-ancestor 8a192b237 HEAD` → true
- `beginModuleAbortReplay` body calls `backend.parentAbort()` (was
  `backend.beginAbort()` + `invokeForkContinuationBegin` loop in `8a192b237`'s
  parent).

### FOLD B — borrowed (vfork) child-seed: IMPLEMENTED (mirror of FOLD 2)

Folded `attachBorrowedModuleChild`'s host loop
(`backend.beginBorrowedChildReplay` + per-side-activation
`backend.addActivationBorrowedChildReplay`) into ONE coarse module call
`backend.childSeedBorrowed` → `fm_child_seed_borrowed`, exactly mirroring
FOLD 2's `childSeed`/`fm_child_seed`.

- **Rust** (`crates/fork-module/src/lib.rs`):
  - `child_seed_borrowed_impl` — reuses FOLD 2's `journal_image_from_arena`
    to decode the inherited `JournalImage` KFMS record from the arena, seeds
    activation 0 via `begin_borrowed_child_replay_impl`, then seeds each side
    via `add_activation_borrowed_child_replay_impl`.
  - `fm_child_seed_borrowed` export.
  - Per-side scratch record is 24 bytes `(id, fixed_prefix, root_lo, root_hi,
    private_lo, private_hi)` — carries the extra borrowed datum (the
    child-PRIVATE prefix) and keeps both the inherited anchor and the private
    prefix wasm64-safe via low/high words. `act0_private_prefix` is a
    width-aware pointer argument.
- **Host TS**:
  - `host/src/fork-module-backend.ts`: `childSeedBorrowed(arenaRoot,
    act0Root, act0PrivatePrefix, sideActivations[])`.
  - `host/src/fork-module-instance.ts`: added `fm_child_seed_borrowed` to
    `FORK_MODULE_REQUIRED_EXPORTS` (so the export is typed + required).
  - `host/src/fork-process-continuation.ts`: `attachBorrowedModuleChild`
    now builds a `sideSeeds` list and makes ONE `backend.childSeedBorrowed`
    call. Removed the now-unused `journalImageForChild` import and the
    borrowed-path `const records` (the module decodes the journal image
    itself now). Fixed the downstream comment that named the old fine-grained
    borrowed calls.
  - `host/src/worker-main.ts`: updated the borrowed-admission comment to
    name `childSeedBorrowed`.

The fine-grained `beginBorrowedChildReplay` /
`addActivationBorrowedChildReplay` (host + Rust `fm_begin_borrowed_child_replay`
/ `fm_add_activation_borrowed_child_replay`) remain exported for the module
unit tests + host-native, per the brief (deletion is a later step).

### DO NOT TOUCH — kept

`worker-main.ts` `setActivationResumeCatalog` left untouched (the genuine
once-per-activation instantiation seed).

## ABI

ABI-neutral. `fm_child_seed_borrowed` is an additive coarse `fm_*` entry
bound by name; it reuses the existing `begin_borrowed_child_replay_impl` /
`add_activation_borrowed_child_replay_impl` and needs NO new drive op, NO
`fork-module-inject` change, NO `fork-codec` change, and NO guest
re-instrument. `cargo run -p xtask -- verify-fresh` and
`scripts/check-abi-version.sh` both report the snapshot in sync with sources
(no `ABI_VERSION` bump needed).

## Completion grep proof

`grep -noE "backend\.[a-zA-Z]+\(|\.backend\.[a-zA-Z]+\("` over
`host/src/fork-process-continuation.ts` + `host/src/worker-main.ts`:

Remaining calls are all COARSE module entries or ref-typed drive-table binds
(host floors):
`parentBeginCapture`, `activationModuleBuffer`, `sealCaptureAndSerialize`,
`parentReplay`, `parentAbort`, `childSeed`, `childSeedBorrowed`,
`childReconstruct`, `parentFinish`, `attachChild`, `attachBorrowedChild`,
`driveRestoredPlan`, `decodedNodeCount`, and the `bindActivation*Drive`
binds. The ONLY fine-grained method call is
`worker-main.ts:862 .backend.setActivationResumeCatalog(`.

Forbidden fine-grained calls — confirmed ZERO:
`beginAbort`, `beginBorrowedChildReplay`, `addActivationBorrowedChildReplay`,
`beginChildReplay`, `addActivationChildReplay`, `beginUnwind`,
`addActivationUnwind`.

## Validation (Node, aarch64-apple-darwin, inside dev-shell)

cargo:
- `fork-codec`: 442 passed, 0 failed.
- `fork-module-inject`: 2 passed, 0 failed.
- `host-native --lib`: 45 passed, 0 failed, 4 ignored.

fork Vitest (all passed):
- `fork-module-borrowed-replay`: 3/3
- `fork-module-backend-multi-activation`: 1/1
- `vfork-fork-module`: 1/1
- `malloc-deep-fork`: 2/2
- `fork-module-multi-activation-funcref-replay`: 1/1
- `fork-module-gc-replay`: 3/3
- `fork-module-exnref-replay`: 6/6
- `fork-capture-session-host-exception`: 4/4
- `fork-module-backend-abort`: 3/3
- `fork-module-kernel-abort`: 1/1
- `fork-instrument-coverage`: 41 passed + 2 expected-fail + 8 skipped
  (P-01..P-11 incl. the P-11 abort path all green). NOTE: this suite boots a
  full kernel per test (~7.3s each); it needs `--testTimeout=30000`. With the
  vitest default 5s per-test timeout on this loaded machine every test times
  out (that is a timeout-config artifact, not a regression — verified by
  re-running with 30s and getting 41/41 green).
- `fork-from-thread`: passed.

Known PRE-EXISTING failure — confirmed still identical, not touched:
- `fork-dlopen-replay-e2e`: 2 pthread-hosted-dlopen tests fail with
  `WebAssembly.Instance(): Import #34 "env" "__wpk_fork_frame_reserve":
  function import requires a callable` (6 passed, 1 skipped). Same error as
  the documented baseline; not caused by this fold.

Freshness / ABI gates:
- `crates/fork-module/build-wasm.sh` (both widths built + staged to
  `local-binaries/`, `host/wasm/`; also copied to
  `local-binaries/source-only-v1/`).
- `build-wasm.sh --verify-fresh`: both fork_module32/64.wasm match current
  source.
- `./run.sh local-build`: succeeded (98/98 nodes, 7/7 products).
- `cargo run -p xtask -- verify-fresh`: exit 0, ABI snapshot in sync.
- `scripts/check-abi-version.sh`: exit 0.

## Genuinely-irreducible residue

None beyond the intentionally-kept `setActivationResumeCatalog` (a guest
`WebAssembly.Module` custom-section extraction the co-resident module cannot
parse — host-only instantiation seed, explicitly out of scope).
