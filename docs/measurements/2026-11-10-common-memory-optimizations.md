# Individual and combined common-memory optimizations

This experiment characterizes the proposed optimizations individually and in
combination against untranslated native Wasm. It extends the
[initial mechanism fixture](2026-11-10-common-memory-prototype.md), using
manually expressed C transformations so actual LLVM optimization and LTO can
also be tested. It is not a general C/Wasm instrumentation pass, a production
runtime change, or a PHP-FPM performance result.

The completed experiment finds near-native dense sequential reads and writes
when a validated span feeds explicit SIMD. Small pointer and object walks
still cost about 1.4–2.1× native. The compiler options alone do not reproduce
the dense-array result, and several included options contribute little or
nothing in this fixture.

## Results

“Native” means untranslated Wasm in the same engine and common memory, not
a host machine-code executable. Each ratio uses the same compiler profile
and scalar/SIMD operation as its candidate. A vector row therefore has a
different native implementation from a scalar row. The retained full matrix
also includes absolute ns/op and a fixed O2 scalar-native denominator.

These are medians of all 14 paired ratios from two cohorts, including samples
that fail the stability rule below. Smaller is less elapsed time; 1.00× is
native time. A dagger marks an unstable comparison, not a correctness failure.
The representative operations here use a contiguous 64 KiB working set.

| Candidate | Operation | Node | Chromium | Firefox | WebKit |
|---|---|---:|---:|---:|---:|
| Checked baseline | read | 3.10× | 3.24× | 3.26× | 2.28× |
| One span guard | read | 1.75× | 2.12× | 3.11× | 2.05× |
| Checked baseline | pointer chase | 1.72× | 1.64× | 2.14× | 1.70× |
| Cached page | pointer chase | 1.67× | 1.55× | 1.63× | 1.64× |
| Proved alignment | read | 2.49× | 2.21× | 3.49× | 2.08× |
| Preserved bulk | copy | 1.00× | 1.01× | 1.02× | 0.99× |
| Scalarized bulk control | copy | 104.84× | 106.26× | 55.25× | 99.65× |
| Preserved SIMD | read | 1.99× | 1.99× | 2.00× | 1.98× |
| Opaque accessor, O2 | read | 6.40× | 7.20× | 5.97× | 4.93× |
| Clang O3 | read | 3.14× | 3.27× | 3.24× | 2.94× |
| Clang O3 + LTO | read | 2.90× | 2.67× | 3.25× | 2.31× |
| Opaque accessor + LTO | read | 6.40× | 7.54× | 6.36× | 4.70× |
| LLVM auto-vectorization | read | 3.01× | 2.85× | 3.24× | 3.06×† |
| Combined scalar, O2 | read | 1.97× | 2.18× | 3.09× | 2.10× |
| Combined SIMD, O2 | read | 1.01× | 1.00× | 1.00× | 1.03× |
| All together | read | 0.98× | 1.00× | 1.00× | 1.00× |

Automatic vectorization contributes **nothing to the emitted code here**:
the O3/LTO and O3/LTO/auto modules have identical SHA-256 hashes. Their timing
differences are experimental variation, not a vectorization gain. Explicit
SIMD is a separate transformation and does change the code.

Page caching is modest for the small pointer chase on Node, Chromium and
WebKit, but helps Firefox materially: 2.14× becomes 1.63× native. It has
little effect on the small sequential read. It should not be described as
universally useless. Alignment helps some engines and worsens Firefox reads
from 3.26× to 3.49×. O3/LTO provide no consistent gain across operations and
hosts, and LTO leaves the opaque read accessor call in the emitted loop.
Making the resolver inline has much better timings than that opaque control;
these flags do not automatically provide equivalent visibility.

The combined SIMD read at O2 is already about 1.00–1.03× its native vector
control. Its absolute times are 0.118–0.126 ns per word across hosts, versus
0.118–0.127 ns with every compiler option enabled. The all-together result
therefore does not establish that each included compiler option is useful.
This is not a complete leave-one-out ablation of every combined component.
The evidence points to validated spans and explicit SIMD as the main dense
read improvements. The scalar span path still branches on its fast-path
address inside the loop; it is not a perfectly hoisted native scalar loop.

Keep the individual candidates and compiler profiles available for application
experiments. A zero effect on this particular emitted module, a small gain on
one microbenchmark, or a regression in one engine is not a universal rejection
of that technique. PHP-FPM has a different access mix, code size, call graph,
object layout and mapping pattern. Its profiles and measurements should decide
which candidates are useful there.

Preserving bulk avoids a particularly bad scalarization cost, but the
original WAT prototype already did this. Standalone Binaryen O3 was screened
in the [earlier optimizer experiment](2026-11-10-common-memory-prototype.md#follow-up-optimizer-options):
it reduced code size while its separate-block timings were inconclusive
under changing load. The current all-together candidate includes Binaryen
O3, but this run does not isolate its marginal timing contribution.

## All together

This candidate combines span guards, invocation-local caches, alignment
knowledge, retained bulk/SIMD, Clang O3, LTO, LLVM automatic vectorization
and final Binaryen O3. A fast path uses only the applicable transforms;
fallbacks do not stack redundant successful guards.

| Operation | Working set | Layout | Node | Chromium | Firefox | WebKit |
|---|---|---|---:|---:|---:|---:|
| read | 64 KiB | contiguous | 0.98× | 1.00× | 1.00× | 1.00× |
| write | 64 KiB | contiguous | 1.00× | 1.00× | 1.05× | 1.00× |
| pointer chase | 64 KiB | contiguous | 1.36× | 1.38× | 1.40× | 1.41× |
| four-field object walk | 64 KiB | contiguous | 1.75× | 2.06× | 2.13× | 1.79× |
| read | 8 MiB | contiguous | 1.00× | 1.00× | 1.00× | 1.00× |
| write | 8 MiB | contiguous | 0.97×† | 1.00× | 1.06× | 1.00× |
| pointer chase | 8 MiB | contiguous | 0.95×† | 0.65× | 0.87× | 0.64×† |
| four-field object walk | 8 MiB | contiguous | 1.19×† | 0.90× | 1.10× | 0.97×† |
| read | 8 MiB | fragmented | 1.57× | 1.50× | 1.38× | 1.13× |
| write | 8 MiB | fragmented | 1.91× | 1.95× | 1.82× | 1.94× |
| pointer chase | 8 MiB | fragmented | 1.15× | 0.77× | 0.97× | 0.82×† |
| four-field object walk | 8 MiB | fragmented | 1.26× | 0.87× | 1.17×† | 0.94×† |
| atomic RMW | 64 KiB | contiguous | 1.00× | 1.00× | 1.00× | 1.00× |
| copy | 64 KiB | contiguous | 1.00× | 1.00× | 1.01× | 0.99× |

These dense-array results do not eliminate the address-translation cost for
general pointer-heavy code. The fragmented sequential fallback still costs
1.13–1.95× native here. Large random-walk ratios below one are observations
with separate backing storage and independently calibrated repetitions;
cache/layout, code-generation and scheduling effects have not been isolated
with profiles. They do not establish that translation itself makes memory
access faster. Likewise, 0.98× versus 1.00× is native-like timing, not proof
of a two-percent translation speedup.

## Run identity and retained evidence

The completed job was `common-memory-all-optimizations-1110-181123-344f`,
using source HEAD `6d5ebb19b24572480edebd5dc355dfca36ae63c6` plus the hashed
uncommitted fixture. It ran on November 10, 2026, approximately
23:11–23:43 UTC, on an Apple M5 Max, macOS/arm64, 18 logical CPUs.

| Host/tool | Version |
|---|---|
| Node / V8 | 24.15.0 / 13.6.233.17-node.48 |
| Chromium | 153.0.8010.12 |
| Firefox | 155.0 |
| WebKit | 26.6 |
| Clang / LLD | declared LLVM 21.1.7 toolchain |
| Binaryen | 126 |

Two separate Node parent processes and two browser-runner cohorts per engine
were used. Native bracketing and randomization reduce drift, but this was a
shared machine: one-minute load ranged from about 24 at the first Node entry
to about 3 after the last WebKit cohort. Of 162 comparisons per host, the
stability rule accepts 137 on Node, 156 on Chromium, 152 on Firefox and 110
on WebKit. Unstable comparisons remain in every table and raw file.

The earlier WAT and present C native implementations differ, so these results
are not a direct before/after comparison with the initial WAT ratios.

Retained inputs and outputs:

- [Complete individual/combined matrices, both native references and absolute times](../../.context/common-memory-all-optimizations-20261110/raw/optimization-summary.md)
- [Machine-readable summary](../../.context/common-memory-all-optimizations-20261110/raw/optimization-summary.json)
- [Source and Wasm provenance](../../.context/common-memory-all-optimizations-20261110/raw/provenance.json)
- [Compiler flags, tool identities and artifact hashes](../../.context/common-memory-all-optimizations-20261110/raw/optimization-build.json)
- [Static instruction-site audit](../../.context/common-memory-all-optimizations-20261110/raw/optimization-static-audit.json)
- [Exact measured fixture sources](../../.context/common-memory-all-optimizations-20261110/sources/README.md)
- [Build/check/benchmark log](../../.context/common-memory-all-optimizations-20261110/job-output.log)
- [Retention manifest](../../.context/common-memory-all-optimizations-20261110/retention-manifest.json)

The retained `raw/` directory contains all eight host/cohort JSON files,
generated C, LLVM IR, WAT, Wasm and disassembly. All 33 source hashes and eight
Wasm hashes were checked while copying. The final in-run provenance check
passed. Static inspection confirms retained `memory.copy` and SIMD sites;
none of the five C modules contains a `global.set` instruction, so this
fixture does not actually exercise C shadow-stack allocation.

## Algorithms

| Candidate | Work removed or retained | Fallback |
|---|---|---|
| Checked baseline | Resolves ordinary accesses through the virtual page table | Split-page scalar handling |
| Span guard | Nonfaulting validation of a contiguous cyclic range once per call, or 16-byte object once per node | Original scalar operations if bounds, permissions or contiguity decline |
| Page cache | Reuses a decoded page and its permissions within one invocation | Refill on page/rights change; original split-page handling |
| Alignment proof | Uses a real base-alignment guard to omit split-page tests in aligned sequential loops | Original unaligned path; pointer chasing checks each new pointer |
| Preserved bulk | Retains LLVM `memmove`/Wasm `memory.copy` instead of scalarizing it | Validates all pages, then stages scattered/overlapping data safely |
| Preserved SIMD | Validates four-word chunks and uses explicit vector operations | Original scalar operations, including fault prefixes and tails |
| Compiler visibility | Compares an inline resolver with an opaque accessor in another translation unit | LTO is tested without changing the access contract |
| Combined | Uses a span fast path, invocation-local cache/alignment fallbacks, retained bulk/SIMD and all selected compiler options | Failed guards preserve original fault behavior |

The earlier WAT prototype already preserved bulk operations. The deliberately
scalarized copy is a separate control illustrating the cost of destroying a
bulk operation; retaining bulk is not a newly claimed gain over that earlier
path. Likewise, explicit SIMD is compared with explicit SIMD native code.

Five compiler profiles cover Clang O2, O3, O3 with LTO, O3/LTO with automatic
vectorization, and the last profile plus a final Binaryen O3 pass. Scalar
profiles disable automatic loop/SLP vectorization to isolate scalar access
transforms. Explicit SIMD remains available in all profiles. The auto and
final combined profiles enable normal LLVM vectorization as well.

## Native references and measurement

Each candidate is bracketed by the same operation compiled with its own
compiler profile but without virtual translation. Thus vector candidates use
a native vector reference, and LTO candidates use an LTO native reference.
A fixed O2 scalar-native anchor is also bracketed and recorded. This keeps
vectorization and compiler gains distinct from translation overhead.

Each host has two cohorts, seven randomized orders per case, independent
checksums and per-operation normalization. Counts are calibrated separately
to accommodate the very different cost of scalarized and bulk copies.
Pointer graphs cover at least four complete cycles plus a nonzero,
independently checked remainder. Initialization, compilation and Worker
launch are excluded. All samples are retained.

The stability rule was fixed before the full run: native before/after spread
at most 25%, timed samples at least 2 ms, at least four acceptable brackets
out of seven in each cohort, and cohort median ratios agreeing within 20%.
Comparisons that fail this rule receive a visible marker. This rule does not
remove all scheduling or shared-machine uncertainty.

Cases include reads, writes, dependent pointer chasing and four-field object
walks over 64 KiB and 8 MiB, fragmented 8 MiB mappings, uncontended atomic RMW,
and 64 KiB copies. The native graph is contiguous in the common Wasm memory;
fragmented translated graphs use another page ordering. Their comparison is
a fallback stress control and includes layout effects. Here, a “physical”
address means an offset in the common Wasm memory, not a host hardware address.

## Correctness and scope

Mappings are stable for the complete synchronous guest call. Cached state is
invocation-local and cannot survive a remap or permission change at the next
entry. Mutable shared payload bytes remain live; no data snapshot or data
immutability is inferred from the mapping guarantee. C shadow stacks and bulk
scratch storage are separate allocations owned by the fixture.

All eight cohorts passed 35 compiler-profile/mode groups and 210,000 scalar
oracle attempts each (including expected permission/bounds refusals), for
1,680,000 attempts total, plus private/shared graph cloning, remap and
permission changes, unaligned/split-page accesses, SIMD tails, denied store
prefixes, overlapping aliases, fragmented bulk destinations and real
two-Worker optimized atomics. The original WAT mechanism checks also run.

A strengthened regression test exposed a missing destination preflight in
the new C copy fallback: a denied suffix allowed a partial write. The test
failed on the old compiled artifact with `bulk denied destination had a
partial write`. The fix validates the complete source and destination before
staging or changing any destination byte. The negative control is retained
under `.context/common-memory-optimization-regression-20261110/`.

These fixtures do not implement concurrent mapping revocation, arbitrary
module isolation, a general instrumentation compiler, Kandelo fork
continuation, host/syscall memory translation, or PHP-FPM/OPcache integration.
No canonical image or full platform benchmark/conformance claim is made.

## Readiness for a PHP-FPM experiment

The mechanism checks and cost screen justify starting an opt-in application
experiment. They do not make the hand-written kernels a compiler pass that
can already execute PHP. Review of the current recipe, fork contract and host
allocator identifies the following prerequisites:

- Apply address translation to a real SDK-built module, including linked
  libraries, fork-generated accesses, data initialization, bulk/SIMD/atomic
  operations and virtual `memory.size`/`memory.grow`. Refuse uncovered code or
  unsupported dynamically loaded modules rather than accepting partial coverage.
- Give each process its own virtual mapping root, while keeping private and
  shared backing allocations in the one group memory. Adapt syscall buffer,
  TLS/control-region, loader and fork capture/replay accesses to that address
  model. Keep pointer values virtual across a fork. Bound group allocation
  against the common memory's limit, rather than assuming each process still
  receives an independent maximum.
- Replace the fixture's fixed-mapping call assumption with a lifecycle that
  covers actual mmap/munmap, fork and any supported threading. Mapping
  stability must not freeze shared payload data or hold a lease across a
  blocking call that needs another mapping operation to progress.

PHP 8.5.12 currently includes OPcache in the CLI and FPM executables. The normal
recipe's `kandelo-opcache-file-cache-only` guard in
[`build-php.sh`](../../packages/registry/php/build-php.sh) explicitly rejects
shared mode. Remove that restriction only in an experiment whose runtime and
artifact admission establish actual sharing. Preserve the normal SDK,
resolver and fork-aware build path; the archived Madison helper architecture
provides useful tests and experience, not a drop-in implementation of this
one-common-memory architecture.

The smallest application acceptance target is a two-worker FPM pool: distinct
worker PIDs, a cache entry published by one worker and reused by its peer,
shared invalidation, independent private request state, and worker replacement
without stale pointers or replayed mapping-cache authority. Exercise this on
Node and then Chromium, Firefox and WebKit. Start with PHP CLI/fork canaries
before serving requests; defer WordPress until these checks pass.

Use three end-to-end controls: ordinary addressing with the existing file
cache, virtualized addressing with the same file-cache configuration, and
virtualized addressing with shared OPcache. The first pair isolates address
virtualization under matched cache settings; the last pair measures the net
effect of changing cache mode within the new address model. Record cold/warm
requests, throughput, memory use and fork/worker replacement costs. These
application measurements have not been run yet.
