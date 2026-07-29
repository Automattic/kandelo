# Process-memory retirement RSS measurements — 2026-07-28

## Purpose and conclusion

This record measures whether host references released by Kandelo's
exact-generation process teardown become collectible in current JavaScript
engines. It also calibrates the ordinary `ArrayBuffer` allocation used to
encourage engines to notice detached shared Wasm backing sooner.

The ownership result does not depend on garbage collection: every process
generation receives a fresh `WebAssembly.Memory`, Kandelo never reuses a
retired backing, and exact Worker/channel/framebuffer fences determine when the
host may drop its references. The RSS runs show that those references are in
fact collectible. They do **not** establish a portable collection deadline.

The resulting default is a coalesced 4 MiB pressure allocation:

- 4 MiB was the smallest size tested repeatedly on Node/V8 and Chromium/V8,
  and it also produced bounded late behavior on Firefox/SpiderMonkey.
- WebKit/JSC was effectively neutral across enabled and disabled conditions.
  Longer WebKit runs nevertheless showed collection descent and late growth
  far below one complete touched backing per child.
- Reducing 32 MiB to 4 MiB cuts the permanently rooted `ArrayBuffer.byteLength`
  by 87.5%. That also lowers the upper bound presented to an engine for virtual
  address-space reservation and external-memory accounting, but those engine
  internals are not measured here. The buffer is never touched, so neither size
  necessarily commits the same amount of physical RSS; commitment remains
  engine-specific.

The hook is lazy: a kernel allocates no pressure buffer until its first process
retirement. Retirements in one event-loop burst coalesce. Afterward exactly one
4 MiB buffer remains rooted until a later retirement replaces it. The hook is a
collection nudge only—not ownership authority, an admission guarantee, or the
mechanism that makes a retired backing collectible.

## Source and environment

The primary cross-engine runs used candidate
`5e3389917b91684b824e3c225c4a299d3471e344`, which contains the fresh-memory
allocator and exact-generation detach design. Later 4 MiB calibration used the
same implementation plus the final destroy admission fence in this change.
That fence changes destroy races, not ordinary completed-child retirement.

- Host: Apple Silicon Mac17,6, 48 GiB RAM, macOS 26.6
- Node: Node.js 24 from Kandelo's declared development shell
- Browser driver: Playwright 1.61.0
- Chromium: 149.0.7827.55
- Firefox: 151.0, Playwright's bundled Firefox Nightly
- WebKit: 26.5, Playwright's bundled WebKit (not shipping Safari)

## Method

The workload performed one warm-up wave, then sequential waves of real Kandelo
children. Each nested child grew its process memory by the configured amount,
touched one byte in every 4 KiB page, exited, and was confirmed absent from
`/proc` before the next sample. Every wave also used one short-lived parent
process; the `completed children` axis below counts only nested children.

Browser samples were taken 150–250 ms after a wave. RSS is the sum reported by
macOS `ps` for the isolated Playwright `BrowserServer` process tree. WebKit
helpers are launchd-owned XPC processes, so its attribution additionally
includes same-build helper processes born after the isolated launch. A
concurrent run of the same WebKit build would make that attribution ambiguous;
none was run concurrently.

The browser baseline is after a four-child warm-up. Standard runs then used 12
waves of eight children (96 children total), each touching 8 MiB. Extended
Firefox and WebKit runs reached 256 children to distinguish a delayed
collection cycle from full-history retention. Node calibration used both 96
children and the repository's shorter canonical RSS test.

For a 96-child run, `late slope` is the least-squares slope of samples from
children 32 through 96, and `late growth` is `RSS(96) - RSS(32)`. Extended-run
slopes are explicitly recomputed over children 128 through 256. Here,
`collection descent` reports an observed later decline between the named child
counts; it is not a private-footprint or per-object measurement.

All cited runs completed every child, reaped every observed PID, and recorded
no guest stderr, host diagnostics, or browser console errors.

## Current 4 MiB default

These runs use the final 4 MiB default with 96 children:

| Engine | Baseline MiB | Peak MiB | End MiB | Late slope MiB/child | Late growth MiB | Collection descent |
|---|---:|---:|---:|---:|---:|---|
| Chromium | 547.50 | 617.41 at 64 | 534.80 | -0.200 | -37.25 | 92.67 MiB from the peak to the later low at 80 |
| Firefox | 1324.00 | 1509.27 at 56 | 1372.17 | -1.499 | -39.69 | 193.67 MiB from the peak to the later low at 80 |
| WebKit | 696.53 | 910.02 at 96 | 910.02 | +2.050 | +131.83 | none within the 96-child window |

Two additional independent 4 MiB Chromium runs were also bounded:

| Run | Baseline MiB | Peak MiB | End MiB | Late slope MiB/child | Late growth MiB |
|---|---:|---:|---:|---:|---:|
| Chromium 4 MiB A | 548.89 | 628.89 | 595.97 | -0.064 | +5.27 |
| Chromium 4 MiB B | 545.30 | 615.90 | 550.20 | -0.252 | -54.50 |

Two 96-child Node/V8 4 MiB calibrations ended 7.88 MiB and 34.17 MiB above
their post-warm-up baselines, with late slopes of +0.074 and +0.225 MiB per
child. The matched zero-byte control ended 836.16 MiB above baseline and had a
+8.666 MiB-per-child late slope. Separate shorter 4 MiB runs also stayed within
the canonical test's 2 MiB-per-child slope and 64 MiB late-growth limits.

## Pressure enabled versus disabled

Matched 32 MiB enabled/disabled runs were collected before reducing the
default. They establish why some bounded nudge remains useful, while also
showing that the nudge is not what creates collectibility.

| Engine and condition | Late slope MiB/child | Late growth MiB | Maximum excursion above baseline MiB |
|---|---:|---:|---:|
| Chromium enabled A | -0.140 | -14.9 | +24.5 |
| Chromium disabled A | +0.854 | +30.0 | +87.1 |
| Chromium enabled B | -0.030 | +2.8 | +27.4 |
| Chromium disabled B | +1.092 | +22.0 | +106.7 |
| Firefox enabled | -1.040 | +21.4 | +185.4 |
| Firefox disabled | +0.900 | +102.1 | +271.6 |
| WebKit enabled | +2.090 | +133.1 | +222.1 |
| WebKit disabled | +2.069 | +132.6 | +213.8 |

Disabled Chromium and Firefox still produced later drops of roughly 68 MiB and
133 MiB. That is evidence consistent with retired-backing collection without
the hook; enabled runs merely encouraged earlier collection in those engines.
The 96-child WebKit enabled/disabled results are indistinguishable at this
measurement resolution.

## Extended engine behavior

The earlier 32 MiB enabled comparison extends Firefox and WebKit to 256
children; Chromium's corresponding available run ends at 96. These runs show
the late behavior after the initial growth window:

| Engine | Children | Baseline MiB | Peak MiB | End MiB | Late-window slope MiB/child | Later descent |
|---|---:|---:|---:|---:|---:|---|
| Chromium | 96 | 513.44 | 540.84 | 523.73 | -0.030 | 17.4 MiB from 72 to 80 |
| Firefox | 256 | 1292.30 | 1483.90 at 128 | 1431.90 | -0.084 from 128–256 | 152.0 MiB from 48 to 80 |
| WebKit | 256 | 703.80 | 982.90 at 240 | 959.80 | +0.251 from 128–256 | 23.0 MiB from 240 to 256 |

Firefox's absolute summed process-tree RSS was the largest: after child 128 it
ranged from 1413.3 to 1483.9 MiB, roughly 2.7 times Chromium's observed
513.4–540.8 MiB range in its shorter 96-child run and 1.5 times WebKit's
939.0–982.9 MiB range over children 128–256. That is not evidence that Firefox
retained more process memories. Firefox fell 52.0 MiB between children 128 and
256 and ended at 1431.9 MiB, while WebKit rose 20.8 MiB over that interval and
ended at 959.8 MiB. Browser process counts, engine heaps, JITs, helpers, and
shared-RSS double counting differ, so this design uses each engine's slope,
collection descents, and enabled/disabled control—not cross-engine absolute
RSS—as the retirement evidence.

WebKit size controls at 96 children were similarly shaped with 1, 8, and
32 MiB touched per child. Over children 128–256, a root-only control grew
19.3 MiB and the 8 MiB churn workload grew 20.8 MiB. This rules out wholesale
retention proportional to every complete touched backing. It does not rule out
all size-related retained bytes, nor does it promise a flat physical RSS line
over every finite window.

## Interpretation and limitations

- RSS includes shared mappings and may double-count them across OS processes.
  It is not private footprint, JavaScript heap size, or a direct count of
  retained `WebAssembly.Memory` objects.
- Baselines vary substantially between fresh browser launches. Slopes,
  within-run descents, matched controls, and repeated runs are more informative
  than comparing absolute RSS between launches.
- Most conditions have one run. Chromium enabled/disabled and 4 MiB conditions
  were repeated; Node 4 MiB was repeated. Firefox 4 MiB and WebKit 4 MiB each
  have one 96-child run.
- The fixed post-wave delay can sample before or after an engine's next
  collection cycle. A negative short-window slope is evidence, not a promised
  scheduling policy.
- The measurements do not quantify CPU cost, process launch latency, energy,
  private footprint, or application performance.
- Browser termination semantics and collection policies change between engine
  versions. Re-run this record when changing the pressure policy or supported
  browser baseline.

The safe architectural statement is therefore narrow: Kandelo drops its
owned aliases at explicit exact-generation fences, never recycles a retired
address space, and current tested engines can reclaim the resulting backing.
The pressure hook improved collection timing on V8 and SpiderMonkey in the
matched 32 MiB controls, and the later 4 MiB calibration remained bounded on
both engines at much lower retained logical cost. WebKit remains engine-timed,
so whole-worker containment and non-reuse—not RSS timing—remain the
correctness boundary.

## Persistent regression coverage added 2026-07-29

The one-time measurements above are now backed by two different persistent
checks. They deliberately answer different questions:

1. Every host-runtime pull request runs 100 real fork/exec cycles under a
   64 MiB live-address-space budget in Chromium, Firefox, and WebKit. This
   fails deterministically if Kandelo stops releasing exact-generation
   allocation authority. It does not claim that a JavaScript engine collected
   physical backing by a deadline.
2. A weekly and manually dispatchable workflow runs engine-local
   physical telemetry. On each browser and runner it records four retirement
   trials and four deliberately-live controls. Both kinds use 1 MiB and 32 MiB
   children twice in low/high/high/low order. Their positions are symmetric
   across the complete eight-trial sequence. The classifier preserves the
   early low/high and late high/low estimates as two independent ABBA
   replicates. It does not average one leaking replicate behind a descent in
   the other.

Each retirement trial reaps four warm-up children and then 96 measured
children. Each control holds one warm-up child and four measured children
live. The smaller control is not expected to make an absolute memory level
portable. Both high-minus-low live-control replicates must independently
expose at least 8 MiB of physical signal per child at warm-up and sustained
churn before the run may say anything positive about retirement.

One unmeasured context first initializes the browser realm, module graph,
Kandelo kernel, and worker machinery. Every measured trial then records
explicit samples before context creation, after kernel initialization, after
warm-up, after each workload wave, after kernel destruction, and around
200 ms, 1 s, and 3 s after context closure. Classification uses the stabilized
last close sample while retaining all three values in the artifact.

During active churn, each retirement replicate must independently stay at or
below both 4 MiB per child and 15% of its paired live signal. The first
four-child warm-up remains an advisory because an engine may not have
scheduled collection yet; the later 96-child window must show separation.
Each of the four retirement trials, rather than their median, must also stay
below a 0.5 MiB-per-child late slope and 32 MiB of late growth. This prevents
one size-independent leak from being averaged behind three flat or descending
trials.

Kernel-destroy and context-close contrasts use absolute bytes, without
dividing by all 100 retirement children. Each replicate must stay below both
4 MiB and 15% of one paired live child's measured backing. This catches, for
example, four permanently retained warm-up generations that the old
per-100-child denominator could hide. The deliberately-live controls must
lose the same size signal after their kernel and context are destroyed.

A strong size-proportional residual after context closure is a regression when
both matched replicates agree and their live controls cleared. One leaking
replicate, a signed descent disagreement, an exceeded per-trial trend, or a
control-retained signal is inconclusive rather than a false pass. A later
workload-health error cannot erase a physical regression already diagnosed
from the captured samples; it is appended to that regression instead. The raw
artifact also stores the pre-health `physicalVerdict` separately from the
final verdict.

Fixed size-independent cache or just-in-time compiler level changes cannot be
found through a size contrast alone. Across the eight warmed contexts, the
classifier therefore gates the median stabilized close residual at the
smaller of 4 MiB and 15% of one live child's signal, and the upper quartile at
the smaller of 8 MiB and 30%. It also limits the Theil-Sen pre-context slope
to 0.5 MiB per context and the difference between the first and last
two-context means to 32 MiB. A consistent residue plus baseline accumulation
is a regression; one exceeded or noisy dimension is inconclusive.

Each trace carries a key made from the engine version, exact Playwright engine
revision, Playwright package version, and runner image. Automated rolling
median and median-absolute-deviation history is deferred; compare only traces
with the same key, and treat a revision change as a new baseline.

### Pre-hardening smoke calibration — 2026-07-29

The first eight-trial harness was smoke-tested on the same Apple Silicon host
and Playwright 1.61.0 engines named above. The kernel and host runtime came
from candidate `2f44cda0f`; the harness itself was an uncommitted working
tree. These aggregate numbers predate the independent-replicate, stabilized
close, absolute terminal, and fixed-realm gates documented above. They explain
why the size contrast was selected, but they are not validation evidence for
the hardened classifier.

| Engine | Mean live size signal per child | Mean retired active signal | Mean destroy signal | Mean close signal | Old median late slope | Old classifier |
|---|---:|---:|---:|---:|---:|---|
| Chromium 149.0.7827.55 | 30.927 MiB | 2.666 MiB | 0 | 0 | +0.189 | pass |
| Firefox 151.0 | 27.056 MiB | 0.048 MiB | 0 | 0 | -0.713 | pass |
| WebKit 26.5 | 0.006 MiB | 0 | 0 | 0 | -0.003 | inconclusive |

The complete macOS commands were correctly inconclusive. Chromium and Firefox
could not prove Linux-style RSS-plus-swap accounting. WebKit's visible root
tree excluded its launchd-owned XPC helpers, so even deliberately-live 32 MiB
children produced no measurable signal. Linux CI remains the required
three-engine evidence because its launch nonce and exact-install-root scan can
attribute reparented helpers and `/proc` can account for swap. The smoke run
does not replace that workflow and does not establish a collection deadline.

On Linux, every sample includes both resident set size (RSS) and the
`Swap` value from `/proc/<pid>/smaps_rollup`. The classifier uses
their sum because a still-retained backing can leave RSS through
swap. If per-process swap cannot be read, the run may pass only when
validated `/proc/swaps` reads before and after the sample prove that
the host has no active swap device.
End-of-run cgroup metadata is diagnostic evidence, not a substitute
for this per-sample rule.

PSS would apportion resident pages shared across OS processes more
accurately than summed RSS. It is not the classifier signal because
the [Linux procfs contract](https://docs.kernel.org/filesystems/proc.html)
states that `SwapPss` omits swapped pages of underlying shmem objects.
SharedArrayBuffer backing is the shmem case this test protects.
RSS plus full `Swap` is deliberately conservative and can
double-count shared pages. It is matched trend evidence, not an exact
physical-memory measurement.

The scheduled Linux runner gives each BrowserServer a random launch
nonce inherited only by its helpers. It starts with the root process
tree, then unions in reparented nonce-bearing processes born no
earlier than that root. At least one nonce-bearing helper must also
resolve under the selected engine's exact Playwright revision. This
excludes older, other-engine, other-revision, and concurrent
same-build launches. Linux process birth reads bracket each
executable read to reject PID reuse. Failure to complete that scan is
inconclusive. On macOS, WebKit's launchd-owned XPC helpers remain
outside this model, so the standalone harness truthfully reports
incomplete attribution there.

A completed trace becomes inconclusive when the guest writes stderr,
the host reports a diagnostic, the page reports a console or runtime
error, Vite fails, the browser exits early, the expected sample
sequence changes, or the workload's completion transcript is not
exact. A failure before trace completion fails the command and cannot
report a pass. Those failures must not be hidden by an otherwise
favorable memory slope. Each engine's 90-day artifact retains raw
process trees, RSS and swap values, exact install roots, browser and
Playwright versions, runner metadata, workload parameters,
diagnostics, and server logs. The reporter also rejects a trace whose
recorded commit does not equal the workflow's checked-out commit.

Every pull request starts a cheap scope job. A tested path matcher
requires physical telemetry when a change touches process-memory
ownership, retirement fences, collection pressure, browser worker and
graphics aliases, the telemetry harness, or the root/browser/host
dependency manifests and locks. Broad shared paths can cause extra
runs, but a new closure can retain `WebAssembly.Memory` without using
any known keyword. A future browser-side owner must therefore be added
to this matcher. Node-only ownership paths keep their deterministic
Node tests unless they also touch browser/shared ownership. Scheduled
and manually dispatched runs bypass path scope and always measure.
The always-on scope job runs the matcher/gate control tests first.
No-match status is distinct from a matcher error; the latter fails
scope and the aggregate gate rather than skipping the matrix.

Both jobs explicitly check out
`github.event.pull_request.head.sha` for a pull request, rather than
GitHub's synthetic merge ref. Scheduled and manually dispatched runs
use `github.sha`. The reporter compares the trace's Git commit with
that same expected SHA. A branch update starts another exact-head run.
Concurrency is keyed per pull request or ref, so an unrelated pull
request cannot evict another pull request's pending sentinel. Runs for
one pull request remain non-cancelling; if more than one newer run is
queued, GitHub may discard an obsolete pending run while preserving the
active run and newest head.

All three engine traces must pass before a relevant change may claim
physical reclamation evidence. Preparation and measurement jobs are
skipped for an unrelated pull request. One always-present aggregate
gate reports "not applicable" in that case and otherwise requires
successful preparation plus the complete matrix. That stable gate is
the check suitable for branch protection. Manually dispatch the
workflow if a relevant owner falls outside the matcher, then add that
owner. A trusted default-branch dispatcher that checks out a requested
SHA and emits an attestation would be stronger against unreviewed
workflow changes, but is not the current design.

A dedicated cgroup-v2 survival sentinel would be stronger on Linux: put the
whole browser launch in one cgroup, record `memory.current`, `memory.peak`, and
`memory.events`. It must also record `memory.swap.current` or safely disable
swap inside only that test cgroup: touched shared pages leaving RSS through
swap is not proof that their backing became collectible. The sentinel would
prove production completes below a calibrated memory-plus-swap limit while the
retained control reaches that limit. It would retain helper attribution even
if a process were reparented. This is not the current merge gate because
GitHub-hosted runners do not expose cgroup delegation as a stable workflow
contract, and an intentional cgroup out-of-memory kill needs an external
supervisor to preserve the trace. The current artifact records the runner's
cgroup-v2 membership and available memory and swap controls so that feasibility
can be reevaluated without weakening the matched-control test.

This design can detect a future leak of process generations without
comparing Firefox's absolute RSS with Chromium or WebKit. No finite
noisy run can rule out an arbitrarily small leak; the per-child
size-contrast and late-trend limits state the smallest persistent
effect this workflow treats as acceptable. The workflow still cannot
promise a collection deadline or prove that every retained byte
belongs to one Wasm backing. An inconclusive result requires
repetition or investigation; it is not positive reclamation evidence.

### What each persistent check proves

The 64 MiB browser test is intentionally not described as proof that every
JavaScript alias disappeared. It proves that real fork/exec generations can
repeatedly pass the allocator's live-address-space gate and that the public
kernel process table returns to only its permanent, address-space-free PID 1
after every cycle. The allocator releases that authority only after the exact
detach transaction commits, but its short retirement backlog is not a
garbage-collection deadline.

The internal ownership edges are covered separately:

| Ownership edge | Persistent evidence |
|---|---|
| Fresh leases, live-byte accounting, duplicate release, and bounded retirement telemetry | `host/test/process-memory-allocator.test.ts` |
| A deliberately retained typed-array wrapper blocks finalization | `host/test/process-memory-retained-wrapper.test.ts` |
| Process Worker terminal identity and quiescence ordering | `host/test/worker-quiescence.test.ts` and `host/test/node-process-teardown-ordering.test.ts` |
| Main and pthread syscall-channel waiter settlement | `host/test/channel-listener-reclamation.test.ts` and `host/test/multi-worker.test.ts` |
| Kernel device, buffer-object, graphics, and framebuffer view removal | `host/test/process-view-teardown.test.ts` |
| Browser-main framebuffer wrapper and generation-tombstone removal | `host/test/browser-kernel.test.ts` |
| Kernel process-table reaping | the three-engine browser churn test and `host/test/host-owned-process-reap.test.ts` |
| Engine-visible physical-memory separation from retained live processes | the exact-head or scheduled matched-control RSS-plus-swap telemetry |

No public API exposes the allocator's internal lease, channel-listener,
pthread-Worker, and framebuffer-owner collections as one aggregate count.
Adding a test-only aggregate would risk making a synthetic inspection path the
contract. The tests above instead assert each owning subsystem at its
authoritative boundary, while the cross-engine end-to-end test and RSS trace
exercise their composition.
