# Additional native instrumentation performance rounds, 2026-10-24

The native backend retains its low-memory design but has not reached
Walrus throughput on the three fork-using real packages measured here.
These are host instrumenter measurements, not guest runtime benchmarks.
Walrus remains unchanged and is still the default backend.

## Method and provenance

Use the same immutable original SDK-link inputs, versions, compiler facts,
Mac and validation policy as the [preceding comparison](2026-10-24-native-instrumentation-profile-fixes.md).
Run three fresh serial processes per backend, alternating order. No builds
or test suites ran alongside the timing matrices. Ordinary desktop apps
remained active. Each CLI timing includes Binaryen `Os`; raw transform
measurements exclude Binaryen. Memory is the raw process's lifetime peak
physical footprint, not resident set size or optimizer-child memory.

The [machine-readable evidence](2026-10-24-native-instrumentation-additional-rounds.json)
records binary hashes, exact source-file hashes, source patch hashes,
input hashes, wall ranges, output hashes and checks for every stage. The
source base is `53f8db8184810a4378b40475abcb369649056f01`, plus the recorded
stage-specific source. The final commit also fixes atom-cache invalidation
on transaction failure; the successful transform path is unchanged.

All 144 transforms and 144 separate Node compilation/artifact-policy
checks passed. Every output hash matches the preceding three-fix baseline
within its backend, phase and input. These package checks do not execute
guest software. Full runtime/ABI verification of the latest optimizations
is still pending; this is a progress report, not completion evidence.

## Measured rounds

CLI wall medians, in seconds. W means Walrus; N means native.

| Stage | Gawk W / N | Coreutils W / N | Bash W / N |
|---|---:|---:|---:|
| Batched writes and inline operands | 1.729 / 2.664 | 0.862 / 1.579 | 2.566 / 4.788 |
| Bounded hot-callee IR cache | 1.720 / 2.280 | 0.865 / 1.510 | 2.552 / 3.905 |
| Callee-first summary order | 1.679 / 2.239 | 0.849 / 1.394 | 2.559 / 3.618 |
| Experimental speed compilation | 1.612 / 2.051 | 0.822 / 1.280 | 2.480 / 3.305 |

The first three rounds use the repository's ordinary size-optimized
release profile. The last round compiles both backends and all host
dependencies with `CARGO_PROFILE_RELEASE_OPT_LEVEL=3`. This compiler setting
is experimental and has not been adopted by the production build script.
Do not attribute its improvement solely to source changes.

The source changes batch private SQLite writes while retaining dirty-page
spilling; keep up to four popped operands inline; move non-loop entry
states; stop normal dead-code suffix walks when injection traversal is
unneeded; cache specialized callee bodies within an estimated 8 MiB payload
allowance; and initially visit direct callees before callers. Fixed-point
revisits still handle recursion and indirect dependencies. The cache has
capacity-based accounting, eviction and transient oversized entries; it
never retains a complete module instruction graph.

Latest experimental raw transform medians:

| Package | Walrus wall | Native wall | Walrus peak | Native peak |
|---|---:|---:|---:|---:|
| Gawk 5.3.0 | 0.875 s | 1.159 s | 132.69 MiB | 36.11 MiB |
| Coreutils 9.6 | 0.478 s | 0.908 s | 196.56 MiB | 36.36 MiB |
| Bash 5.2.37 | 1.838 s | 2.429 s | 173.53 MiB | 37.45 MiB |

Native remains 27%, 56% and 33% slower in the CLI comparison. More profiling
and optimization are needed to reach the requested parity target.
