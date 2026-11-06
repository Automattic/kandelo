# Matched instrumentation measurements on known packages

These are instrumenter timings on identical, original SDK-linked package
bytes. They do not measure guest application execution or complete package
build time. Walrus 0.26.4 and the native backend use the same immutable file
I/O and publication path. No instrumenter algorithm changed for this run.

Each backend ran three times in fresh processes, serially with alternating
order, through the declared macOS development shell. Two serial Clang
builds and other remaining build work were active on this 18-core Mac.
This is a comparison under background load: use the recorded CPU times,
ranges and load averages, and repeat idle before interpreting close timing
differences. All 72 raw/CLI
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
| sed 4.9 | 0.028 (0.028–0.189) | 0.017 (0.017–0.017) | 0.019 (0.019–0.020) | 0.009 (0.009–0.009) |
| grep 3.11 | 0.033 (0.030–0.033) | 0.018 (0.017–0.019) | 0.022 (0.022–0.022) | 0.010 (0.010–0.010) |
| make 4.4.1 | 0.033 (0.033–0.034) | 0.020 (0.018–0.020) | 0.023 (0.023–0.023) | 0.011 (0.010–0.012) |
| gawk 5.3.0 | 1.046 (1.023–1.144) | 4.241 (4.032–4.689) | 1.036 (1.012–1.117) | 4.078 (4.004–4.651) |
| coreutils 9.6 | 0.525 (0.519–0.531) | 2.556 (2.547–2.597) | 0.512 (0.509–0.515) | 2.541 (2.537–2.580) |
| bash 5.2.37 | 1.980 (1.957–1.997) | 7.018 (7.004–7.311) | 1.966 (1.946–1.982) | 6.995 (6.983–7.264) |

## Production CLI with post-optimization

The same inputs through the production CLI with `--post-optimize Os`.
CPU includes the waited-for Binaryen child at its normal default concurrency;
no-op CLI cases bypass Binaryen.
These are seconds, median (range), not guest execution timings.

| Package | Walrus wall | Native wall | Walrus CPU | Native CPU |
|---|---:|---:|---:|---:|
| sed 4.9 | 0.028 (0.028–0.028) | 0.017 (0.017–0.017) | 0.018 (0.018–0.018) | 0.008 (0.007–0.008) |
| grep 3.11 | 0.029 (0.029–0.030) | 0.017 (0.017–0.017) | 0.020 (0.020–0.020) | 0.008 (0.008–0.008) |
| make 4.4.1 | 0.030 (0.030–0.031) | 0.017 (0.017–0.017) | 0.021 (0.021–0.021) | 0.008 (0.008–0.008) |
| gawk 5.3.0 | 1.876 (1.768–2.087) | 5.423 (4.906–5.769) | 7.107 (6.974–7.223) | 11.555 (10.988–12.305) |
| coreutils 9.6 | 0.889 (0.885–0.891) | 2.945 (2.936–2.971) | 3.611 (3.610–3.621) | 5.660 (5.653–5.703) |
| bash 5.2.37 | 2.577 (2.576–2.761) | 7.885 (7.745–7.922) | 7.811 (7.758–7.972) | 14.222 (14.159–14.325) |

## Raw memory and optimized output size

Raw OS lifetime peak physical footprint in MiB, median (range). The CLI's
optimizer-child physical memory is not included in these raw measurements.
Physical footprint differs from resident set size; clean mapped input/output
pages are reclaimable. Requested Rust allocations exclude SQLite/C allocations,
native stacks and allocator overhead. Temporary disk storage is additional.

| Package | Walrus raw MiB | Native raw MiB | Walrus optimized bytes | Native optimized bytes |
|---|---:|---:|---:|---:|
| sed 4.9 | 24.16 (24.14–24.19) | 2.94 (2.94–2.94) | 329,303 | 329,303 |
| grep 3.11 | 28.20 (28.19–28.20) | 3.00 (3.00–3.00) | 386,499 | 386,499 |
| make 4.4.1 | 29.70 (29.69–29.72) | 2.97 (2.95–3.02) | 428,883 | 428,883 |
| gawk 5.3.0 | 120.98 (120.95–123.69) | 29.69 (29.61–31.56) | 1,417,765 | 1,491,007 |
| coreutils 9.6 | 165.22 (164.72–165.28) | 27.94 (27.88–28.56) | 1,773,842 | 1,776,533 |
| bash 5.2.37 | 146.55 (146.44–147.22) | 27.09 (26.81–27.30) | 1,892,830 | 2,093,021 |

## What these runs show

For the three fork-using packages, native raw physical peaks are 75–83%
lower, while the production CLI takes about 2.9–3.3 times as long. CPU time
also increases, so the observed overhead is not just waiting for CPU access.
These ratios describe this setup with background build work.

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

The [machine-readable summary](2026-10-24-native-package-instrumentation.json)
records the source commit, executable hashes, inputs, ranges and load averages.
Exact source/binaries are preserved in `.context/native-package-comparison-build/`;
raw guard traces, stdout/stderr, outputs and validators are in
`.context/package-performance-final/`. The public
[profiling guide](../profiling.md#fork-instrumenter-package-comparisons)
describes reproduction. Production sources match the lexical-replay snapshot;
only measurement helpers differ. These measurements do not establish package
runtime correctness, browser performance or original-Codex throughput.
