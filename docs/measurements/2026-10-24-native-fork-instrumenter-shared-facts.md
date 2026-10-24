# Complete native transform memory after shared fact targets

This fresh comparison measures the complete transform after sharing conservative
compiler-fact target groups and indexing return-flow lookups. Walrus 0.26.4
and its original algorithms remain unchanged. Earlier
[complete measurements](2026-10-24-native-fork-instrumenter-full.md) remain a
historical snapshot; use the matched pairs below for this source revision.

All 42 transforms and 42 separate production host-contract / controlled normal
execution validators passed. Every output hash matches the earlier comparison
within its backend. ABI descriptor and data hashes agree across backends.
This does not establish Codex capacity, full process correctness, or application
performance.

## Physical footprint

Median OS lifetime peak physical footprint in MiB; parentheses show the range
of three fresh processes per backend/example. Runs were serial, alternating
backend order, on arm64 macOS through the declared dev shell. Each process had
a 1 GiB physical guard and 120-second deadline. Both paths include common
immutable input/output snapshots, analysis, planning, rewriting, feature
metadata, validation, atomic publication and checksums. Binaryen and the
separate Node validator are outside the transform measurement.

| Example | Walrus MiB | Native MiB |
|---|---:|---:|
| 512 wide arithmetic functions | 219.20 (214.24–236.44) | 5.61 (5.53–5.73) |
| 8,000 tiny functions | 84.47 (83.73–84.64) | 13.59 (12.98–13.72) |
| One 128,003-operator body | 76.31 (74.84–76.31) | 34.42 (34.39–35.20) |
| 50,000 compiler-fact flow edges | 42.47 (41.39–42.81) | 17.08 (16.84–17.08) |
| 8 MiB active data | 48.20 (48.11–48.28) | 3.91 (3.78–3.98) |
| Tiny caught child | 3.19 (3.14–3.20) | 3.36 (3.30–3.55) |
| Tiny exiting child | 3.09 (3.09–3.11) | 3.53 (3.42–3.55) |

The largest one-function IR remains a significant working set. Its native
requested Rust allocation peak is 31.41 MiB; the wide example uses 1.11 MiB.
Tiny modules retain a small native setup overhead. OS footprint varies between
fresh processes, so ranges accompany the medians.

File-backed pages can remain resident. The native data-heavy median maximum
sampled RSS is 27.47 MiB even though its physical-footprint median is 3.91 MiB.
RSS samples can miss short peaks. Clean mapped pages are reclaimable, and the
pipeline also consumes temporary disk storage. Requested Rust allocation
counts exclude SQLite/C allocations, native stacks and allocator overhead.

Raw many-tiny output remains 588,832 bytes for Walrus and 1,011,369 for native.
This comparison makes no output-size or execution-speed claim. Real process
and browser validation are separate gates.

## Reproduction and evidence

```
scripts/dev-shell.sh python3 scripts/profile-fork-instrument-memory.py \
  --binary .context/native-shared-facts-complete-build/measured-binary \
  --output-dir .context/memory-comparison-shared-facts-validated \
  --rounds 3 --generator generate-sinks --phases instrument \
  --guard-gib 1 --timeout 120
```

The output directory must be new. Its `results.json`, raw stdout/stderr,
physical/RSS traces, validation logs and artifacts are preserved locally.
The executable and 201-file source manifest are in
`.context/native-shared-facts-complete-build/`, based on commit
`9b062571e7eafb1a648a136c5d9c383836a3000d` plus the preserved delta.
Executable SHA-256:

```
30bb80963e0733463af0456e25fc46c556ca47cbcf9db30a442ed52f10cb3f05
```

The [machine-readable summary](2026-10-24-native-fork-instrumenter-shared-facts-summary.json)
contains exact values, hashes and platform metadata. The matching source passed
all 658 instrumenter tests with two Cargo jobs and two test threads. Broad
host/browser and conformance gates remain pending on the draft PR.
