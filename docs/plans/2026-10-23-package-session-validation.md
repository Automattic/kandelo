# Package session prototype validation

This work starts from `f3cb7041f64b657c1ead57d579ccb61867ecf1cf`, after
the termchat port merged. It adds optional package-owned offer/join
procedures, installs their manifests through the ordinary runtime-file
contract, and consumes them in the network panel. See
[the contract](../package-sessions.md) for supported fields and limits.

## Evidence

All build and verification commands use `scripts/dev-shell.sh`. Logs and
screenshots are workspace-local files in `.context/` unless noted below.

| Check | Result | Evidence |
|---|---|---|
| Canonical SourceOnly bootstrap | 195 nodes succeeded, eight products admitted; 189 cached and six published | `package-sessions-stable-images-1023-180341-29e2` agent-job log |
| Session contract, PTY queues and image composition | 173 passed, no skips | `package-sessions-library-final.log` |
| Network controller and invitation codec | Seven passed, no skips | `package-sessions-network-unit-final.log` |
| Real Node termchat and package/runtime-path regressions | Nine passed, no skips | `package-sessions-package-regressions-final.log` |
| Canonical shell wrapper | Passed | `package-sessions-shell-wrapper.log` |
| Chromium UI, real WebRTC, Doom and Quake regressions | 13 passed, no skips or retries | `package-sessions-chromium-final.log` |
| Firefox/WebKit rejection flow and real termchat TUI | Four passed, no skips or retries | `package-sessions-engines-final.log` |
| Complete browser memory gate | Passed: 162 host, three Node, seven Bun and nine browser cases; no skips or flaky browser results | `package-sessions-memory-recovered-1023-185753-4eb1` agent-job log |
| Browser asset audit | 147 imports resolved; nine memory64 fixtures verified; publish-size check passed | `package-sessions-assets-final.log` |
| Host typecheck | Passed | `package-sessions-host-typecheck-final.log` |
| Browser TypeScript diagnostics against the original sources | 129 existing diagnostics on main and current sources; none added | `package-sessions-ts-baseline-final.log`, `package-sessions-ts-diagnostics.json` |
| ABI freshness | Passed; ABI remains 52 | `package-sessions-abi.log` |
| Normal local demo UI | Boot, package offer form and existing-instance choice verified; no page errors | `package-sessions-demo-check.log`, `package-sessions-local-demo.png` |

The application proof uses the real network panel, package-built guests,
ordinary guest PTYs and sockets, the normal signalling relay, and actual
WebRTC links. Cases cover starting termchat after connection, sharing an
already-running instance without restarting it, choosing Doom deathmatch
before starting, and launching the guest's separate join procedure. A guest
prepares the Doom image without running its single-player auto-command.
The tests also reject incompatible procedures and failed joins without
starting the participant program, and reject a second display activity while
the first still owns the framebuffer.

New launches use a fresh terminal. A queue regression keeps the original
terminal occupied and proves the new command goes to a different process.
Machine generations and immediate network-controller state are checked again
at dispatch, so leaving or replacing a session invalidates a pending launch.

The retained termchat TUI test compares all 32,775 transferred bytes and checks
both chat directions, resizing, disconnect, terminal restoration and process
cleanup. Its Firefox/WebKit transport is the real remote session protocol over
MessageChannels; the local WebRTC fixture runs on Chromium. No physical-LAN or
cross-computer NAT-interoperability claim follows from these local tests.

The TypeScript baseline comparison reads the original tracked sources from
the base commit through a compiler host, excludes newly added files from the
baseline, and compares diagnostic file, code and message multiplicities.
This is evidence of no added diagnostics, not a clean full browser typecheck.

## Failed and interrupted attempts

- One aggregate build rejected inconsistent package/identity cache keys while
  manifests were being edited. A later build rejected a concurrent edit to
  `shell/test-build-shell.sh` through the reviewed-recipe-tree guard. The
  stable ordinary bootstrap then succeeded. Neither failure is counted as a
  passing build; no artifact copying, restamping or admission bypass was used.
- The first UI run was stopped while its exact Activity selector could not
  find the wrapped select's accessible label. The UI now supplies explicit
  accessible labels. A leftover owned Vite process caused one subsequent port
  collision and was terminated before the next run.
- An earlier Chromium run passed all 13 cases before the final cancellation
  and invitation-screen refinements. Its log is
  `package-sessions-chromium-before-cancellation-guard.log`; this is historical
  evidence, distinct from the final run above.
- A cross-engine fixture attempted to grant Firefox a Chromium-only
  microphone permission. That failed before page creation. The fixture now
  grants that permission only to Chromium; no page captures media.
- A later run exposed the Doom fixture's premature Ctrl-C. Doom uses raw
  keyboard mode, so the fixture now waits for the reported framebuffer owner
  and uses the frontend's documented quit key before requiring a shell command
  to complete. This changes test setup, not application/runtime behavior.
- DNS failures for `cdn.jsdelivr.net` caused game-image boot errors and the
  memory gate's required external-data checks to fail. Logs preserve those
  failures. A fresh Node HEAD request from the declared dev shell returned
  200 before the final reruns (`package-sessions-cdn-node.log`). No test skips
  or replacement game implementations were introduced.
- The shell wrapper test already lacked its required CA-bundle fixture on
  main. The same failure was reproduced in an isolated checkout of the base
  commit (`package-sessions-shell-wrapper-main.log`). The fixture now provides
  that existing input and accepts its existing composer argument, alongside
  checking the newly declared Cargo metadata tool. The test passes.

## Scope

No kernel, libc, syscall semantics or Wasm ABI structures changed. The full
Rust, libc, POSIX and Sortix inventories were considered and not rerun for
this browser/package-metadata feature. No performance benchmarks, native
Safari desktop run or deployment is claimed. The broad memory gate is
required because image composition and terminal launch routing changed.

Application readiness, automatic process recognition, custom termchat
discovery configuration, game-data compatibility negotiation, and room
ownership independent of the hosting machine remain outside this prototype.
Download storage remains unchanged. The work is local and is not part of the
already-merged termchat PR.

## Invitation UX and dependency follow-up

The user requested one invitation workflow with optional activity selection,
creation before or after joining a room, keep/replace controls and Leave in
that same panel. The follow-up also adds package-declared data dependencies:
known, pinned acquisition sources; a local-file picker; explicit WebRTC
sharing or acquisition hints; and verification before launch. Doom now uses
`/tmp/kandelo-doom.wad` prepared by this flow rather than requiring an image
to have provided `/doom1.wad` beforehand. No termchat download-directory
changes were resumed.

The final ordinary SourceOnly bootstrap,
`invitation-ux-final-images-1023-195017-15a9`, succeeded: 195 nodes, eight
products, six published package nodes. The shared session, PTY and image
composition tests passed 177 cases with no skips in three files
(`.context/invitation-ux-library-final.log`). The Node room-controller tests
passed seven cases (`.context/invitation-ux-network-unit.log`). Host typecheck
passed. The browser comparison again found 129 baseline/current diagnostics
and zero added diagnostics (`.context/invitation-ux-type-baseline-final.log`).
The ABI freshness check passed with ABI 52 unchanged
(`.context/invitation-ux-abi.log`).

The normal local demo server was restarted after package materialization:
the old Vite process had retained its previous package index and therefore
still delivered the old session sidecar. A fresh headless browser against
`./run.sh browser` verified the optional activity form, known Doom WAD,
WebRTC delivery choice and local-file picker, with no page errors
(`.context/invitation-ux-demo-check-final.log`). An initial check during the
restart received connection refused before Vite was ready; it is not counted
as a successful check.

Real-browser and memory-gate results are recorded below when complete;
the earlier prototype runs above are not validation of this follow-up.

The first real Doom test reached both player roles with guest WAD downloads
blocked, then exposed a second issue: the shell presentation did not offer
its newly active framebuffer through the Demo button. That run was
interrupted rather than waiting out an eight-minute disabled-button action.
`MachineView` now exposes an actual framebuffer owner even if the initial
profile has no graphical preference, and an explicit Demo selection can wait
for the launched process to acquire its device. This is based on device
availability, not on the package name. Browser checks now require enabled
Demo controls and real framebuffer owner titles. The initial memory run was
interrupted so its replacement validates this display change as well.

A follow-up display run exposed that deferring every Demo selection changed
keyboard focus timing in the existing Doom waiting-room and Quake menu
flows. Available displays now switch immediately; only unavailable surfaces
use the pending request. Both original control cases passed without retries
in `invitation-ux-display-regressions-1023-200602-73c6`.

The earlier independent termchat harness also sent text immediately after
posting an asynchronous PTY resize. One run missed the post-resize message.
The fixture now waits for the guest to draw its new bottom border before
sending that text; local xterm reflow alone is not guest completion. This
changes fixture ordering, not termchat or the runtime. CDN timeouts during
the subsequent aggregate run are preserved in
`.context/invitation-ux-chromium-final.log`; a fresh declared-shell HEAD
request returned 200 and the expected size (`.context/invitation-ux-cdn.log`).
No artifact substitution, test skip or timeout relaxation was introduced.

The final current-source Chromium aggregate completed 16 passing cases and
one external-CDN timeout (no automatic retries). All new hint/upload cases,
room controls, legacy Doom/Quake controls and the termchat harness passed.
The affected bare-shell Doom case then passed in isolation with the real
CDN and real WebRTC transfer in 22.6 seconds
(`.context/invitation-ux-doom-recovery.log`). It still blocked guest WAD
HTTP requests, so this run proves data delivery over the declared peer
channel rather than a download fallback. The failed aggregate log remains
`.context/invitation-ux-chromium-final.log`. The separate resized-terminal
harness passed once in each engine, without retries, in
`invitation-ux-terminal-resize-1023-201045-ea04`.

`invitation-ux-browser-followup-1023-201300-6e97` completed successfully:
the one Chromium recovery case, all six selected Firefox/WebKit cases
(incompatible/failed invitations, keep/replace/leave, and the independent
termchat browser harness), and the browser asset audit. The audit resolved
147 imports, checked nine memory64 fixtures, and passed publish-size checks.
Logs are `.context/invitation-ux-doom-recovery.log`,
`.context/invitation-ux-engines-final.log` and
`.context/invitation-ux-assets-final.log`. Browser coverage intentionally
uses local Chromium WebRTC; no physical LAN/NAT, native Safari desktop or
remote peer interoperability claim follows from it.

A final headless check of the normal live demo also created a plain room,
verified the keep/replace controls and left it through the same panel, with
no page errors (`.context/invitation-ux-demo-check-final.log`). Screenshots
are `.context/invitation-ux-local-demo.png`,
`.context/invitation-ux-doom-setup.png`, and
`.context/invitation-ux-existing-room.png`.

The complete final memory gate,
`invitation-ux-verified-memory-1023-200746-c549`, passed in 13m26s. Its
162 host checks, three Node teardown checks, seven Bun teardown checks and
nine browser cases all passed with no skips or automatic retries. Chromium,
Firefox and WebKit each completed all four constrained-memory switches
through Doom, Quake, Freeciv, LÖVE, tmux and WordPress in a persistent page,
and passed the worker-message/exit checks. The full log is
`/Users/brandon/.cache/kandelo/agent-jobs/jobs/invitation-ux-verified-memory-1023-200746-c549/output.log`.
Native Safari was not requested or tested. ABI 52 remains unchanged, and
no additional Rust/libc/POSIX/Sortix or performance claim is made.

The final TypeScript comparison still reports 129 baseline/current browser
diagnostics and zero added diagnostics after the resize fixture change.
`git diff --check` passed. The work remains local and uncommitted on the
original workspace branch. The normal demo server remains at
`http://127.0.0.1:5557/?profile=shell` under job
`invitation-ux-demo-1023-195453-8cfb`.

## Expanded catalog and service images (October 23 follow-up)

The user expanded scope to multiplayer games, shell networking tools, and
service images. Added Quake/Freeciv/Netcat/Python/PHP declarations, free
Doom/Quake data choices, and share-only website/Redis/MariaDB procedures.
Service invitations request the normal shell client image without a demo
profile. Client-only manifests are distinct from installed host procedures.
Redis and 32-bit MariaDB products were promoted into the local gallery at
explicit user request; 64-bit MariaDB remains dormant.

Current preliminary evidence (not the older validation above):

- `.context/network-activities-unit-promoted.log`: 64 cases in five files,
  including source catalogs, client-only resolution, source-rootfs image
  contracts, and direct/proxied WordPress URLs executed with guest PHP.
- `.context/network-activities-browser-types.log`: main/current 129 browser
  diagnostics, zero added diagnostics. Host's `npm run typecheck` passed.
- `.context/network-activities-abi.log`: ABI 52 snapshot/bindings consistent.
- `git diff --check` passed before browser validation.

Build attempts remain evidence, including failures: the initial PHP runtime
sidecar went to the standalone mirror rather than resolver output; adding
`WASM_POSIX_INSTALL_LOCAL_MIRROR=0` fixed that contract. The intermediate
`network-activity-images-fixed-1023-221924-a3b1` build succeeded, before the
final service additions. `network-activities-final-images-1023-223943-9592`
completed all 195 graph nodes but was deliberately terminated during slow
debug-xtask finalization (exit 143), so is not a successful bootstrap.
`network-activities-complete-images-1023-225904-24dd` failed planning because
the newly selected database image recipes lacked explicit repository source
providers. The next attempt failed only Redis image construction because
its tsx CLI Unix socket path exceeded macOS's limit inside resolver work
roots. The Redis builder now uses Node's direct TypeScript loader, matching
MariaDB's existing invocation. Final release bootstrap retry is recorded
under `network-activities-images-ready-1023-230751-a9f8`.

Browser/data compatibility, service clients, and the full current memory
gate are pending at this point. Older browser passes above do not validate
these additions.

The release bootstrap `network-activities-images-ready-1023-230751-a9f8`
succeeded in 1m52s. SourceOnly asset verification passed with 149 imports,
nine memory64 fixtures and publish-size checks
(`.context/network-activities-assets-source-only.log`). An earlier asset
invocation omitted SourceOnly policy and failed on legacy/dormant lookups;
it is retained as `.context/network-activities-assets.log` and is not a
passing audit. The product-routing Rust test passed after promoting Redis
and MariaDB32 to normal `bootstrap_target` dispatch; MariaDB64 stays dormant.

The initial browser smoke run was interrupted after two fixture failures:
Quake connected both players but its test's F1/Escape sequence left native
menu/pointer-lock state ambiguous, and Freeciv's test expected a PID in a
title that does not contain it. The nginx guest had rendered the real page;
a subsequent terminal probe read the first hidden terminal instead of the
selected one. The shared terminal test helper now reads the visible terminal,
and new-terminal tests wait for the ordinary login prompt. A corrected batch
passed nginx (including no duplicate guest server) and MariaDB SQL
`SELECT 617 + 19` returning `636`. It also exposed Redis's actual protected
mode rejection; the server is reachable but remote commands need an explicit
image configuration change. Freeciv reached the two-player native lobby,
but the initial Start coordinate was just left of its small native button
at the shell display size; the fixture now targets its actual center.
Neither failed aggregate is represented as a complete passing browser run.

A separate real UI probe of shell-launched Quake, using Backquote without
pointer lock, successfully typed `status` and observed its native server
count (`.context/activity-quake-input-probe.log`, screenshots
`.context/quake-activity-console-{before,after}.png`). The normal local
preview at `http://127.0.0.1:5558/?profile=shell` has been checked in a fresh
headless Chromium page: all seven host activity choices and four Quake data
choices loaded, with zero page errors
(`.context/network-activities-demo-check.log`). This preview serves the
completed SourceOnly projection. The normal `./run.sh browser` front door
is separately refreshing the projection under
`network-activities-live-demo-1023-231821-3601` on port 5557.

Follow-up attempts and fixes:

- `network-activities-games-tools-1023-232441-ea38` failed all eleven
  cases during module loading because it overlapped a normal image refresh.
  The size/digest guard correctly rejected the partially refreshed LAMP
  projection. This was test orchestration error, not gameplay evidence.
  Browser verification is now held until finalization finishes.
- The normal port-5557 refresh completed its graph nodes, then its debug
  finalizer was deliberately terminated (exit 143, no builder children
  remaining). Release retry
  `network-activities-final-redis-images-1023-232628-91e1` succeeded in
  2m48s, including Redis's explicit virtual-network service configuration.
- The next browser aggregate found a real Unix permission issue in free
  Doom preparation: the host-installed input was read-only to maker, so
  replacing it prompted in coreutils mv. The launcher now retains the
  verified original at `/tmp/kandelo-doom-data.bin`, and prepares a separate
  guest-owned `/tmp/kandelo-doom.wad`. Raw IWAD choices use the same copy
  boundary. The original download can be reused and served unchanged.
  The aggregate was stopped after the first failure; its remaining cases
  do not supply evidence. Rebuild job is
  `network-activities-prepared-game-images-1023-233331-8a14`.
- Final host type generation passed; browser comparison remains 129 main /
  129 current diagnostics, zero additions. Logs are
  `.context/network-activities-{host-types,browser-types}-final.log`.

## Website preview routing (October 24 follow-up)

The user clarified that website invitations should use Kandelo's built-in web
preview, including both local listeners and Kandelo network destinations.
The earlier ELinks join procedures were replaced with digest-matched `web`
launches. Both host APIs now accept an optional HTTP `hostname`; the shared
session runtime forwards these requests through its actual TCP backend,
while omitted hostnames preserve local injected connections. The preview
address field accepts local and session HTTP URLs. Destination changes and
machine teardown retire bridge ports/listeners; leaving the network closes
pending session HTTP requests and restores any original local preview.

Before this follow-up, the remaining Chromium run was stopped at exit 130
when the requested web behavior superseded its ELinks fixtures. It had passed
shareware Quake and LibreQuake native client counts, Python/PHP directory
servers, Netcat, solo Freeciv KMS/existing-host/busy-display behavior, and
nginx/ELinks. These are partial results, not an aggregate suite pass.
OpenQuartz needed a native `-game` startup-config overlay because its original
quake.rc omits `stuffcmds`. Freeciv actually started its game, but the fixture
expected a server log phrase that this launch does not emit; the replacement
checks actual display and turn changes. The web→Quake→web fixture incorrectly
called the title-required `previewFrame` helper without a title; it now uses
the actual visible preview iframe. Quake evidence was strengthened to require
bidirectional native `say` delivery, which reaches fully spawned clients.

The first new 37-case unit run had two obsolete command-launch expectations
and two fake-network tests waiting for more request bytes than the real
request contained. The corrected run passed all 37, zero skips:
`.context/network-web-unit-fixed.log`.

The first targeted Node runtime batch passed real remote TCP (including
256 KiB/backpressure, half-close, refusal, reset), actual guest PHP direct/
proxied WordPress URLs, and both Freeciv executable and AI/save/reload cases.
It was not an aggregate pass: SourceOnly excluded three standalone HTTP
fixtures, and Quake correctly rejected a partially refreshed package member
while the product build was running. The standalone HTTP check is being
rerun under the ordinary resolver; package checks must be repeated only after
the image/projection build completes. No artifact guard was relaxed.

The ordinary HTTP fixture rerun found an old `tiny-http-server.wasm` rejected
by current artifact policy before any test loaded. That pre-existing native
fixture is now in global setup's normal SDK/freshness/ABI-stamp inventory,
so its tests rebuild it automatically instead of relying on an old manual
`build-programs` run. This is fixture provisioning, not a relaxed resolver.

After normal fixture provisioning, all seven HTTP cases passed with zero
skips (`.context/network-web-native-provision.log`), including the same
Node client fetching the remote guest over a session TCP stream and then
its own local injected listener, plus rejection after leave.

The first website image build completed PHP but failed shell assembly because
`coreutils-docs` tracks all `host/src` and those files changed while its graph
was running. This produced different planned/compiled cache identities. No
receipt or binary was edited to conceal it. The next image run freezes all
host and package inputs and uses the now-completed PHP compilation.

The stable website image build completed in 5m39s. Final source checks passed
214 Vitest cases plus the 17-case source-rootfs shell bridge suite, 18 Node
service-worker bootstrap/ownership checks, host declarations, and browser
TypeScript baseline comparison (129 existing diagnostics, zero added).
The current SourceOnly asset audit resolved 149 imports and verified nine
memory64 fixtures plus publish-size constraints. ABI structure and generated
bindings remain consistent at ABI 52. Both TyrQuake heap budgets passed on
the completed projection.

The first website browser run failed its local-switch fixture: a background
PHP launch had not proven its native listener was ready. The test now launches
PHP in a separate foreground terminal and waits for its actual startup line.
The failure also exposed a product UX issue: navigation had retired the
working preview before validating its replacement. Destination changes now
commit only after a real HTTP response and bridge setup; a failed change
leaves the current page visible. Network leave also cancels a pending network
preview without discarding a working local one.

The corrected Python browser case passed the complete peer → local PHP → peer
→ leave sequence. The apparent service-client boot stall was an interrupted
fixture artifact: nginx had already rendered and saved its guest screenshot,
but the test tried to click New terminal while still in the preview view.
It now explicitly selects Terminal first. An independent, actual two-machine
nginx invitation rendered the HTML page in the guest preview, visually
inspected at `.context/network-web-nginx-probe.png`. This is separate evidence,
not an aggregate pass for the interrupted browser batches.

The four website preview acceptance cases passed in 1.1 minutes:
`.context/network-web-browser-verified.log` (Python peer/local/peer/leave,
nginx, WordPress SQLite login, Ruby todo POST observed by the host).
All three Quake data choices then passed fully spawned, bidirectional native
chat and real game rendering; LibreQuake and OpenQuartz guest screenshots
were visually inspected. The remaining runtime batch passed nine cases,
including Netcat, solo Freeciv KMS/share-existing/display-busy rejection,
web→Quake→web restoration, failed preview navigation preserving the page,
nginx/Python, WordPress/MariaDB, Redis remote SET/GET, and MariaDB remote SQL.
It was not an aggregate pass: a PHP guest boot error needs a diagnostic rerun,
and nginx/PHP displayed its actual Adminer SQLite app but the fixture wrongly
expected the implementation word `PHP` in the page. Its marker now checks
`Database schema`.

The two-player Freeciv browser run established native world startup, but its
first header-change assertion was too broad: the saved screenshot still
showed year 4000 BCE. Do not count that as turn advancement. The fixture now
uses real pointer-lock release, a narrower native information strip excluding
focus/lock chrome, and a stable pre-turn baseline before the native shortcut.
This is pending revalidation. Earlier interruptions and weak pixel evidence
are not proof of the stronger claim. New UI actions are bounded to 30 seconds
so fixture mistakes cannot consume an entire eight-minute activity timeout.

The stricter three-case rerun passed: Freeciv, PHP directory sharing, and
nginx/PHP Adminer (`.context/network-activities-final-recheck.log`, 1.4m).
Freeciv's actual final native display was visually inspected and reads
3950 BCE, advancing from 4000 BCE. The test uses a stable information-strip
baseline and actual native keyboard shortcuts, not a UI focus/lock repaint.
The prior PHP client boot failure did not reproduce in this rerun; it remains
one earlier failed run, not retroactively a pass. No boot guard or error was
suppressed. All package host/join types now have specific runtime evidence;
invitation regressions, other-engine checks, and the mandatory full memory
gate are still pending at this point.

The nine-case existing invitation/WordPress regression batch passed in 2.4m,
zero skips (`.context/network-activities-invitation-regression.log`): failed
and incompatible invitations; termchat fresh/attach-existing; Doom shareware
peer acquisition and known hint/uploaded hint/uploaded peer verification;
optional-activity keep/replace/leave; and local WordPress/MariaDB wp-admin
login. Other-engine presentation, service-worker recovery, termchat teardown,
and the full memory gate follow without further production edits.

Cross-engine checks completed without production edits:
- `.context/network-activity-cross-presentation.log`: six passed, zero skips
  across Firefox/WebKit (Freeciv KMS/existing-host/busy-display behavior,
  website→Quake→website, and failed destination preserving the page).
- `.context/network-activity-cross-recovery.log`: 11 passed, four explicit
  skips. Incompatible invitations, optional-activity keep/replace/leave, and
  actual termchat chat/file-transfer/terminal restoration passed on Chromium,
  Firefox and WebKit. The two CDP service-worker restart/cookie-authority
  cases passed on Chromium and intentionally skipped on Firefox/WebKit.
Browser TypeScript still has exactly the main baseline's 129 diagnostics,
zero added (`.context/network-activities-browser-types-complete.log`).
The mandatory ordinary `./run.sh test browser-memory` front door is now
running against the complete tree; its result must be recorded separately.
Native Safari and an external production WebRTC pair were not tested.

## Final memory/lifecycle gate

The complete ordinary `./run.sh test browser-memory` gate passed on the final
production tree in 14m08s (job `network-activities-memory-gate-1024-005601-1cdc`,
`.context/network-activities-memory-gate.log`). It prepared the current
SourceOnly products through the normal graph and passed:

- Seven browser memory-boundary source checks.
- 162 host ownership/reclamation cases in 14 files, zero skips.
- Three Node teardown cases and seven Bun/JSC teardown cases, zero skips.
- All nine required Chromium/Firefox/WebKit browser cases, zero skips/flakes:
  four repeated constrained-budget game/Freeciv/LÖVE/tmux/WordPress switch
  cycles per engine, the main-allocation/reload/guest-backing detector, and
  guest exception-handler-resistant exit. The browser phase took 10.4m.

No production code changed after these gates started. The work remains local
and uncommitted; no PR or deployment was created in this follow-up. The
previously merged termchat work is separate. Validation boundaries remain:
local WebRTC joins were exercised in Chromium; Firefox/WebKit presentation
and termchat checks passed without claiming external ICE coverage; native
Safari and an external production peer pair were not run. Four CDP-only
service-worker restart checks intentionally skipped on Firefox/WebKit.

The served preview remains `http://127.0.0.1:5558/?profile=shell`, with seven
installed shell host activities and four Quake data choices. Website and
database service offers are exposed from their own running images; their
invitations boot the default shell client without requiring a demo profile.
Website clients use the real network HTTP preview, and local/native server
requests retain the local listener path.

Final fresh headless preview check passed after the memory gate:
`.context/network-activities-final-demo-ready.log` confirms the served 5558
URL, all seven host activity choices, four Quake data choices, and zero page
errors. `git diff --check` also passed. The preview server is left running.

## October 24: session dialog and level-picker feedback

The session name is now an editable, prefix-free adjective/noun suggestion
(such as “Cosmic Otters”). Activity titles sort alphabetically. Select arrows
have an explicit inset, and the active-session footer wraps on narrow screens.
Setup and active-session views are separate: a completed offer attempts to
copy its final link, and the active view offers Copy link, Leave session and
Change activity. Clipboard denial retains a selectable link and manual copy.
Invitation metadata renders without waiting for the installed catalog; the
readiness message distinguishes boot, catalog loading, connection/data setup,
and boot failure. The metadata is labeled as supplied by the invitation,
rather than a claim that a remote host has already been checked.

Doom/Quake declare bounded `level` host fields. Known catalogs were checked
against all seven size/SHA-256-pinned distributions with the shared parser:
Doom shareware 9, Freedoom Phase 1 36, Phase 2 32, FreeDM 32; Quake shareware
9, LibreQuake lite 10, OpenQuartz 14. Uploaded WAD/PAK metadata is inspected
on demand and again before launch. Quake BSP brush models are excluded by
checking world/player-spawn entities. Native preparation and original
archives/notices remain unchanged. Custom ZIP uploads are not supported.
Freeciv retains its native world/lobby setup. Package/image inputs declare
the new parser dependency and affected output revisions were advanced.

A native replacement check demonstrated that a Ctrl+C byte cannot stop
Quake: its input adapter correctly disables ISIG for raw keycodes. The final
implementation instead attaches a fresh normal login/PTY with an owned-job
identifier before it can fork. Both workers' existing family ledger follows
all descendants. A zero job deadline means interactive/no scheduled timeout;
cancellation still requires all exits, exact worker detachments, reaping and
explicit release. Replacement then closes that activity terminal. Other
terminals remain independent. An owned root's exit does not restart an
unowned login outside the family. No guest syscall or ABI changed (ABI 52).

Completed validation on the feedback implementation:

- `session-owned-terminal-images-1024-115750-6c19`: normal release-xtask
  bootstrap passed in 5m55s, including the affected shell/service images and
  coreutils documentation closure. The earlier complete image build also
  passed; one initial build was intentionally stopped before recipe work to
  finish declaring the parser's build inputs.
- `.context/session-game-catalog-verification.log`: all seven known catalogs
  matched actual pinned data using the shared parser. The maintainer helper
  `scripts/list-game-levels.ts` also inspected the extracted shareware PAK.
- `.context/session-owned-terminal-unit-final.log`: 184 cases passed,
  zero skipped, covering session declarations, malformed/bounded directories,
  safe map arguments, owned PTYs, root-exit ownership, and deadline/cancel
  fences. `.context/session-owned-terminal-node.log`: 10 native Node cases
  passed, zero skipped, including a zero-deadline PTY family.
- `.context/session-feedback-network-contract.log`: seven controller cases
  passed with Node's test runner. An initial Vitest invocation selected no
  files because this suite uses `node:test`; that invocation was not a pass.
- `.context/session-owned-terminal-browser-ready.log`: all six Chromium
  flow cases passed. Actual Quake E1M2 (“Castle of the Damned”) then E1M3
  (“The Necropolis”) rendered during replacement; PHP followed, and an
  unrelated sleeping process survived. Freeciv's server/client/KMS owner
  retired before Quake acquired the framebuffer. A delayed real image
  request proved invitation metadata/readiness during boot, followed by a
  real termchat join.
- `.context/session-feedback-cross-browser.log`: 10 Firefox/WebKit cases
  passed, with two explicit skips of the Chromium-only local WebRTC fixture.
  Both engines exercised the real Quake and Freeciv replacement paths.
- `.context/session-feedback-phone.log`: the friendly-name/active-dialog
  flow and footer bounds at 390px passed in all three engines.
- `.context/session-feedback-invitation-regressions.log`: nine cases passed
  and one failed because its old selector searched for host settings inside
  the participant form. Settings now live in the shared metadata section.
  After correcting that assertion, `.context/session-feedback-doom-level.log`
  passed the isolated two-player Doom case. Its native automap visibly says
  **E1M2: NUCLEAR PLANT**. This is a failed aggregate followed by a passing
  focused recheck, not a passing aggregate. The nine passing cases include
  termchat fresh/existing offers, rejected/failed joins, room keep/replace/
  leave, three data-delivery variants, a guest PHP preview, and local website
  restoration after Quake exits.
- Early browser fixture iterations were interrupted/corrected: the download
  delay initially held Vite's URL module as well as the actual image; game
  output must be read after selecting the visible Terminal; shell probes
  must wait for a new login's actual prompt. A plain-room assertion also
  needed a timeout covering real signalling startup. These runs are not
  counted as aggregate passes.
- `.context/session-feedback-assets.log`: publish-size guard, nine memory64
  fixtures and 149 browser asset imports passed. The ABI check passed in
  `.context/session-feedback-abi.log`. Host type/declaration build passed;
  browser type comparison remains 129 baseline diagnostics, zero added
  (`.context/session-feedback-types-final.log`).

`session-feedback-memory-gate-1024-122003-3cbf` passed in 13m45s through
`./run.sh test browser-memory`: seven source boundary checks, 162 host
ownership cases, three native Node and seven Bun/JavaScriptCore teardown
cases, and all nine Chromium/Firefox/WebKit browser cases (10.5 minutes for
the browser phase). No cases skipped or retried. Each engine completed the
four constrained-budget game/website switch cycles, reload/allocation probe,
and guest-exit checks. Production source was frozen before this gate began.

The local preview remains `http://127.0.0.1:5558/?profile=shell`, served by
`session-feedback-preview-1024-122209-55cd`. HTTP readiness returned 200.
After the memory gate, `.context/session-feedback-final-demo-ready.log`
passed a fresh headless check of this exact URL: a generated name, all seven
alphabetical activity titles, Doom/Quake catalog counts, the separate active
dialog, actual clipboard contents, and zero page errors. The screenshot is
`.context/session-feedback-final-preview.png`. `git diff --check` passed. Native Safari, an external production peer pair, and new
libc/POSIX/Sortix runs are not part of this feedback validation; guest kernel
and libc behavior did not change. Changes remain local and uncommitted.

## October 24: stable dialogs and complete preboot invitation details

Session setup, invitation and active-session views now share a responsive
fixed-height frame, with an independently scrolling body. Desktop, phone
and short landscape checks compare the actual dialog bounds through
activity selection, room creation, activity changes, leaving and boot.

New links include an optional bounded display snapshot: activity title and
description, labeled host values, participant prompts/defaults, and file
requirements/acquisition hints. It contains no launch commands, option
arguments or destination paths. The preview renders before host module
initialization and image activation can wait. Controls stay disabled until
the entire snapshot matches the installed digest-matched procedure. Old
links remain supported and populate their full prompts after boot. Close
and Dismiss are preserved across the startup handoff. The preview applies
the same saved/system theme as the app, preventing a palette change.

Validation for this iteration (all commands through `scripts/dev-shell.sh`):

- `session-stable-dialog-images-1024-132440-bfc4`: ordinary source bootstrap
  passed in 4m50s, rebuilding the affected image closure after the shared
  schema input changed. No recipes or guest binaries were patched.
- `.context/session-stable-dialog-unit.log`: 173 source cases passed,
  zero skipped. Includes all 15 declared-activity packages fitting the
  invitation envelope, display-field validation, command exclusion,
  mismatched snapshots and old links.
- `.context/session-stable-dialog-types-final.log`: 129 existing diagnostics,
  zero added against the comparison baseline (150 diagnostics). This is
  not a clean whole-app typecheck.
- `.context/session-stable-dialog-assets-final.log`: publish-size check,
  nine memory64 fixture contracts and all 149 browser asset imports passed
  against the final SourceOnly projection. An earlier audit overlapped
  image materialization and rejected stale recorded sizes; that run is
  not readiness evidence.
- `session-stable-dialog-browser-1024-132954-83ec`: all nine Chromium
  dialog/game cases passed. After the theme initialization change,
  `session-stable-dialog-final-1024-133458-ffbc` passed ten focused Chromium
  cases, including actual termchat joining/sharing, Doom WAD transfer,
  failed/incompatible invitations and keeping/replacing/leaving rooms.
- `session-stable-dialog-cross-1024-133147-f055`: 15 Firefox/WebKit cases
  passed, two Chromium-only WebRTC cases skipped, one screenshot fixture
  failed while waiting for document fonts with a module request held.
  The fixture now verifies the pre-initialization view through DOM
  assertions, releases that module request, then captures the same waiting
  dialog while holding the real VFS image download instead.
- `session-stable-dialog-waiting-recheck-1024-133659-f39e`: both Firefox and
  WebKit waiting/verification cases passed after that fixture correction.
  Together with the earlier passing cases, all enabled cases have passed
  on all three engines; the two Chromium-only WebRTC skips remain explicit.

The refreshed local server is `session-stable-dialog-preview-1024-133006-85a8`
at `http://127.0.0.1:5558/?profile=shell`. The previous server was deliberately
terminated (143) after image preparation. A fresh check of this exact URL,
`.context/session-stable-dialog-preview-final.log`, passed real shell boot,
seven sorted activities, map catalogs, the active dialog, actual clipboard
contents and zero page errors. Screenshot:
`.context/session-stable-dialog-final-preview.png`.

No kernel, libc, shared-memory ownership, image-composition or machine
teardown code changed in this iteration. The earlier nine-case memory gate
remains recorded above; it was not rerun for this UI-only follow-up. Native
Safari and external production peers were not run. Changes remain local and
uncommitted.

## October 24: concise dialogs and declaration-owned contextual warnings

Removed the repeated network/privacy/verification/invitation explanations
from the main dialogs. Activity descriptions and package versions are under
About this activity. Optional local-file inputs and fingerprints are under
Use a local file; a required unknown file stays expanded. Readiness and
clipboard messages are short. The stable responsive frame is unchanged.

The long Doom/Quake data paragraphs came from `dependencies[].hint` in the
package manifests; the existing-game level note was hard-coded in
ActivityForms. Hints now describe only the local file choice. The Quake
existing-game note now lives in `offers[].existingWarning`. Generic menu
rendering supports declaration-owned activity warnings, choice-option
warnings, selected-source/file warnings and source-specific level warnings.
Unknown map/source references and warning payloads over 256 characters are
rejected. Host invitation snapshots contain only the selected warnings;
participant forms render only their current option's warning. All display
details still require the installed procedure to match before joining.

FreeDM and OpenQuartz supply brief source warnings only when selected;
switching to shareware removes them. No game identifiers or map-specific
warning strings were added to React components. No arbitrary level
restrictions were invented for maps without a declared caution.

Validation (all commands through `scripts/dev-shell.sh`):

- `session-concise-images-1024-145255-ab68`: ordinary source bootstrap
  passed in 4m59s. fbDOOM revision 14, TyrQuake revision 7 and shell revision
  61 contain the updated metadata; affected service-image parser closures
  were rebuilt normally. Package inputs stayed frozen during the build.
- `.context/session-concise-unit.log`: 175 source cases passed, no skips,
  including selected-warning derivation, choice/level/source validation,
  bounded command-free previews and mismatched-warning rejection.
- `.context/session-concise-types-final.log`: 129 existing diagnostics,
  zero added against the 150-diagnostic comparison baseline. Not a clean
  whole-app typecheck.
- `.context/session-concise-assets.log`: publish-size check, nine memory64
  fixture contracts and all 149 browser asset imports passed after final
  image materialization.
- `session-concise-browser-1024-145830-c046`: 25 cases passed across
  Chromium, Firefox and WebKit in 3m28s, with two explicit Chromium-only
  WebRTC skips. Checks include source warnings appearing/disappearing,
  declared already-running notes, concise preboot metadata, map/upload
  handling, clipboard behavior, stable desktop/phone/landscape frames,
  Close/Dismiss handoff, and actual Quake/Freeciv replacement.
- `session-concise-file-regressions-1024-150204-2254`: all four Chromium
  data cases passed in 1m18s: normal WAD transfer, known-source acquisition
  hints, required uploaded files (including rejecting a wrong size), and
  uploaded peer transfer. Both players reached the native Doom connection.

The preview was restarted after the build at
`http://127.0.0.1:5558/?profile=shell` by
`session-concise-preview-1024-145840-a060`; its previous server was
deliberately terminated (143). `.context/session-concise-preview-check.log`
passed a fresh real shell boot, seven sorted activity titles, data catalogs,
actual invitation copying and zero page errors.
`.context/session-concise-option-check.log` also passed on that exact URL:
OpenQuartz displayed one declared warning; shareware displayed none.
Inspected screenshots include `.context/session-concise-option-warning.png`
and `.context/session-game-invitation-preboot-chromium.png`.

This follow-up changes declarations and UI, not kernel/libc, memory ownership
or machine teardown. The earlier memory-gate evidence remains above; no new
libc/POSIX/Sortix or native Safari runs were performed for this change.
Changes remain local and uncommitted.

## October 24: Freeciv activity display scale

The demo already declares `presentation.displayScale: 1.5`; the activity
launches omitted it and advertised device-density pixels to Freeciv. Both
host and join procedures now declare the same bounded KMS `displayScale`
launch preference. It remains installed metadata, not a URL preference or
command argument. Freeciv fonts, layout and saved options are unchanged.

The generic display host applies the launch override before dispatch,
invalidates any previous size and requests a fresh ResizeObserver report.
A closed display is not revived. Retiring the owned activity restores the
image preference; detaching the kernel clears the override and disconnects
active observers. This permits repeated launches in an existing KMS pane
without accepting its stale native-density measurement.

Validation completed before the graphics/memory gate:

- `freeciv-activity-scale-images-1024-151707-2398`: normal source bootstrap
  passed in 4m34s. Freeciv browser bundle revision 4 and shell revision 62
  contain the declaration; shared-parser image closures rebuilt normally.
- `.context/freeciv-activity-scale-unit.log`: 180 cases passed, no skips.
  Includes 1x/2x/3x grid sizing, stale-size invalidation, image fallback,
  closed-pane and next-kernel behavior, plus declaration validation.
- `.context/freeciv-activity-scale-types-final.log`: 129 existing diagnostics,
  zero added against the 150-diagnostic comparison baseline. Not a clean
  whole-app typecheck.
- `.context/freeciv-activity-scale-assets.log`: publish-size check, nine
  memory64 fixture contracts and 149 browser asset imports passed.
- `freeciv-activity-scale-browser-1024-152203-e5be`: four Chromium cases
  passed in 1m06s: host/guest gameplay with a 2x-density invited player,
  fresh and repeated launches at 1x and 2x, and Freeciv-to-Quake retirement.
  The inspected native game screenshot reached 3950 BCE.
- `freeciv-activity-scale-cross-1024-152346-883f`: six Firefox/WebKit cases
  passed in 1m25s, covering both densities, repeated launches and retirement.
  No cases were skipped in either targeted browser run.
- `.context/freeciv-activity-scale-local.log`: the refreshed exact local URL
  `http://127.0.0.1:5558/?profile=shell` passed a fresh 2x-density check:
  1066x600 guest pixels fitted to 1600x900 CSS pixels, with zero page errors.
  Server: `freeciv-activity-scale-preview-1024-152320-b393`.

The required graphics/memory gate subsequently passed:
`freeciv-activity-scale-memory-1024-152522-b81b`, 13m27s total. Its seven
source-boundary checks, 162 host cases, three native Node teardown cases,
seven Bun/JSC teardown cases and all nine Chromium/Firefox/WebKit browser
cases passed without skips. The browser phase took 10.5 minutes and covered
four constrained-budget cycles through Doom, Quake, Freeciv, LÖVE, tmux and
WordPress in each engine, plus allocation/reload and exit-trap probes.
Log: `.context/freeciv-activity-scale-memory.log`.

Screenshots: `.context/freeciv-activity-readable-{browser}-{density}.png`,
`.context/activity-freeciv-host.png`, `.context/activity-freeciv-guest.png`,
and `.context/freeciv-activity-scale-local.png`. Production inputs were
frozen before the required memory gate began. Native Safari, external
production peer pairing and new libc/POSIX/Sortix cases are not covered by
these targeted checks; guest kernel/libc semantics did not change.

## October 24: minimal integration with main at ABI 53

The working branch was fast-forwarded to main commit
`f068a14c783b9078292e08dfbb2535c0c465f84a`, preserving the uncommitted
activity work. This incorporates main's file exchange, extended attributes,
and orphan adoption/reaping. The single textual conflict in `App.tsx` was
resolved by retaining both the invitation arguments to `useNetworkSession`
and main's exchange hooks. ABI 53 is inherited from main; the activity work
does not introduce another ABI change.

The user requested a minimal integration pass and a refreshed demo after
rebuilding. The first normal browser preparation,
`activity-main-minimal-build-1024-165536-937a`, failed after 2h09m while
successfully completing independent work. Two failures were retained:

- Redis's standalone CLI did not pass its declared dinit dependency into
  the image builder. Its fallback read the previous browser projection and
  correctly rejected a changed member size (644755 versus 644195).
- A concurrent SpiderMonkey producer had already published different bytes
  for the same input key. The cache guard validated and preserved that
  winner, rejected this run's staged bytes, and wrote the mismatch receipt
  for key `59c2b0124de1edbf0753bdebb6f59d4d7938bd9daa7f987045434cd3f9d50d86`.
  Both outputs had matching sizes but different hashes. This is unresolved
  reproducibility evidence; no cache entry or validation rule was changed.

The first Redis correction exposed a second missing explicit input,
`/etc/services`, in
`activity-main-minimal-recovery-1024-190610-9c25`. That failed run normally
reused the validated SpiderMonkey winner and completed the other images.
The Redis CLI now supplies both immutable dinit binaries and the services
database already declared in its recipe. Redis image revision 6 includes
these changes. All source changes were held stable during each build.

The final normal bootstrap,
`activity-main-minimal-final-build-1024-191023-4fa2`, passed in 2m00s:
202 successful nodes, 200 cached and two published. It used a freshly built
current release driver, refreshed the canonical Node rootfs and built the
TypeScript host. This is successful normal cache/build admission, not proof
that the SpiderMonkey outputs reproduce byte for byte.

Focused validation on the combined tree:

- `.context/activity-main-minimal-source.log`: 193 source cases passed in
  three files, zero skips (session contracts, display scaling, owned jobs).
- `.context/activity-main-minimal-native.log`: all 11 native Node cases in
  `node-owned-jobs` and `orphan-reparent` passed, zero skips. The ordinary
  SDK/fixture global setup was retained for this native run.
- `.context/activity-main-minimal-browser.log`: all four Chromium cases
  passed in 1.3 minutes, with no skipped or flaky results: Freeciv's complete
  family/display retirement before Quake, two-player Quake shareware,
  Doom's exchange-driven WAD restart, and a remote Redis console performing
  SET/GET. The combined native/browser job,
  `activity-main-minimal-tests-1024-191250-b65a`, passed in 2m24s.
- `.context/activity-main-minimal-preview.log`: a fresh real boot at
  `http://127.0.0.1:5559/?profile=shell` launched Freeciv at device density
  2, with a 1066x600 guest monitor in a 1600x900 CSS display and zero page
  errors. Screenshot: `.context/activity-main-minimal-preview.png`.
  Server: `activity-main-demo-1024-191425-0820`.

This explicitly minimal pass did not rerun the full memory gate, the other
browser engines, native Safari, external peer/NAT pairing, or the full
conformance suites. Earlier ABI-52 results above remain historical evidence;
they are not combined-tree validation for ABI 53. Changes remain local and
uncommitted.

## October 24: integrated Redis board and WordPress SQL invitations

The Redis gallery entry now opens a real guest PHP HTTP service backed by
Redis, with shared ideas and atomic votes. Its activity invitation opens the
host's board in a second computer's Kandelo web preview. The standalone
MariaDB gallery entries and their SQL-test-runner activity were removed;
WordPress with MariaDB instead offers both its website and an interactive
WordPress MySQL connection. The invited client uses upstream MariaDB's
interactive CLI against the host's existing `wordpress` database. The
package declaration warns that this demonstration has no database password
and invited people can edit the database.

The MariaDB package now publishes `mariadb.wasm` on wasm32 and wasm64. It
builds real target terminfo from the declared `ncurses-source` dependency
inside its private recipe roots and uses the bundled GPLv2-compatible line
editor. An upstream-internal extern declaration returned `int` while its
function definition returned `void`; the one-line source patch makes those
signatures agree and avoids an invalid typed Wasm call during history
search. The package uses the existing `NEED_EXTERN_PC` feature to reference
terminfo's terminal globals, rather than defining duplicate symbols.
Redis image revision 8, MariaDB revision 5, lamp revision 24 and shell
revision 63 carry the changed artifacts through the normal resolver.
This work adds no kernel/runtime behavior or ABI change; ABI 53 comes
from main.

Build failures were retained and corrected rather than bypassed. The
missing curses headers were agent packaging/integration mistakes: the
first attempt did not stage them in the private sysroot, and the second
flattened a nested include tree. The final installation preserves the
complete header tree and its flat aliases. Early browser attempts also
caught an obsolete retired-image metadata import and a missing client
lazy-asset mapping; both were fixed in their owning configuration. No
artifact stamping, cache deletion, manual program substitution, Linux
identity macro, or validation relaxation was used.

Validation of the final package/browser inputs:

- `redis-wordpress-history-build-1024-210546-a8dd`: normal full browser
  bootstrap passed after 24m42s. Both MariaDB client architectures built;
  the history-function signature warning is gone. The pre-existing server
  `thd_rpl_deadlock_check` signature warning remains outside this change.
  The normal SourceOnly projection, canonical rootfs and host were updated.
- `.context/redis-wordpress-source-register-final.log`: 25 package-session
  source cases and the registry check passed. Source-only evidence.
- `.context/redis-wordpress-xtask.log`: 782 xtask unit cases and six
  integration cases passed, with no ignored cases.
- `.context/redis-wordpress-registry-tests.log`: all 24 registry/catalog
  Node tests passed, with no skipped cases.
- `.context/redis-wordpress-assets.log`: publish-size check, nine memory64
  fixture contracts and all 155 browser asset imports passed.
- `redis-wordpress-final-browser-1024-213054-24f4`: all five selected
  Chromium cases passed in 1.0 minute, with no skipped or flaky cases.
  Redis clients added an idea, voted from two computers, observed the
  shared count of three, rejected an empty title, and verified the data
  through real remote Redis CLI commands. The SQL guest selected real
  WordPress rows, recalled and re-executed a query through Alt-P history
  search, changed the blog title, observed it on the host website and
  exited the client normally. Three SQL configuration checks also passed.
  Log: `.context/redis-wordpress-browser.log`.
- `redis-wordpress-exact-live-links-1024-214235-3a06`: fresh actual
  gallery-image URLs on port 5559 booted both products, displayed their
  websites, exposed the SQL sharing option and produced zero page errors.
  Screenshots were visually inspected:
  `.context/redis-voting-board-preview.png` and
  `.context/wordpress-mysql-activity-preview.png`. Profile-only URLs do not
  select an image; the shared URLs include each resolved `vfs` image URL.

The first required memory-gate run found a missing exact review entry for
main's existing `kernel_publish_process_exit` call. Its Rust signature is
`pid: u32 -> i32`; no host memory pointer or staged buffer crosses that
call. The test audit now records that one scalar call and asserts both its
ABI signature and Rust parameter type. Runtime code, the ABI and memory
budgets are unchanged. The rerun passed all seven source-boundary checks,
163 host-memory cases, three native Node teardown cases and seven Bun/JSC
teardown cases, with no skips. The browser result is recorded below.

`redis-wordpress-memory-final-1024-213739-6dee` finished with eight of the
nine browser cases passing and one failure, with no skipped cases. Chromium
and WebKit completed all four constrained-memory switching cycles and their
two probes. Firefox passed its two probes but failed during Quake: audio
remained `suspended` despite trusted clicks on the production Enable button,
and the unchanged 30-second audio-readiness assertion timed out. The browser
phase took 12.4 minutes. The cause of the suspended audio is unresolved; this
is not evidence that Firefox itself or these new demos caused the failure.
The full memory gate therefore did not pass, and the branch is not claimed
fully merge-validated. No timeout, audio requirement or memory limit was
weakened, and the failed sequence was not retried to obtain a green result.
Log: `.context/redis-wordpress-memory-final.log`; preserved Firefox evidence:
`.context/redis-wordpress-firefox-memory-failure/`.

The new invitation workflows were tested in Chromium only. The full
memory-gate WebKit coverage is not native Safari evidence. Native Safari,
external peer/NAT routing and full libc/POSIX/Sortix suites were not run for
this package/demo change. All changes remain local and uncommitted; the
port-5559 preview server is left running for the user.

## October 24: graphical Redis commands with phpCacheAdmin

The voting board now links to unmodified upstream phpCacheAdmin 2.7.3,
initially opening its command console. The same guest PHP service serves
its console, key browser, history and other Redis panels. Both local and
invited web previews operate on the board's real Redis server. The
homepage link returns to the board, where command writes become visible
on refresh. The image config selects only Redis, uses bundled Predis,
places temporary files under `/tmp` and omits the authentication-setup
wizard for this intentionally shared temporary demo. The activity-owned
warning explains that invitees can edit or delete its data.

`phpcacheadmin-source` declares the pinned, checksum-verified source
archive. Redis image revision 9 includes its runtime files, unchanged
Predis/Twig archives, PHP's existing Phar extension and third-party
notices for the bundled charting libraries. The PHP/Redis executables were
reused through the normal resolver. Configuration, templates and Phar
files are not public HTTP assets. No kernel behavior or ABI changed.

The integration exposed an existing preview issue: its generic inline
blob-iframe helper was injected into a document whose Content Security
Policy (CSP) did not authorize it. The bridge now leaves that inline
helper out of documents carrying a CSP response header and preserves the
header unchanged. Ordinary non-CSP documents still receive the helper.
The blob-iframe adapter is consequently unavailable in CSP documents;
ordinary pages, assets and requests still use the normal bridge.

Validation:

- `redis-command-ui-ready-build-1024-223136-9c14`: normal release-driver
  bootstrap passed in 1m48s, reusing compiled programs and publishing the
  current image/projection through the usual resolver. The canonical Node
  rootfs and host artifact check also completed.
- `redis-command-ui-verified-checks-1024-223447-7686`: all five selected
  Chromium cases passed in 52.5 seconds, without skipped/flaky cases.
  The extended Redis invitation test opens the upstream command UI on a
  separate client, reads the real ideas hash, increments the vote score
  from three to five, observes five on the host board, recalls history,
  displays Redis's unknown-command error, browses keys, returns to the
  board and verifies five through remote Redis CLI. It also verifies
  that private application files return 404, the normal board's helper
  runs, the CSP page's helper does not run, and the browser still rejects
  an unauthorized inline script. The WordPress SQL invitation/history
  case and three existing SQL configuration checks passed too.
  Log: `.context/redis-command-ui-browser.log`.
- `.context/redis-command-ui-registry.log`: all 24 registry/catalog Node
  cases passed, no skips. `.context/redis-command-ui-assets.log`: size
  checks, nine memory64 contracts and all 155 asset imports passed.
- `redis-command-ui-final-live-1024-223341-00e4`: a fresh current-image boot
  on port 5559 opened the console, executed HGETALL and ZRANGE against the
  board and produced zero page errors and zero console errors. The
  screenshot `.context/redis-command-console-preview.png` was inspected.
  Live server: `redis-command-ui-preview-1024-223333-9895`.
- Final `git diff --check` passed in the declared development shell.

Earlier unsuccessful attempts remain evidence. The first source URL did
not have an archive suffix the resolver supports; it was corrected to
GitHub's normal `.tar.gz` URL with the same verified bytes. The initial
preparation was intentionally interrupted after completed image builds
to include missing bundled-library notices, then normal preparation was
rerun with the release driver. An initial browser check successfully
performed the remote write but found the delayed authentication wizard
over the Keys link. A later test assertion incorrectly used Playwright's
text filter to inspect script source; it was replaced by an observation
of the helper's actual execution. Neither failure was retried unchanged
or hidden by force-clicks, relaxed checks or disabling CSP.

This task did not rerun native Safari, other engines' new Redis UI flows,
external peer/NAT pairing, conformance suites or the full memory gate.
The earlier Firefox Quake audio failure remains unresolved; these results
are not a claim that the entire activity branch is merge-validated.

## Host activity discovery and prominent session feedback — 2026-10-25

Joined clients now receive the host's offers on a bounded, host-owned RTC
channel. Their Change activity menu joins those offers on the current
network; Replace current session opens the local hosting catalog. The
host advertises its current configured activity plus installed, available,
field-free/dependency-free share-only services. Unstarted games are not
advertised. The peer purpose is now `network-activities-v2`.

New invitations bind the selected join contract, allowing host-only
presentation edits without changing client launch authority. Legacy
invitations still require an exact manifest digest. The reported Redis
failure was not reproduced: the user reported that the link works again,
and no failing URL was available. These checks demonstrate compatibility
rules and current Redis behavior, not the cause of that earlier failure.

Copy confirmation, machine readiness, connection progress and file receipt
now have a large status card outside the scrolling dialog body. File
receipt uses actual byte counts, a percentage and a native progress bar.
The fixed dialog frame and compact secondary details remain intact.

Evidence from the declared development shell:

- `session-feedback-build-1025-005355-2435`: normal release-driver
  `xtask bootstrap` passed. Shared session-source changes regenerated
  affected browser images through SourceOnly; existing application builds
  were reused. No ABI change or artifact restamping.
- `.context/session-remote-unit.log`: 27 package-session tests passed,
  including selected-contract compatibility, rejection of changed client
  launches/ports, legacy identity checks, and advertisement validation,
  updates, host authority and payload bounds.
- `.context/session-remote-controller.log`: seven controller cases passed.
- `.context/session-feedback-browser.log`: seven Chromium cases passed;
  the eighth reached the correct negative rejection but its broad alert
  locator matched both the new heading and the detailed error. After
  scoping that assertion and also checking the prominent error heading,
  `.context/session-feedback-negative-browser.log` passed that case.
  No product changes were made between these browser runs.
- The eight browser cases cover a real Freedoom Phase 1 transfer and
  two-player game; live Netcat discovery followed by bidirectional guest
  TCP on the same room; Redis's invited web console; WordPress SQL followed
  by selecting the remotely advertised website without replacing its room;
  copied/denied clipboard paths; preboot metadata and readiness; and
  rejection of modified invitation display details. The transfer fixture
  holds an actual RTC chunk to inspect the 512 KiB progress display, then
  releases it and verifies normal gameplay.
- `.context/session-feedback-assets.log`: size checks, nine memory64
  contracts and all 155 browser asset imports passed.
- `session-feedback-live-check-1025-010216-5e3d`: fresh shell boot on 5559,
  automatic copying and manual recopy verified against the real clipboard;
  key notice/footer visible at desktop and phone sizes; zero page errors
  and zero console errors. Inspected active, startup, transfer and phone
  screenshots under `.context/`. Preview server:
  `session-feedback-preview-1025-005911-b302`.

These are browser session/protocol and presentation changes. The shared
contract helpers have Node tests; this pass does not change Node kernel,
guest socket, process or device behavior. It did not rerun other browser
engines, native Safari, cross-computer/NAT pairing, conformance suites or
the full memory gate. The earlier Firefox Quake audio limitation remains
outside these results; this is not whole-branch merge validation.

## Session identity order and contextual activity switching — 2026-10-25

The pinned session-name row now precedes the activity details and prominent
status card. The status card has 16 CSS pixels of vertical padding above
and below its container; the scrolling form retains its own spacing. The
same order is used before the machine boots and after it becomes ready.

Joined clients see Change activity only when the host advertises an
alternative to their current selection. Matching current parameters and
content are omitted even if display metadata changes; changed parameters
or data can be joined as a new offer. The client menu contains only remote
alternatives, without a local hosting selector. A separate New session
action prepares a local room replacement. Discovery errors remain visible
even when there are no selectable alternatives. Hosts retain their own
Change activity controls.

Validation through `scripts/dev-shell.sh`:

- `session-layout-choices-check-1025-011158-4004`: all six focused
  Chromium cases passed, no skips. Real Quake shareware peers verified
  the single-game guest UI; Netcat verified that Change activity appears
  when an offer arrives, disappears after joining, and New session creates
  a different room while the old host stays connected. WordPress verified
  SQL-to-website switching in the same room and the reverse SQL option.
  Dialog cases verified name-before-status ordering and at least 16 px
  separation, preboot metadata, unchanged frames, clipboard and mobile
  controls, and negative invitation validation.
- `session-quake-choice-proof-1025-011457-b852`: the Quake case also
  passed with explicit positive checks for the populated active dialog
  and New session before checking Change activity's absence. Its screenshot
  disables opening animations for inspection. No product code changed
  after the six-case run.
- `.context/session-layout-choices-assets.log`: size checks, nine memory64
  contracts and all 155 browser asset imports passed.
- `session-layout-choices-live-1025-011422-c189`: the existing live preview
  booted a fresh shell, verified name/status spacing and both copy paths,
  and checked desktop/phone visibility. Zero page or console errors.
  Screenshots inspected: `.context/session-invitation-waiting.png`,
  `.context/session-layout-choices-phone.png`, and
  `.context/session-quake-guest-actions.png`.

This pass changes app React/CSS and browser fixtures only. Existing prepared
images remain current; no package/image rebuild, ABI change, Node kernel
change, or protocol change was needed. Other browser engines, native Safari,
external-network pairing, conformance and the full memory gate were not rerun.

## Publication decision and final main integration — 2026-10-25

The maintainer reports that Quake audio works in Firefox and requests
publishing this work without further costly test runs. This is manual
maintainer evidence, not a passing rerun of the automated memory gate.
The earlier suspended-audio failure and all recorded limitations above
remain part of this PR's validation history; its cause is not established.
No further runtime tests, memory-gate runs, package builds or browser image
rebuilds were performed for publication.

The worktree was fast-forwarded from `f068a14c78` to main's `5cd771bff8`
(Vitest evidence-registry enforcement). All main classifications were
preserved, with the new package-session source tests and WordPress network
configuration prepared-product tests added at their sorted positions.
Existing runtime/browser results precede this final integration. Publication
uses the recorded evidence and the maintainer's explicit decision to defer
further costly testing; it does not claim a green complete memory gate.
ABI 53 and its snapshot are unchanged by this feature.
