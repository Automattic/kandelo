# Go regexp compiler evaluation

Compare regular-expression compilation in two Go source checkouts. This is
an upstream-library evaluation: the browser controls use WASI directly,
without Kandelo, and do not measure WordPress or HTTP throughput. Kandelo
regression and real Caddy service tests are separate gates.

Run from the repository root through the declared dev shell. Both inputs
must be compiler binaries from Git source checkouts that support
`wasip1/wasm32`; install the repository's declared Playwright browsers first.
For example, with the maintained prototype and experimental candidate:

```bash
scripts/dev-shell.sh bash benchmarks/go-regexp/build.sh \
  .context/go-wasm32-study-7VN0Qm/upstream/bin/go \
  .context/go-regexp-upstream-candidate/bin/go \
  .context/go-regexp-benchmark
scripts/dev-shell.sh node benchmarks/go-regexp/run-native.mjs \
  .context/go-regexp-benchmark
scripts/dev-shell.sh npx tsx benchmarks/go-regexp/run-browser.ts \
  .context/go-regexp-benchmark
scripts/dev-shell.sh python3 benchmarks/go-regexp/summarize.py \
  .context/go-regexp-benchmark
```

Avoid concurrent builds and other heavy workloads during timings. Save host
load and memory observations before and after the run. The builder records
compiler versions and source revisions; retain those files alongside the
raw JSON, artifact hashes, source cleanliness and the final summary.

Each workload parses and simplifies its expression before timing. It records
one cold compile, then calibrates for approximately 100 ms per sample and
records five samples. The drivers alternate baseline/candidate order across
three rounds. Each row uses a fresh native/Node child or a fresh browser
page and dedicated worker; browser workers share one browser parent per
round. `GOMAXPROCS=1`. The summary compares medians of recorded per-operation
samples, not whole-process startup. Browser compilation/instantiation are
outside the timed region, but first-use engine compilation may still affect
cold samples.

The URL expression is the exact bounded-repeat expression in
`tests/go/regexp-stack/main.go`. The unchanged compiler can overflow
WebKit's native Wasm call stack. Those baseline errors remain in the raw
results and have no speed ratio; other failures reject the run. The minimal
browser WASI host implements only the operations this workload needs and
throws on any unimplemented operation. Clock polls honor their deadlines.

The bytecode checksum checks the timed workloads' output, while the
candidate's syntax tests compare entire programs against a test-only
recursive oracle over fixed and generated expressions. Native upstream
`regexp`/`regexp/syntax` suites, race checks and separate deep-tree and
Kandelo/browser regressions remain necessary.

Allocation counts come from Go's memory statistics. Pooled storage can have
cold allocations and small amortized replenishment costs even when shallow
compilation adds no allocation. These figures do not establish resident
memory, engine memory, physical reclamation or a `GOMEMLIMIT` budget.

For a quick harness check, set `REGEXP_BENCH_ROUNDS=1` and
`REGEXP_BENCH_CASES=literal` inside the dev shell before running each driver.
Keep smoke outputs separate from full measurements. See the
[2026-11-07 evaluation](../../docs/plans/2026-11-07-go-regexp-upstream-evaluation.md)
for results and adoption status.
