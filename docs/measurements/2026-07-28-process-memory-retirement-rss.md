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
   physical telemetry. On each browser and runner it records two
   48-child retirement trials and a matched control containing 16
   deliberately live Kandelo processes. Each process touches 8 MiB.
   The control must first show a strong memory slope and growth,
   proving that the sampler can see process backing in that run.

The scheduled workflow reports a regression only when both production trials
grow like the sensitive live-process control without a meaningful descent.
It reports a pass only when every trial both separates from the
control and stays below an absolute 2 MiB-per-child late slope and
64 MiB late growth. The absolute limits prevent a smaller unbounded
leak from passing merely because a deliberately live process is
larger. A descending but newly rising trace, one disagreeing trial,
an insensitive control, or an exceeded absolute limit is
inconclusive rather than a false pass.

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

Ordinary unrelated pull requests run only the deterministic
three-engine ownership gate. A pull request that changes
process-memory ownership, retirement fences, collection-pressure
policy, Playwright, or browser-engine dependencies must manually
dispatch the physical workflow for its exact head. All three engine
traces must pass before merge, and moving the branch invalidates the
earlier trace. This limits noisy physical runs to changes that can
affect the contract without leaving those changes to the next weekly
run. Browser dependency bumps use this explicit gate instead of a
path-only automatic trigger because the same lockfiles also carry many
unrelated JavaScript updates, and the evidence must name the PR's exact
head rather than a synthetic merge commit.

This is currently documented maintainer policy; repository automation
does not mechanically dispatch or enforce the exact-head run.

### Planned exact-head enforcement

Land the telemetry workflow before enforcing it. GitHub cannot
`workflow_dispatch` a new workflow until that workflow exists on the
default branch, so making this first telemetry change require its own
dispatch would create a bootstrap deadlock.

A focused follow-up should:

1. Add a `physical_memory_telemetry_required` change-scope output for
   browser/shared process-memory owners, retirement fences,
   collection pressure, this harness, and actual Playwright engine
   version changes in `apps/browser-demos/package-lock.json`.
2. Make `prepare-merge` use trusted base-branch code to select the
   latest `workflow_dispatch` run for the exact pull-request head.
   It must reject a missing run or a newer failure rather than letting
   an older pass hide it.
3. Require that run to succeed and retain non-expired Chromium,
   Firefox, and WebKit trace artifacts. The workflow itself already
   rejects a trace whose commit differs from `GITHUB_SHA`.
4. Test wrong-head, scheduled-only, active, failed, missing-artifact,
   expired-artifact, and exact-success cases.

Explicit paths are intentionally preferable to hunk-keyword
classification: a new closure can retain `WebAssembly.Memory` without
using an existing keyword. Broad shared host files may cause some
extra runs. A future new process-memory owner must be added to the
classifier. Node-only ownership paths should keep their deterministic
Node tests unless the same change also touches browser/shared
ownership.

The initial static path set should include
`host/src/process-memory.ts`,
`host/src/process-memory-creator-gate.ts`,
`host/src/process-generation-detach.ts`,
`host/src/kernel-realm-destroy.ts`,
`host/src/worker-quiescence.ts`,
`host/src/deferred-worker-handle.ts`, the shared/browser kernel worker
entry, protocol, and host files, `host/src/dri/registry.ts`,
`host/src/webgl/submit-queue.ts`, and this workflow, sampler, and churn
fixture, including its focused Vite configuration. Playwright
classification should compare the parsed
`@playwright/test`, `playwright`, and `playwright-core` lock entries
between base and head; unrelated lockfile churn should not trigger it.

This follow-up is expected to take roughly half to one working day,
including its first real three-engine dispatch. Dispatching a pull
request branch trusts that exact head's workflow definition after
review, like ordinary pull-request CI. A default-branch dispatcher
that checks out a `target_sha` and emits a trusted attestation would
be stronger but is a materially larger follow-up.

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
noisy run can rule out an arbitrarily small leak; the absolute limits
state the smallest persistent late trend this workflow treats as
acceptable. The workflow still cannot promise a collection deadline
or prove that every retained byte belongs to one Wasm backing. An
inconclusive result requires repetition or investigation; it is not
positive reclamation evidence.

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
