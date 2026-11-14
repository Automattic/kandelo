# Whole-program common-memory experiment

For the current source-checkout prototype, use the
[integration guide](../../docs/experimental-common-memory.md) and its explicit
SDK, host-profile and package entry points. Current executables require the
format-2 execution-stop contract; the ordinary host refuses them. The older
experiment commands and measurements below are retained research records.
Their format-1 artifacts are refused by the current profile, and their timings
do not include the newly required stop checks.

This is the integration stage after `../common-memory-prototype`: a checked
whole-module memory-access rewrite, followed by real SDK/CLI/fork/FPM tests.
Real PHP-FPM shared OPcache passes the mechanism checks below. Diagnostic
three-control application timings are in the
[PHP-FPM report](../../docs/measurements/2026-11-10-common-memory-php-fpm.md).
This remains a bounded opt-in prototype.

The [optimization survey](../../docs/measurements/2026-11-12-common-memory-optimization-survey.md)
summarizes all 19 candidate families, host-specific results, retained negatives
and resource limits. Timestamp validation remains the primary case; the
[experiment catalog](../../docs/measurements/2026-11-11-common-memory-optimization-catalog.md)
preserves the complete ledger and follow-up ideas.

For interactive WordPress SQLite and MariaDB images using virtualized FPM
and shared OPcache, see the [local WordPress experiment](wordpress/README.md).

The process group has one shared Wasm memory. Guest pointer values stay
virtual; each process has a page-table root. Metadata and per-Worker scratch
storage occupy reserved physical allocations. The initial implementation
requires a single running Worker per process, stopped during host mapping
changes. Shared payloads are mutable. This does not establish untrusted
module isolation or concurrent remap safety.

The translator runs after normal fork preparation, visits generated code as
well as original code, appends its helpers/configuration without shifting
original function/global indices, and converts active data initialization
into an explicit fresh-instance initializer. A cloned child must bind its
own root and skip fresh-image writes before fork replay. New configuration
globals must never be replayed from the parent.

Admission is deliberately bounded: one wasm32 memory, supported memory
operations only, explicit initialization and a bounded scatter-copy scratch
allocation. Unknown forms are refused rather than left untranslated. Normal
SDK/package/fork builds remain the source of application artifacts. The
whole-program pass is not wired into the shipping package build. The normal
host refuses its custom artifact marker unless an experimental group host
explicitly opts in; ordinary ABI and fork checks remain enabled.

No microbenchmark candidate has been discarded. Span/cache/alignment/SIMD
and compiler profiles remain in the earlier fixture for later application
experiments after the checked program path is correct.

Run the compiled-C mechanism checks from a fresh output directory:

```sh
scripts/dev-shell.sh bash tools/common-memory-program/run-canary.sh .scratch/a-fresh-program-run
scripts/dev-shell.sh bash -c 'export KANDELO_COMMON_MEMORY_ARTIFACTS="$PWD/.scratch/a-fresh-program-run"; npx playwright test --config tools/common-memory-program/playwright.config.ts'
```

`run-canary.sh OUTPUT outlined` selects compact typed access wrappers. The
default `expanded` mode preserves the original per-access expansion. Both
keep the same checking helpers; the wrapper mode reduces large guest
function bodies and preserves original function/global indices. The canary
also tests numeric, SIMD lane, atomic, overflow and denied-store forms.

The Rust tool builds for the build machine explicitly; this repository's
default Cargo target is Wasm. The generated metadata reports each rewritten
operation and the original virtual memory limits. Native data-segment
instructions inside generated initializer wrappers preserve segment bounds
and drop state. Memory access helpers use no C shadow stack or external
function imports.

Initial results: compiled-C checks pass on Node, Chromium, Firefox and
WebKit. Ordinary PHP 8.5.12 CLI/file-cache smoke passes against a normal
partial shell image containing PHP; its shared-mode guard refuses startup.
Both normal fork-prepared PHP CLI and FPM artifacts translate and pass Wasm
validation. An opt-in Node profile now executes virtualized PHP CLI, real
PHP fork with private object-graph isolation, and a two-worker FPM pool in
file-cache-only mode. Both FPM worker PIDs serve real FastCGI requests, with
request-local state reset. A normal SDK-built C fork test also passes shared
pointer graphs and native Wasm wait/notify; the untranslated separate-memory
control times out. These are mechanism/application smoke checks, not timing
comparisons. A private copy of the normal PHP recipe now builds PHP with the
shipping shared-mode refusal disabled for this unpublished experiment. A
two-worker pool passes shared-cache publication/reuse, invalidation/recompile,
request-private state, and replacement-worker reuse on Node, Chromium,
Firefox and WebKit. The fixture holds one worker at a VFS barrier to prove
that a distinct worker observes cache changes. Shared-target compilation
increments misses once; the peer and replacement worker reuse it without
another miss. No file cache is enabled in those checks.

The expanded form exhausted Node's background compiler memory. Limiting
compilation tasks passed short checks but still failed the longer warm run;
disabling Wasm inlining also failed. These failed runs are retained.
`--outline-accesses` reduces the translated FPM module from 55.39 MiB to
36.31 MiB and passes full warm trials under default Node settings. The
final comparison uses that profile on all engines, with no engine flags.
It includes two fresh-parent cohorts per host, bracketing ordinary-addressing
controls and 64 warmup batches. Object traversal remains more expensive;
shared OPcache offsets the translation cost in the include-heavy fixture.
The report includes actual latencies, throughput, memory and uncertainty.
Evidence is retained under `.context/common-memory-php-stage{1,2,3,4}-20261110/`
in this workspace.

`platform/build.mjs` bundles the actual host sources into an isolated opt-in
profile. Its syntax-tree rewrite adapts typed views, captured intrinsics,
atomics, text conversion and disposable-Worker initialization to explicit
virtual buffers. Unadapted buffer consumers throw. No per-process Wasm shadow
memory or whole-process syscall-boundary copy stands in for the common group.
The native snapshot-comparator optimization receives no grant for virtual
handles. Native-memory authentication remains in its ordinary path.

The profile selects virtual allocation from the program marker; unrelated
ordinary guest programs retain ordinary memories. Anonymous MAP_SHARED pages
are marked in the process PTEs and inherited by real fork, instead of entering
the old copy/reconciliation backend. The group is bounded and monotonic, with
no physical-extent reuse yet. Anonymous mappings receive fresh physical
pages before initialization, fixed replacements cannot zero a peer's backing,
and successful protection/unmap changes update the calling root. Remaps retain
physical page identity and zero new tails. The SDK C fork probe exercises
replacement, protection, remap and unmap alongside native shared wait/notify.
The browser's asynchronous fork path captures private pages before yielding
and retains live shared PTEs. File-backed shared mappings, general lifecycle
failure/rollback coverage, loaded extensions, threads and arbitrary-module
isolation are still incomplete.
The protected in-kernel pipe client in `platform/fastcgi.mjs` speaks real
FastCGI; the profile publishes no physical-host TCP listener.

Reproduce the application stage after building the normal partial PHP image
and the standalone translator through `run-canary.sh`:

```sh
scripts/dev-shell.sh python3 tools/common-memory-program/build-php-shared.py .scratch/fresh-php-build
scripts/dev-shell.sh node tools/common-memory-program/platform/build.mjs .scratch/fresh-host-profile
scripts/dev-shell.sh tools/common-memory-program/instrument/target/aarch64-apple-darwin/debug/common-memory-program-instrument .scratch/fresh-php-build/out/php-fpm.wasm .scratch/a-fresh-program-run/helpers.wasm .scratch/fresh-php-build/php-fpm-vm.wasm --outline-accesses
scripts/dev-shell.sh env KANDELO_BENCH_WARMUP=64 node tools/common-memory-program/platform/benchmark-run-node.mjs .scratch/fresh-host-profile .scratch/fresh-php-build/out/php-fpm.wasm .scratch/fresh-php-build/php-fpm-vm.wasm .scratch/fresh-node-results
```

Use the build machine's Rust target in the translator path (the example is
Apple Silicon). `platform/benchmark.config.ts` runs the browser cohorts with
`KANDELO_COMMON_MEMORY_PROFILE`, `KANDELO_COMMON_MEMORY_FPM`,
`KANDELO_COMMON_MEMORY_NATIVE_FPM`, `KANDELO_COMMON_MEMORY_ARTIFACTS` and
`KANDELO_BENCH_WARMUP=64` set **inside** `scripts/dev-shell.sh`. The dev shell
intentionally drops unlisted outer environment variables. All output
directories must be fresh. `summarize-php-timings.py NODE_DIR BROWSER_DIR OUT`
validates and summarizes the complete matched inventories.

The ongoing application optimization campaign has a [durable candidate
catalog](../../docs/measurements/2026-11-11-common-memory-optimization-catalog.md).

`platform/build.mjs OUTPUT --pregrow-group` builds a separate diagnostic
profile with initial common backing equal to its existing maximum. This
avoids positive physical shared growth while another process's Worker can
end, covering the broader group lifetime exposed by the tracked
[WebKit growth/instance-destruction defect](../../tests/runtime-workarounds/JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN/entry.md).
It changes the initial physical buffer size and must be reported separately
from dynamic-growth results. Guest virtual growth, permissions and physical
allocation limits remain checked. Omitting the flag preserves the previous
bundle bytes; the frozen interactive preview is unchanged. This is not a
general process-group retirement implementation or a promoted default.
`survey/build-variants.py FRESH_DIR` generates baseline, scalar-resolver,
conditional-commit and combined modules from the same SDK-built inputs.
`survey/check-variants.mjs` and `survey/check-platform.mjs` exercise the
mechanisms and actual fork/FPM paths. `survey/fpm-node-screen.mjs` and
`survey/fpm-browser-screen.mjs` run matched ordinary/file, VM/file and
VM/shared controls; `survey/summarize-fpm.py NODE_DIR BROWSER_DIR OUT`
requires the complete inventory. Run these through the dev shell and retain
failed trials as well as successful ones. Do not change frozen sources or
bundles during a timing run.

`survey/wordpress-run-node.mjs VARIANTS PROFILE IMAGE NATIVE_FPM OUT BACKEND`
and `survey/wordpress.config.ts` measure actual nginx/FPM WordPress pages,
authenticated admin and validated REST JSON. Each control starts a fresh
engine parent. `KANDELO_SURVEY_MODES` selects a comma-separated list starting
with `baseline`; the default includes both individual variants and their
combination. Browser runs additionally select the image/backend with
`KANDELO_SURVEY_IMAGE` and `KANDELO_SURVEY_BACKEND`. Warmup and round counts
are bounded by the monotonic physical allocator; memory snapshots and cache
status checks stay outside timed requests. These private diagnostic fixtures
do not change the user preview, shipping PHP recipe or default runtime.

`survey/build-caches.py FRESH_DIR` builds VM-03's one/two-entry root-header
mapping caches and their VM-01/02 combination. The experimental host now
initializes root word 4 to epoch 1 and advances it on mapping changes;
zero disables caching permanently (legacy root or unsigned wrap). Cache
slots occupy words 5–10 inside the existing reserved header. C helpers keep
effective bounds and rights checks and never cache shared payload bytes.
`survey/cache-checks.mjs` warms guest accesses before actual host mapping,
protection, fork and growth changes, including both epoch wrap paths.

For closer temporal pairing, `survey/paired-run.mjs node|browser VARIANTS
PROFILE NATIVE_FPM OUT` consumes a manifest with explicit `pairReferences`.
Each candidate/reference runs adjacently in each cache configuration, with
ordinary brackets and reversed order in a second cohort. The combined
cache candidate should reference the scalar/conditional control to isolate
the cache's additional contribution. `survey/summarize-paired.py NODE_DIR
BROWSER_DIR OUT` requires matching frozen plans/inputs and a complete
cross-host inventory. Set all environment overrides inside the dev shell.

`survey/paired-matrix.mjs VARIANTS PROFILE NATIVE_FPM OUT` serializes both
host runners and validates their summary. For compiler comparisons, a
manifest may bind `nativeArtifacts[mode]` to `{path, sha256, bytes}` for
each referenced mode. This adds two ordinary controls per build/cohort,
bracketing adjacent VM pairs, so each VM build is compared to its own
ordinary-addressing build. Schema 2 summaries additionally report the
ordinary compiler ratio and the ratio of candidate/reference addressing
overheads. Manifests without those bindings preserve the original plan
and schema 1 results. The analyzer rejects incomplete/duplicated plans,
incorrect artifact bindings and unexpected engine flags.

`survey/summarize-concurrent.py MATRIX OUT_JSON` first reproduces the
matrix's strict summary, then analyzes median completion latency for two
concurrently admitted requests on two distinct real FPM workers. It checks
all seven rounds per workload, worker identities and rate/elapsed agreement,
and retains both orders plus own ordinary brackets. This bounded batch
metric is separate from single-request latency and saturation throughput.

`survey/build-helper-levels.py FRESH_DIR` isolates helper Clang O3 while
retaining the original PHP C-O2 input. `build-php-shared.py FRESH_BUILD
--c-opt=O3` builds PHP C translation units through the private normal recipe;
dependencies, C++ flags and pre-fork/fork stages retain their normal flags.
`survey/build-php-levels.py BUILD_DIR FRESH_VARIANTS` pairs that build with
the original C-O2 build and fixed O2 helpers, including matched ordinary
artifacts. These survey builders currently use the pinned scratch inputs
named in their sources; they are campaign fixtures, not package interfaces.
Non-PHP mechanism probes in the PHP comparison are unchanged controls;
actual shared-FPM checks exercise the recompiled PHP program. A successful
build or short WordPress correctness run does not establish a speedup.

`survey/build-compiler-combined.py FRESH_DIR` combines PHP/helper O3,
alone against the original baseline and with small-offset fusion against
the exact fusion-only reference. Each pair keeps its own ordinary PHP
compiler build. These are explicit combined candidates, including the
helper flag even where its individual screen was neutral or regressive.

Main-program PGO is a separate experiment. `build-php-shared.py FRESH_BUILD
--programs-only --profile-generate-resource=PRIVATE_RESOURCE` uses a private
target profiling runtime; `--profile-use=MERGED_PROFILE` consumes training
data instead. Profiling flags enter actual PHP C make rules after normal
configure. The explicit programs-only scope builds CLI/FPM plus sessions
metadata and omits optional shared-extension outputs; it publishes no
package. This preserves the image's existing extension binaries and does
not establish profiling support for their separate links. New build receipts
save exact builder/recipe sources, flags, profile identity and stamped hashes.

`survey/pgo-fpm-shutdown.mjs PROFILE FPM OUT file|shared
--control-timeout=30 --require-profiles` checks both workers, normal SIGQUIT
exits and profile extraction. A successful master exit alone is insufficient.
`survey/pgo-wordpress-training.ts PROFILE IMAGE FPM OUT LABEL BACKEND`
collects actual frontend/admin/REST/login/cache-status training and flushes
the real FPM workers before teardown. It records all engine flags; any
training-only compiler-tier flag must stay out of unprofiled timing controls.
`survey/build-pgo-variants.py BUILD FRESH_VARIANTS` builds PGO alone and with
small fusion, using matched ordinary builds and the exact original/fusion
references. The FPM compute/includes fixture is separate from training;
WordPress training success is not a held-out WordPress performance claim.

`survey/build-fused.py FRESH_DIR` builds VM-10 zero/small-offset numeric
resolver fusion inside outlined wrappers, plus its VM-01/02 combination.
The translator accepts `--fuse-scalars=zero|small|all` with outlining;
atomics/SIMD stay on helpers. Bounds, rights and one-page checks precede
the raw access; split pages retain original helper staging/commit.
`survey/bounds.wat` and `bounds-checks.mjs` exercise a sparse4GiB virtual
space, exact endpoints, unsigned overflow, maximum offsets and denied
split-store prefixes. Full-offset C mechanism success does not establish
full-offset PHP performance. `survey/summarize-wordpress.py NODE_DIR OUT`
validates complete warm Node WordPress cohorts and reports same-cache and
ordinary-addressing ratios with native-bracket variation.

`--fused-bounds=i32` is a separate opt-in for fused scalars. It rejects
base/constant-offset wrap, checks page width and compares the page index
against the virtual page count, including the exact4GiB case. Split accesses
retain the original full endpoint/permission/staging helper. The default
i64 form remains byte-identical; this flag does not infer alignment from
Wasm hints. `survey/build-i32-bounds.py FRESH_DIR` reproduces ten baseline/
fusion hashes, builds the small-offset application candidate and separate
full-offset mechanism controls, and rejects invalid option combinations.
Full-offset mechanism success does not establish full-offset PHP performance.

`survey/multi-memory/build.py FRESH_DIR` builds the ARCH-01 synthetic WAT
feasibility fixture. `survey/multi-memory/run-node.mjs DIR` runs it inside
a disposable Node Worker; the adjacent Playwright config exercises the
three browser engines using `KANDELO_MULTI_MEMORY_ARTIFACTS=DIR` and
`KANDELO_COMMON_MEMORY_ARTIFACTS=DIR`. Two instances have distinct private
memories and one common shared memory. Canonical pointer values survive an
explicit test copy; private isolation, live shared bytes/atomics, native
bounds and independent/common growth are checked. A mandatory negative
control supplies the same Memory at both import indices, demonstrating that
indices alone do not imply nonaliasing. All three memories are worker-owned,
each capped at four pages. This is neither real fork/SDK/PHP integration
nor a performance test; no production ABI or runtime path changes.

`survey/breadth/run-cross-host-node.mjs ARTIFACTS FRESH_JSON` and the adjacent
Playwright config run the same Worker-only synthetic array cost screen. Set
`KANDELO_COMMON_MEMORY_ARTIFACTS` to a fresh directory containing the historical
`single.wasm`, `dual.wasm` and `single-vm.wasm` from `survey/breadth/build.mjs`.
Six cases compare ordinary private/shared reads, per-access PTE translation,
one span validation per loop and high-bit tagged two-memory reads. Samples use
16 million reads, seven rounds in each of two opposite orders, checksums and
scatter/permission negative controls. Compile/setup and ordered first calls
are reported separately. Only copied JSON leaves each disposable Worker;
the fixture's declared aggregate memory ceiling is 4.5MiB. `vm_span` returns
zero for scattering but faults on permission failure, so this is a pinned
read-only arena cost screen, not a general non-faulting hoisting proof.
The tag is loop-invariant; mixed-pointer streams, real PHP ABI integration,
mapping/fork lifetime proofs and application speed remain unmeasured here.
Historical Node-only `worker.mjs` and its evidence remain unchanged.

`survey/mixed-memory-build.mjs FRESH_DIR` generates a separate ARCH-01
pointer-stream fixture and the current small-offset-fused translator control.
`mixed-memory-probe.mjs` runs only in disposable Workers; the adjacent config
uses a fresh artifact directory through `KANDELO_COMMON_MEMORY_ARTIFACTS`.
Each payload pointer is loaded inside the loop from a known-private table.
Ordinary flattened addressing, tagged one-memory addressing, tagged two-memory
dispatch and PTE translation use equal logical data and pointer order. Seven
bank patterns include shuffled 1/50/99% mixes, alternating and clustered runs.
Read-modify-writes XOR each selected word through even complete cycles, with
exact checksums and final contents checked. The stores are non-atomic.
The 32 mechanism/content checks include bounds, copied-private isolation,
live shared payload, legal import aliasing and negative loop-invariant-tag
controls. This is a high-bit memory32 pointer ABI with 2GiB per bank, not PHP,
SDK/kernel fork, general mmap/protection or pthread integration. The 12MiB
aggregate declared reservation stays Worker-local. Phase40 retains all 784
samples/host and both orders. Mixed tags cost materially more than the earlier
loop-invariant-tag screen; no application speed claim follows.

The separate `access-diagnostics` tool accepts `--region-plans PLAN_REPORT`
for a matching non-fused regional module/helper. It verifies helper bodies,
guard arguments and fast-body site counts, then records guard attempts,
hits/misses, attempted raw fast accesses and per-region branch counts. The
existing access-diagnostic host profile and nine physical counter pages are
reused; region pairs occupy unused slots after original function counters.
The tool rejects plans exceeding that fixed budget. Ordinary counter output
is unchanged. `survey/region-count-mechanism.mjs` checks exact accounting,
fault-prefix order, an arithmetic trap that makes static weighted sites
overcount actual attempts, fresh fork counters and missing-host rejection.
`survey/wordpress-regions.mjs` and `survey/region-counts.config.ts` collect
real WordPress coverage on Node and browsers using `KANDELO_REGION_REPORT`,
`KANDELO_REGION_FPM`, `KANDELO_REGION_MECHANISMS` and the existing profile/
artifact environment variables. These deliberately expensive diagnostics
include background/tail work between asynchronous snapshots and must never
be used for latency ranking. The shared accounting separates dispatch,
function, guard and per-region slots; a static site estimate is not treated
as completed work or a CPU fraction.

`--observe-affine` is a distinct private diagnostic mode in the VM instrumenter,
requiring a helper compiled from `helpers.c` plus `survey/affine-observer.c`.
It preserves plain outlined reads/stores/atomics/SIMD and observes their original
virtual addresses before translation; bulk operations and memory-size/growth
dispatches are excluded. It cannot combine with fusion, region/object guards
or mapping-cache helpers. Missing/mismatched diagnostic hosts fail loudly.
The existing access-diagnostic profile supplies its nine pages/root; a64-byte
cache uses unused slack after the declared counter array, adding no allocation
or reservation. Version2 uses one attempt counter and a16-bin classification
histogram, deriving overlapping policies without incrementing each marginal.
Last-geometry gauges are separate from cumulative counters.

The observer scans contiguous mapping runs on root epoch/page-count changes,
then checks each candidate address against live PTEs. Policies compare the
RW private prefix, largest RW private run and largest readable/writable shared
run. An additional address-wise private-plane comparison checks the prefix's
base against private addresses elsewhere; that does not certify a whole plane
through holes, aliases, permissions or shared exceptions. All original
translation and faults remain. `affine-counts.mjs` verifies partitions/unions;
`affine-mechanism.mjs` covers mappings, growth, offsets, SIMD/atomics and fork.
`wordpress-affine.mjs` and `affine-counts.config.ts` use
`KANDELO_AFFINE_REPORT`, `KANDELO_AFFINE_FPM`, `KANDELO_AFFINE_MECHANISMS` and
the existing profile/output variables for Worker-only application diagnostics.
No latency or safe-hoisting claim follows from these counts.

`feasibility` also provides a read-only `origins` binary for whole-module
operand producers, frame origins and structured readonly loops:

```sh
scripts/dev-shell.sh cargo run --offline --manifest-path tools/common-memory-program/feasibility/Cargo.toml --target aarch64-apple-darwin --bin origins -- INPUT.wasm FRESH_REPORT.json
```

Use the build machine's target on other systems. The input must be an ordinary,
single imported memory32 module with an exported mutable i32 stack pointer.
Already translated modules and incompatible forms fail admission. Reports
include unnamed/generated functions, source operator ordinals, local versions,
modular address expressions, conservative constructor/alias origins and loop
effect windows. The old adjacent-operand count is retained for comparison;
it is not an address-producer proof. Producer anchor names, tracked frame
definitions and no-intervening-effect origins are separate, overlapping counts.
Readonly invariant/stride shapes do not prove CFG induction, overflow, mapping
lifetime, channel alias safety, permissions or fork-entry rebinding. The scan
does not rewrite Wasm or establish optimization eligibility.

`access-diagnostics ... --origin-sites NATIVE_MODULE` derives those classes
freshly from the provided ordinary module and checks the complete memarg call
count and operation-kind order in every original function against an outlined
translated module. Frozen input hashes remain necessary: the join is not a
translation-equivalence proof. This option is separate from regional counting
and rejects regional/object/cache layouts. Class attempts occupy slots208–214
in the existing diagnostic pages; no memory layout is extended. Five overlapping
classes cover anchor names, tracked origins, origins before intervening effects,
readonly invariant sites and stride/bound hints; two slots count their loop/all
unions. Bulk helpers stay in the ordinary dispatch denominator. Custom slots
must be excluded from the ordinary category/function reconciliation.

`survey/origin-sites.wat` and `origin-sites-mechanism.mjs` check exact class
overlap, ordinary results, private child counters, permissions and trapping
attempts, along with the existing scatter/fork/64-bit checks. Browser execution
belongs in a disposable Worker; its parent receives copied results only.
`origin-sites-node.mjs` and `origin-sites.config.ts` collect one SQLite/shared
WordPress mixed-page round after two warmup rounds, using
`KANDELO_ORIGIN_FPM`, `KANDELO_ORIGIN_MECHANISMS` and the existing profile/output
variables. This deliberately expensive observer supplies site-class execution
counts, never latency, CPU fractions or safely removable translations.

`survey/wordpress-atomic-run.mjs` is a separate VM06/VM10 SQLite/shared latency
screen. Its manifest must bind four distinct guests (`baseline`, `atomics`,
`small`, `combined`) to one identical ordinary PHP artifact, host profile and
immutable-code timestamp policy, with no preload. The plan launches the four
VM configurations in opposite orders, between opening/closing ordinary FILE
parents: ten independent parents per host, two warmup and five measured
four-page rounds each. The ordinary brackets can be shared across modes
because their compiler/profile/policy identities are equal. Shared versus
ordinary ratios include OPcache mode effects; atomic versus baseline and
combined versus small compare the same cache mode. This is a bounded
application screen, not a pure translation-tax or full-platform benchmark.
It reuses the plain timing input freezer and quiet browser fixture; diagnostic
profiles remain excluded. Keep per-page/order effects, ordinary bracket drift,
startup/resources and load alongside aggregate ratios.

The generic `survey/wordpress-paired-run.mjs` also supports `mariadb` for
timestamp-policy comparisons. Bind validation-on/off cases to identical guest
and host artifacts with distinct `appOptions`; retain each policy's ordinary
FILE opening/closing controls as well as VM/file/shared cases. Run the existing
`wordpress-policy.mjs` edit/invalidation diagnostic in separate parents before
clean timings. It tests both workers, stale-code behavior with validation off,
shared invalidation and explicit diagnostic FILE-cache removal. Those parents
must not enter latency summaries. `wordpress-syscalls.mjs` is another separate
Node-only diagnostic: it counts all guest-process dispatches between resource
snapshots, including background work, and does not measure CPU or plain latency.

The MariaDB policy screen and its Node order/control instability are recorded
in the optimization catalog. Its image inspection distinguishes resident
service/WordPress bytes from deferred content-identity declarations; it does
not claim a wholly materialized image. PHP opcode-dispatch alternatives now
have a six-way generator/executor compile screen and separate target checks;
the catalog records compatibility failures and large-function costs. They have
no new PHP application performance result. `build-php-shared.py FRESH_BUILD
--programs-only --vm-generated MANIFEST --vm-key switch-specialized` admits
only a completed six-case Kandelo-PHP generator manifest with all four generated
files, including `zend_vm_handlers.h`. It verifies their inputs, stages them
after normal configure, prohibits an ambient PHP generator and checks the
outputs again after a successful build. Other keys are `call|switch|goto`
combined with `specialized|generic`. Keep O2/no-LTO/no-PGO for this independent
screen; a failed source compile remains a failed build. Specialized GOTO
executor compilation and ordinary-C `-mtail-call` admission do not establish
full PHP, OPcache or fork compatibility.

The subsequent full specialized GOTO build and fresh CALL control are recorded
in the catalog's phase50 section. Browser CLI/fork/shared-cache checks and
SQLite/MariaDB WordPress functionality pass, but default Node terminates during
optimizing compilation of virtualized GOTO. Node engine-flag and post-VM O2
diagnostics remain separate from default-host acceptance and timings. The large
executor/wrapper costs, accepted raw compiler facts and rejected post-O2 code
binding, plus broader writer-loop opportunities are retained; no dispatch
default or new warm-performance claim follows from those checks.

`--cache-affine-windows` is the separate non-diagnostic VM-09 prototype. It
requires `helpers.c` plus `survey/affine-bind.c`, and outlined instrumentation.
The binder validates a RW private prefix and the largest accessible shared run,
using root-header words6..11. Nine appended, unexported, nonshared instance
globals cache their descriptors. Scalar wrappers check root, epoch, logical
page count, complete access bounds and permissions before using a constant
backing offset. Misses retain the original translator; atomics/SIMD keep their
original paths. Guest pointer values remain virtual. Children bind their own
private backing; shared payload is always read live. Epoch zero disables hits.
This excludes observer, region/object and root-header-cache strategies, and
requires the existing stopped-process mapping-publication protocol. It is not
support for untracked PTE writes, concurrent remaps or arbitrary pthreads.

`survey/affine-cache-checks.mjs` includes an expected-stale negative control
before publishing a remap, then verifies refresh, rights, overflow, growth,
fork and old fallback forms. `affine-cache-bench.mjs` compares actual guarded
private/shared reads with ordinary Wasm on the same backing; all instances stay
inside disposable Workers. The first implementation regresses that loop on all
four hosts. `survey/wordpress-affine-cache-run.mjs` and its dedicated plan run
a bounded shared-OPcache SQLite screen (one warmup, three measured mixed-page
rounds, opposite VM orders, common identical ordinary file-cache brackets).
Manifest timestamp policies must all be explicit and false. These application
ratios include cache-mode effects; they are not pure translation overhead.
The phase38 catalog retains negative timings and future hoisting/cold-path
variants; this option is not a default or a performance recommendation.

`survey/build-object-regions.py FRESH_DIR` builds VM-04 alone and combined
with small fusion, reproducing ten original default hashes first. The
opt-in `--guard-object-functions` requires its matching private helper
containing `vm_try_span`; a guard helper without the option is rejected.
The proof currently selects whole call-free straight-line i32 functions,
with one unchanged local base, at least two accesses, a64KiB maximum span,
16KiB body and256-operator budgets. Unknown effects, calls, branches,
base mutation, atomics and other memory forms reject the whole function.
The non-trapping metadata guard checks bounds, union rights and physical
contiguity before choosing a cloned fast body or the exact original slow
sequence. Canonical pointer operands remain unchanged except for the raw
access address. Physical temporaries are rematerialized at every entry.
This uses the existing single-Worker mapping-stop and monotonic allocation
contracts: guest payload mappings must never expose roots/PTE metadata.
Extent reuse, concurrent mapping changes or broader replay regions need
new proofs. Broader objects/types/regions remain future experiments.

`survey/object-checks.mjs` covers contiguous/scattered/aliased pages,
read/write/denied permissions, earlier stores before later faults, arithmetic
trap order, remapping, synthetic copies and sparse4GiB endpoints. The usual
Node/browser variant checks include these when the manifest has `objects`.
`survey/build-object-fork.py VARIANTS FRESH_DIR` builds an additional normal
SDK/fork-instrumented/ABI-stamped C fixture and verifies that exported
`object_touch`/`object_sum` are actually selected. The translator's read-only
`--inspect-function-exports NATIVE` diagnostic supplies validated original
indices. `survey/run-object-fork.mjs FIXTURE PROFILE OUT` and the adjacent
`object-fork.config.ts` check real child reentry, private/shared fields,
replacement/protection/remap and ordinary-memory negative controls. Browser
tests set `KANDELO_OBJECT_FORK_ARTIFACTS`, `KANDELO_COMMON_MEMORY_PROFILE`
and `KANDELO_COMMON_MEMORY_ARTIFACTS`. Static selection and correctness do
not establish dynamic coverage or application benefit.

`platform/build.mjs FRESH_PROFILE --pregrow-group --byte-slices` enables
the VM-05 byte-snapshot candidate in a private source copy. The default
`memory.mjs` stays unchanged. The installer preserves the original
constructor/from/subarray lookups and actual subarray call, including
argument conversion. The replacement remains a nonconstructible method with
the original name, arity and property descriptor. Returned byte subviews of at least256 elements can
use the captured coalesced read body when their brands, fields, iteration,
mapping methods and relevant primitives are pristine. Changed callbacks
or unsupported types use the existing `from(subarray)` path. Startup requires
the profile realm's standard intrinsics; post-install customization is
checked. Uint8/Int8/clamped byte output is independent plain storage;
wider-element NoTear/NaN behavior remains on its original path. Brand tokens
hold no original buffer/memory/backing references after public fields change.

`survey/prepare-byte-slices.mjs FRESH_DIR` builds standalone diagnostic
baseline/candidate adapters, then `survey/byte-slice-node.mjs DIR` and
`survey/byte-slice.config.ts` exercise callback order/counts, mutation during
conversions, scatter/aliases/permissions, stale views and independent output.
Browser memories stay in the disposable probe Worker. Diagnostic `bulk`
counts attempts entering the bulk branch, including a read that later
throws; `fallback` counts calls reaching that branch decision.

Add `--byte-slice-diagnostics` only with `--byte-slices` for an application
counter profile. Existing `commonMemoryPrototypeStats()` responses then
include plain byte-slice counters from the kernel Worker only; they do not
aggregate process Workers. `survey/byte-slice-diagnostic.mjs PROFILE FRESH_OUT`
checks real Node WordPress use and an ordinary zero-counter control.
These counter builds are separate from timing. `build-byte-variants.mjs
FRESH_VARIANTS CANDIDATE_PROFILE` rejects diagnostic profiles and pairs the
same original/fused guest modules with their baseline/candidate host builds.

`survey/wordpress-byte-run.mjs HOST VARIANTS PROFILE IMAGE NATIVE FRESH_OUT BACKEND`
collects the bounded VM-05/VM-10 shared-OPcache WordPress latency screen. Its
dedicated plan uses baseline, byte-only, fusion-only and byte+fusion in opposite
orders, with fresh parents and ordinary opening/closing controls for each host
profile (12 parents/host). Guest artifacts must match within byte-only pairs;
manifest profiles and ordinary brackets must match within each profile group.
Every manifest timestamp policy must explicitly be false for immutable code.
Two warmup and five measured mixed-page rounds run per parent; diagnostic
profiles are rejected. The phase39 catalog retains all page/order results,
ordinary drift and overlap evidence. Shared/native ratios include OPcache
mode differences and do not isolate translation cost. Use the corrected,
nonconstructible byte-slice profile; superseded profiles remain historical
evidence only. `BACKEND` is explicitly `sqlite` or `mariadb`; the latter's
phase41 confirmation retains page/order/native drift and backend startup
evidence separately. Browser stream callbacks take bytes only, unlike Node's
`(pid, bytes)` callbacks. Old browser results preserve bytes in their misnamed
`pid` field; phase41 validates that representation before decoding it, without
rewriting or retiming those results. This is an isolated app screen, not a
default or platform gate.

Paired manifests may additionally supply `hostProfiles[mode]` and
`profileArtifacts[path][filename]` with full file identities. This requires
matched ordinary controls per mode. Every Node/browser control selects and
records its own profile; both directories are frozen, and strict analysis
rejects missing/mismatched/stale profile bindings. Ordinary ratios then
include host-profile effects as well as compiler effects. Legacy manifests
retain their plans/results. Profile-routing/analyzer validation fixtures
derived from older observations are labeled validation-only, never new
byte-snapshot timing evidence.


`survey/build-lto-fork.py FRESH_DIR --lto-link-lowering` builds CC-02's
multi-file indirect-callback/fork fixture under O2/full-LTO/ThinLTO, directly
and after PHP-like pre-fork O2. It keeps a jump context active across fork
and checks longjmp in both branches. Omitting the lowering option retains
the naive-LTO link-failure experiment. `survey/run-lto-fork.mjs FIXTURE
PROFILE FRESH_OUT` and `survey/lto-fork.config.ts` exercise ordinary/private,
VM/private, VM/live-shared and ordinary live-sharing negatives. Browser
tests set KANDELO_LTO_FORK_ARTIFACTS, KANDELO_COMMON_MEMORY_PROFILE and
KANDELO_COMMON_MEMORY_ARTIFACTS. Each control uses a fresh host; negative
handshakes are bounded and the child is reaped. Diagnostic memory stats
are current entries, not historical fork counts. Shared data must be
observed before pipe/exit synchronization can satisfy the test.

`build-php-shared.py FRESH_BUILD --programs-only --lto=full|thin` applies
LTO to PHP C compile/link flags after normal configure, preserving the
normal dependencies/C++/pre-fork Binaryen/instrumentation stages. LLD's
LTO backend additionally needs `--mllvm=-wasm-enable-sjlj`,
`--mllvm=-wasm-use-legacy-eh=false` and `--mllvm=-exception-model=wasm`;
the private recipe puts those in EXTRA_LDFLAGS_PROGRAM and records them.
Two settings without the exception model can link yet fail at runtime.
Naive PHP LTO failures and all earlier probes remain retained. The normal
SDK and package recipes are unchanged; corrected PHP application builds
and timing remain to be validated. LTO+PGO is deliberately rejected until
separate characterization, with the combination retained as future work.

`survey/build-lto-variants.py FULL_BUILD THIN_BUILD FRESH_VARIANTS` requires
complete corrected C-O2 main-program receipts, checks normal configure/
header controls and actual compile/link flags, reproduces original FPM
hashes, then prepares each LTO mode alone/with small fusion. Each mode has
its own ordinary CLI/FPM artifacts. Non-PHP probes remain exact reference
controls; actual newly compiled PHP correctness must be checked separately.

The WordPress survey accepts `KANDELO_SURVEY_VALIDATE_TIMESTAMPS=0|1`
(default1) and `KANDELO_SURVEY_CHECK_TIMESTAMP_POLICY=0|1` (default0).
The latter is a correctness diagnostic after the page requests, not a timing
configuration: both FPM workers must see edits with validation enabled, retain
the old program with validation disabled, and see the edit after explicit
cache invalidation. File-cache-only PHP returns false from
`opcache_invalidate()`; that mode separately tests explicit removal of the
probe's disk-cache entry. The diagnostic edits only its private guest test
file and adds a blacklisted controller. It never changes the preview's cache
policy. Short diagnostic runs do not establish an APP-02 performance benefit.

`survey/wordpress-paired-run.mjs node|browser VARIANTS PROFILE IMAGE NATIVE
FRESH_OUT [sqlite|mariadb]` is a separate WordPress protocol for per-case
compiler, host and application factors. It requires explicit `pairReferences`
and `nativeArtifacts`; optional `hostProfiles` require declared bundle hashes.
`appOptions` may bind `validateTimestamps` for every case (default true when
absent). Each policy applies to both that case's ordinary and virtualized
controls. Two reversed cohorts bracket each pair with its own ordinary builds.
Warmup defaults to2 rounds and measurement to5; override with the survey
warmup/round variables. Timestamp diagnostics are disabled during collection.
Run Node and browser stages sequentially into fresh `node` and `browser`
subdirectories, then use `survey/summarize-wordpress-paired.py NODE BROWSER
FRESH_SUMMARY`. It validates complete plans, settings, identities, cache and
teardown before reporting ratios; shared/ordinary includes cache-mode effects.

`survey/prepare-wordpress-policy.mjs FUSION_MANIFEST PROFILE NATIVE FRESH_OUT`
prepares APP-02 configuration-only cases using the same existing small-fusion
VM module, ordinary compiler and host profile. It builds no programs/images
and does not alter the editable preview. Keep raw diagnostics and timing
matrices separate, including every failed or inconclusive attempt.

`wordpress-paired-run.mjs node-cpu ...` collects a separate instrumented Node
CPU matrix; summarize it with `summarize-wordpress-cpu.py DIR FRESH_SUMMARY`.
`wordpress-cpu.mjs` wraps the ordinary host fetch method only in that child
Node process and restores it afterward. It aligns page requests to
`process.cpuUsage()` deltas, rejects overlapping page intervals, and retains
concurrent status requests without summing them. This measures current-process
user/system CPU, including runtime threads/background work, rather than PHP-only
CPU. See the [Node24.15 API](https://nodejs.org/download/release/v24.15.0/docs/api/process.html#processcpuusagepreviousvalue).
Clock-loop probes are retained without subtracting a correction. The plain
WordPress summary rejects CPU matrices; do not pool them with uninstrumented
latency or infer browser behavior from them.

### Access-count diagnostics and aligned atomics

`access-diagnostics/` is a separate, deliberately expensive post-pass over an
outlined VM artifact. Build it for the build machine through the dev shell,
then invoke `common-memory-access-diagnostics INPUT HELPERS OUTPUT REPORT`.
It checks the supplied helper bodies against the merged input and preserves
original function/global indices. Pair its output with a separately built
`platform/build.mjs OUTPUT --pregrow-group --access-diagnostics` host profile.
`survey/wordpress-accesses.mjs` takes the same arguments as
`survey/wordpress-node.ts` and captures per-root operation/function counts
between ordinary resource snapshots. Fork starts fresh counters on its own
root. Counter pages are independent physical diagnostic allocations; snapshots
return copied scalar values. These artifacts and their request times must not
enter uninstrumented timing comparisons. The first all-host results and
limitations are in the living optimization catalog, phase27.

The translator's opt-in `--fuse-atomics` specializes atomic accesses with
constant offsets up to16 bytes. It still checks the full virtual endpoint,
required alignment, permissions and mapped backing. Once alignment is checked,
a power-of-two atomic width divides the64KiB page, so the general split-page
span/staging path is unnecessary. It can be tested individually with
`--outline-accesses --fuse-atomics`, and combined with scalar fusion by adding
`--fuse-scalars=small`. The metadata reports atomic and scalar coverage
separately. `survey/build-atomic-fusion.py FRESH_DIR` creates both individual
and combined variants, reproduces the two existing reference FPM hashes and
builds differential atomic fixtures. Mechanism checks do not establish a
performance benefit; matched timing remains a separate stage.

`platform/build.mjs OUTPUT --pregrow-group --sparse-fork-backing` builds the
separate RT-01 destination-allocation variant. Only committed-fork allocation
requests omit initial payload pages; the existing snapshot copy allocates one
extent for unique private source pages, preserving private aliases, holes and
live shared entries. It does not reclaim or reuse any old physical extent.
`--scratch-bytes=1048576` additionally selects a1MiB scatter capacity; the real
bound remains enforced. These reduce allocator consumption without changing
the group's declared512MiB backing. Node and three-browser application/resource
first screens are in the catalog. General lifecycle acceptance and speed
benefits remain unmeasured.

`--reuse-unmapped-pages`, together with `--sparse-fork-backing`, additionally
tests host allocation from coalesced free extents. Successful mmap replacement,
munmap and mremap shrink/move operations nominate discarded payload pages.
The owning kernel Worker scans every explicitly registered root and pending
fork snapshot before releasing a candidate. Private aliases and live shared
PTEs pin backing; captured fork-private bytes have independent copies, while
pending fork-shared bytes stay pinned. Reused extents are zeroed before
publication. Guest C memory.grow retains its existing monotonic allocator and
lock; it does not consume the free pool. The `unmappedReuse` resource snapshot
reports reclaimed/reused/free pages and retained root/snapshot counts.

This is not root or scratch retirement: all roots, including exited roots,
stay registered. Failed/uncompleted snapshots deliberately stay pinned until
explicit cancellation ownership exists. Mapping mutation is owner-only and
uses the prototype's single Worker/process syscall boundary. Combining this
flag with byte slices is rejected pending physical-alias lifetime proof. It
does not establish arbitrary concurrent remapping, indefinite churn, RSS or
reservation reduction. `platform/reuse.config.ts` runs the disposable-Worker
mechanisms; `survey/reuse-apps.config.ts` supplies paired SQLite checks.
The catalog's phase32 records the first allocation results and limitations.

`survey/wordpress-preload.mjs` uses the ordinary WordPress Node arguments and
captures an inventory of actually cached PHP files. Set
`KANDELO_PRELOAD_INVENTORY` to that run's `inventory.json` in a new run to
exercise native PHP compile-only preload. Results are marked diagnostic and
include actual preload statistics and completion, applied configuration,
startup/application samples and resource state. This is an immutable-code
experiment; it does not change preview behavior or establish update visibility.

`survey/preload-capability.mjs PROFILE FPM FRESH_OUT MODE` is an independent
Node diagnostic, using `native-file`, `vm-file`, `vm-shared` or
`vm-shared-no-preload`. A tiny target defines a function and class; both workers
must observe correct definitions/values when preloaded. The execution marker,
cache mode/status and normal requests are retained. In the tested profile,
file-cache-only modes do not execute preload, while shared OPcache does.
Preload latency must compare shared-cache preload/no-preload; ordinary file
timing is a separate reference with different verified capability. Do not pool
this diagnostic or old preload probes into unprofiled timing cohorts.

`survey/wordpress-preload-run.mjs HOST VARIANTS PROFILE IMAGE NATIVE FRESH_OUT sqlite`
collects plain APP-01 latency, alone and with the byte/small-fusion preset.
Its explicit `preloadPaths` app option is `null` for off or a validated PHP
inventory for on. Omitting it preserves legacy fixture behavior and option
shape. Enabled cases require shared OPcache; ordinary file-cache brackets are
explicitly unpreloaded references with different capability. The fixture uses
normal VFS/ini preparation, with no prototype hooks or timed counters. Both
workers' compiled inventory, persistent definitions and preload statistics are
checked after timed requests. Startup and sampled allocator state remain
separate from warm latency. Phase42 retains reversed-order results, startup
cost, extra allocation and all weak/inconsistent performance signals. The
fixed SQLite corpus does not establish MariaDB, unseen-code or editable-code
preload behavior; shipping defaults and the frozen preview are unchanged.

The `feasibility` crate's read-only `regions` binary screens empty-stack,
call/control-bounded i32 spans. The instrumenter can apply the same analysis
with `--guard-regions=4`: a nonfaulting guard selects physical-base reuse or
the original translated operations in their original order. Guest pointer
values stay canonical and derived physical temporaries are not live across
calls/control boundaries. `survey/build-regions.py FRESH_DIR` builds individual
and small-fusion combined artifacts. Counts are static; PHP dynamic hit coverage
and a reliable application latency benefit remain unmeasured. Phase31 retains
the mechanisms and inconclusive initial Node timing, including regressions.

The feasibility crate's `calls INPUT FRESH_REPORT` binary compares the existing
call-bounded region grammar with transitive direct-call summaries. Build/run
it through the dev shell for the build machine (`cargo run --release
--manifest-path tools/common-memory-program/feasibility/Cargo.toml --bin calls
--target <build-host> -- INPUT FRESH_REPORT`). The strict policy excludes every
callee that can reach an import, indirect call, thread/atomic operation,
growth, exception unwind, unknown operation or guest-memory write. Unknown
store destinations could be syscall-channel fields. Only direct i32 signatures
can enter the current region grammar; caller-local address bases stay unchanged.

The separate `PublishPatternOpportunity` policy counts ordinary-write callees
without supplying a channel-alias proof. It must not authorize rewriting.
Already transformed artifacts and the translator's exact reserved names are
refused; musl's unrelated `__vm_wait`/`__vm_lock` exports remain valid. These
reports do not remove translations or enable a cross-call runtime fast path.
Phase34 in the catalog records static coverage, historical whole-parent dispatch
bounds, the exception/fork integration limit and retained broader analyses.
### WordPress compiler screen

`survey/wordpress-compiler-run.mjs` and `wordpress-compiler-plan.mjs` collect a
bounded SQLite WordPress screen for existing PHP/helper O3 and full/ThinLTO
artifacts, including the available small-offset fusion combinations. Ten VM
shared-cache modes run in opposite fresh-parent orders on Node and all three
browsers. Four actual PHP compiler builds each have opening/closing ordinary
file-cache references. All modes hold the host profile, timestamp-off policy,
image and workload constant; helpers O3 and main-program C LTO are identified
separately from dependency/compiler settings. Two warmup and five measured
mixed-page rounds are retained per parent. The fixture validates real
home/article/admin/REST results, login, both FPM workers, cache mode, artifact
identities and teardown. Ordinary-versus-VM ratios include cache-mode effects;
this is neither a pure translation-tax measurement nor proof of an optimal
compiler configuration or whole-platform improvement.

### WordPress allocation lifetime study

`survey/wordpress-resource-run.mjs` and `wordpress-resource-plan.mjs` exercise
the existing sparse-fork/1MiB-scratch profiles with mapped-payload reuse off
and on, plus an ordinary-addressing file-cache reference. Each fresh parent
runs two warmup and128four-page rounds on the same SQLite image and exact
small-fusion guest. Per-round allocator/PTE/reuse statistics and successful
page progress remain in the normal fixture output. The512MiB common backing,
normal watchdogs and all application assertions remain unchanged.

Resource failures keep their actual Node/Playwright nonzero statuses and
partial results. The collector continues with the other independent cases;
its completion receipt is not an application-pass receipt. There is no
restart, forced GC, raised ceiling or automatic retry within a case. This
bounded fixed-pool study does not measure RSS, rank latency or prove process
retirement, worker-replacement churn or compatibility with byte snapshots.

### Optional writer-loop site diagnostic

`access-diagnostics INPUT HELPERS OUTPUT REPORT --writer-loop-sites NATIVE`
adds an opt-in fourteen-class observer derived from the exact untranslated
native bytes. Slots208–214 preserve the old origin/readonly classes;
215–221 add writer-loop, empty-entry, empty-entry-with-stride-hint, their
scalar/SIMD-store subsets and a readonly/writer union. The report uses explicit
origin-site metadata version2. Legacy plain and seven-class output bytes are
reproduced unchanged. Category and per-function counters exclude these
overlapping classes.

Only modeled loop effects exactly equal to guest writes qualify. Bulk
copy/fill/init can qualify a loop, but these site classes count memarg
operations, not bulk bytes. Nested intervals form unions. Counts reflect
attempted accesses only when control reaches a site, including a trapping
access. They do not prove mapping lifetime, channel/control disjointness,
induction, bounds, no-wrap or safe translation elision. Never time this
instrumented output as an optimization. Phase51 in the catalog records its
mechanisms and actual WordPress reach.

The frozen WordPress source image contains1,500 prebuilt OPcache files.
Ordinary FILE-control results on that image inherit this corpus; a fresh
parent is not an empty cache. Shared-mode trials explicitly disable FILE
cache. Empty-cache controls and cross-dispatch FILE compatibility require
separate checks before promotion. The interactive preview remains unchanged.

### Read-only wrapper-key survey

`cargo run --manifest-path tools/common-memory-program/instrument/Cargo.toml
--target <build-host> --bin wrapper_keys -- INPUT FRESH_REPORT` inventories
exact instruction keys and hypothetical non-atomic alignment/offset policies.
Atomic keys and operation/lane identities remain exact; mixed generic and
specialized signatures stay distinct. Offsets greater than16 are a static
category, not proof of coldness. The explicit default run target remains
`common-memory-program-instrument`. This analyzer emits no guest code and
makes no latency or code-size claim. Phase52 records the counts and failures.

A separate cache-empty WordPress image now passes32Node/browser/backend
functional cases, and a core CALL/GOTO CLI FILE-cache corpus passes154checks
per host, including poisoned-source/empty-cache negatives. Phase53 also proves
ordinary CALL cache generation on all four hosts (565 files/24,456,992 bytes)
and completes a clean-image CALL wrapper timing screen. Compatibility of the
full prebuilt WordPress cache corpus remains unproved; the earlier preseeded
image results retain that qualification.

### Optional alignment and generic-offset wrappers

The translator accepts `--canonicalize-nonatomic-alignment` and
`--generic-large-offsets` with `--outline-accesses`. The first normalizes
non-atomic instruction alignment hints to natural alignment. This is not an
alignment proof: split, overflow and permission checks remain. The second
passes non-atomic offsets greater than16 as an additional i64 argument, after
the original address/value operands. Small offsets remain specialized;
atomics, operation identities and SIMD lane immediates remain exact. Generic
and specialized wrapper signatures have distinct keys. Dynamic offsets feed
both address resolution and scattered-store commit without truncation.

Generic large offsets currently reject regional/object guards, affine caches,
atomic fusion and scalar fusion beyond small offsets. Ordinary helpers and
`--fuse-scalars=small` are the tested configuration; combining other accepted
flags needs its own evidence. Neither option changes the default. Original
outlined/fused CLI/FPM output byte identities are preserved without these flags.

Phase53 implements all eight combinations of alignment normalization, generic
large offsets and small scalar fusion. CLI/C/shared-OPcache mechanisms pass on
Node/Chromium/Firefox/WebKit; all64WordPress variant/backend/host parents pass.
The subsequent80-parent SQLite screen measures1,600pages. Removing over94%of
wrappers adds about1.1MBof Wasm and shows no clear incremental warm application
gain over fusion. Fusion-only ratios versus outlined are0.880Chromium,
0.896Firefox and1.063WebKit; all-three ratios are0.876/0.895/1.048. Node has
large cohort reversals and varying load, so its aggregate is inconclusive.
These are descriptive page-median ratios, not CPU or general throughput.
Own ordinary FILE controls start with an empty cache; shared/ordinary ratios
include OPcache-mode effects. All order/page/native values, failures and
unmeasured follow-ups remain in the optimization catalog and retained archive.
No default/runtime/SDK/ABI/package or frozen-preview change is implied.

### Constant-address applicability diagnostic

`cargo run --manifest-path tools/common-memory-program/feasibility/Cargo.toml
--target <build-host> --bin constants -- INPUT FRESH_REPORT` adds an opt-in
constant-address view. It follows modular i32 producer expressions and
straight-line local constants, conservatively discarding knowledge at joins
and loop-carried writes. Loaded pointers, call results and globals remain
unknown. Unsigned memarg addition is checked separately from i32 wrapping.
The existing `origins` entry point retains its original behavior.

The access-diagnostics tool accepts `--constant-sites NATIVE_MODULE` for an
exact native/outlined operation-order join. Its eight overlapping classes use
slots208–215 and separate version3originSites metadata. These counters measure
attempts, including a trapping access; they remove no translation or checks.
Use the diagnostic memory adapter/profile, never plain `memory.mjs` or these
instrumented artifacts for timing. The previous origin canary remains byte
identical, and mismatched/native/overwrite inputs are rejected.

Phase54's four-host WordPress SQLite census observes5.3418%recognized constant
dispatches:3.0257–3.0258%non-atomic loads,1.2057%stores and1.1103–1.1104%atomics.
All reached constant ranges fit one page. Constant-address atomics account for
about20.35%of atomic dispatches. These are service-wide attempt frequencies,
not CPU share or speedup; small third-root activity remains included. Static
constants span4,719addresses/35pages, which is not a reached-page histogram.
Initial active-data membership is unavailable: all three actual PHP segments
are passive, so a zero in that diagnostic category is not a negative result
for linked data. Generated fork-state ownership still needs an emitted-origin
map. Constant single-page arithmetic specialization, with live PTE/permissions
and atomic payload reads retained, is a separate unimplemented hypothesis.


### Experimental portable PHP tail-call dispatch

The private PHP builder accepts `--c-tail-calls` for the PHP C-only
`-mtail-call` feature, leaving the selected CALL interpreter unchanged.
`--portable-tailcalls` requires the completed generated-header manifest and
`--vm-key call-specialized`; it derives four private headers under the fresh
build directory using `survey/portable-tailcalls.py`. Both options currently
require O2, no LTO/PGO. C++ and dependency flags stay unchanged. This is a
research build option, not a package/SDK/default recommendation.

The portable adaptation relies on real Wasm feature detection and ordinary
Wasm C calling convention. It retains both tail dispatch and public ordinary
single-step tables, scopes their macros, and preserves musttail requirements.
Do not fake `HAVE_PRESERVE_NONE`/architecture macros or weaken musttail to make
the generated sources compile. A no-feature TU check correctly selects CALL.

Phase55's24real Zend API and72recursive-fork/shared-OPcache runtime parents
pass on Node and all3browsers, but portable ordinary-addressing Node WordPress
startup exhausts the stack in a generated fork transport. It is excluded from
latency collection. Simple C reductions do not reproduce on Node, so the exact
PHP routing shape remains open. Do not bypass unwind checks to hide this.
CALL+feature passes both-database application gates and own-build FILE-cache
reuse proof on all hosts. See phase55in the optimization catalog for the
separate compiler-feature/fusion timings, controls and retained failures.


A separate minimal100,000-iteration pure-PHP loop later reproduces portable
stack exhaustion in both ordinary and fused addressing on all4hosts, with
all16CALL/feature controls completing. Firefox's raw failure is-1/recursion,
others139/stack exhaustion; this is not a memory-translation or WordPress-only
failure. Small C counterexamples remain, and no unwind-protocol shortcut is
applied. The completed64-parent SQLite timing screen finds no consistent
feature-only or feature-added-to-fusion latency benefit; Firefox is
inconclusive due cohort disagreement/load. Fusion alone again helps
Node/Chromium and regresses WebKit. All combinations and own ordinary
references remain in phase55of the catalog, without a default promotion.


### Breadth follow-up: size flags, constant guards and worker replacement

Phase56of the catalog preserves three bounded experiments:16real C-unit
O2/O3/Os/Oz object admissions, a handwritten constant-VA8192/width4 helper
cost model, and48actual FPM worker replacements across8parents/all4hosts.
Size flags reduce compiler/cache bodies more than interpreter bodies, but Oz
can enlarge the largest function; no linked-PHP/runtime benefit is claimed.

The constant helper retains current-root logical/PTE/permission checks and
actual payload operations.300mechanisms pass; a560-sample ordinary/outlined/
scalar/atomic-fusion/constant synthetic screen shows useful scalar opportunity
and smaller engine-dependent atomic increments. It is not an automatic
translation pass or PHP speedup. Below-ordinary scalar results include code
shape/JIT effects and ordinary-control drift, not a negative translation cost.

Real shared OPcache survives six SIGTERM worker replacements per case, but
logical allocation with mapped-payload reuse grows102.5→290.75MiB while live
roots remain3and retained records grow3→9. Existing reuse deliberately pins
exited roots. Root/payload/scratch retirement needs explicit authority and
quiescence proofs; no exit/WeakRef/GC/elapsed-time shortcut or root freeing is
added. The earlier flat fixed-pool WordPress curve is not worker-retirement,
RSS or indefinite-life proof. These are private research experiments against
the existing partial shell; no canonical product or memory-suite claim.

### Automatic constant-address specialization

The private translator now accepts `--outline-accesses --constant-addresses`.
It proves constant memory32 virtual addresses from the same original module,
binds each selected function/operator position and typed memory operation,
and specializes address geometry. Every execution still reads the current
root, logical page bound and live PTE, checks permissions/nonzero backing,
and performs the original payload operation. It caches no physical pointer
or payload. Forked private data and shared OPcache keep canonical virtual
pointers. This is an opt-in research transform, not a production ABI change.

The constant producer analysis is version 2. Loop input operands are unknown
because a backedge can replace them; the former first-iteration assumption
has a failing-before/passing-after regression. Constants do not require a C
`__stack_pointer` marker. Default origin analysis retains its original marker
contract. Unknown, unreachable, split-page, memory32-overflow and unaligned
atomic sites use the existing translation path. Unsigned memarg addition is
separate from wrapping i32 expression arithmetic; the exact 4 GiB logical
endpoint is covered. All scalar widths, SIMD lanes and atomic/wait/notify
operations retain their original instruction and operand effects.

The option admits scalar/atomic fusion and conditional commit. It rejects
nonoutlined helpers, object/region/affine modes and wrapper-key policies in
this first implementation. Detailed `constantPlans` stay in the external
report; module metadata contains a bounded summary. The selected wrapper
supersedes the fusion path at its own constant sites.

Phase 57 has 3,760 mechanism checks across Node/Chromium/Firefox/WebKit, 40 real
PHP CLI/FPM parents and 80 WordPress parents across SQLite/MariaDB, plus unit
and option-admission tests. All 36,608 selected PHP-FPM site identities match
the earlier eligible census; one recognized split-page site is excluded.
There are 6,219 constant wrappers, 13,069 total; either app variant adds 499,846
bytes (~1.31%). All four baseline CLI/FPM output hashes reproduce exactly.
The application factorial uses existing small-offset scalar fusion; atomic
fusion is covered by the separate mechanism suite. The primary app timing
keeps timestamp validation enabled. Eight additional
all-host ordinary/combined-profile diagnostics prove both workers load edited
PHP through automatic timestamp validation before explicit invalidation, with
FILE-cache population/reuse and shared no-FILE footprint verified. The first
validation-off timing batch is retained as interrupted on user steering.
Application timing and all controls are recorded in phase 57 of the
optimization catalog.

The longer timestamp-enabled phase 57 screen completes 47 of 48 parents; a
Firefox constant-only case returns empty HTTP 504 after 14 measured pages,
with root cause unresolved. The failed case is retained; previously unattempted
WebKit/Firefox controls are collected separately, never a replacement retry.
Node/Chromium scalar fusion improves the warm four-page aggregate by about
8.5%/7.4%; constants add no clear benefit there. WebKit has large control drift
and Firefox ranks are withheld. The new constant profile has no sustained
admission or default promotion. Full ratios, ordinary controls, cold timings,
loads and failure evidence remain in the catalog.

### Optional adapter-method diagnostic

`platform/build.mjs OUTPUT --pregrow-group --metadata-diagnostics` adds copied
`metadata` counters to `commonMemoryPrototypeStats()`. It observes kernel-realm
virtual-view/span method attempts, not CPU or all guest memory/syscall accesses.
Never use this diagnostic profile for latency claims. It is separate from
`--byte-slice-diagnostics` in this version. Default runtime bundles remain
byte-identical; scatter/fault/fork/mapping mechanisms and eight all-host
WordPress ordinary/VM parents pass. See phase 58 of the catalog for units,
observer windows, seeds and scope.

The retained-validation census finds typed-element reads account for roughly
94% of observed span attempts, DataView operations about 3.5%. That favors
attributing the typed-read paths and testing byte-copy changes with validation
kept, without forecasting a CPU saving. A separate traced Firefox attempt
completes in both outlined/constant profiles; the original HTTP504 remains
unresolved and its failed timing is retained. No new fast path or default is
promoted from these observations.

### Byte-copy/fusion with timestamp validation retained

Phase 59 repeats the guarded byte-copy and small-scalar-fusion factorial with
validation enabled. All 64 SQLite timing parents pass; each cohort brackets
both normal and byte host profiles with their own ordinary FILE controls.
Node/Chromium combined profiles are directionally promising versus baseline,
but Node scalar-only instability, a Firefox combination reversal, and adverse
WebKit results prevent a universal preset. All individual/combined/native,
cohort/page/cold/load evidence remains in the optimization catalog.

The plain-timing collector now also rejects metadata diagnostic profiles.
Forty PHP runtime and forty both-database WordPress admission parents pass;
real edited-PHP timestamp reload passes on all hosts. The policy collector's
own-log input-glob failure is retained and independently recovered without
a guest retry; a future explicit-source collector template is unexecuted.
Separate branch diagnostics confirm actual bulk/fallback use and are never
ranked as timing data. No production default or preview is changed.
