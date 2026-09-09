# Fork control-flow inversion — replay-FINISH fold (fm_parent_finish)

Status: DONE (ABI-neutral). The replay-finish phase — the last host-driven
per-activation guest end loop + `fm_finish_replay`/`fm_finish_abort` — folded into
ONE coarse module call, sound and Node-validated. The remaining unfolded seed/
begin ops (capture-begin, child-seed, partial-abort seal) are classified below
with concrete reasons: they are entangled with host-side KFMS arena bookkeeping,
not the "host binds table / module drives guest" inversion pattern the coarse
entries implement. Browser leg (Chromium + WebKit) owed to the coordinator.

Worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile`. Built on `59ca59193`. Uses the proven
`fm_parent_seal_capture` `() -> ()` drive pattern (the landed capture-seal fold).

## Commits (source; wasm artifacts are gitignored build products)

- (codec) Fork: Add DRIVE_OP_REWIND_END/ABORT_END finish drive ops to the codec
- (injector) Fork: Route REWIND_END/ABORT_END through the shim's void call_indirect
- (module) Fork: Add the coarse fm_parent_finish replay-finish module entry
- (host) Fork: Route the replay finish through the coarse fm_parent_finish entry

## What folded into which coarse entry

`fm_parent_finish(abort: u32)` (`crates/fork-module/src/lib.rs`,
`finish_transaction_impl`) folds the WHOLE replay-finish phase into ONE module
call:

1. `build_finish_plan_impl(abort)` — one `DRIVE_OP_REWIND_END` (`abort` == 0) or
   `DRIVE_OP_ABORT_END` (`abort` != 0) step per open activation, ascending id
   order (`BTreeMap` keys). Argument-free (`() -> ()`).
2. drive the plan through the injector-wired shim (`drive_plan_via_injector` — the
   SAME `__wpk_fork_drive_plan` → `fm_drive_execute` seam the seal fold uses),
   which `call_indirect`s each guest `wpk_fork_rewind_end()` / `wpk_fork_abort_end()`
   (REWINDING / ABORT_UNWINDING → NORMAL).
3. `finish_replay_impl()` (replay) or `finish_abort_impl()` (abort) — exhaust every
   activation's driver, finish the process journal, and release this fork's
   channel-mapped chunks. The abort finish keeps the `in_abort` pairing assertion
   `fm_parent_abort` armed (a stray `fm_parent_finish(1)` is a loud `EINVAL`).

This replaces the host's former two-part finish (`finishModuleTransaction`): a
per-activation `wpk_fork_rewind_end()`/`wpk_fork_abort_end()` loop, then
`backend.finishReplay()`/`backend.finishAbort()`. Both replay and abort finish are
one coarse call.

### Mechanism (mirrors the capture-seal fold)

`wpk_fork_rewind_end` / `wpk_fork_abort_end` are `() -> ()` guest exports
(`fork_instrument::runtime::emit_end_fn`), the SAME shape as the already-folded
`wpk_fork_unwind_end`. So the injector needed NO new `call_indirect` type — only
to WIDEN its no-argument branch from `op == DRIVE_OP_UNWIND_END` to
`op >= DRIVE_OP_UNWIND_END`. New codec constants:

- `fork-codec`: `DRIVE_OP_REWIND_END = 10`, `DRIVE_OP_ABORT_END = 11`,
  `DRIVE_SLOT_REWIND_END = 8`, `DRIVE_SLOT_ABORT_END = 9`,
  `DRIVE_SLOTS_PER_ACTIVATION` 8 → 10, and `append_replay_end_steps(steps, acts,
  abort)`. The stride bump is an EPHEMERAL runtime host<->module table-binding
  contract (every side derives slots from `fm_drive_table_base`), so it is
  additive, not a wire/ABI format change.
- No op between `DRIVE_OP_REWIND_BEGIN` (7) and `DRIVE_OP_UNWIND_END` (9) is void,
  so the void-first / pointer-second / i32-default ordering stays correct (9/10/11
  all take the void branch; 7/8 the pointer branch).

## TS fine-grained call-sites deleted (before → after)

`host/src/fork-process-continuation.ts` `finishModuleTransaction`: the
per-activation guest `wpk_fork_rewind_end`/`wpk_fork_abort_end` drive loop and the
`backend.finishReplay()`/`backend.finishAbort()` call are GONE. It now binds each
activation's finish exports into the drive table (`bindActivationFinishDrive`),
issues ONE `backend.parentFinish(abortReplay)`, then sweeps the per-activation
NORMAL assertion post-drive (mirroring `beginModuleParentReplay` /
`sealModuleCapture`).

`host/src/fork-module-backend.ts`: added `parentFinish(abort)` +
`bindActivationFinishDrive(id, rewindEnd, abortEnd)`. The fine-grained
`finishReplay`/`finishAbort` wrappers are RETAINED (module-only unit tests +
host-native, which are follow-on migrations).
`host/src/fork-module-instance.ts`: `fm_parent_finish` added to the
required-export list.

Module-backend fine-grained finish calls in TS PRODUCTION: **2 → 0**
(`backend.finishReplay()` + `backend.finishAbort()` removed). The residual
`.finishReplay()` grep hits are the coordinator's own public phase method
(`processContinuation.finishReplay()` at worker-main:4192/6903, which routes to the
coarse `parentFinish`) and the unrelated reconstruction floor
(`fork-table-snapshot.ts` `this.floor.finishReplay()`), neither of which is the
module backend.

Whole-picture TS-production module-backend fine-grained call sites this increment
touched: the finish phase went N=2 → M=0. The remaining fine-grained production
call sites (beginUnwind/addActivationUnwind, beginChildReplay/addActivationChildReplay,
beginBorrowedChildReplay/addActivationBorrowedChildReplay, sealForAbort) are
classified below — they are seed/arena ops, not host-driven guest sequences.

## Ops that legitimately stay host-called (per-op reason)

The coarse entries fold host-driven GUEST DRIVE loops (the "host binds the guest
export into `__wpk_fork_drive_table`, module `call_indirect`s it" pattern). The
following are NOT that pattern and are classified, not force-folded:

- **`fm_finish_unwind` (`sealForAbort`, `beginModuleCaptureAbort`)** — single
  atomic partial-capture seal (seal writers + journal, NO host-driven guest drive,
  NO serialize; the guest is mid-unwind and MUST NOT be driven to unwind-end). There
  is no host-driven guest sequence to fold; wrapping it in a coarse entry would be a
  1:1 rename that ADDS a module export without reducing host-called sequencing —
  contrary to the campaign's minimize-host-surface goal. Kept as one honest call.

- **Capture-begin: `fm_begin_unwind` / `fm_add_activation_unwind` (`beginModuleCapture`)**
  — NEEDS-DEFER-DECISION. This is NOT a pure "drive the guest" phase: the seed calls
  ALLOCATE and RETURN each activation's continuation root (`module_buffer`) that the
  HOST needs for its own KFMS bookkeeping (`activation.root`/`replayRoot` →
  `publishProcessLaunchRoot(getActivation(0).root)` at seal, and the
  `appendActivationContinuations` manifest for a dlopen fork), AND the host writes
  the KFMS arena root INTO each guest module-buffer prefix
  (`writeForkModuleStateRoot(memory, root, ptrWidth, arena.rootAddress())`,
  fork-process-continuation.ts:628-633). This is bidirectional host↔module
  arena-metadata exchange. Folding it fully requires the module to own the KFMS
  arena-root linkage AND expose each activation's root back to the host (new
  accessors = MORE host surface, net-negative). A partial fold (only the guest
  `wpk_fork_unwind_begin` `(ptr) -> ()` drive) would NOT remove
  `fm_begin_unwind`/`fm_add_activation_unwind` from TS, so it adds machinery for no
  target progress. DEFER as its own increment that moves KFMS arena root ownership
  into the module.

- **Child-seed: `fm_begin_child_replay` / `fm_add_activation_child_replay` (+ borrowed
  variants) (`attachModuleChild`/`attachBorrowedModuleChild`)** —
  NEEDS-DEFER-DECISION. The child rewind DRIVE is ALREADY folded
  (`fm_child_reconstruct`). What remains is SEEDING from host-decoded KFMS arena
  data: activation 0's root from the launch anchor (`readProcessLaunchRoot`), the
  journal image (ptr/len) from the inherited `JournalImage` KFMS record
  (`journalImageForChild`, fork-process-continuation.ts:917-920), and side-activation
  roots from the `ActivationContinuations` manifest (`activationRootsFromChildArena`).
  Folding it needs the module to DECODE the journal-image + manifest KFMS records
  from the arena itself (feasible — `fm_attach_child` already decodes the reference
  graph from `moduleStateRoot` — but a distinct, larger increment touching KFMS
  journal/manifest decode in Rust). It is also on the explicitly browser-gated
  reentrant child-drive path (Node != browser per the validation contract; the prior
  child-reconstruct increment deferred child work for browser confirmation), so
  landing new child-seed logic under Node-only evidence is exactly what that gate
  forbids. DEFER.

## fm_* surface + ABI

`fm_*` exports 78 → 79 (ADDITIVE: `fm_parent_finish`). The HOST-CALLED sequencing
surface dropped: a per-activation guest `wpk_fork_rewind_end`/`wpk_fork_abort_end`
loop + `fm_finish_replay`/`fm_finish_abort` collapse to one coarse call. The
fine-grained `fm_finish_replay`/`fm_finish_abort` stay exported (module unit tests +
host-native, both follow-on migrations).

ABI-NEUTRAL, NO `ABI_VERSION` bump. `fm_parent_finish` + `DRIVE_SLOT_{REWIND,ABORT}_END`
+ the stride bump are the host<->module runtime contract, not the ABI snapshot; the
drive table binds guest exports BY NAME (`wpk_fork_rewind_end`/`wpk_fork_abort_end`
already exist on every fork-instrumented guest), so there is NO fork-instrument
change and NO guest re-instrument. No guest artifact changed. `check-abi-version.sh
check`: snapshot in sync, ABI_VERSION consistent, no bump. `git diff` shows abi/ +
crates/shared untouched.

## Validation (Node; aarch64-apple-darwin; browser owed to the coordinator)

- `cargo test -p fork-codec --target aarch64-apple-darwin`: 441/0 (+1 for the new
  `append_replay_end_steps` test; updated 2 stride-hardcoded tests to 10).
- `cargo test -p fork-module-inject --target aarch64-apple-darwin`: 2/0.
- `cargo test -p host-native --lib --target aarch64-apple-darwin`: 45/0/4
  (unchanged — native stays on the fine-grained `fm_finish_replay`/`fm_finish_abort`).
- `scripts/check-abi-version.sh check`: in sync, consistent, NO bump.
- Host `npm run build` (tsup + dts): clean.
- Vitest (real forks through the coarse finish; `--test-timeout=90000`):
  - `fork-module-backend-abort` + `fork-module-backend-multi-activation` +
    `fork-module-drive-shim`: 6/6 (retained fine-grained wrappers + shim guard).
  - `fork-continuation` + `vfork-production-mechanism` + `malloc-deep-fork`: 8/8.
  - `fork-from-dlopen-side-module-e2e` + `fork-module-gc-replay` +
    `fork-module-exnref-replay` + `fork-capture-session-host-exception`: 20/20
    (multi-activation dlopen exercises the new stride; borrowed/vfork finish; the
    exception-catch floor).
  - `fork-from-thread`: 3/3 (the thread coordinator finish path).
  - `fork-instrument-coverage` P-*/C-*/S-*/K-*: 31/31 (20 D-* skipped for the
    PRE-EXISTING D-01 harness hang, documented at the base). P-10 = deep multi-chunk
    continuation finish; P-11 = allocation-failure ABORT-replay finish (drives the
    new abort-end path); K-* = signal-handler fork finish; C-* = exception-catch.
- fork-module wasm rebuilt + re-injected both widths (build-key `d84437270…`),
  restaged into `local-binaries`, `host/wasm`, `source-only-v1`;
  `build-wasm.sh --verify-fresh` both widths match current source.
- `./run.sh local-build`: 98/98 (95 cache hits, 3 built), reprojected SourceOnly.
- `xtask verify-fresh`: exit 0 (CLEAN).

Browser leg (Chromium + WebKit fork finish) owed to the coordinator.
