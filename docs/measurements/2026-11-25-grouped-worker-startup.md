# Grouped Worker startup consolidation, 2026-11-25

The baseline is `72e4005fed1ed815d0778b8dfcd2979752aa4793`, the `develop`
merge of #1756. The candidate runtime is `d459b95e8da628d0fb35ffb622a961689290f8bf`.
Both use program ABI 56, host adapter 40 and the read-only group scanner.
The [scanner receipt](2026-11-25-shared-memory-scanner.md) reports a different
comparison between earlier scalar and scanner implementations.

## Ownership reduction

Root, fork, exec and pthread launch now share one implementation of native
construction, readiness observation and memory delivery. The deferred handle
holds the actual Worker. One pending preparation binds its envelope to the
readiness observation and releases both on delivery or reference disposal.
This removes four adapter-local Worker references, duplicate startup and
cleanup branches, and one host validation and copy of the launch expectation
per Worker. The kernel effects, Worker messages and native observations remain
separate across the same lifetime boundaries. Delivery consumes the envelope
once and requires the started backing Worker.

The [preview contract](../shared-memory-groups.md#authority-and-admission)
maps the state owners. Fork must still copy private frames and commit the
saved continuation. A pthread shares the image and owns a distinct control
slot. Exec retains the old and future images around one PID. These facts
require different transactions even when all four use the same Worker
adapter. A later retirement change could investigate the session's duplicate
tracking of pthread retirement and the predecessor Worker list during exec.
It would need to preserve concurrent shutdown, pending effects and failed
retirement custody.

## Validation

- The declared development shell ran 111 native memory-group tests, the ABI
  snapshot and resolver checks, 1,432 host ownership checks across 60 files,
  seven browser memory message-boundary checks, the Rust-first host boundary
  audit, the host build and browser app typecheck.
- The normal kernel-only build published kernel SHA-256
  `ebd54419f573b2ea077964437d5ace3ee6bf0fcbe98106f8bf9a865dc15b79e8`
  and image module SHA-256
  `9eec9d694b6328d424751f122b65c9d7221b1b0d501a1026297f76acf7a012d3`.
  Against that projection, 30 Node root-launch and actual-kernel cases passed.
  Four more Node cases covered shared-file offsets and descriptor coherence,
  threaded exec, native-wait exit and forty cohorts retiring into one backing.
  Thirty-six public Node cases covered byte and VFS launch, executable
  identity, graphics mappings, admission and shutdown. Nine frozen executable
  cases passed against the manifest hashes.
- Forty-eight real SDK browser checks passed across Chromium, Firefox and
  WebKit. Each engine exercised eleven root rollback/shutdown cases,
  pthread fork, descriptor writes with shared-file offsets, threaded exec and
  native-wait exit including forty cohorts. WebKit desktop support remains
  experimental.
- Ten normal app cases passed on the partial shell, five each on Chromium
  and Firefox. They covered Sway input and file persistence, grouped Sway
  activation from an ordinary shell, Cage/Foot input and retirement, Freeciv
  quit and relaunch, and static ScummVM gameplay and native quit.
- Chromium and Firefox each passed twelve same-page Cage, Sway and Sway/SFWBar
  replacements with physical input, terminal creation and close, guest exit,
  and memory boundary assertions.
- The focused engine teardown selection passed three Node and seven Bun
  tests using fixtures linked and stamped through the normal SDK. The
  canonical browser-memory gate is still preparing its full package closure.
  Its full-gallery browser cycles, the dedicated 120-terminal soak and broad
  POSIX conformance are outside the completed validation scope.

## Matched Node ownership comparison

Both revisions used the same published kernel and image module. Each passed
24 public grouped root launches with child wait status and reaping assertions.
Each also passed the ordinary pthread comparison and recorded 256 grouped
pthread retirements with exact stop and retirement assertions. The final 128
samples had zero quarantined replicas and pending wait drains in both arms.

| Last 128 grouped pthread samples | Develop | Candidate |
| --- | ---: | ---: |
| Images | 1 | 1 |
| Replicas | 1–2 | 1 |
| Allocated pages | 162–168 | 158–162 |
| Physical extent pages | 170 | 164 |

These are copied kernel counters in one run per revision. They establish a
stable extent during this workload. Scheduling and concurrent retirements can
change the sampled page counts. The sample is a bounded ownership check, with
causal attribution and overall footprint outside its scope.

## Matched Chromium desktop response

Both worktrees used the same normal partial shell, kernel and lazy package
projection. The image SHA-256 was
`121a4c744a3dae121d0b992505adbf98106cbe2858a1aa5160a9ad031f07c872`.
The build selected Cage, Foot, Sway, Swaybg, SFWBar, Freeciv browser bundle,
static ScummVM, curl, unzip, sysklogd, desktop-data and Bibata. Its activities
were Shell, Freeciv, Cage, Sway and Sway/SFWBar. Static ScummVM launches from
the desktop shell.

Chromium 153 ran two blocks in develop–candidate–candidate–develop order,
using the normal Vite app at 1600×1000. Each run opened and closed six Foot
terminals and moved focus 30 times. Terminal timings end at an observed
rendered prompt. Focus timings use the trusted pointer event and an observed
canvas frame. Machine load varied across runs and the canonical product
build ran concurrently. The repeat used the same host code, after the
validation-only commit `a4eed3c56c8815767494d9a7e5d9706d72c77555`.
[Raw timings and counters](2026-11-25-grouped-worker-startup-samples.json).

| Measurement | First develop | First candidate | Repeat develop | Repeat candidate |
| --- | ---: | ---: | ---: | ---: |
| Terminal open median | 1,171 ms | 1,235 ms | 1,278 ms | 1,267 ms |
| Terminal close median | 241 ms | 249 ms | 253 ms | 250 ms |
| Terminal focus median | 79.69 ms | 82.24 ms | 82.18 ms | 82.21 ms |
| Terminal focus p95 | 119.31 ms | 119.38 ms | 147.58 ms | 130.69 ms |

The candidate's median open took 64 ms longer in the first block and 11 ms less
in the repeat. The median close also changed direction. These samples under
competing load leave the effect on startup latency unresolved.
Each run returned to 11 tasks and nine images after terminal churn, with zero
quarantined replicas and pending wait drains. Live page count returned to
within five pages of its starting count in every run. Physical extent grew
in both revisions while the pool retained reusable capacity.

## Removing the unused replica view

The initial consolidation deleted a net 54 lines from the four launch
adapters and added a net 63 in shared code. The follow-up runtime
`25701786e746` drops the kernel Worker's unused per-replica translated view,
its constructor's Wasm length check, and its detach paths. The registered
image view still serves kernel access, and the guest Worker reconstructs its
own view from the envelope. The session reads the PID and replica handle
from its exact Worker owner, and the pending pthread attachment drops a
write-only replica handle. The combined production TypeScript diff is
151 additions and 146 deletions against the pinned baseline.

With the same partial shell and kernel, a third four-run Chromium block
returned to 11 tasks and nine images with zero quarantined replicas or wait
drains in every run. Live page counts were within five pages of their
starting values. Open medians were 1,306 ms on develop and 1,117 ms on the
follow-up. Focus p95 was 118.11 ms and 115.72 ms, respectively. The single
block leaves the cause of the timing difference unresolved. The raw sample
file records the block separately from the two earlier measurements.

The follow-up passed 66 targeted Node cases, 36 browser SDK cases across
the three engines, the host boundary audit, and app typecheck. The ownership
suite passed 1,431 cases and timed out in the static scratch audit under
competing build load. The isolated audit passed in 208 seconds with its
original five-minute deadline. The longer partial-shell app and replacement
results above refer to the initial consolidation.

## Retirement follow-up

The retirement follow-up through `cc943b9eaef7` removes the session's exec
predecessor Worker list.
At the native join effect, the kernel adapter selects the exact group, PID and
generation from the existing Worker bindings. A detached binding has already
passed containment. On natural pthread exit, the kernel's logical notification
starts one retirement. The later Worker exit message adds no second session
request and the exact Worker stop observer still gates reclamation.

This removes one per-thread Promise map and the second pending-thread scan in
image transport detachment. Rust already waits for started thread retirement
before issuing that detachment. Later thread requests join the exact image
retirement. The remaining host receipt lookup joins the actual in-flight effect
Rust selects. The session's TID map still serves exit routing and host-import
sender checks. The continuation still yields before trying its next immediate
kernel entry. An intermediate change skipped that yield for settled launches,
which could force a later timer retry from the detached phase. The final
production TypeScript diff fell by 23 lines in this pass, to 18 fewer lines
than the pinned develop revision. It adds no kernel entries or wire fields.

The initial Node SDK/public selection passed 37 cases, including threaded exec,
rollback, forced exit and native waits. The final runtime passed 33 focused
Node cases covering threaded exec, root launch/cancellation, kernel boundaries
and native waits. Both pinned Node arms passed 24 public root launches and
reaps and the ordinary and grouped 256-pthread workloads. Both grouped arms
held physical extent at 170 pages in the final 128 samples, with no wait drains
or quarantined replicas. After retirement each had one allocated backing page,
zero images and zero native observers.

Chromium, Firefox and WebKit each passed threaded exec, native-wait exit and
40 native-wait cohorts. Chromium and WebKit also passed 256-pthread churn.
The first Firefox candidate churn run finished all 256 retirements and returned
to one allocated page, but failed the fixed-extent assertion because the last
128 samples contained 164 and 170 pages. In order, the four Firefox reruns
passed at 164 (develop), 170 (candidate), 164 (candidate) and 164 (develop)
pages for that window. All five Firefox runs finished without retained waits,
quarantined replicas or live images. The source of the first late increase
remains unresolved. After restoring the detached-effect yield, all 12 SDK
browser cases passed, including pthread churn and native waits on all three
engines with the same extent assertion.

The final Chromium comparison used the same pinned kernel and partial shell
as the earlier blocks. Each run returned to 11 live tasks and nine images,
with zero quarantined replicas or wait drains. Allocated pages rose from 1,755
to 1,760 in all four runs. Each arm contributed 12 terminal opens and closes
and 60 pointer-focus samples. The calculation uses the median and the
nearest-rank p95.

| Chromium, milliseconds | Pinned develop | Final runtime |
| --- | ---: | ---: |
| Terminal open, median | 1,509.55 | 1,399.06 |
| Terminal close, median | 309.36 | 297.08 |
| Pointer-to-focus frame, p95 | 115.69 | 131.68 |

Machine load varied while other builds and tests ran. The timing effect of
the patch remains unresolved. The raw sample file separately retains the
intermediate comparison that omitted the yield.

The retirement follow-up's parity run exposed a source assertion that still
expected separate inline exec callbacks on pinned develop. It now verifies
that both callbacks receive the opaque request through the actual shared
entry and that the ordinary and grouped adapters take the same request. All
12 parity checks passed the rerun.

The final host build and 1,432-case source ownership suite passed. The
focused ordinary teardown regressions passed three cases on Node and seven
on Bun. The browser app passed typecheck and its seven source memory-boundary
cases. The native run passed 111 memory-group and nine exec-controller tests.
The ABI snapshot matches program ABI 56 and host adapter 40 on the pinned
develop base.

The final runtime passed all ten normal partial-shell app checks across
Chromium and Firefox. They cover Sway input and ordinary file persistence,
shell-to-Sway activation, Cage with Foot, Freeciv quit and relaunch, and
ScummVM gameplay and native quit. Firefox's test-runner temporary-directory
cleanup reported `EACCES` after passing the guest assertions. Full-gallery
browser-memory validation of this runtime is queued behind the existing
canonical source build.

Chromium passed the final runtime's twelve same-page Cage, Sway and Sway/SFWBar
replacements. The first Firefox run completed eight replacements before the
ninth Sway/SFWBar boot timed out waiting for its first Foot process. Its
screenshots show SFWBar and wallpaper downloads in progress at the deadline
and the lazy Foot download at 40% afterward. The retained evidence includes
the process snapshot, syslog and screenshots. The failure precedes that
cycle's retirement checks. Matched Firefox reruns on pinned develop and the
final runtime both completed all twelve replacements and exact guest-retirement
assertions. They used the same partial shell and kernel in separate browser
sessions. The first boot timeout remains in the evidence.

Normal retirement uses Rust's `DETACH_REFERENCES` effect for the exact
receipt, removing one `BEGIN_REFERENCES` kernel round trip per normally
retired Worker. An independent launch rollback still requests authorization.
Both paths join one pending disposer. An authorization refusal releases the
host attempt so an already-issued effect can proceed. Disposer and
acknowledgement failures stay with the exact Worker. Rust still requires the
`REFERENCES_DETACHED` acknowledgement before releasing physical storage.
The fork and pthread launch controllers issue their rollback actions before
the storage owner enters detachment. The fork rollback can still require a
separate containment acknowledgement at that point. Reusing the fast path
there would require changing where those controllers hand off custody.

The issued-detachment follow-up (`b24f481b9a`) passed 108 focused Node cases
against the published kernel. Three new cases check that normal retirement
skips the begin call, with single disposal and exact acknowledgement even
when rollback overlaps or acknowledgement must wait for the kernel gate.
They also cover a refused rollback racing kernel authorization and a failing
disposer retaining its exact backing. The host build and three Rust-first
host-boundary checks passed. The ABI 56/40 snapshot check passed against
pinned develop. Kernel, SDK and ABI sources are identical to that baseline.

Both Node arms passed 24 grouped roots with child wait and reaping, and 256
ordinary and 256 grouped pthread cycles. Over the last 128 grouped cycles
both recorded one live image, one to two replicas, 162–168 allocated pages,
a fixed 170-page extent and zero quarantined replicas or pending wait drains.
Both ended with one allocated control page and zero images, replicas and
native observers.

Chromium, Firefox and WebKit passed real SDK pthread-launch rollback,
threaded exec and standalone native-wait exit. Chromium and WebKit also
passed the forty-cohort native-wait workload. The first Firefox cohort run
passed the exact retirement assertions and failed the final fixed-extent
assertion as the backing grew from 500 to 501 pages. Four matched Firefox
reruns in develop–candidate–candidate–develop order passed the unchanged
assertion. The original result is retained. The full-gallery browser-memory
gate for this follow-up awaits canonical source provisioning.

## Focus latency follow-up

The original Chromium focus metric starts at the trusted pointer event and
ends at the video frame callback timestamp when a sample has the new border
color. It includes browser input delivery, guest focus and rendering, scanout
and video observation. The final historical block's medians were 82.18 ms on
develop and 82.05 ms on the candidate. Its p95 was the fourth-slowest of 60
observations per arm. Three of the four slowest candidate observations came
from the same run.

Across the five recorded blocks, 56 of the 57 observations above 100 ms
occurred on move one or moves 15–20. An exploratory calculation on the final
block omitting those positions gave p95s of 83.26 ms and 83.00 ms. The original
p95s of 115.69 ms and 131.68 ms still describe the complete block. The recurring
positions identify where the tail lies. Its cause remains unresolved.

Two follow-up video diagnostics timed out on the focus-color assertion on both
revisions. Screenshots showed the correct blue border. A diagnostic comparing
the frame bytes with RGBA readbacks from the current video and canvas directly
confirmed BGRA frames. The raw focused pixel was `[119, 85, 40, 255]`, and both
RGBA readbacks gave `[40, 85, 119, 255]`. The raw benchmark predicate assumes
RGBA ordering, so it rejected those frames. The format-aware trial recognized
all eight candidate transitions. The original passing runs did not record
pixel formats, so the format issue explains the diagnostic failures and leaves
the historical tail difference unattributed.

A four-run direct-canvas diagnostic used pinned develop and `fd88906d1d`, the
same kernel and partial shell and two already-running Foot windows. Each run
verified its trusted pointer events, warmed up in both directions and timed 45
focus changes without terminal churn. The 90-move medians were 79.71 ms on
develop and 79.05 ms on the candidate. The respective p95s were 179.77 ms and
164.19 ms. Machine load ranged from 54 to 77 at the start of these runs on an
18-CPU host. Both arms had nine moves of at least 130 ms. For those moves the
page listener was reached within 15 ms of the event timestamp. The remaining
interval covers kernel delivery, guest work, scanout and canvas observation.
The next attribution point is the kernel's evdev ingress and Sway's DRM flip
for the same pointer event.

The four format-corrected video runs used the same two-window workload and
also completed all 45 measured moves per run. Each sampled video frame was
BGRA and the predicate used a normalized RGBA readback. The video medians were
79.18 ms on develop and 79.62 ms on the candidate. Their p95s were 179.04 ms
and 184.62 ms. Starting load ranged from 81 to 127. The direct-canvas and
normalized-video results are separate diagnostics under different loads.
They agree on typical latency and give different directions for the tail
difference.

The next four Chromium runs traced 45 moves each in ABBA order, using
`b24f481b9a` and the same kernel and partial Sway/Foot shell. Scratch
instrumentation recorded the absolute pointer batch entering evdev, the
first DRM submission after that batch, the next flip latch, scanout and the
first observed canvas sample with the expected border color. Each context's
monotonic timestamps were aligned with `performance.timeOrigin`, and a
Worker timestamp was checked against bracketing page timestamps.
The event-to-canvas medians were 80.03 ms on develop and 80.21 ms on the
candidate. The respective p95s were 180.09 ms and 179.68 ms. Starting
one-minute load ranged from 55 to 71 on an 18-CPU host.

The slow samples took separate paths. One 180 ms candidate move spent
108 ms before evdev ingress, with the page listener reached in 13 ms.
Another 191 ms candidate move reached evdev in 7 ms and waited 160 ms
for the first DRM submission. In that interval scanout had a 123 ms gap.
The slowest develop move took 214 ms, including 155 ms between evdev and
the first submission and a 116 ms scanout gap. Flip-latch and scanout
timestamps identify activity during the interval. Multiple flips can occur
before the expected color, so the first flip cannot be assigned to the
focus change from these marks.

A second ABBA block added the page's message post, the Worker message
handler and the vblank scheduler callback. The 180 moves had medians of
80.40 ms and 80.43 ms, and p95s of 194.06 ms and 177.88 ms. Starting
one-minute load ranged from 35 to 44. Of 21 moves at or above 130 ms, nine
waited at least 50 ms between post and handler, reaching about 90 ms on
both revisions. No vblank callbacks were recorded during those nine waits.
Eleven had at least 80 ms from evdev to first DRM submission and also had
an interval of at least 80 ms between vblank callbacks. The remaining move
submitted at 41 ms and latched at 146 ms, after a 115 ms callback gap.
Posting took at most 15 ms from the input timestamp, and the message
handler reached evdev within 0.03 ms on every move. Once the vblank callback
ran, its kernel entry began within 0.06 ms. The trace leaves Worker
scheduling, queued work and frame delivery as the next profiling targets.

A third ABBA block on the same runtime performed six Foot open/close
cycles before the 45 traced moves in each run. All four returned to their
starting live image and task counts, with zero quarantined replicas and
pending wait drains. Across 12 cycles per arm, the median terminal open
was 1,735 ms on develop and 1,736 ms on the candidate. The respective
median closes were 290 ms and 285 ms. Focus medians were 80.56 ms and
80.76 ms, with p95s of 179.08 ms and 180.20 ms. Starting one-minute load
was 20–25. Both revisions again saw delayed message handling and gaps in
vblank callbacks. This lighter-load comparison exercised the changed
retirement path and reproduced a similar focus tail on both revisions.
It still used direct canvas sampling, so the original video-observed
16 ms p95 difference remains unattributed.
[Raw focus diagnostic timings](2026-11-25-grouped-worker-startup-samples.json).

## Retained failures

The first partial build refused a changed package registry snapshot. A retry
passed publication of the index. The first Node and browser SDK runs started
before the source-only projection was finalized and hit missing authority.
The broad Node attempt also hit its fixture-build timeout under competing load.
The later targeted runs used the separate normally published kernel projection.
A first scratch desktop benchmark started Vite in the scratch directory and
failed navigation in every arm. Setting the app working directory let all
four arms complete.
A Firefox test-runner cleanup reported an operating-system permission error
removing its temporary Library directory after passing the browser assertions.
The follow-up initially exposed three fixture assertions that used the
deleted view or a zeroed publication reply. The focused rerun passed after
asserting against the registered image view and supplying a valid reply for
the stale-publication check.
A native test attempt used the default Wasm target. The native-target retry
required missing frozen fixtures, which were provisioned and compared with the
pinned digests. Wasmtime smoke stopped at the existing three-argument native
`host_proc_validate_range` binding. The pinned kernel requires four arguments,
and the corresponding kernel and native host sources are identical on both
revisions.
The first issued-detachment test fixture leaked a spy through the frozen gate
object. Replacing it with a real queued kernel entry made the targeted suite
pass. A shared Nix input fetch lock stalled repeat invocations of the
developer shell. The focused reruns used the exact environment exported from
the worktree's recorded Nix profile.
The follow-up's source-only host audit passed 1,431 cases and exceeded the
five-minute watchdog on the repository-wide TypeScript ownership scan.
The unchanged scan passed in 262 seconds on an isolated rerun.
The first scheduler trace tried to instrument Vite's Worker URL wrapper.
Skipping that wrapper left the marker on the actual Worker source, and all
four runs completed.
