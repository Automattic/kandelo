# kd-immv Helper Input Verification

Date: 2026-06-30

Commands run:

- `git diff --check`: passed.
- `npx vitest run tests/package-system`: 3 files passed, 13 tests passed, 0 failed, 0 skipped.
- `bash scripts/dev-shell.sh cargo run -p xtask --target aarch64-apple-darwin --quiet -- build-deps parse <package>` for `pcre2-source`, `mariadb`, `node-vfs`, `spidermonkey`, `spidermonkey-node`, and `node`: passed.

Notes:

- Initial direct `cargo run -p xtask ...` attempts outside `scripts/dev-shell.sh` failed because the ambient host environment had no `clang` available for host linking. The same manifest parse checks passed inside the declared Kandelo dev shell.
- Full runtime, browser, ABI, libc, POSIX, and package build gates were not run because this change only records helper ownership/provenance, excludes helpers from identity discovery, updates package-system tests, and fixes a stale npm helper instruction. No output bytes or runtime behavior were changed.

Outcome lists:

- Passed: `test-runs/kd-immv-helper-inputs/passed.txt`
- Failed: `test-runs/kd-immv-helper-inputs/failed.txt`
- Skipped: `test-runs/kd-immv-helper-inputs/skipped.txt`
