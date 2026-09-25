# Quake (TyrQuake) Port to Kandelo — Design

Date: 2026-09-24
Branch: `brandonpayton/port-quake-shareware`

## §1. Why

Kandelo is a POSIX-compatible multi-process WebAssembly kernel whose
north star is faithful POSIX conformance exercised through the normal
platform path (SDK, libc, resolver, VFS image, syscalls, host runtime,
kernel). Porting a well-known, demanding C application is one of the
best ways to both **showcase** the platform to a general audience and
**stress-test** it against real software instead of synthetic cases.

Quake (id Software, 1996) is an ideal target: it is a beloved,
instantly recognizable game; it is pure C; and it ships in two renderer
flavors from a single portable codebase (TyrQuake), one software and one
OpenGL. That maps cleanly onto Kandelo's two existing graphics paths:
the software framebuffer (`/dev/fb0`, proven by fbDOOM) and the
KMSDRM → OpenGL ES 2.0 → WebGL2 bridge (proven by the SDL2 demo).

This project has two co-equal goals:

1. **Showcase.** A polished, self-serve kandelo.dev demo where a visitor
   watches a real Kandelo machine acquire id's original shareware
   archive, extract it with real POSIX tools, and boot into a playable
   first level — rendered in the browser with keyboard/mouse input and
   sound.
2. **Stress test.** Treat every porting failure as platform feedback.
   The software path exercises fbdev, evdev/PS-2 input, OSS audio, and
   the C toolchain; the OpenGL path is a deep exercise of the GLES2
   command-buffer bridge that is expected to surface real gaps (missing
   guest-side GL encoders, upload-size limits, etc.).

## §2. Definition of done

**Phase 1 (this spec, in full):** the Quake **shareware** episode boots
to a **playable first level in the browser** using the **software**
renderer, through the normal platform path. Concretely: a visitor opens
the `quake` demo profile, the machine fetches `quake106.zip`, extracts
`id1/pak0.pak` inside Kandelo with real tools, and `tyr-quake` runs in
the Framebuffer pane, playable with keyboard + mouse, with sound
effects. A Playwright test proves real frames render and the process
exits cleanly. `quake` is also runnable from the shell terminal as a
lazy-fetched binary (nethack-style).

**Phase 2 (defined here, planned separately):** a second `quake-gl`
profile runs the OpenGL renderer via SDL2/KMSDRM/GLES2 in the Modeset
pane, showcasing the hardware-style 3D path.

**Explicit non-goals (both phases):**

- Multiplayer / QuakeWorld netcode (`tyr-qwcl`, `tyr-glqwcl`,
  `tyr-qwsv`). Single-player NetQuake only.
- CD / external music (Ogg/MP3 tracks). Shareware music is CD audio and
  is not in the pak; sound **effects** are in scope, music is not.
- Registered/full Quake content. Shareware `pak0.pak` only (bring your
  own pak is supported for owners of the full game).

## §3. Platform capabilities relied upon (background)

Everything Quake needs already exists and is exercised by shipping
demos. Key precedents and seams:

- **Software framebuffer — fbDOOM.** `packages/registry/fbdoom/`
  cross-compiles fbDOOM with its `NOSDL=1` frontend, `mmap`s `/dev/fb0`,
  writes BGRA32, reads MEDIUMRAW keyboard + `/dev/input/mice`, and plays
  OSS audio via `/dev/dsp`. Device node `/dev/fb0` is single-owner
  (second `open` → `EBUSY`) at `crates/runtime-core/src/devfs.rs:151`;
  fbdev ioctls at `crates/shared/src/ioctl_contract.rs:267`; host
  imports `host_bind_framebuffer`/`host_fb_write` at
  `crates/kernel/src/wasm_api.rs:183`; canvas renderer at
  `host/src/framebuffer/canvas-renderer.ts`; UI pane at
  `apps/browser-demos/pages/kandelo/panes/Framebuffer.tsx`.
- **OpenGL — SDL2 demo.** `packages/registry/sdl2/` builds SDL 2.32.10
  configured KMSDRM + GLES2 + evdev + OSS (`build-sdl2.sh`).
  `packages/registry/sdl2-demo/` + `programs/sdl2/` render GLSL ES 1.00
  through the WebGL2 bridge. Guest `libGLESv2.a`
  (`libc/glue/libglesv2_stub.c`) TLV-encodes GL calls; the host decodes
  them into a real `WebGL2RenderingContext` in `host/src/webgl/bridge.ts`
  / `ops.ts`. Pane: `apps/browser-demos/pages/kandelo/panes/Modeset.tsx`
  (`kms` surface, `attachKmsDisplay`, vblank pump).
- **Input.** Framebuffer pane delivers MEDIUMRAW keyboard bytes +
  `/dev/input/mice` PS/2 packets. evdev path delivers
  `/dev/input/event0` (keyboard) / `event1` (pointer) for SDL2.
- **Audio.** OSS `/dev/dsp` → host PCM ring → AudioWorklet
  (`host/src/audio/`). Autoplay gesture satisfied by `host.resumeAudio()`
  on canvas click.
- **Asset staging.** `apps/browser-demos/pages/kandelo/kernel-host/
  configured-assets.ts::stageConfiguredAssets` fetches each declared
  asset at page load, SHA-256-verifies it, and `writeVfsBinary`s it into
  the machine VFS before boot. The service worker
  (`apps/browser-demos/public/service-worker.js`) caches fetched bytes in
  `LAZY_ASSET_CACHE`. In dev, cross-origin URLs route through a
  same-origin CORS proxy.
- **Demo profiles.** A demo is a **profile** of the
  `browser-main-shell` product, listed in
  `apps/browser-demos/pages/kandelo/gallery-roster.json` and defined in
  `packages/registry/shell/source-rootfs-shell-demo-profiles.json`
  (overlay merged by
  `images/vfs/scripts/build-source-rootfs-shell-image.ts`). Presentation
  metadata is written to `/etc/kandelo/demo.json`, parsed by
  `web-libs/kandelo-session/src/demo-config.ts`. The image builder
  hard-binds each profile's launch command + executable
  (`SOURCE_ROOTFS_DEMO_COMMANDS`, `requireOwnedDemoCommands`) so metadata
  cannot advertise a demo that does not actually launch.
- **Terminal lazy binaries.** nethack/vim/python/etc. are registered as
  lazy VFS references (`fs.registerLazyFile` /
  `registerLazyArchiveFromEntries`, `kandelo-lazy:` scheme) in
  `images/vfs/scripts/shell-lazy-archives.ts` +
  `source-rootfs-shell-overlay.ts`; bytes materialize on first `exec`.
- **Bring-your-own asset.** `web-libs/kandelo-session/src/demo-ingest.ts`
  validates a dropped file, writes it to the VFS, SIGTERMs the current
  `/dev/fb0` owner, waits for unbind, and restarts the program.

**Correction to prior assumption.** fbDOOM's *binary* is written
**eagerly** into its profile image, not lazily. What is deferred for
Doom is the WAD (fetched at load) and the streamed image. Quake follows
the same eager-binary/deferred-asset shape for its demo profiles, and
*additionally* registers a lazy terminal binary in the base shell
profile.

## §4. Upstream engine

- **Engine:** TyrQuake by Kevin Shanahan ("Tyrann"). Portable,
  C-only, the base of the libretro Quake core. GPL-2.0.
- **Version/pin:** v0.71 (current stable). Pinned by commit-archive
  tarball from the `sezero/tyrquake` GitHub mirror
  (`https://github.com/sezero/tyrquake/archive/<sha>.tar.gz`) + sha256,
  exactly as fbDOOM pins its source. The exact commit SHA is chosen at
  implementation time (the v0.71 tag commit).
- **Targets used:** `tyr-quake` (NetQuake, software renderer, Phase 1)
  and `tyr-glquake` (NetQuake, GL renderer, Phase 2). QuakeWorld targets
  are not built.
- **Codebase shape:** `common/` holds the engine, both renderers, and
  the selectable video/input/sound backends; `NQ/` holds NetQuake host
  code; `include/` headers. Software rasterizer: `d_*`/`r_*`. GL
  renderer: `gl_*.c`.

## §5. Architecture overview

Two demo profiles, one source tree, phased:

```
                         packages/registry/tyrquake/
                                    |
                 +------------------+------------------+
                 |                                     |
        tyr-quake (software)                 tyr-glquake (GL)
        + vid_fbdev/in_fbdev/snd_oss         + SDL2 (KMSDRM/GLES2)
                 |                                     |
          quake.wasm  ................. Phase 1   quake-gl.wasm  ... Phase 2
                 |                                     |
   profile "quake" -> Framebuffer pane   profile "quake-gl" -> Modeset pane
                 |                                     |
          /dev/fb0 (BGRA32)                    KMSDRM -> GLES2 -> WebGL2
          MEDIUMRAW kbd + /dev/input/mice      evdev event0/event1
          OSS /dev/dsp                         OSS /dev/dsp

   Shared: fetch quake106.zip -> extract id1/pak0.pak inside Kandelo
           (real POSIX tools) -> run with -basedir /usr/share/quake
```

Design for isolation: the engine is upstream and untouched except
through patches; the Kandelo-specific surface is three small backend
translation units (Phase 1) plus a GLES2 renderer port (Phase 2), each
with a clear single responsibility and a well-defined interface to the
engine (the existing `vid_*`/`in_*`/`snd_*` and `gl_*` seams).

## §6. Phase 1 — software profile (full design)

### §6.1 Package & build recipe

New package `packages/registry/tyrquake/`, modeled on
`packages/registry/fbdoom/`:

- `package.toml`: `kind = "program"`, `name = "tyrquake"`,
  `kernel_abi = 43`, `depends_on = []` (Phase 1), GPL-2.0, `[source]`
  archive with pinned URL + sha256, `[[host_tools]]` (make/curl/tar/
  patch as needed). Phase 1 declares a **single** `[[outputs]]` entry
  `{ name = "quake", wasm = "quake.wasm" }` (declaring an output the
  build does not produce would trip the output-metadata/install checks).
  Phase 2 adds the second output `{ name = "quake-gl", wasm =
  "quake-gl.wasm" }` together with the `depends_on = ["sdl2@2.32.10"]`
  and the `bin/tyr-glquake` build step.
- `build.toml`: `script_path`, hashed `inputs`, `revision`.
- `build-tyrquake.sh`: `source scripts/package-build-roots.sh` →
  `kandelo_package_stage_verified_source` (pinned commit, marker-guarded
  re-stage) → `kandelo_package_git_apply_patch` for our patch series →
  `source sdk/activate.sh`, `WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"` →
  drive the engine Makefile:

  ```sh
  make CC=wasm32posix-cc LD=wasm32posix-cc \
       USE_X86_ASM=N USE_SDL=N \
       VID_TARGET=fbdev IN_TARGET=fbdev SND_TARGET=oss CD_TARGET=null \
       LIBS="-lm" \
       bin/tyr-quake
  ```

  Then `source scripts/install-local-binary.sh` and
  `install_local_binary quake bin/tyr-quake quake.wasm`. TyrQuake does
  not fork, so it must stay free of fork instrumentation (like fbDOOM);
  `install_local_binary`'s `auto` path is a no-op for a non-forking,
  non-side-module program.

  Notes: `LIBS="-lm"` only (never `-lc`; `wasm32posix-cc` auto-injects
  `channel_syscall.c` + musl `libc.a`). `USE_X86_ASM=N` selects the C
  fallbacks for the software rasterizer's `.S` files, which cannot target
  wasm. `USE_SDL=N` keeps the software build off SDL (SDL's software
  `SDL_Renderer` is disabled in the Kandelo SDL2 build anyway).

  Whether TyrQuake's Makefile accepts a custom `VID_TARGET=fbdev`
  directly, or whether the patch must add the target wiring, is
  confirmed at implementation time; the patch series adds whatever
  Makefile glue the new backend needs.

### §6.2 Custom backends (the real Phase-1 porting work)

TyrQuake has no fbdev backend, so we add three translation units by
patch (or a `common/` addition), modeled on the existing `vid_x.c` /
`vid_null.c` structure and fbDOOM's proven frontend:

- **`vid_fbdev.c`** — open `/dev/fb0`, query geometry via fbdev ioctls,
  `mmap` the pixel buffer. TyrQuake's software renderer produces 8-bit
  paletted output; this backend converts palette-indexed pixels to
  BGRA32 on flip using the active Quake palette (the same conversion
  fbDOOM performs). Handles the single-owner `EBUSY` contract and clean
  unbind on exit.
- **`in_fbdev.c`** — decode MEDIUMRAW keyboard bytes (bit 7 = release)
  from the Framebuffer pane into Quake key events, and read
  `/dev/input/mice` PS/2 packets for look/move. Coalesce queued mouse
  packets per frame (fbDOOM learned this lesson — see its
  `0002-add-mice-input.patch` rev notes).
- **Sound: reuse `snd_oss.c`.** TyrQuake already ships an OSS backend
  that writes `/dev/dsp`; selected via `SND_TARGET=oss`. No new sound
  code expected — only wiring/latency-buffer negotiation if the generic
  `/dev/dsp` backend needs it (fbDOOM's `0003`/`0005` sound patches are a
  reference if adjustments are required).

`CD_TARGET=null` (no CD audio → no music, per non-goals).

### §6.3 Asset pipeline — in-Kandelo extraction (option C2)

**Principle.** We only ever fetch and cache id's **original, intact
shareware archive** (`quake106.zip`). The playable `pak0.pak` is derived
**on the user's own machine, inside Kandelo, by real POSIX tools**. This
is the most license-defensible posture (id's shareware license clearly
permits redistributing the intact archive; standalone `pak0.pak`
redistribution is disputed) and doubles as a compelling platform
showcase.

**Facts.** `quake106.zip` = 9,094,045 bytes. Chain to the pak:
`quake106.zip` → (unzip) → `resource.1` → (LHA, LZH `lh5`) →
`id1/PAK0.PAK` (18,689,235 bytes; sha256
`35a9c55e5e5a284a159ad2a62e0e8def23d829561fe2f54eb402dbc0a9a946af`).

**Fetch.** The demo profile declares an `assets[]` entry that
`stageConfiguredAssets` fetches at page load and SHA-256-verifies:
`quake106.zip` written to `/usr/share/quake/quake106.zip`. A pinned,
CORS-OK mirror exists (`cdn.jsdelivr.net/gh/<repo>@<commit>/quake106.zip`
class); the exact mirror + sha256 for the archive are pinned at
implementation time (verify sha256 by download, as fbDOOM does for the
WAD, and mirror the constants into
`web-libs/kandelo-session/src/demo-guides.ts` with a test asserting the
demo config points at them).

**Extract (inside Kandelo).** Real wasm tools do the work:

1. Unzip `quake106.zip` → `resource.1` (a standard zip extractor).
2. LHA `lh5`-extract `resource.1` → `id1/PAK0.PAK`.
3. Place the pak at `/usr/share/quake/id1/pak0.pak` (lowercase; Quake is
   case-sensitive on POSIX).

Tooling: we need a zip extractor and an `lh5` LHA extractor available
in-image. Plan: package **`lhasa`** (Simon Howard's small GPL LHA
library/tool, supports `lh5`, no external deps — a clean, small wasm
port) as a registry package, and ensure a zip extractor is present
(package `unzip`, or use a libarchive-based `bsdtar` if the shell image
already ships one — confirmed at implementation time; prefer a single
libarchive tool if it handles both zip and lha). The extraction runs via
a small POSIX wrapper script installed at `/usr/local/bin/quake` (or a
`quake-launch` helper the profile invokes) that is idempotent: if
`/usr/share/quake/id1/pak0.pak` is absent but `quake106.zip` is present,
extract, then `exec` the engine; if the pak is already present, launch
directly.

Extraction re-runs per session (the VFS is in-memory), but the 9 MB zip
is service-worker-cached, so re-fetch is instant and extraction is a
few seconds — surfaced honestly in the syslog/terminal as it happens.

**Bring-your-own pak.** The profile also declares an `ingest[]` block
(`.pak`, ~32 MiB cap, target `/usr/share/quake/id1/pak0.pak`, restart
the engine) so owners of the full game can drop their own `pak0.pak`
(or `pak1.pak` for registered content) — reusing `runDemoIngest`.

**Truthful failure.** If the archive fetch fails, sha256 mismatches, or
extraction fails, the machine surfaces the real error in syslog/terminal
rather than presenting a fake success. If no pak is present, the engine
exits with its genuine "not found" error.

### §6.4 Demo profile, gallery, image wiring

- **Profile `quake`** added to
  `packages/registry/shell/source-rootfs-shell-demo-profiles.json`
  overlay:
  - `identity`: title "Quake (software)", summary (e.g. "Quake's
    software renderer on `/dev/fb0`, extracted from id's shareware
    archive inside Kandelo."), accent, glyph, `packages`
    (`tyrquake@local`, `lhasa@local`/`unzip@local`, `bash@local`,
    `coreutils@local`).
  - `runtime.features`: `["framebuffer"]`.
  - `init.shellCommand`: the launch wrapper, e.g.
    `/usr/local/bin/quake -basedir /usr/share/quake` (the wrapper does
    the idempotent extraction described in §6.3, then execs the engine).
  - `presentation`: `genericDemoPresentation("framebuffer")` shape —
    `runningPrimary: ["framebuffer","terminal","syslog"]`, terminal +
    internals in drawers, `touchControls: true`.
  - `assets`: the `quake106.zip` fetch (§6.3).
  - `ingest`: BYO pak (§6.3).
- **Gallery:** add `{ "product": "browser-main-shell", "profile":
  "quake" }` to `gallery-roster.json`.
- **Owned commands:** add `quake` to `SOURCE_ROOTFS_DEMO_COMMANDS` in
  `images/vfs/scripts/build-source-rootfs-shell-image.ts` (command +
  executable `/usr/local/bin/quake`) so `requireOwnedDemoCommands`
  enforces that the demo actually launches what it advertises.
- **Image build:** the builder eagerly `writeVfsBinary`s the engine to
  `/usr/local/bin/quake` and the launch wrapper + extraction tools, and
  writes `demo.json`. Pass the built artifact through `build-shell.sh` /
  the composer (a `--quake <path>` flag analogous to `--fbdoom`).

### §6.5 Terminal lazy archive (nethack-style)

Register `quake` (the software engine) as a **lazy VFS binary** in the
**base** shell profile via `shell-lazy-archives.ts` /
`source-rootfs-shell-overlay.ts` (`SHELL_LAZY_BINARY_SPECS` or an
archive spec), so typing `quake` in the shell terminal fetches the
engine on first `exec`.

**Honest caveat, by design:** the 18 MB pak is *not* auto-provisioned in
the plain terminal. Bare `quake` with no pak fails with the engine's
genuine "no pak0.pak" error — correct platform behavior, not a defect to
paper over. A short note in the demo guide explains how to provide data
(fetch the shareware zip and run the same extraction, or place/ingest a
pak). The extraction tools (`lhasa`/`unzip`) are likewise available in
the shell (lazy) so a terminal user can reproduce the exact in-Kandelo
extraction by hand.

### §6.6 Runtime layout

- `basedir` = `/usr/share/quake`; game dir `id1` beneath it; pak at
  `/usr/share/quake/id1/pak0.pak`. Config/saves default under the user's
  home (`HOME`), matching fbDOOM's `0007-use-home-for-save-directory`
  approach if TyrQuake needs a writable path (avoids writing under a
  read-only basedir).

### §6.7 Error handling

| Condition | Behavior |
|---|---|
| Archive fetch fails / non-200 | `stageConfiguredAssets` throws; loader surfaces error, machine does not boot into a fake game. |
| Archive sha256 mismatch | Staging aborts with a mismatch error. |
| Unzip / lha extraction fails | Wrapper prints the real tool error to terminal/syslog; engine not launched. |
| No pak present (terminal) | Engine prints its genuine "not found" error and exits. |
| `/dev/fb0` busy (`EBUSY`) | Single-owner contract; ingest SIGTERMs the current owner and waits for unbind before restart (existing mechanism). |

### §6.8 Testing & validation

- **Playwright (software).** New spec
  `apps/browser-demos/test/kandelo-quake.spec.ts`, modeled on
  `kandelo-sdl2.spec.ts` but targeting the Framebuffer pane:
  `gotoMachineOrSkip(page, "quake")` → wait for syslog
  `running /usr/local/bin/quake` (and evidence of extraction, e.g. an
  "extracting" breadcrumb) → Framebuffer canvas visible → assert
  non-blank + PNG-byte-size frame variance across `canvas.screenshot()`
  samples (proves the id logo/menu/level actually renders and animates)
  → drive keyboard input (e.g. Escape / attack) → assert a clean-exit
  breadcrumb in the terminal, and no `failed` in syslog.
- **Manual.** `./run.sh browser`, open the `quake` profile, confirm the
  extraction runs and the first level is reachable and playable with
  keyboard + mouse and audible sound effects.
- **Build provisioning (fresh worktree).** Under
  `scripts/dev-shell.sh`: init the musl submodule → build sysroots
  (`./run.sh setup` / `build-musl.sh`) → build the package
  (`build-programs.sh` / local-build) → build the shell VFS image. A
  missing artifact is provisioning, not a blocker.
- **Package-system tests.** Ensure the demo-config bridge test
  (`tests/package-system/source-rootfs-shell-bridge.test.ts`-style)
  covers the new `quake` profile's asset URL/digest constants.
- Runtime/kernel behavior is not changed in Phase 1 (we consume existing
  fbdev/evdev/OSS syscall surfaces), so conformance suites are not
  expected to move; if any syscall glue is touched, the relevant suites
  are run before claiming completion.

## §7. Phase 2 — OpenGL profile (defined; separate implementation plan)

Phase 2 is scoped here but gets its own implementation plan because it
carries substantially more risk than Phase 1.

### §7.1 Renderer port: OpenGL 1.x → GLES2

TyrQuake's `gl_*.c` use **OpenGL 1.x immediate mode and fixed-function**
exclusively (`glBegin`/`glEnd`, `glVertex3f`, `glTexCoord2f`,
`glColor4f`, `glMatrixMode`/`glLoadMatrix`/`glPushMatrix`, `glTexEnv`,
`glAlphaFunc`, `glShadeModel`) — zero shaders. GLES2 (the only GL the
Kandelo bridge speaks) has **none** of these. Porting requires a
compatibility layer: our own matrix math replacing the fixed-function
matrix stack; GLSL ES shaders replacing fixed-function
texture-combine/alpha-test/flat-vs-gouraud; and batching immediate-mode
draws into VBOs. This is the well-trodden "GLES2 shim / glBegin
emulation" path used by Quake-to-WebGL ports such as Qwasm. Built as
`tyr-glquake` linked against the Kandelo SDL2 package
(`depends_on = ["sdl2@2.32.10"]`), mirroring `build-sdl2-demo.sh`
(pkg-config `gbm libdrm egl glesv2`, `-lSDL2 -lm`).

### §7.2 Missing guest GL encoders + TLV cap

The host WebGL2 bridge already **decodes** the ops GLQuake needs
(`glDrawElements`, `uniformMatrix4fv`, `texSubImage2D`, VAOs,
renderbuffers, depth/cull state — see `host/src/webgl/ops.ts`,
`bridge.ts`), but the guest-side encoders in
`libc/glue/libglesv2_stub.c` are **deliberately absent** for several of
these. Phase 2 adds the missing encoder functions there, respecting the
hard **65 KB-per-TLV-record** cap: large texture/lightmap uploads must
stream via `texSubImage2D`/`bufferSubData`, and vertex/index buffers must
stay within (or be split to) the per-call limit.

### §7.3 ABI check

Adding encoders for opcodes **already defined** in `shared::gl` at the
current `OP_VERSION` (=1) is expected to be structurally ABI-neutral (no
new syscalls, no new opcodes, protocol version unchanged). Phase 2
nonetheless **must** confirm `abi/snapshot.json` is unchanged and that no
semantic ABI-adjacent behavior shifts; if the TLV protocol version or
layout changes, bump `ABI_VERSION` + regenerate the snapshot in the same
change (per the ABI contract).

### §7.4 Profile, pane, test

- Profile `quake-gl`: `kms` presentation surface → Modeset pane;
  `init.shellCommand` runs the GL engine (`/usr/local/bin/quake-gl
  -basedir /usr/share/quake`) after the shared extraction; same
  `assets`/`ingest`. Register in `gallery-roster.json`;
  `SOURCE_ROOTFS_DEMO_COMMANDS` owns `quake-gl`.
- Playwright `kandelo-quake-gl.spec.ts` modeled directly on
  `kandelo-sdl2.spec.ts` (`.kmodeset-canvas` visible, `Waiting for
  PAGE_FLIP` hidden, PNG-byte-size frame variance, clean exit).
- The shared extraction (§6.3) and pak are reused; both profiles depend
  on the same tooling.

## §8. Files to add / change (inventory)

**Phase 1 — add:**

- `packages/registry/tyrquake/package.toml`, `build.toml`,
  `build-tyrquake.sh`, `patches/*.patch` (fbdev video + PS/2/MEDIUMRAW
  input backends, Makefile glue, save-dir/home fix as needed).
- `packages/registry/lhasa/` (and/or `packages/registry/unzip/`) — the
  in-Kandelo extraction tool(s), unless an existing libarchive tool
  suffices.
- Launch/extraction wrapper installed to `/usr/local/bin/quake`.
- `apps/browser-demos/test/kandelo-quake.spec.ts`.

**Phase 1 — change:**

- `packages/registry/shell/source-rootfs-shell-demo-profiles.json`
  (add `quake` profile).
- `apps/browser-demos/pages/kandelo/gallery-roster.json` (add `quake`).
- `images/vfs/scripts/build-source-rootfs-shell-image.ts`
  (`SOURCE_ROOTFS_DEMO_COMMANDS`, artifact flag, eager writes).
- `images/vfs/scripts/shell-lazy-archives.ts` /
  `source-rootfs-shell-overlay.ts` (lazy terminal `quake` +
  extraction tools).
- `web-libs/kandelo-session/src/demo-guides.ts` (archive URL/sha256
  constants) and any bridge test asserting them.
- `packages/registry/shell/build-shell.sh` (pass the new artifact) as
  needed.

**Phase 2 — add/change (separate plan):** GLES2 encoder additions in
`libc/glue/libglesv2_stub.c`; `quake-gl` output/build path
(`depends_on` sdl2); GLES2 renderer compatibility layer patches;
`quake-gl` profile + gallery + owned command;
`kandelo-quake-gl.spec.ts`; ABI snapshot confirmation.

## §9. Risks & mitigations

- **fbdev backend effort (Phase 1).** New `vid_fbdev`/`in_fbdev` is the
  main custom work. *Mitigation:* fbDOOM proves the exact host plumbing
  and the palette→BGRA32 conversion; TyrQuake's `vid_x.c`/`vid_null.c`
  give the backend skeleton.
- **Extraction tooling.** `lh5` decoding needs a real tool in-image.
  *Mitigation:* `lhasa` is small, GPL, dependency-free, and purpose-built
  for `lh5`; prefer a single libarchive tool if one already ships. Verify
  the extraction end-to-end in a scratch machine early.
- **Pak licensing.** Standalone `pak0.pak` redistribution is disputed.
  *Mitigation:* C2 only ever fetches/caches the intact `quake106.zip`;
  the pak is derived locally. Document the posture in the demo guide.
- **Boot-time extraction latency.** A few seconds per session.
  *Mitigation:* SW-cache the 9 MB zip; surface progress honestly; keep
  the extraction idempotent so a persisted VFS (if ever added) skips it.
- **GLES2 renderer port (Phase 2) is large.** GL1→GLES2 is a rewrite,
  not a recompile. *Mitigation:* scoped to its own plan; Phase 1 already
  satisfies the DoD, so Phase 2 risk never blocks the showcase.

## §10. Open questions / to confirm at implementation time

- Exact TyrQuake commit SHA (v0.71 tag commit) + archive sha256.
- Exact `quake106.zip` mirror URL (pinned commit) + sha256 (verify by
  download).
- Whether the shell image already ships a libarchive-based extractor
  (`bsdtar`) that handles both zip and `lh5`, or whether we package
  `lhasa` (+ `unzip`).
- Whether TyrQuake's Makefile accepts a custom `VID_TARGET`/`IN_TARGET`
  cleanly or the patch must add target wiring.
- Whether the generic `/dev/dsp` OSS backend needs latency-buffer
  negotiation for TyrQuake's mixer (fbDOOM's sound patches are the
  reference).
