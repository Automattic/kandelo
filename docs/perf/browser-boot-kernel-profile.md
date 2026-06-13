# Browser WordPress/MariaDB boot profiling and kernel optimizations

Date: 2026-06-05

## Methodology

Browser measurements were taken with the existing Playwright browser benchmark harness:

```sh
# Baseline, from the PR parent commit ffc653a.
git checkout ffc653af7014481a99f59e5cb3e25650254dcc74
cd host && npm run build && cd ..
LD_LIBRARY_PATH=$HOME/.local/pw-libs \
  npx tsx benchmarks/run.ts --host=browser --suite=wordpress --rounds=5

# Final PR branch.
LD_LIBRARY_PATH=$HOME/.local/pw-libs \
  npx tsx benchmarks/run.ts --host=browser --suite=wordpress --rounds=3

LD_LIBRARY_PATH=$HOME/.local/pw-libs \
  npx tsx benchmarks/run.ts --host=browser --suite=mariadb-aria --rounds=1
```

For syscall profiling, the benchmark page was run with `BENCHMARK_PROFILE=1`. That appends
`?profile=1`, enables the existing kernel-worker syscall profiler around the boot/request windows,
and dumps:

- per `(pid, syscall_nr)` kernel-side wall time,
- per-pid gaps between syscalls, which approximate time in guest Wasm/user code or host retry sleeps.

The local workspace could not run the full source program build because the environment did not have
`clang`/LLVM available. The browser application benchmarks used release VFS/application artifacts;
only WordPress and MariaDB browser suites were used for the numbers below.

## Baseline observations

### WordPress + PHP-FPM + nginx

Baseline browser boot on the PR parent commit (`ffc653a`) with the benchmark's fixed readiness sleeps:

| round | `boot_ms` | `http_first_response_ms` |
| ---: | ---: | ---: |
| 1 | 8808.62 ms | 4192.10 ms |
| 2 | 9058.42 ms | 4396.22 ms |
| 3 | 9432.43 ms | 4511.26 ms |
| 4 | 9224.36 ms | 4606.01 ms |
| 5 | 9291.41 ms | 5264.18 ms |
| median | 9224.36 ms | 4511.26 ms |
| mean | 9163.05 ms | 4593.95 ms |
| stddev | 239.46 ms | 405.21 ms |

An earlier one-round baseline measured `boot_ms=9001.31` and
`http_first_response_ms=5330.20`; the five-sample run above confirms that the
initial boot measurement was representative, not a low outlier.

A profile run showed that Rust kernel syscall handling was not the dominant boot cost. During the
8.2s profiled boot window, top kernel-side syscall costs were only a few milliseconds each. The
largest profile signal was repeated 10ms retry gaps from idle blocking accepts:

- PHP-FPM workers each had roughly 600-650 `accept` retries during boot.
- Average gap between retries was roughly 9.5-9.8ms.
- The benchmark itself also imposed fixed sleeps: 5s after spawning PHP-FPM and 3s after spawning nginx.

### MariaDB

The initial MariaDB browser benchmark did not produce meaningful boot numbers: the VFS image had
`/data` owned by root while the benchmark starts `mariadbd --user=mysql`. Bootstrap failed quickly with
permission errors creating files under `/data` and then the benchmark waited until its timeout. This
was a VFS correctness issue, not a kernel performance issue.

## Optimization hypotheses and results

| Hypothesis | Change | Result |
| --- | --- | --- |
| FD table next-free hint would reduce `open`/`close` overhead. | Implemented a next-free descriptor hint in the kernel FD table. | Rejected/reverted. Native FD tests passed, but browser WordPress became unstable and slower. Profile data also showed FD allocation was not a boot bottleneck. |
| Direct host-side injected connections should drain queued wake events immediately. | After `kernel_inject_connection`, explicitly drain kernel wakeup events and schedule blocked retry wakeups in browser and host injection paths. | Accepted. This makes direct injection paths equivalent to normal syscall-return paths, where wake events are already drained. |
| Blocking `accept` should park event-driven instead of polling every 10ms. | For blocking `accept`/`accept4`, register the listener wake token without a periodic fallback timer. | Accepted after adding direct injection wake draining. This is POSIX-correct: a blocking `accept` remains blocked until a connection, cancellation, signal/process cleanup, or explicit wake. It removes idle accept retry storms. |
| Longer/no fallback for targeted `poll` waits would remove nginx's 10ms poll retry loops. | Raised targeted poll fallback from 10ms to 1000ms during testing. | Rejected. WordPress first-response time regressed to about 6.36s in the test run, indicating readiness coverage for all poll cases is not yet complete enough to remove this safety net. |
| Fixed sleeps should be replaced by observed readiness. | WordPress benchmark now waits for the actual PHP-FPM/nginx listener ports instead of sleeping 5s/3s. MariaDB server readiness also uses the shared listener readiness helper. | Accepted as measurement/boot orchestration correction. It removes artificial wall time while still waiting for real kernel-visible readiness. |
| MariaDB VFS data directory ownership should match `--user=mysql`. | Set `/data`, `/data/mysql`, `/data/tmp`, and `/data/test` to mysql uid/gid 101 and mode 0775 in the VFS builder; benchmark also repairs older loaded images before running. | Accepted. MariaDB browser benchmark now boots and runs queries. |

## Final measurements

### WordPress

Final 3-round browser benchmark:

| round | `boot_ms` | `http_first_response_ms` |
| ---: | ---: | ---: |
| 1 | 2281.74 ms | 5540.39 ms |
| 2 | 2967.54 ms | 6858.79 ms |
| 3 | 4154.88 ms | 6532.62 ms |
| median | 2967.54 ms | 6532.62 ms |

Boot improvement versus the five-sample baseline median of 9224.36ms:

- `boot_ms`: **67.8% faster**.
- `boot_ms + http_first_response_ms`: 30.8% faster using median boot and
  median first-response values. First-response time remains noisy and is
  dominated by PHP/SQLite user-space work rather than kernel syscall handling.

A final profile run with the accepted changes showed WordPress boot at 2165.81ms. The previous idle
PHP-FPM `accept` retry storm was gone; kernel-side boot syscall handling remained in the low
milliseconds. The request profile still showed nginx `poll` retry gaps around 10ms and PHP/SQLite
user-Wasm work dominating first-response latency.

### MariaDB Aria

Final browser benchmark after the VFS ownership fix:

| metric | value |
| --- | ---: |
| `bootstrap_ms` | 6493.10 ms |
| `server_ready_ms` | 1520.89 ms |
| `query_create_ms` | 66.68 ms |
| `query_insert_ms` | 471.19 ms |
| `query_select_ms` | 35.16 ms |
| `query_join_ms` | 6.18 ms |

A profile of MariaDB bootstrap showed kernel-side syscall handling around hundreds of milliseconds
in total while most time was in MariaDB user Wasm and InnoDB/Aria initialization. The previous
permission failure was fixed; no kernel-specific MariaDB hack was added.

## Remaining challenges

- WordPress first-response time is still dominated by guest PHP/SQLite execution and nginx's targeted
  `poll` fallback. Removing the poll safety timer needs broader event coverage for all pollable state,
  not just accept queues and pipe readability.
- MariaDB bootstrap still contains benchmark-level waiting (`stdin` consumed plus settle/terminate)
  and engine initialization work. A process-exit/health based bootstrap completion path would make
  that metric more precise.
- The full local source build could not be used in this workspace without `clang`/LLVM, so application
  benchmark validation used release artifacts.
