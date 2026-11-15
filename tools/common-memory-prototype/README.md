# Common-memory process-group mechanism prototype

This isolated experiment tests one underlying shared `WebAssembly.Memory`
containing private per-process pages and genuinely shared pages. An immutable
per-instance global selects its virtual page table. Pointers remain virtual;
translated loads/stores resolve them into the common memory. A harness clone
copies private backing pages and inherits shared ones, preserving pointer bits
and private aliases. It does not implement Kandelo's fork continuation.

Run from the repository root, with a fresh output directory per run:

```sh
mkdir -p .scratch
run_dir=$(mktemp -d .scratch/common-memory.XXXXXX)
scripts/dev-shell.sh bash tools/common-memory-prototype/run.sh "$run_dir" checks > "$run_dir/run.log" 2>&1
```

Use `bench` instead of `checks` to run the translation-cost experiment after
the checks. The command runs Node, Chromium, Firefox and WebKit sequentially.
Read `run.log`, `summary.md`, per-host JSON samples and `provenance.json` from
that exact directory. Copy reviewed evidence into `.context/` for retention.
The generated Wasm needs the declared dev shell's WABT; browser tests use the
repository's silent Playwright fixture. Browser memories live in disposable
Workers; the persistent page receives only numeric results.

An optional third argument selects post-instrumentation Binaryen optimization:
`run.sh "$run_dir" bench O3` (also `O2` and `Oz`). The default is `none`.
The same level applies to native, inline, and helper artifacts. `build.json`
and the provenance manifest record tool versions and exact flags. Optimization
keeps implicit traps and the permission/cross-page checks; no unchecked-memory
or fast-math assumptions are enabled. Generated WAT records preoptimization
input; final Wasm records the selected output.

`generate.py` creates matched native, inline-page-translation, and minimal
Wasm-helper-call artifacts. Native accesses receive physical addresses;
translated accesses receive virtual addresses. The helper control calls actual
Wasm exports using the same resolver. It is not the old Madison helper's
lease/revocation implementation. No JavaScript callback runs per guest access.
The inline hot path has no cross-instance operation call; split-page scalar
operations use a cold Wasm fallback. Physical and virtual addresses are 32-bit.

The tests cover private pointer graphs and aliases after nested page clones,
shared pointer graphs and different-address aliases, immediate peer writes,
split-page scalars, mapping permissions, bounds, CAS, concurrent atomic RMW,
wait/notify across actual Workers, bulk/overlap/scattered copies, quiescent
unmap/remap, and 6,000 seeded operations against an independent byte model.
A deliberately broken private-page clone must fail the independent parent
check. Source and artifact hashes must remain unchanged throughout a run.

Benchmarks measure sequential reads/writes and dependent random pointer
chasing over 64 KiB and 8 MiB working sets, uncontended atomic RMW, and repeated
64 KiB copies. There are nine rotated/reversed rounds after three warmups per
variant. The native control selects a common iteration count with a 50 ms
target and finite cap. Setup, graph initialization, Worker launch and module
compilation are outside samples. Checksums and final data are validated.
Pointer-chase samples traverse at least four whole graphs plus a nonzero
remainder; an independent JS model checks that remainder's checksum.
This deliberately small page table stays cache-friendly. These costs cannot
predict the behavior of a full PHP application or a larger address space.

The trust and lifecycle limits matter: these are generated, trusted modules,
not arbitrary instrumented programs. Metadata changes only while guest calls
are stopped. There is no general C/Wasm rewriter, concurrent unmap/revocation,
guest syscall/host view translation, process isolation proof, dynamic linking,
SIMD or memory64. Physical allocation is bounded and monotonic. Scattered bulk
copies use a per-instance 64 KiB scratch buffer and refuse larger scatter
copies. Contiguous copies validate all pages and use native `memory.copy`.
The group reserves 64 MiB initially with a 128 MiB maximum; each virtual space
is bounded to 64 MiB. These are fixture budgets, not a production ABI.

No shipping runtime, ABI, SDK or PHP recipe is changed. No PHP-FPM/OPcache
integration is claimed. This is the measurement gate before that experiment.

## Individual optimization matrix

`run-optimizations.sh <fresh-output-directory> checks|bench` builds freestanding
C fixtures with the declared unwrapped LLVM compiler, then tests the individual
transforms and their combination. Use `scripts/agent-job start` for the full
two-cohort Node/Chromium/Firefox/WebKit matrix:

```sh
scripts/agent-job start --name common-memory-optimizations -- \
  scripts/dev-shell.sh bash tools/common-memory-prototype/run-optimizations.sh \
  .scratch/a-unique-run-directory bench
```

These are manually expressed C transformations, not a general instrumentation
pass. They exercise actual Clang optimization, cross-translation-unit LTO,
retained LLVM bulk intrinsics and explicit Wasm SIMD. Scalar profiles suppress
automatic loop/SLP vectorization to isolate scalar transforms; the auto profile
and final combined profile enable it. Five compiler profiles cover O2, O3,
O3+LTO, automatic vectorization, and final Binaryen O3. The combined path uses
all applicable transforms, with generic fallbacks rather than redundant guards.

The individual algorithms are checked per access, a nonfaulting contiguous
span guard, an invocation-local decoded-page cache, a proved-alignment branch,
retained bulk operations, and explicit vector operations. An opaque accessor in
a separate translation unit tests compiler visibility before and after LTO.
Field-walking fixtures test four accesses per object. Fragmented 8 MiB mappings
exercise rejected span guards and cache fallbacks. Private/shared graphs,
denied suffixes, remap/permissions between calls, unaligned SIMD tails,
overlap and concurrent optimized atomics receive independent checks.

Mappings remain fixed during each guest call, and caches never survive that
call. C shadow stacks occupy separate host-owned physical pages, apart from
the bulk-copy scratch area. All exported fixture inputs/outputs are integers;
there is no JavaScript callback per memory operation. The fixtures are not
SDK-built guest programs and do not demonstrate Kandelo fork or PHP coverage.

The full benchmark uses two cohorts per host and seven randomized candidate
orders. Every candidate is bracketed by its matched native implementation:
same compiler profile and scalar/SIMD operation. A fixed O2 scalar-native
anchor is also measured. Separately calibrated counts are normalized per
logical operation; graph samples cover at least four cycles and a checked
remainder. Ratios and absolute times retain all samples. Before measurement,
the stability rule is fixed: native brackets within 25%, samples at least
2 ms, at least four of seven acceptable brackets in each cohort, and cohort
median ratios within 20%. Failed stability receives a visible marker rather
than pruning. This is diagnostic evidence under recorded machine load.

`optimization-summary.md` contains the individual, combined and complete
matrices. `optimization-summary.json` and per-host/cohort files retain paired
samples and both native references. `optimization-build.json`, generated C,
LLVM IR, WAT, Wasm and `provenance.json` bind the actual compiler inputs and
outputs. Preserve reviewed evidence under `.context/` after completion.
