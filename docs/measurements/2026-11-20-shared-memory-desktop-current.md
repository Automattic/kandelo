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
for byte. Fresh full browser-memory run 331 and six-wrapper conformance run
333 remain pending. Historical memory run 278 is not relabelled as validation
of this correction. Fresh application/resource and all-nine performance
measurements remain required before promotion.

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

## Whole-browser resource and response measurements

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

A fresh all-nine comparison on both hosts remains required. The fetched
`develop` destination is `bcc8b0c79523912872275f116965ed0fcf835b19`; it differs
from recorded baseline `715243ed0aa1a8564a0dd8ad4bcef331ac3ca18a` only by one
CI evidence-classification row. Each side must still use its own normal SDK,
kernel and ABI-matched artifacts. Historical targeted conformance and the
pre-correction diagnostic do not validate the latest combined runtime.

Repeated whole-machine footprint behavior and the remaining material costs
need investigation. Earlier intermittent input/IPC failures remain recorded;
a successful bounded current run does not prove every historical cause fixed.
The full original launch/shared-object/graphics requirements remain follow-up
work. No merge, deployment or draft promotion is automatic.
