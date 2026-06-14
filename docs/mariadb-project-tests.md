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

With those reruns substituted, the current Node status is 608 PASS, 18 FAIL,
317 XFAIL, 0 XPASS, 240 SKIP, 1183 TOTAL, exit 1. The unexpected failures are:
`check`, `count_distinct2`, `cte_recursive`, `derived_opt`, `huge_frm-6224`,
`lowercase_table2`, `mrr_icp_extra`, `precedence`, `range`, `range_aria_dbt3`,
`range_mrr_icp`, `selectivity`, `sp_stress_case`, `subselect_mat`,
`subselect_sj`, `subselect_sj_jcl6`, `subselect_sj_mat`, and
`win_big-mdev-11697`. No XPASS items were observed.

Root-cause direction: most unexpected failures are long-running optimizer,
range, subselect, or window-function tests timing out under the current 60s
Node budget; `range_aria_dbt3` and `range_mrr_icp` hit the harness hard timeout
after restart overhead. `sp_stress_case` still trips MariaDB OOM, but the
current harness re-bootstraps afterward so later stored-procedure tests no
longer cascade through `mysql.proc` corruption. `lowercase_table2` is included
in the hard artifact counts above, but the follow-up grant bootstrap fix
(`kad-qun.14`, commit `4c39e727`) landed on the integration branch after those
counts were recorded. Do not change the hard totals unless a later rerun or
focused replacement result records the updated chunk 55 counts.

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
| Browser expected-fail classification for release-build, MTR-helper, and SQL-result limitations | Open | `kad-qun.23` |
| Browser VFS fixture/std_data/timezone gaps | Open | `kad-qun.24` |
| Browser VFS storage-state, short-read, and corrupted-table failures | Open | `kad-qun.25` |

The longest resumed interval was chunk 116 at about 29m45s: the runner produced
zero JSON results on the first attempt, then saw repeated 180s
`waitForMariadbReady` timeouts before a later attempt recovered and emitted a
result block. That is tracked as harness/resource isolation work in
`kad-qun.10`. The artifact does not provide a separate numeric timeout or
resource-failure subtotal beyond the 371 FAIL count; the inventory below derives
the current follow-up cluster counts from the raw `FAIL` rows.

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
| Node | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/` plus focused chunk reruns | 608 | 18 | 317 | 0 | 240 | 1183 | 1 |
| Browser | `test-runs/gastown-mariadb-browser-full-pr3/` | 559 | 371 | 0 | 0 | 253 | 1183 | 1 |

## Failure inventory for follow-up routing

This inventory preserves the hard counts above. It does not fold in any
post-artifact fix unless a later full-suite rerun replaces the authoritative
artifact.

Node has 18 unexpected failures after substituting the focused chunk reruns.
Each row below is one unexpected failure in the reconciled count:

| Host | Test | Outcome | Proof artifact | Why / current status | Follow-up |
|------|------|---------|----------------|----------------------|-----------|
| Node | `mysql-test/main/check.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:422` | 60s per-test timeout in a long-running main-suite check test; still needs timeout/resource-envelope vs runtime-bug classification. | `kad-qun.20` |
| Node | `mysql-test/main/count_distinct2.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:573` | 60s timeout in count-distinct optimizer coverage; classify timeout budget, MariaDB expectation, or runtime behavior. | `kad-qun.20` |
| Node | `mysql-test/main/cte_recursive.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:775` | 60s timeout in recursive CTE coverage; classify timeout/resource envelope vs runtime bug. | `kad-qun.20` |
| Node | `mysql-test/main/derived_opt.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:1225` | 60s timeout in derived-table optimizer coverage. | `kad-qun.20` |
| Node | `mysql-test/main/huge_frm-6224.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:2122` | 60s timeout in large `.frm` workload on Node; browser OOM/kernel trap for the same test was fixed separately after artifact by `kad-qun.16`. | `kad-qun.20` |
| Node | `mysql-test/main/lowercase_table2.test` | FAIL | `test-runs/mariadb-project/kad-qun.4-node-current-reruns-20260613T1430Z/chunk-55/node.log:38` | Access denied for `mysqltest_1` to database `test`; fixed after artifact by the grant bootstrap work, but hard totals still include the failure until a rerun replaces them. | `kad-qun.14` |
| Node | `mysql-test/main/mrr_icp_extra.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:2960` | 60s timeout in MRR/ICP optimizer coverage. | `kad-qun.20` |
| Node | `mysql-test/main/precedence.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:3936` | 60s timeout in expression precedence coverage. | `kad-qun.20` |
| Node | `mysql-test/main/range.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4169` | Timed out after 60s; part of the range optimizer cluster. | `kad-qun.20` |
| Node | `mysql-test/main/range_aria_dbt3.test` | harness hard timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4170` | Hit the 180s hard iteration timeout after restart overhead; still open as range/resource-envelope classification. | `kad-qun.20` |
| Node | `mysql-test/main/range_mrr_icp.test` | harness hard timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4171` | Hit the 180s hard iteration timeout after restart overhead; still open as range/resource-envelope classification. | `kad-qun.20` |
| Node | `mysql-test/main/selectivity.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4369` | 60s timeout in selectivity/index workload; browser ENOSPC for the same test was fixed after artifact by `kad-qun.18`. | `kad-qun.20` |
| Node | `mysql-test/main/sp_stress_case.test` | OOM/resource failure | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:4818` | MariaDB reports repeated out-of-memory errors under the current Node/Wasm memory envelope; downstream SP corruption is fixed, but this test still needs focused memory classification. | `kad-qun.21` |
| Node | `mysql-test/main/subselect_mat.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5118` | 60s timeout in subselect materialization coverage. | `kad-qun.20` |
| Node | `mysql-test/main/subselect_sj.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5227` | 60s timeout in semijoin subselect coverage. | `kad-qun.20` |
| Node | `mysql-test/main/subselect_sj_jcl6.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5228` | 60s timeout in semijoin/JCL6 subselect coverage. | `kad-qun.20` |
| Node | `mysql-test/main/subselect_sj_mat.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5229` | 60s timeout in semijoin materialization coverage. | `kad-qun.20` |
| Node | `mysql-test/main/win_big-mdev-11697.test` | timeout | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/node.log:5909` | 60s timeout in window-function coverage. | `kad-qun.20` |

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
| Browser | Stored-procedure OOM and `mysql.proc` corruption cluster: `sp-cursor`, `sp-destruct`, `sp-dynamic`, `sp-error`, `sp-expr`, `sp-fib`, `sp-for-loop`, `sp-group`, `sp-i_s_columns` | 9 | OOM/resource failure / contaminated state | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Same class as the Node SP chunk: OOM followed by corrupted procedure metadata. Harness isolation fix landed after artifact; hard browser totals have not been rerun. | `kad-qun.15`; residual Node memory envelope is `kad-qun.21` |
| Browser | Grant/user/auth bootstrap failures; representative tests: `alter_user`, `cte_grant`, `grant*`, `set_password`, `shutdown`, `user_limits`, `userstat-badlogin-4824` | 51 | FAIL | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Access denied or user creation errors against the browser bootstrap grant baseline. The shared grant bootstrap fix landed after artifact; full browser totals have not been refreshed. | `kad-qun.14` |
| Browser | Release-build, debug-only, plugin/event-scheduler, unsupported native-helper, and expected-result limitations; representative tests: `alter_table_debug`, `connect_debug`, `events_*`, `plugin*`, `client`, `mysqldump*`, `mysqladmin`, `mysqlcheck`, `my_print_defaults`, `log_errchk`, `mysqlhotcopy_myisam` | 165 | FAIL / expected limitation or unsupported-scope candidate | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Browser artifact reports XFAIL=0, so these known MariaDB build/MTR limitations are still undifferentiated FAIL rows. They need explicit expected-fail or unsupported-scope classification. | `kad-qun.23` |
| Browser | VFS fixture, `std_data`, locale, timezone, and cross-suite include path gaps; representative tests: `default`, `func_math`, `function_defaults`, `loaddata`, `loadxml`, `timezone2`, `timezone_grant`, `xa_prepared_binlog_off` | 16 | FAIL / fixture-environment gap | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Missing `/std_data` paths, timezone/locale data, charset/collation data, or included files from other MariaDB suites. Needs VFS fixture fix or expected fixture limitation. | `kad-qun.24` |
| Browser | VFS storage-state, short-read, read-only, file-descriptor, and corrupted-table cluster; representative tests: `ctype_big5`, `ctype_gbk`, `fulltext`, `merge`, `myisam_recover`, `partition_pruning`, `stat_tables`, `subselect`, `win`, `win_big-mdev-11697` | 58 | FAIL / platform or contaminated-state candidate | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Recurrent `Unexpected end-of-file`, `File too short`, read-only table, corrupt index/table, missing temp file, I/O, and file-descriptor failures. Some may be follow-on contamination from `kad-qun.10`; deterministic cases need VFS/runtime investigation. | `kad-qun.25` |
| Browser | Remaining SQL/result mismatch triage; representative tests: `connect2`, `ctype_eucjpms`, `ctype_like_range`, `func_json`, `partition`, `subselect3`, `sum_distinct`, `symlink`, `upgrade_MDEV-23102-*` | 25 | FAIL / still unknown or expected-result candidate | `test-runs/gastown-mariadb-browser-full-pr3/browser.log` | Mixed SQL-result and fixture side effects that did not fit the cleaner clusters. Route with the browser expected-fail classification work first, then split narrower beads if focused reruns show platform bugs. | `kad-qun.23` |
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
| Node | `test-runs/mariadb-project/kad-qun.4-node-20260613T112749Z/` plus focused reruns for chunks 54/55/56/92 | 608 | 18 | 317 | 0 | 240 | 1183 | 1 |
| Browser | `test-runs/gastown-mariadb-browser-full-pr3/` | 559 | 371 | 0 | 0 | 253 | 1183 | 1 |

The Node artifact's raw primary-wrapper count of 596 PASS / 27 FAIL / 311
XFAIL / 0 XPASS / 239 SKIP / 1173 TOTAL is superseded by the reconciled total
above because chunk 56 hit the known zero-result harness path (`kad-lf9`) and
chunks 54, 55, 56, and 92 have authoritative focused reruns. The browser
artifact already folds its pre-rebase chunks 1-49 and post-rebase resumed chunks
50-119 into one final total.

Post-artifact fixes already landed on the integration branch but are not folded
into these hard totals without a rerun: `kad-qun.14`, `kad-qun.16`,
`kad-qun.17`, and `kad-qun.18`. Remaining tracked follow-ups are `kad-lf9`,
`kad-qun.9`, `kad-qun.10`, `kad-qun.20`, `kad-qun.21`, `kad-qun.23`,
`kad-qun.24`, and `kad-qun.25`. See
`docs/mariadb-project-tests.md#failure-inventory-for-follow-up-routing` for the
row-level Node inventory and browser failure-cluster map.
```

Remaining actionable work is represented by narrow beads:

- `kad-lf9`: Node wrapper must fail loudly when a child harness run produces
  zero result rows.
- `kad-qun.9`: browser wrapper should run from resolver-fetched artifacts in a
  fetch-only worktree.
- `kad-qun.10`: browser all-suite runner needs stronger isolation after
  timeouts, page death, or contaminated MariaDB state.
- `kad-qun.20`: Node optimizer/range/subselect/window failures need root-cause
  classification or timeout/resource-envelope treatment.
- `kad-qun.21`: Node `sp_stress_case` still needs isolated memory-envelope
  classification after the mysql.proc recovery fix.
- `kad-qun.23`: browser MariaDB expected-fail classifications need to cover
  release-build, plugin/event-scheduler, unsupported helper, and SQL-result
  limitations that currently appear as raw FAIL rows.
- `kad-qun.24`: browser VFS fixture coverage needs std_data, timezone, locale,
  charset, and cross-suite include path gaps fixed or classified.
- `kad-qun.25`: browser VFS/storage-state short reads, read-only tables, file
  descriptor/resource errors, and corrupted table/index rows need focused
  reproduction and classification.

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
