# Profiling and reducing native instrumentation overhead

The quiet baseline still took 2.8–3.4 times Walrus's CLI wall time on
Gawk, Coreutils and Bash. This report measures three targeted changes to
the instrumenter. It does not measure package build time or application
execution on Node or browsers.

## Exact real-package inputs

Every backend reads the same original SDK link output. Compiler facts remain
bound to the original instruction offsets; no Binaryen pass runs before
instrumentation. Bash uses the untouched link before its recipe optimizes a
separate copy. Archive/input hashes and build provenance are preserved in the
[quiet baseline](2026-10-24-native-package-instrumentation-idle.json).

| Package | Input bytes | Functions including imports | Operators | Work |
|---|---:|---:|---:|---|
| sed 4.9 | 329,303 | 695 | 126,556 | no-op |
| grep 3.11 | 386,499 | 820 | 150,137 | no-op |
| make 4.4.1 | 428,883 | 752 | 162,074 | no-op |
| gawk 5.3.0 | 2,384,170 | 1,598 | 336,873 | fork rewrite |
| coreutils 9.6 | 6,431,132 | 3,484 | 700,637 | fork rewrite |
| bash 5.2.37 | 5,244,315 | 2,496 | 448,419 | fork rewrite |

Each timed run is a fresh process. Both raw backends use two Rayon threads
where applicable; native body processing remains serial. CLI Binaryen uses
its normal default concurrency. All fork-using native runs report compiler
facts as their analysis source, without fallback.

## What the profile found

Separate macOS stack-sampling runs used a symbolized release executable
with the same production source as the quiet baseline. Each sampled the
complete native transform, without Binaryen, at 1 ms intervals until exit.
These diagnostics are separate from the unprofiled measurements below.

| Stack category (inclusive) | Gawk samples | Coreutils samples | Bash samples |
|---|---:|---:|---:|
| All sampled stacks | 3,671 | 2,152 | 4,783 |
| SQLite shared-lock acquisition | 728 | 214 | 734 |
| SHA-256 hashing | 264 | 718 | 521 |
| Body loading/decoding | 450 | 200 | 887 |
| Callee specialization | 1,161 | 362 | 2,691 |

Categories overlap and are not additive CPU percentages. Phase logs put
Gawk child-continuation analysis at about 2.1 seconds and emission at
0.1 seconds. Bash performs two sink plans under its normal side-module
policy. These observations favor eliminating repeated analysis overhead
before experimenting with emission batching.

## Changes

- Retain the exclusive SQLite lock for the private, single-connection
  temporary database. Queries no longer repeat file-lock and filesystem
  checks. Transactions still finish normally and dirty pages still spill.
- Compute the original module's content fingerprint once per immutable
  scan. Frozen plans still reject the wrong module, including different
  bytes with the same section shape. Independently scanned copies of the
  same bytes remain valid.
- Memoize indirect/reference target selection under one frozen policy.
  The cache has a 2 MiB estimated payload allowance, includes the original
  point/invocation/selector/tail status in its keys, and evicts on pressure.
  Oversized entries use database queries. Return/throw summaries and
  specialized effects remain separate and are recomputed as before.

No function IR cache, function batching, Walrus change or ABI change is
introduced. All before/intermediate/after output hashes match for every
package, backend, raw/CLI path and repeat.

## Production CLI before and after

Median seconds, three fresh processes per backend/package/stage, serial
with alternating backend order. CLI includes Binaryen `--post-optimize Os`
at its normal concurrency. Measurements used an Apple M5 Max with 18 CPU cores, 48 GiB RAM and
macOS 27.0.1. No substantial background build load was observed during
measurement stages; ordinary desktop apps remained active.

| Package | Walrus current | Native before | Native lock/hash fixes | Native all fixes | Native time reduction |
|---|---:|---:|---:|---:|---:|
| gawk | 1.715 | 4.771 | 3.445 | 2.732 | 42.7% |
| coreutils | 0.868 | 2.884 | 1.808 | 1.684 | 41.6% |
| bash | 2.579 | 7.804 | 5.825 | 4.919 | 37.0% |

The earlier [quiet baseline](2026-10-24-native-package-instrumentation-idle.md)
and [build-load comparison](2026-10-24-native-package-instrumentation.md)
remain separately pinned. Input bytes and executable hashes are recorded
in each stage's metadata. Walrus timings in this table are from the final
matched run; native before/intermediate columns are earlier serial stages,
not simultaneous measurements.

## Final raw transform measurements

Median (range). Seconds for wall/CPU; MiB for OS lifetime physical peak.
Includes immutable snapshots, analysis, planning, rewriting, feature
metadata, structural validation, atomic publication and checksums. Excludes
Binaryen and separate Node compilation/policy checks. The raw example tracks
requested Rust allocations; CLI timings use the normal executable.

| Package | Walrus wall | Native wall | Walrus CPU | Native CPU | Walrus physical MiB | Native physical MiB |
|---|---:|---:|---:|---:|---:|---:|
| sed | 0.029 (0.027–0.257) | 0.017 (0.016–0.017) | 0.019 (0.019–0.023) | 0.009 (0.009–0.009) | 24.09 (24.09–24.23) | 2.88 (2.88–2.88) |
| grep | 0.029 (0.029–0.029) | 0.018 (0.016–0.018) | 0.021 (0.021–0.022) | 0.010 (0.009–0.010) | 28.19 (28.13–28.20) | 2.95 (2.95–2.97) |
| make | 0.033 (0.032–0.033) | 0.018 (0.018–0.018) | 0.023 (0.023–0.023) | 0.010 (0.010–0.010) | 29.67 (29.67–29.77) | 2.92 (2.91–2.94) |
| gawk | 1.000 (0.997–1.018) | 1.858 (1.854–1.878) | 0.987 (0.985–1.004) | 1.845 (1.842–1.858) | 120.89 (120.84–120.94) | 28.31 (27.89–30.42) |
| coreutils | 0.528 (0.525–0.558) | 1.279 (1.275–1.284) | 0.513 (0.509–0.529) | 1.261 (1.260–1.264) | 164.98 (164.45–165.02) | 26.92 (26.89–27.45) |
| bash | 1.990 (1.974–2.000) | 4.103 (4.076–4.155) | 1.975 (1.959–1.978) | 4.085 (4.061–4.130) | 148.11 (146.70–148.23) | 25.61 (25.42–26.58) |

Physical footprint differs from RSS. Requested Rust allocations exclude
SQLite allocations, native stacks and allocator overhead; temporary disk
storage is additional. CLI optimizer-child memory is not included in these
raw transform peaks. The small bounded target cache retains no function IR.

## Final CLI measurements

Seconds, median (range). CPU includes waited-for Binaryen descendants.

| Package | Walrus wall | Native wall | Walrus CPU | Native CPU |
|---|---:|---:|---:|---:|
| sed | 0.027 (0.025–0.145) | 0.017 (0.014–0.020) | 0.018 (0.018–0.020) | 0.008 (0.007–0.010) |
| grep | 0.029 (0.027–0.029) | 0.017 (0.014–0.017) | 0.020 (0.020–0.020) | 0.008 (0.008–0.008) |
| make | 0.030 (0.030–0.031) | 0.017 (0.017–0.017) | 0.021 (0.021–0.021) | 0.008 (0.008–0.008) |
| gawk | 1.715 (1.704–1.743) | 2.732 (2.731–2.769) | 6.888 (6.865–6.978) | 8.849 (8.819–8.874) |
| coreutils | 0.868 (0.868–0.883) | 1.684 (1.676–1.697) | 3.619 (3.616–3.626) | 4.418 (4.413–4.433) |
| bash | 2.579 (2.563–2.584) | 4.919 (4.910–4.921) | 7.821 (7.795–7.822) | 11.314 (11.309–11.360) |

Sed, grep and make remain byte-identical no-op controls. Their installers
normally bypass instrumentation, so these times do not imply faster builds.
Fork-using outputs retain exactly their previous sizes and hashes.

## Optimized output sizes

These are final production CLI outputs after the same `Os` pass. Their bytes
and hashes are unchanged by the three native performance fixes.

| Package | Walrus bytes | Native bytes | Native growth |
|---|---:|---:|---:|
| gawk | 1,417,765 | 1,491,007 | 5.17% |
| coreutils | 1,773,842 | 1,776,533 | 0.15% |
| bash | 1,892,830 | 2,093,021 | 10.58% |

## Controlled shapes

The final source also passed all 42 complete controlled transforms and 42
separate compilation/production-contract/normal-execution checks. All input
and output hashes match the earlier lexical snapshot exactly, including
both backends. Measurements remain serial, alternating and guarded at 1 GiB
with a 120-second deadline. Binaryen is excluded.

Median seconds and raw physical MiB. The earlier native column is the pinned
historical lexical run, not a fresh quiet baseline; the Walrus/current native
columns are paired in the new run. Full current ranges and hashes are in the
machine-readable results.

| Shape | Walrus seconds | Earlier native seconds | Current native seconds | Walrus MiB | Native MiB |
|---|---:|---:|---:|---:|---:|
| arithmetic-wide | 0.801 | 0.667 | 0.481 | 173.20 | 4.84 |
| many-tiny | 0.121 | 0.573 | 0.292 | 82.45 | 12.64 |
| one-large | 0.131 | 0.096 | 0.075 | 74.83 | 33.09 |
| facts-heavy | 0.038 | 0.336 | 0.194 | 42.58 | 16.89 |
| data-heavy | 0.129 | 1.033 | 0.172 | 48.11 | 4.11 |
| caught-child | 0.013 | 0.017 | 0.017 | 3.25 | 3.45 |
| child-exit | 0.013 | 0.016 | 0.014 | 3.03 | 3.48 |

Many-tiny and facts-heavy remain slower than Walrus. Repeated body decoding,
abstract interpretation and specialization are remaining profiling targets;
no claim of speed parity or a proven benefit from function batching is made.
Small absolute timings include process/guard overhead. Controlled evidence is
in `.context/memory-comparison-profile-fixes/`.

## Validation and provenance

All three stages passed 72 transforms and 72 separate Node compilation /
production artifact-policy checks each: 216 of each in total. No package
program was executed. All six original input hashes are unchanged; repeated
output hashes are deterministic and raw ABI/data fingerprints agree between
backends. The existing 16 GiB / 30-minute guards did not fire.

The Rust workspace excluding xtask passed 3,201 tests with no failures or
skips for these changes. The added
regression checks repeated source identity across independent allocations,
and target-cache disable/oversize/eviction behavior across changing selectors
and return/throw summaries. Broader host/browser application benchmarks and
package runtime conformance are outside this instrumenter timing claim.

The [machine-readable results](2026-10-24-native-instrumentation-profile-fixes.json)
include all stages, ranges, executable/source fingerprints, load averages,
allocation peaks and output hashes. Exact final source and binaries are in
`.context/native-profile-fixes-build/`; raw final traces and artifacts are in
`.context/package-performance-profile-fixes/`. Profiles and baseline phase
logs are in `.context/native-idle-profile/`; the intermediate build is in
`.context/native-lock-hash-build/`. Reproduction uses the
[package comparison script](../profiling.md#fork-instrumenter-package-comparisons).
