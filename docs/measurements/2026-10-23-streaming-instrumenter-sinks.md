# Native fork facts and sink-analysis memory comparison

Measured 2026-10-23 on arm64 macOS 27.0.1. This comparison includes reading
input, validated parsing/scanning, conservative closure, the full compiler
facts solver when facts exist, and the complete experimental native sink
planner. The unchanged Walrus implementation is the baseline. Both paths
run from the same preserved optimized executable against identical bytes.
Neither path executes the input.

This is **not end-to-end fork instrumentation**. Legacy normalization,
continuation rewriting, runtime/module-state generation, final artifact
validation and production output emission are excluded. The controlled
examples do not establish large Codex capacity, production workload memory,
or Node/browser performance. Production still uses Walrus.

## Peak physical footprint

Median of three fresh processes per cell, MiB. The OS lifetime maximum
physical footprint includes C/SQLite allocations, allocator retention and
other process pages, including input bytes.

| Controlled example | Walrus | Native |
|---|---:|---:|
| arithmetic-wide | 134.88 | 5.55 |
| many-tiny | 31.81 | 11.95 |
| one-large | 19.78 | 17.92 |
| facts-heavy | 39.02 | 17.66 |
| data-heavy | 20.44 | 11.47 |
| caught-child | 2.31 | 3.06 |
| child-exit | 2.31 | 3.06 |

Wide arithmetic has 512 functions with 512 arithmetic repetitions each;
many-tiny has 8,000 functions; one-large has 128,003 operators in one body.
Facts-heavy has 256 functions and 50,000 compiler-fact flow edges. Data-heavy
has 256 functions and 8 MiB of active data. Caught-child and child-exit are
small semantic fixtures: one retains the catching root, the other proves a
boundary and removes its root from the activation set. Their native SQLite
setup costs about 0.75 MiB more physical footprint than Walrus.

All 42 measurements completed below the 1 GiB physical-footprint guard and
120-second per-process deadline. The runner checked counts and deterministic
hashes of activation, control, boundary and fork-returning sets against the
baseline and across all repeats. This verifies these analysis outputs for
these fixtures, not full emitted artifact or runtime equivalence.

## Large-body allocator regression and correction

An initial run of this sink phase exposed a real regression: one-large
peaked at 93.30 MiB with the native planner versus 19.80 MiB with Walrus.
Requested live Rust allocations peaked at only 15.20 MiB on the native
path. Repeated geometric growth of the large per-body instruction vector
left freed pages resident in the system allocator during successive passes.

The loader now reserves exactly the operator count already recorded in the
validated scan. The standalone typed iterator performs a bounded count-only
pass before allocation. The input count is checked against the IR instruction
limit before reservation, and decoding verifies the count. No global body
cache or allocator-specific purge is used. After this change, the independent
three-round rerun above measured 17.92 MiB for native one-large. The initial
run and its executable remain preserved separately; the regression was not
removed from the evidence.

Requested Rust allocation peaks in the corrected run were 2.26 MiB for
wide arithmetic, 5.55 MiB for many-tiny, 14.84 MiB for one-large, 3.52 MiB
for facts-heavy and 8.28 MiB for data-heavy. **These are not total heap
figures:** SQLite allocates through C and bypasses Rust's global allocator.
Physical footprint is the primary comparison. Separate allocator peaks
must not be added and presented as one simultaneous peak.

## Procedure and evidence

Only the focused native example was rebuilt under `scripts/dev-shell.sh`,
with an explicit `aarch64-apple-darwin` target and two Cargo jobs. There was
no SDK/kernel/package/browser rebuild or unrestricted large-input run.
Each cell is a fresh process; baseline/native order alternates per repeat,
measurements run serially with `RAYON_NUM_THREADS=2`, and the guard polls
at approximately 5 ms. The executable reports the OS lifetime high-water
mark, so short peaks between polls remain visible. The runner rejects a
reported lifetime peak over the guard even if polling missed it.

```sh
scripts/dev-shell.sh bash -c 'cargo build -p fork-instrument \
  --example memory_comparison --release --target aarch64-apple-darwin -j 2'
scripts/dev-shell.sh python3 scripts/profile-fork-instrument-memory.py \
  --binary target/aarch64-apple-darwin/release/examples/memory_comparison \
  --output-dir .context/new-sink-measurements \
  --generator generate-sinks --phases sinks --rounds 3 \
  --guard-gib 1 --timeout 120
```

Corrected-run evidence is in
`.context/memory-comparison-native-sinks-reserved/`: `results.json`, every
stdout/stderr/status/sample trace, generated inputs, `measured-binary` and
`measured-source/` with its source SHA-256 manifest. Binary SHA-256:

```
60cf8650ed93e8f3ed16e6697a2f79eee1769c9f84d05686de865bb13d3ed7d4
```

The first run is in `.context/memory-comparison-native-sinks/`, including
its preserved binary. Its source-snapshot note discloses that the IR file
was copied after the reservation edit; the preserved binary is authoritative
for that first run. Exact input hashes and physical-peak ranges for both
runs are recorded in their respective `results.json` files. Earlier
front-end/roundtrip measurements use different fixture sizes and older
code; do not combine their cells with this table as one run.
