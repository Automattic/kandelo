# Cage and sway landing

[PR #1574](https://github.com/Automattic/kandelo/pull/1574) lands the
infrastructure and normal package/image integration for upstream cage
0.3.1 and sway 1.12 on wlroots 0.20.2. Its runtime source cut is
`21f3d451bb`, above main `cb0a8226c965`. This is a bounded compositor
consumer contract; complete GLES 2.0 and advertised EGL 1.5/extensions
conformance remain in the separate
[graphics baseline](compatibility-v1.md).

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

1. Build the normal product graph with `./run.sh setup`. Explicitly build
   the optional CTS package with
   `cargo xtask bootstrap graphics-cts-egl --jobs 4`, rebuild programs
   with `bash scripts/build-programs.sh`, and run
   `bash scripts/check-abi-version.sh`. Use the normal xtask freshness
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
Failures remain visible with their exact scope; narrowing delivery does
not authorize skipped cases, weaker assertions or a platform boundary.

## Evidence and current status, 2026-10-29

The `d081e6d453` mapping checkpoint passed the explicit normal CTS/
compositor selection: nine browser cases across all three engines,
including actual cage and sway sessions. Its libc-test, Open POSIX and
Sortix runs completed with zero unexpected failures; exact counts and
artifact identities are in the baseline ledger.

The later ARGB/config increment at `21f3d451bb` passed 212 native C
cases, 717 graphics source checks, workspace Rust, normal matching
dual-width SDK/kernel/host and ABI checks, and 8/8 Node cases. Its
broader browser selection passed 89/90; the fixed comparison passed 11/12.
The failed Firefox GPU-to-2D captures remain recorded. A standalone
capture diagnostic exists, but engine-versus-tooling attribution remains
unresolved. No platform boundary or waiver is claimed.

The final `21f3d451bb` normal product build, Freeciv acceptance,
combined consumers and full memory switching are pending. Full gallery,
manual browser and final combined checks are also pending. This document
defines the landing target; it does not declare the PR merge-ready.
Performance has not been measured.

## Follow-up graphics baseline

The pushed branch `brandonpayton/graphics-baseline-follow-up` preserves
`65b498d284`, including expanded pinned upstream EGL query coverage and
the GLES hint increment. Its PR has not opened yet. Remaining work
includes EGL server waits, additional image sources, forwarded buffer/
image transport, outstanding GLES/EGL errors and lifecycle behavior,
broader mapping/negative coverage and broad upstream CTS validation.

The baseline inventory remains authoritative for those ordinary gaps.
Advertised capabilities are unchanged, and passing compositor sessions
does not close an API family. Once this unpublished ABI is released,
future incompatible changes follow the normal ABI versioning contract.
