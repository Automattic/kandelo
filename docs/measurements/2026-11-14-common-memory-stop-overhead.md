# Format-2 execution-stop instruction costs — November 14, 2026

This measures the extra checks needed to stop a translated process before
publishing its signal death. It compares unvirtualized WebAssembly, translated
WebAssembly without stop checks, and translated WebAssembly with the current
format-2 checks. **Unvirtualized is Wasm in the same engine, not machine-native
code.** The unchecked format-1 arm is an experimental timing control; it is
unsafe for shared-group signal retirement and is refused by the current host.

The standalone handwritten Wasm fixture contains seven source functions and
thirteen inserted stop-check sites. Arithmetic and calls have no guest memory
accesses. Read/write wrap within 64 KiB; atomics repeatedly update one word;
each copy iteration copies 1 MiB. This differs from the earlier C survey:
its ratios must not be interpreted as a change from those historical results.
There is no PHP, WordPress, syscall, fork, or lifecycle latency measurement here.

## Method

Apple M5 Max, arm64 macOS, 18 logical CPUs, 48 GiB memory. Node 24.15.0
(V8 13.6.233.17-node.48), Chromium 153.0.8010.12, Firefox 155.0, and Playwright
WebKit 26.6. These are automated browser engines, not a native Safari run.
The run started at 07:28 UTC, November 14, after the long acceptance job ended
and before the next preparation build. Four preview servers remained running.
The recorded starting load averages were 1.72/3.29/4.47. This records observed
load, not proof of whole-machine idleness.

Each host has two fresh parent cohorts and nine alternating-order measurements
per variant/operation/cohort: 1,296 raw samples. Work is calibrated against the
unvirtualized arm toward 35 ms, with the same iteration count across variants
within a cohort. Compilation, construction and memory resets are excluded.
All arms use a shared backing, initially 4 MiB with a 64 MiB ceiling; translated
arms expose 2 MiB of logical guest memory. Correctness checks compare return
values and all 2 MiB of logical memory, and require native Wasm trapping on
revocation. Every host passed these checks. Timed returns are also compared.

Cells report median time per iteration for the unvirtualized control and ratios
of pooled medians over 18 samples per variant. Translation and translation +
stops are relative to unvirtualized. Stop increment is relative to translation
without checks. Both separate-cohort estimates and paired ratios are retained
in the JSON. No confidence intervals were collected; timer quantization was
not recorded within the original cohorts. Small differences, especially around
one percent, do not establish gains.

## Results

| Operation | Node | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| arithmetic | Unvirtualized: **0.874 ns/iteration**<br>Translation: **1.000×**<br>Translation + stops: **1.002×**<br>Stop increment: **+0.2%** | Unvirtualized: **0.875 ns/iteration**<br>Translation: **1.000×**<br>Translation + stops: **1.001×**<br>Stop increment: **+0.1%** | Unvirtualized: **0.875 ns/iteration**<br>Translation: **1.001×**<br>Translation + stops: **1.006×**<br>Stop increment: **+0.5%** | Unvirtualized: **0.878 ns/iteration**<br>Translation: **1.000×**<br>Translation + stops: **1.745×**<br>Stop increment: **+74.6%** |
| calls | Unvirtualized: **0.873 ns/iteration**<br>Translation: **1.000×**<br>Translation + stops: **1.007×**<br>Stop increment: **+0.6%** | Unvirtualized: **0.875 ns/iteration**<br>Translation: **1.001×**<br>Translation + stops: **1.008×**<br>Stop increment: **+0.7%** | Unvirtualized: **0.875 ns/iteration**<br>Translation: **1.001×**<br>Translation + stops: **1.004×**<br>Stop increment: **+0.3%** | Unvirtualized: **0.877 ns/iteration**<br>Translation: **1.000×**<br>Translation + stops: **3.493×**<br>Stop increment: **+249.4%** |
| read | Unvirtualized: **0.279 ns/iteration**<br>Translation: **6.317×**<br>Translation + stops: **6.892×**<br>Stop increment: **+9.1%** | Unvirtualized: **0.269 ns/iteration**<br>Translation: **6.792×**<br>Translation + stops: **7.169×**<br>Stop increment: **+5.6%** | Unvirtualized: **0.390 ns/iteration**<br>Translation: **4.745×**<br>Translation + stops: **5.157×**<br>Stop increment: **+8.7%** | Unvirtualized: **0.271 ns/iteration**<br>Translation: **5.763×**<br>Translation + stops: **6.730×**<br>Stop increment: **+16.8%** |
| write | Unvirtualized: **0.270 ns/iteration**<br>Translation: **8.927×**<br>Translation + stops: **9.061×**<br>Stop increment: **+1.5%** | Unvirtualized: **0.257 ns/iteration**<br>Translation: **9.515×**<br>Translation + stops: **9.778×**<br>Stop increment: **+2.8%** | Unvirtualized: **0.268 ns/iteration**<br>Translation: **10.206×**<br>Translation + stops: **10.261×**<br>Stop increment: **+0.5%** | Unvirtualized: **0.280 ns/iteration**<br>Translation: **7.521×**<br>Translation + stops: **8.277×**<br>Stop increment: **+10.1%** |
| atomic | Unvirtualized: **1.529 ns/iteration**<br>Translation: **1.218×**<br>Translation + stops: **1.334×**<br>Stop increment: **+9.5%** | Unvirtualized: **1.531 ns/iteration**<br>Translation: **1.301×**<br>Translation + stops: **1.340×**<br>Stop increment: **+3.0%** | Unvirtualized: **1.763 ns/iteration**<br>Translation: **1.694×**<br>Translation + stops: **2.469×**<br>Stop increment: **+45.7%** | Unvirtualized: **1.533 ns/iteration**<br>Translation: **1.168×**<br>Translation + stops: **1.462×**<br>Stop increment: **+25.1%** |
| copy | Unvirtualized: **11003.497 ns/iteration**<br>Translation: **1.006×**<br>Translation + stops: **1.005×**<br>Stop increment: **-0.1%** | Unvirtualized: **11003.118 ns/iteration**<br>Translation: **1.004×**<br>Translation + stops: **1.005×**<br>Stop increment: **+0.0%** | Unvirtualized: **21800.000 ns/iteration**<br>Translation: **1.002×**<br>Translation + stops: **1.005×**<br>Stop increment: **+0.3%** | Unvirtualized: **11161.016 ns/iteration**<br>Translation: **0.997×**<br>Translation + stops: **1.009×**<br>Stop increment: **+1.1%** |

## Interpretation and next work

The large stop-check effects repeat in both parent cohorts: WebKit arithmetic
adds 75.1%/74.4%, WebKit calls adds 249.5%/248.2%, and Firefox atomics adds
45.6%/45.7% over translation without checks. Node, Chromium and Firefox show
small arithmetic/call differences in this fixture. Copy differences are small;
these data do not establish a bulk-copy improvement.

The tight read/write loops also show substantial translation costs against
an exceptionally fast unvirtualized baseline. These are instruction throughput
observations, not predictions of end-to-end PHP latency or compiler optimality.
The safe current checks remain enabled. A useful retained follow-up is to
analyze bounded leaf callees and call-graph cycles to avoid redundant function
entry checks while retaining polls on every unbounded execution path, including
recursive cycles and indirect calls. That idea is unimplemented and unmeasured;
kill latency and shared-write retirement must remain correctness gates.

A matched current-format PHP/WordPress measurement remains unrun. The later
[ordinary-runtime before/after comparison](2026-11-14-common-memory-default-regression.md)
completes the canonical suite coverage and retains adverse deltas; it does not
measure translated PHP request latency. These results do not establish release
or merge readiness, and do not change the timestamp-validation recommendation.

## Reproduction and retained evidence

The retained archive is
`.context/common-memory-stop-overhead-20261114/evidence-v2.zip`; its manifest
records independent SHA-256 readback for every entry. It contains the fixture,
three Wasm artifacts and translation reports, all eight raw timing JSON files,
input hashes, environment/load record, managed-job log, analyzer, and this
report. All fifteen recorded measured input hashes match. The original run is
`common-memory-stop-overhead-timing-1114-022823-7784` (exit 0, 1m55s).

The scripts use the original `.scratch/common-memory-stop-overhead-1` layout.
Restore that layout in a checkout with the recorded dependencies and inspect
the retained input hashes. The rebuild command below writes a separate fresh
fixture directory; the timing command measures the restored frozen artifacts
in the original layout. It does not automatically select the rebuilt files.
Use the declared dev shell for both. `run-timings.sh` refuses to
overwrite existing cohort outputs: move the restored historical result files
to a separate evidence directory before starting a new run. Preserve new
results separately and record the new environment rather than replacing the
historical measurements.

```sh
scripts/dev-shell.sh bash .scratch/common-memory-stop-overhead-1/rebuild.sh .scratch/common-memory-stop-overhead-rebuild
scripts/dev-shell.sh bash .scratch/common-memory-stop-overhead-1/run-timings.sh
scripts/dev-shell.sh python3 .scratch/analyze-common-memory-stop-overhead.py
```
