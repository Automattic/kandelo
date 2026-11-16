# Indexed epoll validation, November 15–16, 2026

This change replaces whole-interest notification scans and delivery snapshots
with a reverse subscription index and a coalesced candidate FIFO. The guest API,
ABI, dedicated kernel worker, wait leases, masks and absolute deadlines remain
unchanged. The measured benefit is for the eventfd scaling probe: at 2,048
registrations its complete create-through-close median fell 53–64% across Node,
Chromium, Firefox and WebKit. Persistent metadata increased. Application results
are mixed; this record does not claim an application-wide speedup or a green
workspace test run.

## Design and semantic boundary

The baseline already had persistent registration, notification history, OFD
ownership and yielding host waits. Its problem was full-list work at notification,
delivery and host wake-hint collection, rather than busy-waiting.

The existing shared epoll backing lock now also owns a fallible `PreparedMap`
AVL index from `(source, never-reused registration identity)` to instance/slot.
Callbacks visit that source's subscribers and indexed ancestors. A per-notification
epoch avoids repeating parent propagation within an affected instance. Each
watch embeds doubly linked FIFO links; repeated notifications occupy one slot.
Dense removal repairs only the moved registration's links and index values.
There are no queued tombstones referring to reused descriptors or slots.

ADD/MOD stage new nodes and vector capacity before publication; refused ADD
publishes nothing and refused MOD retains the previous watch. DEL allocates no
source snapshot. Source refresh retains old subscriptions on refusal and retries
through its description candidate. Index accounting is separate from filesystem
cache admission. One sampler slot is reserved per watch so later nested sampler
membership changes need no allocation. Instance retirement frees its interests,
source nodes, candidate and sampler storage; the global backing table retains
its existing peak slot capacity.

Delivery copies one candidate outside the table lock and rechecks actual backing
readiness. LT delivery moves it to the tail, ET delivery dequeues it, and one-shot
disables until MOD. Each batch visits at most its initial candidate count.
Non-consuming nested checks and blocked probes do not rotate, dequeue, clear
edges or disable one-shot. A later allocation/provider error returns an already
completed short batch and leaves the failing candidate queued. Alias loss queues
authority revalidation without inventing an ET edge. Existing duplicate-fd/OFD,
close/reuse, sibling alias, fork/exec, exclusive callback and four-edge nesting
contracts remain in force.

The host no longer asks `kernel_epoll_wake_indices` to clone and join all
interests at parking. The export remains available; no ABI bump is needed.
Indexed notifications reaching a sleeping instance use the existing coalesced
broad wake record. This can retry unrelated parked waits. The broad wake fan-out
was not separately benchmarked against a large parked-waiter population; the
six-waiter stress test is correctness evidence, not that scaling measurement.
No host interest mirror, shorter safety interval or periodic full-list scan was
introduced. Exact-generation cancellation, atomic mask restoration, empty-set
concurrent registration and finite absolute deadlines retain their existing path.

Ordinary kernel pipes, eventfds, local pipe-backed streams and listeners avoid
idle full-list readiness checks. Host-network history, lazy timer/error state,
task-specific signalfd, PCM/asynchronous devices, delegated host pipes and sockets
without pipe/listener sources retain an explicit sampler list. Nested sampler
membership follows affected ancestors. Device sources can have coarse fan-out.
Datagram/fork capacity identity and KMS state sharing remain fixable platform gaps;
adapters without notification history still reject ET/exclusive with
`EOPNOTSUPP`. See [epoll producer coverage](../epoll.md#producer-coverage).
These limits must not be inferred away from the eventfd measurements.

This is platform work on shared Node/browser paths. Node guest port changes,
libuv backend selection/integration, kqueue, io_uring and new relays are outside
this change. The unchanged epoll/eventfd API and OFD lifetime can support a later
Kandelo libuv epoll backend, subject to the documented provider gaps.

## Inputs and build provenance

Baseline: recorded `origin/main` commit
`f8612113e7bd52a5ce31011d556d7ce1519424be`, detached checkout at
`.scratch/epoll-main`. Candidate: the implementation accompanying this record,
frozen before final measurements. `frozen-source-v3.json` records production
sources; V4 adds only the memory fixture's normal Escape action and scaling test
hashes. Original application JSON records the actual pre-commit HEAD on both
sides; those fields were not rewritten to disguise the uncommitted candidate.
Source manifests and kernel hashes distinguish the builds.

Each side used its own normal SDK/sysroots, fork instrumenter, ABI stamps,
kernel, guest fixtures and images. The identical C scaling diagnostic and test
harness were overlaid on main after provisioning. Shared content-addressed build
cache use is ordinary; artifacts were never swapped between incompatible
builds. All claimed checks ran through that checkout's `scripts/dev-shell.sh`.
Final canonical bootstrap completed 288/288 nodes, exit 0 (12m55s). Earlier
bootstrap wrappers finished their canonical phase and were intentionally stopped
in the unrelated broad standalone GTK fixture inventory; those wrapper commands
are not whole-job passes. Required legacy signal/process and benchmark fixtures
were subsequently built normally with each side's own SDK.

| Artifact | Main SHA-256 | Candidate SHA-256 |
|---|---|---|
| `local-binaries/source-only-v1/kernel.wasm` | `1adb2d2cbc4ab9daad25e0bd29723cd2d343a7b58b5491837bd3e45d6f24f6c0` | `3ad63879a0c9b8e3ed43c1d5e40aa974d867e488cff75d8612fb7f7540821068` |
| `host/wasm/rootfs.vfs.zst` | `08ab06e05991b3b8910333d3290e21926df33c37a707e16a07bd1ae3962b7b87` | `08ab06e05991b3b8910333d3290e21926df33c37a707e16a07bd1ae3962b7b87` |
| `host/dist/node-kernel-worker-entry.js` | `b6cd8a1df8569e955285762551f42eeff6ce1611f922908e8d29f8eeca0a855f` | `69ec2bd6f6d68bacae5c460996fe6d9d6e3c679d0aabf5158e4e5520aa92bc52` |
| `examples/epoll_semantics_test.wasm` | `f347c15e094ef6a80a9a9fb6cac529f4a4dcda3e268bac5f36523c0ca422e3e1` | `102122baba39649fb67ebc7721611d1b421bbe951c54d8c318bbb5a27e6f3153` |
| `examples/epoll_semantics_test.wasm64.wasm` | `131495539a2c45317bb2b9f159e858e6c513d97d5c10e50d699fb97d7b635001` | `ab152bd91ec7810311ef15bc47bec0a7502ba63c68ecb9b7d0cdd67e8a87a9b9` |

The guest binaries have identical source and equal sizes but different hashes
because their own build paths/SDK inputs are retained. Kernel sizes are
2,959,443 B main and 2,975,471 B candidate. Production kernels are uninstrumented.

The unchanged application harness requires the retired standalone `mariadb-vfs`
image for both guest widths. Plain resolution built but did not publish it;
canonical bootstrap refused the excluded package, and direct local-generation
publication failed the runtime identity guard on main. Those failures are
retained. A private copy of the supported set selected only these image products
for the unchanged normal build engine, publishing verified SourceOnly closures.
No shipped catalog, recipe, capability or identity check changed. Missing Node
WordPress source/config initially stopped all six Node launches at the guard;
`packages/registry/wordpress/setup.sh` provisioned each checkout's documented
local fixture (`WP_VERSION=7.0`, `SQLITE_PLUGIN_VERSION=2.1.16`). The ordinary
harness then staged fresh data and dereferenced the plugin symlink. Original
failed launches remain separate from the successful reports.

Host: Apple M5 Max, 18 logical CPUs, macOS 27.2.1; declared Node 24.15.0.
Browser correctness/scaling/memory used Playwright Chromium 153.0.8010.12,
Firefox 155 and WebKit 26.6. Application browser benchmarks used that root
Playwright Chromium distribution. Playwright WebKit is not Safari. Tests used
the shared quiet fixture with guest PCM/analysers running; system output was
not muted. Fork benchmarks used the unchanged default sparse address-space copy.

Retained evidence is under `.context/epoll-index/`: original logs/reports,
`results.tsv`, source/artifact/environment manifests, diagnostic patches,
`scaling-{raw,summary}.json`, application summaries and ordinary matched-pair
`benchmarks/compare.ts` output. `.context/` is retained workspace evidence,
not a tracked release artifact. Disposable native overlays and build trees are
under `.scratch/`. Source-only publication helpers are private diagnostics.

## Correctness and lifecycle checks

| Check on final candidate | Result and scope |
|---|---|
| Canonical optimized `xtask bootstrap --all-packages` | 288/288 nodes, exit 0 |
| `cargo test -p runtime-core --lib --target aarch64-apple-darwin` | 3,766 passed, 1 failed, 0 ignored (121.49s) |
| Full Rust workspace attempt | Compilation failed in unchanged `program-policy/src/lib.rs:187`: undeclared `wasm_posix_shared`; reproduced on exact main |
| ABI snapshot/program baseline (`scripts/check-abi-version.sh`) | Passed; no public interface/layout change |
| `cd host && npm run typecheck` | Passed |
| `cargo fmt --all -- --check` | Failed on candidate and main across 177 files; no whole-workspace formatting pass claimed |
| Source host regression selection | 3 files, 256 passed, 0 skipped |
| Final Node guest/integration selection | 9 files, 270 passed, 0 skipped/failures/load errors |
| Chromium guest correctness | 7 passed, 0 skipped |
| Firefox guest correctness | 7 passed, 0 skipped |
| WebKit guest correctness | 7 passed, 0 skipped |
| Final scaling diagnostic | 96 guest cases passed, 0 skipped across both sides and four hosts |
| Full `./run.sh test browser-memory` | Exit 0, 18 browser cases passed, 0 skipped/flaky; 6 per engine, full four switching cycles; host 253, Node teardown 3 and Bun teardown 7 also passed (29m04s) |

The native failure is `unavailable_host_capability_records_which_one` (EINVAL
versus expected ENOMEM), reproduced on pinned main. An earlier isolated exchange
open ENOENT also reproduced on main; that test passed in the full final run.
The workspace formatting check also fails on pinned main; the patch does not
perform a repository-wide formatting cleanup. The evidence-catalog audit still
reports eight old unclassified files on main;
the new scaling test has its prepared-product classification. These are retained
failures, not a passing workspace claim.

The Node selection was `epoll-semantics`, `epoll-pwait-sigmask`,
`timerfd-wake-latency`, `timerfd-signalfd-scratch`, `abi-version`, `libevent`,
`readiness-deadline`, `kernel-scratch-transfer-boundaries` and
`select-signal-outcome`. It covers both guest widths, four libevent modes,
leases/cancellation, masks/deadlines, scratch boundaries and signal completion.
New native tests cover sparse work bounds, queued dense removal/reuse in four
modes, transactional index/source allocation refusal, short batches, nested
repeated edges/empty-set wake, host pipe probe refusal and disabled sampler
allocation behavior. The C fixture extends real SDK/syscall sparse, dense and
removal/reuse coverage in all four LT/ET/one-shot combinations.

Browser selection was `epoll-semantics.spec.ts`, `timerfd-wake-latency.spec.ts`
and `libevent.spec.ts`, one worker, all three engines. Each candidate engine's
360-round timer stress reported zero stalls. Main first failed Vite startup
because a declared app dependency was missing; after app `npm ci`, main passed
20 cases and failed WebKit's periodic epoll latency check (p50 6,600 us,
max 8,660 us). Candidate observed p50 1,640 us/max 9,800 us and passed. These
single fixture runs do not establish a causal wake-latency improvement. In the
later quiet Node probes both passed: main p50 1,175 us/max 2,010 us; candidate
1,195 us/1,998 us.

The original memory gate timed out clicking Library after Cage captured the
pointer; five other Chromium cases passed, Firefox was interrupted and eleven
cases did not run. A stock-main Cage/input probe reproduced the obstruction.
A second main probe observed `pointerLockElement`, sent the ordinary Escape
key, and passed the ordinary Library navigation. Modeset already advertises
“Press Esc to release.” The test launch helper now does that action when capture
exists and waits for release. No force click, direct `exitPointerLock`, product
UI change, removed assertion, shorter cycle sequence or reduced engine inventory
was used. The complete gate above passed after this fixture correction. A private
Firefox-profile EACCES cleanup warning occurred after tests; the command exited 0.
The original interrupted run remains retained separately.

### Production-guest conformance

Each command below exited 0; expected failures, known-flaky classification and
skips are not added to pass counts. Browser conformance here means Chromium,
not all three engines. No unexpected build failure/timeout occurred.

| Selection | Node | Chromium |
|---|---|---|
| libc functional | 62 PASS, 1 XFAIL | 62 PASS, 1 XFAIL |
| libc regression | 59 PASS, 2 XFAIL, 1 known-flaky PASS | 60 PASS, 2 XFAIL |
| POSIX signal selection | 33 PASS | 33 PASS |
| Sortix I/O, signal, process | 113 PASS, 2 documented SKIP | 113 PASS, 2 documented SKIP |

The Node known-flaky classification was `pthread_cond-smasher`. The Sortix skips
are documented SA_RESTART inapplicability. Sortix used a faithful pinned source
checkout on a case-sensitive HFSX volume via `KANDELO_SORTIX_SOURCE_ROOT`, rather
than the case-folded working-tree submodule. The volume was retired after tests.
Commands, inside the dev shell:

```sh
bash scripts/run-libc-tests.sh functional
bash scripts/run-libc-tests.sh regression
bash scripts/run-posix-tests.sh sigprocmask sigsuspend sigpending sigtimedwait sigwaitinfo
bash scripts/run-sortix-tests.sh io signal process
bash scripts/run-browser-libc-tests.sh functional
bash scripts/run-browser-libc-tests.sh regression
bash scripts/run-browser-posix-tests.sh sigprocmask sigsuspend sigpending sigtimedwait sigwaitinfo
bash scripts/run-browser-sortix-tests.sh io signal process
./run.sh test browser-memory
```

## Work and memory diagnostics (separate from timing)

Private native source overlays exercise the real syscall implementation with
MockHostIO, counting registration inspections/readiness checks. They were never
used as production Wasm timing artifacts. Counts exclude AVL comparisons,
fd/OFD owner resolution, source refresh, host parked-wait retries and scheduler
CPU. They do not prove whole-provider O(k) complexity.

| Watches | Operation | Main inspections | Candidate subscribers | Main readiness checks | Candidate checks |
|---|---|---:|---:|---:|---:|
| 32 | Eight idle checks after initial recheck | 0 | 0 | 256 | 0 |
| 32 | One write + sparse delivery | 64 | 1 | 32 | 1 |
| 32 | 100 writes + delivery | 6,400 | 100 | 32 | 1 |
| 32 | Dense writes + delivery | 2,048 | 32 | 32 | 32 |
| 2,048 | Eight idle checks after initial recheck | 0 | 0 | 16,384 | 0 |
| 2,048 | One write + sparse delivery | 4,096 | 1 | 2,048 | 1 |
| 2,048 | 100 writes + delivery | 409,600 | 100 | 2,048 | 1 |
| 2,048 | Dense writes + delivery | 8,388,608 | 2,048 | 2,048 | 2,048 |

Main counts both its direct and initial parent scan on each mutation. The index
node payload returned to zero after retirement. Observed eventfd capacities were
32/2,048 interests, 64/4,096 source slots and 32/2,048 reserved sampler slots.
Queue links are included in the interest payload. Native allocated metadata
payload (capacities times sizes, live index payload; excludes allocator headers,
fragmentation, global backing slots and RSS):

| Watches | Main interests/sources | Candidate interests/sources | Candidate index | Candidate sampler |
|---|---:|---:|---:|---:|
| 32 | 4,608 B | 5,888 B | 5,632 B | 256 B |
| 2,048 | 294,912 B | 376,832 B | 360,448 B | 16,384 B |

Thus native owned payload is 144 versus 368 B/watch for this two-source eventfd
fixture. A separate Wasm32 compiler layout diagnostic (`cargo rustc ... --
-Zprint-type-sizes`, private targets, no new export) reports interests 96/120 B,
Source 16 B, candidate AVL node 56 B and sampler slot 4 B. Applying those layouts
to observed capacities gives **128 versus 268 B/watch**: 4,096/8,576 B at 32 and
262,144/548,864 B at 2,048. Instance state is 20/64 B separately. These Wasm32
figures are derived payload, not measured browser RSS, reservation or page
commitment. Other providers have different source counts. Whole-lifecycle memory
behavior is supported separately by the ordinary memory gate above.

## Uninstrumented scaling

The same SDK C probe (`epoll_semantics_test --bench 32|2048 lt|et`) ran against
each side's normal kernel/worker. It raises the soft descriptor limit within the
existing hard limit. Three independent parent launches per side alternated order
on an otherwise quiet session. Each Node launch shares a parent across four
count/mode cases; each browser runner covers three engines. This is three
observations per host/count/mode, not statistical certainty.

`clock_getres` reported 1,000,000 ns on every host. Minimum adjacent positive
clock observations ranged Node 21,875–24,583 ns, Chromium 14,999–24,999 ns,
Firefox/WebKit 19,999–20,000 ns; those observations include syscall/channel cost
and are not the physical timer resolution. Small or sub-millisecond differences
must be interpreted cautiously.

The total starts at epoll creation and ends after closing all descriptors,
including register/initial-check/idle/parked/sparse/burst/dense/churn/close work.
Clock calibration and diagnostic buffer allocation precede the total; harness
wall time includes them. Write phases measure mutation plus notification and
the normal guest/channel path, not isolated notification CPU. No placeholder
guest rusage/CPU values are measurements. All 96 guest cases passed; 1,248
clock/phase records produced 192 phase summaries.

### Total at 2,048 registrations

Milliseconds, median [minimum–maximum] across three launches. Lower is better.

| Host | Mode | Main | Candidate | Change |
|---|---|---:|---:|---:|
| chromium | ET | 630.575 [616.225–637.980] | 262.360 [259.510–263.910] | -58.4% |
| chromium | LT | 632.100 [621.160–637.945] | 261.725 [259.370–265.345] | -58.6% |
| firefox | ET | 757.420 [739.700–766.000] | 270.680 [269.820–274.100] | -64.3% |
| firefox | LT | 756.180 [745.560–756.180] | 269.180 [255.820–272.600] | -64.4% |
| node | ET | 542.703 [534.407–652.865] | 239.149 [238.141–239.766] | -55.9% |
| node | LT | 548.212 [535.417–647.700] | 240.493 [240.110–241.054] | -56.1% |
| webkit | ET | 672.880 [668.660–676.800] | 305.360 [304.480–313.660] | -54.6% |
| webkit | LT | 672.200 [667.100–674.380] | 316.360 [304.800–321.440] | -52.9% |

Large-set 64-call idle totals fell from 107.5–185.9 ms to 1.475–2.620 ms;
64 sparse write/wait/read cycles fell from 111.8–188.9 ms to 5.928–8.600 ms.
Dense writes fell from 80.3–91.5 ms to 49.4–69.0 ms, including mutation costs.
Create/register remained included: for example WebKit LT changed 139.62 to
140.06 ms (+0.3%). These are eventfd-probe results, not all-provider/app results.

### Total at 32 registrations

| Host | Mode | Main ms [range] | Candidate ms [range] |
|---|---|---:|---:|
| chromium | ET | 49.000 [48.025–49.255] | 47.250 [47.115–47.580] |
| chromium | LT | 48.680 [47.495–48.870] | 47.500 [46.965–47.860] |
| firefox | ET | 51.620 [49.580–52.180] | 48.840 [47.840–50.340] |
| firefox | LT | 51.940 [49.320–52.260] | 50.920 [49.420–51.120] |
| node | ET | 43.295 [43.111–43.538] | 42.195 [41.782–42.709] |
| node | LT | 42.940 [42.891–44.232] | 42.448 [42.265–42.506] |
| webkit | ET | 57.200 [56.740–57.300] | 55.200 [55.060–55.200] |
| webkit | LT | 56.900 [54.080–57.500] | 54.100 [52.860–55.100] |

All small-set total medians were lower, but several ranges overlap, there are
only three observations per case, and small phase differences approach the
clock/channel floor. These results do not support a broad small-set speedup claim.

### All measured phases

Each entry is main → candidate median milliseconds (three launches). Idle is
64 nonblocking waits; parked is eight 2 ms waits; sparse is 64 write/wait/read
cycles; burst is 64 writes then delivery; churn is 64 DEL/ADD cycles. The total
covers every phase and setup/cleanup. Phase names below are the probe's output.

#### node

| Phase | 32 LT | 32 ET | 2,048 LT | 2,048 ET |
|---|---:|---:|---:|---:|
| burst_delivery | 0.054 → 0.051 | 0.054 → 0.052 | 1.727 → 0.052 | 1.752 → 0.051 |
| burst_write | 2.052 → 2.017 | 1.974 → 1.981 | 2.766 → 1.736 | 2.635 → 1.683 |
| close | 0.848 → 0.843 | 0.824 → 0.885 | 60.619 → 45.208 | 60.594 → 45.075 |
| create_register | 2.515 → 2.659 | 2.537 → 2.726 | 115.924 → 107.697 | 116.012 → 106.952 |
| dense_delivery | 0.060 → 0.062 | 0.057 → 0.060 | 1.696 → 0.559 | 1.663 → 0.601 |
| dense_write | 0.959 → 0.992 | 0.903 → 0.962 | 80.309 → 49.587 | 80.273 → 49.398 |
| idle_wait | 2.572 → 1.942 | 2.518 → 1.907 | 108.112 → 1.569 | 107.494 → 1.528 |
| initial_recheck | 0.704 → 0.723 | 0.690 → 0.727 | 2.908 → 1.415 | 2.942 → 1.410 |
| parked_idle_wait | 22.365 → 22.304 | 22.659 → 22.131 | 51.157 → 22.461 | 51.107 → 22.367 |
| registration_churn | 3.428 → 3.400 | 3.374 → 3.504 | 4.729 → 3.588 | 4.504 → 3.563 |
| sparse_write_wait_read | 7.111 → 7.051 | 7.244 → 6.651 | 112.931 → 6.007 | 111.782 → 5.928 |
| total | 42.940 → 42.448 | 43.295 → 42.195 | 548.212 → 240.493 | 542.703 → 239.149 |

#### chromium

| Phase | 32 LT | 32 ET | 2,048 LT | 2,048 ET |
|---|---:|---:|---:|---:|
| burst_delivery | 0.075 → 0.070 | 0.080 → 0.060 | 2.180 → 0.055 | 2.195 → 0.060 |
| burst_write | 2.375 → 2.285 | 2.405 → 2.325 | 2.900 → 1.980 | 2.805 → 2.015 |
| close | 1.005 → 1.230 | 1.045 → 1.075 | 61.530 → 48.620 | 62.790 → 48.970 |
| create_register | 2.380 → 2.560 | 2.565 → 2.645 | 126.020 → 117.520 | 124.000 → 117.245 |
| dense_delivery | 0.070 → 0.080 | 0.070 → 0.070 | 2.305 → 0.620 | 2.215 → 0.605 |
| dense_write | 1.070 → 1.085 | 1.100 → 1.060 | 83.690 → 53.350 | 82.935 → 53.845 |
| idle_wait | 2.735 → 2.220 | 2.790 → 2.170 | 140.390 → 1.650 | 138.300 → 1.475 |
| initial_recheck | 0.665 → 0.675 | 0.660 → 0.670 | 3.535 → 1.360 | 3.420 → 1.340 |
| parked_idle_wait | 26.140 → 24.845 | 26.015 → 25.045 | 62.445 → 25.780 | 62.665 → 25.885 |
| registration_churn | 3.855 → 4.165 | 3.790 → 3.910 | 4.785 → 3.875 | 4.890 → 3.840 |
| sparse_write_wait_read | 7.855 → 7.305 | 7.890 → 7.590 | 140.795 → 6.590 | 141.355 → 6.520 |
| total | 48.680 → 47.500 | 49.000 → 47.250 | 632.100 → 261.725 | 630.575 → 262.360 |

#### firefox

| Phase | 32 LT | 32 ET | 2,048 LT | 2,048 ET |
|---|---:|---:|---:|---:|
| burst_delivery | 0.080 → 0.080 | 0.080 → 0.060 | 2.840 → 0.060 | 2.840 → 0.060 |
| burst_write | 2.460 → 2.420 | 2.480 → 2.360 | 3.160 → 2.200 | 2.940 → 2.300 |
| close | 0.900 → 1.060 | 0.940 → 0.900 | 71.140 → 48.020 | 71.520 → 50.040 |
| create_register | 2.980 → 3.260 | 3.060 → 2.920 | 129.820 → 123.180 | 129.240 → 121.340 |
| dense_delivery | 0.060 → 0.080 | 0.080 → 0.080 | 4.620 → 0.780 | 4.760 → 0.740 |
| dense_write | 1.080 → 1.120 | 1.160 → 1.080 | 86.180 → 54.040 | 87.780 → 55.600 |
| idle_wait | 3.060 → 2.620 | 3.160 → 2.520 | 184.200 → 1.960 | 185.920 → 1.980 |
| initial_recheck | 0.140 → 0.140 | 0.140 → 0.160 | 3.320 → 0.860 | 3.380 → 0.860 |
| parked_idle_wait | 26.520 → 26.460 | 25.880 → 25.840 | 71.660 → 25.260 | 71.680 → 26.000 |
| registration_churn | 4.180 → 4.080 | 4.100 → 4.280 | 5.060 → 4.020 | 5.280 → 4.060 |
| sparse_write_wait_read | 9.380 → 9.140 | 9.620 → 8.500 | 188.380 → 7.320 | 188.900 → 7.360 |
| total | 51.940 → 50.920 | 51.620 → 48.840 | 756.180 → 269.180 | 757.420 → 270.680 |

#### webkit

| Phase | 32 LT | 32 ET | 2,048 LT | 2,048 ET |
|---|---:|---:|---:|---:|
| burst_delivery | 0.100 → 0.080 | 0.100 → 0.080 | 2.200 → 0.080 | 2.200 → 0.060 |
| burst_write | 2.980 → 2.920 | 2.960 → 2.940 | 3.400 → 2.320 | 3.460 → 2.240 |
| close | 1.920 → 1.900 | 1.880 → 1.880 | 67.660 → 61.140 | 69.260 → 59.640 |
| create_register | 4.020 → 4.300 | 4.060 → 4.520 | 139.620 → 140.060 | 141.400 → 137.300 |
| dense_delivery | 0.100 → 0.100 | 0.100 → 0.100 | 2.280 → 0.900 | 2.300 → 0.860 |
| dense_write | 1.460 → 1.480 | 1.480 → 1.440 | 89.500 → 69.040 | 91.500 → 66.880 |
| idle_wait | 3.900 → 3.180 | 4.040 → 3.280 | 143.840 → 2.400 | 145.240 → 2.620 |
| initial_recheck | 0.720 → 0.840 | 0.760 → 0.780 | 3.740 → 1.700 | 3.680 → 1.660 |
| parked_idle_wait | 24.960 → 23.800 | 24.820 → 23.800 | 61.120 → 23.880 | 60.380 → 23.500 |
| registration_churn | 5.140 → 5.500 | 5.160 → 5.460 | 5.280 → 4.240 | 5.280 → 4.340 |
| sparse_write_wait_read | 10.680 → 10.100 | 10.740 → 9.840 | 146.360 → 8.600 | 148.700 → 7.980 |
| total | 56.900 → 54.100 | 57.200 → 55.200 | 672.200 → 316.360 | 672.880 → 305.360 |

### Harness wall and CPU scope

Bash `time` reports wall/user/system seconds for the runner and its reaped
children, including harness startup and all cases, not guest CPU or one phase.
The browser row aggregates three engines and has parallel host activity.

| Runner | Side | Wall s [range] | User s [range] | System s [range] |
|---|---|---:|---:|---:|
| node | main | 7.415 [6.334–7.431] | 5.943 [5.818–5.949] | 1.424 [1.205–1.592] |
| node | candidate | 5.978 [5.928–6.411] | 5.283 [5.240–5.292] | 1.308 [1.220–1.314] |
| browser | main | 17.752 [17.704–17.997] | 16.780 [16.637–17.004] | 4.456 [4.402–4.606] |
| browser | candidate | 15.536 [15.452–15.936] | 15.242 [15.177–15.344] | 4.259 [4.241–4.811] |

## Full application comparisons

The unchanged enabled inventory is `syscall-io`, `stdin-throughput`,
`process-lifecycle`, `spawn-scratch`, `wordpress`, `mariadb-aria`,
`mariadb-aria-64`, `mariadb-innodb` and `mariadb-innodb-64`. Erlang is disabled
by the ordinary harness and is not counted as passed. All nine suites completed
on Node and Chromium for each successful report. Each report shares a parent
across suites. Three fresh parents per side/host formed the first cohort;
a second matched cohort repeats that scope to investigate initial flags.

The harness was `npx tsx benchmarks/run.ts --rounds=1` and
`npx tsx benchmarks/run.ts --host=browser --rounds=1`, repeated in alternating
side order. Original JSON reports retain `rounds: 1` and their native provenance.
They were not combined into synthetic ordinary multi-round reports. Each pair
was checked with `npx tsx benchmarks/compare.ts before.json after.json`; separate
summaries compute medians/ranges across parents.

The second cohort completed all 12 reports (six per host), exit 0, in 6m50s.
Across both cohorts this is six independent parents per side/host, 24 successful
ordinary reports, with all nine suites in every report. No package builds or
full suites ran concurrently with measurements. Source/doc review continued;
a short workspace formatting check overlapped the second cohort. This is local
observational evidence, not controlled isolation of host scheduling or thermal
state. The original six Node prerequisite failures remain excluded from timings.

Several first-cohort regressions did not repeat at the same magnitude. Browser
many-file conflict changed +14.0% then -5.6%; dense unlock +25.1% then -1.1%;
InnoDB64 bootstrap +5.5% then +0.3%, and insert +16.2% then +0.6%. Node dense
unlock changed +7.3% then +0.2%. These reversals do not erase the original flags
or establish absence of regressions. Node wasm32 Aria SELECT remained higher:
100.84 → 117.39 ms (+16.4%) initially and 98.02 → 115.22 ms (+17.5%) on repeat.
Initial ranges were 94.07–111.38 versus 115.29–119.30 ms; repeat ranges were
96.31–132.43 versus 102.86–117.06 ms. This remains an acceptance risk; its cause
has not been isolated. A separate diagnostic wrapped only that SELECT client invocation with the
existing bounded syscall trace: main collected 797 entries, candidate 799, both
below its 4,096-entry capacity and both exited 0. Both had 666 reads; poll was
8/9 and recvfrom 19/20. Neither trace contained epoll create/ctl/wait/pwait.
This localizes the observed interval to ordinary client/socket work, but does
not rule out indirect costs or establish a cause. The instrumented durations
are excluded from the cohorts. Trace helper and logs are retained separately;
no production source or artifact changed for this diagnostic.

Some positive results also varied: browser Aria create was -17.9% then +10.5%.
WordPress and many other metrics changed by small amounts or had overlapping
ranges. Application throughput/latency improvements must not be inferred from
the separate eventfd scaling benefit.

The following tables retain every metric, rather than selecting wins. Values
are median [min–max], main → candidate, three parent launches in each cohort.
The signed change is the numeric candidate/main change; lower is better for
latency/duration and higher for throughput. Metric names carry the harness units.


### Node: all enabled suite metrics

| Suite / metric | Cohort 1: main → candidate [ranges] | Change | Cohort 2: main → candidate [ranges] | Change |
|---|---:|---:|---:|---:|
| `syscall-io/pipe_mbps` | 61.98 [61.45–62.50] → 62.12 [60.51–63.35] | +0.2% | 61.67 [59.39–63.79] → 62.51 [59.42–63.76] | +1.4% |
| `syscall-io/file_write_mbps` | 87.40 [81.68–87.56] → 84.25 [79.27–86.99] | -3.6% | 84.34 [82.43–87.18] → 85.31 [73.80–87.31] | +1.2% |
| `syscall-io/file_read_mbps` | 123.08 [117.54–124.07] → 121.97 [106.83–123.52] | -0.9% | 123.30 [104.52–124.42] → 123.33 [101.25–125.83] | +0.0% |
| `syscall-io/lock_many_files_acquire_us_per_op` | 28.56 [27.33–30.06] → 28.96 [27.65–34.06] | +1.4% | 28.24 [27.94–30.28] → 27.98 [27.18–31.31] | -0.9% |
| `syscall-io/lock_many_files_conflict_us_per_op` | 24.37 [23.65–24.50] → 24.33 [22.71–24.60] | -0.2% | 24.36 [22.15–24.98] → 24.50 [23.59–25.03] | +0.6% |
| `syscall-io/lock_many_files_replace_us_per_op` | 28.34 [28.31–28.56] → 29.40 [26.93–30.06] | +3.7% | 28.75 [28.53–29.24] → 28.66 [28.30–32.94] | -0.3% |
| `syscall-io/lock_many_files_unlock_us_per_op` | 22.95 [22.19–23.03] → 25.14 [22.91–25.27] | +9.5% | 23.29 [22.96–24.19] → 22.85 [22.81–30.69] | -1.9% |
| `syscall-io/lock_dense_file_acquire_us_per_op` | 23.84 [23.38–24.82] → 24.72 [22.98–25.14] | +3.7% | 23.39 [23.29–24.68] → 23.74 [22.95–26.17] | +1.5% |
| `syscall-io/lock_dense_file_conflict_us_per_op` | 27.00 [26.98–31.03] → 27.55 [26.02–30.49] | +2.0% | 28.09 [26.88–31.13] → 27.00 [26.73–27.97] | -3.9% |
| `syscall-io/lock_dense_file_replace_us_per_op` | 24.44 [24.33–24.90] → 23.35 [23.31–26.93] | -4.5% | 24.03 [22.39–25.39] → 24.13 [24.13–24.57] | +0.4% |
| `syscall-io/lock_dense_file_unlock_us_per_op` | 22.80 [22.74–23.04] → 24.47 [20.95–24.66] | +7.3% | 23.33 [20.48–23.94] → 23.38 [23.32–26.90] | +0.2% |
| `syscall-io/syscall_latency_us` | 24.92 [24.64–34.00] → 24.74 [24.70–24.75] | -0.7% | 24.47 [24.40–25.31] → 24.34 [24.20–25.93] | -0.5% |
| `syscall-io/poll_ready_us_per_op` | 25.60 [25.45–26.04] → 25.37 [25.34–26.11] | -0.9% | 25.34 [25.21–26.92] → 26.55 [25.12–27.42] | +4.8% |
| `syscall-io/poll_timeout_us_per_op` | 1386.53 [1261.86–1392.72] → 1389.30 [1372.81–1389.80] | +0.2% | 1403.28 [1392.39–1404.04] → 1399.30 [1395.47–1412.25] | -0.3% |
| `syscall-io/select_timeout_us_per_op` | 1387.39 [1261.09–1445.80] → 1573.63 [1334.88–1588.42] | +13.4% | 1425.30 [1380.26–1489.77] → 1479.29 [1388.95–1537.69] | +3.8% |
| `syscall-io/epoll_ready_us_per_op` | 29.06 [26.15–30.35] → 24.52 [22.68–24.99] | -15.6% | 29.97 [26.08–31.72] → 30.81 [29.00–31.15] | +2.8% |
| `stdin-throughput/stdin_mbps` | 867.40 [842.16–868.97] → 859.85 [848.51–863.71] | -0.9% | 847.43 [737.03–858.15] → 843.91 [837.00–845.70] | -0.4% |
| `process-lifecycle/hello_start_ms` | 375.26 [362.16–376.40] → 377.11 [367.84–380.20] | +0.5% | 365.32 [356.40–370.11] → 369.56 [358.74–372.16] | +1.2% |
| `process-lifecycle/fork_ms` | 85.74 [85.56–85.79] → 86.49 [85.74–90.38] | +0.9% | 84.65 [80.31–85.77] → 84.96 [84.88–90.87] | +0.4% |
| `process-lifecycle/exec_ms` | 453.80 [449.78–462.52] → 451.40 [447.60–452.28] | -0.5% | 451.55 [438.89–465.93] → 458.46 [451.08–464.89] | +1.5% |
| `process-lifecycle/clone_ms` | 69.79 [67.13–70.52] → 70.88 [70.15–84.72] | +1.6% | 71.41 [69.08–71.51] → 70.60 [70.46–70.61] | -1.1% |
| `spawn-scratch/spawn_ms` | 77.25 [73.81–86.85] → 77.06 [76.60–77.56] | -0.2% | 75.56 [72.87–76.90] → 76.27 [76.22–76.56] | +0.9% |
| `spawn-scratch/spawn_large_wire_bytes` | 84386.00 [84386.00–84386.00] → 84386.00 [84386.00–84386.00] | +0.0% | 84386.00 [84386.00–84386.00] → 84386.00 [84386.00–84386.00] | +0.0% |
| `spawn-scratch/spawn_large_first_ms` | 69.60 [68.73–75.93] → 69.49 [69.46–70.65] | -0.2% | 68.35 [65.43–70.19] → 69.63 [68.92–71.13] | +1.9% |
| `spawn-scratch/spawn_large_repeat_ms` | 70.70 [69.45–70.84] → 72.15 [67.84–72.65] | +2.1% | 68.45 [67.68–72.48] → 68.61 [67.52–70.60] | +0.2% |
| `spawn-scratch/spawn_scratch_kernel_bytes` | 10485760.00 [10485760.00–10485760.00] → 10485760.00 [10485760.00–10485760.00] | +0.0% | 10485760.00 [10485760.00–10485760.00] → 10485760.00 [10485760.00–10485760.00] | +0.0% |
| `wordpress/cli_require_ms` | 505.31 [492.08–517.69] → 498.83 [497.19–503.42] | -1.3% | 505.64 [492.49–511.97] → 502.33 [492.08–530.36] | -0.7% |
| `wordpress/http_first_response_ms` | 3126.60 [2209.91–3230.39] → 1993.54 [1852.95–2712.42] | -36.2% | 3119.87 [3043.68–3269.76] → 1951.20 [1928.79–2719.01] | -37.5% |
| `mariadb-aria/bootstrap_ms` | 2249.19 [2150.54–2320.75] → 2204.15 [2172.85–2281.15] | -2.0% | 2235.70 [2145.55–2312.86] → 2173.94 [2157.23–2213.68] | -2.8% |
| `mariadb-aria/query_create_ms` | 237.63 [237.17–262.42] → 227.59 [227.56–235.01] | -4.2% | 244.46 [228.39–245.36] → 229.27 [228.69–232.78] | -6.2% |
| `mariadb-aria/query_insert_ms` | 1017.76 [966.61–1018.20] → 940.83 [936.76–979.24] | -7.6% | 969.82 [922.64–972.85] → 982.24 [975.74–1005.86] | +1.3% |
| `mariadb-aria/query_select_ms` | 100.84 [94.07–111.38] → 117.39 [115.29–119.30] | +16.4% | 98.02 [96.31–132.43] → 115.22 [102.86–117.06] | +17.5% |
| `mariadb-aria/query_join_ms` | 92.21 [91.35–97.92] → 90.87 [90.52–91.21] | -1.5% | 93.75 [90.11–99.58] → 91.50 [91.32–91.85] | -2.4% |
| `mariadb-aria-64/bootstrap_ms` | 2234.72 [2157.33–2276.84] → 2242.49 [2182.84–2277.02] | +0.3% | 2246.67 [2232.44–2261.95] → 2197.06 [2196.51–2230.08] | -2.2% |
| `mariadb-aria-64/query_create_ms` | 238.01 [232.81–262.11] → 254.68 [228.98–274.94] | +7.0% | 241.21 [231.77–250.82] → 228.54 [226.69–262.10] | -5.3% |
| `mariadb-aria-64/query_insert_ms` | 973.73 [942.30–991.39] → 1015.88 [964.88–1052.02] | +4.3% | 978.17 [923.52–1022.94] → 986.07 [956.86–999.75] | +0.8% |
| `mariadb-aria-64/query_select_ms` | 110.71 [110.06–117.52] → 110.63 [100.72–122.74] | -0.1% | 111.52 [100.16–114.31] → 112.86 [103.15–114.99] | +1.2% |
| `mariadb-aria-64/query_join_ms` | 96.02 [92.47–105.71] → 99.17 [91.53–105.77] | +3.3% | 92.69 [91.76–94.46] → 91.24 [87.25–93.59] | -1.6% |
| `mariadb-innodb/bootstrap_ms` | 2069.99 [2018.63–2126.50] → 2036.22 [2016.61–2090.01] | -1.6% | 2069.38 [2010.53–2088.58] → 2037.70 [2026.29–2041.60] | -1.5% |
| `mariadb-innodb/query_create_ms` | 235.30 [233.46–237.98] → 230.78 [229.68–270.81] | -1.9% | 240.87 [236.30–246.22] → 230.92 [230.08–231.62] | -4.1% |
| `mariadb-innodb/query_insert_ms` | 273.74 [265.07–292.38] → 279.63 [258.89–286.82] | +2.2% | 257.55 [256.19–266.42] → 265.76 [255.16–280.70] | +3.2% |
| `mariadb-innodb/query_select_ms` | 101.41 [97.41–144.06] → 98.01 [92.77–99.12] | -3.4% | 96.91 [96.03–97.93] → 98.66 [97.73–99.73] | +1.8% |
| `mariadb-innodb/query_join_ms` | 90.21 [89.01–100.09] → 88.66 [87.02–89.63] | -1.7% | 90.58 [88.57–92.15] → 90.28 [90.03–91.67] | -0.3% |
| `mariadb-innodb-64/bootstrap_ms` | 2126.57 [2105.01–2154.90] → 2097.85 [2093.84–2238.11] | -1.4% | 2137.30 [2121.58–2147.16] → 2101.06 [2071.84–2130.83] | -1.7% |
| `mariadb-innodb-64/query_create_ms` | 239.36 [233.91–299.95] → 232.59 [228.77–247.46] | -2.8% | 230.33 [230.32–233.82] → 231.52 [228.34–248.53] | +0.5% |
| `mariadb-innodb-64/query_insert_ms` | 279.42 [269.37–279.42] → 268.80 [260.87–272.67] | -3.8% | 269.42 [269.39–301.13] → 261.16 [255.87–277.47] | -3.1% |
| `mariadb-innodb-64/query_select_ms` | 98.16 [97.94–98.97] → 97.08 [94.93–99.51] | -1.1% | 99.00 [98.16–99.13] → 99.44 [96.16–105.97] | +0.4% |
| `mariadb-innodb-64/query_join_ms` | 90.78 [87.81–95.95] → 89.98 [89.25–90.04] | -0.9% | 92.41 [92.12–96.12] → 91.84 [90.21–93.46] | -0.6% |

### Chromium: all enabled suite metrics

| Suite / metric | Cohort 1: main → candidate [ranges] | Change | Cohort 2: main → candidate [ranges] | Change |
|---|---:|---:|---:|---:|
| `syscall-io/pipe_mbps` | 53.15 [52.71–58.89] → 53.36 [53.23–57.84] | +0.4% | 58.48 [51.92–60.16] → 55.75 [54.27–57.18] | -4.7% |
| `syscall-io/file_write_mbps` | 81.50 [79.65–83.06] → 80.41 [78.77–81.07] | -1.3% | 81.86 [80.16–83.13] → 81.93 [81.00–82.26] | +0.1% |
| `syscall-io/file_read_mbps` | 108.89 [108.58–111.73] → 109.90 [108.64–110.07] | +0.9% | 109.83 [108.70–112.10] → 108.18 [107.87–109.00] | -1.5% |
| `syscall-io/lock_many_files_acquire_us_per_op` | 29.73 [29.10–31.89] → 34.57 [31.72–35.43] | +16.3% | 31.42 [29.57–32.32] → 31.96 [28.94–32.64] | +1.7% |
| `syscall-io/lock_many_files_conflict_us_per_op` | 23.28 [23.07–23.34] → 26.53 [25.71–26.90] | +14.0% | 25.91 [25.00–26.54] → 24.45 [23.81–25.35] | -5.6% |
| `syscall-io/lock_many_files_replace_us_per_op` | 29.53 [27.36–34.33] → 30.64 [29.06–31.15] | +3.8% | 31.69 [27.40–31.97] → 32.17 [30.98–33.31] | +1.5% |
| `syscall-io/lock_many_files_unlock_us_per_op` | 26.23 [24.76–28.75] → 27.06 [24.33–27.80] | +3.2% | 26.77 [25.75–26.85] → 27.53 [27.37–28.08] | +2.8% |
| `syscall-io/lock_dense_file_acquire_us_per_op` | 23.61 [22.44–25.16] → 27.25 [24.75–27.38] | +15.4% | 26.64 [22.83–27.60] → 25.76 [25.43–26.11] | -3.3% |
| `syscall-io/lock_dense_file_conflict_us_per_op` | 23.36 [23.08–26.34] → 26.72 [20.16–27.20] | +14.4% | 25.82 [23.85–26.70] → 26.72 [26.23–26.78] | +3.5% |
| `syscall-io/lock_dense_file_replace_us_per_op` | 24.67 [24.00–27.79] → 28.00 [23.73–28.42] | +13.5% | 27.70 [23.69–27.91] → 27.70 [27.52–27.98] | +0.0% |
| `syscall-io/lock_dense_file_unlock_us_per_op` | 19.75 [18.09–24.43] → 24.71 [23.48–25.76] | +25.1% | 24.65 [24.04–24.84] → 24.38 [24.24–24.55] | -1.1% |
| `syscall-io/syscall_latency_us` | 27.23 [26.36–28.77] → 29.50 [28.03–29.87] | +8.3% | 28.38 [28.36–28.66] → 28.20 [27.66–28.32] | -0.6% |
| `stdin-throughput/stdin_mbps` | 834.46 [819.78–854.55] → 862.81 [845.40–866.90] | +3.4% | 865.96 [837.29–880.22] → 856.53 [850.88–885.28] | -1.1% |
| `process-lifecycle/hello_start_ms` | 199.62 [185.40–216.10] → 196.81 [196.43–289.82] | -1.4% | 251.07 [213.05–269.87] → 198.54 [197.34–211.57] | -20.9% |
| `process-lifecycle/fork_ms` | 47.51 [45.48–50.16] → 45.66 [45.34–46.16] | -3.9% | 45.21 [45.13–45.59] → 44.51 [44.04–45.17] | -1.5% |
| `process-lifecycle/clone_ms` | 33.13 [32.57–33.32] → 32.37 [31.99–33.82] | -2.3% | 31.94 [31.52–33.65] → 33.10 [31.67–35.97] | +3.6% |
| `spawn-scratch/spawn_ms` | 40.18 [39.96–47.51] → 39.41 [39.26–39.95] | -1.9% | 39.09 [37.82–44.15] → 39.76 [38.22–42.06] | +1.7% |
| `spawn-scratch/spawn_large_wire_bytes` | 84386.00 [84386.00–84386.00] → 84386.00 [84386.00–84386.00] | +0.0% | 84386.00 [84386.00–84386.00] → 84386.00 [84386.00–84386.00] | +0.0% |
| `spawn-scratch/spawn_large_first_ms` | 30.30 [29.68–34.41] → 29.40 [29.31–29.69] | -3.0% | 28.45 [28.41–28.75] → 29.67 [28.90–34.31] | +4.3% |
| `spawn-scratch/spawn_large_repeat_ms` | 30.76 [29.45–31.80] → 28.86 [28.64–29.17] | -6.2% | 28.85 [28.48–29.10] → 30.40 [28.90–31.71] | +5.4% |
| `spawn-scratch/spawn_scratch_kernel_bytes` | 10485760.00 [10485760.00–10485760.00] → 10485760.00 [10485760.00–10485760.00] | +0.0% | 10485760.00 [10485760.00–10485760.00] → 10485760.00 [10485760.00–10485760.00] | +0.0% |
| `wordpress/boot_ms` | 8481.53 [8453.24–8488.33] → 8480.71 [8436.00–8605.06] | -0.0% | 8454.42 [8440.27–8495.10] → 8446.26 [8440.13–8451.89] | -0.1% |
| `wordpress/http_first_response_ms` | 204.19 [203.64–207.69] → 206.51 [204.01–208.16] | +1.1% | 206.61 [206.27–206.63] → 205.03 [205.01–208.90] | -0.8% |
| `mariadb-aria/bootstrap_ms` | 1097.12 [1074.85–1122.89] → 1097.28 [1075.74–1120.92] | +0.0% | 1059.46 [1052.52–1106.05] → 1085.33 [1071.07–1086.18] | +2.4% |
| `mariadb-aria/query_create_ms` | 15.88 [14.41–19.20] → 13.03 [12.75–13.80] | -17.9% | 12.81 [12.59–15.02] → 14.16 [14.03–14.74] | +10.5% |
| `mariadb-aria/query_insert_ms` | 120.41 [93.92–120.69] → 85.63 [84.69–87.63] | -28.9% | 89.22 [86.44–89.79] → 84.78 [83.37–85.77] | -5.0% |
| `mariadb-aria/query_select_ms` | 7.81 [7.12–8.81] → 7.28 [7.17–7.29] | -6.8% | 6.69 [6.54–8.62] → 6.72 [6.71–7.57] | +0.4% |
| `mariadb-aria/query_join_ms` | 1.87 [1.72–2.98] → 1.63 [1.57–1.70] | -12.8% | 1.66 [1.59–1.66] → 1.54 [1.47–1.58] | -7.2% |
| `mariadb-aria-64/bootstrap_ms` | 1142.61 [1101.56–1189.61] → 1112.74 [1065.34–1142.73] | -2.6% | 1078.52 [1060.52–1173.79] → 1052.57 [1044.67–1075.81] | -2.4% |
| `mariadb-aria-64/query_create_ms` | 14.25 [12.72–14.69] → 13.02 [12.63–13.29] | -8.6% | 14.23 [13.22–14.25] → 13.75 [12.94–13.77] | -3.4% |
| `mariadb-aria-64/query_insert_ms` | 83.22 [79.69–83.85] → 81.64 [81.46–81.71] | -1.9% | 81.21 [81.06–81.92] → 81.32 [81.13–83.60] | +0.1% |
| `mariadb-aria-64/query_select_ms` | 6.71 [6.65–7.12] → 6.77 [6.59–6.93] | +0.9% | 6.69 [6.49–6.98] → 6.69 [6.58–6.74] | +0.0% |
| `mariadb-aria-64/query_join_ms` | 1.77 [1.72–1.79] → 1.83 [1.67–1.86] | +3.4% | 1.72 [1.70–1.81] → 1.67 [1.58–1.68] | -2.9% |
| `mariadb-innodb/bootstrap_ms` | 1008.15 [1000.54–1031.17] → 1012.65 [986.57–1041.94] | +0.4% | 1002.22 [990.72–1003.65] → 1009.42 [967.86–1022.38] | +0.7% |
| `mariadb-innodb/query_create_ms` | 20.44 [18.11–25.79] → 19.69 [17.91–20.41] | -3.7% | 19.49 [19.09–22.43] → 20.21 [19.35–23.56] | +3.7% |
| `mariadb-innodb/query_insert_ms` | 138.43 [135.33–152.20] → 135.25 [135.11–146.53] | -2.3% | 145.91 [135.25–150.27] → 134.64 [133.56–144.93] | -7.7% |
| `mariadb-innodb/query_select_ms` | 6.69 [6.63–6.89] → 6.74 [6.57–7.19] | +0.7% | 6.68 [6.67–7.94] → 6.61 [6.60–6.69] | -1.0% |
| `mariadb-innodb/query_join_ms` | 1.59 [1.58–1.84] → 1.83 [1.78–2.36] | +15.1% | 1.69 [1.50–1.81] → 1.75 [1.60–1.78] | +3.6% |
| `mariadb-innodb-64/bootstrap_ms` | 1002.91 [988.59–1017.05] → 1058.38 [1025.19–1070.33] | +5.5% | 1002.63 [975.34–1008.66] → 1005.58 [960.89–1022.83] | +0.3% |
| `mariadb-innodb-64/query_create_ms` | 19.70 [19.23–22.97] → 22.51 [19.69–23.48] | +14.3% | 20.31 [19.71–20.61] → 20.77 [20.09–26.98] | +2.3% |
| `mariadb-innodb-64/query_insert_ms` | 134.67 [125.74–143.62] → 156.48 [137.56–170.38] | +16.2% | 134.24 [129.62–134.69] → 135.10 [131.94–143.21] | +0.6% |
| `mariadb-innodb-64/query_select_ms` | 8.52 [7.03–8.58] → 7.88 [7.16–9.00] | -7.5% | 8.18 [6.75–9.13] → 7.34 [7.29–9.65] | -10.3% |
| `mariadb-innodb-64/query_join_ms` | 2.10 [2.08–2.68] → 1.92 [1.78–2.01] | -8.6% | 2.24 [1.77–3.21] → 1.79 [1.79–1.99] | -20.1% |

## Reproduction and remaining work

Normal provisioning is `scripts/dev-shell.sh ./run.sh setup --all`, followed by
required standalone SDK test fixtures. The final canonical checkpoint used the
optimized native xtask's `bootstrap --all-packages`; unchanged build-deps and
local-build machinery prepared the dormant benchmark images. Preserve the real
ABI and closure validation on every path.

From `host`, `CI=1 npx vitest run test/epoll-scaling.test.ts`; from
`apps/browser-demos`, `CI=1 npx playwright test test/epoll-scaling.spec.ts
--project=chromium --project=firefox --project=webkit --workers=1`. The private
comparison script records side order/environment, repeats each three times and
retains stdout. Native counters and Wasm32 type layouts require the retained
private patches/diagnostic targets and are distinct from these timing commands.

Follow-up platform work includes complete provider notification histories and
cross-process device/datagram state, reducing broad parked-wait fan-out where
measured, and measuring non-eventfd producers/large nested graphs and many parked
waiters. Readiness owner lookup, ctl-time graph admission/registration lookup and
sampling are not eliminated by the index. Application regressions must remain
visible when considering acceptance; this record does not convert mixed results
into a performance guarantee. No Node/libuv integration was attempted.
