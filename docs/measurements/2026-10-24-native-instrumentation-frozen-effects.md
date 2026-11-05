# Native branch joins and frozen specialization, 2026-10-24

These four further host-instrumenter rounds follow the
[earlier four rounds](2026-10-24-native-instrumentation-additional-rounds.md).
All use the same speed-optimized compilation for both backends and their
host dependencies (`CARGO_PROFILE_RELEASE_OPT_LEVEL=3`). At measurement
this remains an experimental compiler setting, outside the production
build script. This report does not measure guest runtime performance.

Each package/backend/phase has three fresh serial runs, alternating backend
order, with no concurrent builds or suites. Ordinary desktop applications
remained active. CLI includes Binaryen `Os`; raw physical footprint excludes
Binaryen and its children. Inputs, versions, machine and validation match
the preceding report. All 144 transforms and 144 independent Node
compilation/artifact-policy checks passed. Every output hash matches the
preceding baseline within its backend, input and phase. Guest execution
and full latest-source runtime/ABI verification remain separate gates.

The [machine-readable evidence](2026-10-24-native-instrumentation-frozen-effects.json)
records exact input/binary/source hashes, source patches, wall ranges,
output sizes/hashes and validation outcomes. Source base is
`3c9f1aeb68fbeaa261a6655638d2c810212a0d4b` plus each recorded stage's sources.

## Changes and safety boundaries

1. Keep only active labels in a sorted nesting stack, avoiding per-label
   tree allocations. Move the first incoming branch's owned state into its
   join instead of cloning it again.
2. Batch target recording across the private phase, retaining SQLite's
   configured dirty-page spilling. A failed phase publishes no sink plan.
3. Move the completed normal-summary vector into a private interpreter
   session. Reuse specialized return/throw effects across roots within
   the existing 4 MiB allowance. The session cannot rebind summaries.
   Cache keys include recursion depth; newly escaped frames invalidate
   saved and pending effects. Subtrees that declined optional work are
   not cached across roots. Changing-summary evaluations retain their
   original per-root cache policy. Tests cover reuse, depth, work-budget
   fallback, frame invalidation and pending insertions.

## Results

Three-run CLI wall medians, seconds; W means Walrus and N means native.

| Stage | Gawk W / N | Coreutils W / N | Bash W / N |
|---|---:|---:|---:|
| Previous speed experiment | 1.612 / 2.051 | 0.822 / 1.280 | 2.480 / 3.305 |
| Active labels and branch ownership | 1.565 / 2.020 | 0.821 / 1.252 | 2.495 / 3.452 |
| Target write batching | 1.695 / 2.012 | 0.821 / 1.211 | 2.513 / 3.140 |
| Frozen specialization effects | 1.868 / 1.845 | 0.862 / 1.237 | 2.633 / 2.597 |

The last row is approximately CLI parity for Gawk and Bash in this run;
Coreutils remains 43% slower. Small CLI differences are not established
wins: the ranges and Walrus variation require a final paired recheck.

Latest raw transform medians:

| Package | Walrus wall | Native wall | Walrus physical peak | Native physical peak |
|---|---:|---:|---:|---:|
| Gawk 5.3.0 | 0.920 s | 0.912 s | 146.58 MiB | 36.55 MiB |
| Coreutils 9.6 | 0.481 s | 0.810 s | 170.81 MiB | 38.22 MiB |
| Bash 5.2.37 | 1.866 s | 1.630 s | 194.47 MiB | 37.64 MiB |

Native raw medians versus the previous speed experiment are 21%, 11% and
33% lower. These are separately timed stages; paired backend comparisons
above are the authority for the remaining Walrus gap. Walrus remains
unchanged and default. No source/registry modification, analysis weakening
or Walrus fallback was used.

## Scheduling experiment not retained

A fourth round visited escaping functions and their direct dependencies
before other roots, hoping to settle indirect targets earlier. Normal
summary evaluations barely changed: Gawk 6,806 to 6,799; Coreutils remained
6,202; Bash remained 6,996 and 3,540 across its two policy plans. This
extra ordering policy was removed rather than retained on timing noise.

| Package | Walrus CLI | Native CLI | Walrus raw | Native raw |
|---|---:|---:|---:|---:|
| Gawk | 1.697 s | 1.803 s | 0.857 s | 0.880 s |
| Coreutils | 0.834 s | 1.175 s | 0.477 s | 0.815 s |
| Bash | 2.431 s | 2.487 s | 1.804 s | 1.586 s |

These 36 transforms and 36 artifact checks also passed with unchanged
output hashes; their source/binary fingerprints remain in the JSON.
