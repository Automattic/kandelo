# Endgame cleanup report (PR #1350)

Branch: `brandonpayton/rust-first-abi44-reconcile`
Build base: `7633811ae`
Not pushed, not amended, `.superpowers/` untouched.

## Status: BOTH TASKS COMPLETE

## Commits (on top of 7633811ae)
- `e4fa619d6` Test: Drop borrowed-fork-replay tests bound to the deleted JS twin
- `73fd6763f` Docs: Track the pthread-hosted dlopen fork-module import gap

## Task A — remove two dead browser tests
Deleted the two `test(...)` blocks in
`apps/browser-demos/test/borrowed-fork-replay.spec.ts` that dynamic-imported the
deleted JS continuation twin:
- "separate browser Worker borrows ABI 43 replay without consuming its parent"
- "active side activation remains owned by the browser parent"

Kept the live module-path test "borrowed side-module reconstruction does not
write parent memory" (uses `loadSharedLibrarySync`, not the twin).

Removed the now-orphaned top-level fixture-path constants used only by the
deleted tests (`continuationModulePath`, `moduleStateModulePath`,
`runtimeHarnessPath`, `childWorkerPath`, `processRuntimePath`,
`childActiveSideWorkerPath`) and the two now-unused fixture builders
(`buildBorrowedReplayFixture`, `buildBorrowedActiveSideFixture`). All remaining
top-level node imports are still used by the kept test and its
`buildBorrowedDylinkFixture` helper. File shrank by 560 lines.

### VERIFY — borrowed-fork-replay.spec.ts, Chromium + WebKit (inside dev-shell)
Command (port 5462 to avoid the 5401 cross-workspace collision):
`KANDELO_PLAYWRIGHT_PORT=5462 scripts/dev-shell.sh npx playwright test test/borrowed-fork-replay.spec.ts --project=chromium --project=webkit`

Result: **2 passed** (the single surviving test, on both browsers)
- `[chromium] borrowed side-module reconstruction does not write parent memory` PASS (383ms)
- `[webkit] borrowed side-module reconstruction does not write parent memory` PASS (589ms)

## Task B — document the pthread-dlopen gap (docs only, no code fix)
Added a bullet to the "Fork control-flow inversion and rust-first migration"
section of `docs/future-improvements.md`, matching the existing bullet style
(bold lead, root cause, fix recipe, `**Files:**` footer, prose wrapped at 72
columns). It documents:
- The two pthread-hosted dlopen tests fail with
  `WebAssembly.Instance(): Import "env" "__wpk_fork_frame_reserve": function
  import requires a callable`.
- Pre-existing / baseline red, not caused by the control-flow inversion; the 3
  main-thread dlopen siblings pass.
- Root cause: thread worker builds `threadForkModuleInstance` /
  `threadForkModuleBackend` but no thread-side `ForkModuleTrampolines`, and
  `replicaActivationOwner` lacks `forkModuleFrameFlip`.
- Host-side, no-ABI-bump fix recipe mirroring the main worker.
- Deferred as a shared pthread-worker-lifecycle change beyond this PR's scope.

No code fix was applied (documentation only, as instructed).

### Verification of the documented claims
I did not run the dlopen suite (it needs a kernel/sysroot build), but I verified
every load-bearing claim against source so the doc is accurate:
- `host/test/fork-dlopen-replay-e2e.test.ts` has exactly 5 `it()` blocks: 2
  pthread-hosted ("replays pthread-hosted dlopen table state..." line 494,
  "blocks a foreign pthread until the staged loader owner commits" line 575) and
  3 main-thread (lines 265, 340, 419) — matching the 2-fail / 3-pass split.
- `host/src/worker-main.ts` anchors exist: thread `threadForkModuleInstance` /
  `threadForkModuleBackend` declared ~6683-6684, `threadForkModuleBackend.setup()`
  + thread `enableModuleBacking` ~6792-6793, main-path `enableModuleBacking`
  ~3958, `replicaActivationOwner` ~6978, and the `forkModuleFrameFlip` option
  type (trampolines + backend) at ~722 with a main-path use at ~4310. The recipe
  is consistent with the real code. I referenced symbols/relative positions
  rather than hard line numbers in the doc so it does not rot.

## Concern (out of stated scope, flagged not actioned)
The two fixture worker files that only the deleted tests loaded at runtime are
now orphaned and one still imports the deleted twin:
- `apps/browser-demos/test/fixtures/borrowed-fork-replay-browser-worker.ts`
  (imports `SingleActivationForkRuntime` from the deleted
  `host/test/fork-instrument-runtime-harness.ts`)
- `apps/browser-demos/test/fixtures/borrowed-active-side-replay-browser-worker.ts`
- `apps/browser-demos/test/fixtures/borrowed-process-runtime.ts`

They are no longer referenced by any spec (the surviving test uses the separate
`borrowed-dylink-replay-browser-worker.ts` fixture, which is intact), so they do
not affect the passing run. The task scoped me to the test blocks and orphaned
top-level imports/constants only, so I left these fixture files in place. They
are dead and a candidate for deletion in a follow-up if you want the fixtures
cleaned up too.
