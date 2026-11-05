# Cross-process graphics follow-up

The initial findings below record the failing baseline. Repairs are now
implemented and validated on rebuilt products. The final validation
section distinguishes current passes from historical failures and the
remaining validation limits.

The Freeciv port does not currently demonstrate these two failures
during ordinary play. The follow-up protects general device sharing
contracts. Both concerns now have reproductions built with Kandelo's SDK
and run through its ordinary guest syscalls, kernel, and dedicated host
worker.

## Initial reproduction: imported handle lifetime

An allocator creates and exports a 64x64 graphics buffer. Another guest
imports its file descriptor and selects the buffer as its cursor. The
allocator then exits. The root guest waits for that exit; the test
driver awaits the real host termination acknowledgement before allowing
the survivor to map its retained handle.

- An importer that has never mapped the buffer fails to map it afterward
  (`ENOMEM`).
- A control that maps and unmaps the import before allocator exit
  succeeds and reads the expected first and last pixels.

The host registry discovers consumers through mappings, so its process
cleanup can delete storage that the kernel's valid imported handle and
cursor still retain. The host's mapping inventory is not a reference
count.

The intended repair is to keep address-space retirement separate from
buffer lifetime and let the kernel's final-reference destruction event
retire independent host storage. Before making that change, audit forced
termination and failed launch cleanup so they also release real kernel
references. Simply retaining every orphaned buffer would hide a leak.
Audit inherited cursor references alongside existing handle/framebuffer
references, including fork, spawn, and close-on-exec. The source audit
also found that `bump_inherited_dri_bos` counts GEM handles and
framebuffers for a spawned child without counting its cursor reference.
Add a guest regression for that path before changing the reference
bookkeeping.

## Initial reproduction: importer-written cursor pixels

A real browser guest creates and exports a buffer, and a second guest
imports it and selects it as a cursor. The control allocator fills the
buffer with opaque red. In the failing case, only the importer writes
red. Both processes stay alive while the browser presents the cursor.

Observed first presented pixel through the actual worker's 2D canvas
path:

| Writer | Actual RGBA | Expected RGBA |
|---|---|---|
| Allocator | 255, 0, 0, 255 | 255, 0, 0, 255 |
| Importer | 0, 0, 0, 0 | 255, 0, 0, 255 |

Cursor publication currently copies the allocator's mapping. Allocation
identity does not identify the writer. Copying all mappings
indiscriminately would also be wrong: an older reader could overwrite
newer pixels.

The existing anonymous and file `MAP_SHARED` paths in
`host/src/kernel-worker.ts` already compare per-mapping snapshots and
merge only changed byte runs. Reuse that principle, and extract shared
logic where appropriate, instead of introducing a cursor-only writer
assumption. Budget any extra snapshots and keep them inside the
disposable kernel worker.

The repair must define publication at real device synchronization
points. A submitting syscall can define when to publish; its caller is
not necessarily the only writer. Cover later writes to an active image
and stale reader mappings, not only the initial cursor selection.
Preserve bounded independent device storage; never send guest memories
or their views to persistent browser/audio realms.

## Initial repair acceptance criteria

- Make every guest regression pass after repair, with its positive
  controls retained.
- Cover allocator/importer exit, explicit close, exec, trap/forced
  removal, failed launch, and final-reference destruction without leaks.
- Cover disjoint writes within one page as well as unchanged readers.
- Validate both Node and browser host paths and the ABI policy.
- Rebuild affected kernel/guest artifacts and run relevant Rust, host,
  conformance, and repeated browser memory/lifecycle checks.
- Native Safari follow-up is separate from Playwright WebKit evidence.

At baseline, the focused Node test failed for the unmapped importer and
passed its mapped control. The focused Chromium test sampled the canvas:
importer writes show the white page background, while allocator writes
show red. A further control makes the allocator write only after the
peer has mapped the old pixels. That stale peer must not overwrite the
newer allocator pixels when it submits the cursor. Both tests failed for
the defects they were meant to protect; they now pass after repair.

At this initial investigation stage, neither sharing repair was implemented.

## Additional Freeciv browser investigation

The rebuilt 100% presentation / 25% first-run sound image boots and
renders its native menu at Retina density. Its initial 35-case Chromium
run reported nine passes and two failures before investigation stopped
it: one case was interrupted and 23 did not run. This does not establish
a passing complete browser suite.

The saved-mode fixture acknowledged a dock command before the new
client's selected scanout was visible. It now waits for that real mode.
Click-to-lock and its Escape hint then passed at both densities. The
cursor-edge recovery checks still failed at both densities. A fresh
machine edge probe also failed; read-only diagnostics have observed
valid cursor coordinates returning from the guest. Distinguish input
delivery, presentation, and observer timing before assigning a cause.

A focused 12-case run passed ten checks: fresh defaults and settings
preservation, menu audio, main-menu quitting, resolution changes, and
font typing at both densities. Both active-game quit checks failed.
Their screenshots showed that the old warm-pixel assertion could pass
without Options having opened. The quit fixture now clicks the visible
game-menu button and observes the actual titlebar before clicking Quit.
That stricter check passed at ordinary density but still failed at
Retina density. The latter remains unresolved; no runtime repair is
claimed. Keep actual canvas and guest behavior as acceptance evidence.

## Terminal handoff after graphical applications exit

The shared KMS presentation now separates display capability from active
ownership. The kernel worker publishes its DRM master PID in the existing
independent display statistics buffer, including zero when no process
owns the display. The browser continues mounting and measuring that
capability while hidden, but only selects the graphics pane for an
active owner. Release returns the selected pane and keyboard focus to
the terminal and releases pointer capture and held buttons. A new owner
can reopen the same display. No Freeciv changes or guest ABI changes are
needed.

A real Node guest verifies explicit master release, normal exit, forced
termination, and ownership surviving an unrelated child's exit. The
focused 15-case Node run passes. Browser regressions verify native
Freeciv Quit, automatic selection and focus of the existing terminal, typed
relaunch without a focus click, and a second successful Quit at both
ordinary and Retina densities. A separate SDL application also exits to
the focused terminal. All three Chromium cases pass; the Freeciv handoff
regression fails against the previous preview.

These results protect the presentation handoff. At this handoff-only stage,
the original imported buffer lifetime and importer-written cursor defects
remained unfixed. These focused checks did
not establish the complete port browser suite or multi-engine memory gate.


## Shared-buffer repairs and adjustable presentation

The kernel now determines the lifetime of host BO storage through its
existing reference counts. Host process retirement removes only its
mappings and observed membership, preserving storage for unmapped imports.
Final reference destruction releases storage and derived textures. Forced
process removal and failed spawn rollback now collect the same DRI close
effects as ordinary close; the adapter drains those effects. Spawn also
retains inherited cursor references, balancing close/exec retirement.

The host publishes changed byte runs from each mapping relative to its
private snapshot. This merge primitive is shared with anonymous MAP_SHARED
publication. Cursor and texture publication no longer assume the allocator
is the writer. Unchanged stale readers cannot overwrite new pixels, and
later importer writes can update a selected cursor without reselecting it.
Snapshots are bounded by each mapping and BO size, remain worker-local, and
retire with their mappings. Wasm memories still do not live-alias; applications
must synchronize overlapping writers.

The preferred-display-scale menu was removed after user testing showed
that it did not reliably change UI size. It changed connector preferences,
but an already-running client or a saved resolution could ignore it. The
session override API and its state were removed with the menu. Freeciv's
image still prefers 150% on first launch; its own Screen resolution option
changes the actual render resolution. Whole-display fitting remains.
The reported cursor offset after changing preferences is still under
investigation; canvas bounding-box checks alone did not establish correct
visible cursor placement or hit testing.

Early validation: the Rust workspace passed 2,914 tests. The focused
source selection passed 248 tests, including shared-memory publication
regressions. Twelve Chromium Freeciv checks passed at ordinary and Retina
density, covering live zoom with a saved resolution, scrolling and hit
testing, picker drags, font typing, resolution changes, and quit/relaunch.
These browser checks used the verified baseline kernel and current host/UI;
they do not replace final combined-tree checks. Four cursor-pixel probes
passed, including allocator/importer controls and a later importer update.
All four imported-buffer survival cases now pass against that same baseline:
normal exit with mapped and unmapped imports, hard host removal, and a trap.

The real inherited-cursor guest regression fails against the baseline
kernel with EINVAL after repeated child close-on-exec. This complements the
Rust reference-count regression. It now passes against the rebuilt kernel
through the normal completed projection, alongside the four lifetime cases,
exec, shared-memory publication and session checks: 261 pass across nine files.

All 15 cursor pixel/exec browser probes pass across Chromium, Firefox and
WebKit. The earlier fitted UI passed 15 Chromium checks on the rebuilt image:
both densities, preference changes, fitting down/up with viewport changes,
cursor alignment, picker drags, font input, resolution changes, saved modes,
terminal handoff and a separate SDL application. These superseded the early
baseline-image UI evidence above but did not establish live scaling or
exclude the subsequently reported cursor mismatch.

Conformance checks pass: 24 Sortix process cases, 13 selected descriptor/memory
cases, and eight Open POSIX mapping/sync cases with two existing expected
failures and no unexpected failures or skips. The ABI snapshot and host
declaration checks pass. App typechecking still reports the same 82 existing
diagnostics as origin/main, with no new diagnostics.

The complete browser-memory gate passed again after the fitted UI correction:
162 host checks, three teardown cases on each of Node and Bun, and nine
browser cases. Chromium, Firefox and WebKit each completed four
Doom → Quake → Freeciv → WordPress cycles, with real audio, in one
persistent page and audio realm. Native Safari 27.0.1 on macOS 27.0.1
exposed a window, but input/rebinding failed with cgWindowNotFound;
zero native switching cycles completed. The earlier cursor-edge and Retina
active-game Quit checks remain unresolved; the complete Freeciv suite and
general performance are not established as passing.

Broader testing also exposed dock replacements interrupting the primary
terminal while a different terminal owned the display. KMS replacements now
signal and await the actual display owner through the shared device-owner
helper. The browser fixture deliberately launches in the second terminal;
its dock, picker, and resolution flows pass with that ownership repair.

A further source regression exposed a survivor missing the last publication
after its writer unmapped, exited, or replaced its address space. All three
cases failed before pending-reader tracking and now pass. Pending readers
retire with their mapping or after consuming the published bytes; their
refresh eligibility does not depend on another writer remaining mapped.

After removing the ineffective scale control, 146 session tests pass.
Four Chromium checks pass at 1× and 2× density, covering fresh 150%
defaults, visible cursor pixels, actual Options clicks, and fitting down
and up without overflow. Two additional active-game checks pass, including
cursor shape/hotspot changes, losing and restoring pane focus, unit cycling,
and end-turn controls. These checks do not reproduce the user's reported
offset. Native Brave control failed with cgWindowNotFound, so that report
remains open; no cursor repair is claimed by the menu removal.
The current app typecheck has 129 diagnostics both here and in the
origin/main comparison tree, with no new diagnostic messages. The full
browser-memory gate was not rerun for this menu/API cleanup. This change
modifies neither the kernel nor package artifacts.

## Final validation after integrating main (2026-10-21)

Main's compiler/test-tool update at `88b119483fbf` is integrated. Normal
SourceOnly preparation passed all 186 nodes and eight products, with
178 verified cache hits and eight rebuilt nodes. The kernel and shell
image hashes match the products used for the native checks below.

The complete 36-case Freeciv Chromium suite now passes without retries
or skips. It includes a two-player local network game, both display
densities, visible cursor pixels and real menu targets while fitting the
viewport up/down, pointer edge recovery, focus changes, nation-picker
drags, map orders, both Quit paths, resolution changes, font input, and
audio. All 15 independent cursor pixel/exec probes pass across Chromium,
Firefox, and WebKit. The original offset after changing the removed
preference was not reproduced; its original root cause remains
unconfirmed, and menu removal is not claimed as a cursor repair.

The remaining Quit failure was an observation defect: the helper read
stale DOM rows from a hidden terminal rather than the selected terminal's
painted screen. It now selects and observes the intended terminal. The
Quit assertion also verifies automatic terminal handoff, executes a real
command in the launching shell, checks status zero, and verifies that
client and server processes are gone. Six additional active-game Quit
repetitions passed, three at each density. No additional cursor or Quit
runtime workaround was added in this validation pass.

Fresh checks also pass: 2,914 Rust tests across 44 test/doc binaries;
299 host/session checks across 13 files; 204 browser unit tests; ABI 50
snapshot/generated bindings; production browser and host declaration
builds; 24 Sortix process and 13 selected descriptor/memory cases; and
eight selected Open POSIX cases with two existing expected failures.

The full browser-memory gate passes on this combined tree: seven source
protocol/probe checks, 162 host checks, three teardown cases on each of
Node and Bun, and all nine browser cases without skips or retries. Each
engine completes four Doom → Quake → Freeciv → WordPress cycles in one
persistent page/audio realm, with real frames, trusted audio activation,
WordPress responses, and memory-boundary/retirement checks.

Native Brave 155.1.97.57 on macOS 27.0.1 passed trusted audio activation,
menu/options clicks, pointer capture/release, focus out/back, and an
active hosted game. Clicking Quit restored the terminal automatically;
a real shell command reported exit status zero. A too-fast recapture
surfaced the browser's cooldown error and a later click worked.

Native Safari 27.0.1 on macOS 27.0.1 completed four constrained-budget
Doom → Quake → Freeciv → WordPress sequences through the gallery in the
same page, with trusted audio activation and Hello world observed on
each cycle. Native capture omitted central game, terminal, and gallery
pixels even while the user confirmed the game was visible. These native
checks establish control/switching observations, not pixel sampling.
The earlier native-control failures stopped after unlocking the screen.
Only the owned Safari test window was closed afterward.

Browser app typechecking remains failing: 129 current diagnostics versus
131 on main with the same compiler and zero new diagnostic messages.
This is a baseline comparison, not a passing typecheck. Native iOS,
full libc/Sortix, cross-computer routing, and general performance were
not validated in this pass.
