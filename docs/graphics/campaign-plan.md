# Graphics campaign: compatibility, reliable desktops and native feel

Planning checkpoint: 2026-11-09. This is the durable work index for the
graphics campaign after PR #1594. It describes planned behavior, not
supported behavior or completed validation.

The [workspace handoff](workspace-handoff.md) locates preserved local drafts,
Cage evidence and independent previews for continuation in a fresh workspace.

## Scope and authority

The original baseline is OpenGL ES **2.0**, GLSL ES **1.00**, EGL **1.5**
with the advertised extensions, GBM, and **one display** with legacy and
atomic DRM/KMS. The campaign subsequently added native desktop feel,
Freeciv and ScummVM acceptance, the guest graphics driver (B1–B6), Rust
scheduling and a separate GPU executor (C1–C3).

The baseline does not include desktop OpenGL or GLES 3.0. A WebGL 2
backend does not establish GLES 3 compatibility. Future expansions remain
visible below, without silently adding them to a baseline release.

Use this document to choose and track deliverables. The
[compatibility ledger](compatibility-v1.md) remains authoritative for
maintainer decisions, implementation evidence and approved differences;
[future improvements](../future-improvements.md#graphics) retains approved
deferrals. The [coverage map](cts-coverage-v1.md) and
[conformance guide](conformance-testing.md) define upstream test coverage.
Do not overwrite historical results when updating this plan.

The maintainer requested intentional scoping after shipment. The broad
campaign remains paused. Cage crash/performance investigation is explicitly
authorized; this planning task does not authorize starting every remaining
stage. Choose one deliverable and its acceptance scope before execution.
This is sequencing, not permission to drop an existing requirement.

## What actually shipped

- [x] Combined Cage/Sway foundation and B1 graphics increment through
  [PR #1594](https://github.com/Automattic/kandelo/pull/1594).
- [x] Landed commit `df8cf7461f23a6d11d4250aadd3c4ddd4789e81e`;
  #1574 closed as superseded rather than merged separately (D-64).
- [x] Preserved mho22's original foundation contribution and the human
  contributor attribution in the landed commit.
- [x] Normal partial graphical build, canonical host build and ABI check;
  117 focused host tests passed on the tested runtime.
- [x] Preserved the actual graphical matrix: Chromium 8/8, Firefox 8/8,
  WebKit 7/8. The WebKit Cage startup failure reproduced in an isolated
  control. These are historical release results, not new-main validation.
- [ ] Complete GLES/EGL conformance, complete B1 validation, native-feel
  acceptance and the full campaign validation matrix.

D-63 explicitly allowed shipping a generally working graphical increment
with unfinished work recorded. It did not turn failures into passes or
remove the remaining campaign requirements. Runtime source
`567dd52debd150f6ad0037b42c2b137be1f980e1` underlies that build;
release documentation accounts for the remaining landed-tree differences.

## Work register

Status vocabulary: **shipped increment**, **open**, **draft only**,
**authorized investigation**, **future expansion**, **verified**, and
**blocked with named cause**. A historical pass is not current acceptance.
Unverified old drafts must be reconciled against current main before use.

| ID | Deliverable | Status at this checkpoint | Principal dependency / acceptance |
| --- | --- | --- | --- |
| R1 | Cage crashes, startup and performance diagnosis | Focused repairs verified; draft #1678, full mixed-memory gate not accepted | Normal candidate, all-engine regressions, retained failures; other crashes and native-feel work remain open |
| M1 | Trustworthy input-to-visible measurement | Open; tooling exists, qualification unfinished | Selected-display qualification, original input identity, overhead and uncertainty |
| M2 | Frozen desktop and game baselines | Open; historical probes retained | M1 for visible latency; pinned workloads, main and native controls |
| Q1 | Stage A production policy and native-operation audit closure | Production increment shipped; closure open | Exact audit inventory, graphics gate, shader harness and full per-case comparisons |
| Q2 | GLES 2.0 API semantics | Substantial implementation shipped; full acceptance open | G01–G10 ledger coverage and applicable upstream case families |
| Q3 | GLSL ES translation and program behavior | Open closure | Shader harness, real pixels and upstream compiler/link/uniform cases |
| Q4 | EGL 1.5 and advertised extensions | Substantial implementation shipped; full acceptance open | Display/context/surface/image/sync lifecycle and dEQP-EGL |
| Q5 | GBM, shared buffers and single-display DRM/KMS | Foundation shipped; closure open | Ownership/coherence, legacy+atomic commits, fences and real consumers |
| D1 | Desktop correctness and usable keyboard controls | Improvements shipped; recorded defects open | Cage/Sway/labwc/wlcompositor/Omarchy, Foot and optional SFWBar coverage |
| D2 | Ordinary shared-memory Wayland clients | Patch retirement implemented/reported; final verification open | Foot, mako, GTK3 and Qt normal rebuilds, Node smokes and browser specs |
| L1 | Asset, process, descriptor and graphics-resource lifecycle | Repairs shipped; closure open | Replacement-resource safety, stale assets, repeated boots and browser-memory |
| B1 | Guest validation, local errors and ownership foundation | Shipped increment; remaining closure tracked in Q/L/M/V | No claim of complete B1 validation |
| B2 | Asynchronous buffer and texture bindings | Draft only; not landed | B1 ownership foundation; ≤10 synchronous requests per produced ScummVM buffer |
| B3 | Guest-local state/object/limit queries | Draft only; not landed | B2; exact state and invalid-call behavior |
| B4 | Program interface fetched once per link | Draft only; not landed | B3; relink, shared deletion and executable lifetime |
| B5 | Kernel-owned shared-timeline fences | Open; not landed | B4; correct ordering and completion semantics |
| B6 | Inline client-array indexed draws | Open; not landed | B5; capture, bounds, lifetime and draw parity |
| C1 | Rust asynchronous scheduling and completion | Designed; not landed | B6; ABI review, FIFO, dependencies, parking, retirement and throttling |
| C2 | Kernel frontend / graphics executor separation | Designed; not landed | C1; in-memory transport equivalence |
| C3 | Dedicated GPU worker | Designed; not landed | C2; bounded transport, isolation, lifecycle, fault and parity checks |
| V1 | Full final compatibility and regression acceptance | Open | Final frozen candidate; matrix below |
| P1 | Final native-feel acceptance and bottleneck fixes | Open; not measured on final tree | M1/M2, staged measurements, all required workloads and engines |
| S1 | Coherent builds, previews, docs and incremental releases | First increment shipped; ongoing per delivery | Normal build appropriate to claim, exact evidence and explicit follow-ups |
| X1–X9 | Separate expansions | Previously deferred / future proposals | Explicit scope selection; never inferred from baseline completion |

Do not use an effort estimate as a readiness promise. At activation, split
each row into reviewable tasks, identify its owner and likely risks, then
estimate against the current code and artifacts. Name any newly discovered
work in this register instead of silently enlarging another row.

## Delivery order and release boundaries

1. **R1:** investigate Cage and propose the smallest useful repair release.
   Capture correctness and performance separately; do not assume the
   recorded startup failure explains every reported crash or slowdown.
2. **M1 then M2:** qualify the recorder and publish reproducible baselines.
   Headless profiling and correctness work can proceed while visible-display
   access is unavailable; visible timing cannot be substituted with them.
3. **Bounded correctness releases:** select Q1–Q5, D1, D2 and L1 slices by
   reproduced failure and dependency. Audit/ownership fixes required by a
   driver stage must precede that stage. Do not bundle unrelated defects.
4. **Driver sequence:** B2 → B3 → B4 → B5 → B6. Drafting ahead with focused
   checks is approved, but land, validate and measure frozen stages in order.
   Offer a normal-built B preview before moving to C1–C3.
5. **Execution sequence:** C1 → C2 → C3, each a separate accepted checkpoint.
6. **V1/P1:** close full campaign coverage and native-feel gates, fixing
   remaining failures at their owning layers. Then select expansions.

Correctness suites and measurements accompany implementation; steps 3 and
6 are not instructions to postpone all testing until the end. A bounded
release may ship without completing unrelated campaign rows only within
the maintainer's agreed release scope. D-63 is the recorded first-release
exception, not a blanket waiver for later stages. No new deferral, boundary
or reduced criterion is implied by this plan.

## R1: Cage investigation and follow-up

- [ ] Reproduce current-main Cage startup/render/input/exit and repeated
  boot/teardown with frozen source, products, browser versions and config.
  Keep the shipped build as a separate historical control.
- [x] Recover the original matrix and isolated-control diagnostics. The
  known WebKit failure displays `LiveKernelHost setup failed` and an
  `UnknownError` before the test reaches rendering assertions. Neither
  OOM nor a browser defect has been established.
- [ ] Distinguish host bootstrap failure, guest/process crash, renderer or
  context loss, resource exhaustion and a responsive-but-slow compositor.
  Capture the operation, process/session generation and last useful event.
- [ ] Exercise keyboard input, wlterm repaint, resize, client exit, Cage
  exit, restart and concurrent load on all three browser engines.
- [ ] Profile kernel scheduling, synchronous graphics requests, copies,
  uploads, native calls and presentation. Use an existing frozen build
  first; a speculative theory does not require a full SDK rebuild.
- [ ] Propose the owning-layer fix with a reproducing regression. Validate
  cleanup and replacement-resource safety, host parity and affected memory
  behavior. Browser/runtime blame requires a standalone reproduction under
  the runtime-workaround policy.
- [ ] Deliver a normally built candidate, before/after evidence supporting
  the exact claim, known gaps and a small follow-up PR. If diagnosis is
  incomplete, report what is known and the next discriminating experiment.

### R1 follow-up checkpoint — 2026-11-09

The original WebKit startup failure is attributed to OPFS root access in
its ephemeral test context, before any guest starts. Cage now uses the
existing persistent-page fixture, and production failures retain the native
cause and name the storage operation. A separate hidden-terminal resize
race stranded output despite successful client exit; fitting after observed
visibility and the next frame repairs that UI ordering without forcing
scrollback or modifying Cage/wlroots.

The normal Sydney candidate, exact commands/products, validation results,
unsuccessful controls and profiling limitations are recorded in the follow-up
PR and its `docs/graphics/cage-reliability-2026-11.md` report. See [draft PR #1678](https://github.com/Automattic/kandelo/pull/1678) and
its [frozen reliability report](https://github.com/Automattic/kandelo/blob/130239b54f3086e4de4d6f5b7ff004b6dbb428d4/docs/graphics/cage-reliability-2026-11.md).
Before the modest-display change, normal graphics passed 30/30 (10 per\nengine), terminal UI 12/12 and host
sessions/PTYs 15/15; normal products, original fixtures and ABI 56/4/17/21
are verified. The maintainer approved the reviewed shared-cache collection;
18.1 GiB logical was collected with all six protected projection keys and
50 frozen source/product identities preserved. The latest complete gate
with stricter containment-warning detection passed source 7, ownership 253,
Node 3, Bun 7 and all 18 browser cases (six per engine, zero skips/flaky/
retries; four mixed-switch cycles each), exit 0 after 28m52s. The earlier
17/18 run remains adverse: a Doom worklet missed its detach acknowledgement,
and replacement Quake audio correctly stayed unprepared. An instrumented
four-cycle WebKit case passed all 20 detachments; a native reduction passed
512 retirements per engine. The original failure remains unexplained, and
the PR stays a draft with that retirement investigation open. The passing
rerun is not an owner repair or permission to waive that finding. There is no performance correction or
native-feel claim, and the original shipment failures remain historical
failures. Other Cage reports are not assigned to either diagnosed cause.
A new normal-runtime pointer workload reproduces the reported severe cursor
slowness: Chromium paints 40 changed cursor states at 1280×612 but only one
at 3840×2052 during 60 mouse moves plus a drain, with the light observer.
Full diagnostics record 8.32 GB of mapped spans, 8.32 GB of copies and 1.16s
inside import synchronization in the 4K case. Readiness/receive handling
couples pointer input to full-image BO scans/imports in the worker that also
services cursor/vblank presentation. WebKit also degrades with output size.
This remains an open high-resolution performance finding. The requested\nmode policy below reduces the workload.
The runtime stayed frozen, and the report retains failed diagnostic attempts
and observer-cost limits. First-load time still needs separation.
The broad B2–B6/C1–C3 campaign remains paused; the full Q/D/L/V/P gates stay
open. The accidentally expanded Freeciv run also retains three direct-display
failures for D1/V1/P1 investigation, rather than silently treating its
unexecuted cases as passing.

### Maintainer-requested modest display, 2026-11-09

The maintainer prefers a usable modest-resolution Wayland demo rather than
native HiDPI output. Sydney now implements an image-owned Cage preferred-mode
limit of 1280×720 CSS-reference pixels, with no Retina supersampling. This
reduces actual guest buffers; it is an explicit pixel-count/sharpness tradeoff,
not a same-resolution repair of the shared graphics coherence path. Other
profiles retain native defaults, and higher standard connector modes remain
available. The prior high-resolution finding stays open. A separate native-scale-2
Chromium probe measures a 7680-pixel native box for CSS width 3840 and the
same 1280×684 guest mode: 21 cursor paints in a 1.021s sweep plus drain,
first change after 34ms. This is a scoped worker-paint observation, not
physical-display latency.

A full normal bootstrap and ABI check pass with unchanged kernel and fixture
cohorts. The normal shell SHA is
44687dd36b9710933356c6846bd29c1e30e9fc09759593db76385a38ccd93152.
New browser cap/input/resize/exit checks pass 6/6 (three engines, densities
1 and 2). Eight scoped cursor observations support the requested tradeoff:
at CSS width 3840, Chromium records 32 cursor paints with guest mode 1280×684
versus two with the preserved 3840×2052 control. These callbacks are not
physical-display latency, and background preparation was active. Actual
normal-entry visible review passes physical keyboard repaint, resize and
foreground exit 0. Initial startup still takes several seconds. The original
graphical matrix is retained at 32/36. Corrected fixture observations pass
12/12 affected cases; a separate Firefox main-Sway case passes 1/1, while
the original intermittent Sway input/workspace findings remain open.
Prepared-product/session checks pass 333/333, host sessions/PTYs 15/15,
and TypeScript checks pass. The default-relay memory gate passes 15/18 but
cannot fetch Keen; a direct public-proxy run passes 12/18 but fails Doom
browser boot-data fetches. A verified same-origin relay preflight passes
6/6; its complete gate then passes 18/18, four mixed cycles per engine,
with source 7, ownership 253, Node 3 and Bun 7 passing, zero skips/retries/flaky outcomes,
exit 0 after 34m11s. All 50 normal source/product/original-fixture identities
match afterward. Each transport keeps its own verdict; no proxy/runtime
code or resource-limit change was used. The earlier unexplained WebKit audio
retirement remains open, so the PR remains a draft. This does not resume the
broader campaign.

### Maintainer-requested shared-buffer repair, 2026-11-10

The maintainer requested a correction to the measured coherence bottleneck
after comparing Cage with Sway and launching `scummvm-play steel-sky` inside
their terminals. The current implementation reuses only authenticated,
quiescent mapping observations and current reader revisions. Large mappings
use bounded native read-only comparisons; changed runs still publish exact
bytes, and reader/device imports advance their baseline from stable canonical
storage so concurrent guest stores remain visible. Unknown memory provenance
or unavailable native comparison keeps the existing byte-comparison path.
No ABI, guest software, memory ceiling or syscall dispatch change is involved.

Cage now requests one guest pixel per CSS pixel of its pane, removing the
temporary 1280×720 cap and Retina supersampling. A frozen partial development
preview at runtime source `b5727e7cdbca` is available while normal validation
continues. Its tracked Cage matrix passes 15/15 across Chromium, Firefox and
WebKit, including input, resize, exit, repeated restart and density checks.
Two Chromium checks launch the actual Steel Sky engine and open its game
menu under Cage and Sway. These checks do not establish gameplay cadence,
physical display latency or native feel. The report retains failed observer
attempts and the older unexplained unpack/retirement outcomes separately.

Source regressions cover exact writes, concurrent stores, split mappings,
native 32/64-bit comparison and the unavailable-capability fallback. Node
passes 14 focused cases; Bun passes the nine coherence/fallback cases.
Additional strict-native checks fail on pinned Bun 1.3.3's unavailable
multi-memory/Memory64 capabilities; standalone probes retain that boundary
without a product workaround. The complete source/memory gate is pending.

Pinned main `e053470fd8140073d811b64eaa6f62cf90978a5c` and the candidate have
completed normal SDK/program/image preparation. Their published host ABI is
5, while the older archived controls above use host ABI 4; program ABI 56
is unchanged. The candidate's default ABI check encountered a later moving
main reference. Its snapshot and frozen-program baseline matched its own
source, and the explicit comparison with pinned `e053470fd8` passed.

The frozen canonical candidate passes 15/15 Cage checks across all three
engines and three actual Steel Sky checks under Cage, with compositor display
ownership preserved. The first Sway observer confused Foot's title bar with
the game. A corrected interior-pixel/window check passes Chromium and Firefox;
WebKit still fails and retains a visibly corrupted Foot frame for investigation.
These are separate results, not six passing game checks.

The fix branch now includes newly pinned main
`8161769ed9d2394e7793bfd82be08cbf890e7145`, inheriting its published host ABI
6 without changing program ABI 56. The merged source ownership/lifecycle
selection passes 267/267 and source graphics passes 2,353/2,353. Normal preparation and the full browser, memory
and paired benchmark gates for that combined tree remain in progress.
The previous full preview stays frozen at host ABI 5. PR #1678 stays a draft.
See its current `docs/graphics/cage-reliability-2026-11.md` for
artifact identities, original failures and exact evidence scopes. The
broader B2–B6/C1–C3 campaign and full native acceptance remain paused/open.

A smaller WebKit Sway/Foot diagnostic preserves a reference grid after 2,000
carriage-return writes, with a changed-grid negative control. Cage fails
before that workload: wlterm wrongly encodes XKB modifier/function keysyms
as Unicode, adding invisible bytes before shifted characters. The native
regression reproduces twelve three-byte emissions and passes after the
translator repair (1/1 Vitest wrapper, UBSan). The strengthened Chromium
Cage case fails the frozen old terminal with `WLTERM_EXIT code=2` instead
of zero. Rebuilt all-engine and Node Cage/Sway shifted-input checks remain
pending. Sydney commits `cf9ad53959` / `3a6b148bac` carry the repair, package
revision 16 and regressions; the published 56514 rendering preview predates
this additional input fix. The separate WebKit game-download corruption is
still unresolved, and no performance/native-feel acceptance is inferred.

## M1/M2: measurement and frozen consumer workloads

- [ ] Qualify selected-display recording: exact owned window/display,
  unlocked/unoccluded session, original input timestamps, actual visible
  application response, clock alignment and capture uncertainty. Fix the
  overlong/ellipsized window identity issue before trusting its results.
- [ ] Measure observer cost using otherwise matched tracing-on/off runs.
  Keep CPU/allocation profiles separate from quiet latency measurements.
  Censor/refuse missing input or visibility evidence; never call it fast.
- [ ] Freeze source, package/asset hashes, browser/version/renderer,
  viewport/window size, refresh rate, config, saves/seeds and workload.
  Record scheduling/load conditions and native control provenance.
- [ ] Establish main and candidate baselines with separate compatible
  artifacts, alternating run order and repeated independent runs. Preserve
  the original results when repeating an experiment.
- [ ] Cover pointer movement, dragging, resizing, scrolling, typing,
  application launch/menus and idle. Run with and without SFWBar, alone
  and under concurrent application load, on Chromium, Firefox and WebKit.
- [ ] Explicitly investigate the recorded pointer p90 regression without
  SFWBar; determine whether display-aligned vblank resolves it or a distinct
  platform bottleneck remains. Retain the original adverse measurements.
- [ ] ScummVM: fixed game/save/scene, produced buffers and synchronous
  requests, real application cadence, software cursor response, CPU and
  memory. A cursor-only result is not whole-application native feel.
- [ ] Freeciv: pin comparable native/main/candidate workloads and assets.
  Cover startup/loading; terrain, units, text, layering and damage;
  pan/scroll/zoom; selection/movement; menus/city dialogs; animation and
  repaint. Separate end-turn computation from rendering and interaction.
- [ ] Report Freeciv input-to-visible map/UI response, cadence, stalls,
  CPU, memory, draw/upload/copy costs and appropriate Node checks. Propose
  additional Freeciv numeric gates after baseline for maintainer approval;
  do not invent them or assume a GPU worker is the solution.

Required acceptance bars remain cumulative:

| Workload / metric | Required bar |
| --- | --- |
| Pointer with SFWBar: original input → commit | ≤16 ms p90 |
| Pointer with SFWBar: original input → display | ≤2 refresh intervals p90 |
| Pointer: original input → display | ≤1 refresh interval p50; ≤2 p95 |
| Typing | ≤20 ms p50 |
| ScummVM | ≥30 fps; cursor response ≤33 ms p50 |
| Motion, dragging, resizing and scrolling | Display cadence, with missed frames reported |
| Platform interaction stalls | No recurring stalls >50 ms |
| Idle kernel worker and GPU worker when present | Each ≤5% CPU |

Report sample counts, p50/p90/p95 and tail/max observations, refresh
intervals, missed frames, idle/active CPU, memory and instrumentation
overhead per engine and load cohort. Sparse capture must retain its
uncertainty. Average FPS, isolated microbenchmarks and projected gains do
not establish native feel. No new percentile or numeric tolerance is
implicitly an approved substitute for the bars above.

## Q1–Q5: compatibility and audit closure

- [ ] Reconcile each existing ledger requirement with landed code and
  current executable evidence; identify open work by stable ledger ID.
  Old notes saying implemented are not sufficient acceptance evidence.
- [ ] Q1: verify the Stage A production contract: guest acceptance uses
  prediction, without per-call native `getError`; sample native errors
  once per submitted batch. An unpredicted native error resets only that
  context with a loud production diagnostic and is fatal under audit.
  Native OOM resets the context as the documented platform boundary.
  Preserve exact native checks needed for private ownership/publication.
  Verify the approved one-time diagnostic for an unavailable c=0.5 texture
  sampling variant (D-55), and keep the known EGL shared-render performance
  timeouts attributable to synchronous binds visible through B2 (D-56).
- [ ] Resolve or prove repaired the recorded native-operation findings:
  unchecked muxer replay and present blits; drains that could swallow
  guest errors; compressed cube faces reallocated with zero length;
  cube export `EIO` versus `EINVAL`. Attach current regressions/results.
- [ ] Q2: close GLES2 objects/state, buffers and client/indexed draws,
  uniforms, textures/cube maps/compression, FBOs/renderbuffers, raster,
  depth/stencil/blend/clear/readback, ordered errors and all core symbols.
- [ ] Q3: close translated-shader loop-indexed sampler arrays and remaining
  ESSL100 compile/link/reflection/name/type/uniform behavior. Prove output
  pixels and errors rather than only accepting generated source.
- [ ] Q4: close EGL display/config selection, current-thread ownership,
  contexts, window/pbuffer/surfaceless surfaces, resize/swap, image sharing,
  sync and advertised extensions. Preserve deferred-destruction semantics.
- [ ] Q5: verify GBM allocation/map/unmap/import/export, format and layout
  validation, dma-buf identity/lifetime, CPU/GPU coherence and write counts;
  legacy/atomic KMS, vblank, cursor, gamma, events and explicit/implicit
  fences. Exercise pointer widths promised by the platform.
- [ ] Run graphics gate, shader-rewrite harness and per-case dEQP-GLES2
  plus dEQP-EGL comparisons on all three engines. Preserve exact upstream
  applicability rather than skipping families or converting unsupported
  outcomes into passes.

## D1/D2/L1: desktops and lifecycle

- [ ] Retest historical labwc and labwc+SFWBar spec failures, Firefox-only
  SFWBar-on-Sway failure, and Omarchy on the new wayland-demo. Preserve
  originals; passing a different smoke does not resolve a failure.
- [ ] Diagnose Foot's intermittent redraw stall and intermittent extra
  launch separately; reproduce launch, input, repaint, exit and cleanup.
- [ ] Keep the Sway demo's native workspace bar and no default SFWBar.
  Test optional SFWBar separately. Verify terminal launch, focused-tile
  close, focus/move/resize/workspace keys and user-visible help on macOS
  and Windows/browser combinations. Test browser-reserved shortcuts and
  keyboard layouts rather than assuming one modifier works everywhere.
- [ ] Retain fluid simulation and GLSL video/audio as regressions: the
  reported blank/flickering demos were repaired for shipment; selected
  release cases pass on three engines. Verify current candidates too.
- [ ] Retire/verify retirement of Foot, mako, GTK3 and Qtbase wl_shm
  DRM-pool patches through normal builds now that wlcompositor maps memfd
  pools. Run their Node smokes and browser specs and compare performance
  before/after; document exactly which patch was removed and its proof.
- [ ] Preserve the specifically approved generic, potentially upstreamable
  SDL2 disabled-display restore correction. Do not extend that exception
  into permission for unrelated ported-software adaptations.
- [ ] Verify stale service-worker-cached lazy assets fail loudly rather
  than producing tofu text or a partially broken desktop. Cover mixed
  asset generations, missing/altered data and reload/upgrade behavior.
- [ ] Verify descriptor/open-file-description ownership: delayed cleanup
  cannot close or mutate a replacement descriptor, display or resource.
  Include fork/exec/exit, cancellation and shared-resource retirement.
  Preserve D-59's loud rejection of inherited native Wayland connection use
  or cleanup after multithreaded fork until exec/exit; do not silently
  reinterpret inherited connections as safe to use.
- [ ] Repair obsolete shared-mapping fixtures without weakening ownership
  assertions. Recheck partial mappings, receive-completion publication,
  BO cleanup and worker absence/retirement at their actual owners.
- [ ] Verify repeated desktop boot/teardown, memory ceilings and graphics
  resource cleanup on three engines, with the browser-memory suite and
  manual browser checks. Do not give persistent realms guest memory.
- [ ] Reconcile the original `/proc/<pid>/maps` fidelity findings:
  `mprotect` visibility, renamed files and `/dev/zero` naming. Verify any
  claimed repair on the current kernel; retain unresolved platform gaps.

## B2–C3: architectural stages

Keep the detailed historical worker design and preserved drafts as inputs,
not executable authority or proof of current compatibility. Promote any
newly chosen protocol details into tracked architecture documentation
before implementation. Each stage requires inline Why comments covering
ownership, ordering, validation, parity and performance-sensitive choices.

| Stage | Implement | Prove before calling the stage accepted |
| --- | --- | --- |
| B2 | Encode asynchronous binds; preserve guest state, ordered errors, shared-object lifetime and uncertain-state handling | Binding/negative-API regressions, application rendering, audit parity and ≤10 total synchronous requests per produced ScummVM buffer |
| B3 | Authoritative guest state, object, limit, string and precision queries; safe conservative handling where knowledge is incomplete | Query/state dEQP parity, shared-context/invalid-call controls and reduced measured requests |
| B4 | One complete program interface per link; local locations/reflection with generation-safe ownership | Failed relink, current executable versus latest link, shared deletion, location stability and real shader consumers |
| B5 | Kernel fence authority for the shared timeline; preserve native/result-dependent paths where required | Ordered completion, waits, export/import, implicit dependencies and accurate request attribution |
| B6 | Owned inline vertex/index snapshots and bounded client-array submission | Bounds, index conversion/promotion, buffer/client mixtures, lifetime/fault tests and rendered output |
| C1 | Rust FIFO job scheduling, foreign-fence dependencies, result-call parking, execution completion, deferred retirement and swap throttling | Deterministic ordering/cancellation/loss tests; ≤2 frames in flight per surface; required POSIX, graphics and consumer checks |
| C2 | Separate kernel-facing frontend and graphics backend using an in-memory transport | Equivalent results, errors, faults, ordering and cleanup; measured transport cost |
| C3 | Disposable GPU worker, bounded copied command ring/doorbell, canvas transfer, BO sharing, batched completions, loss/fault propagation and progress diagnostics | GPU work isolated from kernel scheduling, truthful fences, bounded backpressure, worker teardown, context-loss/fault injection, memory and all-engine application measurements |

The GPU worker must not retain guest Wasm memory; copy inputs at submit.
Keep KMS authority in the kernel and display effects ordered with graphics.
Do not use blocking `Atomics.wait` in a browser graphics executor that must
return to its event loop to present. Preserve FIFO across contexts and
healthy-peer resources when one context fails. No polling or unused-feature
per-draw/per-frame cost is introduced for convenience.

Node has no supplied GL renderer under the approved D-6/D-37 scope. Test
Node kernel/device/scheduling/protocol behavior and loud renderer absence;
use the approved null-renderer device-worker design for protocol parity,
not a claim of Node GPU rendering. Browsers carry real GL rendering proof.

**ABI review is an activation prerequisite for C1 and other interface
changes.** The shipped family is program 56 / host 4 / GL 17 / fork 21.
The old design's permission to extend *unpublished host 3* is obsolete.
Host 4 has shipped. Preserve the current family wherever compatible;
never reuse a published number for an incompatible contract. If a stage
requires an incompatible change, present that concrete conflict to the
maintainer before implementation. This plan authorizes no new ABI bump,
compatibility shim, baseline replacement or silent semantic change.

## V1: complete final-tree validation

Run relevant checks during each delivery and the complete matrix on the
final frozen candidate. Record exact commands actually executed, versions,
source/artifact hashes, selected/discovered/completed counts, exits and
per-case outcomes. A timeout, missing fixture, load error, interrupted run
or zero selected tests is not a pass. Repeated diagnostics never replace
the original result.

| Area | Required final evidence |
| --- | --- |
| API compatibility | Full pinned dEQP-GLES2 and dEQP-EGL on Chromium, Firefox and WebKit, compared per case with the recorded baseline; performance/stress and applicable extensions included |
| Translation and host graphics | Graphics gate, shader-rewrite harness, negative/state/lifetime and rendered-pixel regressions |
| Desktops and consumers | Full relevant Cage, Sway, labwc, SFWBar, wlcompositor/Omarchy, Foot, Freeciv, ScummVM and graphical-demo specs on three engines |
| Host and kernel | Full artifact-backed host Vitest; Rust, xtask, ABI/snapshot, persistent-program baseline and evidence-class checks |
| Lifecycle and memory | Browser-memory, repeated boot/teardown, fault/context-loss tests and worker/resource retirement |
| POSIX | libc-test, Open POSIX and Sortix on Node and browser, with actual case inventories and truthful expected gaps |
| Performance | All benchmark suites on Node and browser against pinned destination main, plus application/native controls and P1 distributions |
| Product | Coherent normal build, served-product verification and manual browser checks; availability announced separately from validation |

Use the current [validation guide](../agent-guidance/validation.md),
[performance guide](../agent-guidance/performance.md) and conformance guide
for commands rather than copying stale private launchers. Baseline full CTS
inventories record 19,825 GLES2 and 4,117 EGL cases at the coverage map's
upstream pin; enumeration is not execution or a universal applicability
claim. Explain every missing, skipped, unsupported or changed case.

## S1: repeatable delivery, evidence and operations

For every selected delivery:

1. Record one outcome, included IDs, exclusions retained elsewhere, owner,
   dependencies, source baseline, regressions and acceptance commands.
2. Profile/reproduce first. Use focused checks for drafts and incremental
   experiments; rebuild actual changed inputs through normal tooling.
3. Freeze each candidate before tests. Land and measure driver/executor
   stages separately. Never mutate an already published preview's inputs.
4. Build the normal products required by the claim. Label partial graphical
   images with their package selection; they do not validate all packages.
   Preserve rAF vblank export, wlcompositor fixes, lazy xkb data, shell eager
   budget and integrated host changes in the coherent preview. The old r9
   build request is product-coherence work, not a reason for a cosmetic
   rebuild of an unchanged historical version.
5. Announce a runnable preview promptly with source, artifact identity,
   checks passed and blockers. Distinguish availability, stage completion,
   full conformance and native-feel acceptance. Preserve the requested
   existing preview URLs, including port 6271, until explicitly retired.
6. Review inline Why comments and authoritative docs. Update this register,
   architecture, compatibility evidence and future improvements together.
   Use a short Why-first PR with validation and explicit follow-up IDs.
7. Commit and push meaningful progress. At landing, report exactly what
   shipped and the next bounded proposal; do not resume the whole backlog
   automatically. Keep human attribution; never add tool attribution.

Operational constraints remain binding: canonical dev shell; one rebuild at
a time with disk checks; safe cache GC and no deleting active/unique
evidence; `agent-job` and its wait command for long jobs; frozen run inputs;
unique Playwright ports/run UUIDs/private outputs; no sleep-poll loops,
stash, destructive reset or path checkout; no stopping others' servers.
The maintainer authorized Sydney to replace the retired Moscow integration
workspace for this Cage follow-up’s commits and pushes on 2026-11-09. The
original frozen preview worktrees remain controls and must not be switched
or overwritten. No merge is authorized by that location change. Do not commit local
macOS launcher hacks or patch ported software to fit platform defects.

Keep compact reviewed evidence: command, verdict, counts, identities,
per-case differences, measurement distributions and diagnostic conclusions.
Retain unique failed traces and native controls. After review, release
reproducible bulk scratch through the supported evidence lifecycle and
record what survives. Report logical file allocation separately from
physical disk recovery on APFS. Do not rebuild merely to recreate a
discarded passing trace.

An optional validation-runner improvement can encode these manifests,
dependency checks, resumable jobs and comparisons using existing tooling.
Scope it separately if needed; building a new orchestration framework is
not an implicit prerequisite for the next graphics fix.

## Separate expansion register

These are preserved proposals/approved deferrals, not silently activated
baseline tasks. Each needs its own design, build, compatibility, performance
and release scope. Existing approved differences remain in the ledger.

| ID | Expansion | Work to scope |
| --- | --- | --- |
| X1 | GLES 3.0 | Complete API and GLSL ES 3.00; mapping/format/swizzle/restart/sync gaps; ES3 EGL configs/contexts and dEQP-GLES3 |
| X2 | IGT GPU Tools | Port runner/tests and `sw_sync` device; replace or supplement named Rust/guest mirrors with upstream execution |
| X3 | Multiple displays | Extra connector/encoder/CRTC/plane authority, per-output vblank/hotplug, browser surfaces, pointer mapping and measured presentation cost |
| X4 | Node GL renderer | Choose an embedder/backend, provide real rendering and resource lifecycle, then establish Node rendering acceptance |
| X5 | wasm64 compositor packages | libffi dispatch/closures, Rust-dependent libraries, dependency recipes, wlroots/desktops and memory budgets |
| X6 | Additional formats and layouts | 10-bit/FP16 window surfaces, KMS YUV scanout, non-linear/multi-plane layouts, truthful caps and costs |
| X7 | Optional GL/EGL and legacy Wayland sharing | Timer/debug/normalized-format extensions, `EGL_WL_bind_wayland_display` and GBM WL_BUFFER import where justified |
| X8 | Direct guest-to-GPU queues | Reconsider after C3 only if measured submission-hop cost warrants capability/revocation/fence complexity |
| X9 | Remaining driver coverage | Inventory conservative/slow paths and application needs after B/C; improve only with preserved semantics and measured benefit |

The next expansion proposal should explicitly consider X9, X1, X2 and X3:
remaining driver work, GLES3, IGT and multiple displays. Do not reopen an
already decided deferral just because it appears in this inventory.

## Maintenance and next-delivery record

Update this document in each delivery PR, with detailed receipts in the
compatibility ledger rather than appending another unbounded history here.
The work register is the campaign index; it does not duplicate every test
assertion or overrule maintainer decisions.

| Field | Current value |
| --- | --- |
| Selected next work | Validate shared-buffer coherence repair and CSS-sized Cage output; retain transport, Sway, unpack and PCM retirement findings |
| Implementation/release scope | Browser storage diagnostics, terminal visibility/fit, shared-buffer synchronization and image-owned Cage display policy; preserve published program/graphics/fork contracts and inherit pinned main's host ABI 6 |
| Research inputs | Preserved shipment controls, current-main-based normal reproduction, standalone OPFS/xterm controls and frozen Cage copy/native-call profiles |
| Main risk | Startup failure and reported runtime crashes/slowness may have different causes |
| Exit from investigation | Current partial rendering/input checks pass; canonical preparation, paired performance and full memory validation remain pending. Historical configured memory passes do not validate this revision. Default transport, Sway, unpack, PCM, M1/M2, D1/D2, L1 and V1/P1 remain open |
| Broader campaign state | Paused pending intentional delivery selection; no blanket activation by this plan |

Completion of the baseline campaign requires Q/D/L closure, accepted B/C
stages, V1 and P1, coherent previews and updated documentation. Shipping
individual improvements before that point remains useful and must be
described as such.
