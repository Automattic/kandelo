# Portable histogram owner foundation

This is a native source foundation, not an enabled guest `perf_hooks`
implementation. No namespace, public wrapper, native JavaScript binding,
package recipe, event-loop sampler, or browser behavior is enabled by these
files. The frozen performance audit remains the guest support inventory.

## Source and ownership boundary

`histogram-source-identities.json` records the exact Node 26.13.0 target,
source archive and commit, plus SHA-256 identities for every copied file.
`upstream/histogram-reference/` contains unchanged `src/histogram.h`,
`src/histogram-inl.h`, `src/histogram.cc`, the public
`lib/internal/histogram.js`, and the complete bundled HDR C library.
The generator verifies their identities and the existing Node target pin.
The Node license is in `LICENSE`; HDR retains its own `LICENSE.txt`.

`generate-histogram-owner.py` extracts real Node owner algorithms into
`histogram-owner.{h,cc,-inl.h}` and the sliding ring algorithms into
`histogram-window.cc`. `--check` verifies the generated files without
writing. Copies of V8 declarations and libuv samplers remain reference
material only; their presence does not establish implementation support.

The portable adaptations are explicit:

- The namespace changes to `kandelo::histogram`; Node `MemoryRetainer`
  inheritance, V8 wrappers, and external-memory callbacks are removed.
- `unique_ptr` calls unchanged `hdr_close`; `shared_ptr<Histogram>` owns
  the actual histogram and statistics. A shared message-clone bridge must
  retain that same pointer. `Clone()` creates an independent allocation.
- Node read/write lock scopes use `std::shared_mutex`. Cross-owner locking
  uses `std::less` to preserve pointer-ordered locking with a total order
  even for unrelated allocations. Self-add/subtract use a single lock.
- Node's always-on `CHECK` invariants remain always-on aborting checks;
  they do not disappear under `NDEBUG`.
- `uv_hrtime()` becomes an immutable, thread-safe monotonic-nanosecond
  clock capability. The default uses `clock_gettime(CLOCK_MONOTONIC)`.
  Independent clones retain the clock and previous timestamp; diffs
  retain the clock but have no previous timestamp. Tests can inject a
  native function pointer, without involving JavaScript or a host timer.
- Count and exceeds storage/getters use `uint64_t` instead of Node's
  native-host `size_t`, preserving the native 64-bit observable range on
  guest wasm32. HDR bucket counts and values stay signed `int64_t`;
  allocation sizes remain `size_t`.

HDR sources and numerical/statistical/CBOR algorithms are not simplified,
reimplemented with JS arrays, or replaced with canned results. Histogram
memory follows upstream ordinary allocation/free behavior; it is not a
secure, zero-on-free allocation. Export/import is the upstream histogram
CBOR format, not JavaScript engine serialization.

## Requirement trace

The following identifies implemented native material and the separate
missing public/backend portions. References are relative to the unchanged
`upstream/histogram-reference/` tree. The full requirement inventory is
`tests/nodejs/audit/performance-requirements.json`; the ownership discussion
is `tests/nodejs/audit/performance-contracts.md`.

| Requirement family | Native foundation | Separate integration still required |
| --- | --- | --- |
| Creation and configuration | `Histogram::Create`, exact HDR layout, EWMA alpha/threshold; `src/histogram.cc:61–77` | Wrapper defaults, bigint losslessness, validation/errors and branded constructors |
| Basic statistics/counts | Exact min/max/count/exceeds, mean/stddev, percentiles, skewness/kurtosis; `src/histogram-inl.h`, `src/histogram.cc:301–358` | Number versus BigInt conversion, Maps, brands, accessors |
| Probability and buckets | CDF, countAt, percentile batches, linear/log HDR iterators | Public ccdf complement, sorted/deduplicated batches, all input validation |
| Inference/comparisons | Full incomplete-beta/t/normal numerical helpers, mean/percentile CI, KS/Welch/Mann-Whitney/Cohen/Cliff algorithms; `src/histogram.cc:438–679,1291–1568` | Exact result objects, null prototypes, public option/errors |
| EWMA/SLO | Per-successful-sample mean/variance/error-rate updates, source add/subtract/reset semantics | Public burn-rate formula and validation |
| Recording | Record, actual-clock RecordDelta, coordinated-omission RecordCorrected, HDR add/drop counts, subtract/clamping/resetCount | Nonnegative/lossless values and positive expected-interval validation; wrapper mutators return undefined |
| Snapshots/diffs | Independent `Clone`, copied complete owner state, same-layout diff and exact native error categories | Read-only public snapshot class and error construction |
| CBOR export/import | Sparse counts, exact version 1/2 unknown-key behavior, duplicate/type/length/count checks, options and EWMA; `src/histogram.cc:1055–1290,1570–1916` | Actual Uint8Array view offsets/lifetimes, allocation failure/error mapping |
| QRDE | Exact numerical calculation and snapshot/cache source ownership; `src/histogram.cc:680–940`; prepared `HistogramQrdeWork` captures at construction and runs later | Real asynchronous dispatch, cancellation, rooted JS resolver/result delivery, cleanup when JS cannot run, Float64Array results |
| Sliding windows | Lazy independent chunks, exact time/count generation and attempted-record rotation, lazy reset, independent materialization; `src/histogram.cc:2378–2463` | Separate noncloneable JS class, external-memory accounting, public duration-to-ns/options validation |
| Shared lifetime | `shared_ptr`, owned histogram/free, lock protection and independent snapshots | Engine native resource roots/finalizers, structured-clone retention and accounting |
| ELDHistogram | Histogram material can receive real samples | All interval and per-iteration scheduler ownership, unref/start/stop/disposal, prepare/check timing, environment cleanup and clone-to-plain-Histogram behavior |
| toJSON/inspect | None needed in the algorithm owner | Unchanged public wrapper integration and exact returned shapes |

The source's comparison and subtraction preconditions are retained; this
foundation does not invent new compatibility rejection where the pinned
implementation has none. Diff does check layout, normalization offset,
reset generation, exceeds order, and every bucket count.

## Native integration contract

Compile unchanged
`upstream/histogram-reference/deps/histogram/src/hdr_histogram.c` as C11;
add its `include/` directory and this directory to include paths. Compile
`histogram-owner.cc` and `histogram-window.cc` as C++20 with pthreads.
No V8, libuv, JSON, CBOR, or histogram package dependency is needed beyond
the checked-in HDR code and the already required C++/POSIX runtime.
This is an integration requirement, not a package recipe change made here.

Before guest use, the engine bridge must:

1. Define real native classes/brands and a rooted native resource owner.
   Retain `shared_ptr<Histogram>` for message clones; use `Clone()` for
   independent snapshots. Distinguish Histogram, RecordableHistogram,
   ELDHistogram and the noncloneable SlidingWindowHistogram.
2. Adapt the unchanged public `internal/histogram.js` through the ordinary
   module loader and performance binding. Do not expose the constructors
   as additional `perf_hooks` namespace exports. Preserve upstream errors,
   validation, numeric/BigInt conversions, maps and result prototypes.
3. Account actual HDR allocations and cached/copied snapshot storage to
   the engine, including each JS object sharing the same native owner as
   upstream does. Window memory grows lazily; the getter reports allocated
   HDR material, not vector/object overhead or materialized snapshots.
4. Feed the real guest monotonic clock to RecordDelta and time windows.
   A window's ring is confined to its environment thread. Plain Histogram
   operations are lock protected; callback iterators execute while holding
   a read lock and must not reenter a mutator.
5. Schedule prepared QRDE work through the real native job dispatcher.
   Preparation captures an independent count snapshot before dispatch.
   Cache insertion checks mutation generation; cached or uncached
   snapshots need not retain a parent owner. Only a cache miss with cache
   enabled retains the parent until insertion. Deleting abandoned work
   releases its native owners. JS rooting, cancellation, thread-pool
   admission, environment teardown, exception delivery and result backing
   buffers still belong to the job/engine bridge.
6. Implement actual event-loop-delay samplers separately. This owner does
   not schedule events, keep an event loop alive, or claim enable/disable
   behavior.
7. Add source/input manifest coverage and the package recipe compilation
   only when integrated, then build the normal wasm32/wasm64 products.
   Run the relevant unchanged upstream controls and Node/Chromium/Firefox/
   WebKit guest coverage against those exact products.

No engine patch, source manifest, package metadata, guest artifact, VFS
image, kernel interface, or ABI snapshot changes are included. This source
addition by itself has no changed guest-visible behavior on any host.

## Focused controls and limits

Run through the declared development shell, setting an output directory
and the exact pinned native executable:

```bash
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  HISTOGRAM_CONTROL_OUT=/absolute/evidence/directory \
  HISTOGRAM_NATIVE_NODE=/absolute/node-v26.13.0-darwin-arm64/bin/node \
  bash third_party/node-core/tests/histogram/run-controls.sh
```

`HISTOGRAM_CONTROL_SANITIZE=1` requests address/undefined sanitizers for
the focused portable helper. The fixture checks the native version and
records executable SHA-256. It writes raw portable/native output, import
controls and a bounded result report. Decimal/BigInt representations and
CBOR bytes compare exactly; floating statistics use relative `2e-11` and
absolute `2e-12` tolerances. Different platform math libraries can have
different final bits, including EWMA bits represented in exact CBOR; these
controls only establish their recorded host result.

Controls cover empty/one/constant/nonuniform/dense distributions,
significant figures 1–5, coarse lowest values, int64 value extremes,
quantized upper bins, omission correction, same/different/self/empty
comparisons, merging/drop counts, subtract/clamping, snapshot/diff errors,
EWMA and sparse CBOR roundtrips, all three QRDE dequantization modes,
count windows including over-high attempts, and actual native shared
message cloning. Dense samples reach both the exact-support and large
shape QRDE paths. Separate C++ ownership controls observe final release,
queued-work snapshots, cache invalidation, injected-clock deltas, lazy
time expiry, concurrent recording and reciprocal locking.

Serialization controls exercise version-specific unknown top-level/EWMA
fields, malformed nesting, duplicate keys/indices, offsets, count totals,
index/length bounds, sparse int64 overflow and counts above UINT32_MAX.
The INT64_MAX count control checks import/reexport only; it does not
establish overflow-safe recording or all inference methods at that count.

Expected source behavior must not be confused with a simplified
histogram's mathematical results:

- Reported extrema/percentiles/statistics use HDR equivalent-value ranges.
  A configured highest of 1,000,000 at two figures accepts 1,000,001 and
  1,048,575 in the last allocated bucket; 1,048,576 is rejected. The
  implementation preserves that real layout behavior.
- Empty mean/stddev are NaN, while the minimum is INT64_MAX. The public
  Number representation of that sentinel rounds; the BigInt getter does
  not. Empty inference and QRDE results follow source-specific shapes.
- Snapshot clones preserve previous timestamp, exceeds, reset count and
  EWMA. Diffs carry only bucket differences and exceeds. Add does not
  combine EWMA; subtract does not recompute EWMA and increments resetCount.
- CBOR excludes previous timestamp, exceeds, reset count and caches. The
  pinned importer accepts trailing bytes after the first histogram map.
  Version 2 skips unknown fields; version 1 rejects them.
- Exporting an empty EWMA-enabled histogram records alpha but no separate
  initialized flag; import marks positive-alpha state initialized. Its
  next sample therefore has the pinned native import behavior rather than
  a fresh owner's first-sample initialization. The control preserves this
  observed source behavior instead of silently changing it.

Host native controls do not establish guest bindings, wasm toolchain/ABI
compatibility, package rebuild success, asynchronous JS delivery, engine
memory accounting, ELD sampling, or browser/Node guest parity. No
performance measurement or application-speed claim is made.


The review followup adds generated native allocation ownership fields to
Histogram, RecordedSnapshot and RecordedSnapshotSource. The unchanged numerical
algorithms remain pinned. Actual cache/snapshot/HDR-source lifetimes report
native retained payloads to the shared ledger; sliding-window and QRDE vector
capacities have their own real container owners. See native-retained-memory.md
for coverage, contextless ownership, GC-credit projection and unvalidated
JSAPI/clone/pressure boundaries.
