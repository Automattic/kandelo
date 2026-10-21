# Cross-process graphics follow-up (work in progress)

The Freeciv port does not currently demonstrate these two failures
during ordinary play. The follow-up protects general device sharing
contracts. Both concerns now have reproductions built with Kandelo's SDK
and run through its ordinary guest syscalls, kernel, and dedicated host
worker.

## Imported handle lifetime

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

## Importer-written cursor pixels

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

## Review and validation still required

- Make every guest regression pass after repair, with its positive
  controls retained.
- Cover allocator/importer exit, explicit close, exec, trap/forced
  removal, failed launch, and final-reference destruction without leaks.
- Cover disjoint writes within one page as well as unchanged readers.
- Validate both Node and browser host paths and the ABI policy.
- Rebuild affected kernel/guest artifacts and run relevant Rust, host,
  conformance, and repeated browser memory/lifecycle checks.
- Native Safari follow-up is separate from Playwright WebKit evidence.

The focused Node test fails for the unmapped importer and passes its
mapped control. The focused Chromium test samples the actual canvas:
importer writes show the white page background, while allocator writes
show red. A further control makes the allocator write only after the
peer has mapped the old pixels. That stale peer must not overwrite the
newer allocator pixels when it submits the cursor. Both tests currently
fail for the defects they are meant to protect; they must pass after
repair before this draft can merge.

Neither cross-process buffer-sharing repair is implemented yet.

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

These results protect the presentation handoff. The original imported
buffer lifetime and importer-written cursor defects above remain
unfixed, and the complete port browser suite and multi-engine memory
gate are not established by these focused checks.
