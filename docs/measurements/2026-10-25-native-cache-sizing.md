# Native specialization cache sizing, 2026-10-25

A larger cache helps when the working set exceeds its allowance. The real
packages measured here fit within 4 MiB already; a controlled workload
with a 5.3 MiB working set improves by 41% at 16 MiB. Raising its allowance
to 64 MiB adds no benefit. Entries are allocated on demand.

The production default now scales with original function-body bytes:
`clamp(4 * code_bytes, 16 MiB, 64 MiB)`, using saturating arithmetic.
Data, debug and compiler-fact sections do not inflate the allowance.
Explicit library overrides remain available, including zero to disable
reuse. The ceiling controls eviction, not input admission or a process
memory limit. This policy is headroom for larger programs, not a claim
that every package needs or benefits from a larger cache.

## Method and exact sources

Each budget has three fresh serial timed processes with ascending and
reversed budget order. Separate diagnostic processes report hits, misses,
evictions and peak estimated cache payload. All runs include complete
transformation, original input snapshots, structural validation, output
publication and checksums. No Binaryen or guest execution is included in
the timings. No builds or test suites ran alongside timing matrices;
ordinary desktop applications and macOS services remained active.

Every output has a separate Node compilation/production artifact-policy
check. All 60 transforms and all 60 checks passed. Every output hash is
unchanged across budgets for its input. The stress output also passed
controlled normal execution through the generated runtime, returning 13.
It is an intentional cache-pressure fixture, not a real package or a
measurement of real guest application performance.

Both stages use the repository's speed-optimized `instrumenter` Cargo
profile. The real-package sizing experiment uses source base
`721e50e68de74ced7cb6cc1df43a254367ad6e7f` plus its recorded source files;
its measurement argument overrides the cache allowance explicitly.
The controlled stage uses clean production source
`73cc1c664efaf2ba89d7563e60bf8fb3a5383724` with explicit budget overrides.
The [JSON evidence](2026-10-25-native-cache-sizing.json) records binary,
input and source-file hashes, source-patch hashes, wall ranges, physical
and Rust allocation peaks, and each diagnostic session's counters.

## Real packages

Raw transform wall medians, seconds:

| Package | Disabled | 4 MiB | 16 MiB | 64 MiB |
|---|---:|---:|---:|---:|
| Gawk 5.3.0 | 1.618 | 0.887 | 0.869 | 0.874 |
| Coreutils 9.6 | 0.887 | 0.793 | 0.792 | 0.799 |
| Bash 5.2.37 | 3.457 | 1.571 | 1.571 | 1.588 |

These packages have zero evictions at every nonzero budget. Peak estimated
cache payload is 1.21 MiB for Gawk, 3.40 MiB for Coreutils, and 2.00/1.99 MiB
for Bash's two policy sessions. Their counters are identical at 4, 16 and
64 MiB. Small timing differences among those allowances do not establish
a speedup from extra capacity.

At 16 MiB allowance, median total process physical peaks are 35.70 MiB for
Gawk, 38.56 MiB for Coreutils and 37.23 MiB for Bash. These are process
footprints, distinct from estimated cache payload and Rust allocation
requests. The allowance is not a reservation.

## Controlled pressure

The generator emits two passes through 25,000 distinct constant calls to
one small helper, separated by a fork point. The helper stays within the
ordinary specialization rule. The repeated ordered set exposes FIFO
thrashing when it cannot fit, using a small original input rather than a
large all-module instruction graph.

| Cache allowance | Raw wall median | Total physical peak median | Hits | Misses | Evictions | Peak cache payload |
|---|---:|---:|---:|---:|---:|---:|
| 4 MiB | 0.344 s | 52.77 MiB | 0 | 125,000 | 106,276 | 4.00 MiB |
| 16 MiB | 0.203 s | 51.36 MiB | 100,000 | 25,000 | 0 | 5.34 MiB |
| 64 MiB | 0.205 s | 51.33 MiB | 100,000 | 25,000 | 0 | 5.34 MiB |

Counters come from separate diagnostic processes. Larger capacity avoids
repeated callee interpretation here without allocating the unused part
of the allowance. This demonstrates why a larger bounded budget can help;
it does not establish a particular speedup on the original large Codex
input. That latest-source capacity/performance rerun remains pending.

Reproduce with `memory_comparison generate-cache-pressure OUTPUT`, then
`scripts/profile-fork-instrument-cache.py --binary BINARY --output-dir DIR
--cache-mib 4 16 64 INPUT`. The same tool accepts real original SDK-link
inputs; it never executes them during measurement.
