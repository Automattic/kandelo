## Summary

Adopts the SQLite project-unit harness work from PR #5 into Kandelo and records
both-host validation status against SQLite's official `full` permutation.

This PR adds `scripts/run-sqlite-project-unit-tests.sh`, documents the harness in
the porting guide, disables accidental default browser syscall tracing for the
SQLite demo runner, improves browser artifact snapshotting, fixes browser VFS
open-unlink lifetime behavior, and stabilizes the browser threaded-sorter path
used by `sort4.test`.

## Validation Status

Current completion target: SQLite official `full` permutation on both Node and
browser. The larger `all` permutation is tracked separately as `kad-29m`.

Full hard-count report: `test-runs/gastown-sqlite-epic-synthesis/final-hard-counts.md`.

Node full snapshot:

- Command: `/bin/bash scripts/dev-shell.sh /bin/bash scripts/run-sqlite-project-unit-tests.sh --host node --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-node-full-pr5`
- Artifacts: `test-runs/gastown-sqlite-node-full-pr5/{command.log,host-status.tsv,node/summary.txt,node/failures.tsv,node/testrunner.db,node/testrunner.log}`
- Runner status: `node 143`, command `exit_status=1` after summary write.
- Hard counts: 1394 jobs total, 0 done, 0 failed, 0 omit/skip, 1 running, 1393 ready, 0 cases, 0 case errors.
- `kad-36g` fixed the Mach-O exec-resolution wedge that caused this snapshot. No later full-suite Node DB is present in the final artifact set.

Browser full snapshot:

- Command: `bash scripts/run-sqlite-project-unit-tests.sh --host browser --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-browser-full-pr5-snapshot`
- Artifacts: `test-runs/gastown-sqlite-browser-full-pr5-snapshot/{run.log,host-status.tsv,combined-summary.md,browser/summary.txt,browser/failures.tsv,browser/testrunner.db,browser/testrunner.log}`
- Runner status: `browser 1`, page navigation/reload while Playwright was waiting in `page.evaluate()`.
- Hard counts: 1393 jobs total, 58 done, 4 failed, 0 omit/skip, 2 running, 1329 ready, 20066 cases, 1004 case errors.
- The SQLite testrunner records `done`, `failed`, `omit`, `running`, and `ready`; it does not record XFAIL/XPASS/flaky fields.

## Focused Superseding Results

The browser full snapshot's failed/running rows were followed by focused reruns:

| Host | Test | Focused result | Follow-up |
|---|---|---:|---|
| browser | `sysfault.test` | PASS, 1365 cases / 0 errors | Original full-snapshot failures did not reproduce after rebuild. |
| browser | `writecrash.test` | FAIL, 158 cases / 1 error | `kad-wtb.19`: browser executable visibility/materialization after repeated crash-child iterations. |
| node | `writecrash.test` | PASS, 995 cases / 0 errors | Node comparison passes. |
| browser | `walfault.test` | FAIL, 1 recorded case / 1 error | `kad-wtb.20`: browser Tcl abort plus kernel `munmap` trap. |
| node | `walfault.test` | TIME/RUNNING, 0 cases / 0 errors | Did not hit the browser abort path before timeout. |
| node | `like.test` | PASS, 159 cases / 0 errors | Original browser `like-14.2` concern is timing-threshold behavior. |
| browser | `like.test` default cap | PASS twice, 159 cases / 0 errors each | Diagnostic 16384-page comparison fails adjacent timing case `like-14.1`, not `like-14.2`. |
| browser | `savepoint6.test` | PASS, 8007 cases / 0 errors | Fixed by SharedFS open-unlink/rename-over lifetime handling. |
| browser | `sort4.test` | PASS, 11 cases / 0 errors | Browser threaded-sorter crash/stall fixed by `kad-wtb.9`. |
| node | `sort4.test` | FAIL, 11 cases / 5 errors | `kad-wtb.21`: Node temp database open failures in `sort4-2.3/2.4/2.5/2.6/2.8`. |

No SQLite test was skipped or xfailed as a substitute for runtime/platform work.

## Artifacts

- Node full snapshot: `test-runs/gastown-sqlite-node-full-pr5/`
- Browser full snapshot: `test-runs/gastown-sqlite-browser-full-pr5-snapshot/`
- Epic synthesis: `test-runs/gastown-sqlite-epic-synthesis/summary.md`
- Final hard counts: `test-runs/gastown-sqlite-epic-synthesis/final-hard-counts.md`
- LIKE focused artifacts: `test-runs/kad-wtb13-like-*`
- Fault/crash focused report: `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser-fault-recheck.md`

## Test Verification

Latest child branches recorded the full Kandelo gate suite before merge into
`integration/kad-wtb-sqlite-testing`: `cargo test -p kandelo --target
aarch64-apple-darwin --lib`, `cd host && npx vitest run`,
`scripts/run-libc-tests.sh`, `scripts/run-posix-tests.sh`, and
`scripts/dev-shell.sh bash scripts/check-abi-version.sh`.
