# DRI v2 — seed apps plan (wpkfm file-manager + SDL_wpkvideo + wpkbeep audio + wpkpanel widget bar)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Ship four small compositor-client applications that
exercise the plan 2–10 surface end-to-end and turn the
single-window wpkshell demo of plan 10 into a recognisable
desktop:

1. **`examples/programs/wpkfm/`** (~800 LoC) — a file manager.
   Tree view of the rootfs rendered via libwpkdraw, clickable
   rows, double-click-to-descend / single-click-to-select,
   keyboard navigation (Up/Down/Enter/Backspace), one-line
   status bar. Operates over plain `opendir`/`readdir`/`stat` —
   no shell-out, no fork-exec. Lets a user actually navigate the
   filesystem without typing.
2. **`sysroot/patches/sdl2-wpkvideo/` + `examples/programs/wpkcube/`**
   — a new SDL2 video backend (`SDL_wpkvideo`, ~400 LoC of SDL2
   patch) that allocates `SDL_Window` surfaces via libwpkclient
   instead of taking KMS master. The cube demo from plan 7
   PR #2 is rebuilt against this backend; both compositor and
   GLES2 cube coexist in one screen. This is the **post-v1 GL
   coexistence path** the plan 7 KMS-master-coexistence
   cross-plan amendment promised.
3. **`examples/programs/wpkbeep/`** (~300 LoC) — a 1-button
   audio demo. Single 80×40 button; clicking enqueues a 1 s
   440 Hz sine wave into `/dev/snd/pcmC0D0p` using plan 6's
   ALSA `WRITEI` + plan 7's non-blocking-WRITEI + EAGAIN-poll
   amendment. Replaces the plan 6 standalone beep demo with a
   compositor-client variant.
4. **`examples/programs/wpkpanel/`** (~400 LoC) — a 24-px-tall
   panel strip across the top of the screen. Shows a clock
   (HH:MM, right-aligned), an active-application indicator
   (left, polled via `compositor_query_focus` if plan 9 ships
   that — see "Cross-references" below), and a static system-
   tray placeholder (right, fixed icons). Runs as **PID 4** —
   init forks it after PID 3 (wpkshell) so the panel paints
   above whatever's underneath without obstructing window
   placement (compositor reserves the top 24 px from the usable
   work-area).

Combined: ~1900 LoC of new C across four apps, one SDL2 video
backend patch under `sysroot/patches/`, and one new package
recipe (`libwpkdraw_widgets` — a tiny static helper for the
button / row / status-bar widgets shared by wpkfm + wpkbeep +
wpkpanel; see "Architecture" below).

**Architecture:** Four PRs, one per app. Each task below is one
commit. A small fifth piece — the `libwpkdraw_widgets` helper —
ships as a sub-task of PR #1 (it's the dependency wpkfm needs
first, and wpkbeep + wpkpanel re-link the same archive).

1. **`examples/libs/libwpkdraw_widgets/`** (~250 LoC, ships in
   PR #1 alongside wpkfm) — a *very* thin widget library:
   `wpkw_button(surface, x, y, w, h, label, pressed) → void`,
   `wpkw_row(surface, x, y, w, label, selected) → void`,
   `wpkw_status(surface, x, y, w, text) → void`. Three drawing
   primitives over libwpkdraw + DejaVu Sans 12px. No event-
   handling state; callers track focus / press state in their
   own structs and pass the booleans. Intentionally tiny — a
   real widget framework is post-v1.
2. **`examples/programs/wpkfm/`** — main loop + filesystem
   listing + libwpkdraw_widgets row rendering. Compositor
   client via libwpkclient. Two columns: directory tree on
   left (clickable rows), preview pane on right (text snippet
   for `S_ISREG` entries with magic-byte sniffing, blank for
   `S_ISDIR`).
3. **`sysroot/patches/sdl2-wpkvideo/`** — a patch series against
   plan 7's vendored SDL2 source that adds a new video backend
   `SDL_wpkvideo`. Surface allocation goes through libwpkclient
   instead of `drmModeSetCrtc`; SDL2's GL context binds an EGL
   surface backed by a gbm bo whose prime fd is shared to the
   compositor via SCM_RIGHTS (plan 2 + plan 9 D3 path). Built
   from a new build artifact `libSDL2_wpkvideo.a` (separate
   archive from plan 7's `libSDL2.a`; they're mutually
   exclusive at link time — wpkcube links the wpkvideo variant,
   plan 7's KMSDRM demo links the KMSDRM variant).
4. **`examples/programs/wpkcube/`** — the plan 7 cube demo
   compiled against `libSDL2_wpkvideo.a`. Same source as plan
   7 PR #2's cube demo with `SDL_SetHintWithPriority(
   SDL_HINT_VIDEODRIVER, "wpkvideo", SDL_HINT_OVERRIDE);` at
   the top. Visual proof: a GLES2-rendered spinning cube
   coexisting with wpkfm and wpkbeep on a wpkcompositor
   desktop.
5. **`examples/programs/wpkbeep/`** — compositor client +
   libwpkdraw_widgets button + ALSA WRITEI worker. Click →
   non-blocking `ioctl(SNDRV_PCM_IOCTL_WRITEI_FRAMES)` loop
   feeding a 1 s sine wave from a precomputed 44 100-sample
   buffer; poll-based progress indicator (red light during
   playback, green light when ready).
6. **`examples/programs/wpkpanel/`** — compositor client +
   libwpkdraw_widgets status renderer + `clock_gettime`
   polling (~1 Hz redraw cadence). Init amendment extended:
   PID 4 after PID 3, gated on `/etc/wpk/compositor` presence
   (same gate as plan 9 D1 + plan 10 B1).

The four apps **share no state**, communicate only with the
compositor, and run as independent kernel processes. They are
NOT integrated; killing one does not affect the others. The
panel is the only app started by init at boot; wpkfm + wpkbeep +
wpkcube are user-launched from wpkshell (`wpkfm &` for example,
once job-control lands — until then, the demo's `./run.sh
browser` script pre-launches them as background PIDs).

**Tech Stack:**
- Userland C: C99 with `wasm32posix-cc`; static archives only.
- All four apps link `-lwpkclient -lwpkdraw -lwpkdraw_widgets
  -lc`; wpkcube additionally links `-lSDL2_wpkvideo -lEGL
  -lGLESv2 -lgbm`; wpkbeep additionally links `-lasound` (plan
  6 ALSA wrapper).
- Wire format: libwpkclient (plan 9) — surface create/attach/
  commit + INPUT_* event polling. No new wire types.
- Buffer sharing: client → compositor via plan 2's prime fd +
  SCM_RIGHTS over libwpkclient. NO host imports.
- Input: libwpkclient delivers `WPK_CLIENT_KEY` +
  `WPK_CLIENT_POINTER_BUTTON` + `WPK_CLIENT_POINTER_MOTION`
  events with compositor-side xkb resolution.
- Audio (wpkbeep): plan 6 ALSA `WRITEI_FRAMES` ioctl + plan 7
  non-blocking poll + plan 6's EAGAIN return arm.
- GL (wpkcube): plans 2 + 3 follow-up + SDL2 patched with
  `SDL_wpkvideo` backend. wpkvideo's `CreateWindow` calls
  libwpkclient; `GL_CreateContext` binds an EGL surface to a
  gbm bo shared with the compositor.
- Text rendering: libwpkdraw + DejaVu Sans 12 px (panel +
  widget labels); 10 px (file-manager row text, denser).
- Clock source: `clock_gettime(CLOCK_MONOTONIC, …)` (plan 10
  parity) for repeat-rate gating; `clock_gettime(CLOCK_REALTIME,
  …)` + `localtime_r` for the panel's wall clock.

**Companion design doc:** `docs/plans/2026-05-18-dri-design.md`
§9.3 (libwpkdraw consumer story), §9.6 (panel + tray placement
contract), §13 (SCM_RIGHTS for prime-fd attach), §9.5
(custom-protocol vs Wayland trade-off — relevant to
`SDL_wpkvideo` design).

**Critical wasm32 ABI detail:** Every byte goes through existing
syscalls. **Zero kernel exports added; zero host imports added.**
The SDL_wpkvideo backend is a sysroot patch over plan 7's SDL2
source — it does not introduce new kernel surface; it routes
SDL2's existing video-backend abstraction through libwpkclient
+ libgbm instead of through `/dev/dri/card0`.

**Consistency with plans 2 + 4 + 5 + 6 + 7 + 8 + 9 + 10:**

- **No new kernel exports.** All app surface is userspace C
  over the plans 2 + 6 + 7 + 8 + 9 + 10 existing surfaces.
- **Plan 2 + plan 3 GL stack follow-ups are required for PR
  #2.** wpkcube depends on `gbm_surface_create` + `EGL_KHR_*`
  extensions + `libgbm` exporter via `gbm_bo_export`. These
  land in the plan 2 + 3 follow-up PRs (open at the start of
  the implementation sequence per handoff-10).
- **Plan 6 + plan 7 audio resolution (b) is required for
  PR #3.** wpkbeep uses non-blocking `WRITEI` + EAGAIN polling.
  Plan 6 ships the EAGAIN-return arm as the cross-plan
  amendment.
- **Plan 7's `SDL_wpkvideo` backend replaces plan 7's KMSDRM
  backend at link time.** Plan 7's KMSDRM demo (PR #2)
  continues to exist as the direct-KMS path; wpkcube is the
  compositor-mediated path. They build to two different
  static archives (`libSDL2.a` for KMSDRM; `libSDL2_wpkvideo.a`
  for compositor-client). Demos link whichever they want;
  cannot link both.
- **Plan 8's libwpkdraw is the rendering substrate.**
  libwpkdraw_widgets is a thin wrapper; all primitives
  (`wpk_rect`, `wpk_text`, `wpk_blit`) come from plan 8.
- **Plan 9's compositor is the surface broker for all four
  apps.** wpkfm, wpkcube, wpkbeep, wpkpanel are all compositor
  clients. None take KMS master. Direct-KMS fall-back is NOT
  used for any seed app.
- **Plan 10's libwpkterm is NOT a seed-app dependency.** None
  of the four apps embed a terminal. wpkshell is its own
  thing.
- **Plan 9 inline fix #2 (stride plumbing) MUST land for all
  four apps.** Without the wire-format `stride` field, every
  client surface allocated with non-`width*4` stride
  (page-aligned strides on x86 / wasm32 gbm) renders garbled.
  Plan 10's cross-plan amendment to plan 9 already captures
  this.

**Stack base:** Plan 10's PR #3 tip (`…-wpkshell-demo`). The
seed apps need everything plans 2–10 ship plus the GL stack
follow-ups.

**Branch:** `emdash/explore-direct-rendering-infrastructure-wpk-seed-apps-plan-XXXXX`
(chains off plan 10's tip per the branching rule). Four
sub-branches stack off it for the four PRs.

**Final PR base:** Plan 10's `…-wpkshell-demo` tip. **Do not
merge** until Brandon validates the design, plans 2-10 have
merged, and PR #4's manual browser verification confirms all
four apps boot to a recognisable desktop: wpkpanel renders
across the top, wpkshell prompt visible below, wpkfm browsable,
wpkbeep beeps on click, wpkcube spins.

**Four PRs, coordinated merge.** PR titles use Brandon's
`scope(area): action` shape:

1. `examples(wpk): wpkfm — file manager + libwpkdraw_widgets`
2. `sysroot(sdl2-wpkvideo): SDL2 wpkvideo video backend + wpkcube demo`
3. `examples(wpk): wpkbeep — 1-button compositor-client audio demo`
4. `examples(wpk): wpkpanel — 24-px panel widget bar as PID 4`

PR base/head topology (stacked):

```
… (plans 2–10 tips + plans 2/3 GL stack follow-ups + plan 10 demo)
 └── …-wpkshell-demo                              (plan 10 PR #3 tip)
      └── …-wpk-seed-apps-plan-XXXXX              (this plan PR base)
           └── …-wpk-wpkfm                        (PR #1)
                └── …-wpk-sdl-wpkvideo            (PR #2)
                     └── …-wpk-wpkbeep            (PR #3)
                          └── …-wpk-wpkpanel      (PR #4)
```

**Verification gauntlet** (CLAUDE.md): all of the below must pass
with zero regressions before any PR is opened, and re-run before
final merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` acceptable; `FAIL` that isn't pre-existing is a
regression. PR #4 adds manual `./run.sh browser` verification
(CLAUDE.md item 6) — the compositor boots, wpkpanel paints the
top 24 px, a clock ticks; wpkshell prompt visible below the
panel; user launches `wpkfm`, sees a tree view of /, double-
clicks `etc` and descends; user launches `wpkbeep`, clicks the
button, hears a 1 s beep + sees the red→green indicator; user
launches `wpkcube`, sees a spinning GLES2 cube in a 320×240
window over the desktop; user closes each in turn via the
compositor's window-close.

**ABI impact:** **None.** Plan 11 adds zero kernel exports,
zero host imports, zero new ioctls, zero new device nodes.
Every byte crosses the kernel-userland ABI via existing
surfaces from plans 2 + 6 + plan-6-sockets + plan 9. The new
SDL2 video backend is a sysroot-side patch that re-routes
SDL2's existing surface-allocation abstraction through
libwpkclient + libgbm. `ABI_VERSION` does not bump;
`abi/snapshot.json` is byte-identical.

The sysroot grows: `sysroot/lib/libwpkdraw_widgets.a` (~50 KB),
`sysroot/lib/libSDL2_wpkvideo.a` (~1.2 MB, separate archive
from plan 7's `libSDL2.a`), `sysroot/include/wpkdraw/widgets.h`,
the four binaries at `/usr/bin/wpkfm` (~280 KB),
`/usr/bin/wpkcube` (~1.5 MB statically linked SDL2 + GL),
`/usr/bin/wpkbeep` (~200 KB), `/usr/bin/wpkpanel` (~220 KB).
Package index ledger gets one new entry (sdl2-wpkvideo); the
four programs land under `binaries/programs/<arch>/`.

Existing kernel + host + ABI surfaces — all unchanged.

---

## Pre-implementation review

Devil's-advocate pass run during session 12 (next session after
plan 11's session-11 draft). Cross-referenced against plans 2 +
3 + 6 + 7 + 8 + 9 + 10 + design doc. Findings fold conceptually
per Brandon convention; plan body (Phase A through Phase E)
retains its pre-review text and gets the fixes applied at
implementation time. Mirrors plans 6/7/8/9/10's review structure.

### Inline fixes (15 — folded conceptually; plan body unchanged)

1. **wpkfm preview pane chokes on embedded NUL bytes.** B2 line
   624–636 reads the file into `buf`, NUL-terminates at
   `buf[n]`, then walks `strchr(p, '\n')`. Binary files (ELF /
   PNG / gzip / any file with an embedded `\0`) cut the string
   short and the preview shows nothing past the first NUL. Fix:
   before `strchr`, sanitize embedded NULs to `.` (or sniff
   magic bytes and refuse non-text). Fold into B2.
2. **wpkfm `MAX_ROWS = 64` truncation status text misleading.**
   B1 line 580 caps `n_rows` at 64; B2 line 647's status string
   reports `"%s — %d entries"` using `st.n_rows`, so `/usr/bin`
   (200+ entries) renders "64 entries". Risk register #3
   acknowledges the cap but the status line is actively wrong.
   Fix: append `(truncated)` sentinel when `n_rows == MAX_ROWS`.
   Fold into B2.
3. **wpkfm double-click descend fires twice.** B3 line 705–707
   (`handle_click` recursively calls `handle_key(0xff0d)` on
   already-selected dir) AND B4 line 750–755 (main-loop timing
   check separately calls `handle_key(0xff0d)`). A double-click
   on a not-yet-selected directory row: first click sets
   selection + descends via `handle_click`, second click within
   400 ms re-descends via timing path. Pick one path. Lean:
   remove the recursive descend from `handle_click`; keep
   timing-window detection in main loop. Fold into B3 + B4.
4. **wpkfm path-building snprintf truncation unchecked.** B3
   line 678 builds `next[1280]` via `snprintf(next, sizeof next,
   "%s%s%s", cwd, "/", name)`. On deep nesting (cwd already
   1200 bytes), snprintf truncates silently and `cwd` accumulates
   a corrupted path. Fix: check `snprintf` return; refuse descend
   if `(size_t)ret >= sizeof next`. Fold into B3.
5. **wpkfm doesn't error-check `wpk_surface_create` /
   `wpk_font_load_default` / `wpk_client_create_surface`.** B4
   lines 728–729. NULL return → render NULL-deref. Fix: check
   each; return 1 with `fprintf(stderr, ...)`. Same hygiene
   needed in wpkbeep + wpkpanel mains. Fold into B4 + D3 + E2.
6. **wpkfm `last_click_ms = 0` initial value false-positives.**
   B4 line 730 + 748–757. `int now_ms = (int)(ev[i].timestamp_us
   / 1000);` truncates to 32-bit signed; for any timestamp past
   ~24 days uptime, `now_ms` wraps negative and the timing
   comparison fires spuriously. Plan 9 also doesn't ship
   `timestamp_us` on events (see Architecture #2). Lean: drop
   `ev.timestamp_us`, use `clock_gettime(CLOCK_MONOTONIC, ...)`
   client-side (plan 10 parity); initialize `last_click_ns` to
   `INT64_MIN/2`. Fold into B4.
7. **wpkpanel's `usleep` blocks unconditionally; focus events
   delivered mid-sleep delayed up to 60 s.** E2 line 1229
   computes `usleep(60_000_000 - tm.tm_sec * 1_000_000)`. While
   sleeping, libwpkclient's recv buffer accumulates events;
   the panel only wakes at the top of the next minute. Plan
   11's own task header says "0.1 Hz redraw + focus events"
   — fix: `poll(2)` on the compositor fd with a timeout = ms
   until next minute, so focus events wake the loop. Requires
   `wpk_client_get_fd` (already amended into plan 9 via plan
   10's cross-amendment, so no new plan-9 surface needed).
   Fold into E2.
8. **wpkpanel `usleep` overflow on `tm.tm_sec == 60` (leap
   second).** Same line 1229. `60_000_000 - 60 * 1_000_000
   == 0` (fine), but `61 * 1_000_000` (some platforms'
   leap-second representation) underflows the unsigned
   `useconds_t`. Edge case; fixed incidentally by the `poll(2)`
   rewrite in #7. Fold comment into E2.
9. **wpkpanel `screen_w` initial value 1024 is unsupported.**
   E1 line 1167 hardcodes 1024. Plan 9 doesn't broadcast an
   output INIT event with screen dimensions, and plan 8's
   `wpk_surface_create(&w, &h)` semantics on whether
   compositor-negotiated values overwrite the in/out pointer
   are not pinned. wpkpanel needs the actual screen width to
   right-align the clock. Lean: pass `&sw, &sh` with `sw = 0,
   sh = 24` as "compositor picks width"; plan 9 amendment
   documents the convention. See LOAD-BEARING item #3 (this
   collapses there). Fold into E1 + E2.
10. **wpkbeep's HW_PARAMS sketch is incomplete.** D1 lines
    1031–1034 ship `struct snd_pcm_hw_params hw = { 0 };
    ioctl(fd, SNDRV_PCM_IOCTL_HW_PARAMS, &hw); ioctl(fd,
    SNDRV_PCM_IOCTL_PREPARE);`. Plan 6 task A4 / A5 require
    `SNDRV_PCM_IOCTL_HW_REFINE` first, then a populated
    `hw_params` (rate=44100, channels=2, format=S16_LE,
    period_size=1024, buffer_size=4096) — zero-init passes
    through refine but doesn't configure the stream. Fold into
    D1: spell out the full refine → params → sw_params →
    prepare sequence (estimated +40 LoC).
11. **wpkbeep doesn't re-PREPARE between clicks.** D3 line
    1113 calls `play_blocking(pcm_fd)` synchronously. After
    playback, the stream transitions PREPARED → RUNNING →
    DRAINING → SETUP per plan 6's PCM state machine. Second
    click writes into a SETUP-state fd; plan 6 v1 may or may
    not auto-rearm. Safe fix: call `ioctl(pcm_fd,
    SNDRV_PCM_IOCTL_PREPARE)` after each `play_blocking`
    returns. Cross-plan note to plan 6 (see below) asks for
    a definitive answer. Fold into D3.
12. **wpkbeep's `play_blocking` can infinite-loop on
    `xfer.result == 0`.** D2 line 1052 — `if (r >= 0) { int n
    = (int)xfer.result; p += n*2; remaining -= n; }`. Kernel
    may legitimately return `r = 0` with `xfer.result = 0`
    (no progress reported); the loop doesn't advance and
    doesn't `poll(POLLOUT)`. Fix: treat `r >= 0 && result == 0`
    as equivalent to EAGAIN (drop into the poll branch). Fold
    into D2.
13. **SDL_wpkvideo doesn't check `open("/dev/dri/card0")` /
    `gbm_create_device` / `eglInitialize` returns.** C1 lines
    832–835. Cascade of -1 / NULL / EGL_NO_DISPLAY may pass
    silently; `eglInitialize` failure leaves `d->egl_display`
    invalid. Fix: check each; `SDL_SetError` + return -1.
    Fold into C1.
14. **SDL_wpkvideo `WPK_GL_SwapWindow` doesn't handle
    `gbm_surface_lock_front_buffer` NULL.** C1 line 864 —
    first frame before any draw, or lock failure, returns
    NULL. `gbm_bo_get_fd(NULL)` is UB. Fix: NULL-check the
    return; bail silently (skip this swap). Fold into C1.
15. **wpkfm preview line-wrap doesn't handle `\r\n`.** B2
    lines 628–640 wraps on `\n` only. Files with CRLF line
    endings (rare in wasm32 sysroot but possible) render with
    visible `\r` glyphs. Fix: also strip trailing `\r` before
    rendering each line. Minor; fold into B2 as a comment.

### Correctness — open (lean documented)

- **wpkfm `stat(path, &sb)` syscall storm on rescan.** B1 line
  578 calls `stat` once per entry on every rescan; 64 entries =
  64 syscalls per Up/Down/Enter/BS keypress. Acceptable for v1
  envelope (the rescan only fires on directory change, not on
  selection movement). Lean: accept; document the syscall cost.
- **libwpkdraw_widgets primitives use fixed font metrics**
  (12 px DejaVu Sans). All four apps render at the same size
  for simplicity. v2 with theming. Lean: accept.
- **wpkbeep blocks the UI for 1 s during playback** (risk
  register #4). Single-threaded; the synthesized 1 s tone runs
  inline. Plan 7 defers worker-thread support, so wpkbeep
  matches by blocking. Lean: accept; v2 with worker threads.
- **wpkpanel renders only on minute boundary or focus event.**
  No seconds-clock, no live system stats. Lean: accept;
  battery-friendly.

### Architecture — open (LOAD-BEARING flag)

1. **(LOAD-BEARING) `wpk_font_height_px` / `wpk_font_ascent_px`
   missing from plan 8's public API.** Plan 11's
   `libwpkdraw_widgets` primitives (widgets.c lines 449, 451,
   458, 462, 470) call both. Plan 8's finalized §A2 public API
   (plan 8 lines 873–900) exports only `wpk_font_load_default`,
   `wpk_font_destroy`, `wpk_text`, `wpk_text_width`. The two
   accessors appear only as a proposed addition in plan 8's
   devil's-advocate pass (plan 8 lines 335–337). Resolution:
   cross-plan amendment to plan 8 (see below) exports both as
   one-line accessors over `wpk_font`'s internal stb_truetype
   metrics. Without this, plan 11 PR #1 cannot compile.
2. **(LOAD-BEARING) `WPK_CLIENT_FOCUS_CHANGED` wire type +
   event-union extension.** Plan 11 task E2 lines 1218–1222
   read `ev[i].focus.title` (~64 chars). Plan 9's event union
   (plan 9 lines 1437–1451) holds only `{ uint32_t surface_id
   }` for focus events (`FOCUS_IN`, `FOCUS_OUT`). Plan 11
   needs a new variant `WPK_CLIENT_FOCUS_CHANGED` carrying a
   string title. Resolution: cross-plan amendment to plan 9
   (see below) allocates one of plan 9's `_RESERVED_FOR_V2_*`
   slots to this event and extends the union with a
   `struct { uint32_t surface_id; char title[64]; } focus;`
   arm. 24-message cap is NOT bumped (one reserved slot
   consumed). The compositor's D4 focus-dispatch (plan 9 lines
   1864–1895) broadcasts unconditionally to all connected
   clients; subscribers like wpkpanel act on it, others drop
   it in their poll loop.
3. **(LOAD-BEARING) Compositor `place_window` reservation
   target + panel-surface special case + `w == 0` fullscreen
   negotiation.** Plan 11 task E4 (line 1264) says "Modify
   (cross-plan to plan 9): compositor's window placement
   algorithm reserves the top `PANEL_RESERVED_PX = 24` of the
   output." Plan 9 v1 has NO explicit `place_window` helper —
   placement is a hardcoded cascade (plan 9 lines 2248–2250:
   "(50, 50), (250, 200), …"). Plan 11 E4 doesn't pin the
   target task in plan 9. Resolution: cross-plan amendment to
   plan 9 (see below) extracts `place_window` as an explicit
   function in plan 9's D6 placement block, adds a
   `WPK_SURFACE_TYPE_PANEL` exemption so wpkpanel itself
   places at `(0, 0)`, and additionally treats surfaces created
   with `w == 0` as fullscreen-width (resolves wpkpanel's
   `screen_w` heuristic from inline fix #9 in the same patch).
   Requires a small companion API:
   `wpk_client_set_surface_type(cl, surface_id, type)` over
   plan 9's existing `SET_TYPE` wire message. The two pieces
   collapse into one cross-plan amendment.

### Missing tests (15)

1. wpkfm renders a binary file in cwd without preview crash
   (`/usr/bin/wpkshell` ELF preview).
2. wpkfm with a directory containing > MAX_ROWS entries renders
   the `(truncated)` suffix in the status bar.
3. wpkfm double-click on a directory row descends exactly once
   (regression guard for inline fix #3).
4. wpkfm first click after process start is treated as a
   single-click, not a double-click (regression guard for
   inline fix #6).
5. wpkfm path-building refuses descend when the target path
   would be `>= sizeof next` (regression guard for inline fix
   #4).
6. wpkfm exit on ESC + `WPK_CLIENT_WINDOW_CLOSE` cleans up
   the compositor connection.
7. wpkpanel renders the clock immediately at startup (not
   blocked on the first minute boundary).
8. wpkpanel renders an updated focus-app name within 200 ms
   of `WPK_CLIENT_FOCUS_CHANGED` delivery (regression guard
   for inline fix #7's poll-based main loop).
9. wpkpanel's right-aligned clock uses the negotiated screen
   width (post-amendment).
10. wpkbeep second click after first plays a beep (regression
    guard for inline fix #11 — re-PREPARE works).
11. wpkbeep `play_blocking` advances on `xfer.result == 0`
    legitimately or polls (regression guard for inline fix
    #12).
12. wpkbeep HW_PARAMS sequence (REFINE → PARAMS → sw_params
    → PREPARE) succeeds against plan 6's PCM device.
13. SDL_wpkvideo `VideoInit` returns SDL error on
    `/dev/dri/card0` open failure (regression guard for
    inline fix #13).
14. SDL_wpkvideo `WPK_GL_SwapWindow` skips silently on
    `gbm_surface_lock_front_buffer == NULL` (regression guard
    for inline fix #14).
15. Init's E3 amendment doesn't break plan 10's shell-spawn
    smoke (wpkshell still spawns; wpkpanel additionally
    spawns when `/etc/wpk/compositor` is present).

### Trade-offs verified

- 3 widget primitives only (button / row / status); no real
  widget framework (deferred to v2 libwpkui).
- wpkfm is viewer-only (no rename / copy / delete).
- `libSDL2_wpkvideo.a` separate archive (mutually exclusive
  with `libSDL2.a` KMSDRM at link time).
- GLES2 only in wpkcube (no GLES3 / Vulkan).
- wpkbeep blocks UI for 1 s during playback (single-threaded;
  matches plan 7's deferred worker-thread decision).
- wpkpanel updates at minute cadence (no seconds clock, no
  live stats).
- Panel reserves top 24 px globally (no `set_strut` protocol).
- wpkfm preview is text-only.
- All four apps as separate processes; no in-process
  multi-window.
- Init gated on `/etc/wpk/compositor` marker file (plan 10 B1
  parity; absence = WordPress demo path, plan 11 doesn't
  contribute to init's exec chain).
- 5 simultaneous client connections (panel + shell + fm +
  beep + cube) under plan 9's `MAX_CLIENTS = 16` (5 ≪ 16,
  per plan 9 line 425). One client = one process connection
  (not one surface); apps owning multiple surfaces share a
  single connection.
- wpkfm `MAX_ROWS = 64` cap — accepted with status-bar
  truncation indicator (inline fix #2 makes it user-visible).
- DRM_FORMAT_ARGB8888 (`0x34325241`) format constant verified
  against plan 9 line 1639 + plan 11 line 847.
- libwpkclient socket `SOCK_CLOEXEC` covered by plan 10's
  cross-plan amendment to plan 9 (plan 9 lines 940–945); plan
  11 apps inherit clean fds without needing their own.
- `WPK_CLIENT_WINDOW_CLOSE` event shipped by plan 9 (plan 9
  line 1443) — all four apps handle it.
- `wpk_client_get_fd` accessor (needed by inline fix #7's
  panel poll loop) already added to plan 9 via plan 10's
  cross-plan amendment (plan 9 lines 935–945) — no new plan-9
  surface introduced by plan 11 for this.

### Deliberately not flagged

- libwpkdraw_widgets scope discipline (3 primitives) — adding
  a fourth (text input, checkbox, etc.) is a slippery slope;
  v1 holds the line.
- wpkbeep's 1-second tone duration — demo-appropriate;
  arbitrary length is v2.
- wpkcube's GLES2-only scope — plan 12 if upstream drivers
  expand.
- SDL2 patch maintenance discipline — additive only (new files
  under `src/video/wpkvideo/` + one-line `bootstrap[]`
  registration in `SDL_video.c`); no churn in core SDL2
  files, per plan 11 task C1 contract.
- wpkfm hit-test linear scan — n ≤ 64 rows, O(n) is fine.
- wpkpanel battery cost — minute cadence + plan 9 fix #8's
  PAGE_FLIP throttle = 1440 commits/day. Fine.
- wpkfm surface-relative pointer coordinates — plan 9 D4 line
  1880 delivers surface-local x/y. ✓
- wpkbeep audio outside SDL2's audio thread — plan 7
  audio-thread (b) resolution is the pattern; non-blocking
  WRITEI + EAGAIN poll lifts directly. ✓
- Init's exec order (compositor → wpkshell → wpkpanel) —
  serialized; plan 10 B1's wait-for-`/run/wpk/comp` covers
  both subsequent execs (compositor binds once, both clients
  connect post-bind). ✓
- All four apps' format = DRM_FORMAT_ARGB8888 — matches plan
  9's expectation; no format negotiation needed.
- 5-surface simultaneous-count under MAX_CLIENTS = 16 — risk
  register #9 captures this; well under the cap.

### Cross-plan amendments (added to plans 6 + 8 + 9 reviews)

Three amendments leak back to ancestor plans:

1. **Plan 8 — export `wpk_font_height_px` +
   `wpk_font_ascent_px` in §A2 public API.** Trivial one-line
   accessors over plan 8's internal stb_truetype metrics.
   LOAD-BEARING (resolves Architecture #1).
2. **Plan 9 — allocate `WPK_CLIENT_FOCUS_CHANGED` from
   `_RESERVED_FOR_V2_*` slot + extend event union with
   `focus.title[64]`.** Compositor broadcasts on focus change
   to all connected clients. 24-message cap not bumped.
   LOAD-BEARING (resolves Architecture #2).
3. **Plan 9 — extract `place_window` as an explicit function
   + `WPK_SURFACE_TYPE_PANEL` exemption + `w == 0`
   fullscreen-width negotiation + companion
   `wpk_client_set_surface_type` API.** Plan 9 D6 placement
   block becomes the amendment target. Single amendment
   resolves both Architecture #3 (placement reservation) and
   inline fix #9 (panel screen-size discovery).
   LOAD-BEARING.
4. **Plan 6 — confirm two-shot playback works without
   re-PREPARE OR document the rearm requirement.** wpkbeep
   click → play → click again pattern hits the PCM state
   machine. Plan 11 D3 calls `SNDRV_PCM_IOCTL_PREPARE`
   between plays defensively; plan 6 amendment confirms
   whether the defensive call is necessary or noise.
   Non-LOAD-BEARING (wpkbeep works either way).

Plans 2, 3, 7, 10 unchanged — plan 11's dependencies on those
four are clean per the consistency check:

- **Plan 2:** gbm_bo_get_fd / get_stride / import / surface_*
  APIs all match plan 11's calls; the gbm_surface follow-up
  is documented in plan 2's existing cross-plan amendment
  from plan 7's review (plan 2 lines 227–340), blocking plan
  11 PR #2 in dependency order.
- **Plan 3:** `eglGetDisplay(gbm_device)` +
  `eglCreateWindowSurface(gbm_surface)` signatures match plan
  11 C1 exactly (plan 3 lines 453–472); libEGL/libGLESv2 stub
  follow-ups (plan 3 lines 428–445) gate plan 11 PR #2 the
  same way they gate plan 7 PR #2.
- **Plan 7:** SDL2 KMSDRM-backend file layout under
  `src/video/kmsdrm/` parallels plan 11's wpkvideo addition
  under `src/video/wpkvideo/`; audio-thread (b) resolution
  (non-blocking WRITEI + EAGAIN poll) pattern lifted verbatim
  by wpkbeep (plan 7 lines 560–577 ↔ plan 11 D2).
- **Plan 10:** init gate path `/etc/wpk/compositor` matches
  plan 11 task E3; SIGPIPE handling in `main()` pattern
  matches (plan 10 inline fix #4 ↔ plan 11 lines 721, 1081,
  1196); init reap-loop covers the panel zombie via existing
  `waitpid(-1)`; SOCK_CLOEXEC on libwpkclient sockets already
  covered by plan 10's cross-plan amendment to plan 9 — plan
  11 apps inherit clean fds without their own CLOEXEC.

---

## Phase A — sysroot: libwpkdraw_widgets (folded into PR #1)

The shared widget primitives. Ships as the first three commits
of PR #1, ahead of wpkfm itself.

### Task A1: Package scaffold

**Files:**
- Create: `examples/libs/libwpkdraw_widgets/package.toml` — recipe.
- Create: `examples/libs/libwpkdraw_widgets/build.toml` — build state.
- Create: `examples/libs/libwpkdraw_widgets/build.sh` — build script.

```toml
# examples/libs/libwpkdraw_widgets/package.toml
name = "libwpkdraw_widgets"
version = "0.1.0"
license = "MIT"
description = "Thin widget primitives over libwpkdraw — button, row, status bar"

[source]
type = "local"

[deps]
libwpkdraw = "0.1.0"

[build]
script_path = "build.sh"
```

```toml
# examples/libs/libwpkdraw_widgets/build.toml
script_path = "build.sh"
revision = 1

[binary]
index_url = "https://github.com/<repo>/releases/download/binaries-abi-v{abi}/index.toml"
```

```bash
#!/usr/bin/env bash
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

SRC_DIR="$1"
OUT_DIR="$2"
mkdir -p "$OUT_DIR/lib" "$OUT_DIR/include/wpkdraw"

cd "$SRC_DIR/src"
wasm32posix-cc -c -O2 \
    -I"$SRC_DIR/include" \
    -I"$WPK_SYSROOT/include" \
    widgets.c
llvm-ar rcs "$OUT_DIR/lib/libwpkdraw_widgets.a" *.o
cp "$SRC_DIR/include/wpkdraw/widgets.h" "$OUT_DIR/include/wpkdraw/"
```

**Commit:** `sysroot(wpk-widgets): scaffold libwpkdraw_widgets package`

### Task A2: Public header + three primitives

**Files:**
- Create: `examples/libs/libwpkdraw_widgets/include/wpkdraw/widgets.h`
- Create: `examples/libs/libwpkdraw_widgets/src/widgets.c`

```c
// include/wpkdraw/widgets.h
#ifndef WPKDRAW_WIDGETS_H
#define WPKDRAW_WIDGETS_H

#include <stdint.h>

struct wpk_surface;
struct wpk_font;

/** Button — outlined rect + centred label. Press state = darker fill. */
void wpkw_button(struct wpk_surface *s, struct wpk_font *f,
                 int x, int y, int w, int h,
                 const char *label, int pressed);

/** Row — full-width strip with left-aligned label. Selected =
 *  highlighted background (blue) + white text. */
void wpkw_row(struct wpk_surface *s, struct wpk_font *f,
              int x, int y, int w,
              const char *label, int selected);

/** Status bar — full-width strip at the bottom; right-aligned text. */
void wpkw_status(struct wpk_surface *s, struct wpk_font *f,
                 int x, int y, int w,
                 const char *text);

#endif /* WPKDRAW_WIDGETS_H */
```

```c
// src/widgets.c
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/widgets.h>
#include <string.h>

void wpkw_button(struct wpk_surface *s, struct wpk_font *f,
                 int x, int y, int w, int h,
                 const char *label, int pressed) {
    /* Outline + fill. */
    uint32_t fill = pressed ? WPK_RGB(70, 90, 130) : WPK_RGB(90, 110, 160);
    wpk_rect(s, x, y, w, h, fill);
    wpk_rect(s, x, y, w, 1, WPK_RGB(160, 160, 200));            /* top border */
    wpk_rect(s, x, y + h - 1, w, 1, WPK_RGB(40, 40, 60));       /* bottom border */
    /* Centred label. */
    int tw = wpk_text_width(f, label);
    int th = wpk_font_height_px(f);
    int tx = x + (w - tw) / 2;
    int ty = y + (h - th) / 2 + wpk_font_ascent_px(f);
    wpk_text(s, f, tx, ty, label, WPK_RGB(240, 240, 250));
}

void wpkw_row(struct wpk_surface *s, struct wpk_font *f,
              int x, int y, int w,
              const char *label, int selected) {
    int h = wpk_font_height_px(f) + 4;
    if (selected) {
        wpk_rect(s, x, y, w, h, WPK_RGB(50, 90, 170));
    }
    int ty = y + 2 + wpk_font_ascent_px(f);
    wpk_text(s, f, x + 4, ty, label,
             selected ? WPK_RGB(240, 240, 250) : WPK_RGB(200, 200, 210));
}

void wpkw_status(struct wpk_surface *s, struct wpk_font *f,
                 int x, int y, int w,
                 const char *text) {
    int h = wpk_font_height_px(f) + 4;
    wpk_rect(s, x, y, w, h, WPK_RGB(30, 30, 40));
    int tw = wpk_text_width(f, text);
    int ty = y + 2 + wpk_font_ascent_px(f);
    wpk_text(s, f, x + w - tw - 6, ty, text, WPK_RGB(200, 200, 210));
}
```

**Cargo test:** render each primitive into a 320×80 surface;
assert non-zero pixels in the expected regions (button outline +
centre text; row left-aligned text; status right-aligned text).

**Commit:** `sysroot(wpk-widgets): button + row + status primitives`

### Task A3: Smoke program

```c
// programs/widgets_smoke.c
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/widgets.h>
#include <stdio.h>

int main(void) {
    int w = 320, h = 120;
    struct wpk_surface *s = wpk_surface_create(&w, &h);
    if (!s) { perror("wpk_surface_create"); return 1; }
    struct wpk_font *f = wpk_font_load_default(12);
    wpk_surface_clear(s, WPK_RGB(20, 20, 25));
    wpkw_button(s, f, 10, 10, 100, 30, "Click", 0);
    wpkw_button(s, f, 120, 10, 100, 30, "Pressed", 1);
    wpkw_row(s, f, 0, 50, 320, "row 1", 0);
    wpkw_row(s, f, 0, 70, 320, "row 2 (selected)", 1);
    wpkw_status(s, f, 0, 100, 320, "ready");
    wpk_surface_present(s);
    wpk_font_destroy(f);
    wpk_surface_destroy(s);
    return 0;
}
```

**Vitest:** spawn the smoke + verify exit 0. Visual verification
in PR #4's browser walk-through.

**Commit:** `examples(wpk-widgets): widgets_smoke — button + row + status`

---

## Phase B — wpkfm (file manager, rest of PR #1)

A two-pane file manager: directory tree on left, preview on right.

### Task B1: Program scaffold + main loop

**Files:**
- Create: `examples/programs/wpkfm/main.c` — top-level loop.
- Create: `examples/programs/wpkfm/Makefile`.

```c
// main.c
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <wpkclient/wpkclient.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/widgets.h>

#define SURFACE_W 720
#define SURFACE_H 480
#define ROW_H     16     /* matches wpkw_row internal height for 12 px font */
#define MAX_ROWS  64

struct row {
    char name[256];
    int is_dir;
};

static struct {
    char cwd[1024];
    struct row rows[MAX_ROWS];
    int n_rows;
    int selected;          /* index into rows[] */
    int scroll_top;        /* first visible row */
} st;

static void rescan(void) {
    st.n_rows = 0;
    DIR *d = opendir(st.cwd);
    if (!d) return;
    struct dirent *e;
    /* Always include ".." unless at root. */
    if (strcmp(st.cwd, "/") != 0 && st.n_rows < MAX_ROWS) {
        strncpy(st.rows[st.n_rows].name, "..", sizeof st.rows[0].name);
        st.rows[st.n_rows].is_dir = 1;
        st.n_rows++;
    }
    while ((e = readdir(d)) && st.n_rows < MAX_ROWS) {
        if (e->d_name[0] == '.') continue;       /* hide dotfiles */
        char path[1280];
        snprintf(path, sizeof path, "%s/%s", st.cwd, e->d_name);
        struct stat sb;
        int is_dir = stat(path, &sb) == 0 && S_ISDIR(sb.st_mode);
        strncpy(st.rows[st.n_rows].name, e->d_name,
                sizeof st.rows[0].name - 1);
        st.rows[st.n_rows].name[sizeof st.rows[0].name - 1] = 0;
        st.rows[st.n_rows].is_dir = is_dir;
        st.n_rows++;
    }
    closedir(d);
    st.selected = 0;
    st.scroll_top = 0;
}
```

(continues in B2…)

**Commit:** `examples(wpkfm): scaffold main.c — compositor client + dir scan`

### Task B2: Render path (tree + preview)

```c
// main.c (continued)
static void render(struct wpk_surface *s, struct wpk_font *f) {
    wpk_surface_clear(s, WPK_RGB(20, 20, 25));
    /* Left pane: directory tree. */
    int pane_w = SURFACE_W / 2;
    int y = 4;
    for (int i = st.scroll_top;
         i < st.n_rows && y < SURFACE_H - 20;
         i++, y += ROW_H) {
        char label[280];
        snprintf(label, sizeof label, "%s%s",
                 st.rows[i].is_dir ? "[DIR] " : "      ",
                 st.rows[i].name);
        wpkw_row(s, f, 0, y, pane_w, label, i == st.selected);
    }
    /* Right pane: preview. */
    int preview_x = pane_w + 4;
    int preview_w = SURFACE_W - preview_x - 4;
    if (st.selected >= 0 && st.selected < st.n_rows &&
        !st.rows[st.selected].is_dir) {
        char path[1280];
        snprintf(path, sizeof path, "%s/%s", st.cwd,
                 st.rows[st.selected].name);
        int fd = open(path, O_RDONLY);
        if (fd >= 0) {
            char buf[4096];
            ssize_t n = read(fd, buf, sizeof buf - 1);
            if (n > 0) {
                buf[n] = 0;
                /* Line-wrap by '\n' only; very crude. */
                int yy = 4;
                char *p = buf;
                while (*p && yy < SURFACE_H - 20) {
                    char *nl = strchr(p, '\n');
                    if (nl) *nl = 0;
                    wpk_text(s, f, preview_x, yy + wpk_font_ascent_px(f),
                             p, WPK_RGB(180, 180, 200));
                    if (!nl) break;
                    *nl = '\n';
                    p = nl + 1;
                    yy += ROW_H;
                }
            }
            close(fd);
        }
    }
    /* Status bar. */
    char status[1100];
    snprintf(status, sizeof status, "%s — %d entries", st.cwd, st.n_rows);
    wpkw_status(s, f, 0, SURFACE_H - 18, SURFACE_W, status);
}
```

**Commit:** `examples(wpkfm): render — two-pane tree + preview + status bar`

### Task B3: Input handling — keyboard nav + double-click descend

```c
// main.c (continued)
static int handle_key(uint32_t keysym) {
    switch (keysym) {
    case 0xff52: /* Up    */
        if (st.selected > 0) st.selected--;
        if (st.selected < st.scroll_top) st.scroll_top = st.selected;
        return 1;
    case 0xff54: /* Down  */
        if (st.selected < st.n_rows - 1) st.selected++;
        if (st.selected >= st.scroll_top + (SURFACE_H - 24) / ROW_H)
            st.scroll_top = st.selected - (SURFACE_H - 24) / ROW_H + 1;
        return 1;
    case 0xff0d: /* Enter — descend */
    case 0xff53: /* Right */
        if (st.selected < st.n_rows && st.rows[st.selected].is_dir) {
            if (strcmp(st.rows[st.selected].name, "..") == 0) {
                char *slash = strrchr(st.cwd, '/');
                if (slash && slash != st.cwd) *slash = 0;
                else strcpy(st.cwd, "/");
            } else {
                char next[1280];
                snprintf(next, sizeof next, "%s%s%s", st.cwd,
                         strcmp(st.cwd, "/") == 0 ? "" : "/",
                         st.rows[st.selected].name);
                strncpy(st.cwd, next, sizeof st.cwd - 1);
                st.cwd[sizeof st.cwd - 1] = 0;
            }
            rescan();
        }
        return 1;
    case 0xff08: /* BackSpace — up one */
    case 0xff51: /* Left */
        {
            char *slash = strrchr(st.cwd, '/');
            if (slash && slash != st.cwd) *slash = 0;
            else strcpy(st.cwd, "/");
            rescan();
        }
        return 1;
    case 0xff1b: /* Esc — quit */
        return -1;
    }
    return 0;
}

static int handle_click(int x, int y) {
    if (x >= SURFACE_W / 2) return 0;           /* preview pane */
    int row = st.scroll_top + (y - 4) / ROW_H;
    if (row < 0 || row >= st.n_rows) return 0;
    if (row == st.selected && st.rows[row].is_dir) {
        return handle_key(0xff0d);             /* double-click = Enter */
    }
    st.selected = row;
    return 1;
}
```

**Commit:** `examples(wpkfm): input — keyboard nav (Up/Down/Enter/BS/Esc) + click select`

### Task B4: Main loop + event pump

```c
// main.c (continued)
int main(void) {
    signal(SIGPIPE, SIG_IGN);   /* per plan 10 inline fix #4 */
    strcpy(st.cwd, "/");
    rescan();

    struct wpk_client *cl = wpk_client_connect();
    if (!cl) { fprintf(stderr, "wpkfm: no compositor\n"); return 1; }
    int sw = SURFACE_W, sh = SURFACE_H;
    struct wpk_surface *s = wpk_surface_create(&sw, &sh);
    struct wpk_font *f = wpk_font_load_default(12);
    int quitting = 0, dirty = 1, last_click_row = -1, last_click_ms = 0;

    while (!quitting) {
        if (dirty) {
            render(s, f);
            wpk_surface_present(s);
            dirty = 0;
        }
        struct wpk_client_event ev[16];
        int n = wpk_client_poll(cl, ev, 16);
        for (int i = 0; i < n; i++) {
            if (ev[i].type == WPK_CLIENT_KEY && ev[i].key.pressed) {
                int r = handle_key(ev[i].key.keysym);
                if (r < 0) quitting = 1;
                if (r) dirty = 1;
            } else if (ev[i].type == WPK_CLIENT_POINTER_BUTTON &&
                       ev[i].pointer.pressed && ev[i].pointer.button == 1) {
                /* Double-click within 400 ms. */
                int now_ms = (int)(ev[i].timestamp_us / 1000);
                int x = ev[i].pointer.x, y = ev[i].pointer.y;
                int row = st.scroll_top + (y - 4) / ROW_H;
                if (row == last_click_row && now_ms - last_click_ms < 400) {
                    handle_key(0xff0d);
                } else {
                    handle_click(x, y);
                }
                last_click_row = row;
                last_click_ms = now_ms;
                dirty = 1;
            } else if (ev[i].type == WPK_CLIENT_WINDOW_CLOSE) {
                quitting = 1;
            }
        }
    }
    wpk_font_destroy(f);
    wpk_surface_destroy(s);
    wpk_client_disconnect(cl);
    return 0;
}
```

**Vitest:** spawn compositor + wpkfm; assert the surface renders
`/etc` / `/usr` / `/dev` tokens within 500 ms.

**Commit:** `examples(wpkfm): main loop + event pump + double-click handler`

### Task B5: Phase B — full gauntlet + open PR #1

PR title: `[explore-dri] examples(wpk): wpkfm — file manager + libwpkdraw_widgets`

Body covers: libwpkdraw_widgets (button + row + status), wpkfm
main loop, directory scan + tree render + preview render, keyboard
+ mouse input, double-click descend, status bar with cwd.
ABI impact: none.

---

## Phase C — SDL_wpkvideo backend + wpkcube (PR #2)

The compositor-mediated GL path. Patches plan 7's vendored SDL2
source to add a new video backend that allocates surfaces via
libwpkclient instead of `drmModeSetCrtc`.

### Task C1: SDL2 patch — wpkvideo backend skeleton

**Files:**
- Create: `sysroot/patches/sdl2-wpkvideo/0001-add-wpkvideo-backend.patch`
- The patch adds:
  - `src/video/wpkvideo/SDL_wpkvideo.c` — video driver entry points
    (`VideoInit`, `VideoQuit`, `CreateSDLWindow`, `DestroySDLWindow`,
    `GL_CreateContext`, `GL_SwapWindow`, …).
  - `src/video/wpkvideo/SDL_wpkvideo.h` — driver struct definitions.
  - One-line patch to `src/video/SDL_video.c::bootstrap[]` to
    register the new driver under the name `"wpkvideo"`.

```c
// SDL_wpkvideo.c — skeleton
#include <wpkclient/wpkclient.h>
#include <gbm.h>
#include <EGL/egl.h>
#include "../../SDL_internal.h"
#include "../SDL_sysvideo.h"

typedef struct {
    struct wpk_client *cl;
    struct gbm_device *gbm;
    EGLDisplay egl_display;
} WPK_VideoData;

typedef struct {
    uint32_t surface_id;
    struct gbm_surface *gbm_surf;
    EGLSurface egl_surf;
    struct gbm_bo *current_bo;
    int prime_fd;
} WPK_WindowData;

static int WPK_VideoInit(SDL_VideoDevice *_this) {
    WPK_VideoData *d = (WPK_VideoData *)_this->driverdata;
    d->cl = wpk_client_connect();
    if (!d->cl) return SDL_SetError("wpkvideo: no compositor");
    /* Open /dev/dri/card0 just for gbm + EGL — does NOT take master. */
    int drm_fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    d->gbm = gbm_create_device(drm_fd);
    d->egl_display = eglGetDisplay((EGLNativeDisplayType)d->gbm);
    eglInitialize(d->egl_display, NULL, NULL);
    /* Register one display node (single output, compositor-mediated). */
    SDL_VideoDisplay disp = { 0 };
    SDL_AddVideoDisplay(_this, &disp, SDL_FALSE);
    return 0;
}

static int WPK_CreateSDLWindow(SDL_VideoDevice *_this, SDL_Window *window) {
    WPK_VideoData *vd = (WPK_VideoData *)_this->driverdata;
    WPK_WindowData *wd = SDL_calloc(1, sizeof *wd);
    /* Create compositor surface. */
    wd->surface_id = wpk_client_create_surface(vd->cl,
        window->w, window->h, 0x34325241 /* ARGB8888 */);
    if (!wd->surface_id) { SDL_free(wd); return SDL_SetError("create_surface"); }
    /* Create gbm_surface for double-buffering. */
    wd->gbm_surf = gbm_surface_create(vd->gbm,
        window->w, window->h, GBM_FORMAT_ARGB8888,
        GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
    /* EGL surface bound to gbm_surface. */
    wd->egl_surf = eglCreateWindowSurface(vd->egl_display, /* config */ NULL,
        (EGLNativeWindowType)wd->gbm_surf, NULL);
    window->driverdata = wd;
    return 0;
}

static int WPK_GL_SwapWindow(SDL_VideoDevice *_this, SDL_Window *window) {
    WPK_VideoData *vd = (WPK_VideoData *)_this->driverdata;
    WPK_WindowData *wd = window->driverdata;
    eglSwapBuffers(vd->egl_display, wd->egl_surf);
    struct gbm_bo *next = gbm_surface_lock_front_buffer(wd->gbm_surf);
    if (wd->current_bo) gbm_surface_release_buffer(wd->gbm_surf, wd->current_bo);
    wd->current_bo = next;
    int pfd = gbm_bo_get_fd(next);
    uint32_t stride = gbm_bo_get_stride(next);
    /* NB: plan 9 inline fix #2 + plan 10 cross-amendment — stride parameter. */
    wpk_client_attach_buffer(vd->cl, wd->surface_id, pfd, stride);
    wpk_client_commit(vd->cl, wd->surface_id);
    close(pfd);
    return 0;
}

/* …other driver hooks: WPK_PumpEvents, WPK_VideoQuit, WPK_CreateContext… */
```

**Commit:** `sysroot(sdl2-wpkvideo): scaffold wpkvideo backend (VideoInit + CreateWindow + SwapWindow)`

### Task C2: Input plumbing — libwpkclient events → SDL events

```c
// SDL_wpkvideo.c (continued)
static void WPK_PumpEvents(SDL_VideoDevice *_this) {
    WPK_VideoData *vd = (WPK_VideoData *)_this->driverdata;
    struct wpk_client_event ev[16];
    int n = wpk_client_poll(vd->cl, ev, 16);
    for (int i = 0; i < n; i++) {
        if (ev[i].type == WPK_CLIENT_KEY) {
            SDL_SendKeyboardKey(0, ev[i].key.pressed ? SDL_PRESSED : SDL_RELEASED,
                                wpk_to_sdl_scancode(ev[i].key.keysym));
        } else if (ev[i].type == WPK_CLIENT_POINTER_BUTTON) {
            SDL_SendMouseButton(0, NULL, SDL_DEFAULT_MOUSE_ID,
                ev[i].pointer.pressed ? SDL_PRESSED : SDL_RELEASED,
                ev[i].pointer.button);
        } else if (ev[i].type == WPK_CLIENT_POINTER_MOTION) {
            SDL_SendMouseMotion(0, NULL, SDL_DEFAULT_MOUSE_ID,
                0 /* relative=false */, ev[i].pointer.x, ev[i].pointer.y);
        } else if (ev[i].type == WPK_CLIENT_WINDOW_CLOSE) {
            SDL_SendQuit();
        }
    }
}
```

Plus a `wpk_to_sdl_scancode` helper mapping xkb keysyms → SDL
scancodes (a ~150-entry lookup table; the bulk is straightforward
`XKB_KEY_a → SDL_SCANCODE_A` etc.).

**Commit:** `sysroot(sdl2-wpkvideo): input plumbing — libwpkclient events → SDL events`

### Task C3: Build artifact — `libSDL2_wpkvideo.a`

Build script:
- Mirrors plan 7's SDL2 build but applies the wpkvideo patch
  AND configures `--disable-video-kmsdrm --enable-video-wpkvideo`.
- Output: `libSDL2_wpkvideo.a` (separate archive from
  `libSDL2.a`).
- Linked-in symbols don't conflict because each archive carries
  its own `bootstrap[]` registration; demos link one or the
  other, never both.

**Commit:** `sysroot(sdl2-wpkvideo): build.sh — emit libSDL2_wpkvideo.a static archive`

### Task C4: wpkcube demo — plan 7 cube against wpkvideo

```c
// examples/programs/wpkcube/main.c
#define _GNU_SOURCE
#include <SDL.h>
#include <SDL_opengles2.h>
#include <stdio.h>

int main(int argc, char *argv[]) {
    /* Force wpkvideo backend. */
    SDL_SetHintWithPriority(SDL_HINT_VIDEODRIVER, "wpkvideo",
                            SDL_HINT_OVERRIDE);
    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        fprintf(stderr, "SDL_Init: %s\n", SDL_GetError());
        return 1;
    }
    SDL_Window *w = SDL_CreateWindow("wpkcube", 0, 0, 320, 240,
        SDL_WINDOW_OPENGL | SDL_WINDOW_SHOWN);
    SDL_GLContext gl = SDL_GL_CreateContext(w);
    /* Plan 7's cube render code, lifted verbatim. */
    extern void cube_init(void);
    extern void cube_draw(float t);
    cube_init();
    Uint64 t0 = SDL_GetPerformanceCounter();
    SDL_Event ev;
    int quitting = 0;
    while (!quitting) {
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) quitting = 1;
        }
        double t = (SDL_GetPerformanceCounter() - t0) /
                   (double)SDL_GetPerformanceFrequency();
        cube_draw((float)t);
        SDL_GL_SwapWindow(w);
    }
    SDL_GL_DeleteContext(gl);
    SDL_DestroyWindow(w);
    SDL_Quit();
    return 0;
}
```

**Vitest:** spawn compositor + wpkcube; assert wpkcube's surface
is non-blank within 1 s. (GL rendering correctness is verified
via the manual browser walk-through in PR #4.)

**Commit:** `examples(wpk): wpkcube — GLES2 cube via SDL_wpkvideo backend`

### Task C5: Phase C — full gauntlet + open PR #2

PR title: `[explore-dri] sysroot(sdl2-wpkvideo): SDL2 wpkvideo video backend + wpkcube demo`

Body covers: SDL2 patch (~400 LoC adding wpkvideo backend),
input plumbing (xkb → SDL scancodes), `libSDL2_wpkvideo.a`
separate archive, wpkcube demo replicating plan 7's cube against
the new backend. ABI impact: none. **Note in the PR body:**
plan 7's KMSDRM demo continues to exist and is the direct-KMS
path; wpkcube is the compositor-mediated path. They cannot
coexist in the same process (different SDL2 archives).

---

## Phase D — wpkbeep (audio compositor client, PR #3)

A 1-button audio demo.

### Task D1: Program scaffold

```c
// examples/programs/wpkbeep/main.c
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <wpkclient/wpkclient.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/widgets.h>
#include <sound/asound.h>      /* plan 6 ABI: SNDRV_PCM_IOCTL_* */

#define SR 44100
#define DUR_FRAMES SR          /* 1 second */

static int16_t samples[DUR_FRAMES * 2];   /* stereo, interleaved */

static void synth_sine(void) {
    for (int i = 0; i < DUR_FRAMES; i++) {
        double t = (double)i / SR;
        int16_t v = (int16_t)(sin(2.0 * M_PI * 440.0 * t) * 16000);
        samples[i * 2 + 0] = v;
        samples[i * 2 + 1] = v;
    }
}

static int pcm_open_play(void) {
    int fd = open("/dev/snd/pcmC0D0p", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    /* HW params setup — abbreviated for brevity. */
    struct snd_pcm_hw_params hw = { 0 };
    /* …set rate=44100, channels=2, format=S16_LE, period_size=1024… */
    ioctl(fd, SNDRV_PCM_IOCTL_HW_PARAMS, &hw);
    ioctl(fd, SNDRV_PCM_IOCTL_PREPARE);
    return fd;
}
```

**Commit:** `examples(wpkbeep): scaffold main.c + sine synth + PCM open`

### Task D2: Audio thread (non-blocking + EAGAIN poll)

```c
static int play_blocking(int pcm_fd) {
    int16_t *p = samples;
    int remaining = DUR_FRAMES;
    while (remaining > 0) {
        struct snd_xferi xfer = {
            .buf = p, .frames = remaining, .result = 0,
        };
        int r = ioctl(pcm_fd, SNDRV_PCM_IOCTL_WRITEI_FRAMES, &xfer);
        if (r >= 0) {
            int n = (int)xfer.result;
            p += n * 2;            /* stereo */
            remaining -= n;
        } else if (errno == EAGAIN) {
            /* Plan 6 cross-plan amendment from plan 9's devil's-advocate:
             * non-blocking WRITEI on full ring returns EAGAIN. Poll for
             * POLLOUT (kernel-side queue has space) and retry. */
            struct pollfd pf = { .fd = pcm_fd, .events = POLLOUT };
            poll(&pf, 1, -1);
        } else {
            return -1;
        }
    }
    return 0;
}
```

Plan 7's audio-thread resolution (b) is precisely this pattern:
non-blocking WRITEI + EAGAIN-driven `poll(POLLOUT)`. wpkbeep
exercises it directly without going through SDL2's audio
subsystem.

**Commit:** `examples(wpkbeep): audio writer — non-blocking WRITEI + EAGAIN poll`

### Task D3: Main loop — button + state machine

```c
int main(void) {
    signal(SIGPIPE, SIG_IGN);
    synth_sine();
    struct wpk_client *cl = wpk_client_connect();
    if (!cl) { fprintf(stderr, "wpkbeep: no compositor\n"); return 1; }
    int sw = 200, sh = 100;
    struct wpk_surface *s = wpk_surface_create(&sw, &sh);
    struct wpk_font *f = wpk_font_load_default(12);
    int pcm_fd = pcm_open_play();
    if (pcm_fd < 0) { fprintf(stderr, "wpkbeep: no /dev/snd/pcmC0D0p\n"); return 1; }
    int playing = 0, quitting = 0;
    while (!quitting) {
        wpk_surface_clear(s, WPK_RGB(20, 20, 25));
        /* Indicator light. */
        uint32_t light = playing ? WPK_RGB(220, 80, 80) : WPK_RGB(80, 220, 80);
        wpk_rect(s, 10, 10, 16, 16, light);
        /* Button. */
        wpkw_button(s, f, 40, 10, 100, 30,
                    playing ? "Playing..." : "Beep", playing);
        wpk_surface_present(s);

        struct wpk_client_event ev[16];
        int n = wpk_client_poll(cl, ev, 16);
        for (int i = 0; i < n; i++) {
            if (ev[i].type == WPK_CLIENT_POINTER_BUTTON &&
                ev[i].pointer.pressed && ev[i].pointer.button == 1 &&
                ev[i].pointer.x >= 40 && ev[i].pointer.x < 140 &&
                ev[i].pointer.y >= 10 && ev[i].pointer.y < 40 &&
                !playing) {
                playing = 1;
                /* Synchronous; wpkbeep is single-threaded, the
                 * window won't redraw until done — that's OK for
                 * a 1 s tone. */
                play_blocking(pcm_fd);
                playing = 0;
            } else if (ev[i].type == WPK_CLIENT_WINDOW_CLOSE) {
                quitting = 1;
            }
        }
    }
    close(pcm_fd);
    wpk_font_destroy(f);
    wpk_surface_destroy(s);
    wpk_client_disconnect(cl);
    return 0;
}
```

**Vitest:** spawn compositor + wpkbeep; inject a synthetic
pointer-button event at (90, 25); assert the kernel's
`/dev/snd/pcmC0D0p` consumer receives 1 s of samples.

**Commit:** `examples(wpkbeep): main loop — button + indicator + click-triggered playback`

### Task D4: Phase D — full gauntlet + open PR #3

PR title: `[explore-dri] examples(wpk): wpkbeep — 1-button compositor-client audio demo`

Body covers: compositor wire (single window + single button),
sine synth (precomputed buffer), non-blocking WRITEI + EAGAIN
poll (plan 7 resolution (b) executed directly), red/green
indicator light. ABI impact: none.

---

## Phase E — wpkpanel (PID 4 panel bar, PR #4)

The 24-px-tall top-of-screen strip. Init forks it after PID 3
wpkshell.

### Task E1: Program scaffold

```c
// examples/programs/wpkpanel/main.c
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <wpkclient/wpkclient.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/widgets.h>

#define PANEL_H 24

static int screen_w = 1024;       /* compositor reports this via INIT event */

static void render(struct wpk_surface *s, struct wpk_font *f,
                   const char *focus_app, const struct tm *now) {
    wpk_surface_clear(s, WPK_RGB(30, 30, 40));
    /* Bottom border (separator from window area). */
    wpk_rect(s, 0, PANEL_H - 1, screen_w, 1, WPK_RGB(80, 80, 100));
    /* Left: active app indicator. */
    char left[128];
    snprintf(left, sizeof left, "  %s",
             focus_app && focus_app[0] ? focus_app : "(no focus)");
    wpk_text(s, f, 8, 4 + wpk_font_ascent_px(f), left,
             WPK_RGB(220, 220, 230));
    /* Right: clock. */
    char clock[16];
    snprintf(clock, sizeof clock, "%02d:%02d  ",
             now->tm_hour, now->tm_min);
    int tw = wpk_text_width(f, clock);
    wpk_text(s, f, screen_w - tw - 4, 4 + wpk_font_ascent_px(f), clock,
             WPK_RGB(240, 240, 250));
}
```

**Commit:** `examples(wpkpanel): scaffold main.c + render path (left = focus app, right = clock)`

### Task E2: Main loop — 0.1 Hz redraw + focus events

```c
int main(void) {
    signal(SIGPIPE, SIG_IGN);
    struct wpk_client *cl = wpk_client_connect();
    if (!cl) { fprintf(stderr, "wpkpanel: no compositor\n"); return 1; }
    int sw = screen_w, sh = PANEL_H;
    struct wpk_surface *s = wpk_surface_create(&sw, &sh);
    screen_w = sw;          /* compositor may negotiate */
    struct wpk_font *f = wpk_font_load_default(12);
    char focus_app[64] = "";
    int quitting = 0;
    int last_min = -1;
    while (!quitting) {
        time_t t = time(NULL);
        struct tm tm_;
        localtime_r(&t, &tm_);
        if (tm_.tm_min != last_min) {
            render(s, f, focus_app, &tm_);
            wpk_surface_present(s);
            last_min = tm_.tm_min;
        }
        struct wpk_client_event ev[16];
        int n = wpk_client_poll(cl, ev, 16);
        for (int i = 0; i < n; i++) {
            if (ev[i].type == WPK_CLIENT_FOCUS_CHANGED) {
                /* Plan 9 amendment: compositor broadcasts focus name
                 * to subscribed clients. See Pre-impl review above. */
                strncpy(focus_app, ev[i].focus.title, sizeof focus_app - 1);
                focus_app[sizeof focus_app - 1] = 0;
                last_min = -1;     /* force redraw */
            } else if (ev[i].type == WPK_CLIENT_WINDOW_CLOSE) {
                quitting = 1;
            }
        }
        /* Sleep until top of next minute (or wake on event). */
        usleep(60 * 1000 * 1000 - tm_.tm_sec * 1000 * 1000);
    }
    wpk_font_destroy(f);
    wpk_surface_destroy(s);
    wpk_client_disconnect(cl);
    return 0;
}
```

**Commit:** `examples(wpkpanel): main loop — minute-cadence clock + focus listener`

### Task E3: Init amendment — exec wpkpanel as PID 4

**Files:**
- Modify: `examples/init/init.c` — after plan 10 B1's wpkshell
  exec, fork-exec wpkpanel as the next child.

```c
/* After plan 10 B1's wpkshell exec arm, before init's reap loop: */
if (access("/etc/wpk/compositor", F_OK) == 0) {
    pid_t panel_pid = fork();
    if (panel_pid == 0) {
        execl("/usr/bin/wpkpanel", "wpkpanel", NULL);
        _exit(127);
    }
    /* No wait — panel runs alongside wpkshell. */
}
```

**Commit:** `examples(init): fork-exec wpkpanel as PID 4 alongside wpkshell`

### Task E4: Compositor work-area amendment — reserve top 24 px

**Files:**
- Modify (cross-plan to plan 9): compositor's window placement
  algorithm reserves the top `PANEL_RESERVED_PX = 24` of the
  output. New windows positioned at `y >= 24`.

```c
/* In compositor's place_window helper: */
#define PANEL_RESERVED_PX 24
if (placement_y < PANEL_RESERVED_PX) placement_y = PANEL_RESERVED_PX;
```

**Commit:** `examples(wpkcompositor): reserve top 24 px for wpkpanel (cross-plan amendment to plan 9)`

### Task E5: Manual browser verification (the gate)

CLAUDE.md item 6. Build all five binaries (compositor + wpkshell
+ wpkfm + wpkbeep + wpkcube + wpkpanel) and wire them into
`examples/browser/pages/wpk-desktop/`. The browser page mounts:

1. wpkcompositor at PID 2.
2. wpkshell at PID 3 (terminal in a window below the panel).
3. wpkpanel at PID 4 (top 24 px strip — clock right-aligned,
   focus app left-aligned).
4. User launches `wpkfm &` from wpkshell — file-manager window
   appears with tree of /, double-clicking `etc` descends.
5. User launches `wpkbeep &` — single-button window appears;
   click triggers 1 s 440 Hz tone; indicator goes red→green.
6. User launches `wpkcube &` — 320×240 window appears with
   GLES2-rendered spinning cube.
7. All four windows visible simultaneously (excluding wpkshell
   modifier focus). Super+Tab cycles focus; the panel's left
   readout updates accordingly.
8. Closing each window via the compositor's window-close
   gesture reaps the orphaned process cleanly.

**No commit yet — verification only.**

### Task E6: Phase E — final gauntlet + open PR #4

PR title: `[explore-dri] examples(wpk): wpkpanel — 24-px panel widget bar as PID 4`

Body covers: panel scaffold + minute-cadence clock + focus
indicator, init amendment fork-execing PID 4, compositor work-
area amendment reserving the top 24 px, manual browser walk-
through showing all four apps coexisting. ABI impact: none.

---

## Final coordinated merge

When all four PRs are reviewed and approved, the browser
verification passes:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 (wpkfm + widgets) → PR #2's base.
3. Squash-merge PR #2 (sdl2-wpkvideo + wpkcube) → PR #3's base.
4. Squash-merge PR #3 (wpkbeep) → PR #4's base.
5. Squash-merge PR #4 (wpkpanel + init amendment + compositor
   work-area amendment) → plan 10's `…-wpkshell-demo` (or
   wherever plan 10's tip lives at the time).
6. Tag: `[explore-dri-wpk-desktop] plan 11 merged at <sha>` in
   the next session-handoff doc.

**Do not push to upstream until v1 + plans 2–11 are all merged
upstream as a coherent chain.** Plan 11 closes the chain at the
user-facing level; v2 work (Wayland bridge, PTY surface, real
widget framework, etc.) starts after upstream merge.

---

## Trade-offs already locked in (don't relitigate during implementation)

- **Three widget primitives (button, row, status), no widget
  framework.** A real widget toolkit is post-v1.
- **wpkfm is a viewer, not an editor.** No file rename / copy /
  delete / chmod. v2.
- **SDL2 wpkvideo backend is a separate static archive
  (`libSDL2_wpkvideo.a`).** Cannot link both KMSDRM and
  wpkvideo SDL2 in one binary.
- **No GLES3, no Vulkan, no compute.** wpkcube uses GLES2 only.
  v2 may expand if upstream drivers do.
- **wpkbeep is single-threaded, blocks on the audio loop.**
  No background-playback option in v1. A real audio app would
  use the plan 7 audio-thread (b) pattern in a worker thread,
  but plan 7 explicitly defers worker-thread support; wpkbeep
  matches by blocking the UI for 1 s.
- **wpkpanel updates at 1-min cadence.** No seconds clock, no
  CPU/memory readout, no battery widget. v2 may add system
  tray.
- **Panel reserves top 24 px globally.** Compositor work-area
  reduction is hardcoded; no `set_strut`-style protocol in v1.
  v2 may generalise.
- **wpkfm preview is text-only.** No image preview, no
  syntax highlighting, no large-file paging. v2.
- **wpkcube is a static demo, not a 3D engine.** No model
  loading, no shaders beyond the cube's, no physics.
- **No drag-and-drop between wpkfm and other apps.** v2 with
  CLIPBOARD_* plumbing per plan 9 reservation.
- **All four apps run as separate processes.** No in-process
  multi-window pattern.
- **Init's PID 4 panel exec is gated on
  `/etc/wpk/compositor`.** Without the marker, plan 11 doesn't
  contribute to init's exec chain; WordPress demo unaffected.
- **Zero ABI impact.** No kernel surface; no host imports.

---

## Risk register

1. **SDL2 wpkvideo backend scope creep.** The minimum
   viable backend ships ~400 LoC; full SDL_VIDEODEVICE
   coverage (cursor + clipboard + IME + window events) could
   balloon to 2000+ LoC. *Mitigation:* document the supported
   subset (video + GL + input events only); demos that need
   more should use SDL2's other backends (where applicable)
   or wait for plan 12.
2. **`libSDL2_wpkvideo.a` archive size.** Static-linking SDL2
   pulls ~1.2 MB. Two SDL2 archives in the sysroot is ~2.4 MB
   of disk. *Mitigation:* acceptable for v1; v2 may unify on
   a single archive with both backends selectable at runtime.
3. **wpkfm's directory scan slow on large directories.** v1
   reads up to MAX_ROWS=64 entries. Bigger directories silently
   truncate; the status bar shows count = 64 even when more
   exist. *Mitigation:* document; v2 paginates.
4. **wpkbeep's blocking audio loop freezes the window.** Click
   the button → window doesn't repaint for 1 s. *Mitigation:*
   v1 documented behaviour; v2 with worker threads.
5. **wpkpanel's `localtime_r` depends on /etc/localtime being
   present.** If the rootfs ships UTC-only, the panel shows
   UTC. *Mitigation:* ship a default `/etc/localtime` (UTC) in
   the rootfs; document the time-zone behaviour.
6. **Init's PID-4 fork race.** Plan 10 B1 patches init to
   `access`-poll for `/run/wpk/comp` before exec'ing wpkshell;
   wpkpanel benefits from the same wait (it's exec'd after
   wpkshell, so the socket is already present). *Mitigation:*
   plan 10's fix #12 covers both; no separate panel race.
7. **Compositor's focus broadcast (`WPK_CLIENT_FOCUS_CHANGED`)
   pinned to the 24-message inventory.** Adding the message
   to plan 9's enum bumps the count to 25 if all 24 slots are
   used. *Mitigation:* one of plan 9's `_RESERVED_FOR_V2_*`
   slots becomes `WPK_CLIENT_FOCUS_CHANGED`; no count
   increase. Confirm in plan 11's pre-impl review.
8. **GL stack follow-ups (plan 2 + plan 3) are PR #2's
   blocker.** Without `gbm_surface_create` exported under the
   right semantics, wpkcube can't compile. *Mitigation:*
   gate PR #2 on the GL stack follow-ups landing (which they
   must for plan 9 anyway).
9. **wpkfm + wpkbeep + wpkcube all running simultaneously
   hit the compositor's 16-client cap.** 5 surfaces (panel +
   shell + fm + beep + cube) is well under 16. *Mitigation:*
   no risk in practice; documented as a v1 envelope.
10. **`gbm_bo_get_stride` in wpkvideo backend depends on
    plan 2's bo metadata.** If plan 2's bo handle doesn't
    expose stride correctly, the wpkvideo SwapWindow path
    sends garbage. *Mitigation:* plan 2's bo API includes
    `gbm_bo_get_stride` (standard libgbm surface); confirm
    in the implementation phase.

---

## What this plan doesn't cover (deferred)

- **Real widget framework.** Buttons / rows / status only. v2
  with a libwpkui library.
- **File operations in wpkfm.** Rename / copy / delete /
  chmod. v2.
- **Image preview in wpkfm.** v2 (needs decoder library; could
  be a stb_image-based addition).
- **GLES3 / Vulkan.** v2; GLES2 only for v1.
- **SDL2 audio via wpkvideo.** Currently wpkbeep does direct
  ioctl; SDL2 audio works via plan 7's existing path on its
  own. Unifying is v2.
- **Multi-second audio in wpkbeep.** v1 = 1 s; v2 = arbitrary
  length with proper playback state machine.
- **System tray icons in wpkpanel.** Placeholder area only;
  v2.
- **Panel customisation (themes, widgets, layout).** v2.
- **Workspace switcher / multi-monitor panel.** v2 (plan 4
  invariant + Wayland-bridge).
- **Window list in panel.** Just focus indicator in v1; v2
  may add the full window list.
- **wpkcube as an actual 3D demo.** Static cube only; v2 may
  ship a more interesting demo.
- **Drag-and-drop, clipboard.** Plan 9 reserves messages; v2.
- **`xdg-shell`-style window types.** v1 = flat (all windows
  are "toplevel"); v2.
- **wpkpanel `set_strut` protocol.** v1 hardcodes the
  reserved-top-24 px in the compositor; v2 generalises with
  a client-driven protocol message.
- **wpkfm symlink resolution / mount detection.** v1 follows
  symlinks via `stat`; doesn't show the destination. v2.
- **Network panel widgets.** v2.

---

End of plan.
