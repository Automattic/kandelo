# Locking scratch-view mitigation

This investigation follows the cold locking flags recorded in [the
allocation and virtual inspection
report](2026-10-10-lock-allocation-and-virtual-inspection.md). The
mitigation removes a redundant host allocation. It preserves the lease
ownership, blocking retry and memory-growth contracts on Node and
browser; ABI 49 and the Rust kernel are unchanged.

## Cause and scope

A fresh-worker diagnostic crossed the two host implementations with both
Rust kernels, using identical original file-throughput guest and rootfs
bytes. Eight alternating rounds per cell reproduced slower cold dense
acquisition with the newer host under either kernel. This points to the
host path rather than identifying a slower Rust lock algorithm.

Calibrated worker CPU profiles then showed 1.7–3.0 ms of collection
samples within the first 256-operation dense acquisition phase. There
were three fresh workers per host/kernel cell. Median elapsed time after
subtracting sampled collection time was 7.9–8.0 ms in every cell. These
are sampled, instrumented diagnostics, not controlled speed
measurements. They support allocation and collection pressure as a
contributor to the cold timings; they do not identify every allocation
that caused a collection or prove that Rust costs are identical.

The allocation audit found two scoped scratch views constructed for
every lock request: one to write arguments, another to read results.
Each construction adds a wrapper, four closures, a private native view
and initial range checks. The second wrapper existed before this
filesystem migration. Changing surrounding allocation volume can move
collection into a timed phase, so the phase that slows down need not
have introduced the objects that trigger it.

Node's monotonic process clock and the profiler clock use different
origins on this Mac. A named startup marker calibrated every worker
profile separately; the accepted marker brackets were narrower than 1
ms. Phase attribution without that calibration was rejected. Heap
profiles that primarily sample surviving allocations were not used to
claim counts of short-lived allocations.

## Mitigation

Commit `4aae0530da6a93a9d42e060ff5f1251eeab5aac6` reads results through
the argument-writing view within the same lease. Every read still checks
lease validity, accessibility and range. Memory growth refreshes the
private native view before access; an expired wrapper stays revoked.
There is no persistent channel view or cross-request reuse.

Every request still owns an immutable 32-byte input snapshot. Blocking
retries retain it, getter commands still copy results back, setters
remain input-only, and caught-signal and termination ordering remain
unchanged. The authoritative contract is documented in [the
architecture](../architecture.md#advisory-file-locks).

## Controlled cold Node measurements

The baseline is the published pre-mitigation head
`9ce12904460fae92c229573c96878bab2b4d53b7`; the candidate is `4aae0530`.
Both use the same kernel, rootfs and original file-throughput guest. The
host is Node 24.15.0 on macOS arm64; browser diagnostics use the
repository's Chromium 153.0.8010.12 through Playwright on that same
machine. Twenty alternating before/after pairs each launch fresh
dedicated kernel workers. They share one Node parent, so these are not
twenty independent parent-process launches. No repeats or warmup were
added inside the original guest. Values below are medians across
workers.

| Cold metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Many-file acquire, µs/op | 30.8583 | 30.2874 | -1.85% |
| Many-file conflict, µs/op | 28.3268 | 28.1260 | -0.71% |
| Many-file replace, µs/op | 30.4252 | 30.2559 | -0.56% |
| Many-file unlock, µs/op | 25.0315 | 25.1339 | +0.41% |
| Dense acquire, µs/op | 36.8340 | 34.4844 | -6.38% |
| Dense conflict, µs/op | 27.3672 | 26.9297 | -1.60% |
| Dense replace, µs/op | 27.3613 | 27.2285 | -0.49% |
| Dense unlock, µs/op | 25.4473 | 25.2363 | -0.83% |
| Combined eight-phase lock time, ms | 44.8525 | 43.8150 | -2.31% |

Combined time is computed within each worker using 127 operations per
many-file phase and 256 per dense phase, then taking the worker median.
File write/read throughput changed +0.24%/+0.54%. This establishes a
bounded cold Node improvement, not a general application speedup. Dense
acquisition was faster in 16 of 20 matched pairs, and combined time in
15 of 20. Individual pairs remain variable; the table reports the change
between side medians, not the median paired percentage.

Three calibrated profiled workers per side still show collection in
dense acquisition after the fix: median sampled collection time is 2.250
ms before and 2.291 ms after. The construction count is reduced by
implementation, but these profiles do not prove reduced collection
duration or removal of collection pauses.

## Browser clock and validation context

The original Chromium syscall/I/O benchmark ran twelve rounds per side.
Many-file unlock and dense acquisition/unlock medians were unchanged.
Dense replacement changed from 29.30 to 31.25 µs/op (+6.7%). This flag
is retained. The realtime timer quantizes 256-operation phases in
3.90625 µs/op steps; a twelve-round median can land on half a step. The
replacement flag corresponds to a 7.5 to 8.0 ms phase median.

A separate cold diagnostic changes only the guest timer to
`CLOCK_MONOTONIC`, retaining file setup, all eight phases and conflict
assertions. It supplements the original results; it does not replace the
benchmark, add warmup or change the product runtime.

Twenty alternating pairs run in the same Chromium process with separate
baseline/candidate pages and fresh dedicated kernel workers. Median
dense replacement is 29.6699 to 29.1484 µs/op (-1.8%); many-file unlock
is 29.5079 to 29.9016 (+1.3%); combined time is 47.0085 to 46.9110 ms
(-0.2%). Dense acquisition is +1.4%. The finer timer does not repeat the
replacement slowdown, but neither does it establish a browser speedup.
These measurements are a separate diagnostic cohort, not interchangeable
with the twelve-round realtime measurements.

## Sustained locking

Each host has three fresh machine pairs, with 300 complete lock cycles
per machine and descriptors held open. The final 250 cycles use a
monotonic timer and retain all conflict assertions. Cycles within one
machine are correlated; the independent units here are the three pairs.
Pairs 1 and 3 run baseline first, and pair 2 runs candidate first.

| Host/pair | Median before, ms | Median after, ms | Change | p95 before/after, ms | p99 before/after, ms |
| --- | ---: | ---: | ---: | --- | --- |
| Node 1 | 37.0750 | 36.8595 | -0.6% | 51.1120 / 51.7630 | 54.1360 / 54.2960 |
| Node 2 | 37.1590 | 36.8725 | -0.8% | 51.2230 / 51.6190 | 53.3270 / 53.8120 |
| Node 3 | 37.1975 | 36.5970 | -1.6% | 51.0660 / 51.0410 | 53.4960 / 52.7010 |
| Chromium 1 | 30.5305 | 30.6695 | +0.5% | 37.6020 / 38.6060 | 40.4790 / 40.0670 |
| Chromium 2 | 30.7725 | 29.0935 | -5.5% | 38.0820 / 36.0740 | 40.6010 / 37.5610 |
| Chromium 3 | 30.0225 | 30.5550 | +1.8% | 37.2450 / 37.9100 | 38.3800 / 39.9910 |

All three Node medians improve slightly, while tails vary. Chromium's
direction changes between pairs. These measurements do not establish a
general sustained improvement or a fixed locking penalty on either host.

## Application checks

The initial three-round Node run completed all nine suites and used
identical kernel, rootfs and guest artifact bytes on both sides; only
the worker bundle fingerprint differs. It flagged clone (+6.5%), MariaDB
wasm64 Aria table creation (+5.2%) and join (+7.9%). Two separate
six-round rechecks reverse before/after order and do not repeat any of
those slowdowns above 5%.

| Metric | Before-first recheck | Candidate-first recheck |
| --- | ---: | ---: |
| Clone | -0.2% | +0.7% |
| Aria wasm64 table creation | -13.3% | -1.1% |
| Aria wasm64 join | -1.7% | -2.5% |

The larger table-creation variation is another reason not to turn small
application cohorts into a general speed claim.

An initial resumed browser invocation passed `--suite=all`, which this
runner interpreted as an unavailable suite name and completed no suites.
Both empty outputs are excluded. The corrected full run omits that
option and requires exactly nine nonempty, positive-result suites.

Both sides subsequently completed all nine browser suites, three rounds
each. All eight locking phase medians are unchanged in this cohort. The
initial browser flags are pipe throughput (66.67 to 58.82 MB/s, -11.8%),
file reads (111.11 to 100.00 MB/s, -10.0%) and the wasm64 InnoDB join
(1.81 to 1.97 ms, +8.8%). Two order-reversed six-round rechecks repeat
neither the pipe nor file-read slowdown. In the before-first pair,
InnoDB join changes -4.8%; in the candidate-first pair, it changes
+42.6%, with table creation +45.1% and SELECT +80.3%. These flags are
retained. Raw baseline rounds in that second pair switch together after
round 3: creation drops from about 21 to 7 ms, SELECT from about 7 to
0.7 ms, and join from about 1.8 to 0.7–0.8 ms. A six-round aggregate
mixes those different timing regimes. The cause of that rare transition
has not been established.

A supplementary diagnostic measures the browser MySQL client's existing
zero-delay polling timers in twelve alternating pairs. SELECT timer
waits sum to a median 0.5975 ms on each side; the median largest wait is
0.01 ms. Join timer waits sum to 0.150/0.140 ms. These instrumented
results do not support timer clamping as the explanation for that
multi-millisecond baseline transition. Instrumentation can affect races
and cannot establish application throughput.

The final uninstrumented check therefore runs twelve alternating pairs
through the ordinary browser suite, with fresh kernel workers, one
Chromium process and separate baseline/candidate pages. No workload,
query, timing, warmup or runtime behavior is changed. Side medians are:

| InnoDB wasm64 metric | Before, ms | After, ms | Change |
| --- | ---: | ---: | ---: |
| Bootstrap | 1314.300 | 1309.130 | -0.39% |
| Table creation | 21.185 | 21.005 | -0.85% |
| Insert | 133.130 | 135.665 | +1.90% |
| SELECT | 6.965 | 7.105 | +2.01% |
| Join | 1.785 | 1.845 | +3.36% |

Neither the original +8.8% join flag nor the larger order-recheck flags
repeat above 5% in this cohort. This supports retaining the scoped-view
mitigation without claiming that application variability is eliminated.
All twelve pairs and the previous flags remain in the raw records.

Browser WordPress image bytes differ after rebuilding the candidate's
stale image through normal setup. Its timings therefore do not isolate
the scoped-view change. Every other selected browser artifact
fingerprint matches, including the kernel, microbenchmark guests and
both MariaDB images. The WordPress hashes are
`df445033f3d71baf9c68cde6bd8f1d768d47a0e4b74d7f919ea95b2601216f84`
before and
`8a143c7d5bf39edbdead01ab053cbc7504e2731111a1c19ffae71ceb154fe8de`
after.

## Provisioning and correctness

The private baseline was rebuilt through normal setup: all 181 nodes
completed. The browser application suites additionally need the dormant
MariaDB images excluded from default setup. They are built with the
normal source-cache engine and a private package selection admitting
`mariadb-vfs` for both architectures. Tracked product exposure is
unchanged. No incomplete artifact tier is admitted and no provenance
checks are bypassed.

The normal candidate host bundles and declarations build. All 309
focused shared-host tests pass, including all nine advisory commands
across kernel and guest memory growth, scratch lease revocation,
blocking snapshots and signal death. All 15 native lazy/inspection
browser tests pass across Chromium, Firefox and WebKit.

The final normal candidate setup completed all 181 nodes after
rebuilding the affected app images and host bundles. ABI validation
passes, with ABI 49 unchanged from the pre-mitigation baseline. The libc
functional, regression and math run has 306 passes, 17 expected failures
and one declared flaky case that passed (324 cases total). Open POSIX
has 174 passes, 3 expected failures and 2 unsupported skips (179 total).
There are no unexpected failures, build failures or unexpected timeouts.

Sortix's `basic/fcntl/fcntl` and `basic/unistd/lockf` both pass through
the normal runner using the pristine pinned case-sensitive source tree.
These two cases supplement the focused lock tests; they do not replace
the full Sortix follow-up run that was interrupted on October 10.

Normal `./run.sh browser` manual inspection also passes: the shell image
boots, the gallery Internals table shows actual `/proc`, `/dev` and the
active `/dev/pts/0` entry, and no page or console errors were recorded.
Screenshots and the inspection log are retained with the measurement
records. The temporary preview server was then stopped.

The full Sortix validation for the virtual-directory follow-up remains
interrupted; this report does not claim that the entire batch is ready
to merge.

Raw inputs, worker profiles, calibration records, exact result JSONs,
run scripts and artifact fingerprints are retained locally under
`.context/batch-2/cold-1011/`.

| Controlled input | SHA-256 |
| --- | --- |
| Kernel on both sides | `66fe4a7796971ee216ad7e2f09cd2010c73ae0773a5892b4e90b99f257f725a4` |
| Node rootfs on both sides | `2459e92635ac875c2fcd87ea3e99c4613fa01da15655670185b444c685aa60eb` |
| Original file-throughput guest on both sides | `fab6312ca022851bc6bd06b162b24e0e505f6dd89e074c023520ca94f0367b35` |
| Baseline Node worker | `c21cb126898a040f132671e06f47f86eefeaaf6355dc7a76b469f96e9b48c8a6` |
| Candidate Node worker | `64b492e1588b71fec70c3ecaf7f8d6cd9b20684210b2aeee7d7039e3c4922a09` |
| Separate monotonic cold guest | `634e1b2f92efb0f920ac47a0b3c378073e392627c4c14cda60216fe543145fe7` |
