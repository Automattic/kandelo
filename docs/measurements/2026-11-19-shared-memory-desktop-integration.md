# Fresh shared-memory desktop integration checkpoint

This tracks the desktop-first batch through common runtime/package source
`9fa8f3997224` and consumer diagnostics at `9244de33d45d`. Current desktop,
conformance and combined browser-memory checks pass within the scopes below.
Intermittent lifecycle failures and fresh performance/resource acceptance
remain open. Earlier checkpoints and failed experiments are retained; this
does not complete the original PR1–PR9 plan or establish merge acceptance.

The initial checkpoint used `709edf2ac4`, after the failed-fork rollback fix
at `dd8ec71725`.

## Inputs and normal production path

- Program ABI 56, host adapter 23, group format 4.
- Normal SourceOnly kernel key: `2e7a7fc08572fd94ef0456e78cad5811e2a5fdc5965106e65d0b9f0ea4be1934`.
- `./run.sh partial shell sway swaybg foot wayland-demo bibata-cursor-theme`
  built the package closure and image successfully. Ordinary image SHA-256:
  `cc88bc776b809a436cb938e077665ebfc6a9989cf395e28b794ec8a0fc757638`.
- `prepare-shared-desktop-image.ts`, using its default normal resolver and SDK,
  prepared Sway, Swaybar, Swaybg, Swaymsg, Foot, Bash and Coreutils. Grouped
  image SHA-256: `f34d568a40e433c10b347fe7426b73a5cc3f336409bf78de386b79d827deaca0`.
- Vite built the consumer with the image's declared lazy closure through the
  normal resolver. No frozen manifest or research runtime source rewriting
  was used. The full canonical shell was not built; canonical rootfs was.
- Preview budgets stayed 8192 physical pages, 24 processes and 64 tasks.
  Ordinary per-process and renderer budgets were not raised.

## Results

| Check | Result and limit |
| --- | --- |
| Native runtime | 3,887 passed, none failed or ignored. |
| ABI | Snapshot, supported-program baseline and version policy passed. |
| Source/host memory selection | 1,508 passed; this is not the complete browser-memory gate. |
| Real SDK/public Node | All 37 cases passed, including repeated lifecycle cohorts. |
| Failed-fork cleanup | Both registration and actual replay refusal regressions passed on Node, Chromium, Firefox and WebKit. Each refuses 16 forks, checks no waitable child or page growth, then forks successfully. The pre-fix runtime reproduces rollback EBUSY. The exact user interaction sequence is not reproduced. |
| Fresh default desktop | Chromium, Firefox and WebKit passed at 1920×1080: actual typing/file creation, pointer-selected shell PID checks, two Foot/Bash windows, workspace changes and Stop. |
| Fresh pressure/recovery | Chromium and Firefox passed real launch refusal, existing-shell typing, terminal close/reopen and Stop. WebKit intermittently times out on Sway IPC before an explicit capacity refusal. |
| Native interactive consumer | `./run.sh browser --partial` displayed actual shell command output and two Foot windows in Brave. Subsequent verification uses Playwright. |

The first fresh bundled run began before the server listened, producing three
connection refusals. An HTTP-checked rerun passed five of six cases; the
remaining failure was WebKit pressure. The connection race is test orchestration,
not a runtime failure. WebKit pressure also failed with live syscall tracing
removed; disabling tracing does not resolve the issue.

An ordinary-artifact control used the same freshly built partial image and host
bundle. Its explicit experimental group option leaves ordinary artifacts on
the ordinary backend. At the seventh Foot launch, its shell exec failed native
process-memory construction with Out of memory. The diagnostic reported 19
live processes, 1 GiB per-process ceilings and 277,807,104 live buffer bytes.
That is a distinct refusal; it does not explain the grouped IPC timeout.

One grouped WebKit pressure run under native stack sampling passed. Sampling
reported a WebContent footprint of `2.4G`; this is one instrumented diagnostic,
not a paired footprint benchmark or evidence that sampling fixes the timeout.
No failing interval was captured in that sample. Retain both failed unprofiled
runs and the passing profiled run; the cause remains unresolved.

The existing terminal-worker build workaround now has a standalone reproduction
with no Kandelo code: WebKit 26.6 loses handler initialization after a dynamic
import imports the Worker entry, while Chromium and Firefox controls preserve
it. This startup defect is separate from the pressure timeout. See
[WebKit terminal Worker entry workaround](../../tests/runtime-workarounds/WEBKIT-WORKER-ENTRY-EXPORTS/entry.md).

## Reproduction and retained evidence

The developer commands and bounded supported surface are in
[shared-memory-groups.md](../shared-memory-groups.md). The Playwright config
uses an existing server selected by `KANDELO_GROUPED_DESKTOP_URL`, and writes
retained JSON/screenshots under `KANDELO_GROUPED_DESKTOP_EVIDENCE`.
`KANDELO_GROUPED_DESKTOP_TRACE=0` removes optional syscall tracing for the
pressure diagnostic; the default keeps it and the assertions are unchanged.

Workspace `.context/` retains the fresh partial manifest, per-program SDK
provenance, bundled asset hashes, browser runs 8–12, the failed-fork negative
control and both regression stages. The original plan location remains in
`.context/shared-memory-original-plan-location.txt`; the immutable archive and
external agent-log copy remain intact. Bulk builds and the full stack sample
remain in `.scratch/`.

## Remaining acceptance

- Resolve the intermittent WebKit pressure timeout and recheck sustained use.
- Complete the combined browser-memory gate and applicable conformance checks.
- Measure current ordinary/grouped OS footprint, CPU, input and presentation
  latency, and sustained lifecycle behavior with comparable, uninstrumented
  inputs. Historical prototype numbers and the diagnostic sample do not do this.
- Keep the initial preview's fixed-size object, graphics-unmap and launch limits
  explicit; general mutable file sharing and the wider original plan remain
  follow-up work. The missing Compose table also leaves dead keys unavailable.

No automatic merge or deployment occurred. PHP-FPM remains unchanged.

## Exit-notification correction

Repeated real terminal resize and exit tests found a separate Chromium failure:
the shell exited but Foot remained running with its window visible. This
reproduced three times on the earlier kernel. A matched ordinary Chromium
control completed twelve cycles. The trace shows one nonblocking child wait
after the shell exit, followed by Foot waiting in epoll.

The kernel hid grouped child status until exact execution retirement, but
announced SIGCHLD earlier. A signal-driven `WNOHANG` reaper could consume its
only notification while no status was observable. Correction `90958b9adf59`
defers SIGCHLD and automatic reaping through the existing custody predicate.
Two deterministic native tests fail on the original code and pass with the
correction, including signal death, the last sibling receipt, quarantine,
SIG_IGN and SA_NOCLDWAIT. All 3,889 native runtime tests pass afterward.

A normal SDK C program through public `NodeKernelHost` reproduces the early
notification on the old kernel at the second child (`waitpid` returns zero).
The corrected kernel completes all 64 child exits in both prepared and
ordinary modes. The formal SDK/public Node selection then passes all 39
cases in two files, with zero failures or skips, including the existing forty
cohorts each of pthread, fork, forced exit, native-wait exit and anonymous
sharing. The normal kernel package build and ABI snapshot check pass; the
program contract digest is unchanged.

The corrected normally built kernel has SHA-256
`ac950e58a87f4df07288f71b5078782f512396c91787108d537740e7f7d2ec92`.
A causal browser diagnostic changes only that fetched kernel in the frozen
normal host/image consumer, checks its actual response hash and records the
original server manifest separately. Chromium and Firefox complete twelve
real open/resize/workspace/input/exit cycles with this correction. This is a
kernel-only regression check, not a rebuilt full-candidate release gate.
Firefox's first diagnostic read a newly created proof file before its write;
the corrected wait observes the exact expected shell PID bytes. That failed
run remains retained.

WebKit still times out on Sway IPC during a resize after nine completed
cycles. Ordinary WebKit execution completes the matched twelve-cycle control.
The IPC failure remains unresolved and is not evidence of an engine defect.
The full browser-memory preparation also records guarded source-root metadata
changes during redis-vfs and composer-docs publication; independent package
provisioning continues, but that run cannot establish a passing gate. Current
conformance, complete browser-memory and quiet paired performance acceptance
remain outstanding.

## Sustained WebKit diagnostics after the exit correction

At batch head `678eb46d2115`, an ordinary WebKit control completed sixty
identical terminal open/resize/workspace/input/exit cycles with no guest or
memory-boundary errors. Its longest Sway command took 151.44 ms. Grouped
execution continues to exhibit intermittent multi-second progress gaps and
actual Sway IPC timeouts. These are functional diagnostics under concurrent
validation load, not an accepted performance comparison.

Passive DOM and outgoing Worker observations retain every input frame in the
observed failing runs. No dropped-key, VFS naming or shell-PID defect is
established. A separate live main-realm probe returns promptly while guest
progress is stalled. Native sampling sometimes coincides with recovery but
has not isolated a cause. Generic planned Rust dispatch profiling reports a
maximum of 3 ms in a run with long stalls; it does not cover every grouped
IO, mapping or host-completion path. Per-process gaps include blocked/idle
time and must not be described as CPU time.

Three uncommitted experiments remain isolated from the batch PR:

| Candidate | Evidence and remaining limit |
| --- | --- |
| Construct admitted backing extent before attaching WebKit participants | The old consumer fails the exact 512 MiB backing assertion. The candidate passes it, but sustained terminal use still fails after nine cycles with a grouped Worker readiness timeout. This addresses the separately registered shared-memory growth/VM-teardown hazard; it is not a proven IPC fix. Resource acceptance is pending. |
| Bound the new private grouped IPC wait using the existing heap-safepoint policy | Host build and eighteen channel/heap cases pass on retry. The initial long resolver-build fixture deadline failure is retained. Real WebKit desktop IPC still fails. Source Wasm atomic waits retain their original timeout and FIFO. |
| Preflight all source views before fragmented reply publication and remove temporary containers from valid queue-lock paths | Failure injection on the old code leaves two payload bytes changed before the second view allocation throws. The candidate passes all 223 focused address-space/image/pool/admission cases and host build. A rebuilt normal consumer still fails real WebKit IPC. This is a concrete partial-publication correction, not a demonstrated stall fix. |

The first full browser-memory attempt ended with guarded redis-vfs and
composer-docs source-root metadata publication refusals. The guard was not
weakened. The retry at clean `678eb46d2115` completes all 330 canonical
preparation nodes, all 1,508 source/ownership cases and the three teardown
pretests; complete browser-memory acceptance remains pending. No candidate
above has been promoted on that incomplete gate.

Retained workspace evidence includes `desktop-ordinary-webkit-long-control-26`,
`desktop-sysprof-34`, `desktop-lock-timing-38`, the pre-fix publication failure,
and candidate patches before diagnostic instrumentation. Temporary timing
measured intervals up to 28 seconds between queue-lock acquisition and return
from unlock/notify. A second run locates 6.8–13.9-second delays in the
unlock/notify sequence, after payload publication and ordered waiter wake
finish promptly. This interval includes notification after the mutex is
stored unlocked; it does not prove that the mutex stays held throughout.
Separate store/notify attribution is in progress. No outside-runtime defect
is established and guest wait semantics are unchanged.

Further phase timing isolates the unlock store itself: diagnostic 41 records
0.99, 8.32 and 1.14 seconds between `Atomics.store(lock, 0)` and the next
clock read, while the following notify returns promptly. Changing native
queue contenders to read a held mutex before retrying exchange does not fix
the desktop: the normally rebuilt SDK image 43 still records a 20.7-second
unlock-store interval and fails IPC after one completed cycle. Its changed
helper digest and unchanged ordinary program digests are retained.

A smaller real-helper test uses eight contending Wasm Workers for thirty-two
rounds each with the old and revised C mutexes. Both complete, and both have
a maximum host unlock-store interval of 0.02 ms. Simple write contention is
therefore not established as the desktop cause. The read-first C change was
reverted; its patch, normal image, provenance and failing run remain retained.
A subsequent native-sampling attempt refuses ambiguous process attribution
while the full browser-memory WebKit consumer is live; no foreign process is
sampled. The full gate has passed all six Chromium and six Firefox browser
cases, including repeated constrained machine switches. WebKit remains active.

## Current-head browser-memory gate

`desktop-current-browser-memory-1119-015504-d274` completed successfully in
49 minutes 48 seconds at clean `678eb46d2115`. The normal canonical build
completed all 330 nodes. The source/ownership suite passed 1,508 cases in
57 files with no skips; three teardown pretests and seven Node/Bun
reclamation cases passed. All eighteen required browser cases passed across
Chromium, Firefox and WebKit with no skips. The constrained same-page
machine-switch workloads took 6.7, 11.9 and 7.1 minutes respectively.
The final script reports `Browser memory regression gate passed`.

A nonfatal Firefox staging-directory cleanup EACCES is retained in the full
log. This gate validates the pushed candidate's general machine switching,
ownership, audio and reclamation surface. It does not erase the separate
opt-in grouped-desktop sustained-use failure or validate the uncommitted
experiments described above. Full output is retained as
`.context/desktop-current-browser-memory-final-47/output.log.gz`.

## Follow-up: proven corrections and bounded native-store candidate

Three further corrections have independent negative controls and are now separate
commits in the batch. They do not establish that the WebKit desktop is stable.

- Grouped reply publication creates every source view before any payload or
  status write. Before the correction, an injected second-view failure leaves
  a partially changed fragmented reply; afterwards it leaves the reply intact.
- An exact image stop request closes mapping/fork barrier admission while
  generation and storage custody remain retained. A queued stopped-image
  request previously caused the grouped mapping-barrier fatal error. The new
  tests cover late ingress and cancellation of a barrier already in progress,
  retaining allocation charges and requiring the real stop fence. This
  reproduces the failure class, not the exact cause of browser run 56.
- Host reaping refuses kernel-entry contention before retaining its callback.
  Both hosts await the existing later-turn retry after exact detachment. The
  new nested-entry tests on both pointer widths previously showed a reap
  executing after its caller observed refusal. A public ordinary SDK child
  workload also reported that contention as a host diagnostic.

At batch runtime `ec59b7f1170f`, the host builds and all 252 focused source tests
in seven files pass with zero skips. The first private selector failed to load
its configuration; it ran no tests and is retained separately. In the combined
experimental checkout, all 23 reaper/entry/retry tests and all 39 SDK/public Node
cases pass after the reaper correction, including the five forty-cohort cases.
These experimental SDK results include the uncommitted candidates below; the
full browser-memory gate at `678eb46` has not yet been rerun on this new head.
The ABI snapshot check passes at `719a888988c1`; the program contract digest
remains unchanged and existing programs remain valid.

The mutex investigation now includes a standalone JS/Wasm program containing
no Kandelo implementation or layout. An owner releases a byte-zero mutex under
eight native contenders after warming the caller. The ordinary registry driver
runs two attempts on each engine: both WebKit 26.6 attempts reproduce the
contended JavaScript-store delay, while both Chromium 153 and Firefox 155
attempts do not. The retained last WebKit attempt reaches 4,826 ms for the
JavaScript store and 0.02 ms for the equivalent native Wasm store. This is a
latency observation; it supplies neither a specification timing guarantee nor
the cause of every desktop failure. The initial two Firefox harness launches
failed before running the probe; the normal CoreFoundation home setup fixes
that harness failure. No upstream report has been sent.

The private kernel-only native unlock diagnostic 55 completes sixty real Foot
spawn/resize/workspace/input/PID-file/exit cycles and Stop. Normal candidate 56
with native unlock in all participating realms passes sixty cycles on Chromium
and Firefox, but WebKit encounters a mapping-barrier fatal after twelve cycles
and a later run stalls after forty-one. Removing explicit queue-container
allocations and reusing bounded independent pin scratch does not by itself
resolve the failure (run 59 fails after seventeen cycles).

Normal candidate 61 limits the additional native instance to the owning kernel
Worker. It passes sixty cycles on each of Chromium, Firefox and WebKit, with
final input, actual process removal, Stop and no browser/memory-boundary errors.
WebKit also passes the normal 1920x1080 functional test and the real launch-budget
refusal/recovery test. However, the combined candidate 64 repeats WebKit with
a 120-cycle target and fails Sway IPC during resize after 34 completed cycles;
its subsequent functional/capacity commands do not run. The earlier passes
remain bounded evidence, not a reliability claim. At that checkpoint, these native-store, fixed
initial-extent and private IPC candidates remained isolated and uncommitted.

A further private diagnostic 65 substitutes equivalent native kernel stores
for queue, pool and root-mutex releases. It still fails real Sway IPC after
113 completed cycles. Expanding that substitution is not promoted as a fix.

All failed source variants, setup errors, actual artifacts, negative controls
and results remain retained. Current-head conformance, combined browser-memory
and quiet paired footprint/CPU/input/presentation/resource-cost acceptance are
still required. The batch remains draft.


## Default-mode candidate and current corrections

The custody lookup, JSC initial extent, private IPC safepoint and kernel-only
native queue-release candidates are now separate commits in the draft batch.
They contain no temporary phase timers, bootstrap interception, kernel override,
C mutex change or guest-source rewriting. The kernel-only native binding imports
the existing backing and allocates no additional linear memory. Full candidate
acceptance remains pending.

The custody scans still validate every virtual-capacity PTE and every peer.
They skip only zero entries and use a call-local physical lower bound, refreshed
before accepting any page beyond it. New regressions preserve charges on an
invalid physical index or stable virtual tail and accept live peer growth during
a scan. An instrumented eight-image, 65,536-PTE-per-image mechanism screen reduces
backing-accessor calls from 524,313 to 25. Its intercepted timings are not an
application performance result.

| Current check | Result and limit |
| --- | --- |
| Host build and focused source suites at `b1cf7270b9` | 256/256, seven files, zero skips. |
| ABI and workaround registry at `b1cf7270b9` | Pass; program contract digest unchanged; 25 entries and 66 tag sites consistent. |
| Public SDK/Node on equivalent candidate 78 | 39/39, two files, zero skips; includes five forty-cohort cases. |
| Normal desktop and real budget refusal/recovery | All six cases pass across Chromium, Firefox and WebKit. |
| Candidate 78, default untraced WebKit | One 120-cycle run passes in 4m03s. |
| Default untraced repetition 80 | Chromium 120/120 and Firefox 120/120 pass; WebKit fails Sway IPC after 96 completed cycles. |
| Earlier unchanged candidate 64 with tracing off | 120 WebKit cycles pass in 4m37s. Its earlier traced run failed after 34 cycles. |
| Current ordinary same-kernel control 69 | 120 WebKit cycles pass in 3m06s through the normal unprepared partial image and resolver. |

The default-mode WebKit repetition therefore remains intermittent. Tracing is
not established as the sole cause, and the custody change is not established as
a stability fix. Both positive and negative results remain retained. Lifecycle
run durations include different concurrent work and are not paired performance
measurements. Evidence is retained in `.context/desktop-custody-all3-80/`,
`.context/desktop-custody-lifecycle-78/`, `.context/desktop-normal-no-trace-79/`
and `.context/desktop-normal-ordinary-lifecycle-69/`.

The workspace-wide ownership audit at `b1cf7270b9` reports one unreviewed
allocation in the retained untracked research file
`tools/desktop-shared-memory/wait-checks.mjs`. Nine other audit cases pass. This
run is a failure, not an audit pass. The research file is preserved and the
tracked implementation passes all 10 audit cases in the isolated checkout
(`25be15b5c9`, identical tracked runtime), without adding an allowance or
weakening the audit. The combined browser-memory gate,
conformance and matched resource/latency measurements remain pending.


## Current Chromium resource and captured-glyph sample

Runs 86/87 at runtime `b1cf7270b9` use Chromium 153.0.8010.12, three fresh browser parents per arm,
in order ordinary/grouped/grouped/ordinary/ordinary/grouped. Both use normal
public consumers and the same normally built kernel (`ac950e58…`); the ordinary
control is rebuilt at the current runtime with the normal unprepared partial
image and resolver. Grouped uses prepared image 7 and its verified lazy closure.
This comparison includes image preparation and compilation differences; it does
not isolate the shared backing alone. No owned build, stress, trace or profiler
job overlaps either measurement. Other workstation activity is not controlled;
load readings are retained. This is an application sample, not the full platform
benchmark gate or a statistical confidence claim.

| Measurement | Ordinary | Shared group |
| --- | ---: | ---: |
| Browser-family footprint, one visible terminal (MiB) | 1,883.4 | 2,046.9 |
| Two tiled terminals (MiB) | 2,024.1 | 2,175.8 |
| Two separate workspaces (MiB) | 2,049.4 | 2,192.5 |
| Two retiled terminals (MiB) | 2,057.6 | 2,157.5 |
| Immediately after Stop (MiB) | 1,152.6 | 1,293.5 |
| Browser CPU seconds for fifteen input commands | 1.073 | 1.005 |
| Enter to verified shell-output notification, median/p95 (ms) | 31.415 / 44.040 | 11.745 / 30.030 |
| Keydown to captured actual Foot glyph, median/p95 (ms) | 32.320 / 34.120 | 32.395 / 45.015 |
| Start to first mapped terminal, median (ms) | 1,882.7 | 2,553.6 |

Footprint uses macOS's shared-adjusted multi-PID total for the owned browser
family, including GPU/utility processes. It is not a sum of guest buffers.
Memory and CPU rows are medians of three fresh-parent observations. Input and
glyph percentiles pool 45 observations from three parents each; they are not
45 independent browser launches. OS footprint sampling is outside the fifteen
input commands' CPU interval. Input starts at a trusted Enter event and ends at
verified file bytes after a VFS notification. It is not presentation latency.

The separate glyph observer calibrates actual empty/a/b pixels in captured
canvas video, rejects a target match without input, and measures fifteen normal
keypresses plus one deliberate 50 ms delay control per launch. All six controls
exceed 67 ms. This endpoint includes video capture, RAF scheduling and readback;
it is not physical input-to-photon or a GPU frame-time measurement. A blank shell
prompt and hidden cursor make the calibration deterministic. The earlier run 86
fails calibration before timing in one ordinary and one grouped parent; all six
corrected run 87 cases pass. The first resource run 81 fails three ordinary arms
on a missing favicon; the ordinary fixture is corrected through a normal Vite
build, retaining the error assertion. Failed results are preserved.

The candidate still costs about 164 MiB (8.7%) more with one visible terminal
and starts later in this sample. It does not establish a total-memory saving.
The response sample is shorter, while the captured-glyph median is nearly equal
and its p95 is higher. Immediate post-Stop footprint is not proof of retained
guest ownership or OS reclamation. Further allocation-cost investigation and the
required full before/after benchmark gate remain open.

Raw results, selected OS process identities, OS JSON and screenshots are retained
under `.context/desktop-current-resources-86/` and
`.context/desktop-current-glyph-87/`. The strict reader and summary are
`.context/analyze-desktop-current-86.py` and
`.context/desktop-current-measurement-summary-86.json`; fixture sources are in
`.context/desktop-current-measure-sources-86/`.

A separate untraced run 84 tests the already frozen normal all-realm queue-only
native-release build without the earlier pool/root bootstrap. It fails after
46 completed cycles while querying the tree after terminal exit. The exited Foot
and shell are absent from the later process snapshot; a newly launched control
Worker reports readiness timeout. This does not establish failed Ctrl-D or a
successful all-realm fix. Its errors and source variant remain retained.


## Paused full-capacity preparation

Fork and mapping preparation still made one backing-buffer accessor call for
nearly every PTE while retaining the exact parent/image pause. The same local
physical-bound validation now covers those loops too. It scans the full admitted
capacity, skips only zero entries, validates every nonzero entry's rights, tail
and bounds, and refreshes the lower bound before accepting a page beyond it.
There is no persistent view/limit cache or changed budget, guest wait, FIFO,
retirement fence, helper C or SDK artifact contract.

A normally constructed 65,536-PTE image-store probe runs three rounds per path.
Fork accessor counts fall from 65,560 to 25 and mapping counts from 65,556 to 21.
Those are instrumented mechanism counts, not application timing, total-memory
reduction or proof of a WebKit fix. New tests corrupt physical bounds, tail and
rights in both paths and require unchanged allocation charges.

At runtime `d813d6feb4`, the root host builds, all 258 focused cases in seven
files pass with no skips, and the ABI check passes with unchanged program digest.
Equivalent isolated runtime `64f3986a28` also passes all 39 public SDK/Node cases
and one default untraced WebKit 120-cycle run (3m54s). The normal build uses the
unchanged SDK image and kernel; no temporary bootstrap or guest-source rewriting
is present. The normal desktop/refusal matrix passes all six cases. Of two additional
independent WebKit 120-cycle repetitions, the first passes and the second fails
Sway IPC after 112 completed cycles. Both browser-error and memory-boundary
arrays are empty at that failure. The issue remains intermittent; the lookup
change is not established as its fix. The existing three-browser SDK suite
passes all 84 cases (28 per engine) in 6m52s, including five forty-cohort
workloads per engine and actual fork/exec/mapping/pthread/wait retirement. These
are focused SDK checks, not the full libc/POSIX conformance or browser-memory
gate. No sustained-reliability or full-gate acceptance follows from the passes.
The 86/87 resource sample above is pinned to the preceding runtime; it is not
silently reused as measurement of this new change.


## Exact revised-runtime sample 93

After the paused-loop change, both arms are rebuilt at runtime `d813d6feb4`
(equivalent isolated `64f3986a28`). The same alternating order, three fresh
parents per arm, dimensions, fifteen inputs, glyph calibration, delay controls
and OS collector are retained. All six resource and six glyph cases pass in
1m53s; no owned build/stress/profile job overlaps. The earlier sample remains
above rather than being replaced. Differences between samples are not attributed
to the lookup change.

| Measurement | Ordinary | Shared group |
| --- | ---: | ---: |
| One visible terminal, browser-family footprint (MiB) | 1,886.8 | 2,036.6 |
| Two tiled (MiB) | 2,024.2 | 2,165.4 |
| Two separate workspaces (MiB) | 2,055.4 | 2,203.8 |
| Two retiled (MiB) | 2,065.5 | 2,155.0 |
| Immediately after Stop (MiB) | 1,158.3 | 1,296.5 |
| Browser CPU seconds for fifteen input commands | 1.086 | 0.973 |
| Enter to verified output median/p95 (ms) | 29.140 / 57.480 | 11.225 / 22.655 |
| Keydown to captured actual glyph median/p95 (ms) | 32.400 / 33.900 | 32.435 / 34.145 |
| Start to first mapped terminal median (ms) | 1,884.9 | 2,499.6 |

The same interpretation limits apply: this is an application sample with image
and compilation effects, not the full platform benchmark gate. The glyph
endpoint includes its observer and readback. The current sample still costs
about 150 MiB (7.9%) more with one visible terminal and starts about 33% later.
There is no total-memory-saving or presentation-speedup claim. Material cost and
WebKit long-run reliability remain unresolved before promotion.

Raw results are `.context/desktop-current-resources-93/` and
`.context/desktop-current-glyph-93/`. The strict reader is
`.context/analyze-desktop-current-93.py`; the summary and immutable consumer
identities are `.context/desktop-current-measurement-summary-93.json` and
`.context/desktop-current-normal-consumer-identities-93.json`.


## Bounded consumer output

The desktop consumer retained every stdout/stderr byte and sliced each Sway IPC
reply from that global history. The earlier successful 120-cycle run retained
16,383,430 stdout bytes; the 112-cycle failure retained 15,339,105. This is a
consumer retention defect, independently of the unresolved runtime stall.

Runtime `e2318a392e` stores independent 65,536-byte diagnostic tails for each
stream and reports discarded bytes. Each serialized command separately captures
its complete reply, preserving UTF-8 across callback chunks and releasing the
capture after success or failure. It does not truncate replies or synthesize
compositor output. Five new cases verify oversized replies, split UTF-8, input
ownership, ring wrap, concurrent rejection and failure recovery.

All 1,522 source/memory checks in 58 files pass with no skips, including the
ownership audit. This is the source portion, not the full browser-memory gate.
All six normal desktop/refusal cases pass in Chromium, Firefox and WebKit.
Two additional WebKit 120-cycle runs have mixed results: one fails the tree
query after Ctrl-D at 85 completed cycles, and the other passes 120 cycles,
final real input and Stop. The failed run retains exactly 65,536 stdout bytes
and reports 11,690,128 discarded bytes, with no page errors or main-realm
memory-boundary failures. Bounded history is working; it is not the sole cause
or an established fix for the WebKit stall.

Both normal consumers are rebuilt: grouped `6234/grouped-desktop.html` and
ordinary `6235/ordinary.html`. Their page responses are verified HTTP 200.
The kernel/process Worker JavaScript is byte-identical to run 89, and the
normal kernel and SDK image remain unchanged. The resource sample 93 is pinned
to the earlier consumer and is not claimed as a measurement of this UI change.
No new SDK, guest-source substitution or kernel diagnostic bootstrap is shipped.

Evidence is retained under `.context/desktop-output-functional-96/`,
`.context/desktop-output-lifecycle-96/` and `.context/desktop-output-evidence-98/`.
The last contains raw check logs, fixture sources and Worker identities.
Full combined browser-memory/conformance, platform benchmarks and WebKit
long-run acceptance still remain before promotion.


## Kernel notification-lock observation

Private diagnostic 98 samples group metadata inside the owning kernel Worker
on immutable normal consumer 96. It retains only copied scalar console data;
no guest memory reaches the page. The bootstrap observes allocation bits and
replica request/ack/run words without taking locks or writing metadata. These
are nontransactional samples, not custody or reclamation proofs, and this is
not a performance or reliability acceptance run.

That run fails the actual physical-input/VFS proof after 72 completed cycles.
It collects 269 samples: allocated pages range from 230 to 3,836, the final
observation is 2,848, and the high-water mark reaches 4,211 of 8,192 admitted
pages. Both observed pool-lock values are zero in every sample. The final
replicas have no active pause request and their root locks are clear. A
41,505 ms gap between kernel timer callbacks coincides with the failure.
This does not establish page-budget exhaustion or a retained-pause cause.

Private diagnostic 99 adds duration observation around existing kernel Worker
JavaScript atomic calls, preserving their arguments and results. It fails after
94 completed cycles with a real grouped Worker readiness timeout. The largest
single call is `Atomics.wait` on the group notification lock at byte 4,112:
21,952 ms, alongside earlier 2,063 ms and 471 ms waits. The corresponding kernel
timer gap is 22,036 ms. No measured JavaScript store, compare/exchange, exchange
or notify call exceeds 20 ms. The allocation high-water mark remains 4,731 of
8,192 pages. This is evidence of a long synchronous host lock wait at
`publishMemoryGroupNotification`, not proof of another JavaScript store stall
or a particular engine defect. The blocked kernel turn can also delay readiness
message processing and deadline callbacks. It does not explain every retained
failure by itself.

Raw observations are retained in `.context/desktop-accounting-98/` and
`.context/desktop-atomic-spans-99/`; logs and diagnostic sources are retained in
`.context/desktop-output-evidence-98/`. Neither bootstrap is shipped in the PR.
The production notification publication path still blocks on this lock. Its
kernel-event-loop behavior requires correction with publication, waiter ordering
and exact image/channel lifetime preserved. Increasing readiness or test
deadlines is not the correction.


Private control 100 changes only the owning kernel Worker's JavaScript wait on
that lock to a 10 ms bound. Source-Wasm wait timeouts, FIFO positions and all
application deadlines remain unchanged. It still fails the real input/VFS proof
after 43 completed cycles. Individual measured atomic calls stay below 20 ms,
but the kernel timer still has a 22,335 ms gap. A bounded wait inside the same
synchronous retry loop is therefore not a liveness fix. It is not promoted.
An initial wrong-checkout invocation fails before loading the configuration;
that setup failure and the corrected actual failure are retained separately.
Evidence is `.context/desktop-private-lock-bound-100-retry/` plus the log/source
archive above. The queue retry loop remains a concrete event-loop risk; these
observations do not establish that it explains all failures.

A suitable correction must refuse queue contention before any completion byte
or status is published, retain the exact prepared completion, and retry on a
later kernel Worker turn. The existing Rust direct-publication import already
supports refusal followed by the normal queued completion path; it must not
report publication success merely because asynchronous work was accepted.
Private Worker IPC request notifications also need only the native kernel
observer, rather than admission into the guest-notification queue. These are
implementation directions, not shipped behavior or acceptance claims.


## Rejected asynchronous completion experiment

Private variant `ab31773ffe` refuses queue contention before publishing a reply
and retries on a later kernel Worker turn. It also changes private IPC request
notification to wake only the native kernel observer. The variant passes its
host build, all 1,534 source checks in 59 files, the unchanged ABI check and all
six normal desktop/refusal cases. A read-only instrumented WebKit run passes
120 cycles, final real input and Stop in 4m20s. A preceding normal variant fails
the actual input/VFS proof after 116 completed cycles at the 480-second test
limit, with no page errors or main-realm memory violations.

The full SDK checks reject this variant. Node passes 38 of 39 cases; the pthread
cohort test fails at SDK cycle 29. The failed root PID 296 retains thread 300 as
logically exited but not quiescent or joined. The group uses 174 of 2,048 pages,
and the previous successful cohort has retired to one metadata page. Chromium
also fails pthread churn and pthread cohort cycle 6. After these failures the
remaining browser run is deliberately interrupted: 26 cases pass, two fail,
one Firefox case is interrupted and 55 do not run. It is not an 84-case pass.

The retry implementation loses an existing terminal-mailbox guarantee:
`#finalizeThreadExitWithinKernelEntry` removes a thread's channel before its
final exit completion. The new retry refuses an unregistered channel on queue
contention, dropping the reply; its following thread-exit callback also assumes
publication has already finished. Correct asynchronous publication would need
explicit custody for detached terminal mailboxes and retirement ordered after
actual publication. Passing source checks does not prove that lifecycle.

This variant is rejected and is not included in the batch PR. Its exact commit
is retained on local branch
`brandonpayton/shared-memory-publication-experiment`, with the full patch,
logs, diagnostic source and browser results in
`.context/desktop-publication-evidence-103/`. Node results are in
`.context/desktop-publication-node-104/`; normal and instrumented desktop
results are in `.context/desktop-publication-lifecycle-102/` and
`.context/desktop-publication-accounting-105/`. The next isolated candidate
keeps only native-observer notification for private IPC requests. It does not
change completion publication, thread teardown, guest waits or the ABI; it
still requires fresh SDK and desktop validation before acceptance.


## Accepted narrow IPC change and current checks

Runtime `c702dd9214` (equivalent isolated `f1a634a03f`) keeps only native-observer
notification for private Worker IPC requests. Completion publication and thread
retirement use their original ordering. No asynchronous completion-retry code
from the rejected experiment is included. The change is shared by Node and
browsers, with no helper C, SDK image, guest program, memory ceiling or ABI change.

The host builds, the ABI check passes with unchanged program digest, all 1,523
source cases in 58 files pass, and all 39 SDK/public Node cases pass with no
skips. The SDK browser suite passes all 84 cases (28 per engine), including
pthread churn and five forty-cohort workloads per engine. All six normal
three-browser desktop/refusal cases pass. Two independent normal, untraced
WebKit runs each pass 120 real terminal cycles, final input and Stop in 3.8 and
3.9 minutes. They use the normal immutable consumer, without a bootstrap or
metadata substitution. This is bounded evidence; earlier WebKit failures remain
retained and longer reliability is not established by two passes.

The candidate is available at `http://127.0.0.1:6238/grouped-desktop.html`.
The matching ordinary control is `http://127.0.0.1:6240/ordinary.html`.
These results do not replace the required combined browser-memory gate, full
conformance checks or all-suite Node/browser before/after benchmarks.


## Current paired sample 112

The corrected current consumers have byte-identical kernel and process/kernel
Worker JavaScript. Grouped execution uses the unchanged normal SDK image 7;
ordinary execution uses the unchanged normal partial image and its declared
asset resolver. Both include the bounded diagnostic-output consumer. Three
fresh Chromium parents per arm run in the same alternating order as sample 93;
all six resource and six separately captured-glyph cases pass in 1m56s. The
strict reader passes through the dev shell. No owned build, stress or profiling
job overlaps this sample.

| Measurement | Ordinary | Shared group |
| --- | ---: | ---: |
| One visible terminal, browser-family footprint (MiB) | 1,872.4 | 2,021.6 |
| Two tiled (MiB) | 2,026.9 | 2,157.5 |
| Two separate workspaces (MiB) | 2,043.2 | 2,197.5 |
| Two retiled (MiB) | 2,048.9 | 2,194.0 |
| Immediately after Stop (MiB) | 1,157.3 | 1,343.9 |
| Browser CPU seconds for fifteen input commands | 1.215 | 1.018 |
| Enter to verified output median/p95 (ms) | 33.290 / 45.880 | 11.470 / 29.150 |
| Keydown to captured actual glyph median/p95 (ms) | 32.190 / 32.940 | 32.220 / 32.420 |
| Start to first mapped terminal median (ms) | 1,943.2 | 2,549.9 |

The grouped sample costs about 149 MiB (8.0%) more with one visible terminal and
starts about 31% later. There is no total-memory-saving or presentation-speedup
claim. The glyph endpoint includes video capture, scheduling and readback;
all six deliberate 50 ms controls exceed 67 ms. It is not physical
input-to-photon or GPU frame time. Immediate post-Stop footprint does not prove
guest storage retention or OS reclamation. This is an application sample,
including image preparation and compilation differences, not the full platform
benchmark gate. Changes between historical samples are not attributed to the
IPC change.

Measurement 111 is retained as failed: its ordinary fixture mistakenly uses the
grouped frozen asset manifest and all three ordinary arms fail the image's
integrity check while reading Sway. Its three successful grouped arms do not
form an accepted paired comparison. The corrected ordinary fixture uses the
normal image-declared resolver with that manifest unset; no assertion, kernel,
program or deadline changes are made. Sample 112 reruns both arms completely.
Raw results are `.context/desktop-ipc-resources-112/` and
`.context/desktop-ipc-glyph-112/`; the strict reader and summary are
`.context/analyze-desktop-ipc-112.py` and
`.context/desktop-ipc-measurement-summary-112.json`. Frozen identities are
`.context/desktop-ipc-normal-identities-112.json`. Logs and source fixtures are
retained in `.context/desktop-ipc-evidence-108/`.


## Sustained mapped-byte growth in both modes

The retained ordinary WebKit run 69 grows Sway's mapped virtual bytes from
8.375 to 108.375 MiB across 120 terminal cycles. Current grouped repetitions grow
from 8.375 to 109.875 and 110.125 MiB. These are kernel-reported sums of live mmap
region lengths, not browser RSS or just a Wasm backing ceiling. The ordinary
result is historical, so it is not used as a same-run performance comparison.
The growth in both modes requires investigation before claiming stable resource
use over longer sessions.

A fresh read-only diagnostic 113 runs the same twelve real terminal cycles on
both current normal consumers. Both cases pass all input, window, exit and Stop
checks. Public `readProcMaps` snapshots locate the growth in private anonymous
writable mappings: ordinary 3.5625 to 13.25 MiB; grouped 4.8125 to 15.1875 MiB.
The mapped Foot shared-buffer pool total remains 3.25 MiB in each arm. This
narrows the investigation; it does not establish the allocating caller, a leak
cause, resident cost or a shared-group-only defect. No guest rewriting or raw
memory inspection is involved. Results are retained in
`.context/desktop-mapping-cost-113/`, with source and logs in the evidence archive.

### Request-only isolation and json-c release deletion

Diagnostics 114–118 separate Sway tree queries, version queries and resizing
from terminal creation. Fresh Chromium consumers perform 500 successful
untraced requests each, followed by real terminal input, VFS verification and
Stop. Anonymous writable mappings grow as follows:

| 500 requests | Ordinary, initial → final (MiB) | Grouped, initial → final (MiB) |
|---|---:|---:|
| `get_tree` | 3.5625 → 31.4375 | 4.8125 → 32.9375 |
| `get_version` | 3.5625 → 3.9375 | 4.8125 → 5.1875 |

Descriptor counts stay at 58 ordinary and 57 grouped. A separate bounded trace
117b observes Sway accepting and closing IPC connections, anonymous allocations
and some unmaps. The earlier full trace tail 116 is too late to explain the
allocation calls. The fork-only marker probes 114/115 fail and do not establish
a fork-only cost. These are mapping and correctness diagnostics, not resident
memory measurements or performance samples.

The json-c 0.19 source performs the final container deletion inside `assert()`
in its iterative `json_object_put()`. The normal package uses `-DNDEBUG`, so
that freeing call disappears. Native experiment 123 uses the actual upstream
release source and counts `json_object.c` allocations without running Kandelo:
after 100 root objects containing nonempty arrays are released, 200 objects
remain allocated. Moving the call outside the assertion retains zero. The
committed native regression check also passes against the package patch (124).
The package applies that correction through its normal recipe, declares the
patch as a cache input and advances its output revision to 2. The assertion
still checks the freeing call's result in assertion-enabled builds.

Earlier guest JSON allocation probes 120c/121/122/125/126 are retained but
their live-allocation counts are invalid: nested malloc calls from wrapped
calloc/realloc can register a pointer twice, leaving false live entries and
eventually filling the diagnostic table. They are not acceptance evidence.
The plain malloc/free control is unaffected by that duplication and has stable
196,608 mapped bytes through 1,000 repetitions. Corrected counter probe 128
updates an existing pointer's record instead of duplicating it. The independent
native regression does not use the nested allocation wrappers. Corrected probe
128 passes its negative control and candidate checks: the original library
retains 11,100 allocations / 599,080 requested bytes after 20 rounds; the
patched library retains zero after 1,000 rounds of the same 50-object JSON
workload. The patched process maps plateau at 262,144 bytes in that probe;
this is not a browser RSS or full-desktop result. Desktop benefit
still requires rebuilding Sway and the image through the resolver and SDK,
then repeating the request and lifecycle checks.

The current combined browser-memory attempt 119 fails during canonical product
preparation because this experimental checkout lacks the pinned Rust libc
submodule; it does not reach the host/browser memory regressions. The submodule
is now initialized normally. This is retained as a failed gate, with no skip or
readiness waiver. Raw request results are `.context/desktop-map-steady-118/`;
the standalone and guest allocation logs are retained with the resource evidence.

### Fresh normal desktop after the json-c correction

Normal partial-shell build 129 passes, followed by the default image-declared
resolver and formal SDK preparation of all seven desktop participants (131).
No frozen asset override or research guest rewriting is involved. The ordinary
image is 707,437 bytes, SHA-256
`c939f98060cfe5e8d76d24bf1e42142f4965337523f48335844a028137ab5477`;
the grouped image is 7,439,347 bytes, SHA-256
`44e06ab29567f1960c9d616eabdc0bafd8ad538a8364f060d0b395818a4bfbe5`.
Both consumers serve the unchanged `ac950e58…` kernel and byte-identical worker
JavaScript. The installed libc and startup object also match the previous
candidate checkout byte for byte.

All four normal, untraced Chromium query cases (132) pass, each with 500
requests, final physical terminal input, VFS verification, memory-boundary
checks and Stop. These anonymous writable mapping totals replace the earlier
unbounded request-dependent growth:

| Patched desktop | Initial (MiB) | After 100 requests (MiB) | After 500 requests (MiB) |
|---|---:|---:|---:|
| Ordinary, `get_tree` | 3.4375 | 3.5000 | 3.5000 |
| Grouped, `get_tree` | 4.6875 | 4.7500 | 4.7500 |
| Ordinary, `get_version` | 3.4375 | 3.4375 | 3.4375 |
| Grouped, `get_version` | 5.0625 | 4.6875 | 4.6875 |

The grouped version case starts with 60 descriptors and settles to 57 after
its first request; the other descriptor counts remain 58 ordinary and 57
grouped. The tree cases add only one 64 KiB mapping, versus approximately
28 MiB in the earlier 500-query cases. This is a bounded application mapping
result, not browser RSS, physical reclamation or sustained terminal-lifecycle
acceptance. The canonical build and part of the separate desktop matrix run
concurrently; no timing or CPU result is inferred. Raw results and the strict
summary are `.context/desktop-json-steady-132/` and
`.context/desktop-json-steady-summary-132.json`. HTTP and artifact identities
are `.context/desktop-json-normal-identities-131.json`.

The fresh desktop matrix 133 passes all six functional/refusal cases across
Chromium, Firefox and WebKit. Its first normal, untraced WebKit repetition also
passes all 120 real terminal cycles, final input, boundary checks and Stop.
Sway's anonymous mappings increase only from 4.6875 to 4.7500 MiB; shared file
mappings remain 3.4375 MiB and guards remain 0.1250 MiB.

The second repetition fails after 95 completed cycles with a grouped-runtime
diagnostic for PID 2509: `Grouped Worker readiness timed out`. This is the
10-second memory-free readiness handshake, before the prepared Worker receives
its process backing. The failed child is absent from the final live process
snapshot; the base Sway/Foot processes remain enumerable. The cause is not
established. The successful first repetition does not turn the pair into a
passing sustained-lifecycle gate. No timeout or assertion has been changed.
A separate private native sampling diagnostic targets an exclusively attributed,
byte-verified copy of the same Playwright WebKit runtime, only if an actual
command remains pending for 2.25 seconds. It does not rewrite guest or host
source, and is not performance or normal lifecycle acceptance evidence.

The raw lifecycle fixture inherits `concurrentCanonicalBuild: false` from its
older template; that flag is incorrect for 133 (and its diagnostic derivative
140). The stated scope and recorded job intervals show that canonical gate 130
runs concurrently. Treat the flag as invalid metadata, preserve the original
records and infer no isolated timing result. The failure log and Playwright
report are retained in `.context/desktop-json-evidence-124/`, alongside the raw
`.context/desktop-json-lifecycle-133/` results.

### Combined gate and follow-up diagnostics

The provisioned combined browser-memory run 130 finishes with a failing gate.
All 1,523 source cases, three Node teardown cases and seven Bun teardown cases
pass. The browser phase has 14 passes and four failures:

| Engine and case | Observed failure |
|---|---|
| Firefox, machine switching | The WordPress launch after DOS/tmux retains its progress card. The trace also reports failed PCM shutdown and kernel-realm containment; the cause is not established. |
| Firefox, audio activation | Audio becomes active, but the Enable click remains in its visibility/enabled/stability wait for about 150 seconds despite its two-second deadline. No running transition is observed; the cause is not established. |
| WebKit, machine switching | The required external Quake archive HEAD request fails before guest boot. |
| WebKit, audio activation | The external Doom WAD request returns HTTP 502, preventing boot. |

The original logs, screenshots, traces and compact failure receipt are retained
in `.context/desktop-json-evidence-124/`. The audio driver, gesture test and
persistent-page fixture match `develop`; this does not rule out a regression in
another layer. No deadlines, required checks or containment assertions change.

Diagnostic 142 completes one 120-cycle WebKit session, then fails during physical
keyboard input after 114 cycles in its second session. Its native sample covers
an earlier transient command delay and does not establish the input failure's
cause. Diagnostic 143 completes two fresh 120-cycle sessions, final input and
Stop. These diagnostics use extra public process observations and exclusively
attributed native sampling of an unmodified WebKit copy. Their passes do not
erase the uninstrumented readiness failure or establish normal sustained-use
acceptance. Raw records remain in `.context/desktop-readiness-ledger-142/` and
`.context/desktop-readiness-input-143/`.

The `concurrentValidationJobs` list in 143 is overbroad: jobs 130 and 135 ended
before 143 started. Preserve the raw list, use the actual job intervals, and
infer no performance result from these diagnostics.

Normal candidate preparation 144 passes all 24 steps, including the ten
benchmark fixture compilations, normal 32/64-bit MariaDB image publication and
actual artifact admission for all nine suites on Node and browser. Baseline
admission 136 also passes. These are prerequisite checks, with no timing samples.
Current conformance and the unchanged four-case browser recheck are running;
the complete browser-memory gate, quiet paired benchmarks and fresh desktop
resource/input/presentation measurements remain outstanding.

Conformance run 145 subsequently passes all eight wrappers on the same frozen
runtime: libc functional/regression, full POSIX and Sortix process on Node and
Chromium. Each host has 328 classified cases, with six expected failures and
two predeclared skips. Node also reports one predeclared regression flake-pass;
Chromium reports that case as a normal pass. There are no unexpected failures,
build failures or timeouts. The kernel and canonical rootfs hashes remain
unchanged. Detailed results and suite logs are retained as
`.context/desktop-json-evidence-124/conformance145-*`.

The unchanged four-case recheck 146 passes both machine switching and audio
activation on Firefox and WebKit, with zero skips or flaky outcomes. It uses
normal image assets and the standard silent Playwright fixture; the original
130 failures remain retained. This recheck is not the complete 18-case gate.
The full unchanged browser-memory command is running again as 150.

A lower-budget experiment 149 selects the existing `groupPages=4096` option
(256 MiB), with no producer or guest changes. Five of six functional/refusal
checks pass, including normal two-terminal use on all three browsers. Chromium
cannot reopen its sixth terminal after a physical-memory refusal and one
terminal exit: the Sway command succeeds, but the guest reports another
`Out of memory` and the terminal count stays five. The cause of that remaining
headroom/recovery failure is not established. The default remains 8192 pages
(512 MiB); no lower-budget acceptance or RSS improvement is claimed. The failed
run, screenshots and report remain retained with the resource evidence.

The desktop consumer now retains a bounded 512-event process history through
the normal host callback, including parent IDs and main-realm receipt times.
It adds no polling and grants no retirement authority. Normal build 151 serves
the same 86 image assets and byte-identical kernel/worker JavaScript as 131.
All six desktop functional/refusal checks pass, including comparison of the
copied terminal-parent events with the real process table. This diagnostic
change is not a correction for the intermittent readiness/input failures.

The complete browser-memory rerun 150 subsequently passes all 1,523 source
checks, three Node and seven Bun teardown checks, and all 18 browser cases
with zero skips or flaky outcomes. The normal command verifies the browser
report before printing its passing sentinel. Its cleanup removes 333 staging
files and also records an EACCES warning for a test-profile Documents directory;
that warning remains retained. Gate receipts and logs are under
`.context/desktop-current-acceptance-for-timing.json` and the retained evidence
directory. The kernel and canonical rootfs still match conformance run 145.

Diagnostic 152 passes one 120-cycle session, then reproduces a Sway IPC failure
after 83 completed cycles. Its eight-second sampling trigger misses the
three-second IPC deadline. Diagnostic 156 captures earlier: both 120-cycle
sessions pass, with one 1.48-second command delay sampled. That two-second
native sample mostly covers progress after the delay; it contains a single
`Atomics.waitAsync` sample and no blocking JavaScript `Atomics.wait` frame.
It establishes neither a notification-lock cause nor an engine defect. The
recorded 3.2 GiB WebContent footprint is unpaired and instrumented, not a
desktop memory comparison. These passes do not erase the earlier failures.

Canonical publication omits the standalone database benchmark images. The
post-gate artifact check 157 therefore refuses two missing browser fixtures.
Normal benchmark-only publication 158 restores both 32/64-bit images and
passes actual admission for all nine suites on both hosts, while leaving the
kernel and canonical rootfs identical. No foreign artifact is copied and no
suite is skipped. Timing collection waits for a separate workspace's CPU-heavy
job. Attempt 148b completes the baseline's nine Node suites, but a new tracked
build overlaps its last seconds. The overlap guard rejects the result; there
is no accepted paired dataset. Both the original report and failed campaign
receipt remain retained. Collection now requires complete, prespecified
alternating baseline/candidate pairs, rejecting an interrupted pair in full
and preserving completed clean pairs across quiet windows. Three independent
parent launches per arm and host remain required before aggregation.

### Fresh stock WebKit lifecycle result and remaining capacity question

Run 162 uses stock, silent headless Playwright WebKit 26.6 against normal
consumer 151. Both fresh sessions pass 120 terminal cycles, each including
real Foot launch, resize, workspace move, physical keyboard input, exact
Foot/shell process disappearance, final input, bounded output, memory-boundary
checks and Stop. The test retains the original cycle assertions and deadlines;
only run metadata and isolated output/configuration defaults change. There is
no native sampler, custom browser executable, tracing, source replacement or
extra observer RPC. Wall time is 8 minutes 43 seconds. A separate workspace's
compilation runs concurrently, so this is correctness evidence, not isolated
timing evidence. The earlier intermittent failures remain unresolved; this
passing pair does not establish their cause or a correction.

Kernel allocated capacity grows from 936 to 1,166 pages in the first session
and from 936 to 1,171 in the second (14.375 and 14.6875 MiB). The reported
storage metadata remains 101,580 bytes in both sessions. Wasm capacity cannot
shrink; these observations do not distinguish live allocations from allocator
capacity or fragmentation, and do not establish RSS growth. Stable long-session
kernel resource use is not yet established.

Ordinary control 164 completes 116 cycles, then fails its 30-second resize
observation deadline. The second resize command succeeds, but the following
`get_tree` request does not complete; there is no completed query or swaymsg
exit result after that resize. Kernel process/map/counter inspection still
responds, with empty diagnostics and memory-boundary failures. Its kernel
capacity grows from 1,538 to 1,859 pages (20.0625 MiB) at the failure snapshot.
This is a failed, partial control, not equal-length resource acceptance or
proof that the ordinary and grouped stalls have the same cause. No native
sample is collected: a live-job check finds the run already terminal and
refuses further process inspection. The original failure remains retained.
The observations show that increased kernel allocated capacity also occurs
with grouping disabled; live allocation ownership and the reason for that
capacity growth remain to be established. Partial snapshots are recorded in
`.context/desktop-lifecycle-capacity-comparison-166.json`, with the failed
control under `.context/desktop-ordinary-lifecycle-164/`.

The normal result receipt is
`.context/desktop-current-lifecycle-summary-162.json`, with original JSON and
screenshots in `.context/desktop-current-lifecycle-162/` and the terminal log
in `.context/desktop-json-evidence-124/desktop-current-lifecycle-162-PASS.log`.

### Current paired desktop resource and input measurements

Guarded run 165 passes all six resource and all six captured-glyph arms,
with no overlapping tracked build/test job during either phase. Each phase
uses three fresh Chromium 153.0.8010.12 parents per mode, in ordinary/grouped/
grouped/ordinary/ordinary/grouped order. Consumers 151/154 have the same
bounded output/event observers, byte-identical kernel and worker JavaScript,
and their own normally resolved images. These current measurements replace
the earlier pre-json-c sample for this app comparison; that sample is retained.

| Metric (sample median) | Ordinary | Grouped |
|---|---:|---:|
| Browser physical footprint, one terminal (MiB) | 1,903.0 | 2,009.1 |
| Browser physical footprint, two tiled terminals (MiB) | 2,015.1 | 2,145.7 |
| Browser physical footprint, separate workspaces (MiB) | 2,033.7 | 2,170.0 |
| Browser physical footprint, retiled (MiB) | 2,056.1 | 2,155.8 |
| Start to mapped terminal (ms) | 1,972.4 | 2,613.3 |
| Browser CPU for 15 physical inputs (seconds) | 1.224 | 1.009 |
| Enter to verified command output (ms) | 35.125 | 11.120 |
| Keydown to captured Foot glyph (ms) | 32.320 | 32.350 |

CPU ranges across the three parents are 1.152–1.304 seconds ordinary and
0.980–1.135 seconds grouped. Per-parent median Enter-to-output values are
36.080/33.945/33.200 ms ordinary and 11.120/10.950/12.060 ms grouped;
per-parent glyph medians are 32.300/32.320/32.330 and
32.390/32.310/32.430 ms. Each mode has 45 normal input and 45 normal glyph
observations nested within three independent browser launches, not 45
independent launches. No confidence interval or platform-wide claim follows.

Footprint is macOS's multi-PID, shared-region-adjusted browser-family total,
not summed RSS; its inspection is outside the CPU interval. Immediate
post-Stop totals are 1,158.6 and 1,338.1 MiB, not proof of physical reclamation
or steady post-teardown memory. Grouping uses more memory and starts more
slowly in this sample. Lower input CPU and earlier command output do not
establish faster presentation: glyph capture includes observer/readback costs
and is not physical input-to-photon latency.

All no-input negative controls and deliberate 50 ms dispatch-delay controls
pass. The final grouped glyph session takes about 110 seconds end to end,
versus about 12 seconds for the others. The fixture does not locate that
additional delay; short glyph intervals do not prove uniform overall session
responsiveness. The complete original result is retained without exclusion.

Summary and all sample ranges:
`.context/desktop-events-measurement-summary-159.json`. Raw results:
`.context/desktop-events-resources-159/` and
`.context/desktop-events-glyph-159/`. Both guarded phase receipts and terminal
logs are retained as `.context/desktop-json-evidence-124/desktop-current-*-165-PASS.*`.
All-nine-suite Node/browser comparisons remain a separate required gate.
