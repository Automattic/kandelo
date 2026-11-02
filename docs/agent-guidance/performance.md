# Performance Contract

Performance is subordinate to correctness, POSIX behavior, internal integrity,
and host parity. A faster path that weakens syscall semantics, hides wakeups,
drops diagnostics, changes observable process behavior, or diverges Node and
browser is not an acceptable optimization.

Do not make performance claims without benchmark evidence. "Faster," "no
regression," "neutral," and "harmless" are claims when presented as facts. If
you did not measure, say that performance was not measured.

Explicit performance work, broad performance claims, and syscall hot-path
changes require all benchmark suites on both Node and browser, with before/after
comparison. Narrower benchmark scopes are acceptable only for non-performance
changes with plausible performance risk, or for claims that are explicitly
bounded to one app, host, or subsystem.

Run the benchmark scope that matches the claim or risk:

| Situation | Evidence |
|---|---|
| Explicit performance work or broad performance claim | All benchmark suites on Node and browser, before/after comparison |
| Reintroducing or changing syscall hot-path behavior | Micro-benchmark plus all application suites on Node and browser |
| Host-specific improvement | Relevant suites on that host, plus explanation why the other host is unaffected |
| Application-specific improvement | The affected app suite, plus enough surrounding coverage to rule out broad regressions |
| Non-performance change with plausible performance risk | Representative Node and browser suites matched to the affected subsystem |

Full performance suite:

```bash
npx tsx benchmarks/run.ts --rounds=3
npx tsx benchmarks/run.ts --host=browser --rounds=3
npx tsx benchmarks/compare.ts benchmarks/results/before.json benchmarks/results/after.json
```

If a benchmark suite skips because its binary is missing, the claim is not
proven. Build or fetch the prerequisite before drawing conclusions.

Node benchmarks measure the compiled host bundle. A stale `host/dist` bundle
stops the run with the rebuild command (`scripts/dev-shell.sh ./run.sh build
host`) instead of silently measuring the slower `tsx` fallback; each result
records the path that ran in `hostWorker`. Measure the `tsx` path only on
purpose, with `--kernel-worker=tsx`, and never compare it against a bundled
result. See [profiling](../profiling.md#kernel-worker-path).

## Comparing the finished change with its destination

For a claim about performance after merge, compare the latest runtime with
the target branch at a recorded commit. An improvement over an intermediate
PR revision does not prove an improvement over main. Build each side with
its own SDK, kernel and ABI-matched programs and images. Record artifact
hashes and disclose any build-only changes needed to prepare the baseline.

Use alternating baseline/candidate order on an otherwise quiet machine.
Keep fresh-worker timings, repeated workloads and clock-only diagnostics
separate. State when workers share one Node or browser parent process;
those workers are not independent parent-process launches. Check timer
resolution before interpreting a small difference, and retain the original
results when rechecking a flag.

Use CPU and allocation profiles to investigate causes, separately from
uninstrumented timings. Align worker and profiler clocks with a shared
marker before assigning samples to a workload phase. Confirm whether an
allocation sampler includes objects already collected. Fewer temporary
objects do not by themselves prove shorter garbage-collection pauses.
See [architecture reflections](../architecture-reflections.md#measure-the-whole-request-against-the-merge-target)
for the reasoning and [profiling](../profiling.md) for measurement details.

## Keep syscall dispatch simple

Do not repeat known-bad syscall hot-path "optimizations" in
`host/src/kernel-worker.ts`:

- syscall argument count tables to avoid reading unused args;
- syscall classification sets to skip wakeup/event draining;
- cached `DataView` or `Int32Array` objects on channel structs;
- conditional debug-ring logging for "trivial" syscalls.

Those changes were already benchmarked and made application workloads worse
while increasing correctness risk. The host hot path should stay simple unless
new benchmark evidence across application workloads proves otherwise.

The dedicated kernel worker architecture is load-bearing performance work. Do
not move `CentralizedKernelWorker` back to the main thread, add polling in
place of `Atomics.waitAsync`, or make UI/main-thread scheduling part of syscall
dispatch.
