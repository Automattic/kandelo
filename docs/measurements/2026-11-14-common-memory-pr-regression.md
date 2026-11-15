# Committed-PR ordinary-runtime comparison — November 14, 2026

The complete canonical comparison finds adverse results in the ordinary runtime
as well as favorable observations. Node dense file replacement and MariaDB
Aria select, plus Chromium hello startup, exceed a descriptive five-percent
adverse threshold in both orders. Node stdin and exec remain worse in both
orders, with one value below that cutoff in each case. These remain regression
leads before broader distribution. This is **not** evidence of performance
neutrality, a causal feature attribution or a statistical-significance test.

This comparison runs ordinary, untranslated Wasm through the normal hosts. It
does not measure translated PHP-FPM; the [separate application report](2026-11-14-common-memory-application-impact.md)
provides the three-control PHP comparison and OS footprint measurements.

## Inputs and coverage

Main is pinned at `f8612113e7bd52a5ce31011d556d7ce1519424be`; the committed PR
candidate is `897db3712f83a92c55925846853efa97bd27b450`. Both prepared checkouts
remain tracked-source clean. Each uses its own normal SDK, kernel, programs,
images and resolver-selected artifacts. Nine selected standalone benchmark
Wasm guest entries are byte-identical between checkouts; application, kernel
and host artifacts have recorded differences. The whole PR includes multiple
runtime and build changes, so a delta cannot be assigned to shared memory or
the newer accounting API alone.

Both normal package graphs and host builds completed. Missing benchmark source
and dormant MariaDB prerequisites were provisioned through the documented
WordPress setup and normal package resolver. Resolver integrity, Vite access
checks and ABI admission were preserved. The copied development rootfs was
materialized from the normally selected bytes as a regular file. A slow debug
build-finalization attempt was stopped and the same normal bootstrap completed
through its freshly built release tool; this is preparation, not timing data.

All nine enabled canonical suites run on Node and Chromium: syscall I/O,
stdin throughput, process lifecycle, spawn scratch, WordPress, and MariaDB
Aria/InnoDB with both memory32 and memory64 programs. The canonical harness's
disabled Erlang ring policy is unchanged; no enabled suite is skipped.

Eight fresh CLI parents run three rounds per suite: Node main/candidate,
Chromium main/candidate, Node candidate/main, then Chromium candidate/main.
No timings are imported from earlier attempts. Each CLI aggregates its three
rounds; they are not independent parent launches. There are 48 Node and 43
Chromium metrics, all retained below. No confidence intervals or in-cohort
clock-resolution record supports small-difference or equivalence claims.

Environment: Apple M5 Max, 18 logical CPUs, 48 GiB memory, macOS 27.2.1 arm64,
Node 24.15.0, Playwright's bundled Chromium headless-shell executable reporting
Google Chrome for Testing 153.0.8010.12. This is not the native Safari app or
the application fixture's separate launch-server browser processes. The
application campaigns finish before this matrix starts. No other managed
build/test is running at its start; previews remain available and load averages
are recorded per parent. This does not establish whole-machine idleness.

## Repeated adverse observations

Values are canonical three-round aggregates. Each cell labels its main value,
PR value and raw percentage change. Durations favor smaller values; throughput
favors larger values. The five-percent selection is descriptive, not a
significance threshold.

| Metric | Main then PR | PR then main |
|---|---|---|
| node: `syscall-io/lock_dense_file_replace_us_per_op` | Main: **24.79**<br>PR: **27.32**<br>Raw change: **+10.21%** | Main: **24.33**<br>PR: **27.29**<br>Raw change: **+12.17%** |
| node: `mariadb-aria/query_select_ms` | Main: **99.12**<br>PR: **134.22**<br>Raw change: **+35.41%** | Main: **119.37**<br>PR: **132.15**<br>Raw change: **+10.71%** |
| browser: `process-lifecycle/hello_start_ms` | Main: **205.71**<br>PR: **221.5**<br>Raw change: **+7.68%** | Main: **209**<br>PR: **225.46**<br>Raw change: **+7.88%** |

Node stdin throughput changes by **−6.82%** and **−3.16%**. Exec time rises
**5.12%** and **4.86%**; hello startup rises **4.89%** and **7.54%**. Falling just
below the descriptive cutoff does not clear these leads. The earlier
[comparison before the final accounting checkpoint](2026-11-14-common-memory-default-regression.md)
also retains adverse stdin, exec and locking observations. It remains a separate
historical result; the fresh numbers here do not overwrite it.

The Aria select aggregate changes from 99.12 to 134.22 ms in the first pair,
and 119.37 to 132.15 ms in the reverse pair. Retain the absolute durations and
baseline variation alongside the percentages; this does not show that shared
PHP or a particular database operation caused the difference.

## Favorable observations retained

The same descriptive threshold identifies these Node results in both orders.
No Chromium metric exceeds a five-percent improvement in both orders.

| Metric | Main then PR | PR then main |
|---|---|---|
| node: `syscall-io/lock_dense_file_conflict_us_per_op` | Main: **27.11**<br>PR: **24.05**<br>Raw change: **-11.29%** | Main: **26.55**<br>PR: **24.33**<br>Raw change: **-8.36%** |
| node: `syscall-io/epoll_ready_us_per_op` | Main: **31.06**<br>PR: **29.46**<br>Raw change: **-5.15%** | Main: **36.92**<br>PR: **34.65**<br>Raw change: **-6.15%** |
| node: `wordpress/http_first_response_ms` | Main: **2963.27**<br>PR: **2358.73**<br>Raw change: **-20.40%** | Main: **2592.93**<br>PR: **1656.03**<br>Raw change: **-36.13%** |

Ordinary Node WordPress first response is lower in these two pairs, unlike the
order-sensitive earlier comparison. That is an observation of this canonical
first-response aggregate, not a warm translated-PHP result, a production
throughput claim or an isolated feature benefit. All other values, including
mixed directions and adverse values under the cutoff, remain below.

## Identity, ABI and failure accounting

Every selected file and directory fingerprint in all eight results exactly
matches the four final canonical inventories. Both source checkouts are clean.
All 335 current-profile source hashes match both the root checkout and the
prepared candidate, and all six emitted profile modules match their manifest.
The workspace's protected ordinary kernel remains unchanged. This verifies
the recorded inputs; it does not isolate which differing artifact caused a
timing change.

Thirty distinct explicitly selected standalone Wasm files were inspected.
Four lack the `kandelo.abi.contract` custom section: the wasm64 MariaDB server
and mysqltest client in each checkout. Existing version-based admission emits
warnings; no unknown executable was restamped to silence them. This static
inventory does not inspect every executable inside every image or assign each
warning line to one launch. The shared-PHP artifact has separate current
contract validation and is not part of this ordinary benchmark inventory.

Retained preparation failures include missing unpacked WordPress source and
raw wasm64 MariaDB prerequisites, plus the stopped debug finalization and its
profile. An initial post-run metadata audit was launched before the final
candidate browser inventory finished and failed on that missing file. It was
retained and repeated after the inventory command completed; the complete
repeat matches all eight runs. No benchmark timing or failed application case
was converted into a pass. The earlier source-suite failures, intermittent
boot stall and native atomic-wait cancellation boundary remain documented in
the [prototype scope](../experimental-common-memory.md).

## Reproduction and evidence

Run the normal commands separately in each fully provisioned checkout:

```sh
scripts/dev-shell.sh node_modules/.bin/tsx benchmarks/run.ts --host=node --rounds=3
scripts/dev-shell.sh node_modules/.bin/tsx benchmarks/run.ts --host=browser --rounds=3
scripts/dev-shell.sh node_modules/.bin/tsx benchmarks/compare.ts BEFORE.json AFTER.json
```

The retained directory `.context/common-memory-pr-regression-20261114/` contains
all eight raw results/logs, plans and preparation records, selected input bytes
and hashes, four pre/post inventories, four canonical compare reports, the
strict all-metric analysis, ABI inventory, environment and archive read-back
manifest. Earlier failed attempts remain retained. The raw campaign layout
preserves the paths needed to replay the strict metric analysis offline.
These records supplement the application evidence and do not establish release
or merge readiness.

## All canonical values

Each value is the canonical aggregate over three rounds. Pair 1 runs main then
candidate; pair 2 reverses order. Positive raw change means a larger value.
Metric names carry units. No enabled metric is omitted.

## node

| Metric | Pair 1 | Pair 2 |
|---|---|---|
| `syscall-io/pipe_mbps` (higher better) | Main: **62.87**<br>Candidate: **61.76**<br>Change: **-1.77%** | Main: **62.64**<br>Candidate: **61.08**<br>Change: **-2.49%** |
| `syscall-io/file_write_mbps` (higher better) | Main: **85.2**<br>Candidate: **86.65**<br>Change: **+1.70%** | Main: **87.83**<br>Candidate: **83.79**<br>Change: **-4.60%** |
| `syscall-io/file_read_mbps` (higher better) | Main: **125.22**<br>Candidate: **127.13**<br>Change: **+1.53%** | Main: **129**<br>Candidate: **124.95**<br>Change: **-3.14%** |
| `syscall-io/lock_many_files_acquire_us_per_op` (lower better) | Main: **30.04**<br>Candidate: **29.78**<br>Change: **-0.87%** | Main: **29.22**<br>Candidate: **30.22**<br>Change: **+3.42%** |
| `syscall-io/lock_many_files_conflict_us_per_op` (lower better) | Main: **24.68**<br>Candidate: **25**<br>Change: **+1.30%** | Main: **24.57**<br>Candidate: **24.78**<br>Change: **+0.85%** |
| `syscall-io/lock_many_files_replace_us_per_op` (lower better) | Main: **28.29**<br>Candidate: **28.81**<br>Change: **+1.84%** | Main: **28.11**<br>Candidate: **28.61**<br>Change: **+1.78%** |
| `syscall-io/lock_many_files_unlock_us_per_op` (lower better) | Main: **22.88**<br>Candidate: **23.34**<br>Change: **+2.01%** | Main: **24.46**<br>Candidate: **24.89**<br>Change: **+1.76%** |
| `syscall-io/lock_dense_file_acquire_us_per_op` (lower better) | Main: **23.14**<br>Candidate: **23.61**<br>Change: **+2.03%** | Main: **23.13**<br>Candidate: **24.11**<br>Change: **+4.24%** |
| `syscall-io/lock_dense_file_conflict_us_per_op` (lower better) | Main: **27.11**<br>Candidate: **24.05**<br>Change: **-11.29%** | Main: **26.55**<br>Candidate: **24.33**<br>Change: **-8.36%** |
| `syscall-io/lock_dense_file_replace_us_per_op` (lower better) | Main: **24.79**<br>Candidate: **27.32**<br>Change: **+10.21%** | Main: **24.33**<br>Candidate: **27.29**<br>Change: **+12.17%** |
| `syscall-io/lock_dense_file_unlock_us_per_op` (lower better) | Main: **23.46**<br>Candidate: **23.6**<br>Change: **+0.60%** | Main: **23.19**<br>Candidate: **23.56**<br>Change: **+1.60%** |
| `syscall-io/syscall_latency_us` (lower better) | Main: **25.11**<br>Candidate: **24.73**<br>Change: **-1.51%** | Main: **24.32**<br>Candidate: **25.28**<br>Change: **+3.95%** |
| `syscall-io/poll_ready_us_per_op` (lower better) | Main: **25.77**<br>Candidate: **25.71**<br>Change: **-0.23%** | Main: **25.46**<br>Candidate: **26.26**<br>Change: **+3.14%** |
| `syscall-io/poll_timeout_us_per_op` (lower better) | Main: **1422.24**<br>Candidate: **1383.29**<br>Change: **-2.74%** | Main: **1431.62**<br>Candidate: **1435.8**<br>Change: **+0.29%** |
| `syscall-io/select_timeout_us_per_op` (lower better) | Main: **1520.91**<br>Candidate: **1460.27**<br>Change: **-3.99%** | Main: **1507.71**<br>Candidate: **1507.85**<br>Change: **+0.01%** |
| `syscall-io/epoll_ready_us_per_op` (lower better) | Main: **31.06**<br>Candidate: **29.46**<br>Change: **-5.15%** | Main: **36.92**<br>Candidate: **34.65**<br>Change: **-6.15%** |
| `stdin-throughput/stdin_mbps` (higher better) | Main: **862.87**<br>Candidate: **804.05**<br>Change: **-6.82%** | Main: **833.74**<br>Candidate: **807.43**<br>Change: **-3.16%** |
| `process-lifecycle/hello_start_ms` (lower better) | Main: **3346.4**<br>Candidate: **3510.09**<br>Change: **+4.89%** | Main: **3281.88**<br>Candidate: **3529.32**<br>Change: **+7.54%** |
| `process-lifecycle/fork_ms` (lower better) | Main: **83.57**<br>Candidate: **85.83**<br>Change: **+2.70%** | Main: **78.67**<br>Candidate: **78.82**<br>Change: **+0.19%** |
| `process-lifecycle/exec_ms` (lower better) | Main: **3429.48**<br>Candidate: **3605.17**<br>Change: **+5.12%** | Main: **3340.87**<br>Candidate: **3503.2**<br>Change: **+4.86%** |
| `process-lifecycle/clone_ms` (lower better) | Main: **69.03**<br>Candidate: **66.86**<br>Change: **-3.14%** | Main: **64.19**<br>Candidate: **63.54**<br>Change: **-1.01%** |
| `spawn-scratch/spawn_ms` (lower better) | Main: **76.11**<br>Candidate: **78.04**<br>Change: **+2.54%** | Main: **70.25**<br>Candidate: **70.11**<br>Change: **-0.20%** |
| `spawn-scratch/spawn_large_wire_bytes` (lower better) | Main: **84386**<br>Candidate: **84386**<br>Change: **+0.00%** | Main: **84386**<br>Candidate: **84386**<br>Change: **+0.00%** |
| `spawn-scratch/spawn_large_first_ms` (lower better) | Main: **68.55**<br>Candidate: **66.74**<br>Change: **-2.64%** | Main: **62.92**<br>Candidate: **62.43**<br>Change: **-0.78%** |
| `spawn-scratch/spawn_large_repeat_ms` (lower better) | Main: **67.49**<br>Candidate: **68.61**<br>Change: **+1.66%** | Main: **61.48**<br>Candidate: **62.3**<br>Change: **+1.33%** |
| `spawn-scratch/spawn_scratch_kernel_bytes` (lower better) | Main: **1.04858e+07**<br>Candidate: **1.04858e+07**<br>Change: **+0.00%** | Main: **1.04858e+07**<br>Candidate: **1.04858e+07**<br>Change: **+0.00%** |
| `wordpress/cli_require_ms` (lower better) | Main: **486.02**<br>Candidate: **453.8**<br>Change: **-6.63%** | Main: **442.7**<br>Candidate: **450.24**<br>Change: **+1.70%** |
| `wordpress/http_first_response_ms` (lower better) | Main: **2963.27**<br>Candidate: **2358.73**<br>Change: **-20.40%** | Main: **2592.93**<br>Candidate: **1656.03**<br>Change: **-36.13%** |
| `mariadb-aria/bootstrap_ms` (lower better) | Main: **2173.17**<br>Candidate: **2161.17**<br>Change: **-0.55%** | Main: **2147.81**<br>Candidate: **2224.56**<br>Change: **+3.57%** |
| `mariadb-aria/query_create_ms` (lower better) | Main: **230.67**<br>Candidate: **229.1**<br>Change: **-0.68%** | Main: **226.76**<br>Candidate: **227.43**<br>Change: **+0.30%** |
| `mariadb-aria/query_insert_ms` (lower better) | Main: **926.7**<br>Candidate: **1013.77**<br>Change: **+9.40%** | Main: **1003.47**<br>Candidate: **1025.44**<br>Change: **+2.19%** |
| `mariadb-aria/query_select_ms` (lower better) | Main: **99.12**<br>Candidate: **134.22**<br>Change: **+35.41%** | Main: **119.37**<br>Candidate: **132.15**<br>Change: **+10.71%** |
| `mariadb-aria/query_join_ms` (lower better) | Main: **91.13**<br>Candidate: **90.15**<br>Change: **-1.08%** | Main: **91.23**<br>Candidate: **85.86**<br>Change: **-5.89%** |
| `mariadb-aria-64/bootstrap_ms` (lower better) | Main: **2188.59**<br>Candidate: **2209.37**<br>Change: **+0.95%** | Main: **2295.02**<br>Candidate: **2315.27**<br>Change: **+0.88%** |
| `mariadb-aria-64/query_create_ms` (lower better) | Main: **228.64**<br>Candidate: **230.39**<br>Change: **+0.77%** | Main: **226.38**<br>Candidate: **221.39**<br>Change: **-2.20%** |
| `mariadb-aria-64/query_insert_ms` (lower better) | Main: **1021.69**<br>Candidate: **1027.67**<br>Change: **+0.59%** | Main: **1066.24**<br>Candidate: **1070.21**<br>Change: **+0.37%** |
| `mariadb-aria-64/query_select_ms` (lower better) | Main: **104.86**<br>Candidate: **120.52**<br>Change: **+14.93%** | Main: **118.85**<br>Candidate: **121.37**<br>Change: **+2.12%** |
| `mariadb-aria-64/query_join_ms` (lower better) | Main: **93.52**<br>Candidate: **87.23**<br>Change: **-6.73%** | Main: **90.64**<br>Candidate: **87.31**<br>Change: **-3.67%** |
| `mariadb-innodb/bootstrap_ms` (lower better) | Main: **2010.31**<br>Candidate: **2038.13**<br>Change: **+1.38%** | Main: **2043.6**<br>Candidate: **2024.39**<br>Change: **-0.94%** |
| `mariadb-innodb/query_create_ms` (lower better) | Main: **233.14**<br>Candidate: **230.11**<br>Change: **-1.30%** | Main: **224.98**<br>Candidate: **232.81**<br>Change: **+3.48%** |
| `mariadb-innodb/query_insert_ms` (lower better) | Main: **260.64**<br>Candidate: **262.92**<br>Change: **+0.87%** | Main: **257.03**<br>Candidate: **259.96**<br>Change: **+1.14%** |
| `mariadb-innodb/query_select_ms` (lower better) | Main: **97.93**<br>Candidate: **99.26**<br>Change: **+1.36%** | Main: **96.37**<br>Candidate: **97.72**<br>Change: **+1.40%** |
| `mariadb-innodb/query_join_ms` (lower better) | Main: **89.27**<br>Candidate: **89.94**<br>Change: **+0.75%** | Main: **88.53**<br>Candidate: **89.27**<br>Change: **+0.84%** |
| `mariadb-innodb-64/bootstrap_ms` (lower better) | Main: **2087.37**<br>Candidate: **2079.66**<br>Change: **-0.37%** | Main: **2158.61**<br>Candidate: **2128.26**<br>Change: **-1.41%** |
| `mariadb-innodb-64/query_create_ms` (lower better) | Main: **233.91**<br>Candidate: **230.49**<br>Change: **-1.46%** | Main: **225.22**<br>Candidate: **231.18**<br>Change: **+2.65%** |
| `mariadb-innodb-64/query_insert_ms` (lower better) | Main: **264.84**<br>Candidate: **265.09**<br>Change: **+0.09%** | Main: **259.53**<br>Candidate: **270.39**<br>Change: **+4.18%** |
| `mariadb-innodb-64/query_select_ms` (lower better) | Main: **96.65**<br>Candidate: **96.28**<br>Change: **-0.38%** | Main: **97.94**<br>Candidate: **97.08**<br>Change: **-0.88%** |
| `mariadb-innodb-64/query_join_ms` (lower better) | Main: **89.43**<br>Candidate: **89.41**<br>Change: **-0.02%** | Main: **88.76**<br>Candidate: **88.97**<br>Change: **+0.24%** |

## browser

| Metric | Pair 1 | Pair 2 |
|---|---|---|
| `syscall-io/pipe_mbps` (higher better) | Main: **56.45**<br>Candidate: **58.02**<br>Change: **+2.78%** | Main: **58.48**<br>Candidate: **55.1**<br>Change: **-5.78%** |
| `syscall-io/file_write_mbps` (higher better) | Main: **82.3**<br>Candidate: **80.26**<br>Change: **-2.48%** | Main: **82.2**<br>Candidate: **83.02**<br>Change: **+1.00%** |
| `syscall-io/file_read_mbps` (higher better) | Main: **110.62**<br>Candidate: **110.38**<br>Change: **-0.22%** | Main: **111.73**<br>Candidate: **110.86**<br>Change: **-0.78%** |
| `syscall-io/lock_many_files_acquire_us_per_op` (lower better) | Main: **29.65**<br>Candidate: **31.54**<br>Change: **+6.37%** | Main: **29.29**<br>Candidate: **29.57**<br>Change: **+0.96%** |
| `syscall-io/lock_many_files_conflict_us_per_op` (lower better) | Main: **24.57**<br>Candidate: **26.89**<br>Change: **+9.44%** | Main: **25.04**<br>Candidate: **26.1**<br>Change: **+4.23%** |
| `syscall-io/lock_many_files_replace_us_per_op` (lower better) | Main: **31.46**<br>Candidate: **30.31**<br>Change: **-3.66%** | Main: **31.69**<br>Candidate: **31.61**<br>Change: **-0.25%** |
| `syscall-io/lock_many_files_unlock_us_per_op` (lower better) | Main: **27.52**<br>Candidate: **26.54**<br>Change: **-3.56%** | Main: **27.45**<br>Candidate: **26.94**<br>Change: **-1.86%** |
| `syscall-io/lock_dense_file_acquire_us_per_op` (lower better) | Main: **26.1**<br>Candidate: **27.6**<br>Change: **+5.75%** | Main: **27.34**<br>Candidate: **26.02**<br>Change: **-4.83%** |
| `syscall-io/lock_dense_file_conflict_us_per_op` (lower better) | Main: **26.13**<br>Candidate: **25.88**<br>Change: **-0.96%** | Main: **26.15**<br>Candidate: **26.72**<br>Change: **+2.18%** |
| `syscall-io/lock_dense_file_replace_us_per_op` (lower better) | Main: **27.75**<br>Candidate: **27.91**<br>Change: **+0.58%** | Main: **27.82**<br>Candidate: **28.13**<br>Change: **+1.11%** |
| `syscall-io/lock_dense_file_unlock_us_per_op` (lower better) | Main: **25.04**<br>Candidate: **26.33**<br>Change: **+5.15%** | Main: **25.39**<br>Candidate: **24.84**<br>Change: **-2.17%** |
| `syscall-io/syscall_latency_us` (lower better) | Main: **28.27**<br>Candidate: **29.95**<br>Change: **+5.94%** | Main: **28.56**<br>Candidate: **28.31**<br>Change: **-0.88%** |
| `stdin-throughput/stdin_mbps` (higher better) | Main: **880.09**<br>Candidate: **891.03**<br>Change: **+1.24%** | Main: **888.4**<br>Candidate: **891.2**<br>Change: **+0.32%** |
| `process-lifecycle/hello_start_ms` (lower better) | Main: **205.71**<br>Candidate: **221.5**<br>Change: **+7.68%** | Main: **209**<br>Candidate: **225.46**<br>Change: **+7.88%** |
| `process-lifecycle/fork_ms` (lower better) | Main: **44.29**<br>Candidate: **43.66**<br>Change: **-1.42%** | Main: **43.09**<br>Candidate: **44.17**<br>Change: **+2.51%** |
| `process-lifecycle/clone_ms` (lower better) | Main: **32.01**<br>Candidate: **31.59**<br>Change: **-1.31%** | Main: **30.53**<br>Candidate: **31.96**<br>Change: **+4.68%** |
| `spawn-scratch/spawn_ms` (lower better) | Main: **37.2**<br>Candidate: **37.93**<br>Change: **+1.96%** | Main: **36.85**<br>Candidate: **37.9**<br>Change: **+2.85%** |
| `spawn-scratch/spawn_large_wire_bytes` (lower better) | Main: **84386**<br>Candidate: **84386**<br>Change: **+0.00%** | Main: **84386**<br>Candidate: **84386**<br>Change: **+0.00%** |
| `spawn-scratch/spawn_large_first_ms` (lower better) | Main: **28.05**<br>Candidate: **28.68**<br>Change: **+2.25%** | Main: **28.31**<br>Candidate: **29.22**<br>Change: **+3.21%** |
| `spawn-scratch/spawn_large_repeat_ms` (lower better) | Main: **28.62**<br>Candidate: **28.59**<br>Change: **-0.10%** | Main: **28.38**<br>Candidate: **29.12**<br>Change: **+2.61%** |
| `spawn-scratch/spawn_scratch_kernel_bytes` (lower better) | Main: **1.04858e+07**<br>Candidate: **1.04858e+07**<br>Change: **+0.00%** | Main: **1.04858e+07**<br>Candidate: **1.04858e+07**<br>Change: **+0.00%** |
| `wordpress/boot_ms` (lower better) | Main: **8419.97**<br>Candidate: **8455.49**<br>Change: **+0.42%** | Main: **8414**<br>Candidate: **8443.23**<br>Change: **+0.35%** |
| `wordpress/http_first_response_ms` (lower better) | Main: **209.69**<br>Candidate: **208.73**<br>Change: **-0.46%** | Main: **209.5**<br>Candidate: **206.33**<br>Change: **-1.51%** |
| `mariadb-aria/bootstrap_ms` (lower better) | Main: **1064.8**<br>Candidate: **1048.34**<br>Change: **-1.55%** | Main: **1060.69**<br>Candidate: **1047.01**<br>Change: **-1.29%** |
| `mariadb-aria/query_create_ms` (lower better) | Main: **14.19**<br>Candidate: **13.88**<br>Change: **-2.18%** | Main: **14.34**<br>Candidate: **14.09**<br>Change: **-1.74%** |
| `mariadb-aria/query_insert_ms` (lower better) | Main: **81.52**<br>Candidate: **80.74**<br>Change: **-0.96%** | Main: **81.88**<br>Candidate: **82.5**<br>Change: **+0.76%** |
| `mariadb-aria/query_select_ms` (lower better) | Main: **6.98**<br>Candidate: **7.13**<br>Change: **+2.15%** | Main: **6.7**<br>Candidate: **6.64**<br>Change: **-0.90%** |
| `mariadb-aria/query_join_ms` (lower better) | Main: **1.64**<br>Candidate: **1.63**<br>Change: **-0.61%** | Main: **1.63**<br>Candidate: **1.69**<br>Change: **+3.68%** |
| `mariadb-aria-64/bootstrap_ms` (lower better) | Main: **1043.94**<br>Candidate: **1088.94**<br>Change: **+4.31%** | Main: **1056.64**<br>Candidate: **1049.08**<br>Change: **-0.72%** |
| `mariadb-aria-64/query_create_ms` (lower better) | Main: **14.1**<br>Candidate: **14.09**<br>Change: **-0.07%** | Main: **14.38**<br>Candidate: **14.05**<br>Change: **-2.29%** |
| `mariadb-aria-64/query_insert_ms` (lower better) | Main: **81.17**<br>Candidate: **78.84**<br>Change: **-2.87%** | Main: **78.54**<br>Candidate: **81.46**<br>Change: **+3.72%** |
| `mariadb-aria-64/query_select_ms` (lower better) | Main: **6.76**<br>Candidate: **6.88**<br>Change: **+1.78%** | Main: **6.78**<br>Candidate: **6.72**<br>Change: **-0.88%** |
| `mariadb-aria-64/query_join_ms` (lower better) | Main: **1.94**<br>Candidate: **1.72**<br>Change: **-11.34%** | Main: **1.74**<br>Candidate: **1.81**<br>Change: **+4.02%** |
| `mariadb-innodb/bootstrap_ms` (lower better) | Main: **964.88**<br>Candidate: **996.31**<br>Change: **+3.26%** | Main: **986.72**<br>Candidate: **1010.46**<br>Change: **+2.41%** |
| `mariadb-innodb/query_create_ms` (lower better) | Main: **24.35**<br>Candidate: **25.46**<br>Change: **+4.56%** | Main: **19.7**<br>Candidate: **19.36**<br>Change: **-1.73%** |
| `mariadb-innodb/query_insert_ms` (lower better) | Main: **134.31**<br>Candidate: **145.75**<br>Change: **+8.52%** | Main: **144.44**<br>Candidate: **141.42**<br>Change: **-2.09%** |
| `mariadb-innodb/query_select_ms` (lower better) | Main: **6.86**<br>Candidate: **6.63**<br>Change: **-3.35%** | Main: **6.51**<br>Candidate: **6.63**<br>Change: **+1.84%** |
| `mariadb-innodb/query_join_ms` (lower better) | Main: **1.69**<br>Candidate: **1.71**<br>Change: **+1.18%** | Main: **1.63**<br>Candidate: **1.61**<br>Change: **-1.23%** |
| `mariadb-innodb-64/bootstrap_ms` (lower better) | Main: **1012.76**<br>Candidate: **994.21**<br>Change: **-1.83%** | Main: **982.42**<br>Candidate: **1014.02**<br>Change: **+3.22%** |
| `mariadb-innodb-64/query_create_ms` (lower better) | Main: **20.44**<br>Candidate: **21.19**<br>Change: **+3.67%** | Main: **20.96**<br>Candidate: **23.14**<br>Change: **+10.40%** |
| `mariadb-innodb-64/query_insert_ms` (lower better) | Main: **128.93**<br>Candidate: **133.96**<br>Change: **+3.90%** | Main: **138.17**<br>Candidate: **134.59**<br>Change: **-2.59%** |
| `mariadb-innodb-64/query_select_ms` (lower better) | Main: **7.1**<br>Candidate: **7.13**<br>Change: **+0.42%** | Main: **7.05**<br>Candidate: **7.07**<br>Change: **+0.28%** |
| `mariadb-innodb-64/query_join_ms` (lower better) | Main: **2.12**<br>Candidate: **1.93**<br>Change: **-8.96%** | Main: **1.91**<br>Candidate: **1.94**<br>Change: **+1.57%** |
