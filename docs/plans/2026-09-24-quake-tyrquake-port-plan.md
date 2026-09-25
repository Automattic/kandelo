# Quake (TyrQuake) Phase 1 — Software Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `quake` browser demo profile where a Kandelo machine
fetches id's intact shareware archive, extracts `id1/pak0.pak` in-machine
with real tools, and runs the TyrQuake software renderer to a playable
first level in the Framebuffer pane, plus a lazy `quake` terminal binary.

**Architecture:** New `packages/registry/tyrquake/` builds `tyr-quake`
(software, `USE_X86_ASM=N`) with three Kandelo backends added by patch —
`vid_fbdev` (palette→BGRA32 to `/dev/fb0`), `in_fbdev` (MEDIUMRAW kbd +
`/dev/input/mice`), reused `snd_oss` (`/dev/dsp`) — modeled directly on
`packages/registry/fbdoom/`. A packaged `lhasa` (+ zip extractor) performs
in-Kandelo extraction via an idempotent launch wrapper. The demo is a
profile of `browser-main-shell`, wired exactly like the `doom` profile.

**Tech Stack:** C (TyrQuake, GPL-2.0), the `wasm32posix-cc` SDK toolchain,
musl, Kandelo fbdev/evdev/OSS device surfaces, TypeScript image builders +
demo config, Playwright.

**Spec:** `docs/plans/2026-09-24-quake-tyrquake-port-design.md`

## Global Constraints

- Kernel ABI: `kernel_abi = 43` in every new `package.toml` (matches
  current tree; do not bump — Phase 1 touches no ABI surface).
- Toolchain: build only under `scripts/dev-shell.sh`; use
  `wasm32posix-cc`/`wasm32posix-pkg-config`; `WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"`.
- Never pass `-lc` (the SDK auto-injects `channel_syscall.c` + musl
  `libc.a`); pass `-lm` explicitly. Software build uses `USE_X86_ASM=N`,
  `USE_SDL=N`, `CD_TARGET=null`.
- Licensing: fetch/cache **only** the intact `quake106.zip`; derive
  `pak0.pak` locally. Never commit, bundle, or mirror a standalone pak.
- Single output for the Phase-1 package: `{ name = "quake", wasm =
  "quake.wasm" }`. Do not declare `quake-gl` (Phase 2).
- Single-player NetQuake only; no CD music; sound effects only.
- Runtime layout: `basedir = /usr/share/quake`, pak at
  `/usr/share/quake/id1/pak0.pak`, writable saves/config under `HOME`.
- Purpose-prefixed commit subjects (`Packages:`, `Browser:`, `Docs:` …);
  end commit bodies with the `Co-Authored-By: Claude Opus 4.8 (1M
  context) <noreply@anthropic.com>` trailer. Commit only within this
  branch; do not push unless asked.

## Review Focus

- **Archive fetch failure / offline** (Task 8, 10): a non-200 or network
  error on `quake106.zip` must surface a real error in syslog and must not
  boot into a fake or blank game.
- **`pak0.pak` absent in plain terminal** (Task 11): bare `quake` from the
  shell with no data must exit with the engine's genuine "not found" error,
  not hang or fake success.
- **Corrupt/short archive → extraction failure** (Task 8): unzip or `lh5`
  failure must abort the wrapper with the tool's real error before the
  engine is exec'd.
- **`/dev/fb0` already owned (`EBUSY`)** (Task 3, 12): a second framebuffer
  client, or ingest while running, must respect single-owner and restart
  cleanly via SIGTERM+unbind, not deadlock.
- **Oversized BYO pak** (Task 10): a dropped file over the ingest cap must
  be rejected with a clear message, not silently truncated.

---

### Task 1: Package scaffold + verified source staging

**Files:**
- Create: `packages/registry/tyrquake/package.toml`
- Create: `packages/registry/tyrquake/build.toml`
- Create: `packages/registry/tyrquake/build-tyrquake.sh`

**Interfaces:**
- Produces: a package that stages the pinned TyrQuake source into its work
  dir and verifies its sha256. No binary yet.

- [ ] **Step 1: Pin the source.** Under `scripts/dev-shell.sh`, download the
  v0.71 tag commit archive from `https://github.com/sezero/tyrquake/archive/<sha>.tar.gz`,
  record its sha256:

```bash
scripts/dev-shell.sh bash -lc '
  url="https://github.com/sezero/tyrquake/archive/refs/tags/v0.71.tar.gz"
  curl -fsSL "$url" -o /tmp/tyrquake.tgz && sha256sum /tmp/tyrquake.tgz'
```
Record the resolved commit SHA (from the tag) and sha256 for `package.toml`.

- [ ] **Step 2: Write `package.toml`** modeled on
  `packages/registry/fbdoom/package.toml`:

```toml
kind = "program"
name = "tyrquake"
version = "0.71.0"
kernel_abi = 43
depends_on = []

[source]
url = "https://github.com/sezero/tyrquake/archive/<sha>.tar.gz"
sha256 = "<sha256>"
provider = "archive"

[license]
spdx = "GPL-2.0-only"
url = "https://github.com/sezero/tyrquake/blob/v0.71/gnu.txt"

[build]
script_path = "packages/registry/tyrquake/build-tyrquake.sh"

[[outputs]]
name = "quake"
wasm = "quake.wasm"
```
Add `[[host_tools]]` entries for make/curl/tar/patch mirroring fbdoom.

- [ ] **Step 3: Write `build.toml`** with `script_path`, hashed `inputs`
  (the build script + patches dir), and `revision = 1`, mirroring
  `packages/registry/fbdoom/build.toml`.

- [ ] **Step 4: Write `build-tyrquake.sh` staging skeleton.** Source
  `scripts/package-build-roots.sh`, call
  `kandelo_package_prepare_build_roots "$HERE" wasm32`, then
  `kandelo_package_stage_verified_source` with the pinned commit/url/sha and
  a `.kandelo-tyrquake-source` marker (copy the pattern from
  `build-fbdoom.sh:22-83`). End the script (temporarily) after staging with
  `echo "staged"; exit 0`.

- [ ] **Step 5: Run staging, verify it succeeds.**

Run: `scripts/dev-shell.sh bash packages/registry/tyrquake/build-tyrquake.sh`
Expected: prints `staged`, source tree present under the work dir,
sha256 verified (no mismatch error).

- [ ] **Step 6: Commit.**

```bash
git add packages/registry/tyrquake/
git commit -m "Packages: Scaffold tyrquake package and stage pinned source"
```

---

### Task 2: Compile the software engine (null video) — prove the toolchain

**Files:**
- Modify: `packages/registry/tyrquake/build-tyrquake.sh`
- Create: `packages/registry/tyrquake/patches/0001-disable-x86-asm-build.patch`
  (only if the Makefile needs help selecting C fallbacks under
  `USE_X86_ASM=N`)

**Interfaces:**
- Produces: `bin/tyr-quake` linking to a `.wasm` using `VID_TARGET=null`,
  `IN_TARGET=null`, `SND_TARGET=null`. Proves musl glue + C rasterizer paths
  compile for wasm.

- [ ] **Step 1: Add the SDK + build invocation** to the script (after
  staging), replacing the temporary `exit 0`:

```sh
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
make -C "$SRC" CC=wasm32posix-cc LD=wasm32posix-cc \
     USE_X86_ASM=N USE_SDL=N \
     VID_TARGET=null IN_TARGET=null SND_TARGET=null CD_TARGET=null \
     LIBS="-lm" \
     bin/tyr-quake
```

- [ ] **Step 2: Run the build.** Provision first if the sysroot is missing
  (`scripts/dev-shell.sh ./run.sh setup`).

Run: `scripts/dev-shell.sh bash packages/registry/tyrquake/build-tyrquake.sh`
Expected: compiles and links `bin/tyr-quake` (a wasm module). If
`USE_X86_ASM=N` still references `.S` symbols, capture the exact undefined
symbols and add the minimal Makefile patch (`0001-…`) to select the `_c`
source variants; re-run until it links.

- [ ] **Step 3: Smoke-run headless (truthful failure).** Run the wasm under
  the Node host with no pak present; confirm it starts and exits with a real
  "couldn't load pak0.pak / basedir" error rather than crashing in glue.

Run: `scripts/dev-shell.sh node scripts/run-wasm.mjs <path>/tyr-quake -- -basedir /nonexistent`
(use the repo's existing headless wasm runner; find it via
`ls scripts/*run*wasm* host/test/` if the exact name differs.)
Expected: engine prints its own "not found" diagnostic; no host/glue trap.

- [ ] **Step 4: Commit.**

```bash
git add packages/registry/tyrquake/
git commit -m "Packages: Compile tyrquake software engine for wasm (null backends)"
```

---

### Task 3: `vid_fbdev` video backend (palette → BGRA32 to `/dev/fb0`)

**Files:**
- Create: `packages/registry/tyrquake/patches/0002-add-vid-fbdev.patch`
  (adds `common/vid_fbdev.c` + Makefile wiring for `VID_TARGET=fbdev`)
- Reference (read): `packages/registry/fbdoom/build-fbdoom.sh` +
  fbDOOM's framebuffer frontend; TyrQuake `common/vid_x.c`,
  `common/vid_null.c`; `crates/shared/src/ioctl_contract.rs:267`.

**Interfaces:**
- Consumes: TyrQuake's software VID seam. Implement the functions
  `vid_null.c`/`vid_x.c` implement: `VID_Init(unsigned char *palette)`,
  `VID_Shutdown`, `VID_Update(vrect_t *rects)`, `VID_SetPalette(unsigned
  char *palette)`, `VID_ShiftPalette`, `VID_Alloc*`/`D_*` buffer hooks, and
  populate the global `viddef_t vid` (width/height/rowbytes/`buffer`/
  `conbuffer`/`colormap`). Verify exact signatures against the staged
  headers (`include/vid.h`, `include/d_local.h`).
- Produces: on-screen frames via `/dev/fb0`.

- [ ] **Step 1: Implement `vid_fbdev.c`.** In `VID_Init`: `open("/dev/fb0")`,
  `FBIOGET_VSCREENINFO`/`FBIOGET_FSCREENINFO` for geometry, `mmap` the pixel
  buffer; allocate the 8-bit `vid.buffer` (Quake renders paletted), set
  `vid.width/height/rowbytes/conwidth/conheight`. Cache a 256-entry BGRA32
  LUT built from the Quake palette in `VID_SetPalette`. In `VID_Update`,
  convert the paletted `vid.buffer` to BGRA32 into the mmap'd framebuffer
  (respecting stride), matching fbDOOM's conversion. Handle `EBUSY`
  (single-owner) by failing `Sys_Error` with a clear message. `VID_Shutdown`
  unmaps + closes so `/dev/fb0` unbinds.

- [ ] **Step 2: Wire the Makefile** so `VID_TARGET=fbdev` compiles
  `vid_fbdev.c` (mirror how `VID_TARGET=x11` selects `vid_x.c`); capture in
  the `0002-…` patch.

- [ ] **Step 3: Build with fbdev video** (keep `IN_TARGET=null`,
  `SND_TARGET=null` for now):

Run: change the build script to `VID_TARGET=fbdev`, then
`scripts/dev-shell.sh bash packages/registry/tyrquake/build-tyrquake.sh`
Expected: links cleanly.

- [ ] **Step 4: Verify visually via a throwaway image** (deferred to the
  full E2E in Task 12 for the real check; here just confirm it links and the
  headless run reaches the palette/video init without trapping).

- [ ] **Step 5: Commit.**

```bash
git add packages/registry/tyrquake/
git commit -m "Packages: Add tyrquake fbdev video backend (paletted BGRA32)"
```

---

### Task 4: `in_fbdev` input backend (MEDIUMRAW keyboard + `/dev/input/mice`)

**Files:**
- Create: `packages/registry/tyrquake/patches/0003-add-in-fbdev.patch`
  (adds `common/in_fbdev.c` + Makefile wiring for `IN_TARGET=fbdev`)
- Reference (read): fbDOOM `0002-add-mice-input.patch`; TyrQuake
  `common/in_x11.c`, `common/in_null.c`.

**Interfaces:**
- Consumes: TyrQuake input seam — `IN_Init`, `IN_Shutdown`, `IN_Commands`,
  `IN_Move(usercmd_t *cmd)`, and the key event sink `Key_Event(int key, qboolean
  down)`. Verify against `include/keys.h` / `include/input.h`.
- Produces: keyboard + mouse driving the game.

- [ ] **Step 1: Implement keyboard.** Read MEDIUMRAW bytes (bit 7 = release)
  from the framebuffer pane's keyboard fd; map Linux keycodes → Quake `K_*`
  constants; call `Key_Event`. Build a keycode→`K_*` table (reference
  fbDOOM's mapping + `include/keys.h`).

- [ ] **Step 2: Implement mouse.** Open `/dev/input/mice`, decode PS/2
  3-byte packets, accumulate dx/dy + buttons; in `IN_Move` apply to the
  usercmd (sensitivity via existing cvars). Coalesce all queued packets per
  frame (fbDOOM lesson) so motion isn't lost.

- [ ] **Step 3: Wire the Makefile** for `IN_TARGET=fbdev`; update the build
  script to `IN_TARGET=fbdev`. Build and confirm it links.

Run: `scripts/dev-shell.sh bash packages/registry/tyrquake/build-tyrquake.sh`
Expected: links cleanly.

- [ ] **Step 4: Commit.**

```bash
git add packages/registry/tyrquake/
git commit -m "Packages: Add tyrquake fbdev input (MEDIUMRAW kbd + PS/2 mouse)"
```

---

### Task 5: Sound via reused `snd_oss` (`/dev/dsp`)

**Files:**
- Modify: `packages/registry/tyrquake/build-tyrquake.sh`
- Create (only if needed): `packages/registry/tyrquake/patches/0004-oss-latency.patch`

**Interfaces:**
- Consumes: TyrQuake's existing `snd_oss.c` (`SND_TARGET=oss`) writing
  `/dev/dsp`.
- Produces: audible sound effects.

- [ ] **Step 1: Switch `SND_TARGET=oss`** in the build script and build.

Run: `scripts/dev-shell.sh bash packages/registry/tyrquake/build-tyrquake.sh`
Expected: links against the OSS backend cleanly.

- [ ] **Step 2: If the generic `/dev/dsp` backend needs latency/format
  negotiation** (short-write pacing, `SNDCTL_DSP_*`), add the minimal
  `0004-…` patch mirroring fbDOOM's OSS sound patches. Skip if unneeded.

- [ ] **Step 3: Commit.**

```bash
git add packages/registry/tyrquake/
git commit -m "Packages: Wire tyrquake OSS sound to /dev/dsp"
```

---

### Task 6: Install the artifact as `quake.wasm`

**Files:**
- Modify: `packages/registry/tyrquake/build-tyrquake.sh`

**Interfaces:**
- Produces: `local-binaries/programs/wasm32/quake.wasm` (mirror) resolvable
  as program `quake`.

- [ ] **Step 1: Append install.** After the build:

```sh
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary quake "$SRC/bin/tyr-quake" quake.wasm
```
TyrQuake does not fork → no fork instrumentation (assert clean, like
fbDOOM's `wasm_require_no_fork_instrumentation` note).

- [ ] **Step 2: Run the full package build; confirm the artifact lands.**

Run: `scripts/dev-shell.sh bash packages/registry/tyrquake/build-tyrquake.sh`
Then: `ls -l local-binaries/programs/wasm32/quake.wasm`
Expected: file present, non-empty.

- [ ] **Step 3: Commit.**

```bash
git add packages/registry/tyrquake/
git commit -m "Packages: Install tyrquake software build as quake.wasm"
```

---

### Task 7: `lhasa` extraction package (+ zip extractor if absent)

**Files:**
- Create: `packages/registry/lhasa/{package.toml,build.toml,build-lhasa.sh}`
- Create (only if the shell image has no zip extractor): `packages/registry/unzip/…`

**Interfaces:**
- Produces: `lhadecode`/`lha` (lhasa CLI) able to `lh5`-extract `resource.1`,
  installed to `/usr/local/bin`. A zip extractor available in-image.

- [ ] **Step 1: Check for an existing zip/lha tool.**

Run: `grep -rInE "bsdtar|libarchive|unzip|lhasa|\blha\b" images/vfs/scripts/ packages/registry/ | grep -iv node_modules`
Expected: determines whether a libarchive `bsdtar` already ships (handles
both zip and lha → package only that) or whether we need `unzip` + `lhasa`.

- [ ] **Step 2: Package `lhasa`** (Simon Howard, GPL-2.0, no deps) modeled on
  a simple C `kind = "program"` package (`fbdoom`/`nethack` shape): pin the
  release tarball + sha256, `./configure && make` under `wasm32posix-cc`,
  `install_local_binary lha bin/lha lha.wasm`.

- [ ] **Step 3: Build and confirm the artifact.**

Run: `scripts/dev-shell.sh bash packages/registry/lhasa/build-lhasa.sh`
Then: `ls -l local-binaries/programs/wasm32/lha.wasm`
Expected: present. (Repeat for `unzip` only if Step 1 showed it is missing.)

- [ ] **Step 4: Commit.**

```bash
git add packages/registry/lhasa/ packages/registry/unzip/ 2>/dev/null; git add packages/registry/lhasa/
git commit -m "Packages: Add lhasa (lh5) extractor for in-Kandelo pak extraction"
```

---

### Task 8: Idempotent extraction + launch wrapper

**Files:**
- Create: `packages/registry/tyrquake/quake-launch.sh` (installed to
  `/usr/local/bin/quake`)
- Modify: `packages/registry/tyrquake/build-tyrquake.sh` (install the wrapper
  as `/usr/local/bin/quake` and the engine as `/usr/local/bin/quake-engine`)

**Interfaces:**
- Consumes: `lha`/`unzip` (Task 7), `quake-engine` (Task 6),
  `/usr/share/quake/quake106.zip` (Task 10 stages it).
- Produces: `/usr/share/quake/id1/pak0.pak`, then execs the engine.

- [ ] **Step 1: Write `quake-launch.sh`:**

```sh
#!/bin/sh
set -e
BASE=/usr/share/quake
PAK="$BASE/id1/pak0.pak"
if [ ! -f "$PAK" ] && [ -f "$BASE/quake106.zip" ]; then
  echo "quake: extracting shareware data..." >&2
  cd "$BASE"
  unzip -o quake106.zip >/dev/null          # -> resource.1
  lha -xw="$BASE/_extract" resource.1        # lh5 -> id1/PAK0.PAK
  mkdir -p "$BASE/id1"
  # locate the extracted pak case-insensitively and normalize the name
  found=$(find "$BASE/_extract" -iname 'pak0.pak' | head -n1)
  [ -n "$found" ] && cp "$found" "$PAK"
fi
exec /usr/local/bin/quake-engine -basedir "$BASE" "$@"
```
Adjust the `lha`/`unzip` flags to the packaged tools' actual CLI. On any
failure `set -e` aborts before `exec`, surfacing the real error.

- [ ] **Step 2: Install both** in the build script:
  `install` the engine as `quake-engine.wasm` (rename the output) and place
  `quake-launch.sh` so the image writes it to `/usr/local/bin/quake`. (Decide
  in Task 10 whether the wrapper is written by the image builder or shipped
  in the archive; keep the engine artifact name consistent.)

- [ ] **Step 3: Dry-run the wrapper logic locally** against a real
  `quake106.zip` in a scratch dir to confirm unzip→lha→pak yields the exact
  18,689,235-byte pak with the expected sha256.

Run: `scripts/dev-shell.sh bash -lc 'cd /tmp && rm -rf q && mkdir q && cp <zip> q/quake106.zip && cd q && unzip -o quake106.zip && lha ... resource.1 && sha256sum $(find . -iname pak0.pak)'`
Expected: sha256 = `35a9c55e5e5a284a159ad2a62e0e8def23d829561fe2f54eb402dbc0a9a946af`.

- [ ] **Step 4: Commit.**

```bash
git add packages/registry/tyrquake/
git commit -m "Packages: Add idempotent in-Kandelo pak extraction launch wrapper"
```

---

### Task 9: Archive asset constants + bridge test

**Files:**
- Modify: `web-libs/kandelo-session/src/demo-guides.ts`
- Modify: `tests/package-system/source-rootfs-shell-bridge.test.ts` (or the
  nearest existing demo-config assertion test)

**Interfaces:**
- Produces: `QUAKE_ZIP_URL`, `QUAKE_ZIP_SHA256` constants the demo config
  references; a test asserting the profile points at them.

- [ ] **Step 1: Pin + verify the `quake106.zip` mirror.** Find a CORS-OK,
  jsDelivr-servable GitHub mirror pinned to a commit; download and hash it.

Run: `scripts/dev-shell.sh bash -lc 'curl -fsSL "<cdn-url>" | sha256sum; curl -sI "<cdn-url>" | grep -iE "content-length|access-control-allow-origin"'`
Expected: `content-length: 9094045`, `access-control-allow-origin: *`,
record the sha256.

- [ ] **Step 2: Add constants** to `demo-guides.ts` mirroring
  `DOOM_WAD_URL`/`DOOM_WAD_SHA256`.

- [ ] **Step 3: Write the failing test** asserting the `quake` profile's
  asset URL/sha256 equal the constants (copy the existing DOOM assertion).

Run: `scripts/dev-shell.sh npx vitest run tests/package-system/source-rootfs-shell-bridge.test.ts`
Expected: FAIL (profile not defined yet) — this passes after Task 10.

- [ ] **Step 4: Commit.**

```bash
git add web-libs/kandelo-session/src/demo-guides.ts tests/
git commit -m "Browser: Pin Quake shareware archive URL + digest constants"
```

---

### Task 10: `quake` demo profile, gallery, owned command, image wiring

**Files:**
- Modify: `packages/registry/shell/source-rootfs-shell-demo-profiles.json`
- Modify: `apps/browser-demos/pages/kandelo/gallery-roster.json`
- Modify: `images/vfs/scripts/build-source-rootfs-shell-image.ts`
- Modify: `packages/registry/shell/build-shell.sh`

**Interfaces:**
- Consumes: `quake`/`quake-engine`/`lha` artifacts, the archive constants.
- Produces: a bootable `quake` profile in `shell.vfs.zst`.

- [ ] **Step 1: Add the `quake` profile** to the demo-profiles overlay
  (model on the `doom` profile):

```json
"quake": {
  "identity": {
    "title": "Quake (software)",
    "summary": "TyrQuake's software renderer on /dev/fb0, extracted from id's shareware archive inside Kandelo.",
    "accent": "#8a1c1c", "glyph": "Q",
    "packages": ["tyrquake@local","lhasa@local","bash@local","coreutils@local"]
  },
  "runtime": { "features": ["framebuffer"] },
  "init": { "shellCommand": "/usr/local/bin/quake" },
  "presentation": {
    "bootPrimary": "syslog",
    "runningPrimary": ["framebuffer","terminal","syslog"],
    "terminalAccess": "drawer", "internalsAccess": "drawer",
    "touchControls": true
  },
  "assets": [
    { "path": "/usr/share/quake/quake106.zip", "url": "<QUAKE_ZIP_URL>",
      "sha256": "<QUAKE_ZIP_SHA256>", "mode": 420 }
  ],
  "ingest": {
    "accept": ".pak", "maxBytes": 33554432,
    "targetPath": "/usr/share/quake/id1/pak0.pak",
    "onLoad": { "restart": "/usr/local/bin/quake" }
  }
}
```

- [ ] **Step 2: Register in `gallery-roster.json`:**
  `{ "product": "browser-main-shell", "profile": "quake" }`.

- [ ] **Step 3: Own the command.** Add `quake` to
  `SOURCE_ROOTFS_DEMO_COMMANDS` (command `/usr/local/bin/quake`, executable
  `/usr/local/bin/quake`) so `requireOwnedDemoCommands` enforces launchability.

- [ ] **Step 4: Eager writes.** In `build-source-rootfs-shell-image.ts`
  accept a `--quake <path>` (engine) flag; `writeVfsBinary` the engine to
  `/usr/local/bin/quake-engine` (0755), the launch wrapper to
  `/usr/local/bin/quake` (0755), and `lha`/`unzip` to `/usr/local/bin`.
  Thread the flag through `build-shell.sh`.

- [ ] **Step 5: Build the image; run the bridge test (now green).**

Run: `scripts/dev-shell.sh bash packages/registry/shell/build-shell.sh`
then `scripts/dev-shell.sh npx vitest run tests/package-system/source-rootfs-shell-bridge.test.ts`
Expected: image builds; `requireOwnedDemoCommands` passes; bridge test PASS.

- [ ] **Step 6: Commit.**

```bash
git add packages/registry/shell/ apps/browser-demos/pages/kandelo/gallery-roster.json images/vfs/scripts/build-source-rootfs-shell-image.ts
git commit -m "Browser: Add quake (software) demo profile and image wiring"
```

---

### Task 11: Lazy terminal `quake` + extraction tools in base shell

**Files:**
- Modify: `images/vfs/scripts/shell-lazy-archives.ts`
- Modify: `images/vfs/scripts/source-rootfs-shell-overlay.ts`

**Interfaces:**
- Produces: `quake` (and `lha`/`unzip`) fetched on first `exec` in the base
  shell profile.

- [ ] **Step 1: Register `quake-engine` (or a `quake` alias) + `lha`/`unzip`
  as lazy binaries** in `SHELL_LAZY_BINARY_SPECS`, following the nethack
  entry pattern. Decide whether terminal `quake` maps to the raw engine
  (user supplies `-basedir`) or the wrapper.

- [ ] **Step 2: Build the base shell image; confirm the lazy nodes register**
  (a `kandelo-lazy:` placeholder inode exists for `quake`).

Run: `scripts/dev-shell.sh bash packages/registry/shell/build-shell.sh`
Expected: build succeeds; grep the build log / image manifest for the lazy
`quake` registration.

- [ ] **Step 3: Commit.**

```bash
git add images/vfs/scripts/
git commit -m "Browser: Offer quake as a lazy terminal binary in the base shell"
```

---

### Task 12: Playwright E2E — software renderer presents real frames

**Files:**
- Create: `apps/browser-demos/test/kandelo-quake.spec.ts`
- Reference (read): `apps/browser-demos/test/kandelo-sdl2.spec.ts`,
  `apps/browser-demos/test/support/kandelo-machine.ts`

**Interfaces:**
- Consumes: the built `quake` profile image.
- Produces: an automated proof the demo renders + exits cleanly.

- [ ] **Step 1: Write the spec** (Framebuffer-pane variant of the SDL2 test):

```ts
test("quake software demo boots the shareware first level", async ({ page }) => {
  await gotoMachineOrSkip(page, "quake");
  // extraction + launch
  await expect(page.getByText(/running \/usr\/local\/bin\/quake/)).toBeVisible({ timeout: 120_000 });
  const canvas = page.locator(".kandelo-framebuffer-canvas").first(); // confirm selector in Framebuffer.tsx
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  // prove non-blank + animation via PNG byte-size variance
  const sizes: number[] = [];
  await expect.poll(async () => {
    await page.waitForTimeout(500);
    const shot = await canvas.screenshot();
    sizes.push(shot.byteLength);
    return Math.max(...sizes) - Math.min(...sizes);
  }, { timeout: 45_000 }).toBeGreaterThan(400);
  expect(Math.min(...sizes)).toBeGreaterThan(3500); // not a blank frame
  // input + clean exit
  await canvas.click();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/quake .*exited/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/quake .*failed/)).toBeHidden();
});
```
Confirm the framebuffer canvas selector and the exact syslog/exit
breadcrumb strings against `Framebuffer.tsx` and the wrapper's stderr.

- [ ] **Step 2: Run it** (source-only Playwright env; unique `--port`;
  see the browser-app provisioning memory).

Run: `scripts/dev-shell.sh bash -lc 'cd apps/browser-demos && <playwright cmd> test/kandelo-quake.spec.ts'`
Expected: PASS — canvas visible, frame-size variance > 400, clean exit.

- [ ] **Step 3: Commit.**

```bash
git add apps/browser-demos/test/kandelo-quake.spec.ts
git commit -m "Browser: Add Playwright test for the quake software demo"
```

---

### Task 13: Full validation + manual verification + docs

**Files:**
- Modify: `docs/plans/2026-09-24-quake-tyrquake-port-design.md` (tick Phase 1
  status; record the pinned SHAs/URLs resolved during implementation)
- Modify: `docs/posix-status.md` / `docs/browser-support.md` if any
  platform-observable behavior changed

- [ ] **Step 1: Clean rebuild** under `scripts/dev-shell.sh`: package →
  image → run the bridge test + the new Playwright spec together. Report
  exactly what was run.

- [ ] **Step 2: Manual browser check.** `./run.sh browser`, open the `quake`
  profile: confirm the extraction runs (visible in syslog), the id logo /
  menu appears, the first level ("E1M1") is reachable and playable with
  keyboard + mouse, and sound effects are audible. Verify BYO-pak ingest
  restarts cleanly. Verify offline/failed fetch surfaces a real error.

- [ ] **Step 3: Update docs** with resolved pins + Phase 1 completion; note
  Phase 2 remains open.

- [ ] **Step 4: Commit.**

```bash
git add docs/
git commit -m "Docs: Record Quake Phase 1 completion and resolved source pins"
```

---

## Notes for the executor

- This is an engine **port**, not greenfield code: several tasks' "tests"
  are build-success + headless smoke + the final E2E, because unit tests
  don't map onto a cross-compiled renderer. Where a real unit test fits
  (asset constants, extraction sha256), it is written first (Tasks 8, 9).
- The C in Tasks 3–4 must be written against the **staged** TyrQuake headers
  (`include/vid.h`, `include/input.h`, `include/keys.h`) — verify every seam
  signature there before implementing; do not trust the signatures sketched
  here without checking.
- Keep Node/browser parity in mind: the engine runs on both hosts; the
  Framebuffer pane is browser-side. The headless Node smoke (Task 2/3) and
  the browser E2E (Task 12) together cover both.
- Fresh-worktree provisioning (musl submodule → sysroots → programs → image)
  is expected setup, not a blocker.
