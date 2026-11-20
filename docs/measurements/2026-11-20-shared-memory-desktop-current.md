# Shared-memory desktop: current validation and resource cost

This checkpoint distinguishes the current grouped-root lifecycle correction
from the preceding `c9178e6526` runtime, browser import correction `4bd526d429`
and owned-image consumer `a9e54e9ec2`. It supersedes the current-status summary in the
[November 19 investigation](2026-11-19-shared-memory-desktop-integration.md),
which retains earlier measurements and failed experiments. The batch remains a
draft targeting `develop`; neither the original PR1–PR9 plan nor merge
acceptance is complete.

## Supported preview

Trusted compatible programs opt into the existing kernel-owned group through
`experimentalMemoryGroup`. Normal SDK version 3/layout 3 artifacts supply
Sway, Swaybar, Swaybg, Swaymsg, Foot, Bash and Coreutils; historical “format4”
is a prototype label. The developer consumer uses byte launch from its actual
VFS, a 512 MiB group budget, 24 processes and 64 tasks. It is temporary and
in memory. Ordinary execution remains the default in the full Kandelo app.
Grouped initial `spawnFromVfs` and a shared-mode launch in that app are still
absent. The developer page is the working shared desktop preview.

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
