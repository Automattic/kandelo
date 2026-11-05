# Function-local instrumenter front-end memory

These measurements compare unchanged registry Walrus 0.26.4 with the
experimental wasmparser/wasm-encoder front end and Kandelo-owned function IR.
They cover original-input validation, conservative call closure, definition
binding and, separately, round-trip serialization. **Neither path runs the
complete fork transform in this experiment.** Sink interpretation, full
compiler-facts target solving, continuation rewriting, runtime generation and
module-state instrumentation are excluded. Production instrumentation still
uses Walrus.

## Physical footprint

All values are MiB (2^20 bytes). Each cell gives the median lifetime physical
footprint peak from three fresh processes. The operating system reports the
lifetime maximum; these are not the maxima of a sparse sampling trace.

| Example | Input | Defined functions | Front end: Walrus | Front end: native | Front end + serialization: Walrus | Front end + serialization: native |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Wide arithmetic | 3,159,918 bytes; 512 arithmetic groups per function | 1,024 | 265.78 | 6.44 | 277.67 | 6.59 |
| Many tiny functions | 772,453 bytes; one fork call per function | 50,000 | 123.16 | 36.36 | 140.31 | 36.36 |
| One large function | 768,069 bytes; 128,000 arithmetic groups | 1 | 73.45 | 55.39 | 73.77 | 55.48 |
| Facts-heavy | 6,584,518 bytes; 250,000 slot-flow relation lines | 1,000 | 47.02 | 10.34 | 47.28 | 10.45 |
| Data-heavy | 16,814,065 bytes including 16 MiB active data | 1,000 | 40.25 | 19.14 | 88.72 | 19.17 |
| Nested-control regression | 178 bytes; existing `multiple_nested_regions.wat` fixture | 1 | 2.17 | 2.17 | 2.17 | 2.17 |

An arithmetic group is `i32.const 1; i32.const 2; i32.add; drop`. Every
generated function ends with a call to the same imported fork seed. No
optimizer runs between fixture generation, fact hashing and either path.
The input byte counts and function counts for every case are recorded in the
machine-readable evidence; the descriptions above identify the independent
scaling dimensions.

Run-to-run physical peak ranges for serialization were:

| Example | Walrus range | Native range |
| --- | ---: | ---: |
| Wide arithmetic | 277.59–277.74 | 6.58–6.61 |
| Many tiny functions | 140.30–140.33 | 36.36–36.38 |
| One large function | 73.75–73.77 | 55.48–55.48 |
| Facts-heavy | 47.28–47.31 | 10.44–10.47 |
| Data-heavy | 88.70–88.72 | 19.14–19.19 |
| Nested-control regression | 2.17–2.17 | 2.17–2.17 |

The wide example benefits from discarding each function's instructions before
the next. Many tiny functions retain the function/type/call summaries even
on the native path. One large function exposes the largest-function cost:
the native IR still materializes that entire function. Data payloads remain
in the original input buffer, but native output spooling avoids copying the
whole data section through an output vector.

The facts-heavy example compares the existing definition-binding entry point,
which expands `Side`, with the new definition-only reader, which ignores the
250,000 flow edges. Their definition bindings agree. This does **not** measure
the cost of a replacement full facts solver; that solver remains unfinished.
The native call-facts adapter and reference data-flow pass added after this
measurement are also outside these measured phases.

## Requested Rust allocation bytes

The same executable uses a counting global allocator on both paths. These
values are peak sums of live *requested* allocation sizes, not resident or
committed heap. A large reserved vector can contribute its full capacity
without having all its pages touched; consequently these numbers can exceed
physical footprint. Allocator overhead and non-Rust allocations are excluded.

| Example | Front end: Walrus | Front end: native | Front end + serialization: Walrus | Front end + serialization: native |
| --- | ---: | ---: | ---: | ---: |
| Wide arithmetic | 420.86 | 4.35 | 426.25 | 4.36 |
| Many tiny functions | 84.03 | 36.22 | 84.03 | 36.22 |
| One large function | 69.39 | 52.74 | 69.39 | 53.74 |
| Facts-heavy | 34.16 | 7.51 | 34.16 | 7.51 |
| Data-heavy | 36.82 | 16.64 | 68.20 | 16.64 |
| Nested-control regression | 0.02 | 0.01 | 0.02 | 0.01 |

## Method and reproduction

The comparison ran on arm64 macOS 27.0.1, using the repository's dev shell,
the pinned Rust toolchain and native `aarch64-apple-darwin` target. Both paths
are in the same release executable. The run alternated backend order across
three repetitions, used two Rayon threads, and ran only one child at a time.
A 1 GiB physical-footprint guard polled every 5 ms; each child also had a
120-second deadline. All 72 measurement children completed successfully, as
did fixture generation. No input module was executed. No Codex input was
copied or run, and no kernel, SDK, package or browser rebuild was performed.

Physical peaks use macOS `proc_pid_rusage`, `RUSAGE_INFO_V4`, field
`ri_lifetime_max_phys_footprint`. The runner separately samples current
physical footprint to enforce its guard. It terminates, escalates if needed,
and reaps a child that exceeds its limit. A polling guard can overshoot;
the lifetime maximum is the measurement, rather than the guard's sampled
maximum.

```sh
scripts/dev-shell.sh bash -c '
  host_target=$(rustc -vV | awk '\''/^host/ {print $2}'\'')
  cargo build --release -p fork-instrument --example memory_comparison \
    --target "$host_target" -j 2
  python3 scripts/profile-fork-instrument-memory.py \
    --binary "target/$host_target/release/examples/memory_comparison" \
    --output-dir .context/memory-comparison-reproduction \
    --rounds 3 --guard-gib 1
'
```

The example checks validation and the runner compares defined-function counts,
activation/control set hashes and exact-original definition-binding hashes
between backends and repetitions. IR node counts are deliberately not equated:
the native IR includes source delimiters that Walrus represents structurally.
The ordinary streaming tests independently validate output, execute remapped
fixtures in Node and compare the call graph with the oracle. These comparisons
do not establish full fork/replay equivalence for the new pipeline.

Evidence is in `.context/memory-comparison-native-ir/`: `results.json`, each
child's stdout/stderr/status and physical samples, the exact generated inputs,
and a preserved `measured-binary`. The originally measured executable SHA-256
is `ea2cd90fe4066cc6be7adaf4164e3e4c48aa2d4a917198a60893580acb1ae789`.
The report records every input hash. Rebuilding after subsequent source changes
can produce a different binary; the preserved executable identifies this run.

These results support a front-end retention and serialization claim on the
listed examples only. They do not establish whole-program instrumentation
capacity, browser/Node application performance, or feasibility for the large
Codex input. A coordinated complete-transform run still needs the 16 GiB
physical-footprint guard and the remaining semantic/runtime/ABI gates.
