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

## Standing rulings

- Work in `/Users/brandon/kandelo-abi44-reconcile` on the PR branch. Commit per
  step (crash/watchdog resilience). Push forward-only after validated steps.
- One implementation agent at a time on the shared worktree (avoid conflicts);
  let the running agent finish #1 before serializing #2. Single-threaded
  validation to avoid CPU contention producing false failures.
- Deferrals are the maintainer's call. The maintainer authorized deferring
  exnref materialization IF still-real, recorded in future-work. Nothing else
  is self-deferred.
