# Complete native fork-transform memory comparison

Measured 2026-10-24 on arm64 macOS 27.0.1. Both backends ran from one
preserved release executable on identical controlled input bytes, using
normal instrumentation options. The baseline calls the unchanged Walrus
`instrument` implementation. The candidate calls `native::instrument`. Both sides use the same new
file-snapshot and atomic-publication wrappers. This is a backend comparison,
not a comparison against the old main-branch CLI I/O path.

This comparison includes immutable input snapshots, original scanning or
parsing, compiler facts and sink planning, complete helper/module-state and
continuation rewriting, feature declaration, serial output validation,
output snapshots, atomic publication and checksums. It excludes Binaryen
post-optimization on **both** sides. Node validation runs in separate guarded
processes and is excluded from the transform's memory figures.

These are complete-transform measurements on synthetic examples. They do
not establish Codex capacity, full process/browser correctness, application
performance or measurements on another operating system. The CLI's native
backend remains opt-in while those migration gates run.

## Peak physical footprint

MiB, median of three fresh processes, with min–max in parentheses. The
primary metric is macOS's lifetime maximum physical footprint, the same
metric used by the external guard. It includes C/SQLite allocations and
allocator retention; it is not the requested Rust heap or resident set size.

| Controlled example | Walrus | Native |
|---|---:|---:|
| arithmetic-wide | 173.02 (173.02–173.06) | 5.00 (4.86–5.56) |
| caught-child | 3.19 (3.17–3.19) | 3.63 (3.63–3.67) |
| child-exit | 3.06 (3.03–3.13) | 3.47 (3.45–3.47) |
| data-heavy | 48.05 (48.00–48.06) | 4.09 (4.08–4.13) |
| facts-heavy | 42.52 (42.50–42.56) | 16.86 (16.81–17.08) |
| many-tiny | 82.77 (82.38–82.77) | 12.97 (12.81–13.11) |
| one-large | 74.78 (74.78–74.83) | 33.27 (33.22–33.30) |

Wide arithmetic has 512 functions with 512 arithmetic repetitions each;
many-tiny has 8,000 functions; one-large has 128,003 operators in one body.
Facts-heavy has 256 functions and 50,000 compiler-fact flow edges. Data-heavy
has 256 functions and 8 MiB of active data. The two tiny semantic fixtures
cover a child that exits and a child whose exception is caught by its root.

The native path uses about 0.4 MiB **more** physical footprint on the two
smallest fixtures. Its fixed setup cost outweighs its savings there. The
large-body case still sets the native working-set high point: a local IR
must hold that body while planning or rewriting it.

## Resident pages and allocation counters

File-backed snapshots and section spools replace resident heap copies with
file I/O and reclaimable file pages. A low physical footprint does not mean
those pages are never resident. For context, the following figures are the
median of each process's **sampled** RSS maximum. Sampling at about 5 ms can
miss short peaks, so these are diagnostic lower bounds, not the primary
lifetime peak measurement.

| Controlled example | Walrus sampled RSS MiB | Native sampled RSS MiB |
|---|---:|---:|
| arithmetic-wide | 182.95 | 15.52 |
| caught-child | 10.22 | 11.12 |
| child-exit | 10.06 | 10.97 |
| data-heavy | 71.08 | 27.59 |
| facts-heavy | 50.83 | 25.59 |
| many-tiny | 89.31 | 21.48 |
| one-large | 99.52 | 41.08 |

For example, the data-heavy native path's 4.09 MiB physical footprint
coexists with 27.59 MiB sampled RSS. Moving data through private files and
read-only maps is part of the design, with temporary disk I/O as a tradeoff.

Requested Rust allocation peaks are also retained in `results.json` and
`summary.json`: wide arithmetic measured 211.84 → 1.11 MiB and one-large
52.30 → 31.41 MiB. These counters exclude allocations made directly by
SQLite/C and do not include allocator overhead or clean mapped pages.
Do not add them to physical-footprint figures as if they were disjoint peaks.

## Output and runtime checks

All 42 transform processes completed below the 1 GiB physical-footprint
guard and 120-second per-process deadline. Their 42 separate Node validators
also completed under the same guard and deadline without a guard stop.
Runs were serial, with eager/native order alternating per repeat and
`RAYON_NUM_THREADS=2`. The source and destination payload checksums, relevant
ABI descriptors and published output hashes were checked. Output hashes are
deterministic across all three repeats **within each backend**; byte equality
between different transforms is not required.

Each Node validator compiles the artifact, runs the production host's
`describeWasmForkArtifactContractFailures`, initializes its module bootstrap
and executes the controlled parent path with fork returning 13. Typed Wasm
providers and the existing scalar recipe/table journals supply the imports.
It checks result 13, normal fork state and released codec scratch. This adds
normal-execution coverage; it is not a substitute for fresh-child,
cross-worker, signal or process-lifecycle tests.

This work targets instrumenter memory, not raw code size. The many-tiny raw
output grew from 588,832 to 1,011,369 bytes. Output sizes and SHA-256 hashes
for every case are retained in the results. Binaryen and application-level
runtime performance were not measured, and these figures do not support a
claim about either.

## Reproduction and evidence

The focused example was built with two Cargo jobs through
`scripts/dev-shell.sh`, targeting `aarch64-apple-darwin`, in release mode.
Tool versions were Rust 1.97.0-nightly (ca9a134e0), Node 24.15.0, Binaryen
126 and Python 3.13.12. No SDK/kernel/package/browser rebuild was needed.

```bash
scripts/dev-shell.sh env CARGO_BUILD_JOBS=2 cargo build \
  -p fork-instrument --example memory_comparison --release \
  --target aarch64-apple-darwin --offline
scripts/dev-shell.sh python3 scripts/profile-fork-instrument-memory.py \
  --binary target/aarch64-apple-darwin/release/examples/memory_comparison \
  --output-dir .context/full-transform-rerun \
  --rounds 3 --guard-gib 1 --timeout 120 \
  --generator generate-sinks --phases instrument
```

The output directory must be new. The checker requires the declared root
Node dependencies and Binaryen's `wasm-as`; it uses that assembler for its
small `anyref` transit-table fixture. Raw inputs are not executed.

The [machine-readable summary](2026-10-24-native-fork-instrumenter-full-summary.json)
records medians, ranges, sampled RSS, output sizes and input/output hashes.

Preserved run evidence is in
`.context/memory-comparison-full-instrument-validated/`: generated inputs,
every measured/validator stdout, stderr, status and sample trace, all output
artifacts, `results.json`, `summary.json` and tool versions. The executable,
195-file source snapshot and SHA-256 manifest are preserved in
`.context/memory-comparison-full-instrument-validated-evidence/`.
The source base is `572cc2cc525f4ee37d41fea4b363438f249d7af2`; benchmark additions
were uncommitted at measurement time and are included in that snapshot.
Executable SHA-256:

```
aed01d7765b0e8ad10214096214631b0eea98102833702b2cb4f87fc0e2c5c40
```

The initial attempt is preserved separately in
`.context/memory-comparison-full-instrument/` and its matching `-evidence/`
directory. The first transform succeeded, but the separate validator stopped
because WABT could not assemble the `anyref` test table. Only the checker's
assembler changed for the complete rerun; the measured Rust executable is
identical. The initial attempt is not mixed into the table above.

Earlier front-end and facts/sink reports measure different phases, input I/O
and historical builds. Do not combine those cells with this table as one run.
The original large Codex input remains a separate coordinated validation,
with its 16 GiB physical-footprint guard; no Codex result is implied here.
