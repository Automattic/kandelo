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
- `outcome-lists/<host>/passed-tests.tsv` — classified passing rows.
- `outcome-lists/<host>/failed-tests.tsv` — unexpected failure rows with the
  available stderr/error summary in the `detail` column.
- `outcome-lists/<host>/skipped-tests.tsv` — skipped rows with the available
  skip reason or stderr summary in the `detail` column.
- `outcome-lists/<host>/xfail-tests.tsv` — expected-failure rows with the
  available stderr/error summary in the `detail` column.
- `outcome-lists/<host>/xpass-tests.tsv` — expected-failure rows that
  unexpectedly passed.
- `summary.md` — markdown table for PR descriptions.
- `summary.json` — same counts for scripts, including absolute paths to the
  outcome-list artifacts.

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
The image also exposes compatibility paths used by upstream MTR fixtures:
`/std_data` and `/data/std_data` point at `/mysql-test/std_data`, and
`/mysql-test/suite` is present for tests in `main/` that source helper files
from another suite. The browser bootstrap seeds MariaDB's test time-zone rows
from `mysql_test_data_timezone.sql`, so named zones such as `MET`,
`Europe/Moscow`, and `UTC` are available without invoking external host tools.
Browser locale and LDML collation tests remain explicit expected limitations:
locale rows need generated server locale/message data, while LDML rows depend
on per-test `*-master.opt` server options that the current one-server browser
harness does not apply.

Both hosts bootstrap MariaDB with `mysql_system_tables.sql`,
`mysql_system_tables_data.sql`, and `mysql_test_db.sql`, matching
`mysql_install_db`'s default test-database grant baseline. Tests that create
temporary users can therefore connect to the default `test` database the same
way they do under the native MTR environment.

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

## Current Node full-suite status (2026-06-13)

The `kad-qun.4` Node full-suite artifact is
`test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/`. The primary run
covered chunks 1-119 with 60s per-test timeouts, but chunk 56 hit the known
zero-result harness path (`kad-lf9`): the MariaDB server selected an in-use TCP
port, the chunk reported `TOTAL: 0`, and the wrapper continued.

The literal primary wrapper counts are 596 PASS, 27 FAIL, 311 XFAIL, 0 XPASS,
239 SKIP, 1173 TOTAL, exit 1. Exact reruns on the current integration branch
refreshed the chunks affected by in-flight fixes and the zero-result chunk:

| Chunk | Reason | PASS | FAIL | XFAIL | XPASS | SKIP | TOTAL |
|-------|--------|------|------|-------|-------|------|-------|
| 54 | `lowercase_fs_on` current classification | 3 | 0 | 5 | 0 | 2 | 10 |
| 55 | `lowercase_table2` grant-table check | 5 | 1 | 1 | 0 | 3 | 10 |
| 56 | `kad-lf9` zero-result rerun | 5 | 0 | 4 | 0 | 1 | 10 |
| 92 | stored-procedure OOM isolation | 8 | 0 | 2 | 0 | 0 | 10 |
| 94 | `sp_stress_case` resource-envelope classification | 4 | 0 | 3 | 0 | 3 | 10 |

With those reruns substituted, the current Node status is 608 PASS, 17 FAIL,
318 XFAIL, 0 XPASS, 240 SKIP, 1183 TOTAL, exit 1. The unexpected failures are:
`check`, `count_distinct2`, `cte_recursive`, `derived_opt`, `huge_frm-6224`,
`lowercase_table2`, `mrr_icp_extra`, `precedence`, `range`, `range_aria_dbt3`,
`range_mrr_icp`, `selectivity`, `subselect_mat`, `subselect_sj`,
`subselect_sj_jcl6`, `subselect_sj_mat`, and `win_big-mdev-11697`. No XPASS
items were observed.

Root-cause direction: after `kad-qun.20`, the optimizer, range, subselect, and
window-function cluster is classified as a Node project timeout/resource-envelope
limitation rather than a distinct Kandelo runtime bug. The authoritative
artifact rows all end in the 60s mysqltest timeout or the 180s hard iteration
timeout (`range_aria_dbt3` and `range_mrr_icp`) without the OOM, worker trap, or
system-table corruption signatures used for separate runtime follow-ups. Future
60s Node project-suite runs classify these rows as XFAIL. `sp_stress_case` is
now classified as an expected wasm32 MariaDB resource-envelope failure: it OOMed
in the stored-procedure chunk with both 4 GB and 16 GB V8 old-space caps, and a
pre-test re-bootstrap still failed while dropping the generated 5000-branch
procedure. Clean-server isolated runs were not reliable enough to treat this as
a harness isolation fix. `lowercase_table2` is included in the hard artifact
counts above, but the follow-up grant bootstrap fix (`kad-qun.14`, commit
`4c39e727`) landed on the integration branch after those counts were recorded.
Do not change the hard totals unless a later rerun or focused replacement result
records the updated chunk 55 counts.

## Current browser full-suite status (2026-06-13)

The `kad-qun.6` browser full-suite artifact is
`test-runs/gastown-mariadb-browser-full-pr3/`, with `browser.log`,
`chunk-status.tsv`, `summary.md`, and `summary.json`. The run invoked all 1183
`mysql-test/main` tests with 60s per-test timeouts, chunk size 10, and
`MARIADB_BROWSER_RUNNER_RETRIES=3`; no broad browser-only skip list was added.

The equivalent wrapper invocation was:

```bash
LD_LIBRARY_PATH=/tmp/pwdeps/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} \
  MARIADB_BROWSER_RUNNER_RETRIES=3 \
  scripts/run-mariadb-project-tests.sh --host browser --all --chunk-size 10 --timeout-ms 60000
```

The hard browser artifact counts are 559 PASS, 371 FAIL, 0 XFAIL, 0 XPASS,
253 SKIP, 1183 TOTAL, exit 1, across 119 chunk result blocks. Chunks 1-49 came
from the existing checkpoint before the worker rebased. Chunks 50-119 were
resumed after rebasing to `origin/integration/kad-qun-mariadb-tests` at
`2cdc918b23c59d4d672b98de582b7512fdbc1c46`. The branch was later
fast-forwarded for handoff, and the current integration branch includes later
targeted fixes, but the full browser suite has not been rerun after those
post-artifact merges.

The browser FAIL count is therefore a full-suite coverage signal, not 371
independent SQL-result regressions. The current classified failure groups are:

| Group | Status | Tracking |
|-------|--------|----------|
| Timeout/page-death isolation and contaminated follow-on results | Open | `kad-qun.10` |
| Fetch-only/resolver artifact prerequisites for the browser wrapper | Open | `kad-qun.9` |
| `huge_frm-6224` mysqltest OOM causing kernel `unreachable` noise | Landed after artifact | `kad-qun.16`, commit `926225ac` |
| Tests that exec a missing or non-Wasm `mysql` client | Landed after artifact | `kad-qun.17`, commit `d2493661` |
| `selectivity` exhausting the test VFS image capacity | Landed after artifact | `kad-qun.18`, commit `811ba5e4` |
| Browser expected-fail classification for release-build, plugin/event-scheduler, unsupported helper, and SQL-result limitations | Classified after artifact | `kad-qun.23` |
| Browser VFS fixture/std_data/timezone gaps | Landed after artifact | `kad-qun.24`, commit `0dc2e081` |
| Browser VFS short-read/open-unlink storage-state failures | Landed after artifact | `kad-qun.25`, commit `50f5f51d` |
| Browser MyISAM/MERGE storage-state runtime defects | Landed/classified after artifact | `kad-qun.27`, commit `4e06ce12`; MERGE classification in `kad-qun.28`; FULLTEXT classification in `kad-qun.29` |

The longest resumed interval was chunk 116 at about 29m45s: the runner produced
zero JSON results on the first attempt, then saw repeated 180s
`waitForMariadbReady` timeouts before a later attempt recovered and emitted a
result block. That is tracked as harness/resource isolation work in
`kad-qun.10`. The artifact does not provide a separate numeric timeout or
resource-failure subtotal beyond the 371 FAIL count; the inventory below derives
the current follow-up cluster counts from the raw `FAIL` rows.

After `kad-qun.23`, `kad-qun.28`, and `kad-qun.29`, future browser wrapper runs
use an explicit XFAIL list for known MariaDB build/MTR limitations:
release/debug-only cases such as
`debug_dbug`/`SHOW CODE`, disabled event scheduler and dynamic plugin
expectations, unsupported native helper/client/shell commands, Aria-only
wasm expected-result differences, deterministic MERGE/MRG_MyISAM read-only
write-path behavior, and deterministic MyISAM FULLTEXT index corruption in the
wasm MariaDB storage-engine envelope. The list intentionally does not cover
browser timeout/page-death, fixture/VFS, or unclassified storage-state failures;
those remain unexpected until their separate follow-ups classify or fix them. The hard
`gastown-mariadb-browser-full-pr3` counts above remain unchanged until a
superseding browser full-suite rerun records new totals.

After `kad-qun.28`, `merge` and `merge_mmap` are classified as a narrow
MERGE/MRG_MyISAM limitation in the current wasm MTR envelope rather than a
SharedFS state-loss regression. A focused browser rerun with a rebuilt all-test
VFS used:

```bash
MARIADB_TEST_VITE_PORT=53234 \
  npx tsx scripts/browser-mariadb-test-runner.ts --json --timeout 90000 \
  merge merge_mmap
```

Both tests still failed with `ER_OPEN_AS_READONLY`: `merge.test` line 178 on
`t5`, and `merge_mmap.test` line 29 on `m2`. The runner diagnostics read back
the relevant `.MRG` files from `/data/master-data/test/`; `t5.MRG` contained
`t1`, `t2`, and `#INSERT_METHOD=FIRST`, while `t6.MRG`, `m1.MRG`, and `m2.MRG`
contained `t1`, `t2`, and `#INSERT_METHOD=LAST`. `/data/error.log` showed only
normal server startup with no VFS, short-read, or storage-engine error. The
MariaDB source path for this error is `ha_myisammrg::write_row()`, which returns
`HA_ERR_TABLE_READONLY` when the MERGE handler has no writable insert target,
even though the metadata file itself is present and intact. A local experiment
matching MTR's MyISAM default and enabling `--myisam-use-mmap` globally did not
change either failure. Future browser wrapper runs therefore XFAIL these two
tests explicitly; the hard full-suite counts above are unchanged until a rerun.

## Both-host synthesis for the epic PR

The project target is full `mysql-test/main` execution on both hosts with
expected MariaDB build, resource-envelope, and MTR-harness limitations
classified. This synthesis does not identify a separate excluded-suite or
external-tool epic that must block the PR. External-tool cases surfaced as
ordinary mysql-test harness/runtime classification work; the raw non-Wasm exec
failure is fixed by `kad-qun.17`, while any tests that require unsupported
native tools should remain explicit expected limitations.

Use the following hard numbers in the final epic status unless `kad-qun.19`
records a superseding rerun:

| Host | Artifact | PASS | FAIL | XFAIL | XPASS | SKIP | TOTAL | Exit |
|------|----------|------|------|-------|-------|------|-------|------|
| Node | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/` plus focused chunk reruns | 608 | 17 | 318 | 0 | 240 | 1183 | 1 |
| Browser | `test-runs/gastown-mariadb-browser-full-pr3/` | 559 | 371 | 0 | 0 | 253 | 1183 | 1 |

## Failure inventory for follow-up routing

This inventory preserves the hard counts above. It does not fold in any
post-artifact fix unless a later full-suite rerun replaces the authoritative
artifact.

Node has 17 unexpected failures after substituting the focused chunk reruns.
Each row below is one unexpected failure in the reconciled count:

| Host | Test | Outcome | Proof artifact | Why / current status | Follow-up |
|------|------|---------|----------------|----------------------|-----------|
| Node | `mysql-test/main/check.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:422` | Classified as a Node project-suite budget/resource XFAIL: the row reports a 60s mysqltest timeout in long-running table-check coverage, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/count_distinct2.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:573` | Classified as a Node project-suite budget/resource XFAIL: count-distinct optimizer coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/cte_recursive.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:775` | Classified as a Node project-suite budget/resource XFAIL: recursive CTE coverage exceeds the 60s budget in the artifact, despite being a historical expected-pass override. | `kad-qun.20` |
| Node | `mysql-test/main/derived_opt.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:1225` | Classified as a Node project-suite budget/resource XFAIL: derived-table optimizer coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/huge_frm-6224.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:2122` | Classified as a Node project-suite budget/resource XFAIL for the large `.frm` workload; browser OOM/kernel trap handling for the same test was fixed separately after artifact by `kad-qun.16`. | `kad-qun.20` |
| Node | `mysql-test/main/lowercase_table2.test` | FAIL | `test-runs/mariadb-project/kad-qun.4-node-current-reruns-20260613T1430Z/chunk-55/node.log:38` | Access denied for `mysqltest_1` to database `test`; fixed after artifact by the grant bootstrap work, but hard totals still include the failure until a rerun replaces them. | `kad-qun.14` |
| Node | `mysql-test/main/mrr_icp_extra.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:2960` | Classified as a Node project-suite budget/resource XFAIL: MRR/ICP optimizer coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/precedence.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:3936` | Classified as a Node project-suite budget/resource XFAIL: expression precedence coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/range.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4169` | Classified as a Node project-suite budget/resource XFAIL for the range optimizer cluster; focused higher-timeout reruns can promote it if it proves merely under-budgeted. | `kad-qun.20` |
| Node | `mysql-test/main/range_aria_dbt3.test` | harness hard timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4170` | Classified as a Node project-suite resource-envelope XFAIL: the iteration exceeded the 180s hard cap after restart overhead, not a recorded kernel trap. | `kad-qun.20` |
| Node | `mysql-test/main/range_mrr_icp.test` | harness hard timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4171` | Classified as a Node project-suite resource-envelope XFAIL: the iteration exceeded the 180s hard cap after restart overhead, not a recorded kernel trap. | `kad-qun.20` |
| Node | `mysql-test/main/selectivity.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4369` | Classified as a Node project-suite budget/resource XFAIL for the selectivity/index workload; browser ENOSPC for the same test was fixed after artifact by `kad-qun.18`. | `kad-qun.20` |
| Node | `mysql-test/main/subselect_mat.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5118` | Classified as a Node project-suite budget/resource XFAIL: subselect materialization coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/subselect_sj.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5227` | Classified as a Node project-suite budget/resource XFAIL: semijoin subselect coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/subselect_sj_jcl6.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5228` | Classified as a Node project-suite budget/resource XFAIL: semijoin/JCL6 coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/subselect_sj_mat.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5229` | Classified as a Node project-suite budget/resource XFAIL: semijoin materialization coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |
| Node | `mysql-test/main/win_big-mdev-11697.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5909` | Classified as a Node project-suite budget/resource XFAIL: large window-function coverage exceeds the 60s budget, with no runtime trap or OOM signature. | `kad-qun.20` |

Browser has 371 raw `FAIL` rows in
`test-runs/gastown-mariadb-browser-full-pr3/browser.log`. The browser artifact
does not contain expected-fail classifications, so this table accounts for the
371 rows by failure cluster instead of treating each row as an independent
runtime bug:

| Host | Tests / cluster | Count | Outcome | Proof artifact | Why / current status | Follow-up |
|------|-----------------|------:|---------|----------------|----------------------|-----------|
| Browser | `huge_frm-6224` | 1 | OOM/resource failure | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | `mysqltest` OOM produced kernel `unreachable` noise; fixed after artifact so future runs classify the OOM cleanly without contaminating follow-on tests. | `kad-qun.16` |
| Browser | `selectivity` | 1 | VFS ENOSPC/resource failure | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | `/data/master-data` ran out of space in the browser test image; fixed after artifact by increasing the MariaDB test VFS capacity and rebooting on ENOSPC. | `kad-qun.18` |
| Browser | Timeout, page death, and server readiness failures; representative tests: `alter_table`, `bootstrap_innodb`, `check`, `derived_opt`, `events_restart`, `xa`, plus page/server loss in `analyze_debug`, `assign_key_cache`, `bootstrap`, and readiness failures around chunk 116 | 45 | timeout / harness failure | `test-runs/gastown-mariadb-browser-full-pr3/browser.log`; `test-runs/gastown-mariadb-browser-full-pr3/chunk-status.tsv` | Primarily all-suite isolation/resource handling. Chunk 116 also spent 29m45s with repeated 180s readiness timeouts before recovery. Still open. | `kad-qun.10` |
| Browser | Stored-procedure OOM and `mysql.proc` corruption cluster: `sp-cursor`, `sp-destruct`, `sp-dynamic`, `sp-error`, `sp-expr`, `sp-fib`, `sp-for-loop`, `sp-group`, `sp-i_s_columns` | 9 | OOM/resource failure / contaminated state | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Same class as the Node SP chunk: OOM followed by corrupted procedure metadata. Harness isolation fixes landed after artifact; hard browser totals have not been rerun. | `kad-qun.15`, `kad-qun.21` |
| Browser | Grant/user/auth bootstrap failures; representative tests: `alter_user`, `cte_grant`, `grant*`, `set_password`, `shutdown`, `user_limits`, `userstat-badlogin-4824` | 51 | FAIL | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Access denied or user creation errors against the browser bootstrap grant baseline. The shared grant bootstrap fix landed after artifact; full browser totals have not been refreshed. | `kad-qun.14` |
| Browser | Release-build, debug-only, plugin/event-scheduler, unsupported native-helper, and expected-result limitations; representative tests: `alter_table_debug`, `connect_debug`, `events_*`, `plugin*`, `client`, `mysqldump*`, `mysqladmin`, `mysqlcheck`, `my_print_defaults`, `log_errchk`, `mysqlhotcopy_myisam` | 165 | FAIL / expected limitation or unsupported-scope candidate | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Browser artifact reports XFAIL=0, so these hard artifact rows stay counted as FAIL until a rerun. Future wrapper runs classify the known MariaDB build/MTR limitations explicitly. | `kad-qun.23` |
| Browser | VFS fixture, `std_data`, locale, timezone, and cross-suite include path gaps; representative tests: `default`, `func_math`, `function_defaults`, `loaddata`, `loadxml`, `timezone2`, `timezone_grant`, `xa_prepared_binlog_off` | 16 | FAIL / fixture-environment gap in artifact | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Missing `/std_data` paths, timezone/locale data, charset/collation data, or included files from other MariaDB suites in the artifact. Fixed/classified after artifact: targeted browser checks for `func_math`, `warnings`, `xa_prepared_binlog_off`, `timezone2`, `ctype_ldml`, and `default_session` now report 3 PASS, 2 XFAIL, 1 SKIP, 0 FAIL. | `kad-qun.24` |
| Browser | MyISAM FULLTEXT update/delete corruption: `fulltext`, `fulltext2`, `fulltext_update` | 3 | FAIL / expected wasm MariaDB storage-engine limitation | Focused `kad-qun.29` browser reruns: `MARIADB_TEST_VITE_PORT=53230 npx tsx scripts/browser-mariadb-test-runner.ts --json --timeout 90000 merge merge_mmap repair myisam_recover fulltext fulltext2`, plus isolated `fulltext`, `fulltext2`, and `fulltext3 fulltext_update fulltext_var` runs | Clean-browser reruns reproduce deterministic MyISAM FULLTEXT index corruption at update/delete statements: `fulltext` line 96, `fulltext2` line 99, and `fulltext_update` line 23. Adjacent `fulltext3` and `fulltext_var` pass. The Node wrapper already classifies the same family as Aria/MyISAM table-corruption limitations rather than a Kandelo browser VFS regression. | `kad-qun.29` |
| Browser | MERGE/MRG_MyISAM read-only write path: `merge`, `merge_mmap` | 2 | FAIL / expected MariaDB MERGE limitation | Focused rerun from `kad-qun.28`: `MARIADB_TEST_VITE_PORT=53234 npx tsx scripts/browser-mariadb-test-runner.ts --json --timeout 90000 merge merge_mmap` | Both tests fail with `ER_OPEN_AS_READONLY` at the first MERGE write. Focused diagnostics show intact `.MRG` files with child lists and `#INSERT_METHOD=FIRST/LAST`; server logs have no VFS/storage errors, and forcing MyISAM default plus `--myisam-use-mmap` did not change the result. Future wrapper runs classify these two rows as XFAIL. | `kad-qun.28` |
| Browser | VFS storage-state, short-read, file-descriptor, and corrupted-table cluster; representative tests: `ctype_big5`, `ctype_gbk`, `myisam_recover`, `partition_pruning`, `stat_tables`, `subselect`, `win`, `win_big-mdev-11697` | 53 | FAIL / platform or contaminated-state candidate in artifact | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Deterministic short-read/open-unlink and MyISAM recovery defects were fixed after artifact by `kad-qun.25` and `kad-qun.27`. Focused post-fix runs now pass the short-read set plus `repair` and `myisam_recover`; the remaining narrowed MERGE and FULLTEXT cases are split into the `kad-qun.28` and `kad-qun.29` rows above. | `kad-qun.25`, `kad-qun.27` |
| Browser | Remaining SQL/result mismatch triage; representative tests: `connect2`, `ctype_eucjpms`, `ctype_like_range`, `func_json`, `partition`, `subselect3`, `sum_distinct`, `symlink`, `upgrade_MDEV-23102-*` | 25 | FAIL / still unknown or expected-result candidate | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Mixed SQL-result and fixture side effects that did not fit the cleaner clusters. Future wrapper runs classify the known SQL-result limitations from `kad-qun.23`; split narrower beads if focused reruns still show platform bugs. | `kad-qun.23` |
| Browser | Cluster total | 371 | FAIL | `test-runs/gastown-mariadb-browser-full-pr3/summary.json` | Sum matches the hard browser FAIL count from `kad-qun.19`. | See rows above |

PR body replacement text:

```markdown
### MariaDB mysql-test/main final status

Full-suite artifacts now cover all 1183 upstream `mysql-test/main` tests on
both supported hosts. Node used
`scripts/run-mariadb-project-tests.sh --host node --all --chunk-size 10 --timeout-ms 60000`;
browser used
`LD_LIBRARY_PATH=/tmp/pwdeps/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} MARIADB_BROWSER_RUNNER_RETRIES=3 scripts/run-mariadb-project-tests.sh --host browser --all --chunk-size 10 --timeout-ms 60000`.

| Host | Artifact | PASS | FAIL | XFAIL | XPASS | SKIP | TOTAL | Exit |
|------|----------|------|------|-------|-------|------|-------|------|
| Node | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/` plus focused reruns for chunks 54/55/56/92/94 | 608 | 17 | 318 | 0 | 240 | 1183 | 1 |
| Browser | `test-runs/gastown-mariadb-browser-full-pr3/` | 559 | 371 | 0 | 0 | 253 | 1183 | 1 |

The Node artifact's raw primary-wrapper count of 596 PASS / 27 FAIL / 311
XFAIL / 0 XPASS / 239 SKIP / 1173 TOTAL is superseded by the reconciled total
above because chunk 56 hit the known zero-result harness path (`kad-lf9`) and
chunks 54, 55, 56, 92, and 94 have authoritative focused reruns. The browser
artifact already folds its pre-rebase chunks 1-49 and post-rebase resumed chunks
50-119 into one final total.

Post-artifact fixes already landed on the integration branch but are not folded
into these hard totals without a rerun: `kad-qun.14`, `kad-qun.16`,
`kad-qun.17`, `kad-qun.18`, browser expected-fail classification in
`kad-qun.23`, browser fixture coverage in `kad-qun.24`, browser short-read
storage fixes in `kad-qun.25`, browser MyISAM/MERGE storage fixes in
`kad-qun.27`, browser MERGE read-only classification in `kad-qun.28`, browser
MyISAM FULLTEXT classification in `kad-qun.29`, and Node
optimizer/range/subselect/window timeout classification in `kad-qun.20`.
`kad-qun.21` is folded in by the focused chunk 94 rerun above.
Remaining tracked follow-ups are `kad-lf9`, `kad-qun.9`, and `kad-qun.10`.
See `docs/mariadb-project-tests.md#failure-inventory-for-follow-up-routing`
for the row-level Node inventory and browser failure-cluster map.
```

Remaining actionable work is represented by narrow beads:

- `kad-lf9`: Node wrapper must fail loudly when a child harness run produces
  zero result rows.
- `kad-qun.9`: browser wrapper should run from resolver-fetched artifacts in a
  fetch-only worktree.
- `kad-qun.10`: browser all-suite runner needs stronger isolation after
  timeouts, page death, or contaminated MariaDB state.

The final GitHub PR should be opened by `kad-qun.8` from
`integration/kad-qun-mariadb-tests` to `main`. It should present the full-suite
coverage, the hard counts above, and the open follow-up beads, without directly
landing the integration branch.

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
- Browser smoke: `1st` passed. The historical browser all-suite triage run
  (`test-runs/mariadb-project/browser-all-noreboot-20s-c20`) completed the
  first 100/1183 tests at 20s timeout with 26 PASS, 48 FAIL, and 26 SKIP.
  Failures were release-build debug variables, long-running tests,
  storage-engine/MTR expectation differences, missing external mysql client
  tools, grant-table limitations, and browser memory exhaustion after repeated
  transient mysqltest workers.
- Browser full all-suite triage was not green in the reference snapshot. The
  durable harness already invoked all 1183 tests, but the browser host could
  exhaust Chromium/WebAssembly memory in larger chunks and intermittent boots
  could time out before setup SQL. Triage runs used
  `MARIADB_BROWSER_REBOOT_AFTER_FAIL=0` plus chunking to keep collecting
  coverage while this host-resource blocker was isolated.
