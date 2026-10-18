# Locking performance against main, October 11, 2026

The latest ABI-49 runtime is compared directly with main at
`1fa897b4964e3076344e21b37348a2ada471f41a` (ABI 47). Earlier reports compared
intermediate batch revisions; those historical measurements do not establish
performance relative to main.

## Cause and mitigation

Cold syscall completion created private scratch bookkeeping even when no
signal or address needed to be transferred. Each checked scalar proof also
constructed temporary getter-call argument arrays and diagnostic labels.
Private weak-table pointer registrations retained dead lease graphs until
collection, despite their authority already having expired.

The host now binds captured genuine-memory getters once, constructs error
labels only on failure, uses private null-prototype export records directly,
reuses the existing borrow record for overlap checking, and allocates address
redaction bookkeeping only when needed. An ordinary no-signal completion
returns its scalar result without an empty byte array or result wrapper.
Lease retirement explicitly removes pointer registrations and its invalidator.
All capacity, live-memory, owner, overlap, revocation and entry checks remain.
Delivered signals still copy their record within the synchronous lease.
No kernel ABI or syscall semantics change in this optimization.

## Direct comparison

Node 24.15.0 and Playwright Chromium 153.0.8010.12 ran on the same macOS arm64
machine in the repository Nix development shell. Each cohort contains twenty
alternating main/latest pairs of fresh dedicated kernel workers, with one Node
parent or one Chromium process per cohort. These are not twenty independent
parent-process launches. Each version used its own normal SDK, ABI-matched
kernel, boot image and compiled guest.

The original one-pass C source was unchanged, SHA-256
`3de6bb0a2f2a29daad3d2f2a00788da5806f5b0a33151dc802f0a53c1ab4470f`.
Its realtime clock is coarse in browsers. The combined time below weights
127 many-file operations and 256 dense-file operations in each of four phases.
Negative changes are improvements. Individual trials can vary.

| Original workload metric | Node main | Node latest | Change | Chromium main | Chromium latest | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lock_many_files_acquire_us_per_op | 32.6339 | 29.0079 | -11.11% | 39.3701 | 31.4961 | -20.00% |
| lock_many_files_conflict_us_per_op | 29.6339 | 24.7205 | -16.58% | 31.4961 | 31.4961 | +0.00% |
| lock_many_files_replace_us_per_op | 31.4803 | 28.5118 | -9.43% | 31.4961 | 31.4961 | +0.00% |
| lock_many_files_unlock_us_per_op | 26.8189 | 23.6220 | -11.92% | 31.4961 | 23.6220 | -25.00% |
| lock_dense_file_acquire_us_per_op | 27.7559 | 23.9180 | -13.83% | 27.3438 | 27.3438 | +0.00% |
| lock_dense_file_conflict_us_per_op | 28.2520 | 23.4238 | -17.09% | 27.3438 | 23.4375 | -14.29% |
| lock_dense_file_replace_us_per_op | 28.2539 | 27.3789 | -3.10% | 31.2500 | 27.3438 | -12.50% |
| lock_dense_file_unlock_us_per_op | 26.4727 | 23.2305 | -12.25% | 35.1562 | 23.4375 | -33.33% |
| combined_lock_ms | 43.9650 | 38.6900 | -12.00% | 48.0000 | 41.5000 | -13.54% |

Phase metrics use microseconds per operation; the combined metric uses
milliseconds. All eight phase medians improved or tied on both hosts.
The combined latest time beat main in 19 of 20 pairs on each host. A separate
Node-parent cohort also improved all eight medians and combined time by
10.99%, with 20 of 20 pairs faster. Cohorts were not pooled.

A separate first-pass Chromium diagnostic changed only the timer to
`CLOCK_MONOTONIC`, retaining the original workload and preceding file activity.
All eight medians improved; combined time fell from 48.0905 to 41.5060 ms
(13.69%), with 19 of 20 pairs faster. This clock diagnostic is separate from
both the original result and any sustained-cycle measurement.

## Diagnostic evidence and limits

Three worker CPU-profile pairs were calibrated with a marker visible in both
clock domains; the accepted alignment interval was narrower than one
millisecond. Latest dense acquisition had 0/208/0 microseconds of sampled
collection, versus zero in all main profiles. Collection remains in other
phases: across the first eight phases, main had 500/125/0 microseconds and
latest had 667/1208/917. Dense replacement still had collection samples.
The mitigation does not eliminate garbage collection. Instrumented profiles
are diagnostics, not the timing evidence above.

With collected-object sampling explicitly enabled, three allocation-profile
pairs sampled a median 96,884,168 bytes on main and 63,718,536 on latest,
about 34% less JavaScript allocation. These are sampled values, not exact
allocation counts or external-buffer totals. A capability probe verified that
default live-object sampling omits short-lived collected allocations. Forced
collection was used only in that isolated probe, never in timed benchmarks.

Raw paired timings, calibrated profiles, allocation profiles, artifact hashes
and command logs are retained under
`.context/batch-2/main-locking-1011/` in the Seattle workspace.

## Application benchmark preparation

Main's dormant MariaDB image needed three build-only adaptations in its
isolated checkout: an explicit repository source provider, the TypeScript ESM
loader to avoid the macOS CLI socket-path limit, and use of declared resolver
dependency roots rather than an unpublished artifact projection. Main's Rust
kernel, host runtime, guest sources and original TypeScript image construction
body were preserved. Exact before/after hashes and reasons are retained in
three `main-benchmark-*-change.json` records. Each side still builds its own
ABI-matched images through the normal source-only engine.

Both checkouts published the complete normal package set plus the dormant
MariaDB images. Selecting only the image products narrows the published
inventory and omits dependencies needed by other benchmark suites, so that
partial preparation was discarded before measurement. WordPress's pinned
upstream and plugin sources were unpacked for main's normal demo setup;
all source, configuration and router files matched the latest checkout,
excluding reset database and log state. Provisioning preserved the measured
boot-image, kernel and original locking-guest hashes on both sides.

## Merge validation

The measured runtime is `1cb16968ce2e`; subsequent validation repairs and
documentation do not change the runtime. Both sides rebuilt through the
normal source-only engine, using their own SDK and ABI-matched artifacts.

| Check | Latest result |
| --- | --- |
| Rust workspace | 2,880 passed across 44 targets |
| Package tooling | 706 primary unit tests and 3 integration tests passed; two subprocess-isolation checks also rerun their selected unit case |
| Complete shared-host run | 4,951 passed, 21 existing skips; 534 files, zero failures or load errors |
| Resource-isolated Ruby | All three declared cases passed in separate processes |
| Forced JavaScriptCore/Bun | All three checks passed; existing five-second graceful-detach fallback warning remains |
| Host types and browser production build | Passed |
| Browser unit tests | 102 passed |
| Ordinary Chromium runtime | 241 passed, 7 existing skips |
| Cross-engine CI contracts | 72 passed across Chromium, Firefox and WebKit |
| Native lazy, filesystem inspection and signal acceptance | 18 passed across Chromium, Firefox and WebKit |
| ABI snapshot | Passed; ABI 49 |
| Full libc | 306 passed, 17 expected failures, one declared flaky case passed; no unexpected failures |
| Open POSIX | 174 passed, 3 expected failures, 2 unsupported skips; no unexpected failures |
| Full Sortix | 5,065 passed, 23 expected failures, 50 skips; zero failures, unexpected passes, build failures or timeouts |
| CI shell harness | Passed, including ordinary and partitioned suite invocations, exact inventories and forced-Bun checks |

Sortix used the pristine upstream source at
`7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d` on the existing case-sensitive
volume. The user's dirty normal Sortix and libc-test checkouts were preserved.
The obsolete CI harness assertions for the removed remote-release
materializer were retired; the normal suite runner never depended on it.
The async spawn fixture now waits for actual channel completion. The browser
scope audit excludes generated reports and private worktrees while retaining
authored production sources. All original behavioral assertions remain.
The legacy optional-mirror browser fixture explicitly selects and restores
its resolution policy; under the inherited SourceOnly policy its unowned
synthetic file correctly had no loader. Its stale-ABI assertion and the strict
SourceOnly fixtures remain unchanged. The complete browser gate passed after
that fixture repair.

All nine application suites completed three rounds on each version and host,
with positive, nonempty metrics. The first comparison flags Node Aria SELECT
(+6.8%); Chromium flags InnoDB SELECT/JOIN (+5.4%/+10.9%), ordinary/large
repeat spawn (+6.5%/+7.0%) and pipe throughput (-6.3%). Quiet order-reversed
rechecks ran each flagged suite for six rounds per side in each of two
opposite orders. All eight comparison tables have no regression above 5%.
The original flags remain recorded; variability is not eliminated.

| Initially flagged metric | Main first, latest second | Latest first, main second |
| --- | ---: | ---: |
| Node Aria SELECT time | -3.0% | -1.4% |
| Chromium pipe throughput | +3.2% | 0.0% |
| Chromium ordinary spawn time | +1.5% | -1.5% |
| Chromium repeated large spawn time | +2.7% | +0.4% |
| Chromium InnoDB SELECT time | +2.9% | -4.3% |
| Chromium InnoDB JOIN time | +0.7% | -3.4% |

Lower time and higher throughput are improvements. All eight browser locking
phase medians also improved or tied in both syscall-suite rechecks. These
application runs are separate from the original twenty-pair locking cohorts.
All guest workloads and runtime sources remained unchanged during rechecks.

The normal `./run.sh browser --host 127.0.0.1 --port 5410 --strictPort`
preview rebuilt the default package projection and booted the default shell.
Through the actual Internals/VFS UI, procfs showed init and its `self` link,
devfs showed real devices and descriptor symlinks, and `/dev/pts` showed the
active terminal. No page or console errors occurred. Screenshots and the
observed table contents are retained with the logs. All sixteen checked
runtime artifacts, including the kernel, rootfs and host JavaScript bundles,
remained byte-for-byte identical after this normal rebuild.

Browser validation uses the normal
`source-only-v1` resolution policy and the latest published artifact root.
Erlang remains deferred by the maintainer's instruction; its two incomplete
artifact closures are reported separately from admitted-package validation.
All 93 available artifact closures pass. The checker separately reports four
products not built in any tier: `perl-vfs`, `python-vfs`, `redis-vfs` and
`texlive`, each for wasm32. Those informational entries are not failed or
incomplete admitted closures.

Existing platform boundaries remain documented: native lazy archive activation
supports ZIP, while the former gzip-compressed TAR lazy-tree path is missing;
generated procfs file contents remain outside the host read API even though
live procfs/devfs directory metadata is connected. The immutable inspection
identity is reserved init, so its descriptor directory is empty. Erlang's
deferral and Bun's passing-but-warning graceful-detach case are explicit, not
unreported validation failures. GitHub has no hosted status checks for this
batch; the local suite logs establish the recorded readiness evidence.
