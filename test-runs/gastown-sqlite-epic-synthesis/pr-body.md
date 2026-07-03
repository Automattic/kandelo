## Summary

Adopts the SQLite project-unit harness work from PR #5 into Kandelo and records
current both-host validation status against SQLite's official `full`
permutation.

This PR adds `scripts/run-sqlite-project-unit-tests.sh`, documents the harness in
the porting guide, disables accidental default browser syscall tracing for the
SQLite demo runner, and improves browser artifact snapshotting so partial
SQLite testrunner databases survive page reloads.

## Validation Status

Current completion target: SQLite official `full` permutation on both Node and
browser. The larger `all` permutation is tracked separately as `kad-29m`.

Node full run:

- Command: `/bin/bash scripts/dev-shell.sh /bin/bash scripts/run-sqlite-project-unit-tests.sh --host node --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-node-full-pr5`
- Result: did not complete.
- Snapshot: 1394 jobs total, 0 done, 0 failed, 1 running, 1393 ready, 0 cases.
- Blocker: `kad-36g`, Node scheduler/exec path feeds a Mach-O host executable to `WebAssembly.compile()` and leaves the SQLite scheduler wedged. Focused `fts5optimize2.test` reproductions pass, so that test name is not the root cause.

Browser full run:

- Command: `bash scripts/run-sqlite-project-unit-tests.sh --host browser --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-browser-full-pr5-snapshot`
- Result: exited after browser page navigation/reload while Playwright was waiting in `page.evaluate()`.
- Snapshot: 1393 jobs total, 58 done, 4 failed, 2 running, 1329 ready, 20066 cases, 1004 case errors.
- Blockers:
  - `kad-wtb.10`: browser runtime stability/page reload during `walfault`/`sort4`.
  - `kad-wtb.9`: focused browser `sort4.test` threaded sorter memory OOB or CPU-bound stall.
  - `kad-wtb.11`: browser fault/crash filesystem behavior in `sysfault`, `writecrash`, and likely `walfault`.
  - `kad-wtb.12`: browser `savepoint6` tempdb/savepoint state divergence.
  - `kad-wtb.13`: browser `like-14.2` string/collation/LIKE mismatch.

## Artifacts

- Node: `test-runs/gastown-sqlite-node-full-pr5/`
- Browser: `test-runs/gastown-sqlite-browser-full-pr5-snapshot/`
- Synthesis: `test-runs/gastown-sqlite-epic-synthesis/summary.md`

## Test Verification

Prior child branches recorded the full Kandelo gate suite against the harness and
browser changes:

- `cargo test -p kandelo --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

This PR intentionally preserves the remaining SQLite failures as actionable
blockers instead of skipping or xfail-ing upstream tests.
