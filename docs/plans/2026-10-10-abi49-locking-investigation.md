# ABI 49 locking investigation

## Question and scope

PR #1515 previously described roughly 28% slower locking. That statement
combined individual first-pass benchmark phases into a general locking
claim. The investigation retained those measurements and separated
startup, sustained locking, file lifecycle, and worker collection costs.
No runtime optimization, ABI change, or benchmark replacement was made.

Measurements ran October 10, 2026 on the same macOS arm64 machine, using
the declared development shell, Node 24.15.0 and repository Chromium.
ABI 48 was `99e6dd33c7f1d7d6d5107aa45560bf5e037a2f04`; ABI 49 was
`3f4ad86677b26d0f26e9f6915f2c75831658edb5`. The latter adds documentation
to the already validated integrated runtime `7dbe16240a`.

The original benchmark source is identical on both sides. Its SHA-256 is
`3de6bb0a2f2a29daad3d2f2a00788da5806f5b0a33151dc802f0a53c1ab4470f`.
The respective selected kernel SHA-256 values are:

- ABI 48: `1f8d36b0362e65e297bdd6a3a1ec9ba91df10723494f550eacb694ba670cbb96`.
- ABI 49: `bbbc81f69853db88eac717d1313b045c10a02b3045ce11d9a7b499d1bd8da5ac`.

## First-pass slowdown and garbage collection

Six fresh Node rounds of the unchanged `syscall-io` suite reproduced a
slower dense acquisition phase and a faster many-file unlock phase:

| Node first-pass metric | ABI 48, µs/op | ABI 49, µs/op | Change |
| --- | ---: | ---: | ---: |
| Dense-file acquisition | 27.80 | 34.26 | +23.2% |
| Many-file unlock | 38.85 | 28.18 | -27.5% |
| Dense-file conflict | 27.50 | 27.30 | -0.7% |
| Dense-file unlock | 25.54 | 25.60 | +0.2% |

Timed worker CPU profiles identify collection moving between those two
phases. In three ABI 48 machines, first-pass many-file unlock contained
1.25, 1.25 and 1.42 ms of sampled garbage-collector time, while dense
acquisition contained none. In three ABI 49 machines, many-file unlock
contained none and dense acquisition contained 2.54, 2.08 and 1.71 ms.
Dividing the latter by 256 operations gives roughly 6.7–9.9 µs/op,
comparable to the measured acquisition difference.

Profiles used 100 µs sampling and a diagnostic that prints phase
boundaries outside the timers. Those additional writes can themselves
shift allocation and collection timing. Profile numbers establish a
mechanism; they are not replacements for the uninstrumented results.
Node profiler timestamps were calibrated against `process.hrtime` with
a 423 µs offset interval. Chromium profiles used a named clock-marker
function in the kernel worker; the final clock intervals were 94–148 µs.
Earlier Chromium correlations with wider intervals were rejected.

The Rust lock-manager source and host `handleFcntlLock` implementation
are unchanged between these heads. The native descriptor already carries
its file identity, so a lock on these files does not introduce a host
filesystem metadata round trip. Collection is in the shared TypeScript
dispatch/marshalling path, not a new filesystem lock acquisition.

## Sustained diagnostics

The separate monotonic diagnostic preserves all eight lock phases and
their conflict checks, repeating the complete workload 30 times in each
of three fresh machines. The table reports medians of the last 25 cycles
per machine, 75 cycles per version. The initial five cycles remain in raw
output and are excluded only from this sustained comparison. Cycles
within one machine are not independent trials.

| Node sustained metric | ABI 48, µs/op | ABI 49, µs/op | Change |
| --- | ---: | ---: | ---: |
| Many-file acquisition | 23.39 | 23.40 | +0.0% |
| Many-file conflict | 23.08 | 23.09 | +0.0% |
| Many-file replacement | 23.55 | 23.78 | +1.0% |
| Many-file unlock | 23.30 | 23.39 | +0.4% |
| Dense-file acquisition | 24.03 | 24.07 | +0.2% |
| Dense-file conflict | 23.03 | 23.06 | +0.1% |
| Dense-file replacement | 25.56 | 25.68 | +0.5% |
| Dense-file unlock | 23.92 | 23.81 | -0.5% |

Summing the eight actual phase durations for each cycle gives 38.136 ms
versus 38.344 ms on Node, +0.5%. This sum excludes opening, closing,
unlinking and printing. It is not an application or boot-time measure.

Chromium's 30-cycle diagnostic that reopens files each cycle measured
31.408 → 33.122 ms (+5.5%) in one order and 32.341 → 32.903 ms (+1.7%)
in reversed order. Dense unlock was +11.8% and +5.1% respectively.
Keeping files open across cycles instead measured combined phase changes
of -0.3% and +2.0%; dense unlock changed by -1.2% and +6.0%. Holding
descriptors open therefore does not consistently eliminate the smaller
browser difference. It changes file lifecycle and collection context.

The longer Chromium recheck alternated independent machines in the order
48, 49, 49, 48, 48, 49. Each ran 300 persistent-descriptor cycles; the
table uses the median of the final 250 cycles in each machine. All six
guests completed with exit status zero and all conflict checks passed.

| Chromium pair | ABI 48 combined phases, ms | ABI 49 combined phases, ms | Change |
| --- | ---: | ---: | ---: |
| 1, ABI 48 first | 31.254 | 33.853 | +8.3% |
| 2, ABI 49 first | 34.237 | 31.689 | -7.4% |
| 3, ABI 48 first | 33.519 | 31.564 | -5.8% |

Dense unlock also changed direction: +9.0%, -7.8% and -6.3% in these
pairs. Other lock phases moved with the same machine-level variation.
Neither the shorter persistent test nor the longer paired recheck
isolates a consistently slower browser unlock implementation. They do
not prove that the versions have identical performance; they bound the
claim supported by the earlier isolated percentage.

## Reproduction and interpretation

Original first-pass reproduction:

```bash
scripts/dev-shell.sh env KANDELO_CACHE_GC_AUTO=0 \
  npx tsx benchmarks/run.ts --suite=syscall-io --rounds=6
```

The diagnostic variants were built independently for each ABI using that
worktree's normal `sdk/bin/wasm32posix-cc -O2`, fork instrumentation and
ABI stamping. Both sides use byte-identical diagnostic C source. Node
uses `runCentralizedProgram`; Chromium uses the real benchmark page's
`runProgram`, ordinary image construction and `BrowserKernel` lifecycle.
No runtime, filesystem or lock result is simulated.

The monotonic variant changes only the timer to `CLOCK_MONOTONIC` and
repeats the original many-file and dense-file functions. The persistent
variant additionally opens their descriptors only on the first cycle
and closes/unlinks them on the last, while still acquiring, conflicting,
replacing and releasing every lock on every cycle. Longer paired browser
runs repeat that persistent workload 300 times.

Raw outputs, diagnostic sources, profiles, comparison JSON and job logs
are retained locally beneath `.context/batch-2/` and the two private
worktrees' `.context/locking/` directories. These files are gitignored.
The full nine-suite Node/Chromium comparisons recorded in #1515 remain
the broader evidence for this unchanged runtime; the diagnostic table
above supports only the named locking workload.

The original browser benchmark uses `gettimeofday()`, backed by
`Date.now()` in the browser. A 1 ms tick represents 3.90625 µs/op for 256
operations. Its earlier 27.34 → 35.16 µs/op conflict result was 7 → 9 ms,
so the 28.6% percentage describes only a two-tick first-pass difference.
Those timings remain real elapsed costs; neither coarse timing nor
collection permits dropping them from the record.

The evidence explains much of the large first-pass acquisition result
through shifted garbage collection. It does not establish a general 28%
locking regression or an improvement from a runtime fix. A future
allocation optimization must retain immutable blocking-lock snapshots,
scratch ownership, signal handling and both host paths, and must be
validated with the complete benchmark suite and locking conformance.

## Lazy archive and virtual-directory boundaries

The old `LazyTreeDecoder` accepts exactly `zip-v1` and `tar-gzip-v1`.
The latter covers gzip-compressed TAR deferred trees, including OCI image
layers. Native activation currently supports ZIP; the TAR/gzip deferred
tree path is missing. Standalone gzip, plain TAR and zstd were not
additional lazy decoder formats. Zstd boot-image decoding is separate
and remains supported. The previous batch description overstated which
formats had been lost.

`inspect_namespace_directory` explicitly returns `EOPNOTSUPP` for procfs
and non-delegated devfs directories. Guest directory enumeration already
exists in `procfs_getdents64`, `procfs_getdents64_for_pid` and
`devfs_getdents64`. There is no browser restriction or missing guest
directory syscall preventing this inspection support.

The missing work is sharing those real directory entries with the
inspection snapshot path, including truthful stat data and symlink
targets. Numeric `/proc/<pid>/fd` and `fdinfo` must use that live process
record; substituting the reserved inspector PID 1 would incorrectly
produce empty descriptor lists. `/proc/self`, `/proc/thread-self` and
`/dev/fd` must retain the documented inspection identity. Live PTYs,
vanished processes and multi-chunk snapshots also need coverage on Node
and browser. Removing the rejection alone does not supply those entries.
