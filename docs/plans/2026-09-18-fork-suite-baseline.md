# Fork suite baseline, before the build-path change

Date: 2026-09-19

## Anchor

- Commit: `c4693f274a3e2f7a34c57cf94152fdd29d7e845b`
  ("Fork: Make the identity release path observable and assert it")
- Branch: `brandonpayton/lane-f-fork-inversion`
- Fork-module build key (both arches, from Task 3's rebuild):
  `6af415472b473bd857be0dc8a8cbf92d1f5ddfa5fa09f14e6716b79bc9cfb55e`
  (`local-binaries/fork_module32.wasm.build-key` and
  `local-binaries/fork_module64.wasm.build-key`, both staged 2026-09-19
  11:24, matching). This baseline does NOT rebuild the fork module; the
  key above is read, not regenerated.
- Host bundle: `cd host && npm run build` — exit 0. This produced
  `host/dist/node-kernel-worker-entry.js` at 13:08 (2026-09-19), which
  is what the primary suite run below loaded.

## Workspace copies of the raw suite output

Full, unedited stdout+stderr for every run described below is kept in this
plan's git-ignored workspace directory (not committed, per the plan's own
`.gitignore`):

- `.superpowers/sdd/2026-09-18-fork-storage-phase0-and-build-path/fork-baseline.txt`
  — the primary run (exact brief command, see below). **This is the file
  Task 8 diffs against.**
- `.superpowers/sdd/2026-09-18-fork-storage-phase0-and-build-path/fork-baseline-corrected-invocation.txt`
  — a second run from `host/`, used only to separate genuine fork-logic
  failures from an invocation artifact (explained below). Not the
  Task 8 diff target.
- `.superpowers/sdd/2026-09-18-fork-storage-phase0-and-build-path/surface-budget-gate-run.txt`
  — the surface-budget gate run (see "Surface-budget gate" below).

A copy of the primary run was also written to `/tmp/fork-baseline.txt` per
the brief, but that path is not durable across sessions and is not the
record Task 8 should trust.

## Primary run — exact command as specified in the task brief

```
cd /Users/brandon/kandelo-lane-f && npx vitest run host/test/fork-*.test.ts > <workspace>/fork-baseline.txt 2>&1
echo "SUITE_EXIT: $?"
```

- **SUITE_EXIT: 1**
- Summary lines (verbatim):
  ```
   Test Files  6 failed | 62 passed (68)
        Tests  45 failed | 433 passed | 2 expected fail | 9 skipped (489)
     Start at  13:08:43
     Duration  403.63s (tests 89%, import 9%, transform 1%)
  ```
- How much ran: 68 test files discovered (matches `ls host/test/fork-*.test.ts
  | wc -l`), 489 tests counted by vitest (433 passed + 45 failed + 2
  expected-fail + 9 skipped). Nothing was silently excluded by the glob —
  68 matches the file count on disk.
- **Two files failed to produce any test at all** (0 tests collected, not a
  `FAIL <file> > <test>` line, so `grep FAIL` alone would under-report this):
  - `host/test/fork-from-thread.test.ts` — `(0 test)`, whole-file setup threw
    before any `describe`/`it` could register.
  - `host/test/fork-module-kernel-abort.test.ts` — `(0 test)`, same failure
    mode.
  Both threw the identical error, from module-level top-level code executed
  during collection:
  ```
  Error: Failed to generate the program package source projection:
  .../target/aarch64-apple-darwin/release/xtask build-deps program-index-context-ensure --source-repo-root ... failed with status 1:
  xtask build-deps: program package index target changed before publication: local mirror identity or contents changed: .../packages/registry/program-packages.json
  ```
- No unhandled-rejection or worker-crash banners appeared outside the
  `FAIL`/failed-suite reporting; the "not-a-FAIL-line" danger case here is
  specifically the two zero-test files above.

### All 47 `FAIL` lines, verbatim (2 failed-suite lines + 45 failed-test lines)

```
 FAIL  host/test/fork-from-thread.test.ts [ host/test/fork-from-thread.test.ts ]
 FAIL  host/test/fork-module-kernel-abort.test.ts [ host/test/fork-module-kernel-abort.test.ts ]
 FAIL  host/test/fork-from-dlopen-side-module-e2e.test.ts > fork from a dlopened side module > runs mode-1 vfork from a real side-module frame in the production worker path
 FAIL  host/test/fork-from-dlopen-side-module-e2e.test.ts > fork from a dlopened side module > runs mode-1 vfork from a real side-module frame through the fork-module (flag on)
 FAIL  host/test/fork-host-import-runtime.test.ts > production fork host-import routing > retains complete scalar, vector, abstract, and concrete import types
 FAIL  host/test/fork-host-import-runtime.test.ts > production fork host-import routing > parses exact artifact signatures and routes only registered opaque imports
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-01 single top-level fork
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-02 multiple top-level forks
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-03 fork inside if body
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-04 fork inside block body
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-05 fork inside loop body (today: guard-dispatch; post-pivot: trampoline)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-06 fork inside try_table body
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-07 fork via call_indirect (today: guard-dispatch; post-pivot: trampoline)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-08 fork with stack carryovers (today: guard-dispatch; post-pivot: trampoline)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-09 fork in irreducible CFG (today: guard-dispatch; post-pivot: trampoline)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / D-* dispatch > D-10 fork in callee, caller instruments correctly
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-01 fork in compiler EH try body
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-02 fork in compiler EH catch
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-03 fork in a distinct multi-arm catch target
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-04 fork after an external throw reaches a catch
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-05 fork in a single modern-EH catch
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-06 fork in a reference-form multi-arm catch
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-07 fork in a plain-form multi-arm catch
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-10 forks in both a try body and its catch
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / C-* catch-handler resume > C-11 forks after a compiler catch has completed
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / S-* side effects during rewind > S-01 atomic_fetch_add before fork (B1 RMW)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / S-* side effects during rewind > S-02 atomic.notify before fork (B1 notify)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / S-* side effects during rewind > S-03 atomic_compare_exchange_strong before fork (B1 cmpxchg)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / S-* side effects during rewind > S-08 external throw with live compiler exnref state
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / K-* callback fork roots > K-01 fork from sigaction(SIGUSR1) handler (C3) [signal-handler discovery]
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / K-* callback fork roots > K-02 fork from signal(SIGALRM) handler (C3) [signal-handler discovery]
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / K-* callback fork roots > K-04 fork from qsort comparator (C3 indirect-callback pathological case)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / K-* callback fork roots > K-05 fork with pending signal (sigprocmask blocked SIGUSR1)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / K-* callback fork roots > K-06 fork from destructor through compiler CatchAll cleanup
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / K-* callback fork roots > K-07 fork from atexit handler
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-01 fork from main thread, no other threads
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-02 fork while another thread is blocked in pthread_cond_wait
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-03 fork holding pthread_mutex (POSIX-mandated child inherits locked)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-04 popen+pclose (fork+exec+pipe end-to-end)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-05 posix_spawn — non-forking path, must remain unchanged by refactor
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-06 fork from non-main thread
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-07 recursive fork (parent → child → grandchild)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-08 vfork child exit resumes the parent
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-09 posix_spawn forking path (fork+exec via spawn)
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-10 continuation grows beyond the retired fixed reserve
 FAIL  host/test/fork-instrument-coverage.test.ts > fork_instrument_coverage / P-* process & threading > P-11 root and later continuation allocation failures preserve the parent
 FAIL  host/test/fork-module-worker-instantiation.test.ts > fork-module worker instantiation > drives a qualifying fork through the co-resident module
```

The "9 skipped" are `it.skip(...)` cases that are self-documented in
`fork-instrument-coverage.test.ts` as owned by another suite (C-08, C-09,
S-04, S-05, S-06, S-07, F-03, F-04 — 8 named skips there); vitest's own
count for the whole run is 9, and I did not track down the ninth to a
specific line — recorded here as an honest gap rather than a guess. The
"2 expected fail" are `it.fails(...)` at F-01/F-02 in the same file, an
intentional "traps cleanly on unimplemented import" contract, not part of
this baseline's failure set.

## Why 43 of the 47 `FAIL` lines are an invocation artifact, not fork-logic red

Investigating each failure's error text turned up a single mechanical cause
for almost all of them, which changes how this baseline should be read.

`host/vitest.config.ts` sets `testTimeout: 30_000` specifically because
(per its own comment, "STOPGAP (lane T, T6)") every test in
`fork-instrument-coverage.test.ts` costs 8.4-9.6s and the vitest default is
5s. That config file only loads when vitest's project root is `host/`. The
brief's Step 2 command runs `npx vitest run host/test/fork-*.test.ts` from
the **repository root**, where there is no `vitest.config.ts` — so vitest
falls back to its built-in defaults: `testTimeout` reverts to 5000ms, and
(separately) the `pool`/`maxWorkers` settings that serialize/limit
concurrent test-file workers are not applied either.

I confirmed this directly: rerunning a single test
(`fork-instrument-coverage.test.ts -t "P-01"`) from the repo root reproduces
`Error: Test timed out in 5000ms.` on a test that legitimately takes ~8.3s;
the same test passes when run from `host/` (where the config loads).

This explains:

- **40 of the 45 failed tests** — every `D-*`, `C-*`, `S-*`, `K-*`, `P-*`
  timeout in `fork-instrument-coverage.test.ts` is this default-5s-timeout
  artifact, not a fork-logic regression.
- **The 2 zero-test failed suites** (`fork-from-thread.test.ts`,
  `fork-module-kernel-abort.test.ts`) and **1 more failed test**
  (`fork-module-worker-instantiation.test.ts`) all threw the same
  `program package index target changed before publication` error from
  `ensureProgramIndexesInSourceContext` (`host/src/binary-resolver.ts:734`).
  `host/test/global-setup.ts` regenerates
  `packages/registry/program-packages.json` once at suite start via
  `cargo run -p xtask ... build-deps program-index`, and several fork test
  files independently call `resolveBinary` → `ensureProgramIndexesInSourceContext`
  → `xtask build-deps program-index-context-ensure`, which snapshots and
  re-publishes the same file. When multiple such test files execute
  concurrently, one process's re-publish invalidates another's snapshot and
  the guard — correctly — reports the file changed under it. This is a
  concurrency hazard between test files sharing a generated artifact, not
  something Tasks 1-3 introduced; it is orthogonal to the timeout issue
  above but was only observed in the same misconfigured (repo-root) run.

To separate genuine fork-logic red from this artifact, I reran the exact
same file set from `host/` (`cd host && npx vitest run test/fork-*.test.ts`),
where the config loads:

```
 Test Files  2 failed | 66 passed (68)
      Tests  4 failed | 478 passed | 2 expected fail | 9 skipped (493)
```

(Total test count differs from the primary run — 493 vs 489 — by exactly
the 4 tests that `fork-from-thread.test.ts` (3 `it.skipIf`) and
`fork-module-kernel-abort.test.ts` (1 `it`) never got to register in the
misconfigured run; both files ran to completion here with no failures.)

**This corrected run is not the Task 8 diff target** — the primary run
above is, because it is the literal command the brief specifies and is
what a same-command rerun in Task 8 will reproduce (including the same
invocation artifact, symmetrically, on both sides of that diff). This
section exists so a reader of the primary run's 47 `FAIL` lines does not
mistake 43 of them for fork-logic damage.

## The 4 (later 2) genuine failures, and their attribution

Of the corrected run's 4 failures, 2 resolved once a missing local build
artifact was provisioned (not a code defect); 2 are real and are
attributed below to specific commits on this lane.

### Resolved: missing `local-binaries/sffs_module32.wasm`

```
 FAIL  test/fork-from-dlopen-side-module-e2e.test.ts > fork from a dlopened side module > runs mode-1 vfork from a real side-module frame in the production worker path
Error: ENOENT: no such file or directory, open '.../local-binaries/sffs_module32.wasm'
 FAIL  test/fork-from-dlopen-side-module-e2e.test.ts > fork from a dlopened side module > runs mode-1 vfork from a real side-module frame through the fork-module (flag on)
Error: ENOENT: no such file or directory, open '.../local-binaries/sffs_module32.wasm'
```

`local-binaries/` is gitignored and per-worktree (per this plan's own
build-freshness memory and `CLAUDE.md`'s build contract: "a fresh checkout
or `git worktree` inherits none of them"). This worktree simply had never
run `crates/sffs-module/build-wasm.sh`. I built it —
`scripts/dev-shell.sh bash crates/sffs-module/build-wasm.sh`, exit 0,
staged `local-binaries/sffs_module32.wasm` (build-key
`b79fb3bd1529a34e6f5df3c45bbae965d62b21340413eea5758c8efb84073e49`) — and
reran `fork-from-dlopen-side-module-e2e.test.ts` alone: 7/7 passed. This is
a provisioning gap, not a lane regression; per Task 4's constraints I did
**not** touch `crates/fork-module/build-wasm.sh` or its build key.

**Verdict: not a code defect. Not attributable to a lane commit** — the
`sffs-module` build script itself was added on this lane
(`8d81c6b1e2`, "VFS: Give the builder module a build script that defends
its own contract" — confirmed off `main` via
`git merge-base --is-ancestor`), but the failure here was "script never
run in this worktree", which any fresh worktree would hit regardless of
lane state.

### Genuine, attributed: `fork-host-import-runtime.test.ts`, 2 failures

**Failure A — malformed type section on `(ref null shared 0)`:**

```
WasmArtifactModuleError: wa_read_facts: malformed type section: invalid value type (at offset 0x1c)
 ❯ readWasmArtifactFacts src/wasm-artifact-driver.ts:578:11
 ❯ readWasmFunctionImports src/constants.ts:122:10
 ❯ test/fork-host-import-runtime.test.ts:157:24
```

The test's hand-built module (`typedBoundaryImportsModule()`) encodes a
type-section byte sequence including `0x63, 0x65, 0x00` for
`(ref null shared 0)` (long-form nullable ref, `0x65` = the shared-heaptype
prefix, `0x00` = type index 0). Offset `0x1c` (28) in that module is
exactly the `0x00` type-index byte following the shared prefix — the parser
rejects the shared-heaptype construct at the point it tries to read the
heap type that follows `0x65`.

**Failure B — canonicalization mismatch:**

```
AssertionError: expected [ { module: 'host', …(4) }, …(1) ] to deeply equal [ { module: 'host', …(4) }, …(1) ]
- Expected            (test)
+ Received            (production)
-           "code": 99,          // 0x63, long-form "ref null ht"
-           "heapType": -17,     // Extern
+           "code": 111,         // 0x6F, the one-byte "externref" shorthand
```

**Evidence trail:**

- `crates/wasm-artifact/src/facts.rs` (which contains both
  `readWasmArtifactFacts`'s Rust backend and the `binary_value_type`
  canonicalization function responsible for Failure B) was **created on
  this lane**: `git log --diff-filter=A` shows it first added by
  `ed3fefb44d` ("Kernel: Give WebAssembly artifact policy one Rust
  authority", 2026-09-10), and `git merge-base --is-ancestor ed3fefb44d
  888e628d5...` (the lane's merge-base with `main`) returns false — it is
  not an ancestor of `main`, i.e. it was introduced on the lane branch.
  This crate replaced an older hand-rolled TypeScript reader (per the
  crate's own Cargo.toml comment), so both failure modes live entirely in
  lane-introduced code.
- Failure B specifically: `git log -S "abstract_shorthand_code"
  -- crates/wasm-artifact/src/facts.rs` finds exactly one commit,
  `b586eb924e` ("ABI: Carry binary value types and declaration order in
  artifact facts", 2026-09-10, same day as the crate's creation and also
  not an ancestor of `main`). That commit introduced the
  "canonical, not verbatim" encoding rule documented in `facts.rs`
  (nullable/unshared abstract heap types canonicalize to their one-byte
  shorthand) without updating this test's expectations.
- The test file itself (`host/test/fork-host-import-runtime.test.ts`,
  including the specific `(ref null shared 0)` case in Failure A) was last
  touched by `f5d0d544c4` ("Host: Rebuild replay references in fresh
  workers", 2026-07-26) — confirmed an ancestor of the lane's merge-base
  (`888e628d5`), i.e. it **predates the lane** and was written against the
  old TypeScript reader, months before the Rust `wasm-artifact` crate
  existed.

**Verdict: introduced by this lane.** The test's expectations predate the
lane (`f5d0d544c4`, 2026-07-26, on `main`); the production code that now
disagrees with them — the new Rust artifact-facts reader and its
canonicalization rule — was added on the lane on 2026-09-10
(`ed3fefb44d`, `b586eb924e`). Neither commit updated this test, so it has
most likely been red since 2026-09-10 (9 days at the time of this
baseline) without anyone updating or removing it — I did not verify this
by checking out and running each intermediate commit (out of scope for
this task's budget), so "since 2026-09-10" is inferred from the blame
evidence above, not directly measured across the whole range.

I did not determine why `facts.rs`'s parser rejects the shared-heaptype
byte sequence at the wasmparser level (multiple wasmparser versions
0.244-0.258 exist in the workspace's `Cargo.lock`; `crates/wasm-artifact`
pins `0.247` with `default-features = false`) — that would require reading
into the vendored `wasmparser` crate's feature-gating, which is beyond what
this baseline task should spend on. Recorded as **undetermined at the
mechanism level**, but the attribution (introduced by this lane, on
2026-09-10) is not in doubt given the evidence above.

## Net baseline at HEAD (`c4693f274`)

- **2 genuine, lane-introduced failures**, both in
  `host/test/fork-host-import-runtime.test.ts` (see above).
- **0 failures** attributable to Tasks 1-3 specifically (`d7faaf1bb`,
  `621ae43de`, `c4693f274`) — neither failing test's error traces through
  code those commits touched.
- **43 apparent failures are a repo-root-vs-`host/`-cwd invocation
  artifact** (40 default-5s timeouts + 2 zero-test suite crashes + 1 more
  test failure from a shared-file race), reproducible on demand by running
  the brief's exact command from the repository root, and absent when the
  same files are run from `host/`.
- `host/test/fork-identity-release.test.ts` (added by Task 3) is included
  in both runs above and passed in both; its presence is why the file
  count is 68 rather than 67.

## Surface-budget gate

```
cd host && npx vitest run test/surface-budget.test.ts
```

- **BUDGET_EXIT: 0**
- `Test Files  1 passed (1)` / `Tests  109 passed (109)`
- No ceiling was raised or otherwise touched. This task added no
  production code, so this gate was expected to stay green; it did.

## Files touched by this task

- `docs/plans/2026-09-18-fork-suite-baseline.md` (this file) — the only
  file staged for commit.
- `local-binaries/sffs_module32.wasm` and its `.build-key` — built as a
  missing-artifact provisioning step (gitignored, not committed).
- `packages/registry/program-packages.json` — regenerated by `vitest`'s own
  `globalSetup` on every run (gitignored, not committed).
- `host/dist/*` — rebuilt via `npm run build` (gitignored, not committed).
- `crates/fork-module/build-wasm.sh` was **not** run; the fork-module build
  key above was read from the artifacts Task 3 already staged.
