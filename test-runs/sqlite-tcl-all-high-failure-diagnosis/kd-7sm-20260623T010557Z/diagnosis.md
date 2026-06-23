# kd-7sm SQLite Tcl all high-failure diagnosis

Generated: 2026-06-23T01:07:51Z

## Finding

A common setup/harness defect exists. The high all-run failure count is not expected all-target coverage.

Root cause: Kandelo's SQLite official runners inserted the platform override only in `kandelo-testrunner.tcl`. SQLite upstream `test/testrunner.tcl` uses that parent process to create jobs, but for `all` config variants it stores child commands in the form `testfixture test/testrunner.tcl <config> <test-file>`. Those child jobs bypassed the wrapper and reached upstream platform selection with Kandelo/Tcl's raw OS name, producing `cannot determine platform!` before any SQLite test body ran.

The fix in this worktree patches the copied Node workdir runner and the browser VFS runner copy of `test/testrunner.tcl`, so child config jobs inherit:

```tcl
set ::tcl_platform(os) OpenBSD
set ::tcl_platform(platform) unix
```

Focused validation exposed two additional all-mode harness assumptions in the Node path after the platform error was removed:

- SQLite runs each generated `run.sh` after `cd testdirN`, so commands built from host-normalized workdir paths have to be rewritten to paths relative to the job directory, for example `../testfixture.wasm ../test/testrunner.tcl fullmutex ../test/select1.test`.
- The guest `sh run.sh` form hangs in this environment even when the file contains a command that passes via `sh -c`; the copied runner now keeps `run.sh` for auditability but launches the same content through `sh -c`.

The Node runner also now requires or discovers a guest `/bin/sh`-compatible wasm for `all` mode and copies `testfixture`, `sqlite3`, and `sh` into the temporary SQLite workdir so child jobs have stable guest-visible paths.

## Evidence

Paused kd-c5i all-run counts from `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/continuation-wave31-direct-root-20260623T0051Z/wave31-paused-reconciliation-20260623T0100Z/summary.json`:

| Host | Pass | Fail | Skip | Incomplete | Total |
|---|---:|---:|---:|---:|---:|
| node | 1343 | 9007 | 0 | 3 | 10353 |
| browser | 780 | 9586 | 0 | 0 | 10366 |
| combined | 2123 | 18593 | 0 | 3 | 20719 |

Failure split from the paused aggregate:

| Category | Jobs |
|---|---:|
| `config=` variant failures invalidated by harness defect | 17932 |
| ordinary `full` failures to preserve for separate triage | 661 |
| paused incomplete rows | 3 |

Node current failed rows with `cannot determine platform!`: 8959 of 9007 failed rows; node config failed rows: 8959.

Browser representative source failed rows with `cannot determine platform!`: 8073 in `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/browser-current-outcome-lists-20260622T032900Z/failed-jobs.tsv`. The final paused browser aggregate dropped excerpts, but the source list/logs preserve the same signature for config batches.

Representative Node log `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/continuation-wave4-20260622T065630Z/node-canonical/shards/shard-02/batches/002-fullmutex/testrunner.log`:

```text
### config=fullmutex test/types3.test 586ms (failed)
/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/packages/registry/sqlite/bin/testfixture.wasm: cannot determine platform!
    while executing
"error "cannot determine platform!""
    (file "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/continua..." line 268)
    invoked from within
"source $argv0"
    invoked from within
"if {[llength $argv]>=1} {
set argv0 [lindex $argv 0]
set argv [lrange $argv 1 end]
source $argv0
} else {
set line {}
while {![eof stdin]} {
if {$line..."
### config=fullmutex test/rollback.test 531ms (failed)
/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/packages/registry/sqlite/bin/testfixture.wasm: cannot determine platform!
```

Representative browser failure excerpt from `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/browser-current-outcome-lists-20260622T032900Z/failed-jobs.tsv`:

```text
/usr/bin/testfixture: cannot determine platform!     while executing "error "cannot determine platform!""     (file "/sqlite/test/testrunner.tcl" line 268)     invoked from within "source $argv0"     invoked from within "if {[llength $argv]>=1} { set argv0 [lindex $argv 0] set argv [lrange $argv 1 end] source $argv0 } else { set line {} while {![eof stdin]} { if {$line..."
```

## Prior full-run comparison

The prior Tcl `full` artifacts were not exercising the same all-mode config child path. Their explicit failures were small and concrete:

| Run | pass | fail | skip | incomplete |
|---|---:|---:|---:|---:|
| kd-nbh.4-browser-full | 22 | 2 | 0 | 228 |
| kd-nbh.4.1-browser-full-continuation | 94 | 1 | 0 | 100 |
| kd-d7q-browser-full-tail | 1 | 2 | 0 | 0 |

Notable prior full failures were `test/bigfile.test`, `test/bigfile2.test`, `test/recover.test`, and `test/walcrash3.test`; those do not explain the all-run's thousands of one-case `config=` startup failures.

Detailed comparison tables:

- `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-7sm-sqlite-all-high-failure-diagnosis/test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/comparison-tables/all-counts-by-host-outcome-config.tsv`
- `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-7sm-sqlite-all-high-failure-diagnosis/test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/comparison-tables/all-config-failure-counts.tsv`
- `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-7sm-sqlite-all-high-failure-diagnosis/test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/comparison-tables/all-full-failure-overlap-with-prior-full.tsv`
- `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-7sm-sqlite-all-high-failure-diagnosis/test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/comparison-tables/prior-full-counts-by-run-outcome.tsv`

## Setup and invocation comparison

kd-c5i all-run initial invocations used `scripts/run-sqlite-project-unit-tests.sh --permutation all`:

```bash
#!/usr/bin/env bash
set -o pipefail
cd "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run"
TMPDIR=/private/tmp/kd-c5i-node-all-tmux-20260622T015540Z bash scripts/run-sqlite-project-unit-tests.sh --host node --permutation all --jobs 8 --timeout-ms 86400000 --results-root "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/node-all-tmux" > "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/node-all-tmux/run.log" 2>&1
status=$?
printf "%s\n" "$status" > "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/node-all-tmux/exit-status"
exit "$status"
```

```bash
#!/usr/bin/env bash
set -o pipefail
cd "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run"
TMPDIR=/private/tmp/kd-c5i-browser-all-tmux-20260622T015540Z SQLITE_TEST_VITE_PORT=6420 bash scripts/run-sqlite-project-unit-tests.sh --host browser --permutation all --jobs 4 --timeout-ms 86400000 --results-root "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/browser-all-tmux" > "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/browser-all-tmux/run.log" 2>&1
status=$?
printf "%s\n" "$status" > "/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-c5i-sqlite-all-full-throttle-run/test-runs/sqlite-tcl-all/kd-c5i-all-20260622T015540Z/browser-all-tmux/exit-status"
exit "$status"
```

The earlier kd-nbh.4 full run used the supervised browser runner with `--permutation full` and a full manifest; kd-nbh.4.1 restored setup prerequisites (`npm ci`, browser demo dependencies, Tcl/SQLite/zlib/testfixture/dash/kernel/rootfs/VFS) before its final safe-boundary full rerun. Those reports are preserved at:

- `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-nbh.4-sqlite-crash-recovery-fullsuite-rerun/test-runs/sqlite-project-unit-supervised/kd-nbh.4-fullsuite-browser-20260621T043619Z/final-audit-report.md`
- `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-nbh.4.1-sqlite-safe-boundary-continuation/test-runs/sqlite-project-unit-supervised/kd-nbh.4.1-rerun-browser-rootfs-20260621T110111Z/final-report.md`
- `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-d7q-sqlite-full-tail/test-runs/sqlite-project-unit-supervised/kd-d7q-final-accounting-20260621T224023Z/final-accounting-report.md`

Host parity: the defect applies to both Node and browser. Node creates a temporary SQLite workdir; browser creates a fresh memfs from `sqlite-test.vfs.zst`. Both used a parent wrapper named `kandelo-testrunner.tcl`, and both allowed all-mode child config jobs to run raw `test/testrunner.tcl`. Both paths now patch the copied upstream runner rather than SQLite source.

UID/GID/root waves: the paused all-run included ordinary user and direct-root continuation waves, but this defect is independent of UID/GID. The failure happens during Tcl platform classification before the test body or filesystem permission-sensitive setup. Existing root/direct-root wave outcomes should not be treated as valid config coverage until rerun with the child-runner shim fix.

## Fix

Changed files:

- `scripts/run-sqlite-official-tests.sh`: after copying SQLite into the Node workdir, insert the Kandelo platform shim into `test/testrunner.tcl` itself, require/discover a guest `sh` for `all` mode, copy runnable wasm tools into the workdir, rewrite all-mode child command paths relative to `testdirN`, set `SQLITE_TMPDIR=.`, and launch generated commands through inline `sh -c`.
- `apps/browser-demos/pages/sqlite-test/main.ts`: when running `kandelo-testrunner.tcl`, patch `/sqlite/test/testrunner.tcl` inside the browser memfs with the same platform, guest-relative path, `SQLITE_TMPDIR=.`, and inline `sh -c` adjustments, then write the parent wrapper from the same shim text.

No package recipe output, ABI version, or VFS build artifact is changed by this source patch.

## Validation

Focused Node all-mode selector now passes through the normal project-unit wrapper:

```bash
scripts/dev-shell.sh bash -lc 'scripts/run-sqlite-project-unit-tests.sh --host node --permutation all --jobs 1 --timeout-ms 60000 --results-root test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/node-fullmutex-select1-after-inline-launch-fix --fail-fast "^fullmutex select1.test$"'
```

Result: runner exit 0, 1 job done, 0 failed, 0 omitted, 0 running, 192 SQLite cases, 0 case errors. Artifacts:

- `test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/node-fullmutex-select1-after-inline-launch-fix/combined-summary.md`
- `test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/node-fullmutex-select1-after-inline-launch-fix/node/summary.txt`
- `test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/node-fullmutex-select1-after-inline-launch-fix/node/testrunner.db`
- `test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/node-fullmutex-select1-after-inline-launch-fix/outcome-lists/passed-jobs.tsv`
- `test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/node-fullmutex-select1-after-inline-launch-fix/outcome-lists/failed-jobs.tsv`
- `test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/node-fullmutex-select1-after-inline-launch-fix/outcome-lists/skipped-jobs.tsv`

Browser source validation:

- `scripts/dev-shell.sh bash -lc 'cd apps/browser-demos && npx esbuild pages/sqlite-test/main.ts --bundle --format=esm --platform=browser --external:@host/* --external:@kernel-wasm?url --outfile=/tmp/kd-7sm-sqlite-test-main.js'` passed.
- `scripts/dev-shell.sh bash -lc 'cd apps/browser-demos && npx tsc --noEmit'` was attempted and failed on pre-existing unrelated project type errors in `pages/benchmark/main.ts` and host imports lacking Node/ES2024 types; it did not isolate a `pages/sqlite-test/main.ts` error.
- Focused browser all-mode runtime validation was attempted with `--host browser --permutation all "^fullmutex select1.test$"` and blocked before the SQLite page loaded because this worktree lacks `rootfs.vfs` for the browser kernel Vite alias. The attempted run built `apps/browser-demos/public/sqlite-test.vfs.zst` and then Vite failed resolving `@rootfs-vfs`. Artifacts: `test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/browser-fullmutex-select1-after-inline-launch-fix/browser/summary.txt` and `test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/focused-validation/browser-fullmutex-select1-after-inline-launch-fix/browser/blocker-rootfs-vfs.txt`.

Project gate checks:

- `scripts/dev-shell.sh bash scripts/check-abi-version.sh` passed; snapshot, C header, TypeScript bindings, and `ABI_VERSION` are in sync.
- `bash scripts/check-abi-version.sh` outside the dev shell failed first because host Cargo was stable and rejected the script's nightly `-Z` flag; the dev-shell rerun is the authoritative result.
- `cd host && npx vitest run` was attempted after building the sysroot and produced 572 passed, 25 failed, 199 skipped. The failures were due missing binary artifacts such as `kernel.wasm`, `programs/wasm64/hello64.wasm`, and `programs/fork-exec.wasm`, not this SQLite harness patch.

Earlier focused Node validation attempts are preserved under `focused-validation/` and show the intermediate failure boundaries: missing guest shell, host-absolute child path, path relative to the wrong directory, and `sh run.sh` hang. They are useful regression evidence for the setup fixes but not the passing proof.

## Restart source lists

Do not relaunch broad SQLite all until mayor/user direction resumes full-throttle. When resumed, use these exact restart sources:

- Invalidated config rows: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-7sm-sqlite-all-high-failure-diagnosis/test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/restart-source-lists/platform-shim-invalidated-displaynames.tsv`
- Grouped selector patterns for rerun tooling: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-7sm-sqlite-all-high-failure-diagnosis/test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/restart-source-lists/platform-shim-invalidated-selector-patterns.tsv`
- Ordinary full failures to preserve separately: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-7sm-sqlite-all-high-failure-diagnosis/test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/restart-source-lists/ordinary-full-failures-preserve-for-triage.tsv`
- Paused incomplete rows from wave31: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-7sm-sqlite-all-high-failure-diagnosis/test-runs/sqlite-tcl-all-high-failure-diagnosis/kd-7sm-20260623T010557Z/restart-source-lists/paused-incomplete-jobs.tsv`

The `platform-shim-invalidated-*` lists are the high-priority restart set after the fix. The ordinary full failures are not caused by this shim bug and should remain separate SQLite/runtime triage evidence.
