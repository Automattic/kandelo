# Ordinary-runtime before/after comparison — November 14, 2026

The full canonical comparison completed, with adverse results retained. In both
orders the candidate has lower Node stdin throughput, higher Node exec time and
a higher dense file-replacement locking cost. Two Chromium database metrics
also exceed a descriptive five-percent threshold in both orders. This does
**not** establish performance neutrality. It compares ordinary, unvirtualized
Wasm execution in the whole frozen candidate with pinned main; it is not a
measurement of translated PHP-FPM, shared OPcache request latency, or machine-native
code.

## Inputs and method

Baseline: unchanged `origin/main` at
`f8612113e7bd52a5ce31011d556d7ce1519424be`. Candidate: checkout HEAD
`6d5ebb19b24572480edebd5dc355dfca36ae63c6` plus the recorded uncommitted source
snapshot. Preserved unrelated changes are included, so individual feature
attribution is not established. Each side used its own normal SDK, kernel,
programs and images. Both normal source-bootstrap graphs passed. The ten fresh
benchmark guests were built with the same canonical `-O2` flags, normal fork
preparation and exact-output ABI stamping, and are byte-identical between
checkouts. Application executables, images, kernels and host bundles have
recorded differences; their results cannot isolate host changes alone.

All nine enabled suites ran on both Node and Chromium: syscall I/O, stdin,
process lifecycle, spawn scratch, WordPress, and MariaDB Aria/InnoDB in both
32-bit and 64-bit configurations. The canonical harness disables Erlang ring;
that policy was retained. The hosts expose different metrics: 48 on Node and
43 on Chromium. All enabled metrics are shown below.

Environment: Apple M5 Max, 18 logical CPUs, 48 GiB memory, macOS 27.2.1 arm64,
Node 24.15.0, and Playwright's Google Chrome for Testing 153.0.8010.12. This is
an automated Chromium run, not native Safari or the separate Firefox/WebKit
prototype mechanism screens.

There are eight fresh CLI parents: main/candidate on Node, main/candidate on
Chromium, candidate/main on Node, then candidate/main on Chromium. Each CLI
aggregates three rounds per suite. Those rounds share a parent; they are not
six independent parent launches. The first complete Node pair is retained from
attempt 4 after exact canonical file/directory identity checks; continuation 5
runs the six remaining parents. Original timestamps, load and artifact records
are retained. Reuse was selected for complete coverage and unchanged inputs;
a few raw values were visible in progress-log tails, but no comparative timing
report was screened to select runs.

The observed load averages are recorded for every parent. No other managed
build or test appeared in the pre-run job inventories; existing preview/proxy
servers remained running. This is not proof of whole-machine idleness. No
confidence interval or in-cohort timer-resolution record supports small-delta
claims. The five-percent flags below are descriptive, not significance tests.

## Adverse comparisons to retain

Each cell labels the main and candidate aggregates and places each number on
its own line. Throughput favors larger values; duration favors smaller values.

| Metric | Main then candidate | Candidate then main |
|---|---|---|
| node: `syscall-io/lock_dense_file_replace_us_per_op` | Main: **24.62 µs/op**<br>Candidate: **26.24 µs/op**<br>Raw change: **+6.58%** | Main: **24.32 µs/op**<br>Candidate: **26.96 µs/op**<br>Raw change: **+10.86%** |
| node: `stdin-throughput/stdin_mbps` | Main: **856.9 MB/s**<br>Candidate: **799.44 MB/s**<br>Raw change: **-6.71%** | Main: **862.72 MB/s**<br>Candidate: **799.6 MB/s**<br>Raw change: **-7.32%** |
| node: `process-lifecycle/exec_ms` | Main: **3381.09 ms**<br>Candidate: **3630.96 ms**<br>Raw change: **+7.39%** | Main: **3357.43 ms**<br>Candidate: **3578.63 ms**<br>Raw change: **+6.59%** |
| browser: `mariadb-aria-64/query_join_ms` | Main: **1.68 ms**<br>Candidate: **1.78 ms**<br>Raw change: **+5.95%** | Main: **1.79 ms**<br>Candidate: **2.97 ms**<br>Raw change: **+65.92%** |
| browser: `mariadb-innodb/query_create_ms` | Main: **25.2 ms**<br>Candidate: **26.81 ms**<br>Raw change: **+6.39%** | Main: **22.77 ms**<br>Candidate: **25.43 ms**<br>Raw change: **+11.68%** |

The Chromium Aria join flag includes a small absolute duration: the second pair
moves from 1.79 ms to 2.97 ms. Retain it, but do not infer a general database or
translation slowdown from that percentage alone. No metric has a greater-than-
five-percent improvement in both orders. The remaining metrics are mixed,
smaller, or order-sensitive; that does not prove equivalence.

Node hello startup also rises in both orders: **+4.36%** and **+8.36%**. It
falls outside the summary flag only because the first delta is below the
descriptive threshold; it remains a startup regression lead.

The ordinary WordPress Node first-response change reverses with order:
**+11.48%** then **−6.07%**. CLI require changes are **−0.50%** and **−0.89%**.
Chromium WordPress boot changes are **+0.01%** and **+0.04%**, and first-response
changes are **−0.25%** and **+0.74%**. These observations do not establish an
application improvement or prove absence of regression. They do not supply the
missing current-format translated PHP-FPM measurement.

Treat the Node stdin, exec and locking results as unresolved regression leads
before broader distribution. Additional cause-specific profiling is separate
work. The current local prototype remains opt-in, and the
[stop-check instruction measurements](2026-11-14-common-memory-stop-overhead.md)
retain substantial translation/poll costs on some operations and engines.

## Artifact and failed-attempt accounting

The post-run canonical inventory exactly matches every selected file and
source-directory fingerprint in all eight results. The baseline tracked tree
is clean. All 334 recorded current-profile source hashes match both the root
checkout and prepared candidate; all profile artifact hashes match. The
workspace's previously selected ordinary kernel is unchanged.

Thirty distinct selected standalone Wasm files were inspected. Four lack the
program ABI-contract custom section: the 64-bit MariaDB server and `mysqltest`
client in each checkout. The existing version-based admission path emits
warnings; no unknown executable was restamped to silence them. The inventory
does not inspect every executable embedded in an image or attribute each log
warning to a specific launch. This bounds the ABI evidence for those ordinary
benchmarks, separately from the fresh stamped experimental PHP artifact.

All interrupted attempts remain retained: missing MariaDB transitive artifacts;
missing browser rootfs; an intentionally stopped legacy-rootfs preparation with
different dependency hashes; and Vite rejecting a SourceOnly-cache symlink
outside its permitted program-cache root. The final preparation reused the
canonical benchmark materializer to create a regular `host/wasm/rootfs.vfs.zst`
from verified resolver-selected bytes, with exact equality to the frozen
SourceOnly projection. Vite access checks, source snapshots and published
projections were unchanged. These are fixture-preparation changes, not measured
runtime fixes. The original continuation policy overstated timing blindness;
its archive and the explicit correction remain retained.

## Reproduction and retained records

The retained comparison directory is
`.context/common-memory-default-regression-20261114/`: original result JSON,
logs, both input inventories, four canonical `benchmarks/compare.ts` reports,
all-values table, strict analysis, ABI inventory, environment, source/profile
hash audit, live-preview identity check and archive manifest. Failed attempts
are retained separately in `.context/common-memory-benchmark-attempts-20261114/`.

Normal benchmark commands, run separately in each provisioned checkout:

```sh
scripts/dev-shell.sh node_modules/.bin/tsx benchmarks/run.ts --host=node --rounds=3
scripts/dev-shell.sh node_modules/.bin/tsx benchmarks/run.ts --host=browser --rounds=3
scripts/dev-shell.sh node_modules/.bin/tsx benchmarks/compare.ts BEFORE.json AFTER.json
```

The archive includes the exact private preparation, continuation and analysis
scripts. Restore their recorded relative layout to reanalyze the saved inputs;
select a fresh output directory for analysis. To remeasure, prepare each
checkout's own normal build and artifacts, use a fresh campaign directory and
record new identities. The saved campaign driver refuses existing output and
must not overwrite historical measurements. The rootfs materializer also
refuses an existing destination. New measurements are a new campaign.

## Complete canonical metric values

### Node

| Metric | Pair 1 | Pair 2 |
|---|---|---|
| `syscall-io/pipe_mbps` (higher better) | Main: **63.16**<br>Candidate: **62.12**<br>Change: **-1.65%** | Main: **62.64**<br>Candidate: **61.15**<br>Change: **-2.38%** |
| `syscall-io/file_write_mbps` (higher better) | Main: **87.06**<br>Candidate: **85.93**<br>Change: **-1.30%** | Main: **87.94**<br>Candidate: **83.22**<br>Change: **-5.37%** |
| `syscall-io/file_read_mbps` (higher better) | Main: **124.3**<br>Candidate: **125.91**<br>Change: **+1.30%** | Main: **127.49**<br>Candidate: **122.44**<br>Change: **-3.96%** |
| `syscall-io/lock_many_files_acquire_us_per_op` (lower better) | Main: **28.24**<br>Candidate: **28.79**<br>Change: **+1.95%** | Main: **29.96**<br>Candidate: **31.12**<br>Change: **+3.87%** |
| `syscall-io/lock_many_files_conflict_us_per_op` (lower better) | Main: **24.28**<br>Candidate: **24.21**<br>Change: **-0.29%** | Main: **24.18**<br>Candidate: **24.84**<br>Change: **+2.73%** |
| `syscall-io/lock_many_files_replace_us_per_op` (lower better) | Main: **28.39**<br>Candidate: **28.94**<br>Change: **+1.94%** | Main: **27.74**<br>Candidate: **28.58**<br>Change: **+3.03%** |
| `syscall-io/lock_many_files_unlock_us_per_op` (lower better) | Main: **22.8**<br>Candidate: **23.75**<br>Change: **+4.17%** | Main: **22.86**<br>Candidate: **24.56**<br>Change: **+7.44%** |
| `syscall-io/lock_dense_file_acquire_us_per_op` (lower better) | Main: **23.09**<br>Candidate: **23.63**<br>Change: **+2.34%** | Main: **23.24**<br>Candidate: **24.16**<br>Change: **+3.96%** |
| `syscall-io/lock_dense_file_conflict_us_per_op` (lower better) | Main: **26.91**<br>Candidate: **26.63**<br>Change: **-1.04%** | Main: **27.05**<br>Candidate: **23.7**<br>Change: **-12.38%** |
| `syscall-io/lock_dense_file_replace_us_per_op` (lower better) | Main: **24.62**<br>Candidate: **26.24**<br>Change: **+6.58%** | Main: **24.32**<br>Candidate: **26.96**<br>Change: **+10.86%** |
| `syscall-io/lock_dense_file_unlock_us_per_op` (lower better) | Main: **23.3**<br>Candidate: **23.42**<br>Change: **+0.52%** | Main: **23.37**<br>Candidate: **23.37**<br>Change: **+0.00%** |
| `syscall-io/syscall_latency_us` (lower better) | Main: **24.47**<br>Candidate: **24.64**<br>Change: **+0.69%** | Main: **24.59**<br>Candidate: **25.4**<br>Change: **+3.29%** |
| `syscall-io/poll_ready_us_per_op` (lower better) | Main: **25.33**<br>Candidate: **25.59**<br>Change: **+1.03%** | Main: **25.37**<br>Candidate: **26.02**<br>Change: **+2.56%** |
| `syscall-io/poll_timeout_us_per_op` (lower better) | Main: **1434.22**<br>Candidate: **1425.74**<br>Change: **-0.59%** | Main: **1430.37**<br>Candidate: **1433.68**<br>Change: **+0.23%** |
| `syscall-io/select_timeout_us_per_op` (lower better) | Main: **1510.76**<br>Candidate: **1509.71**<br>Change: **-0.07%** | Main: **1507.92**<br>Candidate: **1503.85**<br>Change: **-0.27%** |
| `syscall-io/epoll_ready_us_per_op` (lower better) | Main: **36.1**<br>Candidate: **35.5**<br>Change: **-1.66%** | Main: **37.47**<br>Candidate: **25.98**<br>Change: **-30.66%** |
| `stdin-throughput/stdin_mbps` (higher better) | Main: **856.9**<br>Candidate: **799.44**<br>Change: **-6.71%** | Main: **862.72**<br>Candidate: **799.6**<br>Change: **-7.32%** |
| `process-lifecycle/hello_start_ms` (lower better) | Main: **3390.3**<br>Candidate: **3538.08**<br>Change: **+4.36%** | Main: **3277.93**<br>Candidate: **3552.07**<br>Change: **+8.36%** |
| `process-lifecycle/fork_ms` (lower better) | Main: **84.89**<br>Candidate: **84.69**<br>Change: **-0.24%** | Main: **84.66**<br>Candidate: **82.02**<br>Change: **-3.12%** |
| `process-lifecycle/exec_ms` (lower better) | Main: **3381.09**<br>Candidate: **3630.96**<br>Change: **+7.39%** | Main: **3357.43**<br>Candidate: **3578.63**<br>Change: **+6.59%** |
| `process-lifecycle/clone_ms` (lower better) | Main: **69.53**<br>Candidate: **69.85**<br>Change: **+0.46%** | Main: **69.27**<br>Candidate: **69.19**<br>Change: **-0.12%** |
| `spawn-scratch/spawn_ms` (lower better) | Main: **75.95**<br>Candidate: **74.08**<br>Change: **-2.46%** | Main: **76.01**<br>Candidate: **74.6**<br>Change: **-1.86%** |
| `spawn-scratch/spawn_large_wire_bytes` (lower better) | Main: **84386**<br>Candidate: **84386**<br>Change: **+0.00%** | Main: **84386**<br>Candidate: **84386**<br>Change: **+0.00%** |
| `spawn-scratch/spawn_large_first_ms` (lower better) | Main: **68.85**<br>Candidate: **69.06**<br>Change: **+0.31%** | Main: **68.39**<br>Candidate: **69.56**<br>Change: **+1.71%** |
| `spawn-scratch/spawn_large_repeat_ms` (lower better) | Main: **67.99**<br>Candidate: **65.92**<br>Change: **-3.04%** | Main: **67.72**<br>Candidate: **67.05**<br>Change: **-0.99%** |
| `spawn-scratch/spawn_scratch_kernel_bytes` (lower better) | Main: **1.04858e+07**<br>Candidate: **1.04858e+07**<br>Change: **+0.00%** | Main: **1.04858e+07**<br>Candidate: **1.04858e+07**<br>Change: **+0.00%** |
| `wordpress/cli_require_ms` (lower better) | Main: **448.61**<br>Candidate: **446.38**<br>Change: **-0.50%** | Main: **445.38**<br>Candidate: **441.42**<br>Change: **-0.89%** |
| `wordpress/http_first_response_ms` (lower better) | Main: **1652.56**<br>Candidate: **1842.23**<br>Change: **+11.48%** | Main: **2735.64**<br>Candidate: **2569.61**<br>Change: **-6.07%** |
| `mariadb-aria/bootstrap_ms` (lower better) | Main: **2177.3**<br>Candidate: **2173.62**<br>Change: **-0.17%** | Main: **2167.15**<br>Candidate: **2134.9**<br>Change: **-1.49%** |
| `mariadb-aria/query_create_ms` (lower better) | Main: **227.84**<br>Candidate: **230.24**<br>Change: **+1.05%** | Main: **224.24**<br>Candidate: **224.26**<br>Change: **+0.01%** |
| `mariadb-aria/query_insert_ms` (lower better) | Main: **998.04**<br>Candidate: **1006.96**<br>Change: **+0.89%** | Main: **1011.29**<br>Candidate: **1014.4**<br>Change: **+0.31%** |
| `mariadb-aria/query_select_ms` (lower better) | Main: **131.88**<br>Candidate: **131.69**<br>Change: **-0.14%** | Main: **132.45**<br>Candidate: **136.04**<br>Change: **+2.71%** |
| `mariadb-aria/query_join_ms` (lower better) | Main: **90.58**<br>Candidate: **90.08**<br>Change: **-0.55%** | Main: **89.83**<br>Candidate: **90.19**<br>Change: **+0.40%** |
| `mariadb-aria-64/bootstrap_ms` (lower better) | Main: **2309.16**<br>Candidate: **2317.24**<br>Change: **+0.35%** | Main: **2288.33**<br>Candidate: **2308.29**<br>Change: **+0.87%** |
| `mariadb-aria-64/query_create_ms` (lower better) | Main: **225.52**<br>Candidate: **224.21**<br>Change: **-0.58%** | Main: **227.17**<br>Candidate: **226.15**<br>Change: **-0.45%** |
| `mariadb-aria-64/query_insert_ms` (lower better) | Main: **1066.11**<br>Candidate: **1064.74**<br>Change: **-0.13%** | Main: **1070.57**<br>Candidate: **1088.3**<br>Change: **+1.66%** |
| `mariadb-aria-64/query_select_ms` (lower better) | Main: **121.38**<br>Candidate: **121.81**<br>Change: **+0.35%** | Main: **120.67**<br>Candidate: **118.51**<br>Change: **-1.79%** |
| `mariadb-aria-64/query_join_ms` (lower better) | Main: **90.06**<br>Candidate: **89.99**<br>Change: **-0.08%** | Main: **90.19**<br>Candidate: **87.9**<br>Change: **-2.54%** |
| `mariadb-innodb/bootstrap_ms` (lower better) | Main: **2024.03**<br>Candidate: **2044.44**<br>Change: **+1.01%** | Main: **2036.97**<br>Candidate: **2033.98**<br>Change: **-0.15%** |
| `mariadb-innodb/query_create_ms` (lower better) | Main: **228.37**<br>Candidate: **231.32**<br>Change: **+1.29%** | Main: **227.67**<br>Candidate: **229.05**<br>Change: **+0.61%** |
| `mariadb-innodb/query_insert_ms` (lower better) | Main: **255.04**<br>Candidate: **262.68**<br>Change: **+3.00%** | Main: **260.83**<br>Candidate: **258.85**<br>Change: **-0.76%** |
| `mariadb-innodb/query_select_ms` (lower better) | Main: **97.7**<br>Candidate: **94.94**<br>Change: **-2.82%** | Main: **96.96**<br>Candidate: **96.99**<br>Change: **+0.03%** |
| `mariadb-innodb/query_join_ms` (lower better) | Main: **88.9**<br>Candidate: **89.04**<br>Change: **+0.16%** | Main: **88.51**<br>Candidate: **85.54**<br>Change: **-3.36%** |
| `mariadb-innodb-64/bootstrap_ms` (lower better) | Main: **2136.51**<br>Candidate: **2212.54**<br>Change: **+3.56%** | Main: **2157.25**<br>Candidate: **2184.23**<br>Change: **+1.25%** |
| `mariadb-innodb-64/query_create_ms` (lower better) | Main: **231.68**<br>Candidate: **227.32**<br>Change: **-1.88%** | Main: **229.7**<br>Candidate: **234.57**<br>Change: **+2.12%** |
| `mariadb-innodb-64/query_insert_ms` (lower better) | Main: **265.08**<br>Candidate: **271.22**<br>Change: **+2.32%** | Main: **265.22**<br>Candidate: **263.6**<br>Change: **-0.61%** |
| `mariadb-innodb-64/query_select_ms` (lower better) | Main: **95.16**<br>Candidate: **95.2**<br>Change: **+0.04%** | Main: **97.52**<br>Candidate: **95.94**<br>Change: **-1.62%** |
| `mariadb-innodb-64/query_join_ms` (lower better) | Main: **88.71**<br>Candidate: **91.98**<br>Change: **+3.69%** | Main: **89.61**<br>Candidate: **86.08**<br>Change: **-3.94%** |

### Chromium

| Metric | Pair 1 | Pair 2 |
|---|---|---|
| `syscall-io/pipe_mbps` (higher better) | Main: **54.19**<br>Candidate: **58.53**<br>Change: **+8.01%** | Main: **56.23**<br>Candidate: **58.24**<br>Change: **+3.57%** |
| `syscall-io/file_write_mbps` (higher better) | Main: **82.52**<br>Candidate: **80.55**<br>Change: **-2.39%** | Main: **82.99**<br>Candidate: **83.02**<br>Change: **+0.04%** |
| `syscall-io/file_read_mbps` (higher better) | Main: **112.3**<br>Candidate: **111.42**<br>Change: **-0.78%** | Main: **113.7**<br>Candidate: **108.64**<br>Change: **-4.45%** |
| `syscall-io/lock_many_files_acquire_us_per_op` (lower better) | Main: **31.69**<br>Candidate: **30.51**<br>Change: **-3.72%** | Main: **30.51**<br>Candidate: **29.96**<br>Change: **-1.80%** |
| `syscall-io/lock_many_files_conflict_us_per_op` (lower better) | Main: **25.12**<br>Candidate: **26.03**<br>Change: **+3.62%** | Main: **25.71**<br>Candidate: **25.87**<br>Change: **+0.62%** |
| `syscall-io/lock_many_files_replace_us_per_op` (lower better) | Main: **30.63**<br>Candidate: **30.87**<br>Change: **+0.78%** | Main: **30.55**<br>Candidate: **30.63**<br>Change: **+0.26%** |
| `syscall-io/lock_many_files_unlock_us_per_op` (lower better) | Main: **27.04**<br>Candidate: **26.89**<br>Change: **-0.55%** | Main: **27.51**<br>Candidate: **27.6**<br>Change: **+0.33%** |
| `syscall-io/lock_dense_file_acquire_us_per_op` (lower better) | Main: **27.7**<br>Candidate: **27.19**<br>Change: **-1.84%** | Main: **26.31**<br>Candidate: **26.48**<br>Change: **+0.65%** |
| `syscall-io/lock_dense_file_conflict_us_per_op` (lower better) | Main: **26.5**<br>Candidate: **26.07**<br>Change: **-1.62%** | Main: **26.29**<br>Candidate: **26.5**<br>Change: **+0.80%** |
| `syscall-io/lock_dense_file_replace_us_per_op` (lower better) | Main: **27.73**<br>Candidate: **28.01**<br>Change: **+1.01%** | Main: **28.01**<br>Candidate: **27.93**<br>Change: **-0.29%** |
| `syscall-io/lock_dense_file_unlock_us_per_op` (lower better) | Main: **25.49**<br>Candidate: **25.92**<br>Change: **+1.69%** | Main: **25.37**<br>Candidate: **24.71**<br>Change: **-2.60%** |
| `syscall-io/syscall_latency_us` (lower better) | Main: **28.4**<br>Candidate: **28.9**<br>Change: **+1.76%** | Main: **28.59**<br>Candidate: **28.36**<br>Change: **-0.80%** |
| `stdin-throughput/stdin_mbps` (higher better) | Main: **881.74**<br>Candidate: **880.41**<br>Change: **-0.15%** | Main: **889.05**<br>Candidate: **878.64**<br>Change: **-1.17%** |
| `process-lifecycle/hello_start_ms` (lower better) | Main: **213.3**<br>Candidate: **216.75**<br>Change: **+1.62%** | Main: **212.89**<br>Candidate: **222.63**<br>Change: **+4.58%** |
| `process-lifecycle/fork_ms` (lower better) | Main: **43.03**<br>Candidate: **43.85**<br>Change: **+1.91%** | Main: **43.13**<br>Candidate: **45.35**<br>Change: **+5.15%** |
| `process-lifecycle/clone_ms` (lower better) | Main: **31.4**<br>Candidate: **31.65**<br>Change: **+0.80%** | Main: **30.6**<br>Candidate: **32.57**<br>Change: **+6.44%** |
| `spawn-scratch/spawn_ms` (lower better) | Main: **36.99**<br>Candidate: **38.58**<br>Change: **+4.30%** | Main: **36.83**<br>Candidate: **37.97**<br>Change: **+3.10%** |
| `spawn-scratch/spawn_large_wire_bytes` (lower better) | Main: **84386**<br>Candidate: **84386**<br>Change: **+0.00%** | Main: **84386**<br>Candidate: **84386**<br>Change: **+0.00%** |
| `spawn-scratch/spawn_large_first_ms` (lower better) | Main: **28.05**<br>Candidate: **28.99**<br>Change: **+3.35%** | Main: **27.99**<br>Candidate: **29.32**<br>Change: **+4.75%** |
| `spawn-scratch/spawn_large_repeat_ms` (lower better) | Main: **28.31**<br>Candidate: **29.5**<br>Change: **+4.20%** | Main: **28.46**<br>Candidate: **29.36**<br>Change: **+3.16%** |
| `spawn-scratch/spawn_scratch_kernel_bytes` (lower better) | Main: **1.04858e+07**<br>Candidate: **1.04858e+07**<br>Change: **+0.00%** | Main: **1.04858e+07**<br>Candidate: **1.04858e+07**<br>Change: **+0.00%** |
| `wordpress/boot_ms` (lower better) | Main: **8431.55**<br>Candidate: **8432.75**<br>Change: **+0.01%** | Main: **8433.82**<br>Candidate: **8437.46**<br>Change: **+0.04%** |
| `wordpress/http_first_response_ms` (lower better) | Main: **210.02**<br>Candidate: **209.5**<br>Change: **-0.25%** | Main: **208.02**<br>Candidate: **209.56**<br>Change: **+0.74%** |
| `mariadb-aria/bootstrap_ms` (lower better) | Main: **1048.12**<br>Candidate: **1066.81**<br>Change: **+1.78%** | Main: **1070.31**<br>Candidate: **1085.53**<br>Change: **+1.42%** |
| `mariadb-aria/query_create_ms` (lower better) | Main: **14.23**<br>Candidate: **14.14**<br>Change: **-0.63%** | Main: **14.07**<br>Candidate: **14.21**<br>Change: **+1.00%** |
| `mariadb-aria/query_insert_ms` (lower better) | Main: **81.66**<br>Candidate: **82.17**<br>Change: **+0.62%** | Main: **81.5**<br>Candidate: **81.41**<br>Change: **-0.11%** |
| `mariadb-aria/query_select_ms` (lower better) | Main: **6.96**<br>Candidate: **6.69**<br>Change: **-3.88%** | Main: **7.03**<br>Candidate: **6.92**<br>Change: **-1.56%** |
| `mariadb-aria/query_join_ms` (lower better) | Main: **1.56**<br>Candidate: **1.81**<br>Change: **+16.03%** | Main: **1.56**<br>Candidate: **1.56**<br>Change: **+0.00%** |
| `mariadb-aria-64/bootstrap_ms` (lower better) | Main: **1058.96**<br>Candidate: **1078.29**<br>Change: **+1.83%** | Main: **1050.29**<br>Candidate: **1056.9**<br>Change: **+0.63%** |
| `mariadb-aria-64/query_create_ms` (lower better) | Main: **13.12**<br>Candidate: **14.14**<br>Change: **+7.77%** | Main: **14.06**<br>Candidate: **13.8**<br>Change: **-1.85%** |
| `mariadb-aria-64/query_insert_ms` (lower better) | Main: **80.61**<br>Candidate: **81.99**<br>Change: **+1.71%** | Main: **79.24**<br>Candidate: **79.62**<br>Change: **+0.48%** |
| `mariadb-aria-64/query_select_ms` (lower better) | Main: **6.72**<br>Candidate: **6.62**<br>Change: **-1.49%** | Main: **6.77**<br>Candidate: **6.6**<br>Change: **-2.51%** |
| `mariadb-aria-64/query_join_ms` (lower better) | Main: **1.68**<br>Candidate: **1.78**<br>Change: **+5.95%** | Main: **1.79**<br>Candidate: **2.97**<br>Change: **+65.92%** |
| `mariadb-innodb/bootstrap_ms` (lower better) | Main: **990.84**<br>Candidate: **995.59**<br>Change: **+0.48%** | Main: **967.41**<br>Candidate: **997.34**<br>Change: **+3.09%** |
| `mariadb-innodb/query_create_ms` (lower better) | Main: **25.2**<br>Candidate: **26.81**<br>Change: **+6.39%** | Main: **22.77**<br>Candidate: **25.43**<br>Change: **+11.68%** |
| `mariadb-innodb/query_insert_ms` (lower better) | Main: **137.85**<br>Candidate: **146.41**<br>Change: **+6.21%** | Main: **139.67**<br>Candidate: **141.64**<br>Change: **+1.41%** |
| `mariadb-innodb/query_select_ms` (lower better) | Main: **6.58**<br>Candidate: **6.65**<br>Change: **+1.06%** | Main: **6.75**<br>Candidate: **6.56**<br>Change: **-2.81%** |
| `mariadb-innodb/query_join_ms` (lower better) | Main: **1.74**<br>Candidate: **1.65**<br>Change: **-5.17%** | Main: **1.58**<br>Candidate: **1.67**<br>Change: **+5.70%** |
| `mariadb-innodb-64/bootstrap_ms` (lower better) | Main: **1010.87**<br>Candidate: **979.86**<br>Change: **-3.07%** | Main: **976.19**<br>Candidate: **986.67**<br>Change: **+1.07%** |
| `mariadb-innodb-64/query_create_ms` (lower better) | Main: **20.76**<br>Candidate: **20.33**<br>Change: **-2.07%** | Main: **20.43**<br>Candidate: **19.79**<br>Change: **-3.13%** |
| `mariadb-innodb-64/query_insert_ms` (lower better) | Main: **129.12**<br>Candidate: **128.86**<br>Change: **-0.20%** | Main: **131.62**<br>Candidate: **128.28**<br>Change: **-2.54%** |
| `mariadb-innodb-64/query_select_ms` (lower better) | Main: **7.22**<br>Candidate: **7.12**<br>Change: **-1.39%** | Main: **6.97**<br>Candidate: **7.18**<br>Change: **+3.01%** |
| `mariadb-innodb-64/query_join_ms` (lower better) | Main: **2.09**<br>Candidate: **1.94**<br>Change: **-7.18%** | Main: **2.01**<br>Candidate: **2.03**<br>Change: **+1.00%** |

### Interpretation limits

- Two CLI parents per host and variant, each aggregating three rounds; not six independent parent launches.
- Five-percent flags are descriptive, not confidence intervals or statistical significance.
- Browser means the normal Chromium harness; grouped PHP latency is not measured.
- This compares the whole frozen candidate, including preserved unrelated changes, with pinned main; individual feature attribution is not established.
- No timer-resolution record supports interpretation of small deltas.
- Earlier failed attempts must remain alongside this full campaign.
- The first completed Node pair is retained from attempt 4 after exact canonical selected-file and directory equality checks; the six remaining parents run in continuation 5. All original timestamps and failure records are retained. A few raw progress values were visible before the reuse decision; no comparative timing report selected the imported runs.
