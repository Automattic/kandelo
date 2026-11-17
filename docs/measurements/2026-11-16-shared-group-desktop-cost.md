# Current grouped desktop resource screen

The format-4 desktop candidate still shows a useful capacity/interaction
tradeoff, with higher total reported browser footprint. This is a bounded
Sway/Foot comparison on Chromium, not a claim about the integrated feature or
all Kandelo workloads. It uses the final pthread candidate rather than reusing
older format-3 timings.

## Method

Job `shared-group-format4-cost-1116-011055-ad12` passed all six launches in
2m57s on November 16. Its command was:

```sh
scripts/dev-shell.sh bash .context/run-shared-group-format4-cost.sh
```

Each arm owns a fresh Chromium process tree; order is ordinary, grouped,
grouped, ordinary, ordinary, grouped. Both use the same frozen adapter-15 host
and kernel, with the paired ordinary/grouped desktop images. Display is
1920x1080, with unchanged GLES renderer, configuration and limits. This lower
resolution lets the ordinary arm finish the same two-terminal workload; the
3072x1728 failure/capacity comparison is separate.

The run began after the known peer Node benchmark job exited. The user's
interactive demo remained available; possible activity there is unmeasured
background load. System load averages are retained per launch. This is not a
claim of an otherwise idle dedicated benchmark machine. No profiles or syscall
traces ran. OS footprint sampling happened after the timed input phase.

Input measurement is Enter evdev injection to actual `ok\n` shell-output
verification through a VFS notification, with fifteen probes per launch. It
is not input-to-photon latency. CPU is the sum of CDP CPU-time deltas for stable
owned Chromium processes during the paced input phase, excluding the Node
coordinator. Each reported arm value below is a median of three launch values;
the fifteen probes are not independent browser launches.

## Results

| Measurement | Ordinary | Grouped |
|---|---|---|
| Start to mapped terminal | Median: **22,498 ms**<br>Range: **21,854–22,965 ms** | Median: **22,282 ms**<br>Range: **22,236–22,345 ms** |
| Per-launch median verified shell response | Median: **19.235 ms**<br>Range: **16.320–20.620 ms** | Median: **3.690 ms**<br>Range: **2.415–4.065 ms** |
| Per-launch p95 verified shell response | Median: **29.675 ms**<br>Range: **24.985–33.390 ms** | Median: **7.900 ms**<br>Range: **5.265–7.975 ms** |
| Owned browser CPU during paced typing | Median: **3.471 s**<br>Range: **3.465–3.487 s** | Median: **2.842 s**<br>Range: **2.794–2.891 s** |
| OS-reported browser-tree footprint, one terminal | Median: **1,989.00 MiB**<br>Range: **1,969.62–1,992.65 MiB** | Median: **2,106.72 MiB**<br>Range: **2,088.70–2,127.92 MiB** |
| OS-reported browser-tree footprint, two tiled terminals | Median: **2,129.06 MiB**<br>Range: **2,118.11–2,133.50 MiB** | Median: **2,263.26 MiB**<br>Range: **2,245.89–2,282.12 MiB** |
| OS-reported browser-tree footprint, separate workspaces | Median: **2,160.05 MiB**<br>Range: **2,158.53–2,164.76 MiB** | Median: **2,260.92 MiB**<br>Range: **2,217.81–2,281.80 MiB** |

In this screen, the median-of-launch-medians shell response is about 81% lower
and typing CPU about 18% lower. Separate-workspace footprint is about 101 MiB
higher. These are descriptive comparisons from three launches per arm, not
confidence bounds or a universal speedup. Startup is effectively similar at
this sample size. The format-4 wait work did not erase the promising interaction
result in this particular workload.

## Next resource work

The first grouped launch's post-retile logical accounting reports roughly
40.7 MiB of runtime overhead, 34.1 MiB reusable and 16.4 MiB retained, plus
mapped payload. These are logical ownership categories, not independent OS
footprints. The full group capacity remains 512 MiB pregrown; ordinary helper
process memories are separate. Later samples before machine destruction can
still contain outstanding asynchronous retirement, so those samples alone do
not establish a leak.

The priority is a shared authoritative allocator/reuse model that both translated
guest memory.grow and host allocation can consume safely. The frozen prototype's
C growth helper advances the high-water cursor and cannot consume the JavaScript-only
free pool. Reducing scratch or pregrowth also needs actual correctness/resource
evidence; this screen does not attribute the OS overhead to a single component.
Keep those changes isolated from the user's frozen interactive demo.

## November 17 follow-up

A separate experiment using the unchanged format-4 runtime completed twenty Foot launch,
hidden-workspace, retile and close cycles in one persistent Sway machine per
arm/engine. There were six fresh browser parents: ordinary and grouped on
Chromium, Firefox and WebKit. These are twenty cycles within each parent,
not twenty independent browser launches. Canonical SDK compilation ran in
the background; this run makes allocation/lifecycle observations, not CPU or
latency claims.

All six arms completed the twenty cycles, kept the original terminal, removed
each closed client, exited Sway with status zero, and completed machine
destruction without page errors or memory-boundary violations. The campaign
**failed** its predeclared Chromium grouped allocation plateau: the final five
settled allocation extents were required to be identical.

| Grouped engine | Initial extent (MiB) | Extent after 20 cycles (MiB) | Final five extents |
|---|---:|---:|---|
| Chromium | 163.62 | 198.94 | Changed; criterion failed |
| Firefox | 163.62 | 192.56 | Flat |
| WebKit | 163.62 | 192.56 | Flat |

Chromium's final five extents were 174.94, 174.94, 198.94, 198.94 and 198.94 MiB.
Firefox and WebKit ended at a flat 192.56 MiB over that window. A flat ending
in a bounded run does not establish indefinite boundedness; the late Chromium
increase does not by itself prove an unbounded leak.

These extents describe the allocator's physical-page high-water position,
within the same pregrown 512 MiB backing. They are not OS footprints or RSS.
At Chromium's final settled sample, 80.56 MiB was reusable; its live group
returned to four roots, with no quarantine or unexplained pins. The retired-root
counter advanced by sixty across the twenty client cycles. This narrows the
resource question to live application high-water behavior and allocation/reuse;
it does not identify a single cause or prove the normal feature's reclamation.
Post-root-exit samples can still contain asynchronous retirement.

An earlier attempt incorrectly required the prototype's `pendingSnapshots`
counter to reach zero at startup. That counter includes graphical-object and
thread-scratch pins: the sampled live desktop had eight object pins and two
thread pins. The corrected observation accounts for these owners and requires
no unexplained pins, the baseline root count and no quarantine. The twenty-cycle
inventory and physical plateau criterion were unchanged. The original failed
attempt remains retained.

Response-observation qualification also completed on both arms in all three
engines. Eighteen shell-produced color responses had negative controls before
Enter, actual PNG pixel checks, matching shell completion files, and clean
exit/destroy/boundary checks. A follow-up agreed with all eighteen PNGs using
one-pixel readback from the transferred canvas. The once-per-animation-frame
observer then passed eighteen probes with same-page input/observation clocks
and independent post-interval PNG/completion checks. These qualify a correlated
**rendered canvas** observation mechanism, not physical scanout, input-to-photon,
or a quiet before/after latency comparison. Readback and sampling costs remain
part of the observation.

Original results, failed harness attempts, source identities and all six
lifecycle trajectories are retained under:

- `.context/format4-desktop-lifecycle-complete-1/retention.json`
- `.context/format4-desktop-lifecycle-pin-predicate-failure-1/retention.json`
- `.context/format4-presentation-correlation-complete-1/retention.json`
- `.context/format4-canvas-readback-complete-1/retention.json`
- `.context/format4-latency-method-qualified-1/retention.json`

The formal SDK's shared allocation bitmap is separate work; it has not been
integrated into this frozen desktop and does not retroactively change these
numbers. The preview still needs application-level resource and normal-runtime
acceptance. The interactive demo, renderer and limits were preserved.

## Provenance and limits

The inputs are the frozen host5/kernel1/paired format-4 images identified in the
[baseline record](2026-11-16-shared-memory-desktop-baseline.md). Exact hashes,
source provenance, all six raw runs, footprint tool output, load observations,
presentation-counter observations and aggregate calculations are retained in
`.scratch/shared-group-format4-cost-1` and the retained checkpoint for this phase.
The source base is 5d05771f28fc805e3267f061c669a8d6fd8538b5. The normal shipping
extraction starts separately from origin/main f8612113e7; that is not the
runtime measured here. Other browser engines, broad application benchmarks,
GPU frame times, input-to-photon latency and final main-versus-integrated
comparison are unmeasured by this job.
