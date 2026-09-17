# Fork control-flow inversion — begin / seed / abort-seal folds

**Status: DONE**

All three folds landed. TS production no longer calls any of the five
fine-grained `fm_*` capture/seed/finish-unwind exports; every phase goes
through a coarse module entry, mirroring the already-landed seal / replay /
finish folds.

## Commits (on `brandonpayton/rust-first-abi44-reconcile`, atop `d024beab5`)

- `82c9af0ba` Fork: Route the abort-seal through the coarse fm_parent_abort_seal entry (FOLD 3)
- `d09dc4b66` Fork: Route capture-begin through the coarse fm_parent_begin_capture entry (FOLD 1)
- `ada5850f9` Fork: Route child-seed through the coarse fm_child_seed entry (FOLD 2)

(Not pushed. `local-binaries/`, `host/wasm/`, `local-binaries/source-only-v1/`
fork_module{32,64}.wasm rebuilt/staged but untracked, per repo convention.)

## Before → after: fine-grained `fm_*` calls on the TS production path

| Fine-grained export | before (coordinator path) | after |
|---|---|---|
| `fm_begin_unwind` (`beginUnwind`) | 1 (`beginModuleCapture`) | 0 |
| `fm_add_activation_unwind` (`addActivationUnwind`) | 1 (`beginModuleCapture`) | 0 |
| `fm_begin_child_replay` (`beginChildReplay`) | 1 (`attachModuleChild`) | 0 |
| `fm_add_activation_child_replay` (`addActivationChildReplay`) | 1 (`attachModuleChild`) | 0 |
| `fm_finish_unwind` (`sealForAbort`) | 1 (`beginModuleCaptureAbort`) | 0 |

**begin / seed / finish-unwind all → 0.** The coordinator's remaining
`sealForAbort()` call now routes through the coarse `fm_parent_abort_seal`, not
`fm_finish_unwind`. The fine-grained exports + their backend wrapper methods
(`beginUnwind`, `addActivationUnwind`, `beginChildReplay`,
`addActivationChildReplay`, `finishUnwindAndSerialize`, `sealForAbort`) are
retained for the host TS backend unit tests + host-native + `.mjs` harnesses, as
directed.

## What each fold does

- **FOLD 1 — `fm_parent_begin_capture`** (`crates/fork-module/src/lib.rs`,
  `crates/fork-codec/src/drive_plan.rs`, `crates/fork-module-inject/src/main.rs`,
  host `fork-module-backend.ts` / `fork-process-continuation.ts`): opens
  activation 0's fresh capture, adds each side activation from a host-seeded
  `(id, fixedPrefix)` list, publishes each activation's arena root into its
  module-buffer prefix INTERNALLY, and `call_indirect`s each guest
  `wpk_fork_unwind_begin(root)` through the injected shim in ascending id order.
  New ABI-neutral drive op `DRIVE_OP_UNWIND_BEGIN` (a `(ptr)->()` begin flip in
  the existing pointer-drive band) + `DRIVE_SLOT_UNWIND_BEGIN` (appended slot 10,
  `DRIVE_SLOTS_PER_ACTIVATION` 10→11). The plan is ephemeral per-fork scratch, so
  the op renumber (`UNWIND_END` 9→10, `REWIND_END` 10→11, `ABORT_END` 11→12)
  needs no ABI bump — codec + injector agree at build time. Activation-0 root is
  returned; side anchors are read back via the new `fm_activation_module_buffer`
  getter for the seal-time manifest (a read of module state; `beginUnwind`
  already returned a root, so no new host authority).

- **FOLD 2 — `fm_child_seed`** (same files + `module_state_records.rs`): decodes
  the inherited `JournalImage` KFMS record from the copied arena itself (new
  `fork_codec::decode_journal_image` + a module envelope scan) and seeds
  activation 0's replay from it, then seeds each side activation from a
  host-passed `(id, root, fixedPrefix)` list, in ONE call.

- **FOLD 3 — `fm_parent_abort_seal`**: the mid-unwind sibling of
  `fm_parent_seal_capture`. Wraps the same `finish_unwind_impl` seal (no guest
  unwind-end drive, no serialize — the guest is mid-unwind and no child is
  launched), so the abort path routes through a coarse phase entry.

## Validation (Node, aarch64) — one line

Cargo (fork-codec 442, fork-module-inject 2, host-native 45) + the fork Vitest
suite (fork-instrument-coverage 41 incl. P-11 abort-end / P-10 deep-continuation,
malloc-deep-fork, fork-module-{gc,exnref}-replay, fork-module-backend-{abort,
multi-activation}, fork-from-dlopen-side-module-e2e, dlopen-e2e,
fork-module-drive-shim, vfork-{fork-module,lifetime},
fork-capture-session-host-exception, fork-from-thread, gc/exnref fresh-worker)
all pass; `build-wasm --verify-fresh` (both widths) + `./run.sh local-build`
(98/98) + `xtask verify-fresh` + `check-abi-version.sh` all exit 0; ABI snapshot
unchanged (ABI-neutral).

Note: `fork-instrument-coverage` fixtures cost a uniform ~7.3 s each (kernel
boot + guest wasm compile — the same for non-fork F-01/F-02), so the file needs
`--testTimeout` > the 5 s default on this machine; this is pre-existing
environment cost, not a fold regression (verified by uniform cost across
fork/non-fork fixtures).

## Residue surfaced WITH proof (not deferred — the fold itself is complete)

The three folds fully eliminate the fine-grained production calls. Two premises
in the fold brief turned out to be factually inverted; neither blocks the fold,
but both are recorded here with concrete evidence:

1. **The module does NOT own the KFMS arena; it cannot append records.** FOLD 1's
   brief said "the module owns the arena, so it also appends the JournalImage /
   ActivationContinuations KFMS records host-side today." Evidence:
   `crates/fork-codec/src/module_state_records.rs` is DECODE-ONLY (its own header
   comment lists the pure-byte record decoders and defers the live/binding
   records); the KFMS WRITE protocol — chunk allocation, `reserveRecord` /
   `commitRecord`, `payloadIndex`, `seal()` validation — lives entirely in host
   TS (`host/src/fork-module-state.ts`, class `ForkModuleStateArena`). The module
   only ever receives a `module_state_root` pointer and reads raw bytes. Appending
   records from the module would desync the host arena bookkeeping
   (`chunk.used` / `recordCount` / `payloadIndex`) and break `seal()`. The KFMS
   record APPENDS (`appendJournalImage` / `appendActivationContinuations`)
   therefore stay host-side in `sealModuleCapture`. This is orthogonal to
   eliminating the fine-grained begin calls, which FOLD 1 does regardless.

2. **A side activation's `fixedPrefix` is a genuine host residue (proven, and the
   codebase already documents it).** FOLD 2's brief said the module can fully
   self-seed side activations by decoding the records "it wrote in FOLD 1's seal."
   But `fixedPrefix` is absent from EVERY inherited KFMS record: the
   `ActivationContinuations` (KFAC) entry carries only `(activationId, root)`
   (`WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_SIZE`, encoder
   `encodeForkActivationContinuations`), and the `JournalImage` (KFJI) record
   carries only `(ptr, len)`. The existing `add_activation_child_replay_impl`
   doc already states verbatim: *"the journal image does not carry it, so the host
   supplies it."* `fixedPrefix` is a static property of the child's own loaded
   side module (its `kandelo.wpk_fork.linked_frames` descriptor), which is host
   knowledge on the child. So `fm_child_seed` has the module read what it CAN
   (the `JournalImage` record, from the arena) and the host pass the per-side
   `(id, root, fixedPrefix)` — `root` because the host must decode
   `ActivationContinuations` for its own launch-anchor cross-check anyway
   (`activationRootsFromChildArena`), `fixedPrefix` because it is not derivable
   from any inherited byte. Making the module derive side roots too would need a
   redundant Rust KFAC decoder and would still leave `fixedPrefix` host-supplied,
   so it was not worth the risk; the fold (one coarse call replacing the host
   begin+add loop) is complete either way.

## Owed / not run here

- Browser validation of FOLD 2's reentrant multi-activation child path (owed;
  the coordinator runs it). Node multi-activation child (dlopen) is green.
- Pre-existing, unrelated: `fork-dlopen-replay-e2e.test.ts` has 2 failing
  pthread-hosted-dlopen tests (`WebAssembly.Instance(): "env"
  "__wpk_fork_frame_reserve": function import requires a callable`). Confirmed
  IDENTICAL at the FOLD1+3 baseline with FOLD 2 stashed, so not caused by any
  fold; it is a pthread-worker import-projection issue none of these folds touch.
