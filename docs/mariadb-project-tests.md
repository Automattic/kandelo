# MariaDB project test harness

This harness runs MariaDB's upstream `mysql-test/main/*.test` suite against
Kandelo on the supported Node and browser hosts and writes PR-friendly logs and
counts.

## Commands

Run the full MariaDB project suite on both hosts:

```bash
scripts/run-mariadb-project-tests.sh --host both --all --chunk-size 10 --timeout-ms 60000
```

Useful variants:

```bash
# Node host only, full suite, reset the Node process every 10 tests.
scripts/run-mariadb-project-tests.sh --host node --all --chunk-size 10 --timeout-ms 60000

# Browser host only, full suite, isolated/rebooting path.
LD_LIBRARY_PATH=/tmp/pwdeps/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} \
  scripts/run-mariadb-project-tests.sh --host browser --all --chunk-size 10 --timeout-ms 60000

# Browser host faster triage path. This still invokes every requested test, but
# disables post-failure browser reboots so later tests in a chunk can be affected
# by earlier destructive/timeouting tests. Use it for coverage/counts, not final
# isolation.
LD_LIBRARY_PATH=/tmp/pwdeps/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} \
  MARIADB_BROWSER_REBOOT_AFTER_FAIL=0 MARIADB_BROWSER_RUNNER_RETRIES=3 \
  scripts/run-mariadb-project-tests.sh --host browser --all --chunk-size 20 --timeout-ms 20000

# Single/smoke tests on either host.
scripts/run-mariadb-project-tests.sh --host node 1st
LD_LIBRARY_PATH=/tmp/pwdeps/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} \
  scripts/run-mariadb-project-tests.sh --host browser 1st
```

Logs and machine-readable counts are written under
`test-runs/mariadb-project/<UTC timestamp>/` by default, or to `--results-dir`.
Each run emits:

- `<host>.log` — complete underlying harness output.
- `<host>.exit` — host harness exit code.
- `summary.md` — markdown table for PR descriptions.
- `summary.json` — same counts for scripts.

For the Node host, the wrapper assigns a fresh `MARIADB_TEST_DATA_DIR` under the
results directory for each chunk (or for the single non-chunked run). The lower
level runner now propagates that directory into `MYSQLTEST_VARDIR` and
`MYSQLD_DATADIR`, so upstream tests do not share stale datadir/tmp state across
chunks.

Within a Node chunk, the lower-level runner keeps one MariaDB server for speed
but treats MariaDB OOM and `mysql.proc` system-table corruption as datadir
poisoning events. The failing test is still reported, then the runner
terminates all workers, removes the chunk datadir, runs bootstrap/setup again,
and continues with the next test from a clean system-table state. Browser runs
use the same classification to force a clean page/kernel reboot after those
failures instead of relying on a successful TCP probe.

For the browser host, the all-test VFS contains the full `mysql-test/main` file
set, `include/`, `std_data/`, and MariaDB `share/` files. The browser page runs
mysqltest with `MYSQLTEST_VARDIR=/data`, the server datadir under
`/data/master-data`, and recreates `/data/tmp` before each invocation because
upstream tests may create/drop a database named `tmp`.

## Prerequisites

Either fetch release binaries for the active ABI or build them locally:

```bash
bash build.sh
bash packages/registry/mariadb/build-mariadb.sh
bash images/vfs/scripts/build-mariadb-test-vfs-image.sh --all   # browser/full
npx playwright install chromium
```

On minimal Linux runners, Playwright also needs system browser libraries
(e.g. `libatk-1.0.so.0`). Install them with the platform package manager or
`npx playwright install-deps chromium` before running browser tests. In this
container, Chromium also needs:

```bash
export LD_LIBRARY_PATH=/tmp/pwdeps/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
```

## Historical PR #3 status (2026-06-05)

The following numbers came from the reference PR #3 branch and are preserved
only as adoption context. The `kad-qun.4` and `kad-qun.6` follow-up work must
reproduce or refresh them on the current Kandelo integration branch before they
are treated as current project status.

- Node full suite (`test-runs/mariadb-project/node-all-vardir-errmsg105-60s-c10`):
  raw classified-before-refresh counts were 544 PASS, 185 FAIL, 136 XFAIL,
  78 XPASS, 240 SKIP, 1183 TOTAL. The 185 remaining raw failures are now
  recorded as expected MariaDB build/MTR limitations, and the 78 stale XFAILs
  that passed are override-listed as expected passes. A classification smoke
  run exits 0: `1st aborted_clients alter_table_errors bad_frm_crash_5029
  ctype_gbk_export_import` => 2 PASS, 2 XFAIL.
- Browser smoke: `1st` passes. The current browser all-suite triage run (`test-runs/mariadb-project/browser-all-noreboot-20s-c20`) has completed the first 100/1183 tests at 20s timeout with 26 PASS, 48 FAIL, 26 SKIP. Failures are release-build debug variables, long-running tests, storage-engine/MTR expectation differences, missing external mysql client tools, grant-table limitations, and browser memory exhaustion after repeated transient mysqltest workers.
- Browser full all-suite triage is not green yet. The durable harness now invokes
  all 1183 tests, but the browser host currently exhausts Chromium/WebAssembly
  memory in larger chunks and intermittent boots can time out before setup SQL.
  Current triage runs use `MARIADB_BROWSER_REBOOT_AFTER_FAIL=0` plus chunking to
  keep collecting coverage while this host-resource blocker is isolated.
