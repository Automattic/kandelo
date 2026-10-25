# Native-only instrumenter verification

This dated record describes commit `89945d25cf` at ABI 50. The later
[main integration record](2026-10-25-native-main-integration.md) covers
the combined ABI 53 sources and freshly rebuilt runtime artifacts.

The native instrumenter is now the only fork-instrumentation implementation.
The CLI backend selector, explicit Walrus library APIs, whole-module analysis
and emitters, size-attribution feature and paired-backend profiling coordinator
have been removed. Walrus is a dev dependency for structural inspection in
some tests; it is absent from the tool's normal dependency closure. The
separate local-root-spill crate's Walrus usage is outside this replacement.

Shared ABI names and wire formats remain. `streaming/legacy` handles older
WebAssembly exception instructions (`try`, `catch`, `rethrow`, `delegate`);
it belongs to the native transform and is required for valid compiler output.
No ABI version or host/runtime protocol changes accompany backend removal.

## Before/after artifact comparison

The baseline is the native-default CLI from `dc1f807eea`, whose production
source is unchanged from `1db42bf`. The candidate removes the Walrus backend.
Both use the `instrumenter` Cargo profile and the same original SDK links as
the [paired performance report](2026-10-25-native-instrumentation-comparison.md).
This is an output-equivalence check, with other verification running on the
machine; it makes no new timing or memory comparison claim.

| Package | Raw native output | Native output after Binaryen `-Os` | Independent Node artifact checks |
| --- | --- | --- | --- |
| Gawk 5.3.0 | Byte-identical | Byte-identical | Both passed |
| Coreutils 9.6 | Byte-identical | Byte-identical | Both passed |
| Bash 5.2.37 | Byte-identical | Byte-identical | Both passed |

The six comparisons include complete output bytes, not only descriptors.
The input and output hashes, exact tool hashes and source inventory are in
[the machine-readable record](2026-10-25-native-only-instrumenter.json).
These checks compile artifacts and apply production admission rules; they do
not execute package programs.

## Regression coverage

An isolated copy of the pre-removal native source passed 110 adapted tests
while capturing 193 expectations. Those expectations are stored as readable
values in 68 files under `crates/fork-instrument/tests/snapshots/`. They pin
original function/byte coordinates, call closures, sink sets, compiler-fact
reports, reference liveness, scalar prefix layouts and ABI descriptors.
The committed helper only compares expectations; it cannot update them.

Walrus implementation tests and migration-only differential checks retire
with that implementation. Native checks retain explicit behavior assertions
and execute fresh-instance replay, allocation-failure recovery, catches,
references, tables, segment lifetimes, loaders, scalar codecs and both pointer
widths. Codec/static-root tests that directly injected the old emitters now
compose native providers. The lower test inventory is intentional; no failure
was converted into a skip.

| Current-tree check, through `scripts/dev-shell.sh` | Result |
| --- | --- |
| Workspace Rust, excluding xtask; host target, two build jobs, one test thread | 2,978 passed across 87 groups; zero failed or ignored |
| Five focused Node integration files | 25 passed; zero failed or skipped |
| Native process browser fixture, Chromium/Firefox/WebKit | 57 passed; zero failed or skipped |
| ABI snapshot/version check | Passed |
| Tool builder working-directory and stale-stamp checks | Passed |
| Native generated-program fuzzing | 10,000 runs; zero findings |
| Updated fuzz output-directory launch | 100 runs; zero findings |
| Native cache profiler, Coreutils with 0/4 MiB overrides | Four transforms and four independent artifact checks passed; equal output hashes |

The WebKit source-recursion cases still assert their documented native-stack
boundary explicitly; wide-frame cases check allocation-failure recovery.
The fuzzer now validates native output and checks deterministic transforms,
while engine execution remains a separate gate. Generated fuzz corpora,
findings and build files live outside the instrumenter source tree. A tool
installation initially refused to stamp while the earlier fuzz launcher wrote
build files under its scanned inputs; the launcher was fixed and the normal
builder rerun successfully.

The cache-profiler run checks the retained diagnostic tooling, not cache-speed
claims: other validation was active, with only one measurement per budget.
The earlier paired timing results remain historical measurements; Coreutils
throughput is still a documented gap, not a newly resolved claim.

The full registry, full host-runtime suite, full application benchmarks,
selected conformance suites and original large Codex capacity transform were
not repeated for this deletion. Their earlier scoped evidence remains in the
[native-default rollout record](2026-10-25-native-default-rollout.md). Current
package byte parity and focused runtime checks support removing the oracle;
they do not expand that earlier validation scope.
