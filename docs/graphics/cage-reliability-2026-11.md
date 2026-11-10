# Cage reliability follow-up — 2026-11-09

Status: draft follow-up. Startup and terminal-handoff repairs are implemented.
At the maintainer's request, Cage now chooses a modest guest display bounded
by 1280×720 reference pixels, including on HiDPI displays. The new normal
image passes rendering/input/resize/exit checks at browser densities 1 and 2
in all three engines. Cursor observations support this pixel-quality tradeoff;
they do not establish a same-resolution renderer speedup. The underlying
high-resolution whole-buffer coherence cost and the earlier intermittent
WebKit audio-retirement finding remain open. The default development-relay
memory gate now passes 15/18; all three mixed cases stop at a required DOS
archive fetch returning HTTP 502. A separate full run using the documented
production proxy configuration is pending. The original broader graphical
run is retained at 32/36; corrected affected cases pass 12/12.

This delivery investigates work package R1 after #1594. It does not activate
B2–B6/C1–C3 or claim full graphics/native-feel acceptance.

## Historical control and startup cause

The shipped runtime source is `567dd52debd150f6ad0037b42c2b137be1f980e1`.
Its normal partial shell image is 822,871 bytes, SHA-256
`7707782608bbcf19d1ce04111f6df96339577168cbe483dddda8bd6598fb9449`;
kernel SHA-256 is
`0ac8a09beb8938dc69af49a53d29ea46c5d2f3a129176d4b0b8994097fb64fdc`.
The served image and control sources were retained unchanged. The original
23/24 graphical matrix and separate 0/1 WebKit control remain failures in
the release record.

A page-init observer, without editing the served runtime, identified the
rejection: `BrowserComputerStore.cleanup` calls `browserComputersDirectory`,
and `navigator.storage.getDirectory()` rejects with `UnknownError`. This
precedes machine construction, guest launch and graphics. Neither the message's
example "out of memory" nor this observation establishes memory exhaustion.

The Cage spec used Playwright's ephemeral browser context. Sway and Freeciv
already use the repository's persistent-page fixture, which documents the
WebKit OPFS difference. A standalone page containing only OPFS root/file
write/read operations failed all three calls in each of four ephemeral
WebKit configurations (ordinary/short home/short temp/both short). Changing
local paths did not repair it. Switching only the Cage test's fixture to the
existing persistent-page fixture passed the original real GLES2 render,
idle, input/repaint and wlterm-exit case on all three engines, with the
same shipped runtime. This repairs the test construction; it is not a
new browser-runtime defect or a compositor workaround.

Production storage failures now retain their native error as `cause` and
identify `navigator.storage.getDirectory` and the native name/message in
the visible setup failure. There is one attempt, no fallback and no inferred
OOM classification. Subdirectory errors keep their original handling.

## Terminal handoff after hidden resize

Repeated live Cage boots exposed a separate failure: Cage and wlterm exited
with status zero and released DRM ownership, yet the Terminal view did not
show the exit line or shell prompt. The kernel emitted those bytes, the real
PTY subscriber received them, and xterm's retained buffer contained them.
On failure the terminal had 39 rows, baseY 28 and viewportY 23; its scrollbar
still used a 660-pixel viewport while the resized renderer was 585 pixels
high. A requested scroll to the bottom was clamped five rows early.

The Shell fitted immediately upon reveal, before xterm's visibility observer
resumed its suspended renderer. A standalone xterm/FitAddon hide/resize/output
fixture reproduces the stale scroll range without running Kandelo. Waiting
for observed visibility and fitting on the following animation frame removes
that race in the isolated three-engine check. This is an integration-ordering
repair; no browser-engine fault, guest crash or resource exhaustion is inferred.

The candidate schedules fitting after observed visibility, keeps the existing
terminal/parser state, and cancels its own observer/frame on disposal. It does
not force scroll-to-bottom or change deliberate scrollback. In the real Shell
fixture the original source fails to show EXIT_MARKER_0 after a hidden resize.
The private candidate shows all six exit/prompt markers and preserves a
user-selected historical viewport on Chromium, Firefox and WebKit. These
private source-overlay checks are diagnosis evidence, not final normal-build
acceptance. Three additional component runs verify that retiring a hidden
terminal leaves the replacement PTY's resize ownership intact. All nine real
Cage runs (three repeats per engine, six boots per run) pass with the same
source overlay and frozen normal products. The actual tracked Sydney source additionally passes all 12 terminal repaint
and removal cases across the three engines, with the normal browser app
TypeScript checks (144 browser roots and 46 Node unit-test roots). Current-main-based normal-product results are recorded below.

## Existing canonical-image budget mismatch

The first current-main-based normal build failed before it could publish the
shell: 156 eager files exceeded the recorded limit of 150. Its 2,414,611 eager
bytes were within the 2,436,000-byte ceiling. An independent existing canonical
image built from the same main revision contains the same 156 unique eager
inodes and 2,414,611 bytes; its compressed size is 1,076,107 bytes, SHA-256
`1ef13e892a40b17b3ec30bdef92bde712b44f88f44e4ff6d47a794b991943a1a`.
This reference image was read for attribution, not borrowed as a candidate.

A budget-era image has 146 eager files. Accounting for relocated paths, the
net increase is twelve existing bootstrap files minus the two retired ScummVM
ZIP dispatch files. The additions are game/ROM exchange dispatch, the page
terminal and preview publishers, a Rust login profile, and web-stack and
WordPress-family session-client descriptors. They route startup and exchange
input before selecting/fetching optional runtime archives. The budget update
records the existing payload and permits 160 files (four of slack), retaining
both byte ceilings. It adds no eager file. The seven existing budget tests,
including limit rejection and headroom checks, pass. The successful full normal build and its exact final artifact identity
are recorded below.

## Performance observations

Frozen workload: after the shell prompt and download-toast completion, focus
the real KMS canvas and type `echo cage-profile-0123456789` plus Enter with
40 ms per key. Viewport 1280×720, active output 1280×612, desktop memory
profile, native GLES2 Cage/wlterm. Chromium 153.0.8010.12, Firefox 155.0 and
Playwright WebKit 26.6. All engine results below belong to this shipped build,
not a claimed current-main/candidate performance comparison.

The diagnostic evaluates instrumentation in the kernel worker before native
GL methods are captured, then resets counters after boot. It aggregates
`Uint8Array.set`, native WebGL method wall time and the existing syscall
profiler. A separate attribution run retains stacks for copies ≥64 KiB.
The largest stacks are `GbmBoRegistry.syncImportsForPid`, refreshing both
the mapping and its snapshot with full 3,133,440-byte copies at readiness
boundaries. This synchronization preserves shared-buffer coherence.

| Diagnostic | Chromium | Firefox | WebKit |
| --- | ---: | ---: | ---: |
| Instrumented observation window, ms | 1402.59 | 1477.40 | 1484.60 |
| Profiled syscall-handler calls | 1418 | 1344 | 1602 |
| Syscall handler wall time, ms | 107.82 | 129.46 | 75.76 |
| PID 101 ioctl handler calls | 700 | 661 | 824 |
| PID 101 ioctl handler wall time, ms | 98.44 | 111.88 | 62.18 |
| U8 set input bytes | 6,611,774,875 | 6,304,683,934 | 7,316,826,584 |
| U8 set measured wrapper time, ms | 258.35 | 187.46 | 121.38 |
| texSubImage2D calls | 1144 | 1040 | 1300 |
| Upload input bytes | 68,935,680 | 62,668,800 | 78,336,000 |
| Upload call wall time, ms | 2.32 | 14.14 | 2.42 |
| drawArrays calls | 21 | 20 | 25 |
| blitFramebuffer calls | 49 | 38 | 54 |
| Blit call wall time, ms | 0.14 | 0.30 | 0.26 |
| getError calls | 734 | 624 | 832 |
| getError wall time, ms | 77.78 | 53.96 | 14.82 |

These are exploratory profiles, not uninstrumented timings. Copy timing includes
stack-attribution overhead, wrappers perturb native dispatch, and an unrelated
workspace build ran concurrently. Input pacing, screenshot observation and
browser automation contribute to the window. CPU call duration does not
measure deferred WebGL/GPU execution, fence completion or display latency.
Syscall-profiler handling time and copying can overlap; do not add these
columns into a timing budget. Gaps between syscalls include parked waits and
host scheduling, not solely guest execution. Presentation blits and page-flip
counters show submitted work, not proof of visible-display cadence.

The evidence identifies copying and synchronous graphics/error-query traffic
as leads. It does not justify weakening buffer coherence or removing native
validation. No performance correction was made. Broad benchmarks, native
controls, observer-cost qualification and input-to-visible distributions
remain in the already open M1/M2/P1 work; no native-feel claim is made.

## Commands and raw evidence

Recovered into Sydney `.context/cage-r1-evidence/` (with an additional
`.context/cage-r1-backup-20261109T070847Z/` preservation checkpoint):
`shipped-control-identity.json`, `diagnostic.{spec,config}.ts`,
`diagnostic.sh`, `diagnostic.log`, `diagnostic-results.json`, the standalone
`opfs.*`, and `cage-control.*`. All run through `scripts/dev-shell.sh` with
unique Playwright run UUIDs, private outputs, one worker, zero retries and
the shared silent-audio fixture. The profile4 script/spec/config, JSON and
log retain the table's exact workload and complete counters; profile3
retains copy-attribution stacks. The original release matrix/control traces remain in the external Moscow
archive. Retained private diagnostic failures, including fixture-assumption
failures, have separate outputs and were not overwritten by later results.
The original Moscow checkout disappeared during its normal build; that failed build and an
interrupted viewport diagnostic do not count as acceptance. Sydney's recovery
checkpoint records the recovered source, results and their remaining gaps.

A passed historical control is not current-main acceptance. Other reported
Cage crashes are not attributed to OPFS by this startup diagnosis.

## Normal candidate and acceptance

The Sydney candidate starts from main
`a3490ca0f48d7c249592925cb7b4ac1ab74b9c2a`. Its seven-file source patch at the normal build has SHA-256
`6392d02bd1fff61020a7519eed0b8dc7c08c57ad870297ab16c48eca602754c2`.
The subsequent corrections to the mixed-memory test are test-only: it waits
for actual shell text, focuses the Cage canvas instead of clicking it, and
uses the normal Escape path to release pointer capture before dock
navigation after deliberately mouse-testing a compositor. These fixture
changes add no runtime/product input. A fresh 50-entry receipt before that gate
matches every product, source-owner and original fixture identity from the
successful normal build.

The normal `./run.sh setup`, `bash scripts/build-programs.sh` and
`bash scripts/check-abi-version.sh` completed successfully in the declared
dev shell (job `cage-r1-normal-budget-accounted-1109-035733-1a12`).
No partial-image fallback was used for this candidate. No guest program,
kernel, SDK, syscall or ABI implementation changed. Both original v55/v56
fixture cohorts remain hash-bound to their manifests; the shipped family
remains program 56 / host 4 / GL 17 / fork 21.

| Product | Bytes | SHA-256 |
| --- | ---: | --- |
| Normal shell image | 1,076,101 | `1024edcac14dac7620070ee90a45d6bd2a62fbc36f56f1bd008ff31568f8075b` |
| Kernel | 2,919,292 | `0ac8a09beb8938dc69af49a53d29ea46c5d2f3a129176d4b0b8994097fb64fdc` |

The fresh normal shell has 156 eager files and 2,414,611 eager bytes. Its
compressed encoding is six bytes smaller than the independently identified
budget reference above; these are separate byte identities, not a claim
that the two compressed images are identical.

The preview runs through the actual `./run.sh browser --host 127.0.0.1
--port 56501 --strictPort` entry point. The Chromium visible review passed
rendered shell output, physical keyboard repaint, a host viewport resize,
wlterm exit, automatic Terminal selection and foreground Cage status zero.
The rendered screenshots (`candidate-cage.png`, `candidate-exit.png`) were
inspected. Available preview and completed validation are separate claims.

The selected browser inventory is the original eight shipment checks plus
the two new Cage cases: ten per engine. Each constrained Cage lifecycle
case boots six times, alternates live restarts with clean client exits,
checks visible keyboard repaint and host resize, and retains the same page
realm with no memory-boundary or runtime-error reports.

| Check | Result | Retained run / log |
| --- | --- | --- |
| Normal products, test programs and ABI | Pass; 259 programs stamped; both native widths and snapshot/baseline agree | `cage-r1-normal-budget-accounted-1109-035733-1a12`, `candidate-budget-{setup,programs,abi}.log` |
| Browser app TypeScript | Pass; 144 browser roots, 46 Node unit roots | `candidate-typecheck.log` |
| Storage diagnostic unit | 3/3 pass | `storage-unit-source-only.log` |
| Existing image budget tests | 7/7 pass | `budget-unit.log` |
| Actual terminal repaint/removal regressions | 12/12 pass, three engines | `cage-r1-ui-candidate-1109-033650-9403`, `ui-candidate-results.json` |
| Selected normal graphical matrix | 30/30 pass; Chromium 10, Firefox 10, WebKit 10; no skips/retries | `cage-r1-selected-desktops-1109-092408-4ecb`, `selected-browser-results.json` |
| Host Cage/wlterm/Sway/PTY selection | 15/15 pass in eight files; no skips/load failures | `cage-r1-normal-host-1109-091736-2d84`, `candidate-host.log` |
| Normal visible Cage review | 1/1 pass; both screenshots inspected | `cage-r1-normal-manual-1109-091735-cb73`, `manual-review-results.json` |
| Latest browser-memory gate execution | Pass: browser 18/18, zero skips/flaky/retries; source 7, ownership 253, Node 3 and Bun 7 passed; earlier audio failure remains open | `cage-r1-memory-containment-1109-120622-4ef4`, `candidate-memory-containment.log` |

All claimed browser runs use the shared silent fixture, private run UUIDs,
one worker and zero retries. Browser identities are Chromium
153.0.8010.12, Firefox 155.0 and Playwright WebKit 26.6; Node is v24.15.0.
The visible review starts at 1280×720 and resizes to 1000×640; selected
matrix defaults to 1280×720 and the Cage lifecycle explicitly alternates
1000×720 and 1280×800. Native Safari and visible-display/native-feel timing
were not run.

Commands actually executed through `scripts/dev-shell.sh` include:

```sh
./run.sh setup
bash scripts/build-programs.sh
bash scripts/check-abi-version.sh
./run.sh browser --host 127.0.0.1 --port 56501 --strictPort
# In apps/browser-demos, with the private selected-browser.config.ts:
node node_modules/playwright/cli.js test --config "$evidence/selected-browser.config.ts" \
  test/kandelo-cage.spec.ts test/kandelo-sway.spec.ts test/kandelo-freeciv.spec.ts \
  test/kandelo-modeset.spec.ts test/kandelo-sdl2.spec.ts test/kandelo-scummvm.spec.ts \
  --project=chromium --project=firefox --project=webkit --workers=1 --retries=0 \
  --reporter=line,json
# In host:
node node_modules/vitest/vitest.mjs run \
  test/browser-computer-storage.test.ts test/cage-smoke.test.ts test/wlterm-smoke.test.ts \
  test/sway-smoke.test.ts test/pty-ownership.test.ts test/pty-readiness.test.ts \
  test/terminal-attributes-api.test.ts test/wlterm-vt100-unit.test.ts --maxWorkers=1
# At repository root:
./run.sh test browser-memory
```

`$evidence` above denotes this run's Sydney `.context/cage-r1-evidence`
directory. The private config disables automatic server startup, points to
56501, and selects exactly the ten titles below with an end-anchored regular
expression; normal global setup remains enabled. `selected-inventory.log`
records the runtime inventory. The final JSON assertion requires exactly
30 expected outcomes, zero unexpected, zero skipped and zero flaky.

- Cage storage bootstrap diagnostic; Cage GLES2 wlterm; Cage six-cycle
  resize/exit/live restart.
- Freeciv SDL2 main menu; modeset PAGE_FLIP; packaged ScummVM GUI/pointer.
- SDL2 editor/shader; opaque primary scanout between flips/vblank.
- Sway tiled Foot/native bar; Sway Activity/Alt+Enter/clean exit.

The Node selection uses the normal resolver, preferring verified SourceOnly
products while allowing freshly built local fixtures. Node's actual
wlroots sessions use pixman because Node has no supplied WebGL renderer;
the real GLES2 proof belongs to the browser matrix. The OPFS diagnostic is
browser-only and changes no Node storage API. The Shell fix owns browser
layout and changes no shared PTY implementation.

The all-package artifact-closure advisory check returned exit 1: 150
closures complete, 11 incomplete, one failed and ten not built. Incomplete
entries include the dormant CTS/test packages and optional consumers; the
failed entry is a default-tier `less` mirror generation. This is not a
passing all-package check. Selected suites still resolve their actual
normal products and fail loudly on missing prerequisites. See
`candidate-closures.log` for the exact inventory.

The full artifact-backed host suite, POSIX/libc/Sortix and full graphics
CTS/benchmark matrices were
considered and were not run for this browser storage diagnostic and
terminal layout change. No shared runtime, syscall, ABI or ported-program
semantics changed. This is bounded R1 evidence, not V1, complete B1 or P1
acceptance. M1/M2, Q1–Q5, D1/D2, L1 and V1/P1 retain their broader work;
B2–B6/C1–C3 remain paused. No new compatibility exception is introduced.

## Retained unsuccessful runs

The original 23/24 shipment and isolated WebKit startup failure remain
unchanged. The old terminal source fails the hidden-resize marker control;
earlier scroll-after-write/render candidates did not resolve the stale
scroll range and were discarded. Their private logs and traces remain.

Provisioning failures are not passes: the archived Moscow build lost its
checkout; Sydney's overbroad `setup --all` was stopped with exit 143 while
building optional Waybar; an operator-chosen 16 GiB reserve refused a run;
the first bounded normal build failed the existing 150-file budget; and a
diagnostic `./run.sh build shell` invocation used the wrong target name and
failed (the target is `shell-vfs`). The diagnostic source was restored
before the successful normal build. A default-global-setup unit invocation
was interrupted with exit 130 before the focused source-only unit run.
The first full browser-memory gate passed its source/host/Node/Bun phases
but was interrupted with exit 130 while its first browser case was blocked
on a Library click (job `cage-r1-browser-memory-1109-092353-5b31`). Its trace
shows visible Cage shell output and `CAGE_MEMORY_0`, followed by the canvas
intercepting dock pointer events: the keyboard-only fixture's preceding
body click had acquired pointer capture. The corrected fixture focuses the
canvas without a click, waits for rendered shell text and download-overlay
completion, and then tests the actual repaint. The original trace and
screenshots remain under `memory-pointer-capture-original-trace` and the
original Playwright run `1ee5bc94-c700-45c2-96fc-a505794c99ae`. No browser
memory result from the interrupted run is counted as a pass. The next full
gate progressed past Cage and reproduced the same capture problem after
labwc's deliberate mouse/keyboard check; it was stopped with exit 130
(job `cage-r1-memory-focus-1109-094950-dce7`, retained
`memory-labwc-capture-original-trace`). The local switch helper now presses
Escape and observes actual pointer-lock release before navigating the dock,
leaving the guest alive for ordinary machine teardown. A complete one-cycle
Chromium diagnostic then passed all consumers through WordPress (job
`cage-r1-memory-one-cycle-1109-095857-d4a6`, 1/1). That diagnostic is not a
substitute for the final four-cycle, three-engine gate.

The implementation/test source for that completed full memory run is commit
`09bc20e805`, including the
earlier `037d5b4c07` budget and `218f7cfd4d` browser repair. Its eight changed
implementation/test/budget files are SHA-bound in
`final-implementation-file-identities.json`; documentation commits add no
runtime changes.

No original failure was overwritten or converted into a skipped pass.

The current-main-based original ephemeral WebKit test fails 0/1 on the new
normal products too (job `cage-r1-main-opfs-control-1109-091809-1a49`). Its
retained error context names `navigator.storage.getDirectory` and the native
`UnknownError` before the Running state or any guest. This control includes
the diagnostic wrapper and is not described as a pristine whole-main build.

The first private desktop selector mistakenly chose all 159 cases in six
current spec files instead of the original release selection. It was
intentionally stopped with exit 130 after 8 passes and 3 Freeciv failures;
148 cases were not executed/skipped. The complete adverse JSON, traces and
stop receipt remain in `candidate-browser-results.json`, `candidate-browser.log`
and `expanded-matrix-stop-receipt.json`. A multiplayer case also logged a
Freeciv `null function` in `science_report_dialog_popup`; its test outcome
was a pass, so that log is retained separately from assertion counts.

The three failed 1x Freeciv assertions are cursor alignment (457.93 pixels
versus <4), missing expected `960×540` display text, and unavailable expected
cursor state after pointer capture. All three fail with the same assertions
when only main's original Shell component is substituted into the same
normal products (job `cage-r1-freeciv-main-local-1109-093108-b2c5`, 0/3;
`main-shell-freeciv-local-results.json`). The substituted source equals main
and the frozen shipment's Shell; only dependency query hashes and two
repository import prefixes were localized. The route asserts substitution
occurred. This isolates the terminal-fit change, not the rest of main:
it is a diagnostic, not a pristine full-main acceptance claim. These remain
D1/V1/P1 findings, with no repair or full Freeciv acceptance claimed here.
An earlier invalid version of that diagnostic retained an external import
and correctly received HTTP 403; it was stopped with exit 143, repaired in
separate files, and is not counted as a valid control.

The maintainer authorized Sydney to replace Moscow as this follow-up's
commit/push location after the old checkout was retired. The external
`/Users/brandon/kandelo-handoffs/graphics-moscow-20261109/` package preserves
historical sources, failures and six independent preview worktrees. This
follow-up does not modify those frozen controls.


Local disk checks and ownership receipts accompany the build. The initial
12 GiB opt-in reserve applied to the uncached normal closure; the later
validation-only cached preparation uses a 3 GiB per-node reserve. These are
operator choices, not a changed repository default or relaxed image limit.
Only inactive ignored Sydney compiler intermediates were removed, with
runtime and original-cohort hashes verified before/after. The last removal
was 4,588 native object files: 1.9 GiB logical size but only about 0.13 GiB
of measured free-space recovery. At that checkpoint no shared cache
collection had occurred. The later approved collection is recorded below;
historical failures and previews remain preserved.


## Earlier full-memory failure and working-space blocker (retained)

The completed full memory gate `cage-r1-memory-escape-1109-100214-2053`
returned exit 1 after 28m32s: 15 browser cases passed, and the Chromium,
Firefox and WebKit mixed-switch cases failed. Source contracts (7),
ownership (253), Node teardown (3) and Bun teardown (7) passed. The complete
console outcomes, failure screenshots/error contexts and three traces are
retained under run `738a363d-ce61-4962-90ff-ebd28b3f24ad`; reviewed counts
are in `memory-escape-reviewed-outcomes.json`. The canonical script removes
its temporary summary JSON, so that summary is not claimed as retained.

Chromium read metadata for the retired Quake computer after requesting a
new Freeciv computer: its URL assertion had accepted the old ID. Trace data
identifies the old ID as Quake; `NotFoundError` then came from its removed
temporary directory. Commit `027e4eedbfa8a573ec55cceff3cac91c13f976ed` waits for a different valid computer
ID before reading metadata. It does not catch missing-file errors, retry
boots, weaken frame/audio checks or reduce the four cycles. It passes the
normal TypeScript check; final browser acceptance remains pending.

Firefox failed its Quake frame assertion and explicitly reported `ENOSPC`
while closing its profile. WebKit failed to boot WordPress: the boot log
records a persistent-image write failure at 1,922,960 of 253,063,507 bytes.
No OOM or browser defect is inferred from that write failure. A separate
four-cycle Chromium diagnostic with the generation guard reached labwc but
failed its rendered-command assertion; the retained active screenshot shows
Foot and SFWBar lazy-cache writes rejected with "No space available for this
operation" (job `cage-r1-memory-generation-1109-102025-46bd`). That is not
counted as a passing guard/control or as a rendering-defect diagnosis.

Disk availability fell as low as about 2.4 GiB. A read-only shared-cache GC
preview selects 18.1 GiB of unreferenced below-ABI-56 generations and
abandoned build scratch (job `cage-r1-cache-preview-current-1109-102652-eedc`).
None of the selected generation keys occur in the six preserved preview
projections. An isolated scratch test verifies dry-run preservation and
application removing only an unreferenced ABI-55 fixture while retaining a
live referenced ABI-55 fixture and ABI 56. The first scratch layout selected
zero generations; the corrected layout performed and checked the real test.
At that checkpoint collection had not been applied: explicit authorization
was requested under the repository guide. The user subsequently authorized
this bounded cleanup. The recovery and new validation outcome are recorded
below; the earlier failed run remains an adverse result.


## Approved working-space recovery and follow-up validation

The maintainer explicitly approved the reviewed below-ABI-56 collection.
A fresh dry run selected the same 18.1 GiB; none of its 299 generation keys
matched any of the six preserved preview projections. Before removal,
59 diagnostic files from abandoned build directories were copied with APFS
clones into `gc-preserved-debris-diagnostics`. The isolated scratch control
had already verified that the collector preserves live references and ABI
56 while removing an unreferenced ABI-55 fixture.

The canonical collector first removed 2.8 GiB from the ordinary cache while
correctly skipping the source cache's active build lock. The existing peer
bootstrap was awaited to completion without stopping it. A fresh preview
rechecked preserved projection keys and debris ownership, and a second
application removed the remaining 15.3 GiB. Commands, through the dev shell:

```sh
target/aarch64-apple-darwin/debug/xtask cache-gc --below-abi 56 --max-age-days 36500
target/aarch64-apple-darwin/debug/xtask cache-gc --below-abi 56 --max-age-days 36500 --apply
```

Collected logical size is about 18.1 GiB. Observed available disk rose from
1.01 to 18.88 GiB over the interval; other workspace work also ran, so that
free-space delta is not an exclusive physical-allocation attribution.
`gc-approved-complete-result.json`, both apply logs and the preserved-preview
checks retain the measurements. All 50 frozen candidate/source/original
fixture identities remained identical. Ports 56501, 59247 and 6271 returned
HTTP 200 with their existing owners, and the original frozen image's HTTP
hash remained unchanged.

A standalone native OPFS capacity check then passed on Chromium, Firefox
and WebKit: each persistent context wrote/flushed 1 GiB of nonzero bytes
through a real worker `FileSystemSyncAccessHandle`, verified a 1 MiB readback
sample, closed and removed the test file. This tests host-storage capacity,
not guest-memory reclamation or whole-file readback. Browser storage usage
estimates can lag removal. The probe retained an EACCES warning from the
harness's separate Firefox Downloads-directory cleanup; it is not claimed
as a clean filesystem cleanup. Job
`cage-r1-storage-after-gc-1109-111443-71e4` passed 3/3; its JSON/log and exact
private spec are retained as `storage-capacity-*`.

The complete unchanged memory command was then rerun:
`./run.sh test browser-memory`, job
`cage-r1-memory-after-gc-1109-111719-d689`. Its private wrapper attempted to hold a
read descriptor to the temporary Playwright report, but watched the wrong
temporary directory after dev-shell entry. The raw summary JSON was therefore
not retained. The actual canonical console and failed trace are retained. Test cases, four cycles,
required inputs, one worker and zero retries are unchanged; this run uses its
own port 56503, UUID and private outputs. The normal preparation's opt-in
reserve was restored to 12 GiB after space recovery.

The command returned exit 1 after 28m24s. Source contracts (7), host
ownership (253), Node teardown (3) and Bun teardown (7) passed. Chromium
and Firefox each passed all six browser cases, including all four mixed
switch cycles. WebKit passed five cases and failed its mixed-switch case:
17 passed, one failed, zero skipped or automatic retries overall. Reviewed
console outcomes are retained in `memory-after-gc-reviewed-outcomes.json`,
with the full log and failed trace under run
`a40edf35-1628-4a4c-ad55-d446f88aa778`.

The WebKit failure occurs while switching the third Doom machine to Quake.
The prior sink reports "PCM AudioWorklet did not acknowledge transport
detach; context=running; sink=running". The shared-transport safety latch
then refuses the replacement Quake attachment, leaving audio unprepared.
The retained active screenshot shows the rendered Quake menu and that
specific error. This is not the earlier stale-computer-ID or disk-write
failure, and no OOM or browser defect is inferred. Focused timing diagnostics were started at that checkpoint; their results
and the later gate execution appear below. The unacknowledged audio
retirement remains an open finding.


## Audio-retirement investigation after the failed gate

An instrumented copy of the unchanged mixed-switch case completed all four
WebKit cycles (job `cage-r1-audio-diagnostic-v2-1109-115650-0f38`, 1/1 pass).
It records each node's native context state, audio clock, detach-send time,
acknowledgement and port closure. All 20 detachments were acknowledged,
with a maximum measured acknowledgement delay of 3.68 ms. This is a
negative diagnostic reproduction, not an owner repair or canonical memory
acceptance. The first attempt used the wrong Playwright installation and
failed discovery before executing a case; that log is retained separately.

A standalone page containing no Kandelo runtime then created, rendered,
detached and disconnected 512 worklet nodes per engine, suspending and
resuming one context between nodes. All three engines passed; maximum
measured acknowledgement delays were 0.20 ms (Chromium), 13 ms (Firefox)
and 18 ms (WebKit). Its exact native worklet source and console results are
retained as `audio-detach-native-*`, run
`78bbe849-5705-4beb-8bf6-709d67fd342a`. It emitted the same separate Firefox
Downloads cleanup EACCES warning. This reduction does not reproduce the
original failure and establishes no browser defect.

The failed trace also exposed a gap in the memory test's warning filter:
contained teardown failures were not all recorded as runtime failures. A
later machine that did not need audio could therefore hide a missed fence.
The test now records both forced kernel-realm termination and failed realm
termination warnings, including the PCM shutdown diagnostic. It preserves
the four cycles, activation requirements, frame assertions, memory budgets
and zero-retry policy. The browser TypeScript check passes (144 browser and
46 Node unit roots). Replaying the actual recorded console events through
the actual listener catches the PCM warning with this filter; the previous
listener captured none. The replay and receipts are retained in
`containment-warning-replay.*`. This reporting correction does not repair
or explain the unacknowledged audio transport.

Main advanced independently to `c7338521e0008bca446da140f9fd43af76dad960`
(package-build SDK opt-out, #1679) during validation. The frozen runtime and
all results above remain based on `a3490ca0f48d7c249592925cb7b4ac1ab74b9c2a`;
no results from another workspace or the new build recipe are imported.


## Latest complete memory-gate result

The actual `./run.sh test browser-memory` command at test commit
`c5f6486d340c` returned exit 0 after 28m52s, job
`cage-r1-memory-containment-1109-120622-4ef4`, run
`5d071445-7d22-4743-8e39-7696541ae2bb`. The two documentation files were
being updated at job start; all runtime inputs remained frozen and are
verified independently below. No guest, audio-driver, transport-fence,
ceiling or ABI behavior changed for this rerun.

Source contracts (7), host ownership (253), Node teardown (3) and Bun
teardown (7) all passed. The browser phase passed all 18 cases: six each
on Chromium, Firefox and WebKit, zero skipped, flaky or automatically
retried cases. Each engine completed all four mixed-switch cycles in the
same page realm, with the stricter warning filter active. Mixed-case times
were 6.4m, 9.5m and 5.9m respectively; these are test durations, not
performance or before/after measurements. The canonical script validated
its JSON statistics and printed its final gate-passed marker before its
normal trap removed that temporary report. The full console, guarded exit
and reviewed per-case outcomes remain retained as
`candidate-memory-containment.log` and
`memory-containment-reviewed-outcomes.json`; raw canonical JSON is not
claimed as retained. The private summary helper first expected TAP output
where Node emitted its spec reporter, then was corrected against the actual
log; both attempts remain retained. This did not rerun or alter any test.

The harness separately warned that its Firefox Documents-directory cleanup
received EACCES. The command still passed its 18 browser assertions and
final statistics guard; this is not claimed as a clean filesystem cleanup.
The earlier failed 17/18 gate remains adverse evidence and is not reclassified
by this successful execution. No runtime owner repair for that intermittent
audio failure has been established, so the PR remains a draft with that
investigation open. The next discriminating experiment is the real browser
PCM driver/worklet with its independent worker-owned transport and producer
retirement, without a guest or persistent image, recording native page/audio
clocks and the exact detach fence without changing its timeout.

All 50 frozen candidate/source/original-fixture identities and all eight
final implementation/test/budget hashes still match after the gate.
`products-after-containment-gate.json` and
`containment-implementation-file-identities.json` retain the exact receipts.
The normal preview, program 56 / host 4 / GL 17 / fork 21 and the six
preserved external previews remain unchanged. Available disk later rose to
about 221 GiB during other activity; that later change is not attributed to
the bounded 18.1 GiB logical collection.


## Cursor slowness reproduced on the normal preview

The maintainer reported a very slow cursor after wlterm rendered and slow
initial rendering. New probes used the unchanged normal preview on port
56501, shell SHA `1024edcac14dac7620070ee90a45d6bd2a62fbc36f56f1bd008ff31568f8075b`,
source `ab3324bcbe9bf3f3029334169414d0d70756a80b`. All 50 prior source/product/
original-fixture identities and eight additional performance-owner source
hashes remained unchanged. The server and user preview were not edited or
restarted. Measurements below are diagnostic characterizations, not a
before/after performance claim or native visible-display acceptance.

A mouse sweep submits 60 trusted pointer moves, aiming for 60 Hz, from 20%
to 80% of the rendered canvas width, followed by a 1.5s drain interval.
Observers record actual DOM input delivery and changes painted by the
existing KMS cursor plane. The final cursor image origin is consistently
five pixels left of the target, consistent with a fixed hotspot offset; there is no
large endpoint-distance scaling error in these cases. The failures are
update cadence and responsiveness. These are cursor paint callbacks, not
photographic measurements of what reached the physical display.

The full diagnostic instruments the actual `GbmBoRegistry` methods and
`Uint8Array.set` inside the disposable kernel worker. Chromium results:

| Guest output | Actual sweep delivery | Cursor paints, including drain | Logical mapped bytes scanned | Logical bytes copied | Inclusive import-sync time |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1280×612 | 1.017s | 39 | 6.26 GB | 6.26 GB | 884ms |
| 2560×1332 | 1.024s | 10 | 8.02 GB | 8.02 GB | 1131ms |
| 3840×2052 | 1.002s | 1 | 8.32 GB | 8.32 GB | 1160ms |

GB here is decimal logical byte volume, not physical memory-bus traffic.
Scan volume sums mapped spans passed to the flush hook; copy volume sums
worker typed-array copy lengths.
Import-sync time includes its scan/copy callees; their timings must not be
added. At 4K, the first changed cursor paint arrives about 1047ms after the
first moving event, after the sweep has ended. The cursor eventually reaches
the intended endpoint. WebKit also degrades: 47, 21 and 16 cursor paints
at the same three output sizes; actual sweep delivery stretches to 2.189s
at 4K, so those counts are not comparable FPS measurements.

A second control removes both registry timers and the typed-array copy hook,
retaining only the cursor-plane observer. It reproduces the stall:

| Engine | Guest output | Actual sweep delivery | Cursor paints, including drain | First changed paint after first moving event |
| --- | --- | ---: | ---: | ---: |
| Chromium | 1280×612 | 1.018s | 40 | 34ms |
| Chromium | 3840×2052 | 1.002s | 1 | 1057ms |
| WebKit | 1280×612 | 1.027s | 44 | 15ms |
| WebKit | 3840×2052 | 2.034s | 15 | 74ms |

This control shows that the severe Chromium stall does not depend on the
buffer profiling hooks. Its remaining cursor observer is still measurement
overhead; these runs do not establish native Safari behavior or calibrated
input-to-visible-display distributions.

The owning path is
`CentralizedKernelWorker.#syncImportedBosBeforeResume` at ready wait and
receive completions. For a process sharing graphics mappings,
`GbmBoRegistry.syncImportsForPid` revisits its BOs, merges mapped writers,
then copies each whole mapped image from canonical storage into the process
and into its snapshot. `flushMemoryToSab` compares the entire mapped span to
its previous snapshot to discover writes. Pointer traffic therefore drives
large image comparisons and full imports, even though the cursor itself is
a small separate plane. This synchronous work shares the kernel worker with
input servicing and vblank/cursor presentation, and grows with image area.
It is a concrete CPU coherence/scheduling bottleneck in Kandelo's graphics
path. The previous eventual-render/input/exit checks did not measure this
interactive performance requirement.

Navigation through the rendered-prompt/download-complete checks took roughly
6–8.3s in these fresh profiles. That includes app, persistence, kernel and
guest startup plus observer work; it is not an isolated rendering-duration
measurement. The cursor bottleneck is reproduced, while the rest of initial
startup time still needs separation.

The corrective work belongs at the shared graphics-memory synchronization
and scheduling owners, preserving concurrent mapped writes, canonical
publication and authoritative kernel cursor state. It needs owner-level
regressions and measured application/Node/browser validation before a speedup
claim. The broad B2–B6/C1–C3 campaign remains paused; this performance defect
keeps the bounded R1 delivery open.

Retained evidence is Sydney `.context/cage-performance-20261109/`: raw
numeric logs, diagnostic sources/configs, `pointer-reviewed.json`,
`pointer-light-reviewed.json` and `runtime-identity.json`. Bulk original
reports/traces remain under their registered test run directories. The
full pointer probe passed 6/6 and the light control 4/4, with zero retries.
The first pointer probe completed its movement but failed all six summaries
because its formatter lost the digit escape; its source, log, reports and
traces remain retained as failed diagnostic attempts. The corrected capture
did not change the product. Chromium's initial typed probe passed 2/2,
WebKit's typed probe passed 2/2, and a larger-output typed probe passed 2/2.
Two Firefox typed probes failed during worker instrumentation before
producing summaries (`Execution context was destroyed`); no fresh Firefox
performance result is claimed. Separate Firefox profile-directory EACCES
cleanup warnings remain retained. None of these diagnostics replaces or
reclassifies the earlier functional/host/memory acceptance results.


## Modest default display requested by the maintainer

The maintainer explicitly prefers a responsive modest-resolution Wayland demo
rather than a native HiDPI output. The Cage profile now declares optional
`presentation.displayMaxSize: { width: 1280, height: 720 }` in the normal
shell image. The reusable session contract chooses CSS-reference guest
pixels, fits the preferred mode proportionally within the limit and connector
minimum, and reports 96 DPI. Smaller panes are not supersampled on Retina.
The browser fits the actual guest scanout; this reduces guest buffer allocation
rather than only changing CSS/font scale. Other profiles retain their existing
native defaults. Explicit display scale composes before the size limit.

The limit selects the preferred mode, not a new global graphics capacity.
Programs can still select the connector's other supported modes. A running
Cage compositor keeps its selected mode on host layout resize; no live output
hotplug is claimed. A presentation change invalidates an old pane measurement
before the next client starts. The parser validates the optional object and
the session returns defensive copies. This is browser presentation policy;
Node's layout-free host adapter, guest binaries, kernel, shared graphics
coherence and published ABI are unchanged. Shell build revision is 86.

The original 56501 preview was first relocated into a detached external
worktree at source `4bde403bd0573ce8b036197e9e6150098a88eb24` with its own
normal products and dependencies. HTTP image and required runtime hashes match
the former preview; real Cage smoke checks passed before and after relocation.
It remains the separate high-resolution control. The six earlier external
Moscow previews were not changed.

The new full normal engine/SDK/rootfs/host closure completed through the
canonical dev shell with `cargo run --release -p xtask --target
aarch64-apple-darwin -- bootstrap --jobs 1`, followed by
`bash scripts/check-abi-version.sh`, job
`cage-resolution-normal-release-1109-190944-7481`, exit 0 after 5m41s.
This is the same full normal bootstrap graph, not a partial image. The initial
`./run.sh setup` attempt was intentionally terminated at projection
finalization after 44m16s (exit 143), after completing its package nodes.
A native sample located its CPU cost in debug-tool dependency-identity hashing;
that incomplete attempt is retained and is not reported as a successful setup.
The optimized native tool reused the completed outputs and finished the full
closure, freshness and ABI checks. No build-script or compiler override was
committed, and no package output or fixture was substituted.

| Product | Bytes | SHA-256 |
| --- | ---: | --- |
| New normal shell image | 1,076,137 | `44687dd36b9710933356c6846bd29c1e30e9fc09759593db76385a38ccd93152` |
| Unchanged kernel | 2,919,292 | `0ac8a09beb8938dc69af49a53d29ea46c5d2f3a129176d4b0b8994097fb64fdc` |

A fresh 50-entry source/product/original-fixture receipt verifies the normal
products and both manifest-bound program fixture cohorts. Program 56 / host 4 /
GL 17 / fork 21 remain unchanged. The new preview on 56507 serves that exact
normal SourceOnly projection with HMR disabled; downloaded image bytes match
the table. Availability was reported separately from full acceptance.

The new real-browser cap cases pass **6/6**: two densities each in Chromium,
Firefox and WebKit, zero skips/retries/flaky outcomes. They observe actual
guest mode dimensions, GLES2 shell pixels, keyboard repaint, stable active
mode across a host viewport resize and real wlterm exit 0. The old frozen
normal control fails the new density-1 cap assertion as expected: width 1920
exceeds 1280. Source-only session/image-activity units pass 208/208; browser
TypeScript checks pass 144 browser roots and 46 Node unit roots. A separately
committed stale login assertion now matches the unchanged fixture's `/bin/login`;
the frozen old test reproduced the same failure before that correction.

### Cursor observations with fewer guest pixels

A new light-observer run compares the preserved normal control with the new
normal image at CSS viewport 3840×2160. The actual display pane is 3840×2052.
Both use 60 trusted mouse moves aimed at 60 Hz, followed by a 1.5s drain.
Only cursor-plane paint callbacks are observed, with no BO/copy timing hooks.
The eight cases passed with zero retries. Chromium was 153.0.8010.12 and
Playwright WebKit 26.6. An independent normal-entry preparation was active;
this is not a quiet, alternating repeated benchmark or destination-main
comparison. The intentional quality/pixel-count difference is the product
change: 3840×2052 becomes 1280×684, one ninth as many guest pixels.

| Engine | Image / browser density | Actual guest mode | Sweep delivery | Cursor paints, including drain | First changed paint after first move |
| --- | --- | --- | ---: | ---: | ---: |
| Chromium | old / 1 | 3840×2052 | 1.035s | 2 | 541ms |
| Chromium | capped / 1 | 1280×684 | 1.018s | 32 | 17ms |
| Chromium | capped / 2 | 1280×684 | 1.017s | 32 | 19ms |
| WebKit | old / 1 | 3840×2052 | 2.040s | 15 | 67ms |
| WebKit | capped / 1 | 1280×684 | 2.197s | 39 | 19ms |
| WebKit | capped / 2 | 1280×684 | 2.245s | 32 | 12ms |

At CSS 1280×720, the capped mode is 1280×612: Chromium recorded 34 paints
and WebKit 45. WebKit's mouse-event delivery stretches to about two seconds
in the large cases, so these counts are not comparable FPS measurements.
Cursor callbacks are not calibrated physical input-to-visible-display latency.
The small plane remains painted and the final tip reaches the mapped endpoint.
The large Retina screenshot was inspected: the lower-resolution shell and
cursor are visible and fitted to the pane. A second visible review through
actual `./run.sh browser --host 127.0.0.1 --port 56505 --strictPort` passed
1/1 on Chromium at density 2: real physical-key input repainted the terminal,
host resize fitted the active 1280×648 mode, and exit selected Terminal with
`WLTERM_EXIT code=0` and the foreground `CAGE_EXIT_STATUS=0`. Both rendering
and exit screenshots were inspected. The exit screenshot also retains a
libinput warning of 25ms keyboard-event lag during this loaded run; passing
completion does not establish zero latency. There is no same-resolution
coherence correction or native-feel claim, and no fresh Firefox cursor-timing
claim. The six real-browser functional checks include Firefox at both densities.

Navigation through rendered shell/download readiness still takes roughly
6.2–7.7s for the capped cases, versus 7.7–8.6s for these old controls. These
are single fresh-app observations including persistence/kernel/guest startup
and diagnostic work, not isolated rendering times or a startup speedup claim.
The default is smaller and measurably more responsive in this workload;
first-load separation, high-resolution coherence and the unexplained earlier
WebKit audio-retirement failure remain open. Broader B2–B6/C1–C3 remain paused.

Current evidence is Sydney `.context/cage-resolution-20261109/`: normal build
and ABI logs, source/product receipts, image HTTP verification, cap results,
light-observer sources/results/review, and inspected visible screenshots.
Bulk original test traces remain under their registered run directories.
Prepared-product/session units pass 333/333 across three files, including the
208 source-only cases; host sessions/PTYs pass 15/15 across eight files.
Final TypeScript inventory remains 144 browser roots and 46 Node unit roots.
The larger graphical and default-relay memory failures below remain adverse;
passing focused checks are not substituted for those original outcomes.

### Follow-up checks and retained failures

The first 36-case matrix completed with **32 passes and four failures**,
zero skips/retries/flaky outcomes, job
cage-modest-selected-1109-191920-70a5 (32m16s), run
a49e0c6f-966e-41c4-b8ce-9fdd50f2328e. It exercised twelve cases per engine.
Two failures exposed test observations that needed correction:

- Firefox's repeated Cage case rejected a valid 1000×612 frame because its
  PNG compressed to 7,801 bytes, below an 8,000-byte heuristic. The inspected
  screenshot shows the actual shell prompt. The tests now use their existing
  shell-pixel proof instead, including the memory sequence; no resource
  ceiling or required rendering/input/exit condition was relaxed.
- Chromium's Sway Activity case saw two actual Foot processes, PIDs 108 and
  120, but collected an empty PID list between asynchronous DOM reads while
  the Inspector refreshed. The raw before/after attachments and inspected
  screenshot prove the discrepancy. The helper now reads row count, PID
  cells and row text in one synchronous snapshot, preserving exact process
  counts, the new unique PID, retained old PID, compositor owner and real exit.

The two other failures remain observations to investigate: Firefox's Sway
workspace query left the inspected IPC file empty, and its Activity case
showed three tiled terminals after one Alt+Enter. Neither is explained by
the PID-collection fix. A before-cap Firefox Sway control passes the Activity
case but fails the main Sway case later, waiting for the workspace-two client
to close after Alt+Shift+Q. That is a different failing step, not a reproduction
of the exact empty-file failure. A separate candidate Firefox main-Sway case
then passes 1/1 (113s). These mixed outcomes do not establish an input repair,
a browser defect or native feel; D1/V1/P1 retain the findings.

After the test corrections, the affected selection passes **12/12**, four per
engine: six density/cap cases, three repeated Cage lifecycle cases and three
Sway Activity cases. These are fresh reports, not retries or overwritten
results. The original full 32/36 matrix remains recorded; the full 36-case
selection was not rerun after changes confined to the affected test fixtures.

The strengthened density cases also measure the independent native pixel
box. Chromium and Firefox launch at actual native scale 2, measuring native
width 3840 for CSS width 1920 while the guest remains 1280×648. Both also
pass at scale 1. WebKit uses its documented CSS/DPR fallback at densities
1 and 2. This is stronger than the initial context-DPR emulation alone.
A separate Chromium native-scale-2 cursor probe measures CSS width 3840,
native width 7680 and the same 1280×684 guest mode. It records 21 cursor
paints during a 1.021s sweep plus drain, with the first changed paint 34ms
after the first moving event. Readiness takes 9.758s in that fresh run.
The actual Retina-scaled screenshot was inspected. This remains one scoped
worker-paint observation with background build preparation, not physical
display latency. The earlier eight-observation table retains its original
context-DPR inputs; its density-2 rows do not retroactively prove a native
device-pixel box.

### New default-relay memory run and required data fetch

The exact ./run.sh test browser-memory gate completes **15/18 browser cases**,
five per engine, zero skips/retries; source 7, ownership 253, Node 3 and Bun 7
all pass. Job cage-modest-memory-1109-192229-fa8a exits 1 after 37m29s.
The actual registered run is 30d259d9-338b-44ec-8e4f-51ac21758094; the wrapper's
suggested UUID was stripped by a nested dev-shell entry. Reviewed console
outcomes preserve all eighteen cases. The canonical temporary raw JSON was
deleted by its normal trap; it is not claimed as retained.

All three mixed-switch cases get through Cage, Sway, labwc and tmux in their
first cycle, then stop before DOSBox renders. The inspected terminal
screenshots show dos-play keen1 failing its normal download retries with
HTTP 502. The development relay reports
Bad Gateway: ETIMEDOUT (https://downloads.sourceforge.net).
This is a real failed data fetch, not a Cage crash, successful four-cycle
memory acceptance, or a new out-of-memory diagnosis.

The normal games.tsv requires 153,012 bytes with SHA-256
3d0730f7e4b7c10967609faf5290768eae40b9b6f685060a0ac17c258521a364.
Direct downloads through three official SourceForge URLs match those exact
bytes. A standalone native fetch reaches the first redirect; that does not
establish that the development relay can complete the download. The existing
production default proxy, https://wordpress-playground-cors-proxy.net/?,
returns HTTP 200 and the same manifest-bound bytes.

A separate full gate is running through the exact gate implementation in
the canonical dev shell with that supported production proxy setting:
VITE_CORS_PROXY_URL=https://wordpress-playground-cors-proxy.net/?
and bash scripts/check-browser-memory.sh. This places the configuration
inside the shell so nested environment filtering cannot discard it.
It still prepares normal products and runs every source/host/Node/Bun check
and all eighteen browser cases. No local archive response is mocked, and
there is no skip, replacement guest payload, new browser context between
cycles, relaxed ownership fence or memory-ceiling change. Its result remains
pending. The original default-relay failure remains visible and is not
waived by using the separate supported proxy configuration.
