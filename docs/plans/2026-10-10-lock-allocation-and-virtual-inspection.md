# Lock allocation and live virtual-directory inspection

## Problem and result

The initial ABI 49 batch lost host inspection of `/proc` and `/dev`,
although guest directory enumeration still worked. Its roughly 28%
locking slowdown was also an overbroad interpretation of individual
first-pass phases. The [earlier
investigation](2026-10-10-abi49-locking-investigation.md) records those
measurements and worker profiles. Collection moved between phases;
sustained timings did not establish a general 28% regression.

This follow-up connects host directory inspection to the real Rust
process, descriptor and device records. It also removes avoidable result
allocation and copying from advisory lock setters. The allocation change
is implemented and correctness-tested. The timings below do not prove a
consistent latency improvement or a measured reduction in collection.

Both hosts continue to run the kernel in its dedicated worker. This
follow-up keeps ABI 49: no syscall wire, layout, export or ownership
contract changed, and the committed ABI snapshot check passed.

## Advisory lock ownership

`handleFcntlLock` retains an owned 32-byte input snapshot. Blocking
retries must use the original request even if the guest changes or grows
its memory while waiting. Replacing this snapshot with a view into guest
memory would weaken that contract.

Only successful `F_GETLK`, `F_GETLK64` and `F_OFD_GETLK` requests copy a
result out of kernel scratch and back into guest memory. The six setter
commands take an input-only flock: they now avoid the redundant result
buffer, associated views and writeback. Captured result scalars replace
the temporary callback result object. Scratch leases, signal-death
checks, caught-signal interruption, immutable retries and freshly
acquired guest memory views retain their existing ordering and
ownership.

These removed constructions are a candidate for reducing host collector
pressure. The previous profiles established that collection could affect
lock timings; they did not establish that these particular objects
caused all of the observed collection or that this change eliminates it.

## Truthful procfs and devfs inspection

The inspection snapshot path shares the existing guest directory entry
providers. Numeric `/proc/<pid>/fd` and `fdinfo` use that process's
actual live descriptors. Entry metadata and symlink targets come from
the normal namespace walker. Root listings include existing virtual
mounts even when the boot image omits `/proc` or `/dev`. `/dev/shm`
continues to use tmpfs. Inspection does not open guest descriptors or
allocate devices.

The live test fixture forks a background guest shell, observes its
kernel-assigned child PID, opens descriptors through 809, closes
selected descriptors and a guest-owned PTY master, then waits and reaps
the child. Node and all three browser engines check the corresponding
entries, symlinks, closures and disappearance after reaping. The large
descriptor listing exceeds one scratch buffer and exercises snapshot
chunking. A rebuilt gallery test checks the actual Internals filesystem
table and its virtual mount roots.

Exited children remain visible until their parent reaps them.
Host-created terminal PTY masters remain retained until machine
destruction: closing the guest slave does not release the host master's
reference, and no host master-close API currently exists. The inspector
reports that real state.

Host inspection uses the immutable reserved init identity, PID 1.
`/proc/self`, `/proc/thread-self` and `/dev/fd` therefore refer to init,
whose descriptor table is empty. This work supplies directory metadata;
it does not add a host API for generated procfs file contents. The
existing `/dev/mqueue` enumerator remains empty. These boundaries are
documented in `docs/architecture.md`.

## Measurement method

Measurements ran October 10, 2026 on macOS arm64 with the canonical dev
shell, Node 24.15.0 and repository Chromium. Baseline commit
`3f4ad86677b26d0f26e9f6915f2c75831658edb5` contains the same runtime as
the previous published batch head `30f1c8f153`. Candidate runtime and
benchmark head is `2e4916515e48aed52864de0d1e3e2ee637ae09bb`. Both use
ABI 49.

All nine benchmark suites completed three rounds on Node and Chromium
for both sides, without missing-suite skips. Guest benchmark source and
Wasm bytes are identical. Node's recorded artifacts differ only in the
kernel and host worker bundle. Browser WordPress image bytes also
differ, so WordPress browser timings do not isolate this host allocation
change. MariaDB image bytes are identical. Timed runs were serial.

The browser harness initially could not refresh a sealed read-only
public asset a second time. It now stages the copy beside the
destination and renames it atomically, cleaning its staging directory
afterward. The same harness change was used in the private baseline
worktree; no baseline runtime code was changed. Its three regression
checks passed.

The first candidate run was interrupted by 595 seconds of laptop lid
sleep, confirmed by `pmset` timestamps. Its timeout occurred at wake; it
produced no completed results JSON and is excluded from comparisons. All
nine suites were rerun while awake, followed by a refreshed baseline.
Owned long jobs used an idle-sleep assertion; that does not prevent lid
sleep. Earlier morning baseline measurements remain retained separately.

The sustained diagnostic keeps descriptors open for 300 complete lock
cycles in each of three fresh machines per host and side. It retains all
conflict assertions, uses `CLOCK_MONOTONIC` and excludes the first 50
cycles from each sustained comparison. The 750 retained samples per side
are cycles within three machines, not 750 independent machine trials.
Combined cycle time is the median of per-cycle sums over all eight
phases, weighted by 127 many-file or 256 dense-file operations and
converted from microseconds to milliseconds.

Node's refreshed baseline ran after the candidate. Chromium's actual
order was candidate 10, candidate 11, baseline 10, baseline 11, baseline
12, candidate 12. These runs span differing machine states and are not
one simultaneous paired experiment.

| Sustained eight-phase time | Baseline, ms/cycle | Candidate, ms/cycle | Change |
| --- | ---: | ---: | ---: |
| Node, three fresh machines per side | 37.9280 | 37.4625 | -1.2% |
| Chromium pair 1, candidate first | 32.5355 | 32.9180 | +1.2% |
| Chromium pair 2, candidate first | 33.2445 | 33.5565 | +0.9% |
| Chromium pair 3, baseline first | 35.9055 | 31.6000 | -12.0% |

Against the earlier morning Node baseline, the same candidate is 37.2415
→ 37.4625 ms, or +0.6%. That change in comparison reinforces the limit
of attributing a small difference to the allocation patch.

The same retained cycles also include slow samples; medians do not prove
a uniform improvement. The following descriptive statistics pool cycles
from the three machines per side. They do not remove the run-order and
machine-state differences described above. Percentiles use inclusive
linear interpolation.

| Retained cycle statistic | Baseline, ms | Candidate, ms | Change |
| --- | ---: | ---: | ---: |
| Node mean | 38.9396 | 38.8829 | -0.1% |
| Node 95th percentile | 52.7141 | 51.7418 | -1.8% |
| Node 99th percentile | 57.0417 | 54.8056 | -3.9% |
| Node maximum | 96.2450 | 138.0210 | +43.4% |
| Chromium mean | 34.1433 | 33.7052 | -1.3% |
| Chromium 95th percentile | 42.5218 | 41.5278 | -2.3% |
| Chromium 99th percentile | 45.5287 | 47.7037 | +4.8% |
| Chromium maximum | 50.3920 | 59.5200 | +18.1% |

The full three-round runs retain first-pass timing flags, including Node
dense acquisition (+17.7%), Node InnoDB 64-bit create (+7.8%), Chromium
dense conflict (+11.1%), Chromium process clone (+10.7%) and Chromium
InnoDB create/insert (+17.5%/+11.7%). They are not erased by the
sustained measurements. Quiet six-round rechecks are recorded below.

Six-round rechecks ran serially with Sortix stopped. Node ran candidate
then baseline for syscall I/O, stdin and 64-bit InnoDB; Chromium ran
baseline then candidate for syscall I/O, process lifecycle and InnoDB.
All completed successfully. Changes below are timing differences, not
correctness failures. Positive latency changes are slower; positive
throughput changes are faster.

| Quiet six-round metric | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| Node dense acquisition, µs/op | 35.86 | 39.66 | +10.6% |
| Node many-file acquisition, µs/op | 33.11 | 32.56 | -1.7% |
| Node getpid, µs | 26.99 | 26.96 | -0.1% |
| Node pipe throughput, MB/s | 62.21 | 62.56 | +0.6% |
| Node file write, MB/s | 79.48 | 79.88 | +0.5% |
| Node file read, MB/s | 113.43 | 108.58 | -4.3% |
| Node stdin, MB/s | 717.76 | 721.17 | +0.5% |
| Node InnoDB 64-bit create, ms | 236.94 | 241.50 | +1.9% |
| Chromium many-file unlock, µs/op | 27.56 | 31.50 | +14.3% |
| Chromium dense conflict, µs/op | 37.11 | 35.16 | -5.3% |
| Chromium dense unlock, µs/op | 31.25 | 27.34 | -12.5% |
| Chromium getpid, µs | 30.00 | 32.00 | +6.7% |
| Chromium fork, ms | 39.50 | 38.50 | -2.5% |
| Chromium clone, ms | 29.00 | 29.00 | +0.0% |
| Chromium InnoDB create, ms | 20.12 | 20.99 | +4.3% |
| Chromium InnoDB insert, ms | 141.31 | 142.30 | +0.7% |

The application flags did not repeat above 5%. Node cold dense
acquisition, Chromium many-file unlock and Chromium getpid remain
adverse flags. Chromium dense unlock improved in this recheck; that does
not mean every unlock phase improved. The cold locking concern is not
declared fixed.

A separate Node diagnostic crossed both host implementations with both
built kernels, using the same guest and compressed rootfs bytes. Each
cell ran three fresh dedicated kernel workers and 300 persistent lock
cycles, retaining conflict assertions. Order was old/old, new/old,
new/new, old/new. The warm statistic excludes each machine's first 50
cycles, as above.

| Node host / kernel | First dense acquisition median, µs/op | Warm eight-phase median, ms/cycle |
| --- | ---: | ---: |
| Baseline / baseline | 29.3555 | 38.4015 |
| Candidate / baseline | 28.0664 | 37.1560 |
| Candidate / candidate | 28.4648 | 36.9510 |
| Baseline / candidate | 27.5742 | 37.2305 |

Changing only the host gives -3.2% with the baseline kernel and -0.8%
with the candidate kernel in warm cycle time. Changing only the kernel
gives -3.0% with the baseline host and -0.6% with the candidate host.
This small ordered diagnostic does not reproduce a consistent slowdown
from either source change. It does not explain or invalidate the cold
benchmark flags: the diagnostic holds descriptors open and uses a
different timing protocol, and three machines per cell do not establish
a general improvement or isolate collection behavior.

## Runtime fingerprints

| Artifact | Baseline SHA-256 | Candidate SHA-256 |
| --- | --- | --- |
| Kernel Wasm | `bbbc81f69853db88eac717d1313b045c10a02b3045ce11d9a7b499d1bd8da5ac` | `66fe4a7796971ee216ad7e2f09cd2010c73ae0773a5892b4e90b99f257f725a4` |
| Node worker bundle | `c62a7f65d02fd03973efea76526241cdf8bafa6e170899b05734517e5e0a6220` | `c21cb126898a040f132671e06f47f86eefeaaf6355dc7a76b469f96e9b48c8a6` |
| Host source inventory, 179 files | `e7e6c6f21ffe163cb240eb3a2d75afcfcb8fd5e8ac885785d76c920ea89b3174` | `eeee312853b33d21a1801c3c378fe05f31a2cef4706a27930668002fef52ec2c` |
| Browser WordPress image | `6cb89adc6c58c55a9028546315d4d2126c5dd69acb6e4568e7b4c49d98341b30` | `df445033f3d71baf9c68cde6bd8f1d768d47a0e4b74d7f919ea95b2601216f84` |

## Validation

All build and verification commands used `scripts/dev-shell.sh` with
automatic cache collection disabled. Normal setup completed all 181
nodes in 14m03s after the final root-inspection fix. Fixtures were built
and stamped for ABI 49 through the normal SDK and fork-instrumentation
path.

| Follow-up check | Result |
| --- | --- |
| Native Rust workspace, excluding xtask | 2,880 passed |
| ABI snapshot | Passed; ABI 49 retained, no snapshot drift |
| Focused host runtime/filesystem tests | 346 passed in 11 files, no skips or load failures |
| Advisory retry and memory-growth coverage | All nine lock commands covered; 23 cases passed within the host tests above |
| Native lazy and inspection browser contracts | 15 passed across Chromium, Firefox and WebKit; no skips |
| Rebuilt gallery Internals filesystem test | 1 passed |
| Atomic benchmark public-asset refresh | 3 passed |
| All nine benchmark suites | Three rounds per host and side completed on Node and Chromium |
| libc functional, regression and math | 306 passed, 17 expected failures, 1 declared flaky case passed; no unexpected failures, build failures or timeouts |
| Open POSIX suite | 174 passed, 3 expected failures, 2 unsupported skips; no unexpected failures, build failures or timeouts |
| Current follow-up Sortix run | Deliberately interrupted during include compilation to prioritize quiet performance tests before laptop closure; incomplete |
| Normal manual browser inspection | Pending; the passing rebuilt gallery test above is automated browser evidence |

The follow-up is not fully merge-validated. Resume Sortix and the normal
manual browser check after the laptop is available. No timed performance
run competed with the stopped Sortix job, and its deliberate
interruption is not recorded as a runtime regression.

Standalone host `tsc` still reports 39 errors. The pristine ABI 49
baseline reports the same 39 after path normalization; the normal setup
host bundles and declaration build pass. This follow-up does not claim a
second full host or ordinary 240-case Chromium run: those remain
historical evidence for the earlier integrated batch, with their
recorded failures and skips. The focused shared-host and three-engine
contracts above validate this follow-up. Erlang tests remain deferred by
maintainer instruction.

Native lazy archive activation remains ZIP-only. The former TypeScript
filesystem also supported gzip-compressed TAR deferred trees, including
OCI layers; that decoder has not been ported. Zstd boot-image decoding
continues to work and is separate. The pre-existing obsolete CI-harness
helper failure and Bun's already-exited sibling warning remain recorded
in the batch description; neither was repaired or claimed green here.

Raw logs, JSON, sources, profiles, morning baselines and sleep evidence
remain locally in `.context/batch-2/` and the private baseline
worktree's `.context/locking/`. The initial investigation remains a
historical record; this report supersedes its procfs/devfs inspection
gap.
