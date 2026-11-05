# Quiet-machine instrumentation measurements on known packages

These are instrumenter timings on identical, original SDK-linked package
bytes. They do not measure guest application execution or complete package
build time. Walrus 0.26.4 and the native backend use the same immutable file
I/O and publication path. No instrumenter algorithm changed for this run.

Each backend ran three times in fresh processes, serially with alternating
order, through the declared macOS development shell. The serial Clang builds had finished on this 18-core Mac.
No substantial background build load was observed; ordinary desktop apps
remained active. Pre-run load averages were 4.10 / 3.59 / 5.34. This is
the quiet-machine rerun of the earlier comparison under build load.
Use the recorded CPU times, ranges and load averages when comparing runs. All 72 raw/CLI
transforms and 72 separate Node compilation/production-policy checks passed.
Output hashes repeat within each backend; raw ABI descriptors and data
payload fingerprints agree. No package program was executed. No-op cases
remain byte-for-byte unchanged and are separate from fork rewrite work.

## Inputs

| Package | Input MiB | Functions including imports | Operators | Work |
|---|---:|---:|---:|---|
| sed 4.9 | 0.31 | 695 | 126,556 | no-op |
| grep 3.11 | 0.37 | 820 | 150,137 | no-op |
| make 4.4.1 | 0.41 | 752 | 162,074 | no-op |
| gawk 5.3.0 | 2.27 | 1,598 | 336,873 | fork rewrite |
| coreutils 9.6 | 6.13 | 3,484 | 700,637 | fork rewrite |
| bash 5.2.37 | 5.00 | 2,496 | 448,419 | fork rewrite |

The snapshots preserve original compiler facts and instruction offsets.
Bash's recipe optimizes a separate copy before its installer; this comparison
uses its untouched SDK link output. No Binaryen pass runs between those
compiler facts and instrumentation. Source archive/input hashes and recipe
provenance are in the machine-readable summary.

## Complete raw transforms

Seconds, median (range). Includes snapshots, analysis, planning, rewriting,
feature metadata, structural validation, atomic publication and checksums.
Binaryen and the separate Node checker are excluded. CPU time excludes the
external guard and includes all transform threads. Raw runs use the
allocation-counting example; CLI runs use the normal production executable.

| Package | Walrus wall | Native wall | Walrus CPU | Native CPU |
|---|---:|---:|---:|---:|
| sed 4.9 | 0.027 (0.027–0.035) | 0.017 (0.017–0.017) | 0.019 (0.018–0.020) | 0.009 (0.008–0.009) |
| grep 3.11 | 0.030 (0.029–0.033) | 0.018 (0.018–0.018) | 0.021 (0.021–0.023) | 0.009 (0.009–0.010) |
| make 4.4.1 | 0.033 (0.033–0.033) | 0.018 (0.018–0.018) | 0.023 (0.023–0.023) | 0.010 (0.010–0.010) |
| gawk 5.3.0 | 0.977 (0.976–0.982) | 3.867 (3.850–3.871) | 0.966 (0.964–0.967) | 3.840 (3.832–3.844) |
| coreutils 9.6 | 0.523 (0.521–0.542) | 2.533 (2.506–2.569) | 0.510 (0.510–0.516) | 2.508 (2.490–2.537) |
| bash 5.2.37 | 1.954 (1.951–1.973) | 7.000 (6.974–7.019) | 1.942 (1.937–1.956) | 6.973 (6.928–6.978) |

## Production CLI with post-optimization

The same inputs through the production CLI with `--post-optimize Os`.
CPU includes the waited-for Binaryen child at its normal default concurrency;
no-op CLI cases bypass Binaryen.
These are seconds, median (range), not guest execution timings.

| Package | Walrus wall | Native wall | Walrus CPU | Native CPU |
|---|---:|---:|---:|---:|
| sed 4.9 | 0.027 (0.025–0.029) | 0.017 (0.016–0.017) | 0.018 (0.018–0.019) | 0.007 (0.007–0.007) |
| grep 3.11 | 0.029 (0.027–0.030) | 0.017 (0.017–0.017) | 0.020 (0.019–0.021) | 0.008 (0.008–0.009) |
| make 4.4.1 | 0.030 (0.030–0.032) | 0.017 (0.016–0.017) | 0.022 (0.022–0.023) | 0.008 (0.008–0.009) |
| gawk 5.3.0 | 1.689 (1.675–1.726) | 4.771 (4.752–4.781) | 6.824 (6.815–6.903) | 10.824 (10.810–10.833) |
| coreutils 9.6 | 0.857 (0.850–0.864) | 2.884 (2.882–2.889) | 3.603 (3.562–3.608) | 5.612 (5.567–5.623) |
| bash 5.2.37 | 2.556 (2.550–2.563) | 7.804 (7.770–7.855) | 7.771 (7.761–7.780) | 14.186 (14.110–14.229) |

## Raw memory and optimized output size

Raw OS lifetime peak physical footprint in MiB, median (range). The CLI's
optimizer-child physical memory is not included in these raw measurements.
Physical footprint differs from resident set size; clean mapped input/output
pages are reclaimable. Requested Rust allocations exclude SQLite/C allocations,
native stacks and allocator overhead. Temporary disk storage is additional.

| Package | Walrus raw MiB | Native raw MiB | Walrus optimized bytes | Native optimized bytes |
|---|---:|---:|---:|---:|
| sed 4.9 | 24.16 (24.14–24.17) | 2.92 (2.92–2.95) | 329,303 | 329,303 |
| grep 3.11 | 28.17 (28.17–28.20) | 3.02 (3.00–3.03) | 386,499 | 386,499 |
| make 4.4.1 | 29.73 (29.70–29.80) | 2.98 (2.95–2.98) | 428,883 | 428,883 |
| gawk 5.3.0 | 120.92 (120.88–121.77) | 29.98 (29.59–30.20) | 1,417,765 | 1,491,007 |
| coreutils 9.6 | 164.81 (164.66–164.88) | 28.06 (27.86–28.94) | 1,773,842 | 1,776,533 |
| bash 5.2.37 | 148.00 (146.50–148.16) | 27.23 (27.17–27.59) | 1,892,830 | 2,093,021 |

## What these runs show

For the three fork-using packages, native raw physical peaks are 75–83%
lower, while the production CLI takes about 2.8–3.4 times as long. CPU time
also increases, so the observed overhead is not just waiting for CPU access.
These ratios describe this quieter rerun; the multiple-times slowdown
persists after the serial Clang builds finished. The earlier
[comparison under build load](2026-10-24-native-package-instrumentation.md)
is preserved separately.

The no-op probes are faster and smaller with native, but their normal
installer already bypasses instrumentation. They are not a package-build
speedup. Optimized outputs for fork-using packages grow by about 0.15–10.6%.

Small-function batching remains an untested optimization idea. An earlier
Gawk diagnostic under heavier load spent about 60 seconds in sink analysis
and 0.6 seconds in emission. It suggests profiling repeated analysis and
function decoding before focusing on emission batching. A cache or batch
should have an explicit byte budget to preserve the memory property; these
measurements do not establish which optimization will close the time gap.

## Provenance and limits

The [machine-readable summary](2026-10-24-native-package-instrumentation-idle.json)
records the source commit, executable hashes, inputs, ranges and load averages.
Exact source/binaries are preserved in `.context/native-package-comparison-build/`;
raw guard traces, stdout/stderr, outputs and validators are in
`.context/package-performance-idle-20261024/`. The public
[profiling guide](../profiling.md#fork-instrumenter-package-comparisons)
describes reproduction. Production sources match the lexical-replay snapshot;
only measurement helpers differ. These measurements do not establish package
runtime correctness, browser performance or original-Codex throughput.
