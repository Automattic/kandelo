# Shared iterative Go regexp compiler candidate

## Purpose and status

Go's unchanged `regexp/syntax` compiler recursively visits the expression
tree. Simplifying a bounded repetition can create a tree deep enough to
exhaust WebKit's native Wasm call stack. Both upstream WASI architectures
reproduce this with the exact URL expression imported by Caddy's file
server, without Kandelo imports. This is a native-depth boundary, not a
Go collector defect or proof of an engine specification violation.

The maintainer explicitly approved developing and evaluating a shared
upstream improvement. The candidate is on
[`kandelo-wasm32-regexp-candidate`](https://github.com/kandelo-dev/go/tree/kandelo-wasm32-regexp-candidate),
currently [`f6053060`](https://github.com/kandelo-dev/go/commit/f60530600f70a5ea905a907ac311ec8bd2ae8ac4).
Normal Kandelo package pins remain `a0b048e1`. No upstream issue or pull
request has been submitted. The existing WordPress preview is preserved.

The candidate is **not adopted**. It demonstrates stack safety for the
exercised cases, but deep-pattern compilation is slower on the tested Wasm
hosts. Real FrankenPHP+Caddy evaluation is the next gate; no request-rate
or WordPress performance conclusion follows from these microbenchmarks.

## Implementation

There is one iterative traversal shared across platforms. Its explicit
frames hold the parent expression, next child and accumulated fragment.
Opening captures, child compilation, closing captures, alternation edges
and patch-list ordering retain the original emission order. Shared syntax
subtrees compile at every occurrence; they are not memoized.

Eight frames stay on the goroutine stack. Deeper traversals borrow scratch
storage from `sync.Pool`; each popped expression pointer is cleared. Buffers
larger than 4,096 frames are discarded instead of pooled. This bounds
retained scratch capacity, not accepted expression depth. Keeping pooled
storage separate prevents the inline buffer from escaping to the heap.
Leaf operations have a shared helper and need no traversal frame.

The production compiler has no recursive fallback, architecture check,
Caddy special case, collector change or code-generator change. The original
recursive traversal exists only as a shallow test oracle. Deep-tree tests
inspect the resulting instructions directly, without using that oracle.

## Correctness evidence

A clean native compiler was built from candidate `8b705bed` using verified
Go 1.26.10 as bootstrap. `f6053060` changes only the test oracle's depth and
copyright relative to that build; production sources are identical. The
compiler identifies itself as `go1.28-devel_8b705bed`. Earlier exploratory
runs reused A0's compiler with candidate library source and are not the
clean-build evidence.

With the clean compiler:

- Entire native `regexp/syntax` and `regexp` suites pass.
- Race-enabled `regexp/syntax` passes, including concurrent compilation.
- Complete programs match the original traversal for 2,022 fixed/generated
  expressions. Comparisons include instructions, capture counts and entry
  points; shared instruction-construction helpers isolate traversal order.
- Separate tests compile 10,000-level concatenation and capture trees.
- The exact bounded-repeat regression passes Node on `wasip1/wasm32` and
  legacy `wasip1/wasm`, plus all six architecture/browser combinations.
  The completed WASI controls invoke no unsupported import.
- The same regression passes Kandelo Node and Chromium/Firefox/WebKit
  (3/3 browser cases, 9.6 seconds), with matching ABI-contract stamps.

The first final Kandelo browser invocation omitted its opt-in flag and
skipped all three cases; it is retained separately and supports no passing
claim. The direct fixture initially lacked its ABI-contract stamp; the
corrected run stamps exactly the freshly built output through the normal
fixture helper. Neither attempt is substituted for the executed gate.
The broad compiler/POSIX suite, all optional cgo cases, final WordPress
workflows and reproducibility gates have not been rerun on this candidate.

## Compilation measurements

These are library-compilation measurements, with parse/simplification
outside timing. Three alternating rounds per case/variant produce 15
samples. Each row uses a fresh child process or browser page/dedicated
worker; workers share a browser parent per round. `GOMAXPROCS=1`. There are
72 native/Node rows and 108 browser rows: 105 browser rows succeed and the
three unchanged WebKit URL baselines overflow. Bytecode checksums agree
for all successful workloads across variants.

Host: macOS 27.2 arm64, Node 24.15.0; Playwright Chromium 153.0.8010.12,
Firefox 155.0 and WebKit 26.6. Native means this Mac, not every native
architecture or operating system. No owned heavy build ran during the
measurements. CPU snapshots show 72.3% idle before and 89.8% after;
these endpoint observations do not prove constant load throughout.

Percent change in median time per compilation; positive means slower:

| Host | Literal | Literal text | Class | Capture | Bounded lazy | URL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Native arm64 | +1.4% | -0.8% | +11.6% | +8.1% | +28.8% | -6.7% |
| Node/WASI32 | +3.7% | +7.8% | +8.4% | +9.4% | +46.8% | +58.4% |
| Chromium | +1.2% | -1.2% | +10.3% | +12.6% | +44.3% | +55.7% |
| Firefox | +0.7% | +3.8% | +6.1% | +11.0% | +46.7% | +50.0% |
| WebKit | -0.5% | +0.2% | +8.3% | +12.2% | +44.4% | Baseline overflows |

URL compilation medians give the scale of that difference:

| Host | Original | Candidate |
| --- | ---: | ---: |
| Native arm64 | 15.55 µs | 14.51 µs |
| Node/WASI32 | 44.74 µs | 70.89 µs |
| Chromium | 40.32 µs | 62.77 µs |
| Firefox | 45.87 µs | 68.83 µs |
| WebKit | Overflows | 54.02 µs |

Shallow workloads retain their original allocation counts: literal 4,
literal text 6, class 5 and capture 6. Deep workloads retain approximately
9 and 11 allocations per compile, with small amortized pool-replenishment
costs (about 0.00–0.03 extra allocations in this run). These are steady-state
Go allocation statistics, not a promise of no cold allocations or physical
memory reclamation. Engine allocations and resident memory are unmeasured.
Matching performance is not established; the Wasm regressions remain real.

Earlier iterations are retained: the initial stack added allocations;
the first pooled version made even a literal's inline buffer escape;
separating storage fixed that escape. Clearing only the expression pointer
and splitting leaf emission did not remove the deep Wasm timing regression.
The first browser timing host lacked `poll_oneoff`; its 108 rows are invalid
and excluded. The replacement clock poll honors subscription deadlines.

## Reproduction and remaining decision

The candidate contains upstream-style equivalence/deep/concurrency tests
and `BenchmarkCompileTraversal`. The portable evaluation harness is
[`benchmarks/go-regexp`](../../benchmarks/go-regexp/README.md). Its Node and
browser controls deliberately avoid Kandelo to isolate the library change.

Local evidence is retained under `.context/go-regexp-evaluation/`:
`final-source.json`, `clean-toolchain-build.log`,
`clean-candidate-checks.log`, `final-control-gates.log`,
`final-kandelo-corrected.log`, `native-benchmarks.json`,
`browser-benchmarks.json`, `summary.json` and the before/after load snapshots.
Failed, skipped and intermediate runs remain separate. A smoke check of
the preserved harness is stored under `.context/go-regexp-harness-smoke/`;
its timings are not part of the comparison above.

An experimental first-hit registry copies the unchanged FrankenPHP+Caddy
recipe and changes only its Go source pin to `f6053060`. The normal resolver
builds it into a private projection. Its first attempt omitted the selected
package's script/main input files; resolution correctly rejected the
incomplete override. The complete override is being built. No normal recipe,
application source, PHP artifact or existing preview is replaced by this
experiment.

Before promotion, run that actual service on Node and all three browsers,
retain the compilation tradeoff explicitly, and evaluate application startup
and request behavior. If the library-level cost is unacceptable, further
profiling or a separate instrumentation design is needed; restoring the old
hybrid fallback is not the recommendation. Full compiler/cgo/POSIX, image,
WordPress lifecycle/memory and fair PHP-FPM performance gates remain part
of the parent plan. PHP's optimizer-recursion candidate remains separate.
