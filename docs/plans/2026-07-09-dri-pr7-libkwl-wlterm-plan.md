# DRI v2 — PR7: `libkwl` toolkit + `wlterm` (BROWSER GATE, milestone D′)

Date: 2026-07-09
Branch: `explore-dri-wayland`
Worktree: `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz`

> **Status:** Scope for PR7 of the Wayland-first compositor stack
> (`2026-07-08-dri-wayland-compositor-plan.md` §5). PR6 (the PID-2
> `wlcompositor` server) is DONE and committed. PR7 delivers the first
> real Kandelo Wayland **client app** and closes milestone **D′** — a
> toolkit-built window rendered by our compositor, gated **in the
> browser**.
>
> Repurposes two pre-pivot plan docs whose pseudocode still applies:
> `2026-07-06-wpkdraw-plan.md` (raster primitives + font engine) and
> `2026-07-20-wpk-shell-plan.md` (VT100 core). Those plans targeted the
> dropped custom `wpkcompositor`; here their **rendering/parsing halves
> survive and their KMS-master / custom-wire halves are dropped** per the
> Wayland plan §6 amendment.
>
> **Shipped deviations from this plan:** the bundled font is Inconsolata
> (not DejaVu Sans), embedded as a build-generated C header rather than a
> staged `share/*.ttf`; `wpk_line`/`wpk_blit` and the vt100 scrollback
> ring were dropped — no consumer needed them.

---

## §1. Locked decisions (confirmed with the user, 2026-07-09)

1. **One commit.** PR7 lands as a single commit (`feat(dri/wayland): … (PR7)`),
   exactly as PR6 did. The phases below are the internal build order, not
   separate merges.
2. **Standalone `libwpkdraw`.** The CPU rasterizer is its own static lib
   under `examples/libs/wpkdraw/`, reusable by later seed apps (`wpkfm`,
   `wpkpanel`) — not folded into `libkwl`.
3. **Real `forkpty` + shell.** `wlterm` `forkpty()`s and execs a real shell
   (`dash`) over a PTY, feeding its output to the VT100 core. PTY support is
   confirmed full (see §3).

---

## §2. Feasibility — the stack is already in place

PR7 is **content authoring, not host plumbing.** Verified during scoping:

| PR7 needs | Status | Where |
|---|---|---|
| Two-process compositor+client in one kernel | ✅ proven (PR6) | `host/test/wlcompositor-smoke.test.ts` |
| `wl_shm` prime-fd buffer sharing (`SCM_RIGHTS` + `gbm_bo_import`) | ✅ proven (PR6) | `wlclient-test.c` `make_buffer` |
| xkb keymap fd-pass + key/pointer routing | ✅ proven (PR6) | compositor `wl_seat` path |
| PTY: `posix_openpt`/`grantpt`/`unlockpt`/`ptsname`/termios/`TIOCGWINSZ`/`forkpty` | ✅ Full | `docs/posix-status.md:308–313`, `crates/kernel/src/{syscalls.rs,terminal.rs,devfs.rs}` |
| A real shell to exec | ✅ | `packages/registry/{dash,bash}`, `programs/sh.c` |
| Browser: KMS `card0` → OffscreenCanvas | ✅ (modeset/sdl2) | `live-setup.ts` `kmsAttachCanvas`; `browser-kernel-host.ts` |
| Browser: DOM input → evdev injection | ✅ | `host/src/input/browser-input-source.ts`, `injectInputEvent` |
| Browser: multi-MB binary spawn from VFS | ✅ | `browser-kernel-host.ts` `spawnFromVfs` |
| Playwright demo gate pattern | ✅ | `apps/browser-demos/test/kandelo-{modeset,sdl2}.spec.ts` |

**No new kernel syscalls, no ABI change expected.** Confirm with
`check-abi-version.sh` at the end (expect no bump — same as the Wayland
plan §9 predicts for all v1 Wayland work).

---

## §3. Phase 1 — `libwpkdraw` (CPU raster helper)

`examples/libs/wpkdraw/` — a **buffer-target-only** rasterizer. The old
`2026-07-06-wpkdraw-plan.md` has the full primitive + font pseudocode; take
its rendering half, drop its surface/KMS half.

**KEEP** (render into a caller-owned ARGB8888/XRGB8888 pixel buffer):
`wpk_clear`, `wpk_pixel`, `wpk_rect`, `wpk_line`, `wpk_blit`, alpha blend;
font engine (`wpk_font_load_default`, `wpk_text`, `wpk_text_width`,
`wpk_font_height_px`, `wpk_font_ascent_px`) over a vendored
`stb_truetype.h` + a bundled DejaVu Sans + a 256-entry FIFO glyph cache.

**DROP** (the compositor owns the screen now): `wpk_surface_create`/`present`,
`drmSetMaster`/`drmDropMaster`, `drmModeSetCrtc`, `drmModePageFlip`,
`gbm_bo` allocation, `wpk_widget_pump_events` (input comes from Wayland).

**Surface abstraction change.** `struct wpk_surface` becomes a plain
descriptor over caller memory — `{ uint32_t *pixels; int w, h, stride; }` —
constructed with `wpk_surface_wrap(pixels, w, h, stride)`. Every primitive
takes `struct wpk_surface *`; no lifecycle, no fd, no bo.

Files: `examples/libs/wpkdraw/{package.toml,build.toml,build.sh}`,
`include/wpkdraw/{wpkdraw.h,wpkfont.h}`, `src/{wpkdraw.c,wpkfont.c}`,
`third_party/stb_truetype.h`, `share/DejaVuSans.ttf` (+ `.LICENSE`).
Packaged with the `libdrm`/`libgbm` recipe shape.

**Gate:** `host/test/wpkdraw-smoke.test.ts` + `programs/wpkdraw_smoke.c` —
wrap a heap buffer, `wpk_clear` + `wpk_rect` red + `wpk_text "OK"`, assert
the red rect pixels and non-zero glyph coverage in the expected cells.

---

## §4. Phase 2 — `libkwl` (toolkit over libwayland-client)

`examples/libs/libkwl/` — generalizes `wlclient-test.c`'s ~300 lines of
boilerplate (registry bind, xdg toplevel, `wl_shm` buffer, seat listeners,
frame callback) into a reusable API. The **new** surface of PR7; no prior
plan covers it.

```c
/* Connection + a single CSD toplevel window. */
struct kwl_window *kwl_window_create(const char *title, int w, int h);
void               kwl_window_destroy(struct kwl_window *win);

/* Draw target: the window's back buffer as a wpk_surface (Phase 1). */
struct wpk_surface *kwl_window_surface(struct kwl_window *win);
void                kwl_window_commit(struct kwl_window *win);   /* attach+damage+frame+commit; swaps double buffer */

/* Event loop. Pumps wl_display; returns 0/1 events. timeout_ms<0 blocks. */
enum kwl_event_type { KWL_KEY, KWL_TEXT, KWL_POINTER_MOTION, KWL_POINTER_BUTTON, KWL_CLOSE, KWL_FRAME };
struct kwl_event { enum kwl_event_type type; uint32_t keysym, mods, button, state; int x, y; char utf8[8]; };
int kwl_dispatch(struct kwl_window *win, struct kwl_event *out, int timeout_ms);

/* wl_display fd — LOAD-BEARING: wlterm epolls this AND the PTY master. */
int kwl_display_fd(struct kwl_window *win);
```

Internals: double-buffered `wl_shm` (two gbm dumb-bos, prime-fd pools, swap
on commit — reusing `wlclient-test.c` `make_buffer`), xkb keymap compile on
`wl_keyboard.keymap` → keysym + UTF-8 in `KWL_KEY`/`KWL_TEXT`, CSD (v1: a
1-px border + title bar drawn by the app via libwpkdraw; no server-side
decoration).

Files: `examples/libs/libkwl/{package.toml,build.toml,build.sh}`,
`include/kwl.h`, `src/{window.c,buffer.c,input.c}`. Deps: `libwayland`,
`libxkbcommon`, `wpkdraw`, `libgbm`.

**Gate:** `host/test/libkwl-smoke.test.ts` + `programs/kwldemo.c` — a
button+label window driven against `wlcompositor` (same two-process harness
as the PR6 smoke test): bind → map → composite (assert `COMPOSITE_SAMPLE`
non-black), inject a pointer button over the button rect → assert an
`on_click` marker, inject a key → assert `KWL_TEXT`. Proves the toolkit
end-to-end.

---

## §5. Phase 3 — `wlterm` (the app)

`programs/wlterm/` (next to `programs/wlcompositor/`). A real terminal:
libkwl window + a VT100 core + a `forkpty`'d shell.

- **VT100 core** — from `2026-07-20-wpk-shell-plan.md`'s `libwpkterm`
  pseudocode, kept as an **in-tree module** (`programs/wlterm/vt100.c`),
  not a packaged lib (only wlterm consumes it in v1; promote later when a
  second consumer appears). Cell grid + scrollback ring, `GROUND→ESCAPE→CSI`
  parser, SGR 16-colour palette, cursor moves, ED/EL erase, UTF-8 decode,
  dirty-line render via `wpk_text` into the libkwl back buffer, and a
  keysym→bytes mapper (arrows/Home/End/Ctrl-combos/printable).
- **Shell** — `forkpty()` → `execvp("dash", …)` (or `/bin/sh`); child's
  slave PTY is its stdio, parent holds the master fd. Set `TIOCSWINSZ` from
  the grid dimensions.
- **Main loop** — `epoll` over `{ kwl_display_fd(win), pty_master }`:
  Wayland events → `kwl_dispatch` → key → `wpk_term_input_key` → `write(pty)`;
  PTY readable → `read` → `wpk_term_feed` → mark dirty → render →
  `kwl_window_commit`. `SIGCHLD`/`POLLHUP` on the master → shell exited →
  clean exit. `SIGPIPE` ignored.

Files: `programs/wlterm/{wlterm.c,vt100.c,vt100.h}`, a `build-programs.sh`
block (dedicated pass like `wlcompositor` — needs the libkwl/wpkdraw
include dirs + multi-archive link line + fork instrumentation, since
`forkpty` forks).

**Gate:** `host/test/wlterm-smoke.test.ts` — spawn `wlcompositor` + `wlterm`
(shell = a scripted `dash -c 'printf ...; read x; printf ...'`), assert the
printed text lands in the expected grid cells (marker dump), inject a key,
assert it reaches the shell (echoed back through the grid), both exit 0.

---

## §6. Phase 4 — Browser gate (milestone D′)

The point of PR7: the compositor+`wlterm` stack runs under `./run.sh
browser`, not just Node vitest. This is the **dual-host-parity** proof — the
compositor has only ever run in Node so far.

Touch points (model on the `modeset`/`sdl2` demos):
1. `run.sh` — `build_wlcompositor`/`build_wlterm` builders + add to the
   browser deps array; stage `dash` into the demo VFS.
2. `apps/browser-demos/pages/kandelo/presets.ts` — a `wayland` preset
   (boot command spawns the compositor; compositor or init spawns `wlterm`).
3. `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` — stage the
   compositor + wlterm + dash binaries at boot, spawn the compositor,
   `kmsAttachCanvas` for `card0`, attach `BrowserInputSource` (keyboard on
   `event0`, pointer on `event1`).
4. `images/vfs/…` — `/etc/kandelo/demo.json` (via `writeKandeloDemoConfig`)
   declaring the surface + assets, if the preset needs demo metadata.
5. `apps/browser-demos/test/kandelo-wayland.spec.ts` — Playwright: load
   `/?demo=wayland`, poll syslog for `COMPOSITOR_UP` + `CLIENT_READY`,
   assert the canvas screenshot > threshold bytes (window rendered),
   `page.keyboard.type("ls\n")` → poll for shell output in the grid, ESC or
   clean shutdown. Skip-if-binary-missing guard like the existing specs.

**Per CLAUDE.md dual-host rule:** the Node smoke gates (§3–§5) do **not**
protect the browser path; Phase 4's Playwright spec is mandatory, and both
land in the same commit.

---

## §7. File manifest (all in commit 7)

```
examples/libs/wpkdraw/      package.toml build.toml build.sh
                            include/wpkdraw/{wpkdraw.h,wpkfont.h}
                            src/{wpkdraw.c,wpkfont.c}
                            third_party/stb_truetype.h  share/DejaVuSans.ttf(+LICENSE)
examples/libs/libkwl/       package.toml build.toml build.sh
                            include/kwl.h  src/{window.c,buffer.c,input.c}
programs/wlterm/            wlterm.c vt100.c vt100.h
programs/{wpkdraw_smoke.c,kwldemo.c}
host/test/{wpkdraw-smoke,libkwl-smoke,wlterm-smoke}.test.ts
apps/browser-demos/test/kandelo-wayland.spec.ts
apps/browser-demos/pages/kandelo/presets.ts                     (edit)
apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts      (edit)
scripts/build-programs.sh                                       (edit: wlterm/kwldemo/wpkdraw_smoke blocks)
run.sh                                                          (edit: builders + browser deps)
docs/{posix-status.md,porting-guide.md}                         (edit if surface changes)
docs/plans/2026-07-08-dri-wayland-compositor-plan.md            (edit: §5 PR7 → DONE)
```

---

## §8. Risks / watch-items

1. **Browser timing** — assert canvas *byteLength* (not pixels) and poll
   syslog markers; OffscreenCanvas pixel reads are unreliable (learned by
   the modeset/sdl2 specs).
2. **Two-process spawn in the browser** — proven in Node vitest, but no
   browser demo yet runs two coexisting processes. First real exercise;
   budget debugging here. Watch fd inheritance / `SOCK_CLOEXEC` across the
   compositor→wlterm spawn (fix noted in the wpk-shell plan).
3. **`forkpty` under fork-instrumentation** — `wlterm` forks, so the
   `wlterm.wasm` build MUST run `run-wasm-fork-instrument.sh` (per CLAUDE.md
   fork policy). Missing instrumentation must fail loudly, not degrade.
4. **PTY winsize / SIGWINCH** — v1 window is fixed-size (surfaces immutable
   in v1 per the Wayland plan); set `TIOCSWINSZ` once at startup.
5. **Socket path** — clients connect to `/tmp/wayland-0` (PR6 decision:
   `/` is ro-rootfs, `/var/run` is `EACCES` for non-root). libkwl must use
   `/tmp/wayland-0`, matching the compositor.

---

## §9. Verification (per CLAUDE.md — all must pass)

1. `cargo test -p kandelo --target aarch64-apple-darwin --lib` — expect no regressions (no kernel change anticipated).
2. `cd host && npx vitest run` — the three new smoke gates pass; pre-existing ABI-16 stale-binary failures remain out of scope.
3. `scripts/run-libc-tests.sh` — 0 unexpected FAIL (run only if kernel/libc touched; PR7 shouldn't).
4. `scripts/run-posix-tests.sh` — 0 FAIL (same caveat).
5. `bash scripts/check-abi-version.sh` — exit 0, **no ABI bump** (confirm the raster/toolkit/app work is userland-only).
6. **Browser demo verification** — `./run.sh browser`, `/?demo=wayland`, plus the Playwright spec. This is the D′ milestone gate; it is NOT optional.
