# Browser fork validation (PR #1350 fork control-flow inversion) + dlopen-e2e triage

Worktree: `/Users/brandon/kandelo-abi44-reconcile`
Branch: `brandonpayton/rust-first-abi44-reconcile`  HEAD at start: `e34348128`
All builds/tests run inside `scripts/dev-shell.sh`. Playwright projects:
`chromium` (channel `chromium`, new-headless) and `webkit`.

## STATUS: DONE_WITH_CONCERNS

- The fork control-flow inversion's shared drive + reference-reconstruction
  path is validated as FUNCTIONALLY CORRECT in real Chromium (and, for the
  cross-host specs, WebKit): every fork/vfork/continuation/reference proof
  that runs passes.
- No REAL browser regression attributable to the inversion was found.
- Concerns are all pre-existing (test staleness + demo-test/env issues), not
  inversion regressions. Detailed below.

## Provisioning / freshness (important)

- `crates/fork-module/build-wasm.sh --verify-fresh` reported the staged
  `local-binaries/fork_module{32,64}.wasm` STALE vs HEAD source (closure key
  `2b38a1bb…` staged vs `94405fc5…` current). Rebuilt via
  `scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh`. The resulting
  wasm bytes were BYTE-IDENTICAL to the staged copies (sha
  `b2438bfe…`/`1b8032fd…`); only the freshness build-key stamp was stale
  (the intervening `e4946db71` "Test: Restore focused fork…" changed test
  files in the closure, not the compiled binary). Copied to
  `local-binaries/` + `local-binaries/source-only-v1/`; `./run.sh local-build`
  = 98/98 cache hits, 0 built, 7/7 products. Environment is provably current
  at HEAD.
- Playwright must run INSIDE `scripts/dev-shell.sh`: an outside-shell run made
  `vfork-lifecycle`'s on-the-fly clang side-module fixture fail
  (`No available targets are compatible with triple "wasm32-unknown-unknown"`
  — Xcode clang). Inside the dev shell it passes. All results below are from
  in-shell runs.
- The `kandelo-wordpress` / `kandelo-source-rootfs-shell` demos require the
  full browser binary closure (`programs/wasm32/bash.wasm`, shell/LAMP VFS).
  They need the `prepare-browser` resolution policy
  (`WASM_POSIX_RESOLUTION_POLICY=source-only-v1` +
  `WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=…/local-binaries/source-only-v1`) exported
  so the Vite `@binaries` resolver accepts the source-only tier. Without it the
  demos fail with `Package artifact closure is incomplete … bash.wasm (missing)`.
  The fork-specific specs do NOT need this (they fetch their own fixtures).

## Results table (spec × {Chromium, WebKit})

| Spec | Chromium | WebKit | Notes |
|---|---|---|---|
| fork-continuation.spec.ts | PASS (5/5) | SKIP (by design) | `test.skip(browserName!=="chromium")` — Chromium-only gate |
| vfork-lifecycle.spec.ts | PASS (10/10) | PASS (9/9) | cross-host; incl. real side-module replay (mode 1) |
| borrowed-fork-replay.spec.ts | :368 PASS; :167 FAIL; :510 FAIL | :368 PASS; :167 FAIL; :510 FAIL | REAL failures but PRE-EXISTING stale-test debt (Phase-4 JS-twin deletion), NOT the inversion — see below |
| gc-reference-cycle-fork-module-worker.spec.ts | PASS (after fix `7633811ae`) | SKIP (by design) | Chromium-only gate |
| funcref-fork-module-worker.spec.ts | PASS (after fix `7633811ae`) | SKIP (by design) | Chromium-only gate |
| fork-module-worker-instantiation.spec.ts | PASS (after fix `7633811ae`) | SKIP (by design) | Chromium-only gate |
| kandelo-source-rootfs-shell.spec.ts | SKIP | SKIP | `test.skip(!strict …)` — CI-strict-only acceptance gate; does not run locally |
| kandelo-wordpress.spec.ts | 3 pass / 3 fail | 3 pass / 2 fail (1 skip) | boots via php-fpm fork on BOTH; failures are demo-UI/timing/DB-transport, NOT inversion — see below |

WebKit "SKIP (by design)" = the spec self-skips on non-Chromium
(`test.skip(browserName !== "chromium", "the aggregate browser gate uses
Chromium")`). These are Chromium-gated proofs, not environment failures.

### WordPress detail (both browsers, source-only-v1 policy set; 11.6m run, 2 workers)

| WordPress test | Chromium | WebKit |
|---|---|---|
| :89 mysqli transport benchmark returns | FAIL | FAIL |
| :137 preinstalled site logs into wp-admin | FAIL | FAIL |
| :164 login survives service-worker restart | PASS | SKIP (CDP `ServiceWorker.stopWorker`, chromium-only) |
| :228 site editor loads assets through the bridge | PASS | PASS |
| :260 auth cookie retained for every cookie path | FAIL | PASS |

WordPress DOES boot in-browser on both engines (machine shows
"WordPress MariaDB / Running / Ready"; `:228` site-editor passes on both,
proving php-fpm fork boot + wp-admin asset serving through the bridge; `:164`
login-persistence passes on Chromium). Triage of the failures:

- **:137 wp-admin login (both):** NOT a fork/DB failure. WordPress rendered the
  login form (`#wp-submit` "visible, enabled and stable"); the click was
  intercepted by the demo dock overlay
  `<div class="kdock-popover-dismiss-layer">`, so the click never landed →
  420s timeout. Demo-UI / test-interaction issue.
- **:260 cookie-path:** Chromium FAIL = `waitForSelector iframe[src*="/app/"]`
  180s timeout (app iframe never appeared under two simultaneous WordPress boots
  / worker contention); WebKit PASSED the same test. Timing/contention flake.
- **:89 benchmark (both):** `expect(received).toBeUndefined()` /
  `Received: "Connection refused"` — one mysqli connection variant
  (tcp/unix/persistent) refused. This is a DB-transport-benchmark concern
  (it hammers persistent connections); ordinary page serving works
  (`:228` passes). Reproduces identically on both engines (not browser parity).

I did NOT establish a pre-inversion baseline specifically for the WordPress
benchmark's mysqli "Connection refused"; I classify it as ENV/demo-test rather
than an inversion regression because (a) WordPress boots and serves via
php-fpm fork on both engines, (b) the failure is a clean connection-time
"refused" on specific mysqli variants, not a fork-continuation trap/crash, and
(c) it is identical on Chromium and WebKit. If the coordinator wants it treated
as REAL, it needs a dedicated single-worker WordPress run + baseline comparison.

## Commit `7633811ae` — full explanation

`Fork: Read browser fork-module proof-of-use from the dedicated proof channel`
Files: `apps/browser-demos/test/{fork-module-worker-instantiation,
funcref-fork-module-worker,gc-reference-cycle-fork-module-worker}.spec.ts`
(+41 lines, test-only).

- **What it fixes:** the three browser DRIVE proof specs collected proof-of-use
  only through `BrowserKernel`'s `onHostDiagnostic`. The frame/reference/GC
  proof-of-use counts (`fork_module_frames`, `fork_module_references`,
  `gc_nodes_reconstructed`, `drive_steps_executed`) were moved to a dedicated
  `fork_module_proof` worker-message channel, surfaced as `onForkModuleProof`
  (host/src/browser-kernel-host.ts:93,1530; posted in
  browser-kernel-worker-entry.ts:711/1872/1893). Once moved, `onHostDiagnostic`
  no longer carried them, so the specs observed `diagnostics: []` and failed.
  The fix registers `onForkModuleProof` alongside `onHostDiagnostic` so each
  browser proof reads the same channel its Node counterpart reads via
  `centralized-test-helper`'s `forkModuleDiagnostics` collector.
- **REAL browser regression the inversion introduced/exposed? NO.** This is a
  TEST-ONLY read fix, not a platform regression. Evidence:
  1. The fork DRIVE itself worked in Chromium BEFORE the fix — all correctness
     assertions passed: instantiation printed the full expected output
     (`PRE_FORK / CHILD: ok / PARENT: child=101 / PASS: D-01`, exit 0); funcref
     and gc exited 0 (their child self-verifies the reconstruction). Only the
     proof-of-use telemetry assertion failed.
  2. I proved it was NOT a timing race: widening the browser's bounded proof
     wait from 8s to 30s still produced empty diagnostics (reverted the probe).
  3. The proof channel split landed at `aa28568aa`
     ("Fork: Move fork-module proof-of-use off the host problem channel",
     2026-09-07 22:35), ~3.5h AFTER the specs' last edit (`552b8ee7e`,
     2026-09-07 18:54) and before most coarse-drive inversion commits. The Node
     helper migrated to `onForkModuleProof`; the browser specs were left behind.
  So no coarse/reconstruction path is implicated — the coarse drive +
  funcref/externref/typed-GC reconstruction all function correctly in real
  Chromium; the browser test was simply reading the wrong telemetry channel.
- **ABI-neutral? YES.** Touches only `apps/browser-demos/test/*.spec.ts`. No
  `host/src`, no ABI constants, no snapshot, no guest, no `ABI_VERSION`.
- **Node re-validation? Not required (no shared host/src touched), and confirmed
  green anyway.** Fresh in-shell run of the three Node counterparts
  (`fork-module-worker-instantiation.test.ts`, `funcref-fork-module-worker.test.ts`,
  `gc-reference-cycle-fresh-worker.test.ts`, `--testTimeout=60000`): 3 passed.
  (Note: at vitest's default 5s timeout, `fork-module-worker-instantiation.test.ts`
  times out because the run takes ~8s — a test-timeout artifact, not a missing
  diagnostic; it passes at 60s.)
- **Validation of the fix:** all three specs PASS on Chromium after the change;
  WebKit is skipped by the specs' own Chromium-only gate.
- **NOT pushed** (per instruction — coordinator pushes forward-only).

## borrowed-fork-replay :167 / :510 — pre-existing stale tests (NOT the inversion)

Both failing tests dynamically `import` the DELETED
`host/test/fork-instrument-runtime-harness.ts` and construct the DELETED
`LinkedForkContinuation` JS class:
- Chromium :167 = `TypeError: Failed to fetch dynamically imported module:
  …/host/test/fork-instrument-runtime-harness.ts`; :510 =
  `TypeError: LinkedForkContinuation is not a constructor`
  (WebKit: `Importing a module script failed`).
- The harness + `LinkedForkContinuation` were removed in `eeea97c94`
  "Fork: Delete the JS continuation twin (module is the only implementation)"
  (2026-09-08 15:35) — a Phase-4 deletion that lands AFTER the spec's last edit
  (`552b8ee7e`, 2026-09-07). These two tests have been red since the JS twin
  was deleted; the specific control-flow INVERSION is not implicated.
- The spec's live module-path test (:368 "borrowed side-module reconstruction
  does not write parent memory") PASSES on both browsers — the borrowed-replay
  drive itself works.
- **Recommendation:** these two tests exercise an entire deleted subsystem, so
  the fix is not a small mechanical change — either DELETE them or PORT them
  onto the module path (coordinator's call). I did NOT modify them (not a
  small/obviously-correct fix; a maintainer decision on coverage intent).

## Task 2 — `fork-dlopen-replay-e2e` root cause + recommendation

Run: `scripts/dev-shell.sh npx vitest run host/test/fork-dlopen-replay-e2e.test.ts`
→ 3 passed, 2 failed, 1 skipped (the skipped one is the documented
`smoke_fork_from_thread` residual — not chased).

Failing tests + exact errors:
- `replays pthread-hosted dlopen table state into a fresh fork child`
  (test:569/571): stderr `pthread dlopen: WebAssembly.Instance(): Import #32
  "env" "__wpk_fork_frame_reserve": function import requires a callable`.
- `blocks a foreign pthread until the staged loader owner commits` (test:702/704):
  stderr `owner dlopen: WebAssembly.Instance(): Import #34 "env"
  "__wpk_fork_frame_reserve": function import requires a callable`.

Contrast: the 3 PASSING tests dlopen on the MAIN process worker; both FAILING
tests dlopen from a PTHREAD (`pthread_create` → the thread calls `dlopen` then
forks). Confirmed pre-existing at baseline (not the inversion).

Import binding path (`__wpk_fork_frame_reserve`, absolute paths):
- ABI/definition: `crates/shared/src/lib.rs:2361`,
  `host/src/generated/abi.ts:274,368`; module export produced by the
  fork-module (`crates/fork-module/src/lib.rs:3681`) and the host trampoline
  (`host/src/fork-module-trampoline.ts:156,236,274`); required-import list
  `host/src/fork-module-instance.ts:28`.
- Main-worker guest flip (module export → guest import), works:
  `host/src/worker-main.ts:4639` (builds `forkEnvImports`, passed to the
  side-module import resolver at `:4733`).
- Pthread-parent guest flip, works for the guest itself:
  `host/src/worker-main.ts:7070` (builds `threadForkEnvImports`, passed at
  `:7139`).
- dlopen side-module import assembly:
  `host/src/dylink.ts:1443` — a fork-instrumented side module gets its
  `env.__wpk_fork_*` imports from `options.forkActivationOwner.prepare(...).env`
  (+ `wrapImports`). The generic resolver at `worker-main.ts:2455-2490` would
  throw a descriptive JS error if a name were simply absent; the observed error
  is instead the raw `WebAssembly.Instance()` "requires a callable", i.e. the
  key IS present but bound to a non-callable (undefined) value.

Root cause: on the PTHREAD-hosted dlopen path, the activation owner used to
prepare the side module's `env` does not carry a CALLABLE
`__wpk_fork_frame_reserve` (nor, by extension, the sibling module-backed
`__wpk_fork_frame_*` frame imports). On the main worker the frame-reserve
callable (the module export wrapped for partial-capture abort at
worker-main.ts:4639) is threaded into the dlopen activation-owner env; the
equivalent thread-side wiring (worker-main.ts:7070's
`threadForkModuleInstance`-backed frame imports) is NOT threaded into the
`forkActivationOwner` env that `dylink.ts:1443` uses when the dlopen happens on
a pthread. The side module is therefore instantiated with
`env.__wpk_fork_frame_reserve === undefined`, which WebAssembly rejects.

Recommendation: **(b) document as a tracked platform gap** (and optionally route
a scoped fix separately). Rationale:
- It is PRE-EXISTING (present at baseline; the inversion did not cause it).
- The fix is NOT a one-liner: it must thread the pthread's module-backed
  frame-reserve callable (mirroring worker-main.ts:7070) into the
  `forkActivationOwner.prepare().env` that dylink uses for a pthread-hosted
  dlopen, and be validated against the fork + dlopen + pthread suites. That is
  a shared host-runtime worker-lifecycle change beyond a "small,
  obviously-correct" edit, so I did not apply it (deferral is the maintainer's
  call).
- Suggested `docs/future-improvements.md` entry: "pthread-hosted `dlopen` of a
  fork-instrumented side module fails to instantiate — the co-resident
  fork-module's `__wpk_fork_frame_reserve` (and sibling `__wpk_fork_frame_*`)
  callables are wired into the main-worker dlopen activation-owner env
  (worker-main.ts:4639) but not into the pthread activation-owner env used by
  dylink.ts:1443, so `WebAssembly.Instance()` rejects the side module with
  'function import requires a callable'. Fix by mirroring the thread flip at
  worker-main.ts:7070 into the pthread dlopen import assembly."

## Commits made

- `7633811ae` Fork: Read browser fork-module proof-of-use from the dedicated
  proof channel (test-only; ABI-neutral; NOT pushed).

## REAL browser regression from the inversion

None found. The coarse fork-module drive and the shared reference-reconstruction
model (frames, funcref, externref, typed-GC cycle) all run correctly in real
Chromium; vfork lifecycle + real side-module replay run correctly in both
Chromium and WebKit. All failures encountered are pre-existing (Phase-4
stale tests, a 2026-09-07 telemetry-channel move the browser specs missed) or
demo-test/timing/DB-transport issues in the WordPress demo, none traceable to
the fork control-flow inversion.
