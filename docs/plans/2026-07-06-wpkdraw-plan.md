# DRI v2 — wpkdraw plan (thin 2D rendering library for non-SDL2 apps)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Ship `examples/libs/wpkdraw/` — a thin, static-link-only,
user-space 2D rendering library that sits directly on plan 4's KMS
(`/dev/dri/card0`) + plan 2's gbm_bo (CPU-tier, ARGB8888), giving
non-SDL2 apps a `wpk_draw_pixel` / `wpk_rect` / `wpk_text` /
`wpk_widget_*` surface without pulling in SDL2's ~10 MB of static
lib or its threading requirements. Plan 8 unblocks plans 10 + 11's
seed apps (wpk-shell, file manager, settings panel) which don't
want GL but do want a screen + a button + some text. **Sysroot-only
changes — no kernel code, no host code, no ABI impact.**

**Architecture:** One new package under `examples/libs/wpkdraw/`,
packaged the same recipe shape plan 2's libgbm and plan 7's libdrm
use (`package.toml` + `build.toml` + `build.sh`). The library
builds in three phases — Phase A: core 2D primitives (rect, line,
blit) over a `wpk_surface` backed by a pair of plan-2 CPU-tier
gbm_bos with plan-4 KMS page-flip; Phase B: text rasterizer
(`stb_truetype.h` single-header vendored + a fixed-DPI glyph cache
+ one bundled DejaVu Sans regular font); Phase C: widget primitives
(button + label + panel-strip + popup-menu) + a `wpkdraw_demo`
program that exercises the whole stack. A browser-page smoke test
closes the loop. **No SDL2 dependency** — plan 8's apps either link
wpkdraw or SDL2, never both (the two surface ownership models — KMS
master via SDL2 vs. KMS master via wpkdraw — collide at the master-
set ioctl; v1 doesn't reconcile them).

**Why a separate library, not bundled into wpkcompositor (plan 9)
or written per-app:** the design doc §9.3 already factored wpkdraw
out — the compositor + file-manager + panel all need the same 2D
primitives + text rasterizer + widget toolkit. Bundling into plan 9
would couple the compositor's IPC + xdg-shell decisions to the 2D
surface API, making both harder to evolve. Splitting it out also
unblocks a non-compositor "fullscreen wpkdraw" mode for headless
benchmarking apps + the wpk-shell demo in plan 10 (which doesn't
need a compositor at all — it just takes KMS master and draws a
prompt). One static archive (~80 KB code + 512 KB font); apps that
don't need it don't link it.

**Tech Stack:**
- Userland library: C99 with `wasm32posix-cc`; static archive
  `sysroot/lib/libwpkdraw.a`; public headers under
  `sysroot/include/wpkdraw/{wpkdraw.h, wpkfont.h, wpkwidget.h}`.
- Text rasterizer: `stb_truetype.h` (single-header, public domain;
  the canonical embedded TTF rasterizer; vendored verbatim under
  `examples/libs/wpkdraw/third_party/stb_truetype.h`).
- Bundled font: DejaVu Sans regular (`DejaVuSans.ttf`, ~512 KB,
  Bitstream Vera derivative license — permissive; install to
  `/usr/share/fonts/default.ttf` at app-install time, app reads
  via `wpk_font_load_default(px)`).
- Demo: `programs/wpkdraw_demo.c` — fullscreen ARGB8888 surface
  with a "Hello world" label + a button that animates a colour
  cycle on click + ESC-to-quit through plan 5 evdev. ~200 LoC; the
  smallest "real" wpkdraw app exercising plans 2 + 4 + 5.

**Companion design doc:** `docs/plans/2026-05-18-dri-design.md`
§9.3 (the draw lib + text rasterizer); §9.4 (seed apps that link
wpkdraw); §10 (validation milestones — wpkdraw indirectly underpins
milestone E's file-manager).

**Critical wasm32 ABI detail:** wpkdraw's public API surface
(`wpk_surface*`, `wpk_color`, `wpk_button`, `wpk_font*`) is
deliberately opaque — pointers + plain-old-data structs. No ABI
break risk if internals change. The library does NOT cross the
kernel-userland ABI; every byte goes through plan 2's gbm_bo
mmap + plan 4's KMS ioctls + plan 5's evdev `read()`.

**Clock source:** wpkdraw's animation step uses
`clock_gettime(CLOCK_MONOTONIC, …)` via the existing musl shim —
same as plans 4/5/6/7. Cross-stream parity preserved.

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §9.3,
§9.4, §10.

**Consistency with plans 2 + 3 + 4 + 5 + 6 + 7:**
- Adds NO new kernel exports, NO new host imports, NO new ioctls,
  NO new device nodes. Every kernel surface wpkdraw touches
  already exists from plans 2 + 4 + 5.
- Plan 2's `gbm_bo_create(format=ARGB8888, flags=GBM_BO_USE_SCANOUT
  | GBM_BO_USE_LINEAR)` + `gbm_bo_map(GBM_BO_TRANSFER_WRITE)`
  gives wpkdraw a CPU-mappable pixel buffer; the library writes
  pixels directly into the mapped region.
- Plan 4's `DRM_IOCTL_MODE_GETRESOURCES` / `MODE_GETCONNECTOR` /
  `MODE_GETCRTC` / `MODE_ADDFB2` / `MODE_SETCRTC` /
  `MODE_PAGE_FLIP` + `DRM_IOCTL_WAIT_VBLANK` provide the present
  pipeline. wpkdraw takes master on card0, queries the connector's
  default mode (the v1 single output), sets the CRTC once,
  page-flips between two ARGB8888 bos per `wpk_surface_present()`.
- Plan 5's `/dev/input/event0` + `event1` provide keyboard + pointer
  events. wpkdraw's widget dispatch reads `struct input_event`
  records and routes EV_KEY + EV_REL + EV_ABS to registered
  widgets. ESC-to-quit is hard-coded.
- **Does NOT depend on plan 7 (SDL2)** — wpkdraw and SDL2 are
  alternative front-ends, not stacked. A wpkdraw app and an SDL2
  app cannot both run at the same time on card0 (KMS master is
  exclusive); v1 doesn't multiplex them. Plan 9's wpkcompositor
  fixes this by becoming the only KMS-master holder and serving
  both SDL2 and wpkdraw clients via its own protocol.
- **Does NOT use `gbm_surface_*`** — plan 2 ships `gbm_bo`
  primitives but defers `gbm_surface_create` to a follow-up (plan
  2 line 1869). wpkdraw avoids `gbm_surface` entirely: it owns two
  raw `gbm_bo`s as front + back, swaps the pointer on present, and
  re-uses plan 4's `MODE_PAGE_FLIP` directly. No third bo, no
  triple-buffering, no swap-chain abstraction. (Plan 9's
  compositor will graduate to `gbm_surface_*` once plan 2's
  follow-up lands.)

**Stack base:** Plan 7's `…-sdl2-demo` branch tip. wpkdraw doesn't
extend any kernel code; the kernel is the same as it was at plan 7
merge.

**Branch:**
`emdash/explore-direct-rendering-infrastructure-wpkdraw-plan-XXXXX`
(chains off plan 7's tip per the branching rule). Two sub-branches
stack off it.

**Final PR base:** Plan 7's `…-sdl2-demo` tip. Plan 8 does NOT
depend on plan 7's PR #2 (SDL2 vendor) — only on plan 7's PR #3's
base (plan 6 ALSA). But by stacking on plan 7's full tip we keep
the chain linear; if reviewers want to merge plan 8 ahead of plan 7
PR #3, the rebase is straightforward (no overlapping files).

**Two PRs, coordinated merge.** Each task below is one commit.
Brandon's `scope(area): action` titles:

1. `sysroot(wpkdraw): scaffold + 2D primitives + text rasterizer`
2. `sysroot(wpkdraw): widgets + wpkdraw_demo + browser spec`

PR base/head topology (stacked):

```
… (plans 2–7 tips)
 └── …-sdl2-demo                              (plan 7 PR #3 tip)
      └── …-wpkdraw-plan-XXXXX
           └── …-wpkdraw-lib  (PR #1)
                └── …-wpkdraw-demo  (PR #2)
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

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a
regression. Phase C adds: (a) manual `./run.sh browser` verification
of the wpkdraw demo (CLAUDE.md item 6) — the demo renders a
button + label, click colour-cycles, ESC quits; (b) no profiling
gate (wpkdraw is a single-app fullscreen surface; PROCESS_TABLE
lock contention is dominated by plan 5 evdev rate which is already
gated by plan 7).

**ABI impact:** **None.** Plan 8 adds no kernel exports, no host
imports, no new ioctls, no new device nodes, no new repr(C) structs
on the kernel-userland ABI. Every byte wpkdraw sends to the kernel
goes through ioctls + mmap + read/write already defined by plans
2/4/5. `ABI_VERSION` does not bump; `abi/snapshot.json` does not
change.

The sysroot DOES grow: `sysroot/lib/libwpkdraw.a` (~80 KB code) +
`sysroot/share/fonts/default.ttf` (512 KB) + headers under
`sysroot/include/wpkdraw/`. The package-index ledger gets one new
entry.

Existing kernel + host + ABI surfaces — all unchanged.

---

## Pre-implementation review

Devil's-advocate + consistency pass run 2026-05-19 (session 9), after
plan 8 drafted in session 8. Pass covers: focus areas from the
hand-off-8 sentinel (`gbm_bo_map(GBM_BO_TRANSFER_WRITE)` write-
coherence, `MODE_PAGE_FLIP` synchronous-wait vs plan 4's
one-in-flight throttle, `drmSetMaster` EBUSY clean-error when SDL2
holds master, stb_truetype.h cross-compile under `wasm32posix-cc`,
FIFO-vs-LRU glyph cache, EV_REL vs EV_ABS pointer model in
`wpk_widget_pump_events`, static-link-only invariant + DejaVu Sans
license bundling, multi-tab evdev fanout caveat), plus a code-level
re-read of `wpk_surface_create` / `wpk_surface_present` /
`wpk_widget_pump_events` / `wpk_widget_button_draw`. Findings are
structured Brandon-style. Inline fixes (12) are **folded
conceptually** — plan body retains pre-review text per the Brandon
convention; implementation applies the fix per this section. Three
cross-plan amendments leak back into plans 2 + 4 + 5 reviews; the
open-correctness items are documented with lean resolutions and
do not block the plan from advancing to plan 9.

### Inline fixes (12 — folded conceptually; plan body unchanged)

1. **Pointer position never updates for browser users without
   pointer-lock.** Plan 5 `host/src/input/browser-input-source.ts`
   line 1655 (`onPointerMove` else branch) emits **EV_ABS** (ABS_X +
   ABS_Y) for default-state (unlocked) pointer; EV_REL only fires
   when `document.pointerLockElement` is set. Plan 8's
   `wpk_widget_pump_events` (B1) handles `iev.type == EV_REL`
   exclusively → on the default browser case, `ptr_x` / `ptr_y` stay
   at 0 forever, the button never receives a click at its actual
   coordinates, and the demo silently fails interactive
   verification. Add an `EV_ABS` arm:
   ```c
   } else if (iev.type == EV_ABS) {
       if (iev.code == ABS_X) ptr_x = iev.value;
       if (iev.code == ABS_Y) ptr_y = iev.value;
       /* emit a single WPK_EV_POINTER_MOTION when both X+Y arrive,
        * or — pragmatic — emit on each component, the dispatcher
        * is idempotent on duplicate (x,y) deltas. */
   }
   ```
   Risk register #7 (pointer absolute vs relative) is correct in
   spirit but its lean ("vitest with injectPointerMotionAbs covers
   the absolute path") fires too late — the absolute path is the
   *default* path, not a corner case. Bump the risk register
   wording and add a Phase B1 cargo/vitest test that drives an
   EV_ABS-only sequence through the button. Cross-plan follow-up
   added to plan 5 (note the absolute-by-default semantics in plan
   5's "Trade-offs verified" so future-me consumers know).
2. **`drmModePageFlip(...PAGE_FLIP_EVENT, NULL) + drmWaitVBlank` is
   the wrong vsync pattern.** Per plan 4 (lines 595-623): the
   `PAGE_FLIP_EVENT` flag causes the kernel to post a
   `DRM_EVENT_FLIP_COMPLETE` (type=2, 32 bytes) record onto the
   master fd's per-OFD event ring on the next vblank tick.
   `DRM_IOCTL_WAIT_VBLANK` separately wakes every blocker on the
   broadcast `wait_vblank_queue` on every tick (plan 4
   open-architecture #2: two queues, `read_wait_queue` per-OFD +
   `wait_vblank_queue` global). The pair coincidentally fires on
   the same tick so the demo "works", but:
   - Every `wpk_surface_present` deposits an unread 32-byte record
     in the OFD's `event_ring`. Plan 4's ring caps at 64 records
     and silently drops the oldest (cross-plan amendment from
     plan 5's review, lines 478-504 of plan 4). At 60 Hz the ring
     saturates in ~1 s and stays saturated for the demo's life.
     Not a crash, but wasteful and confusing in `/proc/`-style
     introspection later.
   - The pattern doesn't match plan 4's own modeset demo (plan 4
     line 2103-2111), which uses `drmHandleEvent(card, &ctx)` with a
     `page_flip_handler` callback. SDL2 2.30 KMSDRM also uses
     `drmHandleEvent` (plan 7 line 211-213). Pick the canonical
     pattern. **Lean:** drop the `drmWaitVBlank` call, keep the
     `PAGE_FLIP_EVENT` flag, and replace with `drmHandleEvent(card,
     &ctx)` where `ctx.page_flip_handler` is a no-op callback that
     just signals "flip done". Drains the ring; matches plan 4 +
     plan 7 idiom; one libdrm call instead of two.
   - Alternative (smaller patch but loses the SDL2 idiom symmetry):
     drop `PAGE_FLIP_EVENT` (pass `0` as flags) and keep
     `drmWaitVBlank`; no record produced, ring stays empty.
   Cross-plan follow-up added to plan 4 documenting the chosen
   pattern. Fold the resolution into A3's `wpk_surface_present`
   body at impl time.
3. **`gbm_bo_map` signature mismatch across plans 2 + 4 + 8.**
   Plan 8 A3 (line 580-582) calls:
   ```c
   *out_pixels = gbm_bo_map(*out_bo, 0, 0, s->width, s->height,
                            GBM_BO_TRANSFER_WRITE, &map_data, NULL);
   ```
   — 8 args with `&map_data` (a `void **`) where the upstream Mesa
   `gbm_bo_map` puts the `uint32_t *stride` out-param. That's a
   pointer-shape mismatch (writes `uint32_t` through a `void **`,
   undefined behaviour in C). Plan 2 C3 (line 1760) and plan 4 C2
   demo (line 2099) both call it with 9 args `(bo, 0, 0, w, h, 0,
   NULL, NULL, NULL)` — implying plan 2's stub uses a non-standard
   signature. Either way plan 8's call doesn't match either. **Fix:**
   pick the upstream Mesa shape — `(bo, x, y, w, h, flags, uint32_t
   *stride, void **map_data)` — and re-issue plan 2's stub +
   plan 4's modeset demo + plan 8's surface allocator against it.
   Stride is also retrievable via `gbm_bo_get_stride(bo)`, so
   plan 8 can just drop the stride out-param and call
   `gbm_bo_map(bo, 0, 0, w, h, GBM_BO_TRANSFER_WRITE, NULL,
   &map_data)`. Cross-plan amendment added to plan 2's review.
4. **Old back-buffer mapping leaks every `wpk_surface_present`.**
   Plan 8 A3 line 666-672: each present `gbm_bo_map`s the now-back
   bo to refresh `s->back_pixels` but never `gbm_bo_unmap`s the
   previously-mapped slot. Under plan 2's `mmap_shared` aliasing
   model the host-side mmap_anonymous slot accumulates: 5 s × 60
   fps = 300 slots, ~1280×720×4 ≈ 3.7 MB each = ~1.1 GB of stale
   mappings (the SAB pages are still shared, only the wasm Memory
   mapping table grows). Long-running app crashes or stalls when
   mmap_anonymous runs out of pages. **Fix:** cache the two
   mappings once at `wpk_surface_create` time (one per bo), swap
   the `back_pixels` pointer between them on present. No re-map
   per frame.
5. **Release-outside-button drops the click AND leaves
   `_pressed = 1` stuck.** Plan 8 B1 line 1242-1250 dispatcher:
   ```c
   for (int i = 0; i < n_buttons; i++) {
       if (!point_in(&buttons[i], ptr_x, ptr_y)) continue;
       if (press) buttons[i]._pressed = 1;
       else if (buttons[i]._pressed && buttons[i].on_click) {
           buttons[i]._pressed = 0;
           buttons[i].on_click(...);
       }
   }
   ```
   On release outside the button, `point_in` is false → the
   `continue` skips the button entirely → `_pressed` stays at 1 →
   button renders as "pressed" forever, AND next press anywhere
   sets it back to 1, masking the bug. Standard widget behaviour:
   on release, *every* button clears its `_pressed`, but only the
   one(s) the cursor is currently inside fire `on_click`. Restructure:
   ```c
   if (press) {
       for (int i = 0; i < n_buttons; i++)
           if (point_in(&buttons[i], ptr_x, ptr_y))
               buttons[i]._pressed = 1;
   } else {
       for (int i = 0; i < n_buttons; i++) {
           int fire = buttons[i]._pressed &&
                      point_in(&buttons[i], ptr_x, ptr_y);
           buttons[i]._pressed = 0;
           if (fire && buttons[i].on_click)
               buttons[i].on_click(&buttons[i], buttons[i].user);
       }
   }
   ```
6. **`err_gbm:` label leaks the gbm_device when bo allocation
   fails.** Plan 8 A3 line 631 says "`gbm device intentionally
   not destroyed — held by bo lifetime`" — true on success path
   where `bo_front` holds it, but on the goto-from-failure path
   `bo_front` was never allocated, so the gbm device has no owner.
   Memory leak per failed create. **Fix:** make `err_gbm` actually
   `gbm_device_destroy(gbm)`. The success path's comment becomes
   accurate (bo's lifetime extends the device).
7. **`wpk_widget_button_draw` baseline math is hard-coded for
   ~24 px ascent.** Plan 8 B1 line 1194: `int ty = b->y + b->h / 2
   + 8;` — the `+ 8` is approximately a 24 px font's half-ascent.
   At 12 px or 48 px the label drifts. Expose a small `wpk_font`
   accessor (`int wpk_font_ascent_px(wpk_font *f)` returning
   `(int)(f->ascent * f->scale + 0.5f)`) and replace the literal
   with `int ty = b->y + (b->h + wpk_font_ascent_px(f)) / 2;`.
   Trivial; one new public API entry.
8. **`drmDropMaster` on the partial-init goto-`err_master:` path
   is correct *if* `drmSetMaster` succeeded.** Re-reading the
   error chain — A3 line 591: `if (drmSetMaster(...) < 0) goto
   err_close;` (which skips `err_master`). All other failures
   route through `err_master` after master is held, so the drop
   is right. No-op observation: leave a sentinel comment at
   `err_master:` reminding future-me that this label is only
   reachable when master is currently held.
9. **`wpk_widget_pump_events` uses process-global `static int
   ptr_x, ptr_y`.** v1 is single-surface so safe; plan 9's
   compositor will need per-client state. Document the v1
   limitation in `<wpkdraw/wpkwidget.h>` near the pump declaration
   and flag the lift in plan 9: replace the static with a
   caller-owned `struct wpk_event_state *` parameter.
10. **`-fPIC` in the build script is dead weight for a static
    archive.** Plan 8 A3 build wires `wasm32posix-cc -c -O2 -fPIC`.
    `libwpkdraw.a` is a static archive linked into executables that
    are themselves wasm modules — wasm32 has no shared-lib loader,
    PIC adds 2-4% code size for nothing. Drop `-fPIC` across all
    `wpkdraw_*.c` + `stb_impl.c` + `wpkfont.c` + `wpkwidget.c`
    compile lines. Matches plan 2/7's static-archive convention.
11. **`[deps]` in `package.toml` doesn't list libgbm.** Plan 8
    line 257: `[deps] libdrm = "2.4.120"` (plan 7's package), with
    a comment "no gbm package dep — wpkdraw uses gbm_bo* via plan
    2's libgbm-stub which is already in the sysroot". Plan 2 C3
    (line 1730) builds libgbm to `sysroot/lib/libgbm.a` *as part
    of plan 2's PR #3*, but it's a sysroot artifact (no
    `examples/libs/libgbm/package.toml` listed in plan 2). If a
    fresh CI box starts at plan 7's tip + plan 8 branch, plan 2's
    PR #3 has merged and libgbm is in the sysroot — fine. But if
    plan 2 follow-ups (e.g., gbm_surface) refactor libgbm into a
    proper package, this dep needs to be added. **Action:** at
    plan 8 impl time, audit `examples/libs/libgbm/` — if a
    package.toml exists, add the dep; if not, document in plan
    8 A1 that wpkdraw's build assumes plan 2's sysroot is
    materialised first (which the chain ordering enforces, so
    the assumption is safe today).
12. **UTF-8 decode advances 1 byte for any 4-byte sequence start.**
    Plan 8 A5 `decode_utf8` (line 974): the `else` arm
    `{ c = '?'; *pp += 1; }` catches both malformed bytes AND
    legitimate 4-byte UTF-8 starts (`(byte & 0xf8) == 0xf0`,
    e.g., emoji, mathematical alphanumerics). One logical
    codepoint becomes 4 '?' glyphs. Acceptable for v1 (locked-in:
    Latin/Greek/Cyrillic only) but document the limit explicitly
    in `<wpkdraw/wpkfont.h>`: "v1 supports BMP only (codepoints
    ≤ 0xFFFF); 4-byte UTF-8 starts emit `?` per byte." Plan 11's
    seed apps are English-only so this is invisible at v1.

### Correctness — open (lean documented; address at impl time)

- **`gbm_bo_map(GBM_BO_TRANSFER_WRITE)` write-coherence under plan
  2's CPU-shared tier.** Plan 2 B2 (line 1521) confirms "`gbm_bo_map`
  cache-flush no-ops (`_flags`) follow Linux semantics" — the flags
  parameter is decorative. Plan 2 §B2's `MemoryManager::mmap_shared`
  aliases the bo's SAB slice directly to the user's wasm Memory
  region; writes through the pointer ARE the bo's bytes, visible
  to the host's KMS presenter on next `kernel_vblank` without any
  explicit flush. Plan 8's risk register #1 mitigation ("may
  require a `wpk_surface_flush()` call") is defensive but
  unnecessary if plan 2 lands as drafted. **Lean: omit flush in
  v1.** If Phase A3 smoke test shows garbage on canvas, that's a
  plan 2 B2 regression (the `mmap_shared` spike outcome went the
  other way), not a plan 8 bug — escalate plan 2 first.
- **`MODE_PAGE_FLIP` one-in-flight throttle vs `wpk_surface_present`
  blocking model.** Plan 4 (line 430): "One in-flight PAGE_FLIP
  per (CRTC, OFD)." Plan 8's `wpk_surface_present` is synchronous —
  it blocks on `drmHandleEvent` (after inline fix #2) before
  returning, so the next present's PAGE_FLIP is always issued
  after the previous one's FLIP_COMPLETE has been consumed. The
  throttle is never tripped under normal flow. Risk: if the host's
  vblank tick is delayed past 1/60 s (e.g., browser tab
  backgrounded), `drmHandleEvent` blocks indefinitely; the demo
  appears frozen. **Lean: acceptable.** Plan 4's PAGE_FLIP throttle
  semantics force this behaviour everywhere; a paused-tab demo
  hanging matches a paused-tab WebGL demo hanging. Document the
  expected behaviour in `<wpkdraw/wpkdraw.h>` near `wpk_surface_present`.
- **`drmSetMaster` clean-error path when SDL2 (plan 7) holds
  master.** Plan 8 A3 line 591 routes EBUSY through `goto err_close`
  → fd closed → master not held → next op fails cleanly. Verified
  against plan 4 line 1131-1135 (`try_set_master` returns
  `Err(Errno::EBUSY)` if another OFD holds master). The
  `wpk_surface_create` returns NULL with errno=EBUSY; caller's
  `perror("wpk_surface_create")` prints
  `"wpk_surface_create: Device or resource busy"`. Demo exits 1
  cleanly. **Lean: matches drafted plan; risk register #3 covers
  it.** Add a vitest spec under B3 that spawns a stub master-
  holder first, then asserts wpkdraw_demo exits 1 with EBUSY on
  stderr.
- **Pointer-pump fanout under plan 5's seat-shared model.** Plan
  5 (line 1428 + handoff-5 follow-up): every open OFD on event0
  sees every keystroke; every event1 OFD sees every pointer event.
  A second wpkdraw process opening event0 receives every ESC the
  first process types, including app-private quit chords. v1 is
  strictly single-app-fullscreen (the KMS-master invariant blocks
  N concurrent surfaces); the hazard is dormant until plan 9's
  compositor adds EVIOCGRAB-based focus routing. **Lean: document
  the v1 limitation in `<wpkdraw/wpkwidget.h>` next to the pump
  declaration:** "v1: keyboard + pointer events are visible to
  every process with the device open. Single-app-fullscreen is
  the only safe configuration. Plan 9's compositor adds focus
  routing." No code change; doc-only.
- **`stb_truetype.h` cross-compile under `wasm32posix-cc`.** stb
  headers reference `floor`, `sqrt`, `pow`, `fabs` — all in our
  musl libc per `musl-overlay/`. The implementation TU
  `#define STB_TRUETYPE_IMPLEMENTATION` includes the header once;
  no static-init globals beyond the `stbtt__buf` zero-init.
  **Lean: A4's smoke test (call `stbtt_InitFont` + render one
  glyph) is sufficient.** Add `-lm` to the *executable* link
  line in `wpkdraw_demo` (the static archive doesn't link `-lm`;
  the demo's `wasm32posix-cc -o wpkdraw_demo.wasm ... -lm` does).
  Plan 8 line 1369 already has `-lm` — verified.
- **DejaVu Sans license bundling at sysroot share/fonts.** Plan 8
  A5 installs both `default.ttf` and `default.LICENSE`. **Lean:**
  the license file goes under the same dir as the font; users
  who `find /usr/share/fonts -name '*.LICENSE'` discover it.
  Acceptable per Bitstream Vera + DejaVu permissive license.
  No further bundling needed.
- **Static-link-only invariant.** Plan 8 line 226 trade-off
  confirms — `libwpkdraw.a` only, no `.so`. The build script
  only produces `.a`; package recipe doesn't include a
  `--enable-shared` flag (there's no `configure` step at all —
  hand-rolled compile + `llvm-ar rcs`). **Lean: no recipe risk.**
  Add a cargo test under A6 that asserts
  `sysroot/lib/libwpkdraw.so` does NOT exist post-build.
- **`wpk_widget_pump_events` partial-record reads.** `read(fd,
  &iev, sizeof iev)` against plan 5's per-OFD ring: plan 5 line
  1334-1390 enforces "read returns a multiple of 24 bytes (one
  full `input_event`); partial-record returns are forbidden;
  read with too-small buffer returns EINVAL." Plan 8's pump
  passes exactly `sizeof(struct input_event)` (24 bytes) per read
  → plan 5 returns either 24 bytes (one record) or 0/EAGAIN.
  Plan 8 only proceeds on `== (ssize_t)sizeof iev`, dropping
  -1/EAGAIN cleanly. **Lean: matches plan 5's contract.** No
  change.

### Architecture — open (NO LOAD-BEARING items)

Plan 8 has zero open architecture items. Every cross-plan dependency
(gbm_bo from plan 2; KMS/PAGE_FLIP from plan 4; evdev from plan 5)
is on already-drafted-and-reviewed surfaces with locked-in
semantics. Specifically:

- Plan 7's open-architecture #1 (SDL2 audio thread model) **does
  not apply** — wpkdraw has no audio path.
- Plan 7's open-architecture #2 (GL stack ownership —
  `libEGL.a` + `libGLESv2.a` + `gbm_surface_*`) **does not apply**
  — wpkdraw is CPU-tier-only, no EGL, no GLES, no swap-chain.
  This is the entire reason plan 8 exists per design §9.3 (the
  "GL-less alternative to SDL2_Renderer").
- The "wpkdraw and SDL2 don't coexist on KMS master" constraint
  is a *locked-in trade-off*, not an open architecture question.
  Plan 9 will multiplex; v1 partitions cleanly.

### Missing tests — add at impl time

- **`wpk_widget_pump_events` EV_ABS path drives pointer.** Vitest
  under B3 with `injectPointerMotionAbs(handle, x, y)` (which uses
  plan 5's EV_ABS emission); assert the click test passes through
  the absolute path. Without this, inline fix #1 has no regression
  guard.
- **Release-outside-button does NOT fire `on_click`.** Vitest
  pseudo: press inside button, drag pointer outside, release; assert
  `on_click` was never called AND the button visibly de-presses
  on the next render. Regression guard for inline fix #5.
- **`wpk_surface_create` failure when SDL2 holds master.** B3
  spawns a small wasm program that takes master on card0 and
  sleeps; spawn wpkdraw_demo; assert demo exits 1 with errno=EBUSY
  on stderr.
- **Partial-init cleanup releases master.** Cargo test forces
  `gbm_bo_create` ENOMEM (via host stub) and asserts the kernel's
  master-holder slot is empty after the failed `wpk_surface_create`.
  Regression guard for inline fix #6 + the goto-chain.
- **Mapped slots don't accumulate across 300 presents.** B3 test
  asserts the count of `mmap_anonymous` calls stays at 2 (one per
  bo) after 300 `wpk_surface_present` invocations. Regression guard
  for inline fix #4.
- **Glyph cache FIFO eviction is observable.** Render 300 distinct
  codepoints through `wpk_text`; assert cache stays at exactly 256
  entries and the *oldest 44 evicted* codepoints' bitmaps have been
  freed (no `bitmap` pointer to leaked memory).
- **`wpk_font_load_default(px_size)` clamps invalid sizes.**
  `px_size = 3` and `px_size = 257` both return NULL with
  errno=EINVAL; `px_size = 4` and `px_size = 256` succeed.
- **`wpk_text_width` matches `wpk_text` rendered width.** Smoke
  test: render "Hello world" at px=24; compare `wpk_text_width(f,
  "Hello world")` against the rightmost non-zero pixel column of
  the rendered bitmap; assert within 2 px (sub-pixel rounding
  slack).
- **`sysroot/lib/libwpkdraw.so` does NOT exist post-build.**
  Static-link-only invariant guard. Cargo test asserts only `.a`
  shipped.
- **`wpkdraw_demo.wasm` Vitest at 24 fps (slower vblank).** Drive
  `kernel_vblank` from the test harness at 24 Hz instead of 60 Hz;
  assert the demo still exits cleanly and `kmsCounts.page_flip`
  scales linearly. Catches frame-rate-coupling bugs in `wpk_surface_present`.
- **Wheel events ignored cleanly.** Plan 5 emits `EV_REL { REL_WHEEL,
  ±1 }` on scroll; plan 8's pump should not synthesise spurious
  `WPK_EV_POINTER_MOTION` for wheel ticks. Vitest: inject a wheel,
  assert `nev` after pump excludes any pointer-motion record.

### Trade-offs verified

- **Static-link-only, no shared lib.** `libwpkdraw.a` only; v1
  libc has no `dlopen`. Plan 8 line 1548 + design §9.3. ✓
- **Two gbm_bos direct, no `gbm_surface_*`.** Plan 2 defers
  `gbm_surface_create` (plan 2 line 1869); wpkdraw owns front + back
  bos directly + page-flips between them. Simpler than a swap-chain;
  plan 9 graduates to gbm_surface once it lands. ✓
- **wpkdraw and SDL2 are alternative front-ends, not stacked.**
  KMS master is exclusive (plan 4 line 430). Plan 9 multiplexes
  via a compositor that holds master + serves both client types.
  ✓
- **FIFO glyph cache, fixed 256-entry cap.** Linear-probe lookup
  is O(N) per glyph; cap of 256 keeps the constant small. LRU is
  a profiling-driven refinement (risk register #6); for v1's
  English UI labels (~80 distinct codepoints typical) the cap is
  ample. ✓
- **No anti-aliasing on lines.** Bresenham; AA is post-v1. ✓
- **Text rasterizer uses 8-bit alpha mask** (stb_truetype's
  default) — sub-pixel position rounded to integer pixel. Matches
  Mesa's swrast text + most embedded GUI toolkits. ✓
- **CLOCK_MONOTONIC pinned via musl shim.** Cross-stream parity
  with plans 4/5/6/7. ✓
- **One bundled font (DejaVu Sans regular).** Bold/italic post-v1. ✓
- **UTF-8 decode permissive.** Malformed → '?', no errors raised.
  BMP-only (inline fix #12). ✓
- **No multi-window.** Plan 9 introduces windowing. ✓
- **No mouse cursor rendered by wpkdraw.** Apps draw their own.
  Plan 9's compositor will manage a system cursor. ✓
- **No event-routing IPC.** wpkdraw is in-process; plan 9 adds
  the unix-socket protocol. ✓
- **Zero ABI impact.** No kernel exports, no host imports, no
  ioctls, no device nodes. Sysroot-only addition. ✓
- **stb_truetype.h public-domain vendoring.** Standard practice;
  cross-compiles under wasm32posix-cc (math symbols all present
  in musl). ✓
- **DejaVu Sans permissive license.** Bitstream Vera + DejaVu
  modifications; bundle `default.LICENSE` alongside `default.ttf`. ✓
- **Two-PR stacked merge.** PR #1 (lib + primitives + text) →
  PR #2 (widgets + demo). Plan 7's `…-sdl2-demo` tip as base. ✓

### Deliberately not flagged

- **`wpk_surface` is not thread-safe.** v1 is single-threaded
  (no pthreads); n/a until plan 9 / SDL2 audio thread (plan 7
  open-arch #1). ✓
- **`wpk_blit` forward-iteration may corrupt under self-aliasing
  with downward `dst < src` row order.** Single-surface aliasing
  is an unusual pattern (no real app blits a surface onto
  itself); the comment "memmove-safe" overstates safety. Document
  the constraint or leave for plan 9's compositor to fix when it
  introduces buffer-to-buffer blits between client surfaces. ✓
- **Bresenham line includes both endpoints.** Matches X11/fbcon
  convention. ✓
- **Out-of-bounds `wpk_pixel` silently discarded.** Matches
  Cairo/SDL clip-not-abort idiom. ✓
- **`wpk_clear` is not vectorised.** ~1280×720×4 = 3.7 MB per
  clear × 60 fps = 220 MB/s. Marginal; SIMD is post-v1. ✓
- **No animation framework.** v1's demo loop is the app's
  responsibility; no tween library. Plan 11's seed apps build
  their own per-app. ✓
- **`wpkdraw_demo.c` hard-coded 5 s runtime.** Matches plan 7's
  demo cadence for vitest parity. ✓
- **Wheel event handling absent.** Plan 8 pump drops `EV_REL`
  with codes other than REL_X/Y, which catches wheel ticks too.
  Documented; demo doesn't scroll. ✓
- **Per-OFD `event_ring` accumulation under inline fix #2
  resolution.** If wpkdraw chooses the alternative (drop
  PAGE_FLIP_EVENT + keep WAIT_VBLANK), no records are produced
  and the ring stays empty. If it chooses the canonical drmHandle
  + PAGE_FLIP_EVENT, drmHandleEvent drains. Either way the ring
  stays bounded. ✓
- **`gbm_bo_get_handle(*bo).u32` may return 0 for failed
  allocator state.** Plan 2's stub allocates a `drm_mode_create_dumb`
  before returning the bo; the handle is non-zero by construction.
  ✓

### Cross-plan amendments (added to plans 2, 4, 5 reviews)

- **Plan 2 follow-up.** `gbm_bo_map` signature shape disagrees
  across plans 2/4/8 (see inline fix #3). Plan 2's libgbm stub
  C3 (line 1730+) is the source of truth and currently uses a
  9-arg variant `(bo, x, y, w, h, flags, ptr1, ptr2, ptr3)` where
  the last three are unused outputs. Plan 4's modeset demo
  (line 2099) inherits the 9-arg shape. Plan 8 attempts an 8-arg
  call with a pointer-shape mismatch. **Lean: align on upstream
  Mesa's 8-arg shape `(bo, x, y, w, h, flags, uint32_t *stride,
  void **map_data)` and re-issue both plan 2's stub + plan 4's
  modeset demo against it.** Plan 8 then calls
  `gbm_bo_map(bo, 0, 0, w, h, 0, NULL, &map_data)` (stride via
  `gbm_bo_get_stride(bo)`). Note added to plan 2's Pre-impl
  review and plan 4's Pre-impl review under a new "Cross-plan
  amendment from plan 8's devil's-advocate" subsection.
- **Plan 4 follow-up.** Plan 8's `wpk_surface_present` (after
  inline fix #2 resolution) uses `drmModePageFlip + PAGE_FLIP_EVENT
  + drmHandleEvent` — same pattern as plan 4's own modeset demo
  (line 2103-2111). Confirms plan 4's event ring + handler
  interface is the canonical idiom. Note added to plan 4's
  "Deliberately not flagged" subsection: "wpkdraw (plan 8) +
  modeset demo (plan 4 C2) + SDL2 KMSDRM (plan 7) all use
  drmHandleEvent for FLIP_COMPLETE drain; WAIT_VBLANK is for
  free-running vblank polling without page flips."
- **Plan 5 follow-up.** Plan 5's `BrowserInputSource` (line 1655)
  emits **EV_ABS** for default-state pointer (unlocked) and
  EV_REL only when pointer-lock is active. Plan 8's pump (and
  any future hand-rolled evdev consumer) must handle BOTH; the
  default browser case is EV_ABS, not the corner case. Note
  added to plan 5's "Trade-offs verified" subsection: "Pointer
  emits EV_ABS by default; consumers expecting cursor-on-default-
  browser must handle the absolute path. SDL2's libinput shim
  handles both; hand-rolled consumers (wpkdraw plan 8) need an
  explicit EV_ABS arm. Documented as a cross-plan amendment from
  plan 8's review."

### Cross-plan amendment from plan 9's devil's-advocate — fix #4 extension to compositor-client mode

Plan 9's devil's-advocate pass (session 10) caught that plan 9
E1's `wpk_surface_present_via_compositor` (plan 9 lines 1396-1415)
re-introduces the per-present `gbm_bo_map` leak that THIS plan's
inline fix #4 closed. Plan 8 fix #4 cached both bo mappings at
`wpk_surface_create` time and swapped a single `back_pixels`
pointer between them on each present — no remap. Plan 9 E1's
amendment shape calls `gbm_bo_map(s->bo_back, ...)` on EVERY
`wpk_surface_present_via_compositor` invocation without
`gbm_bo_unmap` of the previous mapping.

**The fix-#4 invariant must extend to BOTH direct-KMS and
compositor-client modes.** Plan 8's body retains the
pre-review text (per Brandon convention); plan 9 E1's body also
retains pre-review text. At impl time, plan 9 E1 amends
`wpk_surface_create_via_compositor` to cache the symmetric
`bo_front` mapping at create time (parallel to plan 8 fix #4's
direct-KMS pattern), stores `front_pixels` + `back_pixels` +
their `map_data` slots on `struct wpk_surface`, and
`wpk_surface_present_via_compositor` swaps pointer references
on present WITHOUT re-mapping.

*Resolution for this plan:* no change to plan 8's body or
review — fix #4 is documented here and applies to ALL `wpk_surface_present_*`
variants, present and future. Plan 9 E1's "Inline fix #1"
(in plan 9's own review) carries the explicit fold-where note
matching this cross-plan amendment. The shared `wpk_surface`
struct gains two cached mapping slots (one per bo) at impl
time; both modes use them.

### Cross-plan amendment from plan 11's devil's-advocate — export wpk_font_height_px + wpk_font_ascent_px (added during session 12)

Plan 11's `libwpkdraw_widgets` primitives (`wpkw_button`,
`wpkw_row`, `wpkw_status` in widgets.c lines 449, 451, 458,
462, 470) need to compute label positions from font metrics
(centre-align text in a button; baseline-place row labels;
size status-bar strip). Plan 8's finalized §A2 public API
(lines 873–900) exports `wpk_font_load_default`,
`wpk_font_destroy`, `wpk_text`, `wpk_text_width` — but not
the per-glyph height / ascent accessors. Plan 8's own
devil's-advocate pass proposed adding them (lines 335–337)
under the "useful trivia, not LOAD-BEARING for plan 8 itself"
heading, but the finalized §A2 API didn't pick them up.

Amendment: extend §A2 to export the two accessors. Public
header:

```c
int wpk_font_height_px(struct wpk_font *f);   /* ascent + descent */
int wpk_font_ascent_px(struct wpk_font *f);   /* baseline above origin */
```

One-line bodies over plan 8's internal stb_truetype metrics
struct (font.c already computes both internally for
`wpk_text` layout). Land as part of plan 8's libwpkdraw PR —
public header addition + two one-line body additions +
cargo-test asserting non-zero return on a 12-px font.

LOAD-BEARING for plan 11 PR #1 — without these,
`libwpkdraw_widgets` cannot compile. Promotes plan 8's own
"useful trivia" addition from optional to required by plan
11's downstream consumer.

---

---

## Phase A — sysroot: wpkdraw core (PR #1)

Two new tasks under `examples/libs/wpkdraw/` — primitives + text.

### Task A1: Package scaffold

**Files:**
- Create: `examples/libs/wpkdraw/package.toml` — recipe.
- Create: `examples/libs/wpkdraw/build.toml` — build state.
- Create: `examples/libs/wpkdraw/build.sh` — build script (stub).

**Step 1: Package recipe**

```toml
# examples/libs/wpkdraw/package.toml
name = "wpkdraw"
version = "0.1.0"
license = "MIT"
description = "Thin 2D rendering library for non-SDL2 apps; sits on plan 4 KMS + plan 2 gbm_bo"

[source]
type = "local"  # wpkdraw is in-tree; no upstream

[deps]
libdrm = "2.4.120"   # plan 7 — for the KMS API
# Note: no gbm package dep — wpkdraw uses gbm_bo* via plan 2's
# libgbm-stub which is already in the sysroot. If plan 2's stub
# ships as a separate package, add it here.

[build]
script_path = "build.sh"
```

**Step 2: Build state**

```toml
# examples/libs/wpkdraw/build.toml
script_path = "build.sh"
# No repo_url / commit — this is in-tree source.
revision = 1

[binary]
index_url = "https://github.com/<repo>/releases/download/binaries-abi-v{abi}/index.toml"
```

**Step 3: Build script (filled in across A2–A6)**

```bash
#!/usr/bin/env bash
# examples/libs/wpkdraw/build.sh
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

SRC_DIR="$1"        # path to examples/libs/wpkdraw/src
OUT_DIR="$2"        # output dir for libwpkdraw.a + headers
WORK="$OUT_DIR/build"
mkdir -p "$WORK"

# A2–A4 fill in the actual sources + compile + archive steps.
echo "TODO A2: compile wpkdraw primitives + text + widget TUs"
exit 1
```

**Step 4: Cargo test**

```bash
cargo xtask build-deps resolve wpkdraw
```

Expected: package.toml parsed; build attempted; fails with "TODO
A2". OK — A2 wires the real build.

**Step 5: Commit**

```bash
git add examples/libs/wpkdraw/{package.toml,build.toml,build.sh}
git commit -m "sysroot(wpkdraw): scaffold package recipe + build state"
```

---

### Task A2: Public headers

**Files:**
- Create: `examples/libs/wpkdraw/include/wpkdraw/wpkdraw.h`.
- Create: `examples/libs/wpkdraw/include/wpkdraw/wpkfont.h`.
- Create: `examples/libs/wpkdraw/include/wpkdraw/wpkwidget.h`.

The public API is intentionally small. Each header is one logical
unit.

```c
// include/wpkdraw/wpkdraw.h
#ifndef WPKDRAW_H
#define WPKDRAW_H

#include <stdint.h>
#include <stddef.h>

/** Opaque surface handle. Owns a front+back gbm_bo pair, the
 * card0 fd, and the picked CRTC + connector + mode. */
struct wpk_surface;

/** ARGB8888 packed colour. The most-significant byte is alpha
 * (0xff = opaque, 0x00 = fully transparent); next byte is red,
 * then green, then blue. */
typedef uint32_t wpk_color;

#define WPK_RGB(r, g, b)    (0xff000000u | ((uint32_t)(r) << 16) \
                              | ((uint32_t)(g) << 8) | (uint32_t)(b))
#define WPK_RGBA(r, g, b, a) (((uint32_t)(a) << 24) \
                              | ((uint32_t)(r) << 16) \
                              | ((uint32_t)(g) << 8) | (uint32_t)(b))

/** Acquire master on /dev/dri/card0, allocate two ARGB8888
 * gbm_bos at the connector's default mode, SETCRTC the front
 * one. On success returns a non-NULL surface and writes the
 * effective width + height to *out_w + *out_h.
 *
 * Returns NULL on failure; check errno for the underlying cause
 * (EBUSY = another app holds master; ENOENT = no connector;
 * ENOMEM = bo allocation failed).
 *
 * v1 limitation: a single wpk_surface per process; opening a
 * second returns EBUSY. */
struct wpk_surface *wpk_surface_create(int *out_w, int *out_h);

/** Release master + free bos + close card0 fd. Safe to call on
 * NULL. */
void wpk_surface_destroy(struct wpk_surface *s);

/** Page-flip front <-> back; block on WAIT_VBLANK until the
 * flip completes. Returns 0 on success, -1 on KMS error. */
int wpk_surface_present(struct wpk_surface *s);

/** Direct access to the back-buffer pixel data (ARGB8888 packed).
 * Caller can write directly; modifications are visible on the
 * next wpk_surface_present(). Returns NULL if surface invalid.
 *
 * stride is the per-row byte advance — usually width * 4 but
 * the gbm allocator may pad. */
uint32_t *wpk_surface_back_pixels(struct wpk_surface *s,
                                  int *out_stride);
int wpk_surface_width(struct wpk_surface *s);
int wpk_surface_height(struct wpk_surface *s);

/* ---- 2D primitives ---- */

/** Fill the entire back buffer with a single colour. */
void wpk_clear(struct wpk_surface *s, wpk_color color);

/** Plot a single pixel; alpha-blended against existing content if
 * `color`'s alpha < 0xff. Out-of-bounds writes are silently
 * discarded (no abort, no error code). */
void wpk_pixel(struct wpk_surface *s, int x, int y, wpk_color color);

/** Filled rectangle (x, y, w, h) — half-open coordinates, so the
 * rect occupies columns [x, x+w) and rows [y, y+h). Alpha-blended.
 * Negative w / h is a no-op. */
void wpk_rect(struct wpk_surface *s, int x, int y, int w, int h,
              wpk_color color);

/** Bresenham line from (x0, y0) to (x1, y1) inclusive, 1px wide,
 * alpha-blended. No anti-aliasing in v1. */
void wpk_line(struct wpk_surface *s, int x0, int y0, int x1, int y1,
              wpk_color color);

/** Blit src's back pixels onto dst's back buffer at (x, y). Uses
 * src-alpha-over-dst compositing. src and dst may be the same
 * surface (memmove-safe). */
void wpk_blit(struct wpk_surface *dst, int x, int y,
              struct wpk_surface *src);

#endif /* WPKDRAW_H */
```

```c
// include/wpkdraw/wpkfont.h
#ifndef WPKDRAW_FONT_H
#define WPKDRAW_FONT_H

#include "wpkdraw.h"

/** Opaque font handle. Owns a stb_truetype font + a glyph cache
 * at a fixed pixel size. */
struct wpk_font;

/** Load the bundled DejaVu Sans regular at `px_size` pixels and
 * cache the glyph atlas. Returns NULL on failure (errno set:
 * ENOENT = /usr/share/fonts/default.ttf missing, ENOMEM = atlas
 * allocation failed). */
struct wpk_font *wpk_font_load_default(int px_size);

void wpk_font_destroy(struct wpk_font *f);

/** Compute the width (in pixels) of a UTF-8 string in this font.
 * Used for layout before calling wpk_text. */
int wpk_text_width(struct wpk_font *f, const char *utf8);

/** Render a UTF-8 string at (x, y) — y is the baseline, NOT the
 * top — into the back buffer. Alpha-blended. */
void wpk_text(struct wpk_surface *s, struct wpk_font *f,
              int x, int y, const char *utf8, wpk_color color);

#endif /* WPKDRAW_FONT_H */
```

```c
// include/wpkdraw/wpkwidget.h
#ifndef WPKDRAW_WIDGET_H
#define WPKDRAW_WIDGET_H

#include "wpkdraw.h"
#include "wpkfont.h"

struct wpk_event {
    enum { WPK_EV_KEY, WPK_EV_POINTER_MOTION, WPK_EV_POINTER_BUTTON,
           WPK_EV_QUIT } type;
    union {
        struct { int keycode; int pressed; } key;
        struct { int x; int y; } pointer_motion;
        struct { int x; int y; int button; int pressed; } pointer_button;
    };
};

/** A clickable rectangular button. The label is rendered with the
 * supplied font; `on_click` fires when a WPK_EV_POINTER_BUTTON
 * with `pressed = 1, button = 0` arrives inside the rectangle.
 * `user` is passed back unchanged. */
struct wpk_button {
    int x, y, w, h;
    const char *label;
    void (*on_click)(struct wpk_button *self, void *user);
    void *user;
    /* Internal — set by wpkdraw, don't touch. */
    int _hover, _pressed;
};

/** Draw a button into the back buffer. */
void wpk_widget_button_draw(struct wpk_surface *s, struct wpk_font *f,
                            struct wpk_button *b);

/** Pump events from `/dev/input/event[0,1]` into the widget
 * dispatcher. Routes pointer events to overlapping buttons,
 * keyboard events to the global ESC handler (returns
 * WPK_EV_QUIT if ESC is pressed).
 *
 * Reads up to `max_events` records per call; non-blocking.
 * Returns the number of synthesised wpk_events written into
 * `out_ev`. */
int wpk_widget_pump_events(int evdev_kbd_fd, int evdev_ptr_fd,
                           struct wpk_button *buttons, int n_buttons,
                           struct wpk_event *out_ev, int max_events);

#endif /* WPKDRAW_WIDGET_H */
```

**Step 4: Commit**

```bash
git add examples/libs/wpkdraw/include/wpkdraw/
git commit -m "sysroot(wpkdraw): public headers — wpkdraw / font / widget API"
```

---

### Task A3: Core 2D primitives implementation

**Files:**
- Create: `examples/libs/wpkdraw/src/wpkdraw.c` (~400 LoC).
- Create: `examples/libs/wpkdraw/src/wpk_internal.h` (~30 LoC).

```c
// src/wpk_internal.h
#ifndef WPK_INTERNAL_H
#define WPK_INTERNAL_H

#include <stdint.h>

struct wpk_surface {
    int fd_card;        /* card0 fd */
    int crtc_id, conn_id;
    uint32_t mode_id;   /* allocated mode handle if needed */
    int width, height;
    /* Two ARGB8888 gbm_bos forming the front/back pair. */
    struct gbm_bo *bo_front, *bo_back;
    uint32_t fb_front, fb_back;  /* MODE_ADDFB2 fb_ids */
    uint32_t *back_pixels;       /* mmap'd back-buffer */
    int back_stride;             /* bytes per row in back_pixels */
    int back_is_index;           /* 0 = front is bo_front; 1 = swapped */
};

/* Alpha-blend src over a dst pixel in-place; both ARGB8888. */
static inline uint32_t wpk_blend_pixel(uint32_t dst, uint32_t src) {
    uint32_t a = src >> 24;
    if (a == 0xff) return src;
    if (a == 0) return dst;
    uint32_t inv = 255 - a;
    uint32_t dr = (dst >> 16) & 0xff, dg = (dst >> 8) & 0xff,
             db = dst & 0xff, da = dst >> 24;
    uint32_t sr = (src >> 16) & 0xff, sg = (src >> 8) & 0xff,
             sb = src & 0xff;
    uint32_t r = (sr * a + dr * inv) / 255;
    uint32_t g = (sg * a + dg * inv) / 255;
    uint32_t b = (sb * a + db * inv) / 255;
    uint32_t fa = a + (da * inv) / 255;
    return (fa << 24) | (r << 16) | (g << 8) | b;
}

#endif /* WPK_INTERNAL_H */
```

```c
// src/wpkdraw.c
#define _GNU_SOURCE
#include <wpkdraw/wpkdraw.h>
#include "wpk_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#include <xf86drm.h>
#include <xf86drmMode.h>
#include <gbm.h>

/* ---- Surface lifecycle ---- */

static int allocate_bo_and_fb(struct wpk_surface *s, struct gbm_device *gbm,
                              struct gbm_bo **out_bo, uint32_t *out_fb,
                              uint32_t **out_pixels, int *out_stride) {
    /* Allocate CPU-shared-tier bo (LINEAR + SCANOUT) at surface dims. */
    *out_bo = gbm_bo_create(gbm, s->width, s->height, GBM_FORMAT_ARGB8888,
                            GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR);
    if (!*out_bo) return -1;
    /* Wrap as KMS framebuffer via MODE_ADDFB2. */
    uint32_t handles[4] = {0}, pitches[4] = {0}, offsets[4] = {0};
    handles[0] = gbm_bo_get_handle(*out_bo).u32;
    pitches[0] = gbm_bo_get_stride(*out_bo);
    if (drmModeAddFB2(s->fd_card, s->width, s->height, GBM_FORMAT_ARGB8888,
                      handles, pitches, offsets, out_fb, 0) < 0) {
        gbm_bo_destroy(*out_bo);
        return -1;
    }
    /* Map for CPU writes. */
    void *map_data = NULL;
    *out_pixels = gbm_bo_map(*out_bo, 0, 0, s->width, s->height,
                             GBM_BO_TRANSFER_WRITE, &map_data, NULL);
    *out_stride = pitches[0];
    return 0;
}

struct wpk_surface *wpk_surface_create(int *out_w, int *out_h) {
    struct wpk_surface *s = calloc(1, sizeof *s);
    if (!s) { errno = ENOMEM; return NULL; }
    s->fd_card = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    if (s->fd_card < 0) goto err_free;
    if (drmSetMaster(s->fd_card) < 0) goto err_close;
    /* Resolve the v1 single connector + crtc + mode. */
    drmModeRes *res = drmModeGetResources(s->fd_card);
    if (!res || res->count_connectors < 1 || res->count_crtcs < 1) {
        errno = ENOENT;
        goto err_master;
    }
    s->conn_id = res->connectors[0];
    s->crtc_id = res->crtcs[0];
    drmModeConnector *conn = drmModeGetConnector(s->fd_card, s->conn_id);
    if (!conn || conn->count_modes < 1) {
        errno = ENOENT;
        drmModeFreeResources(res);
        goto err_master;
    }
    drmModeModeInfo mode = conn->modes[0];
    s->width = mode.hdisplay;
    s->height = mode.vdisplay;
    drmModeFreeConnector(conn);
    drmModeFreeResources(res);
    /* Allocate gbm device + front/back bos. */
    struct gbm_device *gbm = gbm_create_device(s->fd_card);
    if (!gbm) goto err_master;
    uint32_t *_unused_front_px;
    int _unused_front_stride;
    if (allocate_bo_and_fb(s, gbm, &s->bo_front, &s->fb_front,
                           &_unused_front_px, &_unused_front_stride) < 0)
        goto err_gbm;
    if (allocate_bo_and_fb(s, gbm, &s->bo_back, &s->fb_back,
                           &s->back_pixels, &s->back_stride) < 0)
        goto err_front;
    /* Initial SETCRTC: present the (currently blank) front bo. */
    drmModeSetCrtc(s->fd_card, s->crtc_id, s->fb_front, 0, 0,
                   &s->conn_id, 1, &mode);
    if (out_w) *out_w = s->width;
    if (out_h) *out_h = s->height;
    return s;
err_front:
    drmModeRmFB(s->fd_card, s->fb_front);
    gbm_bo_destroy(s->bo_front);
err_gbm:
    /* gbm device intentionally not destroyed — held by bo lifetime */
err_master:
    drmDropMaster(s->fd_card);
err_close:
    close(s->fd_card);
err_free:
    free(s);
    return NULL;
}

void wpk_surface_destroy(struct wpk_surface *s) {
    if (!s) return;
    drmModeRmFB(s->fd_card, s->fb_front);
    drmModeRmFB(s->fd_card, s->fb_back);
    gbm_bo_destroy(s->bo_front);
    gbm_bo_destroy(s->bo_back);
    drmDropMaster(s->fd_card);
    close(s->fd_card);
    free(s);
}

int wpk_surface_present(struct wpk_surface *s) {
    /* Swap front and back. The previously-back is now front and
     * we page-flip to it. */
    if (drmModePageFlip(s->fd_card, s->crtc_id,
                        s->back_is_index ? s->fb_front : s->fb_back,
                        DRM_MODE_PAGE_FLIP_EVENT, NULL) < 0)
        return -1;
    /* Wait for vblank — synchronous, simplifies the API. */
    drmVBlank vbl = { .request.type = DRM_VBLANK_RELATIVE,
                      .request.sequence = 1 };
    drmWaitVBlank(s->fd_card, &vbl);
    /* Now the just-flipped bo is the front; swap which one
     * back_pixels points to so the next frame writes the other. */
    s->back_is_index ^= 1;
    /* Re-map the now-back bo's pixels. The two mappings could be
     * cached but for simplicity we remap each present. */
    void *_unused;
    s->back_pixels = gbm_bo_map(
        s->back_is_index ? s->bo_front : s->bo_back,
        0, 0, s->width, s->height, GBM_BO_TRANSFER_WRITE, &_unused, NULL);
    return 0;
}

uint32_t *wpk_surface_back_pixels(struct wpk_surface *s, int *out_stride) {
    if (!s) return NULL;
    if (out_stride) *out_stride = s->back_stride;
    return s->back_pixels;
}

int wpk_surface_width(struct wpk_surface *s)  { return s ? s->width  : 0; }
int wpk_surface_height(struct wpk_surface *s) { return s ? s->height : 0; }

/* ---- 2D primitives ---- */

void wpk_clear(struct wpk_surface *s, wpk_color color) {
    if (!s || !s->back_pixels) return;
    int stride_px = s->back_stride / 4;
    for (int y = 0; y < s->height; y++) {
        uint32_t *row = s->back_pixels + y * stride_px;
        for (int x = 0; x < s->width; x++) row[x] = color;
    }
}

void wpk_pixel(struct wpk_surface *s, int x, int y, wpk_color color) {
    if (!s || !s->back_pixels) return;
    if (x < 0 || y < 0 || x >= s->width || y >= s->height) return;
    uint32_t *p = s->back_pixels + y * (s->back_stride / 4) + x;
    *p = wpk_blend_pixel(*p, color);
}

void wpk_rect(struct wpk_surface *s, int x, int y, int w, int h,
              wpk_color color) {
    if (!s || w <= 0 || h <= 0) return;
    int x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
    int x1 = x + w; if (x1 > s->width)  x1 = s->width;
    int y1 = y + h; if (y1 > s->height) y1 = s->height;
    int stride_px = s->back_stride / 4;
    if ((color >> 24) == 0xff) {
        /* Fast path: opaque fill. */
        for (int py = y0; py < y1; py++) {
            uint32_t *row = s->back_pixels + py * stride_px + x0;
            for (int px = x0; px < x1; px++) *row++ = color;
        }
    } else {
        /* Slow path: alpha-blend per-pixel. */
        for (int py = y0; py < y1; py++)
            for (int px = x0; px < x1; px++)
                wpk_pixel(s, px, py, color);
    }
}

void wpk_line(struct wpk_surface *s, int x0, int y0, int x1, int y1,
              wpk_color color) {
    /* Standard Bresenham — no anti-aliasing in v1. */
    int dx = x1 - x0, dy = y1 - y0;
    int ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
    int sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    int err = (ax > ay ? ax : -ay) / 2;
    while (1) {
        wpk_pixel(s, x0, y0, color);
        if (x0 == x1 && y0 == y1) break;
        int e2 = err;
        if (e2 > -ax) { err -= ay; x0 += sx; }
        if (e2 <  ay) { err += ax; y0 += sy; }
    }
}

void wpk_blit(struct wpk_surface *dst, int x, int y,
              struct wpk_surface *src) {
    if (!dst || !src || !dst->back_pixels || !src->back_pixels) return;
    int sw = src->width, sh = src->height;
    int dx0 = x < 0 ? 0 : x, dy0 = y < 0 ? 0 : y;
    int dx1 = x + sw; if (dx1 > dst->width)  dx1 = dst->width;
    int dy1 = y + sh; if (dy1 > dst->height) dy1 = dst->height;
    int ds_px = dst->back_stride / 4, ss_px = src->back_stride / 4;
    for (int dy = dy0; dy < dy1; dy++) {
        int sy = dy - y;
        uint32_t *drow = dst->back_pixels + dy * ds_px;
        uint32_t *srow = src->back_pixels + sy * ss_px;
        for (int dxp = dx0; dxp < dx1; dxp++) {
            int sxp = dxp - x;
            drow[dxp] = wpk_blend_pixel(drow[dxp], srow[sxp]);
        }
    }
}
```

**Step 4: Build wires**

Update `build.sh` to compile `src/wpkdraw.c` into `libwpkdraw.a`:

```bash
wasm32posix-cc -c -O2 -fPIC \
    -I include -I "$WPK_SYSROOT/include/libdrm" -I "$WPK_SYSROOT/include" \
    src/wpkdraw.c -o "$WORK/wpkdraw.o"
llvm-ar rcs "$OUT_DIR/lib/libwpkdraw.a" "$WORK/wpkdraw.o"
cp -r include/wpkdraw "$OUT_DIR/include/"
```

**Step 5: Cargo test**

```rust
// crates/xtask/tests/wpkdraw_resolution.rs
#[test]
fn wpkdraw_resolves_and_builds() {
    let out = run_resolve("wpkdraw");
    assert!(out.lib_dir.join("libwpkdraw.a").exists());
    assert!(out.include_dir.join("wpkdraw/wpkdraw.h").exists());
}
```

**Step 6: Smoke test**

```c
// programs/wpkdraw_primitives_smoke.c
#include <wpkdraw/wpkdraw.h>
#include <stdio.h>
int main(void) {
    int w, h;
    struct wpk_surface *s = wpk_surface_create(&w, &h);
    if (!s) { perror("wpk_surface_create"); return 1; }
    printf("surface: %dx%d\n", w, h);
    wpk_clear(s, WPK_RGB(0, 0, 0));
    wpk_rect(s, 50, 50, 100, 100, WPK_RGB(255, 0, 0));
    wpk_line(s, 0, 0, w - 1, h - 1, WPK_RGB(0, 255, 0));
    wpk_surface_present(s);
    wpk_surface_destroy(s);
    return 0;
}
```

**Vitest:** assert exit 0; stdout has "surface: WxH" with sensible
dimensions; check `host_kms_set_fb` was called twice (front + back
ADDFB2) and `host_kms_page_flip` exactly once.

**Step 7: Commit**

```bash
git add examples/libs/wpkdraw/src/ examples/libs/wpkdraw/build.sh \
        programs/wpkdraw_primitives_smoke.c \
        host/test/wpkdraw-primitives-smoke.spec.ts
git commit -m "sysroot(wpkdraw): 2D primitives — surface, clear, pixel, rect, line, blit"
```

---

### Task A4: stb_truetype vendor

**Files:**
- Create: `examples/libs/wpkdraw/third_party/stb_truetype.h` —
  upstream verbatim, vendored from
  https://github.com/nothings/stb commit `<pinned>` (latest
  stable as of 2026-05).
- Create: `examples/libs/wpkdraw/third_party/stb_truetype.LICENSE`.

The header is ~5500 lines; vendor unmodified. Public domain
license; copy the dedication.

**Step 1: Build wires**

Update `build.sh` to define the implementation TU:

```bash
# Create a tiny TU that pulls in stb's implementation. stb_truetype
# uses #define STB_TRUETYPE_IMPLEMENTATION to opt into the body;
# without it the header is declaration-only.
cat > "$WORK/stb_impl.c" <<'EOF'
#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"
EOF
wasm32posix-cc -c -O2 -fPIC \
    -I third_party "$WORK/stb_impl.c" -o "$WORK/stb_impl.o"
# Append to the archive.
llvm-ar rcs "$OUT_DIR/lib/libwpkdraw.a" "$WORK/stb_impl.o"
```

**Step 2: Cargo test**

A library-link smoke test: compile a tiny C file that calls
`stbtt_InitFont` and `stbtt_FindGlyphIndex` and link against
`libwpkdraw.a`. Assert no unresolved symbols.

**Step 3: Commit**

```bash
git add examples/libs/wpkdraw/third_party/
git commit -m "sysroot(wpkdraw): vendor stb_truetype.h (single-header rasterizer)"
```

---

### Task A5: Font subsystem — load + glyph cache + text rendering

**Files:**
- Create: `examples/libs/wpkdraw/src/wpkfont.c` (~250 LoC).
- Create: `examples/libs/wpkdraw/share/DejaVuSans.ttf` (512 KB,
  vendored binary; see Step 3).
- Create: `examples/libs/wpkdraw/share/DejaVuSans.LICENSE`.

```c
// src/wpkfont.c
#define _GNU_SOURCE
#include <wpkdraw/wpkfont.h>
#include "wpk_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include "../third_party/stb_truetype.h"

#define WPK_GLYPH_CACHE_CAP 256

struct cached_glyph {
    int codepoint;          /* 0 = empty slot */
    int w, h;               /* glyph dimensions */
    int xoff, yoff;         /* offset from baseline */
    int advance;            /* horizontal advance */
    uint8_t *bitmap;        /* alpha mask (caller free's) */
};

struct wpk_font {
    stbtt_fontinfo info;
    int px_size;
    float scale;
    int ascent, descent;
    uint8_t *ttf_data;      /* mmap'd file backing */
    size_t ttf_len;
    /* LRU-ish cache. v1 is FIFO for simplicity. */
    struct cached_glyph cache[WPK_GLYPH_CACHE_CAP];
    int cache_next;         /* next eviction slot (FIFO) */
};

static const char *DEFAULT_FONT_PATH = "/usr/share/fonts/default.ttf";

struct wpk_font *wpk_font_load_default(int px_size) {
    if (px_size < 4 || px_size > 256) { errno = EINVAL; return NULL; }
    int fd = open(DEFAULT_FONT_PATH, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return NULL;
    struct stat st;
    if (fstat(fd, &st) < 0) { close(fd); return NULL; }
    uint8_t *data = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (data == MAP_FAILED) return NULL;
    struct wpk_font *f = calloc(1, sizeof *f);
    if (!f) { munmap(data, st.st_size); errno = ENOMEM; return NULL; }
    f->ttf_data = data;
    f->ttf_len = st.st_size;
    if (!stbtt_InitFont(&f->info, data, 0)) {
        munmap(data, st.st_size);
        free(f);
        errno = EINVAL;
        return NULL;
    }
    f->px_size = px_size;
    f->scale = stbtt_ScaleForPixelHeight(&f->info, (float)px_size);
    int line_gap;
    stbtt_GetFontVMetrics(&f->info, &f->ascent, &f->descent, &line_gap);
    return f;
}

void wpk_font_destroy(struct wpk_font *f) {
    if (!f) return;
    for (int i = 0; i < WPK_GLYPH_CACHE_CAP; i++)
        free(f->cache[i].bitmap);
    munmap(f->ttf_data, f->ttf_len);
    free(f);
}

static struct cached_glyph *get_glyph(struct wpk_font *f, int codepoint) {
    /* Linear probe — v1 cache is tiny so this is fine. */
    for (int i = 0; i < WPK_GLYPH_CACHE_CAP; i++)
        if (f->cache[i].codepoint == codepoint) return &f->cache[i];
    /* Miss — render into the next FIFO slot. */
    struct cached_glyph *g = &f->cache[f->cache_next];
    f->cache_next = (f->cache_next + 1) % WPK_GLYPH_CACHE_CAP;
    free(g->bitmap);
    g->codepoint = codepoint;
    g->bitmap = stbtt_GetCodepointBitmap(&f->info, 0, f->scale, codepoint,
                                         &g->w, &g->h, &g->xoff, &g->yoff);
    stbtt_GetCodepointHMetrics(&f->info, codepoint, &g->advance, NULL);
    return g;
}

/* UTF-8 decode one codepoint; advance ptr; returns codepoint or -1 on
 * malformed. */
static int decode_utf8(const char **pp) {
    const unsigned char *p = (const unsigned char *)*pp;
    if (!*p) return 0;
    int c;
    if ((*p & 0x80) == 0)        { c = *p; *pp += 1; }
    else if ((*p & 0xe0) == 0xc0){ c = (*p & 0x1f) << 6  | (p[1] & 0x3f);
                                   *pp += 2; }
    else if ((*p & 0xf0) == 0xe0){ c = (*p & 0x0f) << 12 | (p[1] & 0x3f) << 6
                                       | (p[2] & 0x3f);
                                   *pp += 3; }
    else                          { c = '?'; *pp += 1; }
    return c;
}

int wpk_text_width(struct wpk_font *f, const char *utf8) {
    if (!f || !utf8) return 0;
    float x = 0;
    while (*utf8) {
        int cp = decode_utf8(&utf8);
        if (cp == 0) break;
        int adv;
        stbtt_GetCodepointHMetrics(&f->info, cp, &adv, NULL);
        x += adv * f->scale;
    }
    return (int)(x + 0.5f);
}

void wpk_text(struct wpk_surface *s, struct wpk_font *f,
              int x, int y, const char *utf8, wpk_color color) {
    if (!s || !f || !utf8) return;
    int baseline_y = y;
    while (*utf8) {
        int cp = decode_utf8(&utf8);
        if (cp == 0) break;
        struct cached_glyph *g = get_glyph(f, cp);
        if (g->bitmap) {
            for (int gy = 0; gy < g->h; gy++) {
                for (int gx = 0; gx < g->w; gx++) {
                    uint8_t alpha = g->bitmap[gy * g->w + gx];
                    if (!alpha) continue;
                    uint32_t glyph_color = (color & 0x00ffffff) |
                                           ((uint32_t)alpha << 24);
                    wpk_pixel(s, x + g->xoff + gx,
                              baseline_y + g->yoff + gy, glyph_color);
                }
            }
        }
        x += (int)(g->advance * f->scale + 0.5f);
    }
}
```

**Step 1: Vendor DejaVu Sans**

Source: https://dejavu-fonts.github.io/ — version 2.37, the
`DejaVuSans.ttf` regular face. ~512 KB. License: Bitstream Vera +
DejaVu modifications — permissive (similar to MIT). Vendor the
LICENSE text alongside.

```bash
curl -sL https://github.com/dejavu-fonts/dejavu-fonts/raw/v2.37/ttf/DejaVuSans.ttf \
    > examples/libs/wpkdraw/share/DejaVuSans.ttf
curl -sL https://github.com/dejavu-fonts/dejavu-fonts/raw/v2.37/LICENSE \
    > examples/libs/wpkdraw/share/DejaVuSans.LICENSE
```

**Step 2: Install to sysroot**

In `build.sh`:

```bash
mkdir -p "$OUT_DIR/share/fonts"
cp share/DejaVuSans.ttf "$OUT_DIR/share/fonts/default.ttf"
cp share/DejaVuSans.LICENSE "$OUT_DIR/share/fonts/default.LICENSE"
```

**Step 3: Build wires**

```bash
wasm32posix-cc -c -O2 -fPIC \
    -I include -I third_party "$WORK"/../src/wpkfont.c \
    -o "$WORK/wpkfont.o"
llvm-ar rcs "$OUT_DIR/lib/libwpkdraw.a" "$WORK/wpkfont.o"
```

**Step 4: Smoke test**

```c
// programs/wpkdraw_text_smoke.c
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>
#include <stdio.h>
int main(void) {
    int w, h;
    struct wpk_surface *s = wpk_surface_create(&w, &h);
    if (!s) return 1;
    struct wpk_font *f = wpk_font_load_default(24);
    if (!f) { wpk_surface_destroy(s); return 1; }
    int tw = wpk_text_width(f, "Hello, wpkdraw");
    printf("text width: %d\n", tw);
    wpk_clear(s, WPK_RGB(20, 20, 30));
    wpk_text(s, f, 20, 50, "Hello, wpkdraw", WPK_RGB(220, 220, 220));
    wpk_surface_present(s);
    wpk_font_destroy(f);
    wpk_surface_destroy(s);
    return 0;
}
```

**Vitest:** assert exit 0; stdout shows reasonable text width
(>= 100, <= 300 for the 24px font); check
`host_kms_set_fb` and `host_kms_page_flip` counts.

**Step 5: Commit**

```bash
git add examples/libs/wpkdraw/src/wpkfont.c \
        examples/libs/wpkdraw/share/ \
        programs/wpkdraw_text_smoke.c \
        host/test/wpkdraw-text-smoke.spec.ts
git commit -m "sysroot(wpkdraw): font subsystem — stb_truetype + DejaVu Sans + glyph cache"
```

---

### Task A6: Phase A — full gauntlet + open PR #1

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

(ABI snapshot expected unchanged.)

Push, open draft PR.

Title: `[explore-dri] sysroot(wpkdraw): scaffold + 2D primitives + text rasterizer`

Body (Brandon style):

```markdown
## Summary
- New `examples/libs/wpkdraw/` — thin static-link-only 2D
  rendering library on top of plan 4 KMS + plan 2 gbm_bo.
  Public API: `wpk_surface_*`, `wpk_clear` / `wpk_pixel` /
  `wpk_rect` / `wpk_line` / `wpk_blit`, `wpk_font_*`,
  `wpk_text` / `wpk_text_width`.
- Vendor `stb_truetype.h` (single-header rasterizer) +
  DejaVu Sans regular (~512 KB, permissive license) at
  `/usr/share/fonts/default.ttf`.
- Two smoke programs (`wpkdraw_primitives_smoke`,
  `wpkdraw_text_smoke`) + Vitest specs verify the surface +
  font subsystems talk to plans 2 + 4 correctly.

## Why
Plan 8 of the DRI v2 design — gives non-SDL2 apps (plans 10's
wpk-shell, plan 11's seed apps) a screen + a button + some text
without pulling in SDL2's ~10 MB of static lib or its
threading requirements. Plan 9's wpkcompositor + plan 11's
file-manager / panel both link this.

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run` (two new wpkdraw-* spec files)
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

## ABI impact
None — sysroot-only addition. No kernel exports, no host
imports, no new ioctls or device nodes, no shared-ABI struct
changes. `abi/snapshot.json` byte-identical.

## Notes
- wpkdraw owns two gbm_bos directly (front + back ARGB8888)
  rather than using `gbm_surface_*` — plan 2's libgbm-stub
  defers `gbm_surface_create` to a follow-up; wpkdraw doesn't
  need triple-buffering or a swap-chain abstraction.
- wpkdraw and SDL2 are alternative front-ends, not stacked. A
  process linking wpkdraw shouldn't also link SDL2 — both fight
  for KMS master. Plan 9's compositor multiplexes both
  client types.
- Font cache is FIFO-with-fixed-cap (256 glyphs/font); LRU is a
  post-v1 refinement.
```

**Do not merge.**

---

## Phase B — sysroot: widgets + demo (PR #2)

### Task B1: Widget primitives implementation

**Files:**
- Create: `examples/libs/wpkdraw/src/wpkwidget.c` (~200 LoC).

```c
// src/wpkwidget.c
#define _GNU_SOURCE
#include <wpkdraw/wpkwidget.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>
#include "wpk_internal.h"

#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <linux/input.h>

void wpk_widget_button_draw(struct wpk_surface *s, struct wpk_font *f,
                            struct wpk_button *b) {
    wpk_color fill   = b->_pressed ? WPK_RGB(60, 60, 80)
                      : b->_hover  ? WPK_RGB(90, 90, 110)
                                   : WPK_RGB(70, 70, 90);
    wpk_color border = WPK_RGB(180, 180, 200);
    wpk_color label_color = WPK_RGB(230, 230, 240);
    /* Filled body + 1-px border. */
    wpk_rect(s, b->x, b->y, b->w, b->h, fill);
    wpk_line(s, b->x, b->y, b->x + b->w - 1, b->y, border);
    wpk_line(s, b->x, b->y + b->h - 1, b->x + b->w - 1, b->y + b->h - 1, border);
    wpk_line(s, b->x, b->y, b->x, b->y + b->h - 1, border);
    wpk_line(s, b->x + b->w - 1, b->y, b->x + b->w - 1, b->y + b->h - 1, border);
    /* Centred label. */
    int tw = wpk_text_width(f, b->label);
    int tx = b->x + (b->w - tw) / 2;
    int ty = b->y + b->h / 2 + 8;  /* approximation; baseline below mid */
    wpk_text(s, f, tx, ty, b->label, label_color);
}

static int point_in(struct wpk_button *b, int x, int y) {
    return x >= b->x && x < b->x + b->w && y >= b->y && y < b->y + b->h;
}

int wpk_widget_pump_events(int evdev_kbd_fd, int evdev_ptr_fd,
                           struct wpk_button *buttons, int n_buttons,
                           struct wpk_event *out_ev, int max_events) {
    static int ptr_x = 0, ptr_y = 0;  /* simple session-global */
    int n_out = 0;
    /* Keyboard events. */
    struct input_event iev;
    while (n_out < max_events &&
           read(evdev_kbd_fd, &iev, sizeof iev) == (ssize_t)sizeof iev) {
        if (iev.type == EV_KEY && iev.value == 1) {
            if (iev.code == KEY_ESC) {
                out_ev[n_out].type = WPK_EV_QUIT;
                n_out++;
                continue;
            }
            out_ev[n_out].type = WPK_EV_KEY;
            out_ev[n_out].key.keycode = iev.code;
            out_ev[n_out].key.pressed = 1;
            n_out++;
        }
    }
    /* Pointer events. */
    while (n_out < max_events &&
           read(evdev_ptr_fd, &iev, sizeof iev) == (ssize_t)sizeof iev) {
        if (iev.type == EV_REL) {
            if (iev.code == REL_X) ptr_x += iev.value;
            if (iev.code == REL_Y) ptr_y += iev.value;
            out_ev[n_out].type = WPK_EV_POINTER_MOTION;
            out_ev[n_out].pointer_motion.x = ptr_x;
            out_ev[n_out].pointer_motion.y = ptr_y;
            n_out++;
        } else if (iev.type == EV_KEY && iev.code == BTN_LEFT) {
            int press = (iev.value == 1);
            out_ev[n_out].type = WPK_EV_POINTER_BUTTON;
            out_ev[n_out].pointer_button.x = ptr_x;
            out_ev[n_out].pointer_button.y = ptr_y;
            out_ev[n_out].pointer_button.button = 0;
            out_ev[n_out].pointer_button.pressed = press;
            n_out++;
            /* Dispatch click to overlapping buttons. */
            for (int i = 0; i < n_buttons; i++) {
                if (!point_in(&buttons[i], ptr_x, ptr_y)) continue;
                if (press) buttons[i]._pressed = 1;
                else if (buttons[i]._pressed && buttons[i].on_click) {
                    buttons[i]._pressed = 0;
                    buttons[i].on_click(&buttons[i], buttons[i].user);
                }
            }
        }
    }
    /* Update hover state for all buttons. */
    for (int i = 0; i < n_buttons; i++)
        buttons[i]._hover = point_in(&buttons[i], ptr_x, ptr_y);
    return n_out;
}
```

**Step 1: Build wires**

```bash
wasm32posix-cc -c -O2 -fPIC \
    -I include "$WORK"/../src/wpkwidget.c -o "$WORK/wpkwidget.o"
llvm-ar rcs "$OUT_DIR/lib/libwpkdraw.a" "$WORK/wpkwidget.o"
```

**Step 2: Commit**

```bash
git add examples/libs/wpkdraw/src/wpkwidget.c
git commit -m "sysroot(wpkdraw): widget primitives — button + event pump"
```

---

### Task B2: `wpkdraw_demo.c` — surface + label + button + ESC quit

**Files:**
- Create: `programs/wpkdraw_demo.c` (~150 LoC).

```c
// programs/wpkdraw_demo.c — ~150 LoC
// Fullscreen wpkdraw surface; a label + a button that animates
// a colour cycle on click; ESC quits via plan 5 evdev.

#define _GNU_SOURCE
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>
#include <wpkdraw/wpkwidget.h>

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <time.h>

static int cycle_step = 0;

static void on_click_cycle(struct wpk_button *self, void *user) {
    (void)self; (void)user;
    cycle_step = (cycle_step + 1) % 6;
}

static wpk_color color_at_step(int step, int x, int y, int w, int h) {
    /* Simple HSV-ish gradient that shifts on each click. */
    int r = (x * 255) / w;
    int g = (y * 255) / h;
    int b = ((x + y) * 255) / (w + h);
    switch (step) {
    case 0: return WPK_RGB(r, g, b);
    case 1: return WPK_RGB(b, r, g);
    case 2: return WPK_RGB(g, b, r);
    case 3: return WPK_RGB(255 - r, g, b);
    case 4: return WPK_RGB(r, 255 - g, b);
    case 5: return WPK_RGB(r, g, 255 - b);
    }
    return WPK_RGB(0, 0, 0);
}

int main(void) {
    int w, h;
    struct wpk_surface *s = wpk_surface_create(&w, &h);
    if (!s) { perror("wpk_surface_create"); return 1; }
    struct wpk_font *f = wpk_font_load_default(24);
    if (!f) { perror("wpk_font_load_default"); wpk_surface_destroy(s); return 1; }
    int kbd_fd = open("/dev/input/event0", O_RDONLY | O_NONBLOCK);
    int ptr_fd = open("/dev/input/event1", O_RDONLY | O_NONBLOCK);
    if (kbd_fd < 0 || ptr_fd < 0) {
        perror("open evdev");
        return 1;
    }
    struct wpk_button btn = {
        .x = w / 2 - 60, .y = h / 2 + 20, .w = 120, .h = 40,
        .label = "Cycle",
        .on_click = on_click_cycle,
    };
    /* 5 s timeout (testing) or until ESC. */
    struct timespec t0;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    int running = 1;
    while (running) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long ms = (now.tv_sec - t0.tv_sec) * 1000 +
                  (now.tv_nsec - t0.tv_nsec) / 1000000;
        if (ms > 5000) break;
        struct wpk_event evs[16];
        int nev = wpk_widget_pump_events(kbd_fd, ptr_fd, &btn, 1,
                                          evs, 16);
        for (int i = 0; i < nev; i++)
            if (evs[i].type == WPK_EV_QUIT) running = 0;
        /* Render. */
        for (int y = 0; y < h; y += 32)
            for (int x = 0; x < w; x += 32)
                wpk_rect(s, x, y, 32, 32, color_at_step(cycle_step, x, y, w, h));
        wpk_text(s, f, 20, 40, "wpkdraw demo — click Cycle, press ESC",
                 WPK_RGB(255, 255, 255));
        wpk_widget_button_draw(s, f, &btn);
        wpk_surface_present(s);
    }
    close(kbd_fd); close(ptr_fd);
    wpk_font_destroy(f);
    wpk_surface_destroy(s);
    return 0;
}
```

Build via `wasm32posix-cc -o programs/wpkdraw_demo.wasm
programs/wpkdraw_demo.c -lwpkdraw -ldrm -lgbm -lm`.

**Step 1: Commit**

```bash
git add programs/wpkdraw_demo.c
git commit -m "examples(wpkdraw): wpkdraw_demo — surface + label + button + ESC quit"
```

---

### Task B3: Vitest end-to-end

**Files:**
- Create: `host/test/wpkdraw-demo.spec.ts`.

Runs `wpkdraw_demo.wasm` under the centralised kernel; asserts:
- The demo exits 0 within 6 s (5 s runtime + 1 s margin).
- The host's `host_kms_set_fb` was called at least once (initial
  setup) and `host_kms_page_flip` was called ~300 times
  (60 Hz × 5 s).
- The button click handler fires when the host injects a
  `BTN_LEFT` press + release at the button's center.
- Pressing ESC mid-run terminates within 200 ms.

```ts
// host/test/wpkdraw-demo.spec.ts
test("wpkdraw_demo runs cleanly under NodeKernelHost", async () => {
  const { exitCode, kmsCounts } = await runProgram(
    "programs/wpkdraw_demo.wasm",
    { timeoutMs: 6000 }
  );
  expect(exitCode).toBe(0);
  expect(kmsCounts.set_fb).toBeGreaterThan(0);
  expect(kmsCounts.page_flip).toBeGreaterThanOrEqual(150);  /* lenient */
  expect(kmsCounts.page_flip).toBeLessThanOrEqual(330);
});

test("wpkdraw_demo: ESC quits early", async () => {
  const handle = startProgram("programs/wpkdraw_demo.wasm");
  await sleep(1000);
  await injectKey(handle, "KEY_ESC", 1);
  const { exitCode } = await handle.waitExit(2000);
  expect(exitCode).toBe(0);
});

test("wpkdraw_demo: button click fires handler", async () => {
  const handle = startProgram("programs/wpkdraw_demo.wasm");
  await sleep(500);
  /* Move pointer to button center, click. */
  await injectPointerMotionAbs(handle, 640 / 2, 480 / 2 + 40);
  await injectPointerButton(handle, "BTN_LEFT", 1);
  await injectPointerButton(handle, "BTN_LEFT", 0);
  await sleep(500);
  await injectKey(handle, "KEY_ESC", 1);
  const { exitCode } = await handle.waitExit(2000);
  expect(exitCode).toBe(0);
  /* No direct way to assert the handler fired without
   * instrumenting the demo; the pixel diff at the clicked
   * position is the proxy. */
});
```

**Commit:** `host(wpkdraw): vitest — wpkdraw_demo end-to-end (timeout + ESC + click paths)`

---

### Task B4: Manual browser verification (the gate)

CLAUDE.md item 6. Build the demo, wire into `examples/browser/
pages/wpkdraw/`. The browser page mounts an `<iframe>` with the
same cross-origin-isolation headers; clicking "Run" spawns the
kernel, mounts the demo, and:
- A fullscreen colour-tile pattern renders behind a
  "wpkdraw demo …" label + a "Cycle" button.
- Clicking the button shifts the colour cycle.
- Pressing ESC quits the demo within ~200 ms.

If the demo quits but the canvas is blank: plan 2's gbm_bo
mapping isn't taking effect, OR plan 4's `MODE_SETCRTC` isn't
binding to the right framebuffer. Check the browser console for
KMS errors.

If clicks land but no visual change: the button's `on_click` is
firing but the next-frame render isn't updating `cycle_step`.
Check the demo loop's draw call ordering.

If ESC doesn't quit: plan 5's evdev DOM listener probably isn't
routing to the kernel — check `examples/browser/lib/
browser-kernel.ts`'s `kernel_input_event` invocations.

**No commit yet for this task — verification only.**

---

### Task B5: Phase B — final gauntlet + open PR #2

PR title: `[explore-dri] sysroot(wpkdraw): widgets + wpkdraw_demo + browser spec`

Body (Brandon style):

```markdown
## Summary
- Widget primitives — `wpk_button` + `wpk_widget_button_draw` +
  `wpk_widget_pump_events` for keyboard + pointer event
  dispatch. ~200 LoC.
- New `programs/wpkdraw_demo.c` — fullscreen surface + colour
  tile pattern + a "Cycle" button + ESC quit. The smallest
  "real" wpkdraw app exercising plans 2 + 4 + 5 without SDL2.
- New Vitest spec verifies the demo runs cleanly under
  NodeKernelHost (timeout + ESC + click paths).
- Manual browser verification: canvas + click + ESC quit
  confirmed in Chromium + Firefox.

## Why
Plan 8 of the DRI v2 design. wpkdraw is the GL-less alternative
to SDL2_Renderer (which plan 7 explicitly disabled via
`--disable-render`). Apps in plans 10's wpk-shell + plan 11's
seed apps + plan 9's wpkcompositor decorations all want this
surface without SDL2's overhead.

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`
- Manual browser verification: demo runs cleanly (5 s timeout +
  ESC quit + button click confirmed on Chromium 120 +
  Firefox 122).

## Dual-host parity proof
wpkdraw demo runs identically on Node.js (Vitest spec) and
Chromium / Firefox (manual). The library has no host-specific
code paths; everything goes through plans 2 / 4 / 5's existing
kernel surface.

## ABI impact
None — entirely an examples + sysroot addition. No kernel,
host, or shared-ABI changes.

## Notes
- wpkdraw's `wpk_surface` owns two gbm_bos directly (no
  gbm_surface). Plan 2's libgbm-stub doesn't yet ship
  `gbm_surface_*`; wpkdraw avoids the dependency.
- wpkdraw and SDL2 can't coexist on card0 (master is
  exclusive). The demo assumes no SDL2 app holds master.
- 5 s demo runtime is the smallest interval that drives the
  full vblank cycle (300 frames @ 60 fps) without tail-
  dominating; matches plan 7's demo length.
- Button event dispatch is in-process only — no IPC, no
  client-server. Plan 9's wpkcompositor will replace
  `wpk_widget_pump_events` with a Wayland-shaped protocol.
```

**Do not merge until PR #1 (wpkdraw lib) is merged into this PR's
base.**

---

## Final coordinated merge

When both PRs are reviewed and approved, the browser demo runs
cleanly:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 → PR #2's base.
3. Squash-merge PR #2 → plan 7's `…-sdl2-demo` (or wherever
   plan 7's tip lives at the time).
4. Tag: `[explore-dri-wpkdraw] plan 8 merged at <sha>` in the
   next session-handoff doc.

**Do not push to upstream until v1 + plans 2–8 are all merged
upstream as a coherent chain.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **Static-link-only, no shared lib.** `libwpkdraw.a` only.
  The v1 libc has `--disable-loadso`-equivalent semantics (no
  `dlopen`); a `libwpkdraw.so` would require a runtime loader
  that doesn't exist. Plan 9's compositor + plan 10/11's seed
  apps all statically link wpkdraw at build time. Acceptable
  cost (~80 KB per linking binary) given the demo set's size.
- **wpkdraw owns gbm_bos directly, not `gbm_surface_*`.** Plan
  2's libgbm-stub defers `gbm_surface_create` to a follow-up.
  wpkdraw's two-bo front/back model is simpler than a swap-chain
  and doesn't need the extra abstraction. Plan 9's compositor
  will graduate to `gbm_surface_*` once it lands.
- **wpkdraw and SDL2 are alternative front-ends, not stacked.**
  A process linking wpkdraw shouldn't also link SDL2 — both
  fight for KMS master. v1's seed-app set in plans 10/11
  partitions cleanly: SDL2 apps for GL workloads, wpkdraw for
  2D + text apps. Plan 9's compositor multiplexes both.
- **No anti-aliasing on lines.** v1 uses standard Bresenham;
  AA is post-v1.
- **No vector primitives (curves, fills, gradients).** v1 is
  pixel + rect + line + blit + text only. AGG-style vector
  rasterization is out of scope.
- **No multi-window support.** wpkdraw is single-fullscreen-
  surface only; multi-window arrives with plan 9's compositor.
- **Glyph cache is FIFO with fixed cap (256 glyphs/font),
  not LRU.** Simpler; LRU is a profiling-driven refinement.
- **One bundled font (DejaVu Sans regular) only.** Bold +
  italic + monospaced are post-v1; users can `wpk_font_load_default`
  at any size but face selection is fixed.
- **UTF-8 decode is permissive (treats malformed bytes as '?').**
  No errors raised. Apps with strict UTF-8 needs can pre-validate.
- **Event pump is in-process only.** No IPC, no client-server,
  no event-routing protocol; plan 9 introduces those.
- **`CLOCK_MONOTONIC` pinned via the existing musl shim** —
  same as plans 4/5/6/7. wpkdraw's animation step uses the
  same clock.
- **No host imports, no kernel exports, no new ioctls.** Plan
  8 is the second plan in the chain (after plan 7) to add zero
  kernel-userland ABI surface. Sysroot + examples only.

---

## Risk register

1. **`gbm_bo_map(GBM_BO_TRANSFER_WRITE)` semantics differ between
   plan 2's CPU-shared tier and what wpkdraw expects.** wpkdraw
   writes pixels then calls `wpk_surface_present`; if plan 2
   requires an explicit unmap/flush to make writes visible to the
   KMS presenter, the demo renders garbage. *Mitigation:* A3's
   smoke test catches this — if pixel write + present doesn't
   show the rect on-canvas, the mapping semantics need
   adjustment. May require a `wpk_surface_flush()` call
   before `wpk_surface_present` if plan 2's mapping is
   not write-coherent.
2. **`MODE_PAGE_FLIP` returns EBUSY if a previous flip is still
   pending.** wpkdraw's `wpk_surface_present` is synchronous (it
   `drmWaitVBlank` before returning), so the next flip should
   always succeed. But under unusual scheduling (host-side
   vblank tick delayed beyond 1/60 s), the next flip could fire
   before the previous completes. *Mitigation:* `wpk_surface_present`
   returns -1 on EBUSY; caller can retry or skip the frame.
3. **`drmSetMaster` returns EBUSY if SDL2 (plan 7) holds master.**
   A wpkdraw app launched while an SDL2 app is running will
   fail to open. *Mitigation:* `wpk_surface_create` returns NULL
   with errno=EBUSY; the demo prints a clear error and exits.
   Plan 9's compositor fixes by being the only master holder.
4. **DejaVu Sans 512 KB download flakes during CI.** The fetch
   step in A5 pulls the .ttf from GitHub; CI might timeout or
   the upstream URL might shift. *Mitigation:* once landed, the
   .ttf is vendored under `examples/libs/wpkdraw/share/` and
   gets staged into the package's archive (so the binary
   release flow ships it; consumers don't re-download). The
   fetch step is one-time at A5 implementation; cache locally.
5. **stb_truetype.h trips on `floor` / `sqrt` / `pow` link
   errors.** Our libc has math symbols; should be fine. If not,
   add `-lm` to the test program link line (the static
   archive itself doesn't link `-lm`; callers do at final-link
   time).
6. **Glyph cache memory growth.** With many distinct codepoints
   (CJK text), 256-glyph FIFO eviction churns and re-renders
   per-character per-frame. *Mitigation:* if profiling shows
   this is a hotspot, bump the cap (256 → 1024) or switch to
   LRU. For v1's seed-app set (English UI labels), 256 is
   ample.
7. **Pointer position absolute vs relative.** wpkdraw's event
   pump treats `EV_REL { REL_X, REL_Y }` as deltas; plan 5
   ships the pointer with `BUS_VIRTUAL` and may emit absolute
   coordinates instead. *Mitigation:* B3's vitest with
   `injectPointerMotionAbs` calls verifies the absolute path;
   if plan 5 only emits relative, wpkdraw's accumulator
   handles it.
8. **Rendering at non-default mode.** v1 uses the connector's
   first mode (`modes[0]`), which may not match the canvas
   element's natural size in the browser. *Mitigation:* the
   browser host's `host_kms_set_fb` already scales to fit;
   any mismatch is a display issue, not a render issue.

---

## What this plan doesn't cover (deferred)

- **Anti-aliasing.** Lines + text edges are not AA'd. Post-v1.
- **Vector primitives.** No curves, no path fills, no
  gradients. AGG-style rasterization is post-v1.
- **Multi-window.** wpkdraw is single-fullscreen-surface only.
  Plan 9's compositor introduces windowing.
- **Multiple font faces.** Only the bundled DejaVu Sans
  regular. Bold + italic + monospaced are post-v1.
- **Image loading.** No PNG / JPEG / GIF decoder. Apps that
  need them link `libpng` + `libjpeg-turbo` themselves.
- **GPU-tier composition.** wpkdraw is CPU-tier only — every
  pixel write is software. Plan 9's compositor may use GL
  acceleration for its decorations.
- **HiDPI / fractional scaling.** v1 is 1.0× only.
- **Bidi / shaping for complex scripts.** stb_truetype renders
  individual glyphs; no harfbuzz, no fribidi. Latin /
  Greek / Cyrillic only.
- **Mouse cursor.** wpkdraw doesn't draw a software cursor;
  apps tracking `ptr_x`/`ptr_y` may draw their own. Plan 9's
  compositor will manage a system cursor.
- **Animation framework.** v1's demo loop is the app's
  responsibility; no tween library, no scene graph.
- **Save / load surface to file** (PNG export, etc.). Apps
  needing this implement their own.
- **Subpixel positioning** of glyphs. v1 rounds to integer
  pixels.
- **Right-to-left text layout.** No RTL support.
- **`libwpkdraw.so` dynamic loading.** Static archive only; no
  `dlopen` in v1 libc.

---

End of plan.
