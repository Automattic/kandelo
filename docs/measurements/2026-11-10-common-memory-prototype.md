# Common-memory process groups: mechanism and translation cost

Measured November 10, 2026 on an Apple M5 Max, arm64 macOS, 18 logical CPUs,
48 GiB RAM. Engines: Node 24.15.0 / V8 13.6, Chromium 153.0.8010.12,
Firefox 155.0 and Playwright WebKit 26.6. This is a standalone mechanism
experiment, not a shipping runtime change or PHP performance result.

The [prototype](../../tools/common-memory-prototype/README.md) imports one
shared Wasm memory into multiple instances and Workers. Each instance has a
virtual page table. Private backing pages are copied by a harness clone;
shared mappings retain common backing. Stored pointers remain unchanged.
The clone is not Kandelo's fork continuation or a kernel process creation.

Node and all three browser engines passed six mechanism groups: private and
shared pointer graphs, nested private-page clones and aliases, split-page
operations, bounds/permissions, CAS, bulk and overlapping copies, quiescent
remap, and actual two-Worker atomics and wait/notify through aliases. Each
host also passed 6,000 scalar operations against an independent byte model
(2,986 expected access refusals). A deliberately broken clone that shares
private pages was rejected by the independent parent check.

## Diagnostic cost estimates

The table reports median elapsed-time ratios against matched untranslated
native Wasm accessing the same common memory. Values above 1 mean slower.
Translation includes virtual bounds, permission and cross-page checks.

| Workload, 64 KiB working set | Node | Chromium | Firefox | WebKit |
|---|---:|---:|---:|---:|
| Sequential i32 reads | 2.09× | 2.14× | 2.74× | 1.90× |
| Dependent pointer chasing | 1.56× | 1.52× | 1.72× | 1.66× |
| Sequential i32 writes | 2.02× | 2.04× | 4.56× | 1.93× |
| Uncontended atomic i32 RMW | 1.01× | 1.02× | 1.03× | 1.00× |
| Repeated 64 KiB copy | 1.00× | 1.07× | 1.00× | 1.02× |

Node sequential reads measured 0.301 ns/native operation and 0.629 ns/inline
translated operation. Writes measured 0.299 versus 0.604 ns. These are
amortized hot-loop costs, not the latency of an isolated load. The minimal
Wasm-helper-call control measured 1.584 and 1.535 ns respectively. It uses
the same resolver, without the old Madison helper's lease/revocation work;
this does not measure a replacement for that whole implementation.

An 8 MiB working set was also measured. Sequential read/write ratios broadly
persisted. Large pointer-chase samples remained variable: native/inline
max-to-min sample ranges reached 2.42×/3.00× on Node, 1.75× for Chromium's
inline samples, and 1.75×/1.89× on Firefox. Do not treat their median ratios
as precise estimates. Bulk-copy samples also had wide ranges on WebKit and
in Chromium's inline control; their near-native medians do not prove zero
overhead or a speedup.

Each case has nine rotated/reversed rounds, three warmups per variant and
a common iteration count calibrated on native toward 50 ms, capped at
134,217,728 iterations. Some fast capped samples lasted about 40 ms.
Pointer chasing traverses at least four graphs plus a remainder with a
nonzero independently modeled checksum. Setup, compilation and Worker launch
are excluded. The small page table is cache-friendly. Other work ran on the
machine; this is not a controlled benchmark cohort. There is one fresh Node
parent and one browser launch per engine in each full run.

## Evidence and next boundary

The [reviewed raw report](../../.context/common-memory-20261110/reviewed/summary.md)
links by proximity to per-host JSON containing every sample and checksum,
host versions/load snapshots, generated WAT/Wasm and source/artifact hashes.
The retained `sources/` directory contains exact reviewed inputs. The first
exploratory run is preserved separately: its large Node chase was unstable,
and the reviewed fixture subsequently strengthened warmup/iteration coverage
and its independent chase checksum. Source and artifact hashes stayed fixed
throughout the reviewed run. Python/JavaScript/Bash syntax and whitespace
checks passed.

This supports feasibility of the trusted common-memory mapping mechanism
and a nontrivial scalar translation cost. It does not establish PHP request
latency, compiler coverage, general process isolation, concurrent mapping
revocation or kernel/host interoperability. No general C/Wasm rewriter,
Kandelo fork, PHP-FPM/OPcache build, canonical image, platform conformance or
full-platform benchmark suite ran. Shipping runtime, ABI, SDK and PHP recipe
are unchanged. PHP integration remains the next experimental stage after
reviewing this cost gate.

## Follow-up: optimizer options

The prototype originally assembled WAT with WABT without a subsequent
Binaryen pass. A follow-up added an explicit `none|O2|O3|Oz` option, keeping
`none` as the default. `run.sh <fresh-directory> bench O3` applies ordinary
trap-preserving optimization to all three artifacts. Build/provenance JSON
records the selected flags and tool versions. Only `none` and `O3` received
this follow-up's full mechanism/benchmark runs; `O2` and `Oz` remain unmeasured.

Fresh baseline and `-O3` artifacts both passed Node and all three browser
engines, including the independent oracle and broken-clone negative control.
Sources and artifacts stayed unchanged throughout both runs. With WABT
1.0.36 and Binaryen 126, `-O3 --enable-threads --enable-bulk-memory` reduced
the inline module from 2,367 to 2,040 bytes (13.8%). Disassembly of its read
loop still contains the per-iteration virtual-bounds check, page-table load,
permission check, cross-page branch and payload load. It has two static
`i32.load` sites in that function before and after optimization; this is not
a dynamic instruction-count claim.

The timing screen is inconclusive. The Node baseline began with a one-minute
host load average of 25.56, while the Node optimized run began at 93.89, on
18 logical CPUs. Baseline and candidate ran in separate blocks. Changing
background load, wide sample ranges and these ordering differences prevent
a controlled speedup/regression claim. Do not use the numerical screen to
select `-O3` as a new default. Exact results, disassembly and sources are
retained under [the optimizer evidence](../../.context/common-memory-optimizer-20261110/comparison.json).

The next useful instrumentation experiments are a nonfaulting guard that
decodes a contiguous span once for a block/loop, proved-alignment removal of
cross-page branches, and guarded reuse of a decoded page. These need a
mapping-lifetime guarantee and generic fallback preserving original fault
and side-effect order. A Wasm load's alignment hint alone is not a proof.
One common memory would let validated spans use direct physical addressing
for either private or shared bytes; mutable shared data must remain live.
Actual C/LLVM applicability and benefit remain unmeasured in this prototype.

The normal PHP recipe already compiles with `-O2` and invokes Wasm
optimization. Its fork-aware pipeline and code-bound compiler facts must be
preserved when adding a new transformation. The standalone optimizer option
does not establish PHP or fork-pipeline integration.
