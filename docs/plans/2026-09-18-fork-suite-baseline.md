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
cd /Users/brandon/kandelo-lane-f && npx vitest run host/test/fork-*.test.ts > .superpowers/sdd/2026-09-18-fork-storage-phase0-and-build-path/fork-baseline.txt 2>&1
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

**The reproducibility claim above is not equally strong for all 43.** The
40 timeouts are well-supported: 8.2-9.6s actual durations against a hard
5s cutoff is a large, consistent margin, and I confirmed it with a
targeted single-test rerun (above). The other 3 — the two zero-test
suite failures in `fork-from-thread.test.ts` and
`fork-module-kernel-abort.test.ts`, plus the one failed test in
`fork-module-worker-instantiation.test.ts`, all carrying the
`program package index target changed before publication` error text —
were observed in a single run of the primary command. The mechanism I
described for them (concurrent test files racing to republish the same
generated file) is scheduling-dependent by construction, and I did not
rerun the primary command a second time to check whether the same 3
lines, or the same count, come back. **If Task 8's `diff <(grep FAIL
baseline) <(grep FAIL after)` shows an added or dropped `FAIL` line whose
text contains `program package index target changed before publication`,
cross-check it against this race mechanism before attributing it to the
build change** — it may simply be the same pre-existing race landing on a
different file under different scheduling, not a regression Phase 1
introduced.

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
  test failure from a shared-file race), absent when the same files are
  run from `host/`. The 40 timeouts reproduce reliably on demand
  (confirmed by a targeted rerun); the 3 race-derived lines were seen
  once and are scheduling-dependent — see the caveat above before
  attributing a diff-visible change in those 3 specific lines to Phase 1.
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

## P-11 recursion headroom

`programs/p_11_fork_continuation_enomem.c` calls `fork_at_depth(4096)` on
whatever shadow stack `build-programs.sh` links it with (no `-z,stack-size`
flag is passed, so wasm-ld's own default applies). Task 7/8 will move that
default to the SDK's 8 MiB. This measures the margin before that move, on
the artifact as built today — not rebuilt for this task.

**Artifact measured:** `local-binaries/programs/wasm32/p_11_fork_continuation_enomem.wasm`,
`ls -la` → size 88738 bytes, mtime `Sep 12 05:05` (2026), confirmed via
`stat -f "%Sm"`. Built before this plan's work; not rebuilt here.

### wasm-ld's default stack size is 65536 bytes, measured, not assumed

The brief's premise (64 KiB default) was checked directly rather than taken
on faith, and `build-programs.sh` was re-confirmed to pass no
`-z,stack-size` anywhere in `CFLAGS`/`LINK_POST_LIBS`
(`grep -n "stack-size" scripts/build-programs.sh` → no matches).

To find wasm-ld's actual default, a trivial `void _start(void) {}` was
compiled (`wasm32-unknown-unknown`, `-nostdlib`) and linked three ways —
with no `-z stack-size`, with `-z stack-size=65536`, and with
`-z stack-size=1048576` — then each linked module's `__stack_pointer`
initializer was read with `wasm-objdump -x`:

```
default:            global[0] i32 mutable=1 <__stack_pointer> - init i32=66560
-z stack-size=65536:  global[0] i32 mutable=1 <__stack_pointer> - init i32=66560
-z stack-size=1048576: global[0] i32 mutable=1 <__stack_pointer> - init i32=1049600
```

The default and the explicit-65536 run produce byte-identical
`__stack_pointer` initializers (66560 = `--global-base` default of 1024 +
65536). This confirms wasm-ld's own default stack size is exactly 65536
bytes (64 KiB) for this toolchain (LLVM/lld 21.1.7), by direct comparison
against an explicit value — not inferred from `stackTop - dataEnd` on the
real artifact, which the task brief flags as an overstatement (it would
fold in the whole of `.bss`, which occupies address space but emits no
data segment).

### Locating `fork_at_depth` in the shipped artifact

The shipped artifact carries almost no local function names — its `name`
custom section (read via `llvm-objdump -t`, 90-ish entries) contains only
`wpk_fork_*`/`__wpk_fork_*` symbols the fork-instrument tool itself injects;
ordinary compiled C functions (including `fork_at_depth`, `main`, libc
internals) have no name entries at all. This is not instrumentation
stripping something — a scratch recompile of the same source **without**
running the fork-instrument step (see below) shows the same absence of
names for user functions, so it is just how this `-O2`, no-`-g` toolchain
output looks by default.

Without names, `fork_at_depth` was located by its structural signature: a
custom wasm-binary parser (LEB128-aware, written for this task) established
the true global-index numbering (`imported_globals=3`, so module-defined
globals start at index 3; `__stack_pointer` is exported as `global[3]`) —
`wasm-objdump -x` was independently checked against this and found to
mis-parse this binary's Type/Global sections (it fails on the module's
shared-reftype/exnref encodings — `wasm-objdump -d local-binaries/…wasm`
throws `error: expected valid result type`, `error: table elem type must be
a reference type`, and `warning: invalid function index: 166` on this exact
file — so its section listings for this artifact are not trustworthy and
were not used for the global-index or self-recursion analysis; `llvm-objdump`
and the custom parser were used instead). A second script then scanned the
`llvm-objdump -d` disassembly for a function that calls itself (`call N`
where `N` is that function's own index, derived from position in the CODE
section plus the confirmed 16 imported functions). Exactly one match: wasm
function index 42 (address `0001028a`), which also matches the fork
`c_04_fork_in_catch_external_throw.cpp`-style save/restore shape: its
prologue checks a resume-state flag (`global.get 8; i32.const 2; i32.ge_u`)
and, when set, restores six locals from six fixed offsets (16/20/24/28/32/36)
of a state-struct pointer held in `global 9` — a per-function-specific
restore sequence that only makes sense as fork-instrument's specialization
for this exact function's local layout, not a generic shared helper. It is
called from 43 sites across the `__wpk_fork_resume_*` dispatch functions,
consistent with being the one place all logical recursion levels of
`fork_at_depth` resume into.

### All three hypotheses were tested; two hold together

**Hypothesis 1 (a small per-frame shadow-stack cost N) — rejected.**
Function 42's full body was dumped and searched for any reference to
global index 3 (`__stack_pointer`, confirmed by the parser above and
cross-checked against 63 other `global.get/set 3` references elsewhere in
the binary that DO show the classic prologue shape, e.g.
`global.get 3; i32.const 8128; i32.sub; local.tee 7; global.set 3` at
address `0x1535` in an unrelated function — so global 3 is definitely the
stack pointer and the shape is definitely present in this binary when a
function needs it). `grep -c "global\.(get|set)\s*3\b"` restricted to
function 42's address range returns **zero**. There is no
`global.get 3 / i32.const N / i32.sub / global.set 3` prologue in this
function at all — not for any N.

**Hypothesis 2 (zero shadow-stack cost — ordinary scalar locals never touch
it) — confirmed, from two independent artifacts.** In the shipped
instrumented binary, function 42 never references global 3, at all, in any
branch. To rule out this being an instrumentation artifact rather than a
property of the source, the same `.c` file was recompiled in isolation
(scratch only, not touching `local-binaries/` or the official build path,
and **not** run through `scripts/run-wasm-fork-instrument.sh`) with the
same `CFLAGS`/link flags `build-programs.sh` uses. In that raw,
uninstrumented build, `fork_at_depth` is wasm function index 20 (address
`0x4f5`), and its entire body is:

```
000004f5 <>:
     4f7: 20 00        local.get   0
     4f9: 45           i32.eqz
     4fa: 04 40        if
     4fc: 10 1a        call        26        # fork()
     4fe: 0f           return
     4ff: 0b           end
     500: 20 00        local.get   0
     502: 41 01        i32.const   1
     504: 6b           i32.sub
     505: 10 14        call        20        # fork_at_depth(depth - 1) — genuine self-call
     507: 20 00        local.get   0
     509: 41 7f        i32.const   -1
     50b: 46           i32.eq
     50c: 6a           i32.add
     50d: 0b           end
```

This is a line-for-line match to the C source (`if (depth == 0) return
fork(); …; fork_at_depth(depth - 1); …; return result + (depth == -1);`).
There is no `.local` declaration at all — the function needs no locals
beyond its one parameter — and it references no global whatsoever, so it
cannot be adjusting `global[1]` (`__stack_pointer` in this un-instrumented
build, confirmed by the same parser). `depth` and the fork() result are
plain scalars with no address ever taken in the C source, so LLVM keeps
them in wasm locals/on the value stack; nothing forces them onto the
linear-memory shadow stack. **This holds independent of whether the call is
genuinely recursive or has been transformed** — see below — because it is
true in both the raw recursive form and the shipped instrumented form.

**Hypothesis 3 (the recursion is not 4,096 real call frames at runtime) —
also confirmed, but only in the shipped artifact, and by a different
mechanism than plain `-O2` tail-call optimization.** The raw/uninstrumented
build above shows genuine, real recursion: `call 20` targets its own
function index, so an uninstrumented build of this program would make up
to 4,096 real nested wasm `call` frames (the `asm volatile` in the source
does its job of blocking LLVM's own tail-recursion-to-loop pass). But the
**shipped** artifact's function 42 is shaped as an explicit loop instead: a
resume-state check, then `loop … br_if 0` decrementing a local by 1 each
iteration (`local.get 0; i32.const 1; i32.sub; local.tee 0; br_if 0`) is
the entire "recursive descent" — one function invocation iterates 4,096
times rather than 4,096 functions nesting. The resume-state-restore
preamble (loading saved locals from a struct pointer, gated on a
"phase >= 2" flag) could not come from plain `clang -O2`, which has no
concept of a resumable phase; this loop shape is the fork-instrument tool's
CFG transformation for making the function fork-resumable, not a LLVM
optimizer artifact. (One genuine self-recursive `call 42` does still exist
in the shipped function, guarded inside a `try_table`/`catch`-driven
unwind path reached only when a real fork is captured mid-descent — but
because function 42 itself never touches `global 3` in *any* branch, its
contribution to shadow-stack usage is 0 bytes regardless of how many times,
or in what shape, it executes.)

**Both hold, and they reinforce each other**: the shipped artifact's
"recursion" is a loop (H3), and even the genuinely-recursive raw form would
have cost 0 bytes of shadow stack per frame (H2). Either fact alone is
sufficient to clear the 64 KiB default; having both, from independently
built artifacts, is stronger evidence than either alone.

### The numbers

- Per-frame shadow-stack cost, measured: **0 bytes** (no
  `__stack_pointer`-adjusting prologue exists in `fork_at_depth`, in either
  the shipped instrumented form or a from-scratch uninstrumented
  recompile).
- Total at 4,096 frames: `4096 × 0 = 0 bytes`.
- Verdict against the 64 KiB (65536-byte) default: **fits, with the entire
  budget unused by this recursion** — 0 of 65536 bytes, not a narrow
  margin. **No overflow. No live defect** in the sense the brief's Step 3
  warned about; `.bss` is not being silently corrupted by this fixture's
  recursion depth.
- Margin at 8 MiB (8,388,608 bytes, Task 8's target): also 0 of 8,388,608
  bytes used. Task 7/8's stack-size change has **no effect** on this
  fixture's shadow-stack usage, because the fixture never drew on the
  existing 64 KiB budget to begin with. This is not "fits more
  comfortably at 8 MiB" — it is unaffected by the stack-size change either
  way.

This conclusion is scoped to `fork_at_depth`'s own contribution, which is
what recursion depth could have multiplied. It does not certify the peak
shadow-stack usage of the whole `main()` call chain (printf, mmap, libc
internals each have their own fixed, non-recursive frame costs — one
unrelated function elsewhere in the binary was observed using 8128 bytes
in a single frame, see above) — but none of those costs scale with the
4,096 argument, so they are out of scope for "the recursion's headroom."

### What actually bounds this recursion, since the shadow stack does not

The depth-scaling resource in this test is not the wasm-ld shadow stack at
all: it is the fork-module's own continuation-chunk allocator, which is
mmap-backed and sized in `WASM_PAGE_BYTES` (65536-byte) pages, per the C
file's own comments. Deep fork captures need "far more frame chunks than
three pages hold" (source comment, line 168-171), and `main()` deliberately
leaves the process's address space full except for exactly three
releasable pages before calling `fork_at_depth(4096)`, so the ENOMEM this
test expects is the continuation-chunk allocator running out — an
intentional, already-tested platform behavior (this is P-11's entire
purpose per its file-header comment), not a stack limit of any kind.

A separate, hypothetical limit — the wasm engine's own native call-stack
depth for genuine nested `call` instructions — would only be relevant to
the raw/uninstrumented recursive form, not to what is actually shipped and
run today (which is loop-shaped, per Hypothesis 3 above). That engine
limit, where it applies at all, is a trap on overflow (not silent
corruption) and is host/engine-dependent; it was not measured here because
it does not apply to the artifact under test.

### Surface-budget gate (this task)

```
cd host && npx vitest run test/surface-budget.test.ts > <output> 2>&1
echo "BUDGET_EXIT: $?"
```

- **BUDGET_EXIT: 0**
- `Test Files  1 passed (1)` / `Tests  109 passed (109)`

Run from `host/`, per this plan's own established rule (a repo-root
invocation silently drops `host/vitest.config.ts`). No ceiling was touched;
this task added no production code and no test.
