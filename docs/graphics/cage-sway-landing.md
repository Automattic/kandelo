# Cage and sway landing

[PR #1574](https://github.com/Automattic/kandelo/pull/1574) lands the
infrastructure and normal package/image integration for upstream cage
0.3.1 and sway 1.12 on wlroots 0.20.2. Its runtime source cut is
`21f3d451bb`; the landing also integrates main `e4bca8639e4b` and its
program-ABI crate extraction, package build fixes, terminal signal wakeup,
WebKit thread-worker retirement, real yacc/lex and guest NetHack build. Existing consumer evidence
predates that main integration; normal combined rebuilds and acceptance
remain required. This is a bounded compositor consumer contract; complete
GLES 2.0 and advertised EGL 1.5/extensions conformance continue in
[follow-up PR #1594](https://github.com/Automattic/kandelo/pull/1594),
tracked by the [graphics baseline](compatibility-v1.md).

## Contract being landed

- Normal wasm32 package builds, declared dependencies and VFS images
  provide cage, sway and their clients, configuration and input data.
- The single-display legacy DRM/KMS path supports device discovery,
  master and framebuffer authority, PRIME/dma-buf images, GPU scanout
  and input used by these compositors.
- Shared contexts, objects, storage, descriptors and mappings retain
  independent owners through close, fork, exec and retirement. The
  completed ownership and rollback foundation stays in this landing.
- Node checks exercise real compositor processes and lifecycle behavior;
  Chromium, Firefox and WebKit exercise actual rendered sessions.
- Cage accepts client input and exits with its session. Sway exercises
  tiling, focus/input, IPC, its status bar and cooperative exit.
- Existing graphics applications remain regression consumers. ARGB
  native-window support repairs the SDL path exposed by rebuilding
  Freeciv; it does not introduce a Freeciv-specific workaround.

Use one coherent unpublished epoch: program ABI 56, kernel-host version
3, GL operation table 17 and fork record 21. Regenerated declarations,
SDKs, kernel, packages and images must match their exact source. No
artifact from another revision becomes current by restamping it.

Contributor attribution remains intact, including mho22's port work from
PR #1539, Brandon Payton's graphics work and Emmanuele Bassi's GTK
source correction. The landing preserves newer main behavior.

## Executable acceptance

Run from the repository development shell (`scripts/dev-shell.sh bash`).
Retain commands, source revision, artifact hashes, exit statuses and
reports in the baseline ledger. Long build/suite runs use
`scripts/agent-job` as described in the validation guide.

1. Build the normal product graph with `./run.sh setup` or the same
   bootstrap graph through the normally built release xtask. Explicitly
   build the optional CTS package with `xtask bootstrap graphics-cts-egl
   --jobs 4`, rebuild programs with `bash scripts/build-programs.sh`,
   and run `bash scripts/check-abi-version.sh`. Use the xtask freshness
   check; do not substitute copied artifacts.
2. Run native graphics checks and `host/vitest.graphics.config.ts`, plus
   normal guest-backed cage/sway, foot, DRM/KMS, mapping, GBM file-owner
   and render-ring tests. Both guest widths remain required where the
   fixtures support them; compositor packages currently build wasm32.
3. Run `test/wlroots-rendered-session.spec.ts` and the inherited DRM,
   scanout-format, native-window, render-ring, mapping/file-owner and
   pinned EGL CTS browser fixtures in Chromium, Firefox and WebKit.
   Rendered pixels, input, accepted modesets/flips and clean retirement
   are required observations; startup output alone does not establish
   this contract.
4. Run the actual Freeciv main-menu test and the affected full gallery
   regression checks, including `test/kandelo-cage.spec.ts` and
   `test/kandelo-sway.spec.ts`. Manually verify the affected gallery
   flows through `./run.sh browser`, recording the engines and behavior
   observed.
5. Run the unmodified `./run.sh test browser-memory`. Require complete
   repeated application cycles through cage and sway, with the normal
   memory-message and cooperative-drain assertions.
6. Consider the required libc-test, Open POSIX and Sortix suites against
   the exact landing delta. Record completed older-source evidence as
   such; bridge the later format/config changes with their current
   native, host and real-browser checks. Do not label older-source
   conformance as a final-source run.

These gates protect the port path and existing consumers. They do not
require unrelated baseline API families before this landing.
Actual port, existing-consumer or browser-memory failures remain landing
blockers. The broader inherited GPU-to-2D capture failure and candidate
worker-isolation mitigation belong to follow-up #1594, with the exact
failed evidence retained. The combined run still exercises that broader
path; a failed case must be reported as failed. This scope split does
not authorize weaker assertions, a blanket waiver or a platform boundary.

## Evidence and current status, 2026-10-29

Main `e4bca8639e4b` is integrated by merge `30dfe6bb0d`, preserving
its program-ABI crate extraction, build changes, terminal signal wakeups,
WebKit worker retention, real yacc/lex and guest NetHack build. Program ABI 56 / host 3 / GL table 17 /
fork record 21 remain unchanged. Earlier integration `5a54da5635` passed
ABI regeneration/check, resolver regression, 87 shared cases, 15 focused
xtask checks and 357 focused host cases, with byte-identical generated
outputs. The additional main merge passes 60 host cases in three files.
The resumed full xtask suite passes at follow-up source `ba845edaf4`,
including all 811 unit cases and later integration targets. These source
checks do not establish combined-main application acceptance, which
remains pending.

The prior clean candidate `9088f31021` completed its normal product,
optional CTS, ABI, freshness and artifact-closure checks. Its bounded
acceptance job `cage-sway-reviewed-landing-1029-143356-baef` finished
with exit 1 after 1h17m:

| Selection | Result |
|---|---|
| Freeciv SDL main menu, Chromium | 1/1 passed |
| Node compositor/device selection | 23/25 passed; two Sway timeouts |
| Three-engine gallery, rendered sessions and pinned EGL CTS | 13/15 passed; two Sway shell-prompt observations failed |
| Full persistent-page browser-memory gate | 9/9 passed across all three engines |

The memory gate completed all four game/compositor/tmux/WordPress cycles
per engine. The Cage idle observation repair passed in all three engines.
Chromium and Firefox Sway traces show master release, but late child
stderr split the shell prompt that the old test counted. The fixture now
requires actual display release and automatic terminal handoff, then
executes the parent shell's existing exit-status command. It preserves
input, idle, renderer, clock and restart assertions and their deadlines.
This stronger exit observation still needs execution.

The two Node whole-test timeouts remain unexplained. A diagnostic on the
same verified artifacts with opt-in phase checkpoints passed all three
Sway cases in 14.4–15.0 seconds, including cooperative cleanup. That
passing diagnostic (`sway-node-fresh-diagnostic-1029-155733-42b2`, source
`5a0f83afb7`) does not erase the failed combined selection. A diagnostic
in a different checkout instead exposed a stale client ABI digest; it
is recorded as provisioning failure and is not evidence about the
verified candidate's timeouts.

Artifact identities for `9088f31021` are retained privately in
`.context/cage-sway-reviewed-artifacts.json`: 98 owners, 237 members,
with resolved kernel SHA-256
`3b255f7f652d520fae5a24a3f8ff377a79ccb151b352204c9b052ecfc5f7de91`.
A complete SDK/toolchain/generated-input/raw-module comparison before
and after acceptance found no differences from the freshly built
standalone fixture inputs. No fixture bytes were copied or restamped by
that comparison. A separate normal-policy identity capture confirms
that the Node-selected compositor programs match the recorded products.
These identities are prior-candidate evidence, not current-main builds.

The earlier `e58d19f98a` combined selection passed Node 25/25 and the
full memory gate 9/9; its broad browser selection passed 142/144, retaining
two Firefox GPU-to-2D capture failures under #1594. Its gallery passed
4/6 before the readiness repairs. Manual headless Chromium review at
that source observed Cage shell input/exit and Sway's initial terminal
and workspace switching; it did not establish tiling or pixman restart.

Pinned libc-test, Open POSIX and Sortix at the `d081e6d453` mapping
checkpoint completed with zero unexpected failures. Later ARGB/config
source `21f3d451bb` passed 212 native C cases, 717 graphics source checks,
workspace Rust, normal dual-width SDK/kernel/host and ABI checks.
Exact counts, failures and identities remain in the baseline ledger.
They are historical evidence and do not replace combined-main checks.
This PR remains a draft. Performance has not been measured.

### Port dependency prerequisites

The port dependency declarations follow the shared host-toolchain
contract. SHA-256-verified libxkbcommon 1.13.2 source requires Meson 1.4
in its upstream `meson.build`; all Meson consumers therefore declare
1.4, including the existing Cairo, librsvg, Pango and Freeciv recipes.
The development shell provides Meson 1.9.1. json-c reuses the CMake 3.20
floor, xkeyboard-config reuses the existing Perl probe, and
libdisplay-info requires Python 3.11 because the shared metadata helper
imports `tomllib`.

The pkg-config declarations probe the executable itself. Normal recipe
checks retain native hwdata 0.300 and Wayland scanner module 1.20
minimums before configuration; upstream Meson dependencies are
unchanged. Manifest parsing, shell syntax and the regenerated local
program-index check pass. The full metadata checker still exits 1 for
17 disagreements in six existing groups: cargo, clang, make, patch,
python3 and zip. Its diagnostic output matches main
`cb0a8226c965` exactly; the introduced CMake, Meson, Perl and pkg-config
disagreements are eliminated. This is a metadata and prerequisite-check
correction. Target sources, flags and revisions are unchanged. Normal
rebuilding against these recipe inputs passed on `9088f31021`; fresh
combined-main validation remains pending.

### Verified package source reuse

The compositor recipes restage their manifest-selected, verified primary
source on every invocation through the shared package helper. An existing
private source directory cannot override a newer manifest or resolver
input. Sway reapplies its reviewed patches once to that fresh copy.
Resolver source trees remain immutable. Recipe changes invalidate their
normal cache identities; current products require a normal rebuild.

The canonical shell fixture includes the required xkeyboard-config
archive, verifies its composer argument, and checks that a missing
archive fails before publication.

### Cage idle-frame fixture prerequisite

The `e58d19f98a` Firefox gallery trace failed idle-frame equality while
the shell was still starting. Its first sample shows the empty terminal
grid and four flips; the second shows the `kandelo$` prompt and six
flips. Both captures completed promptly. `WLTERM_READY` is emitted after
the empty grid is committed, before the terminal reads the shell's PTY
output, so it does not establish an idle shell session.

The browser fixture now waits for visible first-row shell text before
taking its idle baseline. It decodes the public canvas screenshot,
maps output coordinates using the connector mode, and samples below
libkwl's 28-pixel titlebar in wlterm's 16-pixel text row. The first
8-pixel character cell is excluded because the initial empty grid
already draws an underline cursor there. More than 24 occupied output
columns distinguishes substantial shell text from that cursor. Saved
trace controls yield zero columns for the empty grid and 38.4 for the
rendered prompt after scaling the trace's 680-pixel canvas to its
1088-pixel output. The exact one-second idle equality, typing change,
nonblank-frame and clean-exit assertions remain unchanged, with no
deadline increase. The corrected full case passed on all three engines
at `9088f31021`. This is Cage acceptance evidence for that candidate,
not full graphics conformance or combined-main validation.

## Follow-up graphics baseline

The pushed branch `brandonpayton/graphics-baseline-follow-up` preserves
`65b498d284`, including expanded pinned upstream EGL query coverage and
the GLES hint increment. [PR #1594](https://github.com/Automattic/kandelo/pull/1594)
is stacked on #1574. Remaining work includes EGL server waits,
additional image sources, forwarded buffer/image transport,
outstanding GLES/EGL errors and lifecycle behavior,
broader mapping/negative coverage and broad upstream CTS validation.

That PR also tracks the recurring inherited-display Firefox capture and
presentation-worker isolation candidate. In the standalone diagnostic,
continuous readback with both visible canvases on the same worker failed
all three bitmap-capture runs; separating readback and presentation
workers passed three runs with unchanged displayed-pixel assertions.
A local profile records simultaneous main-thread snapshot/paint and
worker readback/event waits. The specific internal permission/snapshot
cycle remains a pinned-source inference because private native frames
were not symbolicated. These results support further investigation;
they are neither a completed product repair nor proof that every Kandelo
capture failure has that cause.

The baseline inventory remains authoritative for those ordinary gaps.
Advertised capabilities are unchanged, and passing compositor sessions
does not close an API family. Once this unpublished ABI is released,
future incompatible changes follow the normal ABI versioning contract.


### Narrow renderbuffer replay ownership

A canonical host build on combined follow-up `97e0aaf98a` exposed a
TypeScript declaration error: the muxer owns replay state, while its
renderbuffer helper was typed as requiring a complete guest binding.
The helper now accepts only the optional read-only renderbuffer-view
map it actually reads. A state-only owner without imported aliases uses
its native renderbuffer directly; a mapped owner resolves the retained
native alias. No guest address space is added to the muxer contract.

The new causal regression fails before the repair with a missing-map
exception. After the repair all 24 muxer cases pass, and the canonical
host build completes JavaScript and declaration generation. Both commands
use the declared development shell; logs are retained in the VMA
checkout as `.context/muxer-narrow-owner-{before,after,host}.log`.
This is bounded helper/build evidence. The current normal product run at
`85c56d342d` predates this helper repair; combined rebuilt application,
three-engine browser, memory and conformance acceptance remain required.


### Inherited-mapping publication failure guard

The static export-failure audit exposed a missing first fatal-signal
check in inherited DRI mapping publication. Its catch now preserves the
branded kernel-export failure before ordinary rollback writes, consistent
with whole-generation containment. Ordinary host publication errors still
restore prior bytes and reference counts; no audit allowance is added.

The declared-shell selection passes entry gate 44/44, shared inheritance
6/6, export-failure audit 9/9 and entry-context audit 25/25. The memory
write audit passes 85/86, with one synthetic fixture timing out at its
unchanged five-second deadline. The complete selection is 169/170 and
remains a failed run; the full audit must pass before final readiness.
Normal current-source artifacts, rendered consumers, browser-memory and
conformance remain pending.

### Fresh-checkout GBM native validation inputs

The native GBM harness now resolves public DRM headers from the current
source-only libdrm package, instead of assuming an older dependency install
in the SDK sysroot. On a fresh primary checkout the old harness fails at
missing `sysroot/include/libdrm/xf86drm.h`. After the repair the normal resolver
provisions the current SDK and libdrm; all 38 public GBM symbols and the actual
metadata, modifier, format and retained CPU-mapping checks pass under UBSan.
The GBM implementation and public headers are unchanged. This repairs source
validation provisioning; it does not establish a new compositor/browser pass.

### Desktop density and text defaults

Sway's automatic output scale now rounds the measured connector density
against a 96-DPI logical grid. Small high-density outputs and physical
millimetre rounding no longer force a 2x display to scale 1. Unknown,
invalid or aspect-only physical dimensions retain scale 1. This is a
compositor desktop policy; KMS modes, physical-size reporting and input
coordinates remain unchanged. Native panel axes are compared consistently
before the desktop's logical rotation.

The Sway session selects a 12pt UI font and a separate 14pt foot config at
`/usr/share/kandelo/sway/foot.ini`, using compositor scaling once. Both
Super+Return and Ctrl+Return select that config after the upstream include.
The shared 12pt terminal configuration for other desktops is unchanged.
The normal wayland-demo desktop archive carries this file under `sway/`;
the shell image mounts the archive under `/usr/share/kandelo/`.

The package runs a native check of the actual extracted scale function.
The existing browser spec also has 1x/2x small-pane cases checking native
mode size, painted bar height, actual Sway IPC scale, rendered-client
clicks and clean exit. These rendered cases require normal rebuilt Sway,
wayland-demo data and shell image; source-only checks do not establish
the new desktop's runtime acceptance.
