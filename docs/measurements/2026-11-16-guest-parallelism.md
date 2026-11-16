# Guest parallelism measurements — 2026-11-16

## Purpose and conclusion

This record establishes whether Kandelo guest processes and threads execute
in parallel, which decides what `sysconf(_SC_NPROCESSORS_ONLN)` must report.

Guest computation runs in parallel. Every process and thread is its own host
Worker, and eight CPU-bound workers finished in about the time one took on
Node.js, Chromium, Firefox and WebKit. Syscalls do not run in parallel: they
are all served by the one kernel worker. With syscall-bound workers, total
throughput stops growing at about four workers.

The kernel therefore reports the host's available parallelism as the processor
count (see `docs/posix-status.md`, `sysconf()`). That count describes where
guest code can run, not how many syscalls the kernel serves at once.

These are correctness measurements. They do not measure any build, and they
make no claim about build speed.

## Source and environment

- Base commit `768475048e73` (`develop`), with the processor-count change in
  the working tree. The parallelism results do not depend on that change; the
  first Node.js sweep ran before it, when `sysconf` still reported 1.
- Apple M3 Max, 14 CPUs (10 performance, 4 efficiency), macOS.
- Node.js v24.22.1; Playwright 1.63.0 with Chromium 153.0.8010.12,
  Firefox 155.0 and WebKit 26.6.
- The machine was shared with other build agents. Its 1-minute load average
  was 7 to 20 during the runs, so absolute times vary between repetitions, and
  scaling past 8 workers mostly measured contention.

## Method

`benchmarks/programs/cpu-parallel.c`, compiled with `wasm32posix-cc -O2
-pthread` and fork-instrumented. It starts `n` workers that each do the same
fixed work, and prints the wall time from the first start to the last exit.
If workers run in parallel, the time stays near the `n = 1` time; if they are
serialized, it grows about `n` times.

- `cpu` work: 200 million iterations of an arithmetic loop that makes no
  syscalls.
- `sys` work: 20,000 `getppid()` calls, each a round trip to the kernel
  worker.
- `thread`: `pthread_create` and `pthread_join`. `fork`: `fork`, then `wait`.
  Fork time is included, so `fork` rows grow with `n` even when the children
  run in parallel.

Node.js runs used a `NodeKernelHost` with no root filesystem image. Browser
runs used the test-runner page (`/pages/test-runner/?minimal=1`) through
Playwright. Each row is one run; most configurations ran twice.

## Results

CPU-bound work, wall time in milliseconds, first and second run. Speedup is
8 times the `n = 1` time divided by the `n = 8` time of the same run.

| Host | `thread` n=1 | n=2 | n=4 | n=8 | Speedup at n=8 | `fork` n=8 |
|---|---|---|---|---|---|---|
| Node.js | 693, 706 | 1086, 683 | 897, 701 | 759, 876 | 7.3x, 6.4x | 1369, 1440 |
| Chromium | 617, 636 | 618, 645 | 650, 645 | 678, 672 | 7.3x, 7.6x | 914, 910 |
| Firefox | 1063, 1078 | 1063, 1164 | 1104, 1187 | 1802, 1273 | 4.7x, 6.8x | 1245, 1742 |
| WebKit | 613, 588 | 588, 606 | 625, 650 | 864, 686 | 5.7x, 6.9x | 1210, 1135 |

Node.js `thread` runs at higher counts, in one run each with a load average
of 10 to 14 on 14 CPUs: n=12 took 1242 ms, n=14 1480 ms and n=28 2533 ms
against 731 ms for n=1.

Node.js can also start top-level processes directly. Eight concurrent
`NodeKernelHost.spawn` calls of the `n = 1` program took 1099 and 1519 ms,
against 783 and 823 ms for one.

Syscall-bound work: total `getppid()` calls per second across all workers,
from the `thread` rows.

| Host | n=1 | n=2 | n=4 | n=8 |
|---|---|---|---|---|
| Node.js | 25k–35k | 59k–60k | 74k–76k | 63k–75k |
| Chromium | 35k–38k | 64k–65k | 82k–84k | 93k–96k |
| Firefox | 13k–32k | 36k–37k | 34k–45k | 48k–50k |
| WebKit | 27k–32k | 49k–50k | 65k–66k | 76k–78k |

One worker leaves the kernel worker idle while the calling thread receives
each result, so a second worker raises throughput. Past four workers,
throughput grows little: the kernel worker is busy all the time.

## Reported processor counts

With the change, a `cpu-parallel info` run reported:

| Host | Host value | `_SC_NPROCESSORS_ONLN` / `_CONF` |
|---|---|---|
| Node.js | `os.availableParallelism()` = 14 | 14 / 14 |
| Chromium | `navigator.hardwareConcurrency` = 14 | 14 / 14 |
| Firefox | `navigator.hardwareConcurrency` = 14 | 14 / 14 |
| WebKit | `navigator.hardwareConcurrency` = 8 | 8 / 8 |

WebKit reports 8 on this 14-CPU machine. Kandelo reports the value its host
reveals, so a guest under WebKit sees 8 processors.

## Reproducing

Inside `scripts/dev-shell.sh`, after `scripts/build-programs.sh`:

```bash
npx tsx examples/run-example.ts benchmarks/wasm/cpu-parallel.wasm thread 8 200000000
npx tsx examples/run-example.ts benchmarks/wasm/cpu-parallel.wasm thread 8 20000 sys
```

The browser rows came from a temporary Playwright spec that ran the same
binary through `window.__runTest` on the test-runner page. That spec is not
committed.
