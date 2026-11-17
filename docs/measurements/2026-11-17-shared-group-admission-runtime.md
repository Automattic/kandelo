# Shared-group admission: ordinary runtime validation

This records the admission-only kernel candidate, not grouped execution or the
finished desktop feature. Ordinary execution remains selected. Performance
results are mixed, and the Node file-write cost remains an open review concern.

## Inputs and method

- Candidate runtime: `1a834217bd9d9cdae92fcab5ac15a1a7fa9c4f14`.
- Comparator: develop `715243ed0aa1a8564a0dd8ad4bcef331ac3ca18a`.
  The fetched develop advancement `bcc8b0c7` changes one test classification row.
- Each arm used its own normally prepared ABI-matched SDK/kernel/program/image
  artifacts. Source and artifact hashes stayed fixed throughout each campaign.
- Darwin arm64, Node v24.22.1; browser benchmarks used Chromium. All nine enabled
  suites completed. The existing Erlang exclusion remained explicit.
- Three alternating independent CLI launches per arm/host, one suite round per
  launch. Tables report medians of those launch results. Processes within one
  parent are not independent parent launches.
- No overlapping tracked builds/tests were accepted. Explicit existing preview
  servers remained available with their process identities and CPU deltas
  recorded. This does not establish an otherwise idle operating system.

Normal CLI preparation passed for both arms: 330/330 nodes and 11/11 canonical
products each. The candidate passed the ABI/supported-program baseline checks,
4,113 native library tests, 47 actual-kernel admission checks, all eight
Node/Chromium conformance wrappers, and the full browser-memory gate (300 host,
three Node, seven Bun and 18 Chromium/Firefox/WebKit cases). Existing expected
failures/skips remain recorded. Retirement fences in the admission fixture are
simulated inputs. Firefox reported an owned temporary-directory cleanup warning;
that warning remains in the retained full log.

## File-write investigation

Throughput is MiB/s; larger is better. These are separate experiments, not
interchangeable samples or confidence bounds.

| Experiment | Ordinary develop | Admission candidate | Change |
|---|---:|---:|---:|
| Complete nine-suite matrix, Node | 63.26 | 48.51 | -23.3% |
| Focused syscall-I/O follow-up, Node | 58.11 | 54.56 | -6.1% |
| Complete nine-suite matrix, Chromium | 70.03 | 77.19 | +10.2% |
| Focused syscall-I/O follow-up, Chromium | 76.57 | 76.95 | +0.5% |
| Persistent-kernel Node, predeclared steady window | 153.79 | 147.35 | -4.2% |

The focused follow-up used three independent CLI pairs per host and three
in-process rounds per CLI. All three Node launch pairs were slower. Some other
initial I/O leads changed direction or attenuated, including reads and pipes.

The persistent-kernel follow-up used three fresh Node parent pairs and twelve
ordinary process launches per one dedicated kernel. Iteration 0 was retained as
cold, iteration 1 as warming, and iterations 2–11 were the predeclared steady
window. All six CLI launches and 72 guest launches passed without tracked load
overlap. Paired steady differences were +8.4%, -11.1%, and -4.2%. Cold and warming
medians changed by +21.5% and -9.7%, with wide launch variation. The steady result
does not clear or replace the original fresh-kernel regression.

Private profiler runs had equal syscall/write counts and no retries or pending
pipes. They ran with source instrumentation and concurrent build load, so they
are investigative evidence only. No source-level cause has been established.
There is no performance-neutrality or universal speedup claim.

## Complete Node matrix

Units are in metric names. Lower times and larger throughput are better; byte
counts describe resources. Bold formatting is the comparison tool's regression
highlight, not a statistical significance test.

| Benchmark | Before | After | Change |
|-----------|--------|-------|--------|
| mariadb-aria-64/bootstrap_ms | 2307.75 | 2192.74 | -5.0% |
| mariadb-aria-64/query_create_ms | 255.82 | 250.96 | -1.9% |
| mariadb-aria-64/query_insert_ms | 1038.34 | 1045.12 | +0.7% |
| mariadb-aria-64/query_join_ms | 96.22 | 91.14 | -5.3% |
| mariadb-aria-64/query_select_ms | 111.34 | 120.01 | **+7.8%** |
| mariadb-aria/bootstrap_ms | 2450.02 | 2180.39 | -11.0% |
| mariadb-aria/query_create_ms | 265.26 | 254.43 | -4.1% |
| mariadb-aria/query_insert_ms | 1014.37 | 960.47 | -5.3% |
| mariadb-aria/query_join_ms | 89.66 | 92.57 | +3.2% |
| mariadb-aria/query_select_ms | 115.76 | 111.12 | -4.0% |
| mariadb-innodb-64/bootstrap_ms | 2040.15 | 2053.72 | +0.7% |
| mariadb-innodb-64/query_create_ms | 229.8 | 238.5 | +3.8% |
| mariadb-innodb-64/query_insert_ms | 272.28 | 297.83 | **+9.4%** |
| mariadb-innodb-64/query_join_ms | 90.53 | 89.35 | -1.3% |
| mariadb-innodb-64/query_select_ms | 96.04 | 96.98 | +1.0% |
| mariadb-innodb/bootstrap_ms | 1981.41 | 2018.51 | +1.9% |
| mariadb-innodb/query_create_ms | 236.03 | 234.44 | -0.7% |
| mariadb-innodb/query_insert_ms | 292.67 | 274.09 | -6.3% |
| mariadb-innodb/query_join_ms | 88.42 | 87.55 | -1.0% |
| mariadb-innodb/query_select_ms | 94.51 | 93.39 | -1.2% |
| process-lifecycle/clone_ms | 69.83 | 66.56 | -4.7% |
| process-lifecycle/exec_ms | 427.64 | 421.18 | -1.5% |
| process-lifecycle/fork_ms | 82.43 | 82.06 | -0.4% |
| process-lifecycle/hello_start_ms | 339.6 | 338.4 | -0.4% |
| spawn-scratch/spawn_large_first_ms | 65.86 | 64.88 | -1.5% |
| spawn-scratch/spawn_large_repeat_ms | 64.81 | 65.32 | +0.8% |
| spawn-scratch/spawn_large_wire_bytes | 84386 | 84386 | 0.0% |
| spawn-scratch/spawn_ms | 77.55 | 73.34 | -5.4% |
| spawn-scratch/spawn_scratch_kernel_bytes | 10485760 | 10485760 | 0.0% |
| stdin-throughput/stdin_mbps | 864.9 | 837.64 | -3.2% |
| syscall-io/epoll_ready_us_per_op | 29.56 | 28.59 | -3.3% |
| syscall-io/file_read_mbps | 116.37 | 110.2 | **-5.3%** |
| syscall-io/file_write_mbps | 63.26 | 48.51 | **-23.3%** |
| syscall-io/lock_dense_file_acquire_us_per_op | 26.16 | 25.4 | -2.9% |
| syscall-io/lock_dense_file_conflict_us_per_op | 24.17 | 23.6 | -2.4% |
| syscall-io/lock_dense_file_replace_us_per_op | 25.38 | 25.74 | +1.4% |
| syscall-io/lock_dense_file_unlock_us_per_op | 27.11 | 24.84 | -8.4% |
| syscall-io/lock_many_files_acquire_us_per_op | 28.68 | 31.17 | **+8.7%** |
| syscall-io/lock_many_files_conflict_us_per_op | 27.71 | 26.46 | -4.5% |
| syscall-io/lock_many_files_replace_us_per_op | 30.02 | 29.56 | -1.5% |
| syscall-io/lock_many_files_unlock_us_per_op | 24.46 | 24.22 | -1.0% |
| syscall-io/pipe_mbps | 50.47 | 47.53 | **-5.8%** |
| syscall-io/poll_ready_us_per_op | 27.77 | 29.65 | **+6.8%** |
| syscall-io/poll_timeout_us_per_op | 1394.74 | 1403.85 | +0.7% |
| syscall-io/select_timeout_us_per_op | 1441.86 | 1422.93 | -1.3% |
| syscall-io/syscall_latency_us | 32.74 | 33.37 | +1.9% |
| wordpress/cli_require_ms | 526.46 | 551.09 | +4.7% |
| wordpress/http_first_response_ms | 3227.65 | 3150.62 | -2.4% |

## Complete Chromium matrix

| Benchmark | Before | After | Change |
|-----------|--------|-------|--------|
| mariadb-aria-64/bootstrap_ms | 1147.13 | 1199.58 | +4.6% |
| mariadb-aria-64/query_create_ms | 13.96 | 14.73 | **+5.5%** |
| mariadb-aria-64/query_insert_ms | 87.94 | 86.5 | -1.6% |
| mariadb-aria-64/query_join_ms | 2.03 | 1.77 | -12.8% |
| mariadb-aria-64/query_select_ms | 7.22 | 6.99 | -3.2% |
| mariadb-aria/bootstrap_ms | 1148.19 | 1078.49 | -6.1% |
| mariadb-aria/query_create_ms | 15.4 | 17.1 | **+11.0%** |
| mariadb-aria/query_insert_ms | 102.84 | 106.28 | +3.3% |
| mariadb-aria/query_join_ms | 1.77 | 1.84 | +4.0% |
| mariadb-aria/query_select_ms | 7.32 | 7.99 | **+9.2%** |
| mariadb-innodb-64/bootstrap_ms | 1092.06 | 1077.49 | -1.3% |
| mariadb-innodb-64/query_create_ms | 22.07 | 24.74 | **+12.1%** |
| mariadb-innodb-64/query_insert_ms | 145.03 | 148.8 | +2.6% |
| mariadb-innodb-64/query_join_ms | 2.14 | 2.12 | -0.9% |
| mariadb-innodb-64/query_select_ms | 7.75 | 7.57 | -2.3% |
| mariadb-innodb/bootstrap_ms | 1092.79 | 1155.61 | **+5.7%** |
| mariadb-innodb/query_create_ms | 23.66 | 21.52 | -9.0% |
| mariadb-innodb/query_insert_ms | 151.32 | 144.16 | -4.7% |
| mariadb-innodb/query_join_ms | 1.78 | 1.73 | -2.8% |
| mariadb-innodb/query_select_ms | 6.85 | 6.98 | +1.9% |
| process-lifecycle/clone_ms | 35.6 | 32.95 | -7.4% |
| process-lifecycle/fork_ms | 52 | 46.06 | -11.4% |
| process-lifecycle/hello_start_ms | 196.61 | 188.33 | -4.2% |
| spawn-scratch/spawn_large_first_ms | 31.37 | 29.49 | -6.0% |
| spawn-scratch/spawn_large_repeat_ms | 32.4 | 30.78 | -5.0% |
| spawn-scratch/spawn_large_wire_bytes | 84386 | 84386 | 0.0% |
| spawn-scratch/spawn_ms | 43.01 | 43.01 | 0.0% |
| spawn-scratch/spawn_scratch_kernel_bytes | 10485760 | 10485760 | 0.0% |
| stdin-throughput/stdin_mbps | 691.14 | 761.42 | +10.2% |
| syscall-io/file_read_mbps | 103.19 | 108.05 | +4.7% |
| syscall-io/file_write_mbps | 70.03 | 77.19 | +10.2% |
| syscall-io/lock_dense_file_acquire_us_per_op | 27.32 | 26.37 | -3.5% |
| syscall-io/lock_dense_file_conflict_us_per_op | 28.53 | 26.84 | -5.9% |
| syscall-io/lock_dense_file_replace_us_per_op | 27.87 | 27.91 | +0.1% |
| syscall-io/lock_dense_file_unlock_us_per_op | 25.27 | 24.82 | -1.8% |
| syscall-io/lock_many_files_acquire_us_per_op | 32.44 | 32.32 | -0.4% |
| syscall-io/lock_many_files_conflict_us_per_op | 25.75 | 27.44 | **+6.6%** |
| syscall-io/lock_many_files_replace_us_per_op | 35.04 | 32.92 | -6.1% |
| syscall-io/lock_many_files_unlock_us_per_op | 28.51 | 27.56 | -3.3% |
| syscall-io/pipe_mbps | 48.97 | 53.29 | +8.8% |
| syscall-io/syscall_latency_us | 29.38 | 29.97 | +2.0% |
| wordpress/boot_ms | 8668.47 | 8605.15 | -0.7% |
| wordpress/http_first_response_ms | 205.85 | 205.48 | -0.2% |

## Retained evidence and remaining work

The workspace retains original logs, raw reports, artifact/source identities,
preview CPU accounting and failed attempts under:

- `.context/shared-develop-integration-1/performance-complete-1/retention.json`
- `.context/shared-develop-integration-1/io-followup-1/retention.json`
- `.context/shared-develop-integration-1/write-profile-1/retention.json`
- `.context/shared-develop-integration-1/persistent-write-complete-1/retention.json`
- `.context/shared-develop-integration-1/persistent-write-overlap-1/retention.json`

An earlier persistent pair overlapped another workspace's native compilation and
was rejected by the load guard. Both raw arms remain retained as exploratory
results; the clean campaign restarted all three pairs. The SDK checkout's
separate package-provisioning failure is retained independently and did not
produce either benchmark arm's artifacts.

Kernel admission does not implement normal grouped launch, physical-page
retirement, descriptor-backed objects, graphics ownership or a usable normal
Sway/Foot image. Those remain later stages. Merge review must account for the
ordinary-write findings; passing correctness checks does not establish that
resource costs are acceptable for the finished feature.
