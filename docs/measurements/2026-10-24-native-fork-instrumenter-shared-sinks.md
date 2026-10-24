# Complete transform measurements after shared sink target sets

This snapshot shares exact target sets in function-local results and the
disk-backed sink planner. Walrus 0.26.4 and its algorithms remain unchanged.
All 42 complete transforms and 42 separate production host-contract / controlled
normal-execution validators passed. Every emitted hash matches the earlier
[shared-facts comparison](2026-10-24-native-fork-instrumenter-shared-facts.md)
within its backend; relevant ABI descriptor and data hashes agree across
backends. The matching source passed all 667 instrumenter tests, with no skips.
These are fresh matched runs; differences from earlier reports do not isolate
the effect of the target-storage change. No CPU profile was collected here.

## Memory

Median OS lifetime peak physical footprint in MiB (range of three fresh
processes). Runs were serial, alternating backend order, on arm64 macOS
through the declared dev shell, with a 1 GiB physical guard and 120-second
deadline. Both sides include immutable input/output snapshots, analysis,
planning, rewriting, feature metadata, serial Wasm validation, atomic
publication and checksums. Binaryen and the separate Node validator are
excluded from the transform measurement.

| Example | Walrus MiB | Native MiB |
|---|---:|---:|
| 512 wide arithmetic functions | 173.42 (172.83–173.72) | 4.83 (4.81–5.23) |
| 8,000 tiny functions | 82.42 (82.39–82.44) | 12.63 (12.61–12.92) |
| One 128,003-operator body | 74.64 (74.63–74.80) | 33.03 (32.94–33.05) |
| 50,000 compiler-fact flow edges | 42.17 (42.11–42.17) | 16.67 (16.56–17.02) |
| 8 MiB active data | 47.72 (47.69–48.03) | 3.78 (3.73–3.80) |
| Tiny caught child | 2.97 (2.92–2.98) | 3.41 (3.36–3.41) |
| Tiny exiting child | 2.91 (2.89–3.13) | 3.34 (3.33–3.36) |

File-backed pages can remain resident and are reclaimable. Physical footprint
differs from RSS; sampled RSS may miss short peaks. Requested Rust allocations
exclude SQLite/C allocations, native stacks and allocator overhead. Temporary
disk storage is additional. One-function IR still contributes to the working set.

## Transform wall time

Median complete-transform seconds (range of three fresh processes). Wall time
includes process startup and external guard completion detection; small
absolute differences should be read with that overhead in mind. These are
transform timings, not guest application execution timings.

| Example | Walrus seconds | Native seconds |
|---|---:|---:|
| 512 wide arithmetic functions | 0.775 (0.757–0.798) | 0.665 (0.662–0.667) |
| 8,000 tiny functions | 0.118 (0.118–0.120) | 0.586 (0.574–0.626) |
| One 128,003-operator body | 0.130 (0.130–0.132) | 0.096 (0.096–0.098) |
| 50,000 compiler-fact flow edges | 0.038 (0.038–0.038) | 0.338 (0.336–0.343) |
| 8 MiB active data | 0.123 (0.119–0.133) | 1.084 (1.077–1.103) |
| Tiny caught child | 0.013 (0.011–0.013) | 0.016 (0.016–0.017) |
| Tiny exiting child | 0.013 (0.013–0.013) | 0.017 (0.016–0.017) |

No successful complete original-Codex timing or memory pair exists. The
[guarded attempts](2026-10-24-native-codex-transform.md) remain separate failed
transform observations. These controlled examples do not establish Codex
capacity, broad process correctness or application performance.

## Reproduction and provenance

```
scripts/dev-shell.sh python3 scripts/profile-fork-instrument-memory.py \
  --binary .context/native-target-groups-build/measured-binary \
  --output-dir .context/memory-comparison-shared-sinks-validated \
  --rounds 3 --generator generate-sinks --phases instrument \
  --guard-gib 1 --timeout 120
```

Use a new output directory. Raw logs, guard traces, validator results and
artifacts are preserved there. Exact source and executable are preserved in
`.context/native-target-groups-build/`. Source base commit plus preserved delta:
`069020aa7d4e094f5107aab29b3317bac500c77c`.
Executable SHA-256:

```
7f9dd77356b566a1a78182b867a7f8ecc2899bf1cec0e0d7003fa13b038ab291
```

The [machine-readable summary](2026-10-24-native-fork-instrumenter-shared-sinks.json)
contains exact timings, physical footprints, hashes and platform metadata.
Broad host/browser and conformance gates remain pending on the draft PR.
