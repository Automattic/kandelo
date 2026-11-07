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
After the expanded compiler gate passed, all four normal Kandelo Go pins
and `kandelo-wasm32-prototype` select f605. All four normal consumers now build and pass their Node and focused browser
gates. The WordPress image rebuild remains pending. No upstream issue or pull request has been submitted. The existing WordPress preview is preserved.

The candidate is **selected for normal package rebuilds** after its broad
validation. It demonstrates stack safety for the exercised cases, but
deep-pattern compilation is slower on the tested Wasm hosts. Actual FrankenPHP+Caddy now passes the focused service gate on Node
and all three browsers, including WebKit. No request-rate or WordPress
performance conclusion follows from these microbenchmarks.

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
A later clean f605 build also passes all five standard-library build modes,
18 Node runtime/cgo cases and the expanded three-engine compiler suite:
297 passed, zero skipped/flaky, 15m54s. This includes all 14 optional
cgo-runtime/PHP probes per engine. All 61 selected program artifacts match
the expected compiler or C SDK producer and kernel ABI; typed prototype
receipts bind source/target/layout. The freshly rebuilt manual C-link
fixture exposed legacy assembly assumptions on both A0 and f605; its
wasm32 assembly now uses direct C handles and four-byte values. No compiler
or app correction was needed. GoHello now passes an independent same-key rebuild after the shared
helper selects upstream's reproducible builder mode. Development bootstrap
otherwise discards ambient GOFLAGS and retains scratch paths in native tools;
their content IDs affect target build IDs. Compiler identities are preserved.
This checks this Mac/development environment, not cross-OS reproducibility.
Final WordPress and larger consumer reproducibility gates remain open.

## Normal package integration

All four normal packages build with f605 and the shared reproducible native
bootstrap. GoHello 33 passes Node VFS/posix_spawn and an independent same-key
rebuild of both compilers and its target. Standalone Caddy 15 uses the normal
explicit source resolver because it is intentionally excluded from the
default bootstrap set. Classic 38 and combined 19 use normal bootstrap.
Their combined build/Node sequence completes in 25m12s.

Both FrankenPHP Node gates execute PHP/static/OPcache, 32 request-lifetime
checks at concurrency four and normal shutdown without host diagnostics.
Classic observes Go collections 1 to 3; Caddy observes 16 to 31. Four normal
consumers also pass Chromium/Firefox/WebKit (12/12). A receipt-validated
projection preserves their exact bytes and matches frozen kernel
`a991e3cf4469345e8b274572c2fec153331fa9da53678e0860f5f7e238d80783`.
The first narrow projection omitted rootfs, so Vite's full-app dependency
scan warned even though the consumer tests passed. A rerun with the normal
rootfs prerequisite is in progress. No artifact validation is relaxed.

| Package/revision | Wasm bytes | SHA-256 |
| --- | ---: | --- |
| GoHello 33 | 2,197,333 | 8445a3ef4fe9660d09771631bb506cda46145c87998d85c521ded0386335d209 |
| Caddy 15 | 92,108,164 | 9150f42c177a64764c68529766c1e5aef911923e130770da834f516de3c59318 |
| Classic 38 | 70,004,744 | 90cfbd2753045029948ee95b588cfed63b0170778c83a08359cef8434e1be430 |
| FrankenPHP/Caddy 19 | 185,049,718 | b2e9fc963c76df4e8ee8ad234ca5b3ee7205db65c77d114fae21e0811f4aab06 |

A read-only comparison with the private f605 build finds identical data
and all but two of 196,005 function bodies. The changed bodies export
`wpk_fork_module_table_state_save` and `restore`; they embed baseline
fingerprints bound to the exact original bytes. Custom `go:buildid` and
`kandelo.build.key` differ too. These variants have different native builder
mode/recipe revisions, so this is a diagnostic, not a same-key reproduction.
Do not strip identities after instrumentation to force equality. Larger
C-linked independent
byte-reproducibility checks remain open; GoHello's completed check is not
substituted for them. WordPress image, final workflows, memory/lifecycle and
performance gates remain open. The existing preview is preserved.

Final instrumentation sampled about 8.9 GiB RSS in native `wasm-opt` and
briefly nearly exhausted unused RAM. Swap-out counters did not increase
across the checks, and it completed without intervention. This sampled
build-process cost is distinct from guest/demo footprint and does not bound
the optimizer's peak. Further large runs select the documented
`BINARYEN_CORES=1` setting; its memory effect is not yet measured.

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

## Real FrankenPHP+Caddy evaluation

A complete experimental first-hit registry copies the unchanged released
FrankenPHP 1.13.5/Caddy 2.11.9 recipe and changes only its Go pin to
`f6053060`. The normal SourceOnly resolver builds and publishes it into a
private projection in 7m28s. Its declared Go 1.26.10 bootstrap freshly
builds `go1.28-devel_f6053060`; this service proof does not reuse the local
8b compiler. The original incomplete override omitted its script/main files
and was correctly rejected; that attempt is retained separately.

Candidate artifact: 185,049,718 bytes, SHA-256
`ee48e2bfa3bfcd9a31d984a8e1989a2af1625184bb1450791681714438f7b919`.
It uses the same ABI-55 kernel and PHP artifact as the baseline. Neither
FrankenPHP nor Caddy source is patched. PHP's separate experimental optimizer
candidate remains present in the PHP artifact and is not evaluated here.

The candidate passes the maintained Node service test: real PHP/static HTTP,
OPcache compilation/cache-file creation, 32 requests with four in flight
and exact CGI/body checks during observed Go collection (17 to 34), then
normal SIGTERM exit 0, with no host diagnostics. The browser service gate
also passes Chromium, Firefox and WebKit (3/3, 35.4 seconds), including
32 concurrent request checks during collection and normal shutdown. The
unchanged-library baseline had exited before readiness on WebKit; its
stripped frame trace did not establish exact function identity by itself.

A separate Node diagnostic runs the whole maintained test in six fresh
children, three alternating rounds, with no simultaneous owned heavy build.
The workload includes engine compilation, machine boot, PHP/static/OPcache,
32 concurrent request checks, shutdown and teardown. All six runs pass.

| Whole Node service-test elapsed time | Median | Range | Samples |
| --- | ---: | ---: | ---: |
| Original library | 5.414 s | 4.865–6.313 s | 3 |
| Candidate | 5.452 s | 5.221–5.659 s | 3 |

The candidate median is 0.7% higher, with overlapping ranges. This small
sample does not establish a performance difference. It is neither isolated
server startup nor sustained request throughput and does not replace the
planned WordPress/FPM comparison. A first diagnostic setup used an
incorrect binary-resolver path and accidentally captured shell banners;
it executed no service samples and is retained as an invalid attempt.

Application source and the preserved preview remain unchanged. The normal
Go recipe pins now select f605; their rebuilds remain pending. Stack safety is established for these service cases; broad
compiler, cgo, memory/lifecycle and production WordPress gates remain open.

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

Real-service evidence is `real-caddy-candidate-artifact.json`,
`real-caddy-candidate-tests.log`, `real-caddy-node-comparison.json` and the
six per-child logs in the same evaluation directory. Build job:
`regexp-caddy-evaluation-1107-013552-c471`. The baseline artifact SHA-256 is
`20c10f8ec00cea0ae470ea6a58eb408383d4e3d38da89be17e738e3a79aeb79d`.

The reusable harness is also rebuilt from its recorded compiler inputs and
smoke-tested on native/Node and all three browsers under
`.context/go-regexp-harness-built/`. Its summarizer rejects mixed WASI
artifacts across Node/browser rows; a deliberately mixed cohort is rejected.
Smoke results do not enter the full comparison above.

Broad coherent compiler validation now passes and normal Go pins select
f605, with the compilation tradeoff explicit. Normal package rebuilds,
reproducibility and final image/application validation remain pending. The candidate is a robustness improvement,
not an established speed improvement. If that cost is unacceptable, further
profiling or a separate instrumentation design is needed; restoring the old
hybrid fallback is not the recommendation. Final image, WordPress workflow,
lifecycle/memory and fair PHP-FPM performance gates remain in the parent
plan. PHP's optimizer-recursion candidate remains separate.

## Expanded validation checkpoint

Fresh source/build and Node logs are in `.context/go-regexp-broad-gates/`.
`cohort-identity.json` records 61 artifact hashes and their Wasm producer/ABI
checks. The completed browser report is
`browser-reports/playwright.c7dLsh/{report.json,context.json,console.log}`.
Builds and corrections retain separate failed observations; none is a test
allowance. Native `go version -m` does not recognize this Wasm format, so
the audit uses the linker's standard producer metadata, not guessed strings.

The original A0 source/toolchain is preserved at
`.context/go-regexp-baseline-a0` before fast-forwarding the prototype. Its
compiler tools are relocated from the original A0 build, not freshly built.
Timing artifacts and their recorded hashes remain unchanged.
