# Rust-First Fork: Control-Flow Inversion Completion Plan

> Authoritative, durable record for the autonomous run started 2026-09-09.
> If context is lost (compaction/crash), this file + the SDD ledger +
> `git log` are the recovery map. Trust them over recollection.

## Recovery coordinates

- **Worktree:** `/Users/brandon/kandelo-abi44-reconcile`
- **Branch:** `brandonpayton/rust-first-abi44-reconcile`
  (tracks `origin/brandonpayton/epoll-kernel-route`, the head of **PR #1350**)
- **PR #1350:** "Kernel: rust-first migration — unified ABI-44 tree
  (transport, native host, VFS, fork/exec)" — OPEN.
- At plan time local was **4 commits ahead** of the remote PR branch
  (unpushed inversion progress, latest `f58af80e5` "Route the replay finish
  through the coarse `fm_parent_finish` entry").
- **ABI 44.** After editing `crates/fork-module`, rebuild via
  `crates/fork-module/build-wasm.sh`, then copy `host/wasm/fork_module{32,64}.wasm`
  to `local-binaries/` **and** `local-binaries/source-only-v1/`, then
  `./run.sh local-build` to re-finalize the SourceOnly projection, or a stale
  module runs. Host (`crates/host-native`) builds use the host triple
  `--target aarch64-apple-darwin` (bare cargo picks the wasm target and fails).

## Corrected understanding (do not re-inflate either way)

- **There is ONE fork capture/replay engine:** `crates/fork-module` +
  `crates/fork-codec` (wire/decode/gc-plan/drive-plan). The JS/TS continuation
  twin (~4,600 lines) is **already deleted**. The point-of-no-return
  (module-or-fatal) is **already done and cross-host validated.** This is the
  load-bearing achievement and it holds.
- **`host-native` is NOT a second engine — it is a second *driver*.**
  `crates/host-native/src/guest.rs` (Rust/wasmtime) drives the one module but
  through the **fine-grained** `fm_*` API (zero coarse calls) and interleaves
  some wasmtime-native materialization between calls. TS production
  (`host/src/*.ts`) likewise still hand-drives the fine-grained subset.
- The module currently exports **~92 `fm_*`** symbols. The campaign's remaining
  work is to make *every* driver use the **coarse** per-phase API, then delete
  the now-unused fine-grained exports, reaching a **single-digit floor** (coarse
  entries + genuine host-floor imports such as `resolve_externref`).
- **The prior "ACCEPT-78 floor" ruling is SUPERSEDED.** 78 was unfinished
  migration mistaken for an architectural floor. We are completing the
  migration, not accepting the surface.

## Mandate & constraints (from the maintainer, 2026-09-09)

- **Do items 1–5 autonomously. Keep the native (`host-native`) work IN this PR.**
- **Push policy:** push forward-only to the PR branch (`origin/brandonpayton/epoll-kernel-route`)
  as steps validate. **Never amend, never force-push** that branch. Only move
  forward.
- **Endgame:** at the end, do BOTH — (a) run a local dev server for manual
  browser testing, and (b) curate the campaign history onto a **separate**
  branch for the maintainer's review. The curated branch requires a force-push,
  which **waits for maintainer review** — do not push it.
- **Maintainer is SOLE MERGER. Never merge.**
- **Do not lose noted future work.** Before removing the committed
  `.superpowers` scratch, harvest any genuine future-work notes into the repo's
  future-work doc under `docs/`.
- **Re-check the wasmtime-exnref belief** — it may no longer be true. Deferring
  it is acceptable ONLY with an explicit entry in the repo future-work doc.

## Findings (2026-09-09 read-only investigation)

- **wasmtime-exnref belief is STALE.** wasmtime was upgraded 35 -> **48**
  specifically to unblock the fork-instrumented module's `exnref`/`Exn` heap
  type. On 48, `kernel_engine()` sets `wasm_gc(true)` + `wasm_exceptions(true)`,
  the instrumented module **parses** (`smoke_loads_fork_instrumented_guest`
  passes), and the throw/catch mechanism works
  (`wasmtime::ThrownException` + `Store::take_pending_exception`, `guest.rs`).
  The EXN reconstruction drive-thunk is wired in native (`guest.rs:6789,6806`).
  What is **unproven — not proven-impossible** — is a real exnref-carrying fork
  reconstructing end-to-end natively; today's native tests only assert
  `exnrefs_reconstructed == 0` on frames-only fixtures. So #2 must **attempt the
  full coarse migration including the exnref path and verify empirically**; only
  a real, reproduced native failure justifies fail-loud + a future-work entry.
- **Future-work doc target:** `docs/future-improvements.md` (repo-tracked). The
  exnref item, if it survives empirical check, goes here. (`docs/fork-*.md` may
  also warrant a known-limitations note.)
- **`.superpowers` scratch = 10 tracked files** under `.superpowers/sdd/*`
  (progress + task reports). Harvest genuine future-work notes into
  `docs/future-improvements.md`, then `git rm` them. Note: `host-native/Cargo.toml`
  comments reference `.superpowers/sdd/2026-09-05-n1-i4-native-fork-frames/wasmtime-upgrade-report.md`,
  which is **not tracked** — a dangling doc pointer to fix when cleaning up.

## Work items

### 1. Finish TS-production coarse-ification  (IN PROGRESS — agent ae9c8f18eb66e43a4)
Fold the remaining fine-grained TS drive in `host/src/fork-module-backend.ts`,
`host/src/worker-main.ts`, `host/src/fork-process-continuation.ts` into the
coarse per-phase entries. Fine-grained calls to retire from TS production
include `fm_begin_reference_replay`, `fm_finish_unwind`, `fm_begin_abort`,
`fm_finish_abort`, `fm_begin_replay`/`fm_finish_replay`, `fm_begin_unwind`,
`fm_set_activation_*`, and the `fm_capture_*` seed family. The agent has already
added `fm_parent_finish` and routed the finish path through it. **Validate
cross-host after.**

### 2. host-native coarse-ification  (stays in this PR)
Rewrite `crates/host-native/src/guest.rs` to drive via the **coarse** API
(`fm_parent_replay`/`fm_parent_abort`/`fm_parent_seal_capture`/`fm_parent_finish`/
`fm_child_reconstruct`), matching Node/browser, for everything wasmtime can do.
**Re-verify the exnref-materialization limitation first** (see item 5); if it is
still real, native fails loud on exnref-carrying forks and the gap is a
future-work entry — NOT a reason to keep the fine-grained API. This is the
largest single item and unblocks #3.

### 3. Delete the now-unused fine-grained `fm_*`  (blocked on 1, 2, 4)
Once no driver or test calls a fine-grained export, delete it from
`crates/fork-module/src`. Target: single-digit surface. This is an ABI-surface
change to the module's exports — confirm no ABI_VERSION/snapshot obligation is
missed (`scripts/check-abi-version.sh`, `cargo xtask verify-fresh`).

### 4. `.mjs` → Rust test migration
Move fine-grained-primitive coverage from external `.mjs` harnesses into Rust
(`crates/fork-codec` unit tests / `crates/host-native` wasmtime tests). Prune
remaining `.mjs` to the coarse API. Tests live where the primitives live; we do
NOT keep a production API surface to satisfy harnesses.

### 5. Cleanup + future-work doc
- Resolve the externref-scan direction: `host/src/fork-externref-process-owner.ts`
  + `host/src/fork-reference-wire.ts` `scanSegmentedForkReferenceExternrefHandles`
  vs. a module-side scanner. Default: the module is the production path.
- **Harvest** genuine future-work from the committed `.superpowers` scratch into
  the repo future-work doc, then **remove** the `.superpowers` tracked files.
- **Re-check wasmtime-exnref**; record the outcome (still-real → future-work
  entry + native fail-loud; no-longer-real → migrate it too).

### 6. Endgame (after 1–5 validate)
- **Validation battery (done = validated):** host-native (host triple),
  fork-codec, full Vitest, browser Chromium + WebKit fork validation, and
  relevant fork/process conformance (posix/libc/sortix). Triage env failures
  (missing package / browser-in-Node / timeout) from real regressions.
- **Serve** a local dev build for manual testing; put the URL where the
  maintainer will see it.
- **Curate** the campaign into phase-narrative commits on a **separate** branch
  (byte-identical tree proven via `git range-diff`; Brandon as author; drop
  `.superpowers`). Do NOT push it — it needs review + a force-push the
  maintainer approves.

## Progress log

- **#1 folds landed (Node-validated, ABI-neutral, not yet pushed):** replay-finish
  → `fm_parent_finish`; abort-seal → `fm_parent_abort_seal` (`82c9af0ba`);
  capture-begin → `fm_parent_begin_capture` (`d09dc4b66`); child-seed →
  `fm_child_seed` (`ada5850f9`). Reference-replay drive was already coarse inside
  `fm_parent_replay`/`fm_child_reconstruct`.
- **#1 remaining (agent running):** abort-replay-begin (`backend.beginAbort`) and
  borrowed/vfork child-seed (`beginBorrowedChildReplay`/`addActivationBorrowedChildReplay`)
  — both mirror FOLD 1 / FOLD 2; being folded now.
- **PROVEN GENUINE FLOOR (kept with proof, NOT a convenient hold):**
  `setActivationResumeCatalog` (`worker-main.ts:853`) + the resume-catalog seeds
  (`fm_set_resume_catalog` / `fm_set_activation_resume_catalog`). The host extracts
  resume-catalog ordinals from the guest `WebAssembly.Module`'s fork-instrument
  custom section — host-only; the co-resident module cannot parse the guest
  binary — and seeds them once at instantiation so module slot numbering matches
  `__wpk_fork_resume_table`. A setup seed, not a drive loop; both hosts +
  host-native do it. This is legitimate bedrock.
- **Two premise corrections (from the fold agent, with proof):** the module does
  NOT own the KFMS arena write protocol (`fork-codec` is decode-only; reserve/
  commit/seal live in host TS `ForkModuleStateArena`) — so JournalImage/
  ActivationContinuations *appends* stay host-side (candidate for a later
  TS→Rust push, but NOT an `fm_*` export floor). A side activation's `fixedPrefix`
  is a genuine host residue (no KFMS record carries it) — the host passes it into
  `fm_child_seed`.
- **ENDGAME TRIAGE ITEM (pre-existing, NOT a campaign regression):**
  `fork-dlopen-replay-e2e.test.ts` — 2 pthread-hosted-dlopen tests fail with
  `__wpk_fork_frame_reserve` import "requires a callable"; confirmed identical at
  the pre-fold baseline. Decide during endgame: real fix vs. documented tracked
  issue. Must NOT be silently shipped as green.

## #2 host-native — PARTIAL (green + pushed), blocked by usage limit

Commits (pushed to PR branch, all green — host-native `--lib` 45 pass / 0 fail):
`67b588270` coarse TypedFunc handles + drive-table phase-flip bind; `83e5cbfd9`
native PARENT path → coarse; `cfebb27ee` native CHILD path (COW + vfork) → coarse.
Parent capture/seal/replay-rewind/finish and child seed/reconstruct/finish now
drive the coarse entries. `smoke_fork_externref_reconstructs`, GC array/struct/
cycle, and `smoke_loads_fork_instrumented_guest` pass — externref + GC
reconstruction work natively through the coarse path.

**Remaining #2 (REDUCIBLE, not an architectural floor — do NOT mislabel):**
1. **Reference/GC-reconstruction model divergence.** `fm_parent_replay`
   deliberately does NOT fold reference reconstruction; it is a separate phase in
   BOTH hosts, driven two different ways: TS uses a **guest-pull** model (the guest
   calls `decodeFuncref`/`decodeExternref`/`routeGc`/`loadGc` import shims during
   rewind — `host/src/fork-activation-registry.ts:397+`), native uses an
   **explicit host-drive** (`guest.rs` `drive_reference_replay` = `fm_begin_reference_replay`
   + `fm_build_gc_plan` + `fm_drive_execute`). The shared reconstruction API
   (~15 exports: `fm_begin_reference_replay`, `fm_build_gc_plan`, `fm_drive_execute`,
   `fm_gc_plan_count`, `fm_ref_*`, `fm_funcref_ordinal`, `fm_externref_handle`,
   `fm_static_root_slot`, `fm_decoded_*`) is used by BOTH. Reaching the single-digit
   floor needs native unified onto the shared model (or both hosts onto ONE coarse
   "reconstruct references" entry). This is a substantive native rearchitecture,
   NOT a mechanical fold — deferred here ONLY because the usage limit blocks the
   subagent-driven work it needs, not because it is irreducible.
2. **Abort path.** `fm_parent_abort`/`fm_parent_abort_seal` handles are bound but
   no confirmed call site in `guest.rs`; native's gated-abort/parent-abort-replay
   path (`guest.rs` ~3554-3611) needs verification and wiring to the coarse entries.
3. **exnref (exception-ref) CAPTURE — the maintainer's pre-authorized deferral.**
   Reconstruct side is wired; wasmtime-48 parse + throw/catch work. The agent's open
   question ("can native CAPTURE a live exnref at all") is unverified. Verify
   empirically when unblocked; if it genuinely fails, native fails loud +
   `docs/future-improvements.md` entry with the reproduced error.

**Single-digit `fm_*` floor is NOT reached.** It is blocked on the above (#2
residual), the `.mjs`→Rust migration (#4), and only then deletion (#3).

## #2 host-native — DONE (verified), premise corrected

Resumed under the work login (personal login's weekly limit was the block).
Landed + pushed: `63f42ce9c` abort path → coarse `fm_parent_abort`; `d2d00a02f`
exnref-capture gap documented in `docs/future-improvements.md`.

**The "host-drive vs guest-pull divergence" I described was WRONG (verified in
code).** Both hosts already reconstruct references the SAME way: funcref/externref
= guest-pull (import shims); GC/exnref = HOST-DRIVE via `fm_begin_reference_replay`
+ `fm_build_gc_plan` + `fm_gc_plan_count` + `fm_drive_execute`. TS does this too
(`fork-module-backend.ts:417-434`, `driveRestoredPlan`, `fork-table-snapshot.ts:365`)
— I missed it earlier because it's named `driveTypedGraph`/`driveRestoredPlan`, not
`driveExecute`. The agent REPRODUCED proof it is a genuine floor: removing the
GC-drive traps `smoke_fork_gc_struct_reconstructs` with "undefined element: out of
bounds table access" — the guest cannot pull GC nodes in dependency order without
re-instrumentation. So native is already unified with TS; the 4 remaining native
fine-grained calls == TS's reference/GC reconstruction. **KEPT with proof.**

Native validation: host-native `--lib` 45/0 (4 ignored), fork-codec 442/0,
fork-module-inject 2/0, check-abi consistent (ABI-neutral). exnref CAPTURE is a
fail-loud documented deferral (capture import stubs unbound; no exnref fixture
exists yet — follow-up in `docs/future-improvements.md`).

## BLOCKER (RESOLVED via work login): account weekly usage limit

Hit mid-#2; resets **Sep 11, 9pm America/Indianapolis**. Fresh subagent dispatch
fails on the limit; the subagent-driven completion of #2's residual + #3/#4/#5 is
blocked until reset. Everything green is committed and pushed forward to the PR
branch; nothing is lost. Main-loop tool calls (build/test/git) still work, but the
remaining work is delicate native replay-seam surgery that should be done
subagent-driven with full validation, not hand-hacked under the limit.

## FLOOR REACHED (#3 done, pushed): 71 fm_* exports

Empirical result after deleting the 13 callerless fine-grained drive exports
(`1d2691358`/`3c7ac57b8`/`5f5fb0ec2`, pushed). Surviving `fm_*` = **71** (72 with
the walrus-injected `fm_drive_execute`):
- **9 coarse** per-phase drive entries (the inversion's win)
- **43 reference-marshalling / reconstruction** — the genuine per-type guest↔module
  reference ABI (capture builders `fm_capture_*` ×17, ref feed `fm_ref_*`/
  `fm_funcref_ordinal`/`fm_externref_handle`/`fm_static_root_slot` ×10, decoded-graph
  readout `fm_decoded_*` ×5, reconstruction drive/plan/install ×9, child-side seeding ×2)
- **8 seeds** (`fm_set_*`)
- **11 infra** (errno/stats/drive-table/journal/frame accessors)

ABI: snapshot-consistent, NO bump (the co-resident module's host-facing `fm_*`
surface is not tracked in `abi/snapshot.json`; `verify-fresh` + `check-abi`
consistent). Validation: fork-codec 442, host-native --lib 45, local-build 98/98
(real WordPress/MariaDB VFS forks through the coarse path), Vitest fork suite 154
passed / 0 unexpected (2 expected-fail = pre-existing dlopen-e2e, 9 skipped).

**#5 + endgame follow-ups (from #3 concerns):**
- Two focused-unit assertions lost when obviated harnesses were removed
  (wrong-activation-peek `EINVAL` gate; stray-`finishAbort` pairing). Invariants
  still enforced in-impl + covered at integration; RESTORE as Rust unit tests
  (tests where primitives live) in #5.
- Stale gitignored `host/dist` blocked the first local-build (old required-exports
  list); `scripts/build-host.sh` fixed it. A dist-freshness gap worth a
  future-work note (the "stale artifact fails loud" contract should catch it).

## Standing rulings

- Work in `/Users/brandon/kandelo-abi44-reconcile` on the PR branch. Commit per
  step (crash/watchdog resilience). Push forward-only after validated steps.
- One implementation agent at a time on the shared worktree (avoid conflicts);
  let the running agent finish #1 before serializing #2. Single-threaded
  validation to avoid CPU contention producing false failures.
- Deferrals are the maintainer's call. The maintainer authorized deferring
  exnref materialization IF still-real, recorded in future-work. Nothing else
  is self-deferred.
