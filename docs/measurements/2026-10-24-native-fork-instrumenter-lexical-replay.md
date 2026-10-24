# Complete transform measurements after lexical replay

This snapshot adds proven lexical direct-call replay to shared local and
disk-backed target sets, without adding a Wasm feature requirement. Walrus 0.26.4 and its algorithms remain unchanged.
All 42 complete transforms and 42 separate production host-contract / controlled
normal-execution validators passed. Output hashes repeat exactly in three fresh processes per backend. Walrus
hashes match the earlier shared-facts comparison; native bytes may differ
because direct calls now replay lexically. Relevant ABI descriptor and data
hashes agree across backends. The matching source passed all 667 instrumenter tests, with no skips.

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
| 512 wide arithmetic functions | 173.59 (173.11–174.45) | 5.28 (4.91–5.44) |
| 8,000 tiny functions | 82.36 (82.09–82.42) | 12.67 (12.64–12.94) |
| One 128,003-operator body | 74.64 (74.64–74.81) | 33.05 (33.03–33.17) |
| 50,000 compiler-fact flow edges | 42.55 (42.14–42.58) | 16.98 (16.67–17.00) |
| 8 MiB active data | 47.75 (47.64–48.11) | 3.83 (3.75–4.02) |
| Tiny caught child | 2.95 (2.94–3.22) | 3.55 (3.38–3.59) |
| Tiny exiting child | 3.09 (3.09–3.11) | 3.36 (3.36–3.55) |

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
| 512 wide arithmetic functions | 0.784 (0.753–0.795) | 0.667 (0.661–0.691) |
| 8,000 tiny functions | 0.115 (0.112–0.120) | 0.573 (0.572–0.576) |
| One 128,003-operator body | 0.130 (0.128–0.130) | 0.096 (0.094–0.097) |
| 50,000 compiler-fact flow edges | 0.035 (0.034–0.039) | 0.336 (0.334–0.337) |
| 8 MiB active data | 0.116 (0.114–0.118) | 1.033 (1.031–1.048) |
| Tiny caught child | 0.013 (0.013–0.017) | 0.017 (0.017–0.017) |
| Tiny exiting child | 0.013 (0.013–0.013) | 0.016 (0.016–0.017) |

No successful complete original-Codex Walrus/native pair exists. An earlier
[shared-target checkpoint](2026-10-24-native-codex-transform.md) completed
the native transform at 451.38 MiB physical peak in 1,073.45 seconds; its
fingerprint is separate from this lexical-replay snapshot. The final-source
large-input rerun remains pending. These controlled examples do not establish Codex
capacity, broad process correctness or application performance.

## Reproduction and provenance

```
scripts/dev-shell.sh python3 scripts/profile-fork-instrument-memory.py \
  --binary .context/native-lexical-replay-build/measured-binary \
  --output-dir .context/memory-comparison-lexical-validated \
  --rounds 3 --generator generate-sinks --phases instrument \
  --guard-gib 1 --timeout 120
```

Use a new output directory. Raw logs, guard traces, validator results and
artifacts are preserved there. Exact source and executable are preserved in
`.context/native-lexical-replay-build/`. Source base commit plus preserved delta:
`67214f18167185831970fc53a44fd2f646482f0c`.
Executable SHA-256:

```
19f09572f6034995846f67b2c77739368ff37daa9d76b8211f5ae5e749c8467d
```

The [machine-readable summary](2026-10-24-native-fork-instrumenter-lexical-replay.json)
contains exact timings, physical footprints, hashes and platform metadata.
The same production source passed 667 instrumenter tests, 23 focused Node
checks, five native side-module checks and the 57-check three-engine browser
matrix (including two explicit WebKit stack-boundary cases). The broader
Rust workspace passed 3,200 tests, xtask passed 726, and the ABI snapshot
check passed. Selected conformance checks and the final-source Codex rerun
remain pending on the draft PR.
