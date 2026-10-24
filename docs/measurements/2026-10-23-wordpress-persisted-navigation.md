# Persistent WordPress navigation observations — 2026-10-23

## Method

The user reports working persistence but slower navigation after reopening
checkpoint 1.34 in Firefox, and unexpectedly slow installation in Chrome.
This is exploratory measurement, not an optimization or a statistical
before/after performance claim.

The frozen ABI 51 WordPress/MariaDB candidate uses CRC32C and ordinary runtime
settings, without prefetch/cache overrides. The host is an Apple M3 Max,
macOS 27.0.1, with 36 GiB of memory. Playwright uses Firefox 155.0/revision
1543 and Chromium 153.0.8010.12/revision 1243: desktop headless browsers,
not the user's installed profiles or physical phones.

Each engine uses an owned profile and computer. Measure installation, page
reload and browser-process close/relaunch. After each boot, log in and visit
dashboard, initialized/styled visual editor and media list twice. Publish a
post and upload a browser-generated 256-pixel PNG before reopening. Reopen
blocks the source-image URL and confirms both saved REST objects remain
accessible. No full-image checkpoint is taken.

Initial measurements precede that post/upload setup: initial/reopened views
do not have identical data. First/second visits do not guarantee OS/browser
cache temperatures. Browser restart does not flush OS filesystem caches.
The agent's validation scheduler is held between commands during the final
run and automatically resumed afterward, not proof of a globally idle host.

Timing serves unmodified production worker bytes with passive main-thread
progress/request observers. Separate diagnostics prepend an observer calling
genuine OPFS methods and counting duration, returned bytes and calls. Existing
WebAssembly module-cache counters do not measure PHP compilation or OPcache.

## Timing observations

Seconds; one observation per cell, not a mean or percentile.

| Engine / operation | Initial computer | Page reload | Browser restart |
| --- | ---: | ---: | ---: |
| Firefox: first WordPress response | 26.23 | 19.22 | 22.03 |
| Firefox: first editor visit | 4.50 | 3.87 | 8.10 |
| Firefox: second editor visit | 4.41 | 3.83 | 5.74 |
| Firefox: first media-list visit | 6.75 | 5.09 | 5.41 |
| Firefox: second media-list visit | 5.34 | 7.78 | 9.83 |
| Chromium: first WordPress response | 25.60 | 15.70 | 18.04 |
| Chromium: first editor visit | 4.03 | 3.07 | 3.02 |
| Chromium: second editor visit | 2.86 | 2.73 | 2.71 |
| Chromium: second media-list visit | 2.65 | 2.57 | 2.76 |

Firefox has slow/variable editor and media responses after browser restart,
not a universal slowdown on every reload/action. Second visits do not
reliably improve. Chromium's reported slowdown is not reproduced here.

Main-thread progress timestamps put source staging completion at 4.65 s in
Firefox and 5.87 s in Chromium relative to page navigation clocks. These are
not isolated download/decompression durations. First-to-last checked-base
write progress spans are 2.86 s/1.58 s; verification spans are 0.98 s/0.79 s.
Streaming phases overlap: these are not additive phase CPU costs. Reopen
has no source-image request or installation progress.

## Diagnostic observations

These are separate instrumented runs, not subtractions from the timing table.
Counts are returned OPFS API bytes, not physical disk traffic. Native-call
time includes synchronous browser work/scheduling, not all async storage
operations, host/kernel queuing, checksumming, guest execution or rendering.

| Engine, after browser restart | Action wall time | OPFS read bytes | Native read time | Native flush time | Wasm compile time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Firefox: second editor | 4.28 s | 104.2 MiB | 94.5 ms | 3.7 ms | 0 ms |
| Firefox: second media list | 5.28 s | 321.3 MiB | 404.5 ms | 3.7 ms | 0 ms |
| Chromium: second editor | 2.81 s | 135.0 MiB | 22.4 ms | 14.7 ms | 0 ms |
| Chromium: second media list | 2.33 s | 170.3 MiB | 23.5 ms | 28.8 ms | 0 ms |

Firefox's second media view rereads 319.875 MiB of immutable base in 5,118
calls with zero newly observed 64-KiB base pages. Other reads are about
0.33 MiB of journal and 1.05 MiB of index data. This is repeated reading of
an already observed working set, not simply encountering cold files. It
makes read amplification/cache effectiveness worth investigating, without
proving it dominates the remaining CPU or coordination time.

Measured synchronous OPFS methods and Wasm compilation do not explain most
wall time. The source configures PHP with opcache.file_cache_only=1 and
disabled timestamp validation. Ordinary cross-process shared-memory OPcache
is explicitly refused because the required sharing is unavailable. PHP
bytecode/file-cache work remains a separate profiling candidate, not a reason
to enable unsupported sharing.

Next isolate Rust verification/cache work, host/kernel coordination, PHP and
MariaDB execution, and rendering. A bounded cache-size/working-set experiment
is better supported than shipping frequency-based prefetch now. Do not weaken
verification or sync acknowledgements to improve these numbers.

## Read-cache follow-up

An independent read-only review identifies three mechanisms to distinguish,
not a diagnosed cause of these navigation times:

- The automatic immutable-base cache caps at sixteen 64-KiB data pages and
  four 4-KiB index pages. A miss reads and verifies an entire data page;
  inode/pointer metadata competes with file contents for these slots.
- Before each nonempty persistent file write, ordinary I/O usage at or above
  half its limit triggers global clean-read-cache reclamation. This can clear
  the base, journal and verified-file caches without any base mutation.
  These measurements do not establish that the trigger fired.
- Allocation refusal can reuse an existing victim instead of filling a new
  slot. Configured cache capacity is not proof of effective resident capacity.

A private follow-up is prepared to reopen the same seeded computer with
16 data/4 index pages, then 64/8, then 64/8, then 16/4. Both conditions retain
the existing checking policy, I/O admission and total memory ceilings. Timing
and storage diagnostics remain separate; no prefetch is added. This experiment
requires at least 8 GiB of free disk space. Both timing and diagnostic cases
now complete on Firefox and Chromium, without test retries or skips.

The payloads are about 1.016 versus 4.031 MiB, but the I/O allocator charges
twice payload capacity: approximately 2.03 versus 8.06 MiB, excluding slot
bookkeeping. Increasing capacity can itself increase pressure, so this is a
cache-size/pressure experiment, not an isolated capacity measurement. Journal
and browser caches also evolve during the sequence. A further diagnostic
should count threshold clears, data hits/misses and allocation fallbacks, with
ordinary I/O usage at the clear. The existing aggregate I/O statistic combines
ordinary and writeback pools and cannot alone establish the trigger condition.

### Seeded cache comparison

Two page-reopen observations per setting, in the order described above;
seconds shown as the observed pair, not a population percentile. Both settings
use the frozen 1.34 artifacts. The browser process remains running, unlike
the earlier browser-restart measurement.

| Engine / action | 16 data / 4 index pages | 64 data / 8 index pages |
| --- | ---: | ---: |
| Firefox: first WordPress response | 15.77, 16.78 | 16.27, 15.41 |
| Firefox: second editor visit | 3.61, 3.29 | 3.03, 3.05 |
| Firefox: second media-list visit | 4.16, 4.31 | 3.51, 3.41 |
| Chromium: first WordPress response | 15.01, 15.51 | 15.52, 15.53 |
| Chromium: second editor visit | 2.60, 2.59 | 2.51, 2.58 |
| Chromium: second media-list visit | 2.15, 2.39 | 1.93, 1.90 |

The media observations support a modest responsiveness benefit, not an
orders-of-magnitude change or a boot-speed claim. Separate diagnostic base
read volumes for the second media visit are 307.44/325.44 MiB versus
137.46/146.33 MiB in Firefox, and 157.00/167.75 MiB versus 75.52/71.33 MiB
in Chromium. The larger bounded cache roughly halves these rereads. This
does not identify pressure-triggered clearing versus ordinary eviction, or
attribute the remaining application time to a specific CPU activity.

Journal/index reads on boot grow over the reopen sequence; base reads are
about 219 MiB at 16/4 and 200 MiB at 64/8. Those are real application-startup
reads, not evidence of a capacity-wide immutable-image verification pass.
The changing journal and shared browser process remain comparison limits.

Receipts are .context/wordpress-cache-experiment-1-34-{timing,diagnostics}.*.
All four test cases pass and native-artifact, frozen-site and private-probe
audits pass. The runner exits nonzero because its final live-source audit
detects three subsequent shutdown fixes, not because those fixes were served
to these baseline computers. Before editing, the original three files were
preserved and matched against the frozen build receipt under
.context/persistence-checkpoint-1-34-source-reference/. No cache default has
changed in production source as a result of this experiment.

## Evidence and limits

Job wordpress-persisted-profile-live-1023-102456-5afc passes all four cases:
two timing and two diagnostic, without retries/skips. Production-source,
native-artifact, frozen-site and private probe-source audits pass. Receipts
are under .context/wordpress-persisted-profile-1-34-live-*.
Kernel SHA-256:
5a721bfba26f86391219e040cb11623e6e031ce0ecba572af08d808a662c8fc3.

Firefox Playwright service-worker request-event durations are often nearly
zero despite multi-second readiness. Root-page resource entries include
VFS-named JavaScript chunks, not the worker download. Neither proves isolated
download/HTTP latency; finer attribution needs a network/CPU trace.

Two failed pilots never reached reopen and are excluded. One PNG had an
invalid IDAT checksum. A valid canvas PNG still received REST multipart error
rest_upload_image_type_not_supported; the existing tested raw image/png
request succeeds. That request-path discrepancy is not diagnosed storage
corruption and remains a follow-up.
