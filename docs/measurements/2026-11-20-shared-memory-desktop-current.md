# Shared-memory desktop: current validation and resource cost

This record retains successive desktop integration checkpoints, including the
grouped-root lifecycle correction, `c9178e6526` runtime, browser import correction
`4bd526d429` and owned-image consumer `a9e54e9ec2`. The latest normal-app checkpoint
is below; later checks do not erase earlier failures. It supersedes the summary in the
[November 19 investigation](2026-11-19-shared-memory-desktop-integration.md),
which retains earlier measurements and failed experiments. The batch remains a
draft targeting `develop`; neither the original PR1–PR9 plan nor merge
acceptance is complete.

## Normal app and admission policy

The normal opt-in app now prepares its Sway/Foot image through the SDK, package
resolver and image writer, including compatible shell, login and syslog
participants. `./run.sh browser --partial --trusted-desktop-preview` uses the
server's root URL. The validated partial shell contains Sway, Swaybg, Foot,
Wayland desktop data, the Bibata cursor theme and sysklogd. Ordinary app builds
keep their existing backend. The canonical production build remains pending;
the serial retry has completed Rust, guest Clang and CMake and is preparing the
remaining packages. This producer uses the earlier integration source; the
latest runtime still needs its own complete product and memory-gate check.

An explicit 24-process/64-task developer fixture reproduces the user's refusal
at nine terminals: 23 live non-init processes, about 25 tasks and 299 MiB of
shared backing capacity. Sway's transient command/launch processes exhaust the
process allowance before the 512 MiB backing ceiling. Closing and reopening a
terminal restores capacity. These numbers describe that fixture, not every
normal app login tree or resident memory.

The normal trusted app now supplies only its existing 512 MiB backing budget.
Process and task quotas are optional embedder choices; omitted counts use the
protocol's u32 ceiling without preallocation. Explicit quotas remain enforced,
and kernel metadata, backing allocation and host Workers remain finite.
This removes a small configured desktop ceiling without promising unlimited
resources. See [the option contract](../shared-memory-groups.md#desktop-first-opt-in).

| Current bounded validation | Result |
|---|---|
| Normal app: clock/input/workspaces/tiling, exit and CPU-renderer restart | Passed on Chromium, Firefox and WebKit |
| Normal app: twelve actual Foots and shell children, physical close and new-PID reopen | Passed on all three engines; initialized process-table cleanup rerun also passes below |
| Public SDK: 26 simultaneously live children followed by 66 simultaneously live pthreads, 512 MiB backing | Passed on Node and all three browser engines |
| Full Node SDK selection, including copied usage inspection | 63 passed, no skips |
| Public browser VFS launch/identity/refusal/DRM/inspection selection | 18 passed, no skips |
| Browser SDK and exact retirement selection | 105 passed, no skips |
| Host build/declarations, browser types and ABI check against develop | Passed |
| Source memory/ownership selection plus inspection and entry-context audit | 1,601 passed across 61 files, no skips |

The optional Node/browser `getMemoryGroupUsage()` diagnostic returns copied
kernel admission and backing counters without creating a group or exposing
guest memory. A real SDK-built C program maps the same two-page object twice;
both hosts count two unique shared pages and observe complete task/image/object
retirement. Known scalar fields are selected before leaving the kernel Worker
and validated again at the SDK proxy. The contention regressions hold the real
allocator lock, require an immediate `EAGAIN`, keep kernel admission readable
and recover the same counters after unlock. No automatic polling is added.
See [the diagnostic contract and units](../shared-memory-groups.md#desktop-first-opt-in).

The live-child SDK probe first failed in both grouped Node launch modes at its
128 MiB fixture budget with `ENOMEM`; ordinary execution passed. A controlled
128/512 MiB pair reproduced the refusal and then completed the same C program
at 512 MiB. The maintained admission case now matches that preview budget.
The failed run is retained, and does not count as a passing 128 MiB workload.
The ordinary private-file fixture now checks develop's explicit `EFAULT` on
unsupported growth and verifies that its original mapping survives; the grouped
arm still requires successful growth against the retained original file.

The earlier ordinary Node Open POSIX run completed 174 passes, three expected
failures and two standard skips, with no failures or timeouts. Its libc run
completed 305 passes, 17 expected failures, one listed flaky pass and a
`raise-race` timeout at the unchanged 30-second limit. Isolating that case timed
out again. A fresh develop baseline passed the same case, followed by a fixed
develop/candidate/candidate/develop comparison passing all four runs. These
mixed results remain retained.

A fresh full ordinary Node run on runtime `6ba046c7f9` now passes the unchanged
default inventories: Open POSIX 174 passes, three expected failures and two
standard skips; libc 306 passes, 17 expected failures and one listed flaky pass,
with zero failures or timeouts and `raise-race` passing. The normal SDK/kernel,
runner and source guards are unchanged. This is current ordinary Node evidence,
not grouped-all-libc or browser conformance. The passing rerun does not erase
the earlier timeouts; its complete evidence is retained under
`.context/shared-desktop-conformance-603/`.

An initial normal-app lifecycle probe stopped after eleven completed iterations
on an empty cached file preview. A fresh-read control then passed 30 Firefox
iterations; this does not establish the earlier failure's cause. The subsequent
1,200-cycle-per-engine normal-app run fails all three engines:

| Engine | Completed cycles | Failure |
|---|---:|---|
| Chromium | 1,108 | One recorded DOM Alt+Enter sequence is followed by two new Foots/shells; exact count requires one new pair |
| Firefox | 495 | The same extra-Foot/shell count failure |
| WebKit | 32 | Thirty fresh reads of the expected shell proof file remain empty |

Chromium's Enter down/up interval is about 1.25 ms and Firefox's 9.34 ms,
with `repeat=false`. Actual kernel delivery and compositor repeat timing were
not measured in that run. Page errors and memory-boundary violations are empty
on all three engines. The extra-terminal failures remain unresolved.

A separate SDK-built evdev observer records kernel-injection timestamps and its
own read timestamps through an independent open file description. It runs in a
derived diagnostic image through the normal app, leaving Sway's input stream
intact. Fixed-size ring parsing rejects stale, overwritten and incomplete data;
short ordinary/grouped controls pass. A fixed WebKit comparison then fails the
grouped arm after 35 completed cycles while the ordinary arm completes 120.
The grouped screenshot shows `e` in the original terminal and `cho ...` followed
by `command not found` in the new terminal. DOM and evdev records contain the
full intended command without repeat or dropped-event markers. This identifies
a test-readiness gap: process existence does not establish compositor focus and
visible shell readiness. It does not prove Sway's event-read timing, explain the
extra-terminal failures or establish a browser-engine defect.

A subsequent fixture waits for the focused new terminal's actually rendered
Bash prompt before typing. Pixel controls refuse a blank area, an inactive
window and changed glyphs. Ten physical open/type/PID-file/close cycles pass on
each WebKit arm, with no page or memory-boundary errors. The unchanged count,
file-content and close oracles remain; earlier failures are retained. A new
normal bare-root WebKit sustained run is in progress without the evdev observer
or derived diagnostic image. Short controls are not sustained acceptance.

A subsequent audit found that a final zero-Foot process check could accept a
transient empty Inspector table while loading. Nonzero-count failures are
unaffected. The corrected maintained capacity check requires init PID 1 in
the same snapshot: twelve actual Foots/shells, physical close and new-PID
reopen, guest Sway exit and initialized zero-Foot/shell cleanup now pass on
all three engines (run 644). This is bounded terminal cleanup, not proof of
whole-machine backing reclamation.

The maintained Cage suite passes six cases across Chromium, Firefox and
WebKit (run 643). It proves physical exact-shell-PID output, initialized
Cage/Foot/shell exit and KMS owner zero, plus Freeciv menu Quit, new-PID
relaunch, actual server child, rendered lobby/world, stable no-input controls,
physical end-turn input, native Options/Quit and both client/server retirement,
then restored Foot input and graphical exit. Strict TypeScript checks pass.
Retain the earlier config initialization failure (639) and Chromium shortcut
Quit failure (641); the latter's cause is unproven. The final fixture opens
and observes the native Options dialog before requesting Quit.

The two-hour grouped sustained runs 584 and 596 timed out. Host power logs
record clamshell sleep at 21:58:56 and wake at 22:00:27 near their last progress
checkpoints. This is correlation, not a proven cause or browser defect.
The WebKit failure screenshot shows the entire page white. Its final page
evaluation failed after context closure, losing the final JSON. The grouped
584 observer file contains only an initial, uncommitted snapshot; its automatic
attachments were overwritten by the ordinary arm's shared output directory.
Retained raw reports and checkpoints do not establish failure event timing.
No sustained acceptance follows from these interrupted runs. Further runs
need distinct output directories, phase/error persistence before page awaits
and a recorded host sleep window.

The current full `./run.sh test browser-memory` attempt (634, head 64652cc29e)
failed in normal product preparation before runtime checks: the fresh
worktree's declared Rust libc submodule was uninitialized. It is now initialized
to the tracked commit, but a full successful retry is still required. This is
provisioning repair, not a waived memory gate.

The normal-app captured-glyph latency method now passes on both ordinary and
grouped Chromium: actual `a`/`b` glyph calibration, three no-input captures,
fifteen trusted key trials and a deliberately delayed 50 ms positive control.
Its initial setup failure is retained. With a rendered-prompt check and a
retained pre-Enter screenshot, both arms now reach capture; no runtime change
was made. Captures include canvas readback and
measure browser keydown to observed glyph, not physical input-to-photon, native
presentation or GPU frame time. These pilots ran under concurrent builds and
stress tests and are not an accepted performance comparison.

The full combined browser-memory gate, canonical build, sustained lifecycle and
matched memory/CPU/input/presentation measurements remain required. Earlier
Firefox/WebKit input and IPC failures remain retained. The full memory gate was
interrupted during duplicate guest Clang preparation, before runtime phases;
it must run after the retained canonical producer publishes its artifacts.

Raw sources, failed and passing reports, screenshots and provenance are retained
under `.context/shared-desktop-followup-545/`,
`.context/shared-desktop-inspection-561/`, `.context/shared-desktop-input-572/`,
`.context/shared-desktop-input-578/`, `.context/shared-desktop-input-588/` and
`.context/shared-desktop-readiness-592/`. No runtime source was rewritten for
these checks. The evdev observer's initial blocking-read failure is retained;
its normal nonblocking poll/read consumer does not resolve the documented
blocking evdev-read gap.


### Exploratory normal-app resource pilot

A single fresh-browser ordinary/grouped Chromium pair validates the collection
path at develop `d2ff5af69e` and runtime `6ba046c7f9`. It ran under concurrent
builds and sustained tests, with load averages around 15–20. These are raw
pilot observations, not a fair acceptance comparison or evidence of a memory
benefit. Each phase uses macOS's shared-region-adjusted footprint total for the
owned browser family, including GPU and utility processes; every PID/identity
and report-schema guard passes. No forced GC, syscall tracing or CPU sampling
runs in the workload. The six-package partial and ordinary/grouped normal app
paths above are used without an observer program or runtime source rewriting.

| Observed phase | Ordinary MiB | Grouped MiB |
|---|---:|---:|
| One visible terminal | 2,378.0 | 2,517.2 |
| Two tiled terminals | 2,473.7 | 2,684.7 |
| Two terminals on separate workspaces | 2,514.7 | 2,683.5 |
| Two terminals retiled | 2,496.6 | 2,682.6 |
| After guest Sway exit, login machine still live | 2,158.4 | 2,405.4 |

Fifteen physical shell commands, each followed by a fresh Inspector proof-file
read, consume 17.776/18.533 browser-family CPU seconds over 14.158/14.132 elapsed
seconds respectively. CPU inventories remain stable, and page/memory-boundary
errors are empty. This measures the normal app workflow, including Inspector;
it is neither a kernel-only microbenchmark nor input/presentation latency.
Guest exit does not destroy the machine: the final row cannot prove backing
reclamation. Independent HTTP receipts record observed same-origin asset URLs;
they are not hashes of the browser-consumed response bodies. The initial
collection-hook failure is retained alongside the passing pilot.

The higher observed grouped footprint remains a material cost to investigate.
The pool clears allocated pages and grouped forks copy all private pages. An
isolated disposable-Worker Node screen separates allocation from verification:
reading every word can itself make fresh shared pages resident. In its 128 MiB
case, an untouched allocation uses about 27 MiB before verification and 155 MiB
after; clearing or scanning it uses about 155 MiB beforehand. Sparse copy uses
about 160 MiB before verification against 283 MiB for dense copy, with a CPU
tradeoff. These private-memory operations establish neither application savings
nor the cause of this desktop pilot's difference. No allocator/fork change has
been made on that evidence. Fair alternating desktop measurements and complete
cross-host validation remain required. Raw evidence and source are retained in
`.context/shared-desktop-readiness-592/` and
`.context/shared-desktop-allocation-601/`.

## Bitmap handoff correction

The user's screen recording confirms visible scene blanking at 1280×720 while
the page controls and cursor remain visible. Control 425 reproduces 91 black
captures out of 100 on the published preview, with the machine still ready and
no reported errors. This is a user-visible presentation failure, not visual
acceptance merely because a later screenshot is nonblack.

The relay consumed the producer canvas with `transferToImageBitmap`, while the
renderer retained/cached that canvas and could present it again without a full
redraw. The correction snapshots it with `createImageBitmap`, preserving those
producer pixels. The unchanged single-bundle acknowledgement and retirement
fences still bound transport ownership. This is a Kandelo ownership correction;
no external runtime defect is claimed.

Matched 427 uses a clean export of batch head `2b94115f30` and changes only that
capture policy. Both arms pin all 353 artifact routes, including kernel and
image, to identical bytes. The local VFS-launch/startup candidate is excluded.
The reproduction changes viewport height, scroll position and pointer position
at device scale factor two, and examines all 100 consecutive captures rather
than waiting only for eventual recovery.

| Black captures / 100, same workload | Consuming capture | Snapshot capture |
|---|---:|---:|
| Chromium 153.0.8010.12 | 91 | 0 |
| Brave 157.0.8103.79 | 92 | 0 |

Repeat 429 passes another 100 captures each on Chromium, Brave, Firefox and
WebKit: 400 captures, zero black, with no reported errors. The new producer-pixel
regression fails on the old code (its second frame is black), then all 22 bitmap
ownership/retirement unit cases pass with the correction. These are bounded
presentation checks, not memory/performance or full preview acceptance.

The snapshot retains the producer surface. Resource comparison 438 uses three
fresh Chromium parents per arm in order old/new/new/old/old/new, the same
1920×1080 desktop, 15 physical shell commands, complete process CPU accounting,
OS physical-footprint samples and strict Stop checks. All six pass, with no
tracked compute overlap or host sleep during measurement. The old arm remains
visibly faulty; these numbers measure the capture replacement's resource cost.

| Median across three parents, Chromium 153 | Consuming capture | Snapshot capture |
|---|---:|---:|
| Two terminals retiled, owned-browser footprint | 2057.5 MiB | 2051.0 MiB |
| Footprint after Stop | 1206.6 MiB | 1308.1 MiB |
| CPU seconds for 15 commands | 0.951 | 0.947 |
| Trusted Enter to verified file output, median of parent medians | 11.445 ms | 12.155 ms |

The stopped median is 101.5 MiB higher; the samples are variable and do not
identify the retained allocation or prove a leak. This material cost remains
open. Active footprint and CPU medians do not establish a saving. Input timing
ends at verified guest file output, not presentation. Sustained lifecycle,
captured-pixel latency and the full browser-memory gate remain pending for the
fix. Raw samples, process inventories, overlap and sleep audits are retained in
`.context/desktop-bitmap-resources-438` and included in the portable JSON.

The original 3K desktop, restart, cancellation and negative-control cases plus
the new sustained DPR2 presentation test pass across all three engines: 15
tests in run 433. The old 3K failures and failed
experiments remain retained; this does not retroactively clear them. An isolated
local test bundle contains this fix while the new VFS/startup changes remain
uncommitted. Raw comparison, screenshots and receipts are retained in
`.context/desktop-bitmap-handoff-427`; the user recording and sampled frames
are retained separately in `.context/desktop-flicker-user-423`.

## Supported preview

Trusted compatible programs opt into the existing kernel-owned group through
`experimentalMemoryGroup`. Normal SDK version 3/layout 3 artifacts supply
Sway, Swaybar, Swaybg, Swaymsg, Foot, Bash and Coreutils; historical “format4”
is a prototype label. The developer consumer uses byte launch from its actual
VFS, a 512 MiB group budget, 24 processes and 64 tasks. The normal opt-in app
also supports initial `spawnFromVfs` through its image-owned login path, with
the admission policy described above. Both previews are temporary and in memory.
Ordinary execution remains the default in ordinary app builds.

PHP-FPM is unchanged. Persistent writable sharing, mixed graphical clients,
PostgreSQL and Apache remain follow-ons. Shared objects are whole, fixed-size
and offset zero; mutable/offset mappings and fragmented graphics unmapping
are not completed by this preview. Compose/dead-key input remains unavailable.

## Current grouped-root lifecycle correction

Grouped launches previously left exited host-root records in Rust after their
execution images had retired. Ordinary launches already called the existing
host-root reaper; the grouped owner omitted it. A four-root control finds
ordinary records absent and grouped records in zombie state with parent zero.
The live-process API hides these records and therefore cannot prove removal.

The shared Node/browser owner now calls that existing reaper after exact
retirement and before publishing exit. Rust atomically checks exited state
and host-parent ownership. Guest-owned children retain their wait status.
Destroy owns any deferred final publication after the execution image leaves
the live map. No ABI, kernel, guest program, memory limit or PHP-FPM change is
needed for this correction.

The original unmodified desktop run 320 fails after 819 completed cycles,
with I/O admission peaking at 132,119,822 credits against a 132,120,576 limit.
Namespace admission remains flat and no shared-mapping failure is reported.
A separate 2,000-launch Swaymsg control reproduces accumulating I/O credits
without a compositor, socket, PTY or graphics device. Diagnostic Sway run
315c also fails at 819 cycles but emits no allocator-wrapper diagnostic; it
does not establish a libdrm allocation failure. These failed runs are retained.

The corrected candidate passes:

- Nineteen Node checks, including normal child waits, repeated public grouped
  roots and destroy during a deferred reap. The C fork fixture verifies its
  child's exact exit status of 23.
- Two thousand normal compatible Swaymsg byte launches. Every actual stdout
  PID has no remaining `/proc/PID/stat` record. Post-warmup I/O admission is
  exactly 8,944 credits at every checkpoint.
- The normal full canonical browser build, its SDK-prepared full-shell image
  and all six untraced 3K browser cases across Chromium, Firefox and WebKit.
  These include black-desktop negative controls, real terminal input, workspace
  moves, actual root-record removal and Stop. The image has 353 asset routes;
  its seven ordinary/prepared executable hash pairs match the prior canonical
  image. Its container is 7,924,676 bytes, SHA-256
  `3a45708f179e5715cc73ffe51d4b6e40717d09afb68813bd3f7b94801e17da39`.
- All 1,200 original 3072×1728 terminal lifecycle cycles in one Chromium
  machine, at the unchanged 512 MiB group limit and 30-second operation
  deadlines. Every cycle opens Foot, moves it, verifies physically typed shell
  output against the filesystem, closes it and checks removal. All 14,419
  completed host roots checked are absent. Final input, composition, Stop,
  diagnostics and memory-boundary assertions pass without reload or forced GC.
- The ABI check: existing program digest unchanged, version and snapshot
  consistent.

| Extended corrected run | Initial | Final / observed tail |
|---|---:|---:|
| Kernel linear-memory extent, pages | 1,575 | 1,605 |
| I/O admission, credits | 2,381,630 | 2,381,548; checkpoints 200–1,200 range 2,381,436–2,386,370 |
| Completed terminal cycles | 0 | 1,200 |
| Completed host roots checked absent | 0 | 14,419 |

Kernel extent grows by 30 pages, about 1.9 MiB. Unique proof files remain in
the workload. Admission credits and linear-memory extent are not whole-browser
physical footprint. Concurrent canonical preparation and memory validation
also make this a functional/resource-accounting run, not a CPU or latency
comparison or a total-browser plateau proof.

Runs 323d/324c/327/328/329/330/334/335 retain the source patch, normal build
receipts, image provenance, full results and screenshots under workspace
`.context/desktop-root-reap-*`. The fix is validated from `369e61cb9b` plus the
recorded patch; the batch imports those four runtime/test/registry files byte
for byte. Fresh full browser-memory run 331 passes: 1,544 source checks in
59 files, three Node and seven Bun teardown checks, and all 18 browser cases
with no browser skips, flakes or unexpected failures. Each engine completes
four constrained-budget machine/audio switching cycles in one persistent
page. Cleanup reports EACCES on its owned Firefox Downloads directory;
successful removal of that path is not claimed.

The Bun/JavaScriptCore phase also logs ten ordinary `thread process exit`
shutdown fallbacks through the `NodeKernelHost` API: the guest exit checks pass,
but their cleanup times out and terminates the kernel realm. Node/V8 logs no
such warning in this run. This existing result does not prove graceful
retirement for that ordinary Bun pthread case. The constrained browser phase
separately rejects forced teardown; its eighteen passes must not be read as
clearing the Bun warnings.

Grouped companion 338 also passes four canonical desktop boot/input/workspace/
Stop cycles per engine in one persistent document. Actual completed host roots
are absent each cycle. Its distinct module URLs retain module-cache code and
disposed debug hosts, so this is functional/retirement coverage rather than
normal full-app navigation or a whole-browser memory plateau proof.

The subsequent restart consumer uses actual Start → Stop → Start controls in
the same loaded entry. Stop cancels a pending fetch, awaits the session's
operations and machine destruction, releases its closed host reference, and
enables a fresh machine. Run 343b passes all twelve browser cases; the committed
lifecycle regression's six cases also pass on Chromium, Firefox and WebKit in
346. Each engine completes four real boots with typed file output, workspace
moves, root-record removal and fresh filesystems, plus cancellation while image
loading is held followed by a successful restart. No module reimports, reloads
or forced GC are used. The normal full canonical build 345 passes using the
consumer's own SDK, resolver and rebuilt native helper. These results do not
establish an OS memory plateau or a net memory saving. The initial 343 run was
interrupted after its cleanup fixture
clicked an already disabled Stop button; that failed run is retained separately.

Capacity/recovery probe 377 sends twenty actual New terminal button requests
per engine against the unchanged published consumer. Each engine reaches the
existing process limit, with 25 observable processes including synthetic init.
Admission EAGAIN, guest fork refusal and unsuccessful Sway commands remain
visible in the retained output. All three bounded cases keep Sway alive and
complete Stop → Start followed by verified typed file output. The earlier fatal
fork-rollback error does not reproduce. These are capacity/recovery passes,
not error-free launches or proof that every previous concurrency failure is
fixed; the preview still reserves no control-process slot.

The new consumer's required full browser-memory run 347b fails after source
1,544, Node three and Bun seven checks pass. Chromium and WebKit each pass all
six browser cases, including four persistent constrained switching cycles.
Firefox passes four cases and fails two: Quake staging receives proxy HTTP 502
with an upstream CDN timeout before the framebuffer check; the separate audio
gesture case times out waiting for its active signal. Its trace records a blank
failure page and a failed Shell boot, without establishing the cause. An
unchanged isolated Firefox audio case passes in 359; that mixed outcome does
not clear the full gate. The run ends with sixteen browser passes and two
failures, no browser skips or retries. Source remains frozen. Its Bun phase
also retains the ten shutdown fallbacks described above.

Unchanged full rerun 370 passes after 31 minutes: the same 1,544 source checks,
three Node and seven Bun checks, and all eighteen browser cases with zero
skips, retries, flakes or unexpected failures. Each engine completes four
persistent constrained-budget switching cycles. Neither Firefox failure from
347b reproduces; no source, expectation, limit or deadline was changed to obtain
this result. The mixed outcomes remain recorded, without a cause or fix claim.
Bun again logs ten ordinary pthread cleanup fallbacks; Node logs none. Owned
Firefox Documents cleanup reports EACCES and is retained. This clears the
current consumer's full browser-memory rerun, not the remaining conformance,
resource, shared-object or graphics acceptance.

The first attempt, 347, stops after the source phase because this new checkout
lacks the pinned historical ABI artifacts and its copied baseline producer has
an invalid relocated submodule path. Provisioning fourteen regular files with
exact manifest sizes and hashes resolves that setup failure before 347b; no
artifact is restamped. Initial image preparation 350 also stops with its normal
structural decoder absent; installing the repository tool and rebuilding the
consumer's native helper allows 350b to pass. The resulting seven program hash
pairs, 353 artifact routes and browser JavaScript bytes match the previously
validated restart bundle exactly. All failed attempts remain retained.

Strict measurement campaign 353 stops with zero samples when 347b exits
nonzero. A separate diagnostic campaign retains that failure and the prior
331 backend evidence while measuring the current desktop; it grants no
shipping or browser-memory clearance. The PR remains draft.

Six-wrapper conformance run 333 finishes with failure. Node and Chromium libc
and POSIX wrappers exit zero; Node libc records a `pthread_cond-smasher`
flake-pass. Node Sortix reports 5,071 passes, the `tcgetwinsize` failure and a
`poll` timeout; Chromium reports 5,072 passes and the same terminal-size failure
without a timeout. Each Sortix host also records 15 expected failures and 50
skips. Source, artifact identities, deadlines and expectations remain unchanged.
The historical Node `select` timeout does not reproduce in this run; that does
not establish a fix. Historical memory run 278 is not relabelled as validation
of this correction. The fresh resource and all-nine diagnostics below retain these failures;
they do not grant promotion clearance.

## Previous build and correctness evidence

The following results precede the grouped-root correction above.

- The full normal browser build succeeds, including 144 browser and 46 Node
  TypeScript roots and all 330 normal prepared products. Its initial TS5097
  failure was corrected by using ordinary extensionless generated-constant
  imports in two host files. The 27 compiled host JavaScript bodies remain
  byte-exact after removing only their normal leading source-fingerprint
  comments for comparison; both emitted runtime Worker files are byte-exact
  without normalization. No production banner or freshness guard was changed.
- A canonical full shell-derived image is prepared through the normal resolver,
  SDK and image builder, with 353 declared asset routes. Its grouped image is
  7,924,676 bytes, SHA-256
  `1f1b8336da477d192034c7ea1f05ec3691e8112302592f2fb87656a5bc513566`.
  The seven ordinary/prepared executable hash pairs match the earlier normal
  partial image. The original untraced 3072×1728 matrix passes all 18 cases
  across Chromium, Firefox and WebKit, including black/gray negative controls,
  real terminal input, pointer-selected shell identity, workspaces and Stop.
- The full built Kandelo app passes a Chromium normal-UI smoke: Library → Sway,
  real Foot keyboard input writing a file, compositor exit, and actual VFS
  content verified through the parent shell. This uses ordinary execution and
  is not evidence of full-app shared-mode integration.
- The unchanged full `./run.sh test browser-memory` gate passes on `c9178e6526`:
  1,544 source/host cases in 59 files, three Node and seven Bun teardown cases,
  and all 18 browser cases, with no skips or browser flakes. Each engine runs
  four constrained-budget machine/audio switching cycles in one persistent
  page. A Firefox profile cleanup EACCES warning remains recorded; the suite
  exits zero. This is ordinary-runtime switching coverage.
- A grouped-display companion completes four real boot/input/two-terminal/
  workspace/Stop cycles in one persistent document per engine, with no reload
  or forced GC. Chromium/WebKit pass in run 280; Firefox launch fails before
  guest execution until the separate fixture inherits the normal project
  launch policy, then all four Firefox cycles pass in 280c. The original
  overall 280 failure remains a failure. This is not a memory plateau proof.
- The current runtime also passes 39 Node SDK/public-launch cases and Node/Bun
  teardown after the import correction. Earlier exact-runtime evidence includes
  84 browser SDK cases, 169 ownership/relay cases, ABI/baseline checks, 720
  untraced terminal lifecycle cycles, and separately traced resize-completion
  checks. These scopes do not replace full conformance or performance checks.

The owned-image consumer also passes all 18 original untraced 3K cases
across the three engines in run 296, with the same runtime Worker and artifact
bytes as the preceding candidate.

The accepted full memory run is `desktop-browser-memory-278-1120-001917-b0d4`;
canonical preparation/browser runs are 285b/291, import/build completion is
284b, and the built-app smoke is 294b. Workspace `.context/` retains receipts,
logs, image provenance and screenshots. An earlier private smoke failed test
source parsing before browser execution; it was corrected in a separate run.

## Previous restart-consumer measurements

[Portable review samples](2026-11-20-shared-memory-desktop-samples.json) retain
all independent all-nine benchmark values, current desktop resource samples,
persistent-cycle footprints and their raw-report hashes. They omit absolute
producer/cache paths; original logs and manifests remain in workspace evidence.


Resource phase 362 measures the current reusable Start/Stop consumer with the
normal canonical SDK image. Six fresh Chromium parents run in O,G,G,O,O,G
order, three per arm, at 1920×1080. Both arms use the same current host;
ordinary presentation attaches its canvas directly while shared presentation
uses the bitmap relay. The collector includes the owned browser's GPU and
utility processes and uses the OS multi-PID physical-footprint total with
shared-region adjustment. Source/artifact checks, tracked-job overlap checks
and the whole-phase host-sleep audit pass. Retained preview identities and CPU
usage are recorded; this does not establish a completely idle OS.

| Current canonical consumer, median | Ordinary | Shared |
|---|---:|---:|
| Two terminals on separate workspaces, MiB | 2061.3 | 2228.8 |
| Immediately after Stop, MiB | 1167.2 | 1461.4 |
| Whole-browser CPU for fifteen typed commands, seconds | 1.158 | 1.043 |

This is **167.5 MiB more while active and 294.2 MiB more after Stop** for
shared execution. These are diagnostic observations, not a net memory saving
or a general CPU speedup. The required full memory run 347b and conformance
333 remain failed. This canonical comparison also differs from the older
partial-image run below; it does not isolate the effect of the UI change.

The separate persistent phase 364 passes 96 actual Start/Stop cycles: sixteen
cycles in the same page and entry for each of six fresh Chromium parents,
three per arm. Each cycle verifies typed file output, workspace changes,
composition, completed machine destruction and a fresh filesystem on restart.
It uses no reload, module reimport or forced collection. Source identities,
tracked-job overlap checks and the whole-phase sleep audit pass.

| Parent | First four stopped footprints, median MiB | Last four, median MiB |
|---|---:|---:|
| Ordinary 0 | 1057.3 | 1119.3 |
| Shared 1 | 1291.0 | 1423.0 |
| Shared 2 | 1296.6 | 1434.4 |
| Ordinary 3 | 1078.0 | 1136.9 |
| Ordinary 4 | 1088.7 | 1124.1 |
| Shared 5 | 1321.3 | 1404.7 |

These finite observations show growth and variation, not a demonstrated
plateau or attribution to a retained guest memory. Main-page heap counters
alone do not account for the total-browser cost. The sixteen-cycle scope is
Chromium only. Independent follow-up 367 passes sixteen actual Start/Stop
cycles each on Firefox and WebKit at the published preview origin, using the
same entry, unchanged 240-second case deadline and operation deadlines. It
checks the 512 MiB group extent, completed roots, fresh filesystems, empty
diagnostics and browser memory-boundary errors. The committed regression
continues to cover four cycles per engine. Neither functional pass proves a
whole-browser footprint plateau; full-app switching and audio acceptance
remain separate requirements.

The current glyph-latency phase fails calibration in one of six parents and
provides no accepted new latency result. Raw diagnostic 365 captures a
uniform black RGBA readback in the failed shared sample where a localized
glyph was expected. Its baseline and subsequent glyph have the expected gray
background. All three frames report the same BGRA format and color-space
metadata. Whether the black sample reflects visible presentation or the
capture path is unresolved; neither a renderer fix nor an engine defect is
established. A six-parent source-canvas probe 366 does not reproduce any
black sample. Independent API control 368, containing no Kandelo code, passes
240 WebGL2 producer/bitmap-display/video readbacks without black; its 2D arm
fails waiting for a video frame. These mixed diagnostics do not explain the
original black sample. Bounds and deadlines remain unchanged.

All failed attempts remain retained: the initial ordinary HTML favicon 404,
two overly strict private transport observers, and both failed glyph phases.
Expected asset `net::ERR_ABORTED` cancellations are recorded separately in
362; HTTP errors, console errors and other transport failures still reject
the run. Resource phase 362 is independently valid, but its enclosing campaign
fails the glyph phase. Persistent phase 364 runs independently afterward.
Receipts and raw samples are retained in `.context/desktop-restart-diagnostic-measurements-362`,
`.context/desktop-restart-persistent-364` and
`.context/desktop-calibration-raw-365`. No failed overall run is relabelled as
a pass.

## SDK wrapper-cost correction

The normal translator now shares outlined access wrappers across constant
offsets, passing each original offset as a private i64 argument. Operation,
alignment and lane distinctions remain separate. The existing checked helper
still validates effective-address addition, permissions, split stores and
atomics. Public imports, exports, extension version 3, layout 3 and budgets
are unchanged. Ordinary executable inputs and all 27 emitted host JS/CJS files
match the preceding candidate.

Sway's wrapper count falls from 14,567 to 55 and Foot's from 3,623 to 47.
Their raw Wasm files grow by 499,958 and 172,814 bytes respectively; the
prepared image shrinks from 7,924,676 to 7,835,657 bytes. The measured image SHA-256
is `b6258b7f035dc880ac521534210bda0fa5c29d3175f70cdbab2cbe390fcaba75`.
Cold compile-only measurements show little footprint difference; the actual
desktop comparison supplies the application evidence.

Matched grouped-only comparison 374 uses three fresh Chromium parents per
arm. Median browser footprint falls by 134.8 MiB with two separate workspaces
and 210.5 MiB immediately after Stop. This compares two grouped implementations,
not ordinary execution, and does not attribute the difference to native code
alone.

Fresh comparison 384 then measures ordinary execution against the corrected
SDK candidate at 1920×1080. It uses three fresh Chromium parents per arm in
O,G,G,O,O,G order, identical ordinary executable inputs and unchanged limits.
Both use the normal canonical shell and public launch APIs; ordinary uses its
direct canvas and grouped uses the disposable bitmap relay. Whole-browser OS
footprint includes the owned browser process family and adjusts shared regions.

| Ordinary versus corrected grouped, median | Ordinary | Grouped |
|---|---:|---:|
| One visible terminal, MiB | 1910.4 | 1945.8 |
| Two tiled terminals, MiB | 2013.9 | 2056.0 |
| Two separate workspaces, MiB | 2050.2 | 2064.8 |
| Two retiled terminals, MiB | 2071.0 | 2062.5 |
| Immediately after Stop, MiB | 1149.7 | 1231.9 |
| Whole-browser CPU for fifteen commands, seconds | 1.132 | 1.001 |
| Trusted Enter to verified file output, ms | 34.410 | 11.200 |
| Key to captured Foot glyph, ms, separate phase 388 | 32.310 | 32.230 |

The separated-workspace ranges are 2047.7–2064.9 MiB ordinary and
2061.8–2100.2 MiB grouped. Grouped remains 14.6 MiB higher at that checkpoint
and 82.1 MiB higher immediately after Stop. These observations do not establish
a net browser-memory win, a confidence interval, a steady state or a general
speedup. Lower CPU and verified shell-output time apply only to this workload.
The material ordinary-path costs in all-nine comparison 354 remain unresolved.

Captured-glyph phase 388 passes all six fresh parents, fifteen real responses
per parent, three no-input controls and a deliberate 50 ms delay control. It
uses the actual Foot client crop and unchanged 32-pixel/10-second bounds.
The result includes video capture/readback and is not input-to-photon or GPU
presentation latency. Earlier black calibration failure 365 is retained; this
whole successful phase neither identifies its cause nor establishes an engine
defect. Both phases pass source/artifact, tracked-overlap, retained-preview CPU
and whole-phase sleep checks; the OS is not claimed completely idle.

The candidate's own normal canonical build validates all 330 cached products
and 144 browser/46 Node type roots. The complete native workspace Rust run
passes 4,776 tests; real public SDK Node cases pass 40/40 and the complete
three-engine browser SDK suite passes 84/84 without skips or flakes. Twelve
normal desktop/restart cases, the ABI check and ten authority checks pass.
Explicit offset tests cover split-page permissions, atomic alignment, i64
payloads and effective-address overflow.

Full browser-memory run 381 passes 1,544 source checks in 59 files, three
Node checks, seven Bun checks and all eighteen browser cases, including four
persistent constrained switching cycles per engine. Node logs zero ordinary
pthread cleanup fallbacks; Bun logs ten. Firefox owned-profile cleanup reports
EACCES. Original failed setup 372/372b, SDK run 382 and memory run 347b remain
recorded; successful complete runs do not erase failures or establish their
causes. Run 382's Chromium setup failure came from a shared writable dependency
directory in the test setup, which has been replaced with independent installs.

The original 3072×1728 stress workload 387 passes all 1,200 terminal cycles,
with every one of 14,428 completed host-root records checked absent. Kernel
extent grows from 1,790 to 1,823 pages while unique proof files are retained;
final I/O admission is 2,381,542 credits. No forced GC, reload, relaxed budget
or deadline was used. Sixteen same-page grouped Start/Stop cycles each also
pass on Firefox and WebKit in 390. These concurrent correctness runs are not
CPU, latency or OS-footprint comparisons.

Repeated whole-machine phase 389 passes all 96 real Start/Stop cycles in six
fresh Chromium parents, sixteen cycles in the same page per parent. Every
cycle verifies fresh filesystem state, physical input, workspace moves,
composition, closed host and memory-boundary checks. Whole-phase sleep and
tracked-overlap checks pass. Its stopped footprints still show material growth:

| Parent / mode | First stopped, MiB | Sixteenth stopped, MiB | Change, MiB |
|---|---:|---:|---:|
| 0 ordinary | 1040.5 | 906.6 | −133.9 |
| 1 grouped | 1146.4 | 1662.0 | +515.6 |
| 2 grouped | 1135.2 | 1659.1 | +523.9 |
| 3 ordinary | 1071.6 | 1144.3 | +72.7 |
| 4 ordinary | 1070.8 | 1133.5 | +62.8 |
| 5 grouped | 1173.4 | 1836.5 | +663.1 |

This is a correctness pass with an unresolved resource cost, not a memory
plateau. A separate non-timing control 395 checks actual owned CDP worker
absence after every Stop: all sixteen cycles pass without tracing or forced
GC, while footprint changes from 1135.9 to 1287.3 MiB. A traced control 393c
shows renderer buffer-allocator growth and a remaining attached kernel target;
that target does not recur in 395. These diagnostics do not identify a cause
or establish an external-runtime defect. Earlier diagnostic setup/trace-output
failures are retained. The batch remains draft while repeated-use growth and
other material costs are investigated.

Combined-branch validation 392/394b passes the ten translator cases, ten
unchanged authority checks over an exact 6,993-file candidate export, ABI,
registry, types, normal canonical build and SDK image preparation. Root's
initial audit also sees a retained untracked research allocation; those files
remain untouched and that failure is recorded. An inherited native helper
still embedded an older checkout path and was rejected; rebuilding it in a
fresh local target completes the normal catalog/image path.

All twelve committed desktop/restart cases pass on the combined bundle in
Chromium, Firefox and WebKit, including physical input at 3072×1728, black
negative controls and four same-entry boots per engine. Its image is
7,835,655 bytes, SHA-256
`8e7e119d837782b9a11792350a38c55a71240e6261a39a7dc7761f092d52c4fd`.
All seven ordinary/prepared program hash pairs, browser JavaScript, kernel
and other asset bytes match the measured bundle. NetHack's archive and its
image/manifest bindings differ: only its `kandelo.build.key` custom section
changed; every other complete Wasm section matches. Raw archive and image
identities remain different; no normalization or whole-bundle equality is
claimed.

Manual review of the retained 396b screenshots finds two visible terminals
on Firefox and WebKit, but a black Chromium desktop in its final PNG despite
three immediately preceding nonblack PNG screenshots and passing physical
input/workspace assertions. An earlier sampled frame in that same Chromium
composition sequence was also black. This is an unresolved presentation or
capture discrepancy; the automated pass does not establish that it is harmless
or identify an engine defect. The original PNG is retained and this keeps
visual acceptance incomplete.

Raw source, failed attempts, samples and receipts are retained in
`.context/desktop-wrapper-*`; portable per-parent samples and source-report
hashes are in the accompanying
[review data](2026-11-20-shared-memory-desktop-samples.json).


## Caller-side launch copy

The desktop caller now passes an exact, plain VFS file buffer directly to
`BrowserKernel.spawn`, which still snapshots it before transfer. A partial view
or shared backing still gets an exact-span copy. This removes a redundant
whole-program allocation without changing the host API, SDK, kernel, guest
programs, budgets or transport ownership.

Runtime observation 410 confirms that the 14,376,960-byte Sway caller copy and
155,294-byte Swaymsg caller copies disappear. The host's `ArrayBuffer.slice`
snapshot remains present in both arms. Real physical input and Stop pass.
Normal canonical build/types and all twelve original desktop/restart cases
pass across Chromium, Firefox and WebKit in 406. Its retained Chromium PNG
shows both real terminals; this single observation does not clear the earlier
intermittent black frames.

Matched phase 407 uses six fresh Chromium parents in P,C,C,P,P,C order, three
per arm, comparing the previous grouped caller with this grouped caller. All
353 artifact routes, kernel/image and worker JavaScript bytes match. The main
entry changes, and the default-artifact helper changes only its import of that
entry; raw differences are retained. Source, retained-preview CPU, tracked
compute-overlap and whole-phase sleep checks pass.

| Previous versus copy removal, median | Previous grouped | New grouped |
|---|---:|---:|
| Two separate workspaces, MiB | 2067.2 | 2039.2 |
| Immediately after Stop, MiB | 1288.7 | 1281.2 |
| Whole-browser CPU for fifteen commands, seconds | 0.967 | 0.979 |
| Trusted Enter to verified file output, ms | 12.675 | 11.660 |

This observes about 28.0 MiB less active footprint and 7.5 MiB less immediately
after Stop. It is a grouped-versus-grouped comparison, not a fresh comparison
with ordinary execution or evidence of a general speedup.

Repeated phase 408 passes all 96 actual UI cycles, sixteen in one loaded page
per fresh parent, without GC, reload or reimports. Each cycle checks fresh
filesystem state, physical input, workspace movement, composition, closed host
and memory boundaries at unchanged limits/deadlines. Median first-to-sixteenth
stopped growth is 145.0 MiB before and 147.9 MiB after the caller change. The
change does **not** establish a retention fix or plateau. The earlier 389
campaign's larger 516–663 MiB growth remains retained; even the unchanged arm
now differs, so this cannot be credited to the copy change.

The full browser-memory gate was not rerun for this caller-only change. Its
host/SDK/kernel and ordinary full-app paths are unchanged from 381; the new
checks exercise the changed developer page directly. All previous failures
and remaining acceptance requirements still apply.

Further diagnostics preserve the uncertainty:

- Native allocation sampling 400 completes sixteen cycles without tracing or
  forced GC. It reports repeated 10,447,552-byte allocations and allocations
  matching Sway's byte size. The stripped native stacks do not identify their
  owners; sampled allocation totals are not OS footprint or leak proof.
- Independent native API control 401 passes 240 captures at 3072×1728 through
  two workers and scene/cursor bitmap planes, using 2D and WebGL2 producers.
  It contains no Kandelo runtime or Wasm and does not reproduce black frames.
- Control 399 finds one black screenshot before the composition helper and
  fourteen normal screenshots. Correction to its earlier private notes: that
  helper uses successive **PNG screenshots**, not video. Glyph phase 388 is
  the separate video-based measurement. The black issue remains unresolved.
- Normal SDK control 404b passes ordinary initial VFS launch and rejects the
  compatible grouped target with ENOEXEC for its required extension. This
  confirms the documented initial `spawnFromVfs` gap; no admission or permission
  check was weakened to make it run.

Raw reports are retained in `.context/desktop-launch-copy-*`,
`.context/desktop-caller-copy-count-410`, `.context/desktop-native-sampling-400`,
`.context/bitmap-presentation-control-401` and `.context/grouped-initial-vfs-404b`.

## Previous whole-browser resource and response measurements

Run 295 measures both consumers using the existing public
`BrowserKernel.initFromOwnedImage` API. Each consumer owns a fresh fetched boot
image and does not need to preserve a decoded copy for restart. The API moves
that decoded image into the kernel Worker. Host/runtime source, SDK artifacts,
group budgets and presentation bounds are unchanged. Ordinary and shared arms
both use this ownership choice.

The comparison uses the normal partial image built with `shell sway swaybg foot
wayland-demo bibata-cursor-theme`, kernel SHA-256
`c8720e84e8b5cf53616db823b3ff1d85baf5f9e2737f023bcb59e460fa4b0ed1`,
ordinary image `04104d6f43a6e47ae200ac84348fd424e021c5b215e5b6191865314294afcd9b`
and shared image `e12023980d8704f39ba22a1ab2f4bc6c5f049570b6a05ec32a70c639faa4f881`.
The canonical products above were also built, but these numbers describe the
partial-image workload, not the full app or canonical image.

On macOS arm64, Chromium 153.0.8010.12, each phase uses three independent fresh
browser parents per arm in O,G,G,O,O,G order. Resource probes use a 1920×1080
desktop; glyph probes use 1280×720. The complete owned OS browser family,
including GPU and utility processes, is included. The OS multi-PID physical
footprint total adjusts shared regions; per-process sums are retained
separately. Footprint probes run outside the fixed 15-command CPU interval.
Both six-case phases pass, with unchanged input hashes, no tracked overlapping
build/test jobs and no host sleep. Retained preview identities and CPU times
are recorded. This does not establish a completely idle operating system.

| Median | Ordinary | Shared |
|---|---:|---:|
| One visible terminal, MiB | 1867.0 | 2006.7 |
| Two tiled terminals, MiB | 2018.2 | 2142.3 |
| Two terminals on separate workspaces, MiB | 2057.7 | 2162.7 |
| Two retiled terminals, MiB | 2049.9 | 2170.7 |
| After normal Stop, MiB | 1144.6 | 1396.6 |
| Whole-browser CPU for 15 commands, seconds | 1.094 | 1.024 |
| Trusted Enter to verified shell output, ms | 30.585 | 11.830 |
| Keydown to captured glyph, ms | 32.190 | 32.270 |
| Start to mapped terminal, ms | 1911.2 | 2509.7 |

Shared execution still costs about **105.1 MiB more while active and 252.0 MiB
more immediately after Stop**. This is not a net memory saving. Shared
separated-workspace samples range 2149.7–2174.7 MiB; ordinary samples range
2019.6–2061.2 MiB. Three parents do not establish a confidence interval or a
platform-wide speed claim. After-Stop snapshots are not a steady-state or leak
measurement.

The shell-output endpoint observes actual guest file output following the
original trusted Enter event. It is not presentation latency. Glyph timing
includes capture/readback overhead, uses actual a/b calibration, three
no-input controls per parent and a deliberate 50 ms delay control. There are
45 regular responses per arm and three delay controls. Its approximately
32 ms observer floor can hide smaller presentation differences. It does not
measure physical input-to-photon latency or GPU frame time.

Run 277 retains the preceding copy-preserving API comparison: ordinary/shared
separated-workspace medians 2065.4/2193.8 MiB and after-Stop medians
1150.7/1444.3 MiB. Those are separate runs, not an interleaved before/after
estimate of the ownership change. Both show material total-browser overhead.
Native profiles 286–288 are exploratory only: generic allocation tags and
incomplete allocator inspection do not identify an engine defect, compiled
code cost or a retained guest memory. Main-page JavaScript heap is small;
backing storage and native/other-isolate allocations require separate
attribution. No forced collection was used.

The initial owned-image pilot 293 completed the workload but failed its
no-error assertion on missing private-page favicons in both arms. The normal
HTML was restored in a new immutable fixture; 293b passed both arms. The old
404 failures remain retained. Accepted evidence is the separate six-parent
run, `desktop-owned-measurements-295-1120-015635-5e6e`, with raw resource/glyph
receipts and `.context/desktop-current-measurement-summary-295.json`.

## Repeated whole-machine observation

Run 297 completes 16 ordinary and 16 shared boot/input/two-terminal/workspace/
Stop cycles in one persistent document per arm on Chromium. Memory-boundary
checks, exact diagnostics and all functional assertions pass. No page reload,
new browser between cycles or forced collection is used. Each cycle imports
the same compiled entry under a distinct module URL, so this observer retains
module code and disposed debug-host objects. It is not equivalent to the full
app's normal machine replacement and is not a leak acceptance gate.

Immediate after-Stop OS footprints rise from 1048.9 to 1172.2 MiB for ordinary
and 1245.1 to 1534.0 MiB for shared execution. Shared samples fall from 1537.9
to 1434.8 MiB before rising again. Main-page backing storage also varies and
rises, ending at 78.3/131.0 MiB ordinary/shared. These functional passes do not
establish a plateau or prove which owners explain the retained footprint.
The original samples, process inventories and main-page heap counters are
retained in `.context/desktop-owned-trend-297`. Broader sustained resource
acceptance remains open.

## Extended desktop stress

Run 306 fails after 820 completed terminal cycles in one 3072×1728 shared
desktop, with no machine restart, page reload or forced collection. Each
cycle starts Foot, moves it to another workspace, verifies a physically typed
shell command against the guest filesystem, closes it and verifies process
removal. The next cycle logs a libdrm atomic-property error, a failed page
flip and an unsuccessful Sway IPC connection. Sway still appears running;
host diagnostics are empty. This is a failed sustained-desktop gate.

At failure, the shared physical extent is 196.7 MiB, below the unchanged
512 MiB limit. Kernel memory has risen from 1,575 to 2,887 pages
(180.4 MiB); the last completed checkpoint has eight live processes.
Neither these counters nor wlroots' `errno` message identifies the allocation
that failed. libdrm can return a negative error without setting `errno`, so
the exact return and arguments need capture before attributing the failure.

Ordinary control 311 fails in its first cycle with Wayland broken pipes and
terminal loss. It does not reach the shared failure's workload length or
establish a common cause. Separate normal-SDK libdrm screen 310 passes
50,000 allocation/free rounds, 1,000 grouped forks and 1,000 ordinary forks.
That screen excludes DRM submission, Wayland and GPU presentation; it does
not clear the desktop failure. All original failed runs remain retained.

## Previous full conformance and remaining acceptance

Full pre-correction run 298 completes all six unchanged wrappers. The
Node and Chromium libc and POSIX wrappers exit zero. Node libc reports
306 passes, 17 expected failures and one flake-pass; Chromium libc reports
307 passes and 17 expected failures. Each POSIX run reports 174 passes,
three expected failures and two skips.

| Full Sortix run | Pass | Unexpected fail | Timeout | Expected fail | Skip |
|---|---:|---|---|---:|---:|
| Current Node | 5,070 | `tcgetwinsize` | `poll`, `select` | 15 | 50 |
| Current Chromium | 5,072 | `tcgetwinsize` | None | 15 | 50 |
| Pinned-develop Node control 309 | 5,071 | `tcgetwinsize` | `poll` | 15 | 50 |

All three discover 5,138 tests. The shared `tcgetwinsize` failure reports
missing SIGWINCH and is also present in the historical baseline. Separate
baseline/current three-case controls pass poll/select and fail that same
SIGWINCH check. These controls do not clear the full-run timeouts; the
candidate's additional select timeout remains unresolved. No test
expectation, selection or deadline was relaxed. Current run 298 verifies
unchanged tracked inputs and kernel/rootfs artifacts before and after.

Node diagnostic 339 identifies an initial-size distinction in the retained
`tcgetwinsize` failure. The pristine case requests 24×80 and expects SIGWINCH;
Kandelo's new PTY already reports 24×80. A normal-SDK control changing the
observed size to 25×81 receives the signal and passes, while explicitly
reapplying the observed size correctly produces no signal. The original case
still fails. A separate native Darwin PTY initially reports 0×0. No kernel
default, upstream test, expectation or deadline was changed. These Node
controls do not clear a full-suite failure or establish browser coverage.

The original all-nine timing pipeline stops at the failed conformance gate
and produces no timing samples. Separate diagnostic preparation 312 passes
all 24 normal SDK/resolver steps and both-host artifact admission; preparing
compatible inputs grants no correctness or performance acceptance.

Separate diagnostic run 316b subsequently completes all nine enabled suites
on Node and Chromium, with three independent normal CLI parents per arm/host
and alternating order. Each side uses its own normal SDK, kernel and
ABI-matched artifacts. All twelve launches exit zero with matching metric
inventories, no tracked compute overlap and no Sleep/FullWake event across
the timing phase. Retained preview process identities and CPU usage are
checked; this does not establish a completely idle operating system or a
confidence interval.

This measures `a9e54e9ec2`, before the root correction. It is explicitly
diagnostic, not promotion evidence: the failed conformance and sustained
desktop receipts remain bound to the result. Material observed costs include:

| Host / metric | Develop median | Pre-correction median | Change |
|---|---:|---:|---:|
| Node hello start, ms | 332.79 | 353.79 | +6.31% |
| Node exec, ms | 406.03 | 435.72 | +7.31% |
| Node stdin, MiB/s | 864.90 | 786.06 | −9.12% |
| Node dense-file lock conflict, µs/op | 23.81 | 27.55 | +15.71% |
| Browser spawn, ms | 36.93 | 39.80 | +7.77% |
| Browser large first spawn, ms | 27.95 | 30.68 | +9.77% |
| Browser dense-file lock conflict, µs/op | 24.63 | 26.58 | +7.92% |
| Browser dense-file lock replacement, µs/op | 24.47 | 27.75 | +13.40% |
| Browser InnoDB bootstrap, ms | 959.22 | 1051.88 | +9.66% |
| Browser InnoDB create query, ms | 19.14 | 22.88 | +19.54% |

Other metrics improve; these rows do not establish global performance
neutrality or causation. The create-query samples overlap and vary by a few
milliseconds. Complete comparisons, all samples and provenance remain in
`.context/desktop-diagnostic-all-nine-316b`. Profiling and a fresh corrected
candidate comparison are still required; the root fix does not itself prove
these ordinary-path costs resolved.

Corrected-runtime diagnostic 354 now completes the same nine suites on Node
and Chromium: twelve independent CLI launches in alternating order, three per
arm/host, each side using its own normal SDK, kernel and ABI-matched artifacts.
All launches exit zero; suite inventories and artifact identities match;
tracked compute overlap and whole-phase Sleep/FullWake checks are clear.
Fetched `develop` remains `bcc8b0c79523912872275f116965ed0fcf835b19` before
and after, differing from the pinned baseline
`715243ed0aa1a8564a0dd8ad4bcef331ac3ca18a` only by one CI evidence row.
The explicit Erlang exclusion is retained. This measures ordinary execution,
not grouped application performance, and remains diagnostic because the
conformance and current full-memory failures are still bound to its receipt.

| Host / metric | Develop median | Corrected median | Change |
|---|---:|---:|---:|
| Node hello start, ms | 325.13 | 347.79 | +6.97% |
| Node exec, ms | 396.53 | 423.94 | +6.91% |
| Node stdin, MiB/s | 869.06 | 779.25 | −10.33% |
| Node dense-file lock conflict, µs/op | 24.29 | 28.64 | +17.91% |
| Browser clone, ms | 30.85 | 33.27 | +7.84% |
| Browser large first spawn, ms | 28.72 | 30.76 | +7.10% |
| Browser large repeated spawn, ms | 28.50 | 30.90 | +8.42% |
| Browser many-file lock acquire, µs/op | 30.47 | 33.78 | +10.86% |
| Browser many-file lock conflict, µs/op | 26.62 | 29.41 | +10.48% |

Other metrics improve or vary. Three samples do not establish confidence
intervals, causation or global performance neutrality. In particular, the
root-reap fix does not clear these ordinary-path costs. Complete per-launch
samples, source/admission records, comparisons, retained-preview CPU and sleep
audits are preserved in `.context/desktop-root-reap-all-nine-354`.

Repeated whole-machine footprint behavior and the remaining material costs
need investigation. Earlier intermittent input/IPC failures remain recorded;
a successful bounded current run does not prove every historical cause fixed.
The full original launch/shared-object/graphics requirements remain follow-up
work. No merge, deployment or draft promotion is automatic.


### Normal package-backed lazy preview (2026-11-21)

The `shared-desktop-programs` package now produces eighteen individually lazy
SDK archives. A normal partial shell explicitly activates them; the launch
command validates that image instead of producing a separate eager image.
The resulting partial image is 119,429 bytes (SHA-256
`4b3bb368563d1dbd1e5b9b6aee92fc7351030256961ae7c7a7994eda7b832411`).
All eighteen executable paths remain deferred and share actual inodes with
their package paths, including preserved root-owned mode 4755 for login.
All thirteen prepared executable hashes shared with the preceding Cage/game
preview match exactly. Image size alone is not total boot traffic or browser
resident memory; lazy program/data fetches, compiled code and runtime backing
still require measurement.

Normal partial and SDK/package builds pass (678/679). Strict types pass
(669/670/680). The image module's native suite passes 71 cases (672); real-Wasm
hard-link/lazy-serialization validation passes (674). The image/filesystem and
ordinary shell-composition regressions pass 109 cases (677), with one existing
opt-in 32 GiB sparse-fixture case skipped. This does not replace the canonical
production build or full browser-memory gate.

Against the normal app, Chromium/Firefox/WebKit each pass cold on-demand
program loading and physical Foot input/initialized graphical cleanup (684).
Their request records show Cage/Foot/Bash SDK archives, with no Freeciv or
ScummVM program fetch. The six maintained Freeciv/Foot checks pass (685), as do
three Sway twelve-terminal/initialized cleanup checks using the same normal
partial image's Sway profile (686). Three ScummVM launcher checks pass (687);
ScummVM gameplay remains unproven. Earlier ScummVM process/color diagnostics
captured terminal startup and are not game-scene evidence.

Retained preparation failures: 671 named a nonexistent recipe input; 673 used
an import whose resolution depended on the build directory; 675 hit the host
Unix-socket path limit in the optional tsx CLI control channel. The recipe now
uses the declared loader entry directly. In 676 the SDK package completed,
but the partial selection omitted the ordinary application packages. The
normal command now names them explicitly and missing selections fail clearly.
Server 681 rebased the image-reader path through the Vite config bundle;
683 supplies the normal resolver's explicit module bytes. None of these
failures is a claimed browser-engine defect. The existing previews remain
available. The full memory gate, sustained failures and unmatched resource
pilots above remain outstanding; there is no net memory or latency claim.


The maintained six-case Cage suite now includes the cold demand-load assertions
and passes all three engines (689). The public Node host also passes all four
normal partial-image checks (690), including explicit grouped Bash launch,
normal lazy archive reads, fork/exec pipelines through Coreutils/grep/sed and
non-null public group accounting. Full app typechecking passes (691: 144
browser roots and 46 Node-test roots); targeted test/image/plugin types pass
with their Vite declarations (692). An earlier ad hoc typecheck omitted those
declarations (688); it is retained as a failed check invocation, not a product
failure. These results still do not establish a canonical build, full memory
gate, sustained lifecycle or matched performance acceptance.

The current package/image change also passes the normal ABI version check against `origin/develop` (job `lazy-abi-693-1121-014616-e4e4`). The image-builder hard-link export is additive; program ABI 56 and host-adapter 24 remain unchanged. Full canonical and browser-memory acceptance remains pending.


### Fixed-size memfd mappings and ScummVM Quit (2026-11-21)

The original shared ScummVM game rendered and responded to movement, but
native Quit returned 139 (699/704/709/713), versus 0 in the ordinary control
(703). Debugger evidence identified `free(512)` during
`wl_cursor_theme_destroy(NULL)`. The pinned Wayland library uses memfd for its
cursor pool. A public Node reduction (715) confirmed that ordinary memfd
shared mapping succeeds, while the grouped path refused it with errno 95.
The observed contents at virtual address zero were retained; their writes
were not attributed to an engine defect.

The kernel now gives memfds the same fixed, whole-object direct backing
surface as tmpfs. It retains stable kernel identity, admission, population,
cancellation and pin lifetime; descriptor reads, sizes and seek cursors stay
coherent after promotion. Atomic admitted metadata permits the object to be
retained safely by the synchronized backing table. Abandoned unpublished
preparations also release their mutation fence for both tmpfs and memfd.
No application wrapper or Wayland source workaround was added. Descriptor
writes, growth, truncation and general offset mappings remain incomplete.

Validation 730 passes: 4,804 native workspace tests, zero failures, ignored
or filtered tests; normal kernel build; ABI check against `origin/develop`
with program 56/host-adapter 24 and the program contract digest unchanged;
three selected internal/public Node byte/VFS launch cases; and the shared-file
SDK case on Chromium, Firefox and WebKit. The maintained C fixture now checks
both tmpfs and memfd aliases, private copies, fork, descriptor reads, shared
`dup` cursors and post-close use. The selected Node invocation reports thirty
unselected public-launch cases as skipped by its name filter; this is a
targeted result, not a complete host-suite result.

The normal partial build (722) passes and produces the same 119,429-byte
image with SHA-256 `4b3bb368563d1dbd1e5b9b6aee92fc7351030256961ae7c7a7994eda7b832411`.
Against that normal app, diagnostic 739 passes all three engines: God of
Thunder menus and rendered world, no-input movement control, physical
right/left movement, native Quit/no-save status 0, actual Foot input proof
and exact Cage cleanup. Each observed kernel response matches SHA-256
`1630584d60491267bc4c4681d8e00035043eaa2dc5e1b292bf66ee199d77b55d`.
The live candidate is `http://127.0.0.1:6385/`; the prior user previews remain
unchanged. Run `scummvm-static-play god-of-thunder` for the normal verified
download/catalog/game path, or `scummvm-static` for the launcher.

Retained failures are not waived: 721 exhausted local disk during native
linking; 727 lacked the seven immutable ABI-55 controls; 729 found a missing
namespace in a new mock-host fixture, subsequently corrected. Both frozen
ABI cohorts were reproduced/verified through their pinned SDKs. In 723,
Chromium passed gameplay and Quit; Firefox's scene mask matched during the
intro fade before the next key was accepted, and WebKit's single directory
snapshot preceded publication of the shell's exit-status file. Diagnostic
739 requires full-color story readiness, with a fading-frame negative control,
and refreshes actual file observations until the exact status is available.
It preserves the original game/input/status/cleanup assertions. Raw inputs,
logs and captures are retained under `.context/shared-desktop-memfd-718/`.

The earlier full browser-memory attempt (697) completed the canonical build
and all 1,574 host ownership regressions, then failed historical ABI-fixture
provisioning before Node/Bun teardown tests loaded. Its browser legs did not
run. Provisioning now succeeds, but the full gate must be rerun on the current
candidate. Canonical 697 is evidence for the preceding packaging revision,
not a current full-memory pass. Earlier sustained failures, grouped/browser
conformance gaps and fair memory/CPU/input/presentation measurements remain
open. No new performance or net-memory claim is made.


### Maintained game checks and current capacity rerun (2026-11-21)

The maintained `playwright.trusted-scummvm.config.ts` now selects the actual
God of Thunder game check separately from the Cage/Freeciv inventory.
Run 746 passes all three engines (three expected, zero skipped, flaky or
unexpected) against the unchanged normal app and kernel from the fixed-memfd
candidate. It covers menus, world rendering, physical movement, a no-input
movement control, native Quit status 0, physical Foot input and Cage cleanup.
The targeted strict type check passes after declaring the fixture's existing
metadata field; the original declaration/configuration failures are retained.
No runtime, package, ABI or PHP-FPM configuration changed in this test addition.

Run 747 passes all six maintained Cage/Foot/Freeciv cases. Its Sway capacity
rerun passes Chromium and WebKit; Firefox creates twelve terminals, closes
one and creates a new PID, but times out waiting for the final Sway exit.
The retained screenshot shows the command reaching Bash as `waymsg exit`.
That is not a clean capacity-suite pass. Prompt/focus readiness is under
investigation; later diagnostic fixture changes do not erase this failure.

The complete browser-memory gate is still running on the clean runtime
candidate. Its canonical preparation, source/ownership and Node/Bun teardown
legs complete, and its Chromium browser leg passes; the other browser legs
remain pending. The sustained run and fair resource/performance/conformance
gates remain open. Evidence from 744/746/747 and their failed controls is
retained in `.context/shared-desktop-current-753/`.


The capacity check now waits for Bash's rendered prompt under the actual
focused Sway title before Ctrl+D and the final command. Process creation alone
did not establish input readiness. It preserves all twelve-process/shell,
one-removed PID, new-replacement PID, display-release and initialized-table
cleanup assertions. Run 755 passes all three engines with zero skips, flaky
or unexpected results. The normal app/kernel remain unchanged.

The preceding readiness diagnostics are retained: 751 incorrectly assumed the
rightmost tile was focused, while Sway had followed the pointer after Internals
closed. Diagnostic 754 tried an absolute-position click while pointer capture
was active; Chromium refused its focus assertion and Firefox hit the original
seven-minute test deadline. The corrected keyboard check observes the actual
focused prompt and does not change pointer capture. Known-prompt, inactive-title,
blank-pixel and changed-glyph controls pass. This does not establish captured
pointer behavior, sustained capacity or a performance benefit.

The public `playwright.trusted-desktop.config.ts` also accepts the explicit
Sway profile/VFS query of the normal partial image, rather than rejecting the
documented profile URL. Run 758 passes its three selected capacity cases and
strict types on all three engines. The other Sway cases were not selected by
that invocation and are not newly claimed here.


### Current production, memory and conformance results (2026-11-21)

The unmodified full `./run.sh test browser-memory` gate (741) passes on
runtime `c85334be07250433dfa26f40c4aa3fe1685605d3`: normal canonical
preparation, 1,574 host tests in 60 files, three Node and seven Bun teardown
cases, and eighteen browser cases across Chromium, Firefox and WebKit.
There are no skipped, flaky or unexpected browser cases. HEAD, status and
tracked-diff guards match. A nonfatal Firefox temporary-profile cleanup
permission warning is retained; it is not a guest-memory release failure.

The normal production build (763) passes canonical preparation, the
unchanged machine-registry audit, strict types, the authenticated asset
group and the production bundle. The packaging correction validates the
full authored SDK inventory instead of synthesizing a desktop identity in
the app. The same 119,429-byte partial image and kernel hashes recorded
above are consumed by the built app; the eighteen programs remain separate
lazy archives. No additional launch image is created.

The built-app run (769) has fourteen passes and one failure: all three
ScummVM cases, all six Sway/capacity cases and five of six Cage cases pass.
Chromium's Freeciv case fails before client creation because its ordinary
data archive fetch fails. Firefox and WebKit run Freeciv successfully.
The corrected network diagnostic (773), fixed at three Chromium repetitions,
passes gameplay, native Quit, physical Foot input and exact Cage cleanup
without reproducing that download failure. The original failure remains
unresolved; this is an intermittent result, not a clean full-suite pass.
Diagnostic 771 had reached the game but incorrectly tried a shell command
before quitting it. Its failure is retained separately from the real fetch
failure. No browser-engine defect is established.

Current ordinary conformance (767) completes all four default inventories:

| Host | Suite | Pass | Expected failure | Standard skip | Listed flaky pass | Failure/timeout |
|---|---|---:|---:|---:|---:|---:|
| Node | POSIX | 174 | 3 | 2 | 0 | 0 |
| Chromium | POSIX | 174 | 3 | 2 | 0 | 0 |
| Node | libc | 306 | 17 | 0 | 1 | 0 |
| Chromium | libc | 307 | 17 | 0 | 0 | 0 |

Each suite exits zero. The outer job exits one because its final porcelain
status guard detects the libc submodule's generated, untracked `build/`
directory. Audit confirms the parent HEAD and binary diff are identical,
the upstream test revision remains
`790f94c7b6feb8ade25868c10fba46233f783a0b`, its tracked diff is empty, and all
325 new files are under `build/`. This is ordinary regression evidence;
it does not establish full grouped execution conformance. The raw job
failure and the guard audit are retained without changing expectations.

The fixed 1,200-cycle-per-engine sustained run (752) passes Chromium,
including real Sway exit and initialized zero-Foot cleanup. Firefox completes
464 cycles, then one launch shortcut leaves three Foot processes and shells
where exactly two were expected. The assertion fails after its unchanged
deadline. WebKit is still running at this recording. Repeated input and
duplicate process creation remain hypotheses; neither is established.
The original failed run remains retained while a separate fixed-length
Firefox diagnostic records actual DOM key transitions around launches.
This loop does not measure unique backing, reservation or whole-machine
memory reclamation.

The current-source resource pilot (760) used Chromium 153.0.8010.12, two fresh
browser parents, the normal ordinary/grouped partial images and the same
Sway/Foot workload. It ran under concurrent validation load and is a method
pilot, not the required quiet alternating comparison. Exact image bytes were
forwarded unchanged to the app; interception ended before sampling. The
owned-process macOS footprint includes GPU and shared-region accounting.

| Two-terminal workload | Ordinary | Shared group |
|---|---:|---:|
| Tiled browser footprint (MiB) | 2,550.10 | 2,636.58 |
| CPU seconds for fifteen physical shell commands and fresh file reads | 16.7965 | 17.3029 |

The grouped footprint is 86.48 MiB (3.39%) higher in this pilot. No net memory,
CPU or latency benefit is claimed. Unique guest backing, reserved capacity,
input/presentation latency, quiet alternating samples, sustained all-engine
completion and the target-branch benchmark comparison remain open gates.
Raw inputs, logs, screenshots and guard audits for these runs are retained
under `.context/shared-desktop-current-753/` in the workspace archive.

### Built-app cache correction and sustained input controls (2026-11-21)

The cache correction in `2ddabdca310a1908f4ceedc5012fe458f377e449`
keeps a completed lazy VFS network response readable when optional
CacheStorage open/put fails. Native size/digest checks, Content-Length and
body-read failures retain their existing behavior. A fresh owned Chromium
profile with a managed quota reproduces the failure before the fix (798):
the actual Freeciv archive receives a network 200 but its caller gets
`Failed to fetch`. An independent CacheStorage write rejects with
`QuotaExceededError`. The maintained regression also fails before the fix
(799). This establishes a cache error-handling defect; the unlogged cause
of the earlier run 769 remains unknown.

After the fix, all cache contracts across the three engines pass (802):
83 passes, 16 explicit skips for Chromium-CDP-only controls, zero unexpected
or flaky results. The first broad invocation (801) lacked the maintained
macOS Firefox profile environment and failed before those test bodies;
that fixture failure remains retained.

Normal production build 803 passes with unchanged tracked-source guards,
the same partial-image and kernel hashes, and the optional Inspector group
counter presentation from `3c2cd9718bc6`. The actual built-app archive
checks (805) pass both unrestricted and quota-refused cases: 48,851,310
bytes with SHA-256
`8a824448153fe38e58e9cff4522ba77b9d8cf9a11b4d71c1138d5398b2ec2411`.
The independent native cache refusal still occurs in the limited case;
the fix returns the complete network bytes rather than promising durable
cache storage. Built-app run 806 passes all fifteen maintained cases:
six Cage/Foot/Freeciv, three ScummVM, and six Sway/capacity cases across
Chromium, Firefox and WebKit, with no skips, flaky or unexpected results.
Source guards match. These bounded passes do not erase run 769 or establish
sustained acceptance.

Sustained run 752 finally fails WebKit after 637 completed cycles with the
same extra-terminal symptom. Firefox diagnostics reproduce it after 250
(775), 450 (789) and 103 (800) completed cycles. Run 789 observes one actual
DOM shortcut and exactly one forwarded Alt-down/Enter-down/Enter-up/Alt-up
sequence. Run 800 additionally observes one such sequence received by the
actual kernel worker, with Enter down/up 5.14 ms apart. Its synchronous
message handler returns quickly; this does not timestamp deferred kernel
entry execution or prove when Sway consumes the release.

The ordinary current-runtime control (795), using the ordinary partial
image without group admission, also fails after 537 completed cycles:
three Foot processes and shells instead of two. It likewise records one
DOM and main-to-worker shortcut sequence (Enter held about 96 ms). Thus
these results do not establish a group-specific failure or a regression
against the recorded target branch. The common input/launch path remains
under investigation without changing counts, deadlines or repeat policy.
A three-cycle diagnostic pilot (809) successfully collects the existing
Inspector syscall trace and scalar process events without runtime source
rewriting; its longer fixed-length run is pending. Trace instrumentation
is diagnostic evidence, not a performance sample.

The cache correction changes no Node, SDK, ABI, kernel or memory ownership
contract. The full memory and conformance receipts above predate it.
Quiet resource/latency measurements, target-branch benchmark comparison,
material-cost treatment and sustained acceptance remain incomplete.

### Built Chromium endurance and resource screens (2026-11-21)

Run 829 completes all 1,200 Chromium cycles against the normal production
app from build 803 in 48.2 minutes. It retains the original physical-input,
Foot/shell counts and deadlines, then exits Sway and observes initialized
PID 1 with no Foot processes. Twenty-six copied group snapshots include
the initial state, periodic checks and the state after graphics exit.
The periodic physical extent stays at 2,578 pages (161.125 MiB). After
graphics exit, the two remaining login/syslog images own 325 pages
(20.3125 MiB); shared objects/pages/references, quarantine, wait drains,
native observers, staging bytes and retained mapping references are zero.
This shows bounded logical reuse in this run. The machine remains live;
these counters do not prove RSS reduction, backing collection or machine
destruction. Firefox and WebKit remain pending at this checkpoint.

The independent guest evdev recorder in run 827 reproduces the extra
terminal after 388 completed Firefox cycles on the development server.
It records exactly one Enter press/release, 3.74 ms apart, with both read
by its independent device OFD within 0.94 ms and no dropped records.
Sway subsequently issues two fork calls; their entry-to-next-observed-
syscall gaps are 592.26 and 594.60 ms. Sway reads input again only after
both calls. This narrows the investigation to compositor consumption and
timer ordering while fork blocks. It does not prove the exact repeat
branch or split fork time into CPU and waiting. The ordinary-execution
reproduction above remains relevant; no repeat policy or test count was
changed.

Two host-only resource candidates were screened on isolated source
checkouts at `e296c91dd1a1`, using the same normal SDK/kernel/image inputs.
The first avoids clearing pages newly supplied by the same locked
`Memory.grow`; it still clears all previously present and reused pages.
The second also reuses ordinary fork's sparse-copy scanner for disjoint
private physical pages while the exact parent barrier is held. Neither
candidate is included in this batch.

| Diagnostic candidate | 12-terminal candidate minus baseline footprint | After graphics exit, machine still live |
|---|---:|---:|
| Fresh-growth zeroing only (844) | +7.06 MiB | -42.34 MiB |
| Fresh-growth zeroing and sparse private copy (852) | +16.84 MiB | -164.77 MiB |

Each desktop screen uses one fresh Chromium parent per arm, exact
one/two/twelve-terminal input and process checks, fifteen physical shell
commands with fresh VFS reads at each occupancy, and actual Sway exit.
Both pass; the second also checks the browser-consumed source response
bodies for the candidate changes. These runs overlap builds and other
validation. They do not establish a consistent active-desktop memory
reduction or qualifying CPU benefit. The combined candidate's diagnostic
CPU totals are lower in this single pilot, but require a quiet comparison.

Synthetic Node/Bun screens cover 16/128 MiB images with zero, sparse and
dense data. The combined Node candidate has about 125 MiB lower
post-preparation RSS for a mostly empty 128 MiB image; its pre-copy RSS
also differs, so this is a combined-operation result. Bun shows little
memory benefit and slower zero-page scanning. The combined candidate
passes the normal host build, 1,629 source checks in 62 files and seven
synthetic byte/alias/protection/reuse modes on each browser engine. These
are diagnostic checks, not a combined browser-memory or full performance
gate. The patches and failed or inconclusive experiments remain retained
without promotion.

Run 831's lossless, marker-aligned V8 trace is also diagnostic. Matching
actual SDK hashes, function indices and code offsets identifies seven
grouped modules. The large repeated Wasm sample counts resolve to
`vm_wait32`, where native waits may be parked. Sample counts therefore do
not measure CPU utilization. `imageOwnedPages` is the largest JavaScript
leaf in this trace; its actual CPU/allocation cost remains to be measured
before changing retirement checks. Signed negative V8 time deltas are
preserved rather than clamped.

[Derived review samples](2026-11-21-shared-memory-resource-screens.json)
record source/report hashes and numerical results. Quiet matched
memory/CPU/input/presentation measurements, the target-branch benchmark
comparison and sustained all-engine completion remain open. The resource
screens introduce no SDK, ABI, kernel, package or PHP-FPM changes into
this batch.

## Built endurance and normal high-resolution checks, November 21

The unchanged built app now completes all 1,200 physical-input and terminal
lifecycle cycles on Chromium and a fresh Firefox parent. Chromium's run takes
48.2 minutes; Firefox's takes about 64 minutes. Both retain the original
counts, whole-file proofs and deadlines, then exit Sway through the guest and
observe initialized PID 1 with zero Foot processes. Firefox's periodic common
extent stays at 2,521 pages (157.5625 MiB), compared with Chromium's 2,578 pages
(161.125 MiB). After graphics exit, Firefox reports 325 allocated pages
(20.3125 MiB), two remaining login/syslog images and zero shared objects,
references, pending wait drains, quarantine and native observers. The machine
remains alive; these counters do not measure RSS or machine collection.

The original three-engine run remains failed: Firefox stopped after 781
completed cycles when host disk exhaustion prevented a phase-record write,
and WebKit stopped after 892 cycles with repeated characters corrupting an
`echo` command. The fresh Firefox success does not erase that original run.
WebKit's next diagnostic fails after 233 cycles with three terminals instead
of two, despite one trusted Enter down/up pair forwarded about 1.1 ms apart.

An independent normal-SDK evdev recorder then passes a three-cycle built
WebKit smoke check and fails the longer diagnostic after 301 completed
cycles. Its screenshot shows repeated `c` characters changing the redirected
pathname, so the expected file retains the preceding cycle's contents. The
recorder reports zero drops and retains a bounded final event window. Browser
key holds in that window remain below 21 ms and guest event down/up pairs
below 30 ms, but one key release
reaches the independent reader 18.318 seconds after its event timestamp.
The retained copied syscall trace has an adjacent-call gap of 18.336 seconds;
older rows were overwritten in its bounded ring. This narrows the problem to
a service or scheduling stall, without proving a particular handler's CPU
cost, compositor branch or browser-engine defect. A separate three-cycle
startup control observes 19 fork Workers with preparation-to-replay spans
below 115 ms; those normal paths do not explain the failure tail and do not
justify weakening replay or retirement fences.

The current normal app also repeats the original high-resolution scenario.
Each grouped engine completes six workspace/tile cycles at native 3072×1728,
twelve fresh whole-content physical-command proofs, and actual Sway exit
with zero terminals. Moving each window between full and half width exercises
the real graphical buffer resize path. The comparison retains its failed
ordinary controls separately:

| Engine | Grouped high-resolution workload | Ordinary control |
| --- | --- | --- |
| Chromium | Pass | Process table stays at one Foot/shell while waiting for two |
| Firefox | Pass | Screenshot readback reaches its 5-second fixture deadline; capacity remains unproved |
| WebKit | Pass | Process table stays at one Foot/shell while waiting for two |

These runs overlap builds and are not quiet performance or whole-browser RAM
comparisons. All engines retain actual image/kernel response SHA checks
through a test-owned HTTP observer that forwards bodies unchanged. Earlier
fixture failures remain retained: canonical persistent contexts, the public
kernel scanout statistics and the HTTP observer replace unsuitable context,
placeholder-canvas and disposable-worker body observations. No runtime or
image source is rewritten.

The checked-in normal-app regression now preserves both terminal PIDs through
six high-resolution workspace cycles, twelve exact file proofs and real
cleanup. Its six selected cases, including the existing twelve-terminal
capacity/reuse cases, pass on Chromium, Firefox and WebKit against the same
normal built app, with zero skips, flaky or unexpected cases. The normal own
host build and strict test types pass. This commit changes tests and evidence;
the runtime remains c853 and the built frontend remains e296. No new SDK,
ABI, kernel, package or PHP-FPM behavior is introduced.

[Derived lifecycle samples](2026-11-21-shared-memory-desktop-lifecycle.json)
retain numerical scope and report/artifact hashes. Sustained WebKit behavior,
quiet matched resource/interaction measurements, the destination benchmark
comparison and the material-cost decision remain open. Neither resource
experiment is promoted and no net-memory or performance benefit is claimed.
