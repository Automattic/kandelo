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
guest memory.grow and host allocation can consume safely. The existing C growth
helper advances the high-water cursor and cannot consume the JavaScript-only
free pool. Reducing scratch or pregrowth also needs actual correctness/resource
evidence; this screen does not attribute the OS overhead to a single component.
Keep those changes isolated from the user's frozen interactive demo.

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
