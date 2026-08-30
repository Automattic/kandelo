# DRI v2 — wpkcompositor plan (PID 2 compositor + custom protocol + libxkbcommon + libinput-real)

> **⚠️ SUPERSEDED (2026-07-08) by
> [`2026-07-08-dri-wayland-compositor-plan.md`](2026-07-08-dri-wayland-compositor-plan.md).**
> The project pivoted the compositor + userland half of DRI from this custom
> wire protocol to **Wayland**. `wpkcompositor`, `libwpkclient`, and the
> 24-message custom wire are dropped before being written; seed apps become
> Wayland clients. The reusable parts (real libxkbcommon, real libinput, KMS
> master, `gbm_surface`, prime-fd + SCM_RIGHTS) survive under the new plan's
> PR4/PR5. Kept below as history only.

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Ship `examples/programs/wpkcompositor/` — a small (~1.2 kLoC)
wasm32 program that the kernel boots at PID 2, takes KMS master on
`/dev/dri/card0`, listens on `/run/wpk/comp` (unix socket), and
multiplexes SDL2 + wpkdraw client surfaces onto a single
OffscreenCanvas via plan 4's KMS + plan 2's gbm_bo prime-fd
sharing. Plus three new sysroot libraries — `libwpkclient.a`
(client-side wire to the compositor), `libxkbcommon.a` (real
upstream port; SDL2 + the compositor both link this for keymap
translation), and `libinput.a` (real upstream port; replaces plan
7's `libinput-lite` stub with gesture + palm-rejection +
multi-device fan-out). Plus a one-line wpkdraw amendment that
detects the compositor socket and switches between "direct KMS
master" mode (no compositor) and "compositor client" mode
(SCM_RIGHTS prime-fd over the socket). Together these close
the load-bearing gaps in plans 7 (SDL2 audio thread / KMS master
contention) and 8 (wpkdraw and SDL2 alternative front-ends, not
stacked).

**Architecture:** Five PRs (one per phase). The compositor is a
single C program plus three new packages and a wpkdraw
follow-up amendment. Each surface is one in-tree component:

1. **`examples/programs/wpkcompositor/main.c`** (~1.2 kLoC) — the
   PID-2 compositor server. Boot, take KMS master, set up EGL +
   gbm_surface on card0, listen on `/run/wpk/comp`. Event loop is
   `poll([card0, sock, libinput_fd], -1)` dispatching to:
   - `card0` POLLIN → drain `drm_event_vblank` records (page flip
     completion + WAIT_VBLANK ticks); advance frame composition.
   - `sock` POLLIN → `accept(2)` new client; per-client state in a
     `compositor_client` struct.
   - per-client fds POLLIN → drain wire messages
     (CREATE_SURFACE / ATTACH_BUFFER / COMMIT / SET_TITLE /
     SET_TYPE / etc., 24 message types per design §9.2).
   - `libinput_fd` POLLIN → `libinput_dispatch`; route events to
     the focused client via INPUT_* messages on its socket.
2. **`examples/libs/libwpkclient/`** — client-side static lib
   that SDL2 + wpkdraw link to talk to the compositor.
   Public API:
   - `wpk_client_connect(path)` — opens AF_UNIX socket; returns
     opaque handle or NULL if the compositor isn't running
     (callers fall back to direct KMS).
   - `wpk_client_create_surface(c, w, h, format) → surface_id`.
   - `wpk_client_attach_buffer(c, surface_id, prime_fd)` —
     sends `ATTACH_BUFFER` + the fd via `SCM_RIGHTS`.
   - `wpk_client_commit(c, surface_id)`.
   - `wpk_client_poll(c, &events, n_events)` — drain INPUT_* +
     FOCUS_* + WINDOW_CLOSE messages into a caller buffer.
   ~250 LoC static archive; no .so.
3. **`examples/libs/libxkbcommon/`** — port of upstream libxkbcommon
   1.6.0 (latest stable as of 2026-05). Build subset:
   `libxkbcommon.a` only (no libxkbcommon-x11 / -compose /
   -registry); pulls in the Compose key handling separately if
   plan 11 needs it. ~150 KB static archive after dead-code
   elimination. Used by the compositor (for KEY_* → text /
   modifier state) AND by SDL2 (already; plan 7's
   `--disable-libudev` doesn't disable xkbcommon).
4. **`examples/libs/libinput/`** — port of upstream libinput
   1.25.0. Build with `--disable-libwacom --disable-documentation`
   (we don't ship tablets in v1). Replaces plan 7's
   `libinput-lite` stub. Adds: gesture detection (swipe / pinch),
   palm rejection (basic — distance from touch start), multi-
   device fan-out (libinput auto-discovers `/dev/input/event*`).
   ~400 KB static archive.
5. **wpkdraw amendment (`examples/libs/wpkdraw/src/wpkdraw.c`)** —
   add a 50-LoC fork in `wpk_surface_create`: if
   `connect("/run/wpk/comp", …)` succeeds, switch to "compositor
   client mode" — allocate bos via plan 2's renderD128 (no master
   needed), pass prime fds to the compositor via libwpkclient.
   Else fall back to the existing "direct KMS master mode".
   Plan 8's body stays unchanged; the amendment is in a new
   internal function `wpk_surface_create_via_compositor` and a
   one-line dispatch in `wpk_surface_create`.

**Tech Stack:**
- Userland C: C99 with `wasm32posix-cc`; static archives only.
- Compositor program: `examples/programs/wpkcompositor/main.c`
  cross-compiles to `wpkcompositor.wasm`; installed by the
  rootfs-build step at `/usr/bin/wpkcompositor`. Init reads
  `/etc/wpk/compositor` (a one-line config) to decide whether
  to fork-exec it as PID 2.
- Wire format: the design doc §9.2 binary frame
  (`u32 length | u32 type | u8 payload[]`). 24 message types
  in v1; serialised hand-rolled in C, no protobuf, no flatbuffers.
- Buffer sharing: client → compositor via plan 2's prime fd +
  `SCM_RIGHTS` over the AF_UNIX socket. **This requires
  plan-6-sockets-plan's SCM_RIGHTS path landed** (see plan 2's
  "What this plan doesn't cover", line 1872+).
- Input: libinput auto-discovers `/dev/input/event0` (kbd) +
  `event1` (ptr) via plan 5's seat-shared model; the compositor
  is the single libinput consumer in v1.
- Keymap: libxkbcommon — the compositor loads the default keymap
  on init and translates KEY_* + EV_KEY values into XKB keysyms
  + modifier states for INPUT_KEYBOARD messages.

**Companion design doc:** `docs/plans/2026-05-18-dri-design.md`
§9 (compositor + userland), §9.1 (boot sequence), §9.2 (custom
protocol), §9.5 (why custom, not Wayland — Wayland is 6 weeks,
custom is 1 week), §6.3 (vblank events on card0 read side), §5.4
(compositor's privileged hooks).

**Critical wasm32 ABI detail:** the compositor protocol is
entirely userspace — every byte goes through the existing
`socket(AF_UNIX)` + `sendmsg(SCM_RIGHTS)` + `read` /
`write` syscalls. **Zero kernel exports added.** Zero host
imports added. The plan-6-sockets-plan's SCM_RIGHTS is the only
kernel surface this plan depends on (and it should land before
plan 9 starts implementation; if it hasn't, plan 9 carries an
inline sub-plan to finish it).

**Clock source:** All four new components use `clock_gettime(
CLOCK_MONOTONIC, …)` via the musl shim — cross-stream parity with
plans 4/5/6/7/8.

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §9
(compositor), §9.2 (wire format), §9.5 (custom-vs-Wayland
trade-off; 1 week vs 6 weeks).

**Consistency with plans 2 + 4 + 5 + 6 + 7 + 8:**

- **No new kernel exports.** All compositor surface is userspace
  C over plans 2/4/5/6's existing kernel ioctls + plans 2/3's
  GL stack follow-up + plan-6-sockets's SCM_RIGHTS.
- **Plan 4's KMS master semantics drive the compositor's
  exclusivity.** Once wpkcompositor takes master on card0, no
  other process can `drmSetMaster` until the compositor drops or
  dies. Plan 8 (wpkdraw direct KMS mode) + plan 7 (SDL2 KMSDRM
  backend) are *demoted to compositor clients*: their direct-KMS
  paths still work (boot without the compositor) but won't
  coexist with it. The wpkdraw amendment + a parallel SDL2
  backend amendment (plan 11) handle the demotion gracefully.
- **Plan 5's seat-shared evdev model is the compositor's input
  pipeline.** libinput opens event0 + event1 (via
  `libinput_path_add_device`), and *because the compositor is
  the only libinput consumer in v1*, the seat-shared fanout (every
  open OFD sees every event) doesn't cause double-delivery — only
  the compositor has the fds open. Client surfaces don't open
  evdev directly under this design; they receive INPUT_* messages
  over the wire.
- **Plan 6's ALSA path is independent.** The compositor doesn't
  manage audio routing in v1; audio clients (SDL2, future
  wpkdraw audio apps) talk to `/dev/snd/*` directly. Plan 6's
  per-quantum tick model + non-blocking WRITEI + POLLOUT (per
  plan 7 open-architecture #1 resolution) still operate
  unchanged.
- **Plan 7's SDL2 audio thread** decision (option (b): non-
  blocking WRITEI + SDL2 polling patch, lean from plan 7 review)
  is independent of plan 9. The compositor doesn't need
  threading; its event loop is single-threaded `poll(2)`.
- **Plan 8's wpkdraw direct-KMS path is preserved.** The
  amendment is additive: detect compositor → switch to client
  mode; absent compositor → keep direct KMS master.
- **GL stack follow-up (plan 2 + plan 3 amendments) must land
  before this plan starts.** The compositor's EGL surface creation
  + gbm_surface_lock_front_buffer + libGLESv2 draw calls all
  depend on the libegl-stub + libgles2-stub + gbm_surface
  follow-ups documented in plans 2 + 3's reviews. This is the
  same blocking dependency plan 7 PR #2 carries; plan 9 inherits
  it. **Block plan 9 implementation start on the GL stack
  follow-up PRs landing.**

**Stack base:** Plan 8's `…-wpkdraw-demo` branch tip (plan 8's
PR #2 head). The compositor needs everything from plans 2–8 plus
the plan 2 + 3 GL stack follow-ups. If the follow-ups haven't
landed by impl time, rebase onto their tips first.

**Branch:** `emdash/explore-direct-rendering-infrastructure-wpkcompositor-plan-XXXXX`
(chains off plan 8's tip per the branching rule). Five sub-branches
stack off it for the five PRs.

**Final PR base:** Plan 8's `…-wpkdraw-demo` tip. **Do not merge**
until Brandon validates the design, plan-6-sockets-plan's
SCM_RIGHTS path has landed, the plan 2 + 3 GL stack follow-ups
have landed, and Phase E's manual browser verification confirms
the compositor multiplexes SDL2 + wpkdraw clients correctly.

**Five PRs, coordinated merge.** Each task below is one commit.
PR titles use Brandon's `scope(area): action` shape:

1. `sysroot(input): libxkbcommon — real upstream port`
2. `sysroot(input): libinput — real upstream port replacing libinput-lite`
3. `sysroot(wpk): libwpkclient — compositor client wire`
4. `examples(wpk): wpkcompositor — PID 2 server + custom protocol`
5. `sysroot(wpkdraw)+examples(wpk): wpkdraw compositor-client mode + demo + browser spec`

PR base/head topology (stacked):

```
… (plans 2–8 tips + plan 2/3 GL stack follow-ups)
 └── …-wpkdraw-demo                       (plan 8 PR #2 tip)
      └── …-wpkcompositor-plan-XXXXX      (this plan PR base)
           └── …-wpk-xkbcommon            (PR #1)
                └── …-wpk-libinput        (PR #2)
                     └── …-wpkclient      (PR #3)
                          └── …-wpkcompositor      (PR #4)
                               └── …-wpk-demo      (PR #5)
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
regression. Phase E adds manual `./run.sh browser` verification
(CLAUDE.md item 6) — the compositor boots at PID 2, an SDL2 +
GLES2 demo and a wpkdraw demo both connect, both visibly render in
distinct compositor-decorated windows, focus + click + ESC work
across both.

**ABI impact:** **None.** Plan 9 adds zero kernel exports, zero
host imports, zero new ioctls, zero new device nodes. Every byte
crosses the kernel-userland ABI via existing surfaces from plans
2/4/5 + plan-6-sockets (SCM_RIGHTS). `ABI_VERSION` does not bump;
`abi/snapshot.json` is byte-identical.

The sysroot grows substantially: `sysroot/lib/libxkbcommon.a`
(~150 KB), `sysroot/lib/libinput.a` (~400 KB),
`sysroot/lib/libwpkclient.a` (~30 KB code), `sysroot/include/{xkbcommon,libinput,wpkclient}/`,
the compositor binary at `/usr/bin/wpkcompositor` (~600 KB
including its statically linked deps), plus default keymaps under
`/usr/share/X11/xkb/` (~2 MB; libxkbcommon's data files —
permissive license, vendored). Package index ledger gets three
new entries.

Existing kernel + host + ABI surfaces — all unchanged.

---

## Pre-implementation review

Devil's-advocate + consistency pass run 2026-05-19 (session 10),
after plan 9 drafted in session 9. Pass covers: focus areas from the
hand-off-9 sentinel (SCM_RIGHTS round-trip with plan-6-sockets,
libinput's path-mode under plan 5's seat-shared fanout, xkbcommon
data-files rootfs bloat budget, compositor crash → client orphan
recovery, `gbm_surface` triple-buffer ring vs plan 4's PAGE_FLIP
throttle, libxkbcommon + libinput cross-compile risk, single-
libinput-consumer invariant, custom protocol scope vs design §9.2's
24-message inventory, PID 2 boot ordering vs init's existing shell-
spawn), plus a code-level re-read of every C snippet in the plan
body — `main.c`, `compositor_handle_attach_buffer`,
`compositor_handle_commit`, `compositor_handle_libinput_event`,
`compositor_event_loop`, `wpk_surface_create_via_compositor`,
`wpk_surface_present_via_compositor`, `wpk_widget_pump_events_via_compositor`,
plus a re-audit of `docs/plans/2026-03-08-phase6-sockets-plan.md` for
plan 9's SCM_RIGHTS dependency. Findings are structured Brandon-style.
Inline fixes (18) are **folded conceptually** — plan body retains
pre-review text per the Brandon convention; implementation applies
each fix per this section. Five cross-plan amendments leak back into
plans 2 + 4 + 5 + 7 + 8 reviews; the load-bearing open-architecture
items (3) gate plan 9 implementation start.

### Inline fixes (18 — folded conceptually; plan body unchanged)

1. **`wpk_surface_present_via_compositor` re-introduces plan 8's
   gbm_bo_map per-frame leak.** Plan 8's review fix #4 cached both
   bo mappings at `wpk_surface_create` time and swapped a single
   `back_pixels` pointer between them on each present (no remap).
   Plan 9 E1 (lines 1396-1415) calls
   ```c
   s->back_pixels = gbm_bo_map(s->bo_back, 0, 0, s->width, s->height,
                               GBM_BO_TRANSFER_WRITE, NULL, &s->back_map_data);
   ```
   on **every** `wpk_surface_present_via_compositor` invocation
   without `gbm_bo_unmap` of the previous mapping. Same regression
   shape plan 8 #4 closed. **Lean:** cache both mappings at
   `wpk_surface_create_via_compositor` time (line 1384 already does
   this for `bo_back`; add the symmetric `bo_front` mapping at
   create time), store `front_pixels` + `back_pixels` + their
   `map_data` slots on `struct wpk_surface`, and swap pointer
   references on present without re-mapping. Cross-plan amendment
   added to plan 8's review noting fix #4 extends to E1.
2. **`compositor_handle_attach_buffer` hard-codes
   `stride = width * 4`.** Plan 9 D3 (line 1142) computes the
   import stride as `s->width * 4`, assuming ARGB8888 and a
   tightly-packed row. Client bos allocated with
   `GBM_BO_USE_LINEAR` (the only tier `gbm_bo_get_fd` can export
   in v1 per plan 2's SAB-backed model) MAY have pitch alignment
   (4 KiB-aligned strides are common). The compositor's
   `gbm_bo_import` with the wrong stride → garbled texture.
   **Lean:** the wire-format `wpk_msg_attach_buffer` payload must
   carry `stride: u32` alongside `surface_id` (and optionally a
   `format: u32` override in case the client renegotiates). The
   importer uses the wire-supplied stride, not a recomputed
   `width * 4`. Fold into C2's wire format + D3's import code.
3. **`compositor_handle_libinput_event` only handles
   `LIBINPUT_EVENT_POINTER_MOTION` (relative), not
   `LIBINPUT_EVENT_POINTER_MOTION_ABSOLUTE`.** Plan 5's
   cross-plan amendment from plan 8's review (lines 533-534 of
   plan 5) confirms that the default-state browser pointer
   emits EV_ABS, which libinput translates to
   `POINTER_MOTION_ABSOLUTE` (NOT `POINTER_MOTION`). Plan 9 D4
   (line 1224-1242) handles only the relative arm. Without the
   absolute arm, the compositor cursor never moves on default-
   browser (unlocked) input — the exact same failure mode as
   plan 8 fix #1. **Lean:** add a parallel arm:
   ```c
   case LIBINPUT_EVENT_POINTER_MOTION_ABSOLUTE: {
       struct libinput_event_pointer *p = libinput_event_get_pointer_event(ev);
       double ax = libinput_event_pointer_get_absolute_x_transformed(p, c->screen_w);
       double ay = libinput_event_pointer_get_absolute_y_transformed(p, c->screen_h);
       c->cursor_x = ax; c->cursor_y = ay;
       compositor_clamp_cursor(c);
       /* …hit-test + route as relative path… */
       compositor_mark_dirty();
       break;
   }
   ```
   Fold into D4. Risk register #4 (libinput filter chain on
   synthetic devices) is correct in spirit but doesn't catch
   this — the issue isn't filtering quality, it's a missing
   event arm. Bump risk register #4 to also reference inline
   fix #3.
4. **Compositor never grabs evdev devices with EVIOCGRAB.** Plan
   5's seat-shared model fans every event to every open OFD on
   `/dev/input/event*`. Plan 5 explicitly punted exclusivity to
   plan 9 (plan 5 lines 224-230: "plan 9 does enforce cross-fd
   exclusivity"). Plan 9 D2 sets `compositor_open_restricted`
   (line 1080) as libinput's open hook but libinput by default
   does NOT call EVIOCGRAB. Without it, a co-running wpkdraw-
   direct (boot path: compositor not started → wpkdraw takes
   master, opens evdev → user starts compositor → wpkdraw stays
   alive, compositor also opens evdev → double-delivery of every
   keypress) breaks both processes silently. **Lean:** amend
   `compositor_open_restricted` to call
   `ioctl(fd, EVIOCGRAB, (int){1})` after open and ignore the
   return (v1 plan 5 records the grab flag without enforcement;
   plan 9's grab is the enforcement — see open-architecture #2
   below for the load-bearing follow-up). Fold into D2.
5. **`accept` without `SOCK_CLOEXEC` propagation.** D2 line
   1069 sets `SOCK_CLOEXEC` on the listener but Linux `accept(2)`
   does NOT inherit `O_CLOEXEC` onto accepted fds. The implicit
   accept in `compositor_accept_client` (referenced at D5 line
   1272) must use `accept4(c->sock, NULL, NULL, SOCK_CLOEXEC)`,
   otherwise client fds leak across any future fork-exec (init's
   crash-restart of the compositor would inherit stale client
   sockets). Hygiene; fold into D5's `compositor_accept_client`.
6. **D2 boot path has no `goto err_*` cleanup chain.** On any
   failure between `drmSetMaster` (line 1056) and the event
   loop, `main()` returns 1 directly. Plan 4 (lines 403-406)
   confirms master is auto-dropped on OFD-final-close, so the
   master itself doesn't leak across process exit — but the
   following resources do during partial init: `C.gbm`
   (`gbm_destroy_device`), `C.gbm_surface`
   (`gbm_surface_destroy`), `C.egl_dpy` (`eglTerminate`),
   `C.sock` (still bound; the `unlink` happens at next start),
   `C.input` (`libinput_unref`), `C.xkb_state` / `_keymap` /
   `_ctx` (each has an `unref`). The pattern Brandon would write
   matches plan 8 A3's `err_gbm: → err_master: → err_close:`
   goto chain. **Lean:** add a goto-chain to D2 mirroring plan
   8's pattern; install a single `signal(SIGTERM, set_quit)` so
   the event loop's normal exit path triggers the same cleanup.
   Fold into D2.
7. **Missing `SIGTERM`/`SIGINT` handler.** The compositor at
   PID 2 will receive `SIGTERM` from init on system shutdown (or
   a user-driven kill). Without `signal(SIGTERM, set_quit_flag)`,
   default termination skips the cleanup chain from fix #6.
   Master is still released (OFD-final-close per plan 4) but
   `/run/wpk/comp` socket file persists until the next compositor
   start (which unlink+rebinds per D2 line 1072 — so functional,
   but cosmetically stale on `ls /run/wpk/`). Add the handler.
   Risk register #9 acknowledges the leak; the handler closes
   the cosmetic loophole.
8. **Event-loop render path can exhaust the gbm_surface ring.**
   Per plan 2 follow-up, `eglSwapBuffers` semantically calls
   `gbm_surface_lock_front_buffer`, rotating the draw bo into
   the locked-by-scanout set. Plan 4 enforces one in-flight flip
   per (CRTC, OFD); a second `eglSwapBuffers` issued before the
   first's FLIP_COMPLETE arrives → either EBUSY (the inner
   page-flip ioctl) or — depending on the EGL stub's gating —
   silently consumes the next free bo, returning an undrawn
   front. With a 3-bo ring, three successive `dirty` ticks
   without a FLIP_COMPLETE drain (from a stalled vblank) exhaust
   the ring. Risk register #3 documents the issue but D5's loop
   (line 1268) only gates `poll(timeout = dirty ? 0 : -1)` and
   then unconditionally renders if `c->dirty`. **Lean:** add a
   guard
   ```c
   if (c->dirty && gbm_surface_has_free_buffers(c->gbm_surface)) {
       compositor_render_frame(c);
       c->dirty = 0;
   }
   ```
   so a full ring stalls one frame instead of erroring or
   silently corrupting. Fold into D5.
9. **`compositor_pick` hit-test ordering not specified.** D4
   line 1231 calls `compositor_pick(c, c->cursor_x, c->cursor_y)`
   but the function (referenced, not shown) must iterate in
   **reverse z-order** (topmost surface first) to find the
   correct click target — the same surface render order (line
   1170) used for compositing iterates bottom-up (panels →
   toplevels → popups). Plan 9 should explicitly note the
   reverse iteration to prevent the obvious mistake at impl
   time. Document in D3 alongside `compositor_register_surface`.
10. **`compositor_drain_client` framing-state contract.** D5
    line 1287-1288 calls `compositor_drain_client(c, fds[i].fd)`
    but the function (referenced) must handle **partial reads**
    — a 64-byte `wpk_msg` header may arrive in two `read` calls
    if the kernel socket buffer is split, or `read` may return
    a multiple of `sizeof(struct wpk_msg)` plus a partial trailing
    payload. The client-side libwpkclient's `wpk_client_poll`
    (C3 lines 916-924) uses `MSG_PEEK` to probe the header
    length before consuming, but the server-side
    `compositor_drain_client` is not specified. **Lean:** every
    `compositor_client` carries an `inbuf[4096]` + `inbuf_used`
    state; `compositor_drain_client` reads into the tail of the
    buffer, then walks fully-arrived frames. Fold into D3
    alongside `struct compositor_client`.
11. **`accept(2)` overflow past `MAX_CLIENTS`.** D5 line 1260
    sizes `struct pollfd fds[2 + 1 + MAX_CLIENTS]` with
    `MAX_CLIENTS` undefined in the snippet. If
    `compositor_accept_client` blindly accepts past the cap, the
    pollfd array overflows on the next loop iteration → stack
    smash. **Lean:** define `#define MAX_CLIENTS 16` (matching
    `listen(c->sock, 16)` on line 1076), and have
    `compositor_accept_client` reject the 17th accept with an
    immediate `close()` of the new fd plus a "compositor full"
    error frame on it (or silently close — design choice for
    plan 9). Fold into D5.
12. **24-message-type protocol — count discrepancy with design
    §9.2.** Design §9.2 enumerates ~16 named message types
    (CREATE_SURFACE, DESTROY_SURFACE, ATTACH_BUFFER, COMMIT,
    SET_TITLE, SET_TYPE, INPUT_KEYBOARD, INPUT_POINTER_MOTION,
    INPUT_POINTER_BUTTON, INPUT_POINTER_AXIS, FOCUS_IN, FOCUS_OUT,
    CLIPBOARD_SET, CLIPBOARD_REQUEST, CLIPBOARD_DATA,
    WINDOW_CLOSE). Plan 9 claims "24 message types per design
    §9.2" at lines 87, 336, 1338, 1567 + Phase E PR body. The
    delta (~8) is most likely (a) request/reply pairs counted
    separately (CREATE_SURFACE_REPLY is one such; plan 9 C2 line
    884 references it), (b) reserved/v2 types pre-allocated, or
    (c) drift between design + plan. Either reconcile or
    enumerate explicitly. **Lean:** plan 9 C2 ships an enum
    `WPK_MSG_*` with all 24 constants, name-mapped to design
    §9.2's table, and the message-handler dispatch in D5
    explicitly switches on every one (most as no-ops for v1, with
    a `default → log "unknown frame; v1 ignores forwards-compat"`
    fallback already at C3 line 942). Without this, the design
    §9.5 trade-off ("custom = 1 week, Wayland = 6 weeks") loses
    its scope discipline. Cross-plan amendment to the design doc
    is NOT required (the design is permissive on count); the
    discipline is plan 9's. See open-architecture #1 below.
13. **`gbm_bo_import` cookie path not exercised in plan 9.**
    Per design §13, prime fds carry `OpenFileKind::PrimeBo {
    bo_id, cookie }` and `gbm_bo_import` MUST internally call
    `DRM_IOCTL_PRIME_FD_TO_HANDLE` (which checks cookie +
    bumps refcount) before returning a usable bo. Plan 2's
    libgbm follow-up doesn't explicitly state that `gbm_bo_import`
    is the wrapper around `prime_fd_to_handle`. Plan 9 D3
    (line 1145) calls `close(prime_fd)` immediately after
    `gbm_bo_import` with the comment "gbm_bo holds a kernel-
    side ref" — this is **only safe** if the import call
    actually issued `PRIME_FD_TO_HANDLE` under the hood (which
    bumps the kernel-side bo refcount). If the libgbm stub
    merely stashed the fd, the close is a use-after-free.
    **Lean:** cross-plan amendment to plan 2 — the `gbm_bo_import`
    wrapper in libgbm-stub MUST issue `DRM_IOCTL_PRIME_FD_TO_HANDLE`
    before returning, full-stop. Document the contract in plan
    2's follow-up amendment block. Fold into plan 2's review.
14. **`gbm_surface_create` flags vs plan 2's LINEAR-only ring.**
    Plan 9 D2 (line 1063-1064) requests
    `GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING` on the
    compositor's gbm_surface. Plan 2's follow-up ring is
    SAB-backed (LINEAR modifier; no GPU-side restrictions).
    SCANOUT-on-LINEAR is fine for a software KMS path (host
    composites the surface into the OffscreenCanvas) but
    RENDERING-on-LINEAR means the EGL stub renders into the
    SAB-mapped bo and the host's GL context samples it as a
    foreign texture via `WPK_BIND_FOREIGN_TEXTURE`. **Lean:**
    confirm at plan 2 impl time that the ring honors
    `SCANOUT | RENDERING` together; v1's stub should treat
    them as equivalent (always LINEAR, always SAB-backed).
    Document in plan 2's follow-up.
15. **EVDEV → XKB keycode offset uses unexplained magic
    number `+ 8`.** D4 line 1202 `xkb_keycode_t kc = key + 8;`
    is the standard X11-keycode-space-vs-evdev-keycode-space
    offset (X11 keycodes start at 8; evdev at 0). Correct but
    non-obvious. **Lean:** replace with a documented constant
    `#define XKB_EVDEV_OFFSET 8` and a one-line comment "XKB
    keycodes = evdev + 8 (X11 historical offset)". Fold into
    D4.
16. **Compositor + libwpkdraw double-link of stb_truetype.h.**
    D6 statically links `libwpkdraw.a` for decorations + cursor.
    `libwpkdraw.a` itself embeds `stb_truetype.h` (plan 8 A4)
    via `STB_TRUETYPE_IMPLEMENTATION`. If the compositor binary
    also includes `stb_truetype.h` (it might, if any source
    file pulls it in for an unrelated reason), the linker hits
    duplicate-symbol errors. **Lean:** the compositor `#include`s
    `<wpkdraw/wpkdraw.h>` (the public header, which forward-
    declares `wpk_font` opaquely) and never the implementation
    header. Verify at impl time: `nm wpkcompositor.wasm | grep
    stbtt_` should show exactly one resolution. Fold into D2's
    include policy comment.
17. **xkbcommon data files at `/usr/share/X11/xkb` — 2 MB
    rootfs bloat budget.** A3 vendors ~30 keymap files (rules +
    types + compat + keycodes + symbols). v1's WordPress demo
    rootfs is ~30 MB; +2 MB is 6.7% — material but tolerable.
    Risk register #5 documents the bloat. **Lean:** A3 strips
    to absolute minimum (us layout only, no other layouts).
    Verify the strip size empirically — `du -sh share/X11/xkb/`
    on the assembled tree. If it exceeds 2 MB, drop
    `rules/evdev.lst` (the per-layout description table) which
    is the largest single file at ~1.5 MB and not needed for
    runtime keymap resolution (only `xkb_keymap_new_from_names`
    needs `rules/evdev`, not `evdev.lst`). Fold into A3's strip
    step.
18. **libinput quirks file path is `/usr/share/libinput/` not
    `/etc/libinput/`.** B4 installs the quirks file at
    `$OUT_DIR/share/libinput/30-default-virtual.quirks` and
    libinput's build defines `LIBINPUT_DATA_DIR='"/usr/share/libinput"'`
    (B3 line 606). The rootfs build must symlink or copy
    `share/libinput/` into `/usr/share/libinput/` at install
    time. Plan 9's rootfs-build step (referenced not shown)
    must produce the path. **Lean:** add an explicit "rootfs
    install layout" subsection under B4 documenting the
    `/usr/share/libinput/` and `/usr/share/X11/xkb/` (A3)
    + `/usr/share/fonts/default.ttf` (plan 8) install
    invariants. Fold into B4.

### Correctness — open (lean documented)

- **plan-6-sockets-plan's SCM_RIGHTS path landed status.** Audit
  this session confirms SCM_RIGHTS is IMPLEMENTED in the kernel
  (kernel/src/wasm_api.rs `kernel_sendmsg` / `kernel_recvmsg` cmsg
  handling + pipe.rs `InFlightFd` queue + syscalls.rs sys_sendmsg
  / sys_recvmsg socket-layer routing + glue/syscall_glue.c
  syscalls 137/138 dispatch). MSG_PEEK | MSG_DONTWAIT supported
  (syscalls.rs sys_recv ~line 5248); POLLHUP delivery confirmed
  (syscalls.rs sys_poll ~lines 6333-6424); EPIPE on send-to-closed
  confirmed (syscalls.rs sys_write ~lines 5478-5497); cross-process
  AF_UNIX connect via the UnixSocketRegistry confirmed. **Lean:**
  plan 9 does NOT need an inline sub-plan completing plan 6;
  build directly on the as-shipped surfaces. Risk register #1's
  mitigation collapses to "verify the file `/run/` mount exists
  in the rootfs and is writable by PID 2 before bind". Add a
  one-line `mkdir -p /run/wpk` early in D2 (line 1068 has it;
  good) and assert it succeeds.
- **PID 2 boot ordering vs init's existing shell-spawn.** D1's
  amendment fork-execs the compositor before the user shell.
  Existing init in `examples/init/` (per CLAUDE.md citation;
  the init was added in PR #486 per the recent commits) runs a
  shell after `/dev` mounts. **Lean:** D1's amendment goes
  **after** the dev mount and **before** the shell exec, with
  the `access("/etc/wpk/compositor", F_OK) == 0` guard ensuring
  the WordPress demo (which doesn't ship `/etc/wpk/compositor`)
  boots unchanged. Risk register #7 documents this. The init's
  fork-exec sequence must NOT `waitpid` on the compositor's PID
  (long-lived service); confirmed at line 1008 ("init doesn't
  wait on it").
- **KMS master transition on a misbehaving prior holder.** If a
  wpkdraw-direct or SDL2 demo was launched before init's
  amendment exec'd the compositor (e.g., user added an explicit
  pre-shell line that started a demo), the compositor's
  `drmSetMaster` returns EBUSY → main() exits 1, init has no
  PID 2 service, no compositor. **Lean:** documented as a v1
  invariant; init's responsibility to fork-exec the compositor
  BEFORE the user shell. If init spawns a shell that then forks
  wpkdraw-direct, the compositor (already at PID 2) holds master
  and wpkdraw-direct exits with EBUSY on its own setMaster call
  — the same constraint plan 8 risk register #3 covers
  bidirectionally. Risk register #2 wording (plan 9) is correct.
- **Compositor crash → wpkdraw-direct fallback.** Plan 9 says
  "client falls back to direct KMS (wpkdraw) or fatal-exits
  (SDL2)" on EPIPE. wpkdraw's fall-back path: an established
  surface with a dead compositor connection cannot transition
  back to direct-KMS mid-flight because (a) the surface's gbm
  device was opened against renderD128, not card0, and (b)
  somebody else may already hold master in the meantime.
  Plan 9 E1's amendment shape ALREADY accepts this — once a
  surface is established via the compositor, EPIPE means
  fatal-exit for that surface (not a re-attempt at direct-KMS).
  **Lean:** document this in E1: "compositor-client mode is
  one-way; EPIPE during present means the demo exits with an
  error message. The fall-back to direct-KMS happens at surface
  *create* time, not after." Fold the wording into Phase E1
  alongside the present function.
- **libxkbcommon + libinput cross-compile under wasm32posix-cc.**
  Both upstream use meson; plan 7 A2 line 648 documents meson
  + wasm32 is a known footgun and plan 7's libdrm-KMS subset
  used a hand-rolled Makefile + explicit `.c` list. Plan 9 A2 +
  B3 follow the same pattern. **Lean:** budget 2-3 build rounds
  per library for the inevitable symbol-resolution churn. Risk
  register #2 covers this. The biggest unknown is libinput's
  `evdev-fallback.c` / `evdev-mt-touchpad.c` cross-references
  (B3 line 593's "keyboards use the fallback driver" is correct
  but the file lists are heuristic). Plan B4's smoke link
  catches missing symbols.
- **libinput's filter chain on synthetic BUS_VIRTUAL devices.**
  Risk register #4 covers this. Quirks file B4 marks the
  devices as `ModelGenericKeyboard=1` / `ModelGenericMouse=1`,
  which disables acceleration profiles and most palm rejection.
  Plan 9 E3 profiles the result; if pointer feels laggy,
  add `<NoFilter>` to the quirks file. **Lean: pre-emptively
  ship a more aggressive filter-disable in B4** rather than
  iterate from a default-noisy baseline.
- **`EGL_KHR_image_base` absence in plan 3's stub.** Plan 9 D3
  composites client bos via `gbm_bo_import` + plan 3's
  `WPK_BIND_FOREIGN_TEXTURE` ioctl, not via EGLImage. **Lean:**
  documented as design choice in the plan 3 follow-up; v1 sticks
  to the simpler bo-import + foreign-texture binding. EGLImage
  is post-v1 (Wayland compat layer may need it).
- **`gbm_surface_has_free_buffers` semantic.** Plan 2's follow-up
  defines it as "nonzero iff free pool is non-empty". The bo is
  considered free when (a) never locked, or (b) released via
  `gbm_surface_release_buffer` after the FLIP_COMPLETE that
  scanned it out. Plan 9's render guard (inline fix #8) depends
  on this. **Lean:** the EGL stub's eglSwapBuffers + the KMS
  page-flip handler must release the previously-scanned-out bo
  back to the ring. Verify at plan 2 + plan 3 impl time.
- **`gbm_bo_get_fd` returns a fresh prime fd per call.** Plan 9
  E1 line 1408-1413 calls `gbm_bo_get_fd(s->bo_front)` on every
  present then `close(pfd)` after `wpk_client_attach_buffer`.
  Plan 2's libgbm follow-up: does `gbm_bo_get_fd` allocate a
  fresh fd (incrementing kernel-side refcount) or return a
  cached fd? **Lean:** matches upstream Mesa semantics — fresh
  fd each call, caller's `close` is the release. Confirmed
  against the plan 2 follow-up surface (`gbm_bo_get_fd` calls
  `DRM_IOCTL_PRIME_HANDLE_TO_FD` per invocation, which always
  returns a new fd). Document in plan 2.
- **`gbm_bo_import` GBM_BO_IMPORT_FD shape.** D3 line 1140-1146
  uses
  ```c
  struct gbm_import_fd_data data = {
      .fd = prime_fd, .width = s->width, .height = s->height,
      .stride = s->width * 4, .format = s->format,
  };
  ```
  The struct shape matches upstream Mesa. The `s->width * 4`
  stride is the bug from inline fix #2; the struct itself is
  correctly used.

### Architecture — open (LOAD-BEARING)

These three items GATE plan 9 implementation start. Each must
have a resolution committed before Phase A's first commit lands.

1. **(LOAD-BEARING) 24-message-type inventory must be enumerated
   and reconciled against design §9.2.** The design §9.2 table
   lists ~16 named types (the exact count depends on whether
   request/reply pairs and CLIPBOARD_SET/REQUEST/DATA are counted
   as 1, 2, or 3). Plan 9 claims "24" at multiple lockstep points.
   Without an explicit enumeration, the protocol scope leaks
   during impl — every "well, this is just one more message"
   addition during Phase D erodes the §9.5 trade-off ("custom =
   1 week, Wayland = 6 weeks") that justifies the custom path.
   **Resolution:** C2's wire-format implementation ships an
   explicit `enum wpk_msg_type` with all 24 constants, named
   1:1 against the design §9.2 table. Any constant marked
   `_RESERVED_FOR_V2_*` ships as no-op (server logs "unknown")
   but reserves the wire-format slot. The §9.2 table is **the**
   source of truth; if the implementation needs message #25,
   it's a design amendment, not a plan 9 amendment. Fold the
   enumeration into C2 as a new sub-task (C2a: "enum + design
   reconciliation").
2. **(LOAD-BEARING) EVIOCGRAB exclusivity in the compositor.**
   Plan 5 v1 records `grabbed` flag without enforcement (plan 5
   lines 224-230 + lines 361-369 explicitly punt this). Plan 9
   inherits the enforcement obligation. Inline fix #4 above
   describes the lean (call EVIOCGRAB in `compositor_open_restricted`)
   but the kernel-side enforcement (other OFDs return -EBUSY on
   read after a grab) is **not implemented in plan 5 v1**. So
   the grab is purely cosmetic in v1 — both compositor and
   wpkdraw-direct still receive every event. **Resolution
   options:**
   - **(a)** Plan 9 ships an inline sub-plan extending plan 5
     to enforce EVIOCGRAB cross-OFD (plan 5 A3 has the dead-
     code arm `EBUSY` path; resurrect it). Adds ~1-2 days to
     Phase A.
   - **(b)** Plan 9 accepts the v1 hazard and documents it
     ("if you run wpkdraw-direct and the compositor
     concurrently, both will receive every keystroke; v2 ships
     enforcement"). Lower scope; documented limitation.
   - **(c)** Plan 9 enforces at user-space level (the
     compositor's libwpkclient wire protocol becomes the only
     supported client; wpkdraw-direct is removed from the
     supported configurations).
   **Lean: (a).** The enforcement is ~20 lines of Rust in plan
   5's `sys_read` arm (skip the event for non-grabbing OFDs if
   any other OFD holds the grab), and it closes the hazard
   plan 5 was designed to leave open for plan 9. Cross-plan
   amendment to plan 5 added.
3. **(LOAD-BEARING) `gbm_bo_import` MUST internally issue
   `DRM_IOCTL_PRIME_FD_TO_HANDLE` (cookie + refcount).** Plan
   9's `compositor_handle_attach_buffer` closes the prime fd
   immediately after import (D3 line 1145), relying on the
   import call having bumped the kernel-side refcount. If
   plan 2's libgbm stub doesn't go through PRIME_FD_TO_HANDLE
   (e.g., it just stashes the fd in its bo struct), the close
   is a use-after-free that strikes only when the compositor
   later samples the bo as a texture. **Resolution:** plan 2's
   gbm_surface follow-up must EXPLICITLY document that
   `gbm_bo_import(GBM_BO_IMPORT_FD, ...)` issues
   PRIME_FD_TO_HANDLE under the hood and the caller is free to
   close the fd. Add a cross-plan amendment to plan 2 now;
   verify at plan 2's impl time. If plan 2 ships a stub without
   the cookie path, plan 9's compositor leaks bos and the demo
   silently corrupts client textures after ~16 frames (cookie
   slot exhaustion or refcount=0 free).

### Missing tests — add at impl time

- **SCM_RIGHTS prime-fd round-trip vitest** under `host/test/`.
  Spawn compositor; spawn a tiny test client that calls
  `wpk_client_create_surface` + `wpk_client_attach_buffer` with
  a renderD128-allocated prime fd; assert the compositor's
  `gbm_bo_import` succeeds, the bo's stride matches what the
  client allocated, and the compositor's foreign-texture binding
  fires for it. Without this, inline fix #2 + #13 are unguarded.
- **Compositor crash → wpkdraw-direct fall-back at create time.**
  Spawn compositor; spawn wpkdraw-demo (which connects via
  libwpkclient and starts compositing); send SIGKILL to the
  compositor; assert wpkdraw-demo exits with an EPIPE error
  message (NOT a fall-back to direct-KMS; per the "lean" in
  Correctness — open above).
- **wpkdraw-direct vs. running compositor.** Compositor running.
  Launch wpkdraw-direct (a version that explicitly skips the
  compositor probe). Assert it exits 1 with EBUSY from
  `drmSetMaster`. Regression guard for risk register #2.
- **EVIOCGRAB cross-OFD enforcement.** Open event0 from process
  A (the compositor). Open event0 from process B. A calls
  EVIOCGRAB(1). Inject a keypress via `kernel_input_event`.
  Assert A reads the event AND B reads 0 bytes / EAGAIN (or
  blocks if not non-blocking). Regression guard for open-arch
  #2 resolution (a). If resolution (b) is chosen, this test is
  documented-XFAIL.
- **24-message-type enumeration matches design §9.2.** Cargo
  test asserts `WPK_MSG_*` enum has exactly 24 constants and
  each name appears in the design §9.2 table. Catches drift.
- **`gbm_bo_import` close-after-import safety.** Cargo test
  (plan 2 follow-up) asserts that after `gbm_bo_import(GBM_BO_IMPORT_FD,
  data, ...)` + `close(data.fd)`, the returned bo's kernel-side
  refcount is 1 (the import call's ref) and the bo remains
  valid until `gbm_bo_destroy`. Regression guard for open-arch #3.
- **`gbm_surface_has_free_buffers` returns 0 mid-flip.** Plan 9
  test: render 3 frames in a row without draining card0 POLLIN;
  assert the 4th render attempt sees `has_free_buffers() == 0`
  and stalls cleanly (per inline fix #8).
- **Stale `/run/wpk/comp` cleanup on re-launch.** Start
  compositor; SIGKILL it; start compositor again; assert the
  second start succeeds (the `unlink` at D2 line 1072 clears
  stale state). Regression guard for risk register #9.
- **Quirks file + xkb data files installed under /usr/share/.**
  Cargo test asserts after rootfs build that
  `/usr/share/libinput/30-default-virtual.quirks` AND
  `/usr/share/X11/xkb/rules/evdev` exist and are readable.
  Regression guard for inline fixes #17 + #18.
- **xkb modifier latching: Shift+a → 'A'.** Spawn the smoke
  program from A4 with a modified sequence: KEY_LEFTSHIFT press
  + KEY_A press; assert `xkb_state_key_get_one_sym` returns
  `XKB_KEY_A` (capital) not `XKB_KEY_a`.
- **EV_ABS-on-default-browser cursor tracking.** vitest
  injects a sequence of ABS_X / ABS_Y events; assert the
  compositor's cursor position lands at the absolute coords
  AND the focused client receives a POINTER_MOTION message with
  surface-relative coords. Regression guard for inline fix #3.
- **Client-surface stride plumbing.** Client allocates a 320×240
  ARGB8888 bo with stride = 1280 (tight). Client allocates a
  320×240 with stride = 4096 (page-aligned). Compositor's
  `gbm_bo_import` uses the wire-supplied stride in both cases
  and the sampled texture is intact. Regression guard for inline
  fix #2.
- **Multi-client focus cycle Super+Tab.** Spawn 3 wpkdraw
  clients; assert Super+Tab cycles focus through all 3 in a
  consistent order. E2's vitest covers 2; bump to 3 to catch
  the cycle vs. toggle distinction.

### Trade-offs verified

- **Custom protocol, not Wayland.** Per design §9.5 — 1 week vs
  6 weeks. ✓
- **libxkbcommon real, not hand-rolled.** Hand-rolled would be
  ~3000 LoC of keymap parser + symbol table; error-prone and
  duplicates existing Linux bugs. ✓
- **libinput real, not lite stub.** Plan 7's libinput-lite is
  sufficient for SDL2's basic key+button but lacks gesture +
  palm rejection + multi-device fan-out. ✓
- **Path-mode libinput, no libudev.** v1 has no udev daemon;
  `libinput_path_create_context` + explicit
  `libinput_path_add_device` works. ✓
- **No tablet / trackpoint / touchscreen in libinput subset.** ✓
- **Single-threaded poll loop.** No worker threads; matches
  design §9 + no-pthreads rule. ✓
- **24-message-type cap.** ⚠️ COUNT MISMATCH WITH DESIGN — see
  LOAD-BEARING open-architecture #1.
- **Software cursor.** Plan 4 doesn't yet expose MODE_CURSOR2. ✓
- **PID 2 reservation.** Init amendment D1. ✓
- **Single CRTC / connector / mode.** Matches plan 4. ✓
- **Window placement compositor-chosen.** v1 cascade
  (50,50)→(250,200)→…; v2 may add xdg-positioner. ✓
- **Compositor links libwpkdraw statically for decorations.**
  Plan 8 surface re-used; one bundled font. ✓
- **Compositor crash → clients orphaned (EPIPE).** Documented;
  no auto-restart watchdog in v1. ✓
- **Per-client linked list.** N ≤ MAX_CLIENTS = 16; linear scan
  is fine. ✓
- **SCM_RIGHTS for prime-fd attach.** Plan-6-sockets shipped
  (audit confirms IMPLEMENTED). ✓
- **`gbm_surface_*` from plan 2 follow-up.** ✓
- **`libEGL.a` + `libGLESv2.a` from plan 3 follow-up.** ✓
- **Zero ABI impact.** Sysroot + examples only. ✓
- **Five-PR stacked merge.** xkbcommon → libinput → libwpkclient
  → wpkcompositor → wpkdraw-amendment+demo. ✓
- **CLOCK_MONOTONIC pinned via musl shim.** Cross-stream parity. ✓
- **Custom hand-rolled C serialiser, no protobuf/flatbuffers.** ✓
- **Static-link-only invariant.** All four new libraries ship
  `.a` only; no `.so`. Compositor binary is a static-link wasm. ✓
- **No animation framework / per-frame dirty redraw.** ✓
- **One libinput consumer in v1 (the compositor).** ⚠️
  Enforcement gap — see LOAD-BEARING open-arch #2.

### Deliberately not flagged

- **Wayland wire compatibility (post-v1, ~6 weeks).** Design §15. ✓
- **XDG-shell-style state machine (v2 may add).** ✓
- **Multi-monitor (plan 4 invariant).** ✓
- **Output rotation / scaling / DPI awareness (v1 = 1.0×).** ✓
- **Hardware cursor plane (v2; needs plan 4 MODE_CURSOR2).** ✓
- **Touch / pen / tablet (v1 = keyboard + pointer).** ✓
- **Client-surface scaling / HiDPI (v1 = 1:1).** ✓
- **Window resize messages from compositor → client (v1 =
  client-immutable dims).** ✓
- **Cursor theme / animated cursors (v1 = hardcoded arrow).** ✓
- **Stacked pop-up menus + tooltips (v1 = flat z-order).** ✓
- **Drag-and-drop / clipboard implementation (design §9.2
  reserves CLIPBOARD_*; v1 ships as no-op stubs counted in the
  24-message inventory).** ✓
- **Compositor restart watchdog (v1 = manual relaunch).** ✓
- **Audio thread plumbing (plan 7 open-arch #1; INDEPENDENT
  of plan 9 — see "Cross-plan amendments" for the resolution
  picked this session).** ✓
- **Plan 7's SDL2 KMSDRM backend coexisting with the compositor
  (plan 11 ships SDL_wpkvideo backend; v1 SDL2 demo is direct-
  KMS only).** ✓
- **`WPK_BIND_FOREIGN_TEXTURE` ioctl (plan 3 A4 ships it).** ✓
- **xkbcommon data files at /usr/share/X11/xkb 2 MB rootfs
  bloat — acceptable per inline fix #17 strip strategy.** ✓
- **Window placement algorithm (v1 cascade; not an
  open-architecture item, a hardcoded heuristic).** ✓
- **`compositor_cycle_focus` algorithm (round-robin over the
  client list; not specified in the design, picked at impl).** ✓
- **VFS mount tree for `/run/wpk/` — plan 6 audit confirms paths
  resolve through host_resolve_path; the kernel doesn't manage
  a tmpfs mount but `bind` creates real inodes on the host
  filesystem (rootfs must contain `/run/wpk/` directory).** ✓
- **wpkdraw-direct mode preserved with no compositor —
  documented by E1's auto-detect dispatch.** ✓

### Cross-plan amendments (added to plans 2, 4, 5, 7, 8 reviews)

- **Plan 2 follow-up (LOAD-BEARING).** `gbm_bo_import(GBM_BO_IMPORT_FD,
  data, ...)` MUST internally issue `DRM_IOCTL_PRIME_FD_TO_HANDLE`
  (cookie verification + bo refcount bump) before returning a
  usable `struct gbm_bo *`. Caller-owned `data.fd` is safe to
  `close(2)` immediately after import. Without this contract,
  plan 9 D3's close-after-import is a use-after-free. Note
  added under plan 2's existing "Cross-plan amendment from
  plan 7's devil's-advocate — gbm_surface follow-up
  (LOAD-BEARING)" subsection as an addendum sub-bullet.
- **Plan 4 follow-up.** Plan 9's compositor relies on plan 4's
  OFD-final-close auto-drop of KMS master semantics (lines
  403-406 + 1116 of plan 4). On compositor crash, master IS
  released cleanly; the compositor doesn't need an explicit
  `drmDropMaster` in its cleanup chain (though plan 9 inline
  fix #6 adds one as defensive hygiene). Note added to plan
  4's "Deliberately not flagged" subsection: "OFD-final-close
  auto-drop is sufficient for compositor-process-death; plan 9
  does NOT require a separate drmDropMaster ioctl on graceful
  shutdown."
- **Plan 5 follow-up (LOAD-BEARING).** Plan 5 v1 records
  `EVIOCGRAB(1)` as `i.grabbed = 1` without enforcing cross-OFD
  exclusivity on subsequent reads (plan 5 review lines 224-230
  documented this as "plan 9 closes the hazard"). Plan 9's open-
  architecture #2 resolution **(a)** ships the enforcement —
  ~20 LoC in plan 5's `sys_read` arm: if any other OFD on the
  same device holds `grabbed = 1`, return 0 / EAGAIN. The change
  is plan-5-amendment, landed as part of plan 9's Phase A (or
  as a plan 5 follow-up PR before plan 9 opens). Note added to
  plan 5's review under a new subsection "Cross-plan amendment
  from plan 9's devil's-advocate — EVIOCGRAB enforcement".
- **Plan 7 follow-up (resolution of open-arch #1).** Plan 7's
  open-architecture #1 (SDL2 audio thread model) is **picked
  this session: option (b) — non-blocking WRITEI + SDL2
  polling patch + plan 6 EAGAIN return arm.** Rationale: option
  (a) (libpthread shim) is heaviest; option (c) (defer audio)
  is a feature regression; option (b) is ~150 LoC SDL2 patch +
  the plan 6 EAGAIN arm and matches plan 6's existing non-
  blocking surface. Plan 9's compositor doesn't manage audio
  (audio clients hit /dev/snd/* directly), so this decision is
  independent of plan 9 mechanically but resolves the last
  outstanding open-architecture item in the plan chain. Note
  added to plan 7's review under a new subsection "Cross-plan
  amendment from plan 9's devil's-advocate — audio thread
  resolution: option (b)".
- **Plan 7 follow-up — KMS-master coexistence.** Plan 7's SDL2
  KMSDRM demo (PR #2) and plan 9's compositor both take KMS
  master. Plan 7's review does NOT call this out; reviewers
  could miss the implication. Note added to plan 7's review:
  "SDL2 KMSDRM demo and wpkcompositor are mutually exclusive
  in v1 — both call `drmSetMaster` and only one can hold it
  at a time. The boot-ordering invariant (init starts compositor
  at PID 2; SDL2 demos start as PID 3+ and hit EBUSY if the
  compositor is running) is documented in plan 9 risk register
  #2 + the SDL_wpkvideo demote path in plan 11."
- **Plan 8 follow-up.** Plan 8's review fix #4 (cache both
  gbm_bo_map mappings at create-time, swap pointer on present,
  no remap) **extends to plan 9 E1's `wpk_surface_present_via_compositor`.**
  Plan 9 E1's snippet re-introduces the per-present remap.
  Note added to plan 8's review under a new subsection
  "Cross-plan amendment from plan 9's devil's-advocate — fix
  #4 extension to compositor-client mode": at impl time, the
  cached-mapping invariant applies to BOTH direct-KMS and
  compositor-client surface present paths.
- **Plan 6 follow-up — EAGAIN return arm for audio writei.** As
  part of plan 7's open-arch #1 resolution (b), plan 6's ALSA
  PCM `WRITEI` ioctl path needs an explicit EAGAIN return arm
  for non-blocking writei when the kernel-side queue is full.
  Plan 6's review covers this conceptually under "ALSA non-
  blocking", but the explicit EAGAIN-vs-EBUSY distinction
  wasn't pinned. Note added to plan 6's review under a new
  subsection "Cross-plan amendment from plan 9's devil's-
  advocate — explicit EAGAIN arm for SDL2 audio polling".

### Cross-plan amendments from plan 10's devil's-advocate (added during session 11)

- **Plan 10 follow-up (LOAD-BEARING) — expose
  `wpk_client_get_fd` accessor.** Plan 10 main.c's poll-loop
  integration calls `wpk_client_get_fd(cl)` to feed the
  compositor socket into `poll(2)` alongside the shell pipe;
  plan 9's public header (lines 1366-1410) exposes no fd
  accessor. The internal `struct wpk_client` carries `.fd`
  (line 1433) but it's not reachable across the API boundary.
  Add to the public header: `int wpk_client_get_fd(struct
  wpk_client *c);` (one-line body: `return c ? c->fd : -1;`).
  Required for plan 10 implementation start. Plan 10 inline
  fix #2.
- **Plan 10 follow-up (LOAD-BEARING) — extend
  `wpk_client_attach_buffer` signature with `stride: u32`.**
  Plan 9 inline fix #2 commits the wire-format
  `wpk_msg_attach_buffer` payload to carry `stride: u32`, but
  the C API at line 1378 / 1518 still takes only
  `(c, surface_id, prime_fd)`. Without the parameter, plan 9
  fix #2 is incomplete on the client side and the compositor
  has to recompute `width * 4` — re-introducing the bug.
  Extend the signature to `(c, surface_id, prime_fd, uint32_t
  stride)`; libwpkdraw's `wpk_surface_present_via_compositor`
  (E1 line 2039) forwards `gbm_bo_get_stride(s->bo_back)`.
  Required for plan 9 fix #2 closure AND plan 10 first non-
  trivial render. Plan 10 inline fix #3.
- **Plan 10 follow-up — `SOCK_CLOEXEC` on the client-side
  socket.** Plan 9's `wpk_client_connect` body (lines 1439-
  1455) calls `socket(AF_UNIX, SOCK_STREAM, 0)`. Without
  `SOCK_CLOEXEC`, the compositor fd leaks into every external
  command wpkshell fork-execs, bloating the OFD table and
  exposing the compositor protocol stream to unrelated
  programs. Amend to `socket(AF_UNIX, SOCK_STREAM |
  SOCK_CLOEXEC, 0)`. Symmetric to plan 9 inline fix #5
  (`SOCK_CLOEXEC` on `accept4`). Plan 10 inline fix #5.
- **Plan 10 follow-up (escape hatch) — optional connect-retry
  loop in `wpk_client_connect`.** Plan 10 inline fix #12
  resolves the init→wpkshell sequencing race init-side
  (init `access`-polls `/run/wpk/comp` before exec'ing
  wpkshell). The libwpkclient-side escape hatch is a
  10×50 ms retry on ENOENT inside `wpk_client_connect`
  before returning NULL (≈8 lines). Lean: ship the init-side
  fix first; add the libwpkclient retry only if the init
  poll proves flaky in practice. Not LOAD-BEARING under the
  init-side resolution.

### Cross-plan amendments from plan 11's devil's-advocate (added during session 12)

Plan 11 (`docs/plans/2026-07-27-wpk-seed-apps-plan.md`) ships
four seed apps over the libwpkclient + compositor surface
(wpkfm + libwpkdraw_widgets, SDL_wpkvideo + wpkcube, wpkbeep,
wpkpanel). Two LOAD-BEARING architecture items leak back into
plan 9.

- **Plan 11 follow-up (LOAD-BEARING) —
  `WPK_CLIENT_FOCUS_CHANGED` event variant +
  `focus.title[64]` event-union extension.** Plan 11 task E2
  lines 1218–1222 read `ev[i].focus.title`. Plan 9's event
  union (lines 1437–1451) holds only `{ uint32_t surface_id }`
  for focus events (`FOCUS_IN`, `FOCUS_OUT`). Plan 11 needs a
  new variant `WPK_CLIENT_FOCUS_CHANGED` carrying a string
  title for wpkpanel's active-application readout. One of
  plan 9's `_RESERVED_FOR_V2_*` slots becomes
  `WPK_CLIENT_FOCUS_CHANGED`; the union gains a
  `struct { uint32_t surface_id; char title[64]; } focus;`
  arm. 24-message inventory cap is NOT bumped (one reserved
  slot consumed). The compositor's D4 focus-dispatch (lines
  1864–1895) broadcasts the event unconditionally on every
  focus-surface change to all connected clients — no opt-in
  subscribe API needed in v1 (clients that don't care drop
  it in their poll loop). If a future plan wants opt-in, add
  `wpk_client_subscribe_focus(cl)`; v1 doesn't. Required for
  plan 11 PR #4 (wpkpanel). Plan 11 Architecture #2.
- **Plan 11 follow-up (LOAD-BEARING) — extract `place_window`
  as an explicit function + `WPK_SURFACE_TYPE_PANEL`
  exemption + `w == 0` fullscreen-width negotiation +
  companion `wpk_client_set_surface_type` API.** Plan 9 D6
  places windows via a hardcoded cascade (lines 2248–2250:
  "(50, 50), (250, 200), …"). Plan 11 task E4 needs a hook
  to reserve `PANEL_RESERVED_PX = 24` from the top of the
  output for new windows, AND a way for wpkpanel itself to
  place at `(0, 0)` exempt from the reserve. Amendment:
  refactor placement into an explicit
  `place_window(compositor, surface) → (x, y)` helper in D6;
  surfaces with `type == WPK_SURFACE_TYPE_PANEL` skip the
  reserve and place at `(0, 0)`. Additionally: a surface
  created with `w == 0` is negotiated to the full screen
  width minus reserved struts and the negotiated value flows
  back to the client via `wpk_client_create_surface`'s reply
  (this resolves wpkpanel's `screen_w` heuristic from plan
  11 E1 line 1167 without adding a separate output-size
  query API). Companion client API:
  `int wpk_client_set_surface_type(struct wpk_client *c,
  uint32_t surface_id, uint32_t type);` over plan 9's
  existing `SET_TYPE` wire message — wire format unchanged,
  C wrapper added. New constants:
  `WPK_SURFACE_TYPE_NORMAL` (0, default) and
  `WPK_SURFACE_TYPE_PANEL` (1). Future plans may add
  `_DIALOG`, `_TOOLTIP`, etc. Required for plan 11 PR #4
  (wpkpanel + compositor work-area cooperation). Plan 11
  Architecture #3 (collapses plan 11 inline fix #9).

---

## Phase A — sysroot: libxkbcommon (PR #1)

Port upstream libxkbcommon 1.6.0 (latest stable as of 2026-05) as
a static library. Compositor + (future) SDL2's xkbcommon-based
keymap path both link this.

### Task A1: Package scaffold

**Files:**
- Create: `examples/libs/libxkbcommon/package.toml` — recipe.
- Create: `examples/libs/libxkbcommon/build.toml` — build state.
- Create: `examples/libs/libxkbcommon/build.sh` — build script (stub).

```toml
# examples/libs/libxkbcommon/package.toml
name = "libxkbcommon"
version = "1.6.0"
license = "MIT"
description = "XKB keymap library — subset for compositor + SDL2"

[source]
type = "git"
url = "https://github.com/xkbcommon/libxkbcommon.git"
commit = "xkbcommon-1.6.0"

[deps]
# No external deps — libxkbcommon is self-contained over the C
# standard library + a tiny embedded XKB data set. We vendor the
# keymap data files (`/usr/share/X11/xkb/`) as part of this
# package's archive.

[build]
script_path = "build.sh"
```

```toml
# examples/libs/libxkbcommon/build.toml
script_path = "build.sh"
repo_url = "https://github.com/xkbcommon/libxkbcommon.git"
commit = "xkbcommon-1.6.0"
revision = 1

[binary]
index_url = "https://github.com/<repo>/releases/download/binaries-abi-v{abi}/index.toml"
```

```bash
#!/usr/bin/env bash
# examples/libs/libxkbcommon/build.sh
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

SRC_DIR="$1"
OUT_DIR="$2"
WORK="$OUT_DIR/build"
mkdir -p "$WORK/lib" "$WORK/include/xkbcommon"

# A2 fills in the actual subset + compile.
echo "TODO A2: extract xkbcommon subset + cross-compile"
exit 1
```

**Commit:** `sysroot(input): scaffold libxkbcommon package`

### Task A2: libxkbcommon — hand-rolled Makefile subset

libxkbcommon's meson build pulls in test programs + Compose + the
XML keymap parser. We strip to the essentials:

- **Keep:** `src/atom.c`, `src/context.c`, `src/keymap.c`,
  `src/keysym.c`, `src/state.c`, `src/utils.c`, `src/scanner-utils.c`,
  `src/utf8.c`, `src/keymap-priv.c`, `src/keymap-format-text-v1.c`
  (the v1 XKB text keymap parser), `src/x11/atom.c` (no, drop —
  X11-specific), the generated `src/parser.c` + `src/scanner.c`
  (pre-generated bison/flex artifacts; we don't run bison/flex
  in the build).
- **Drop:** `src/compose/`, `src/registry/`, `src/x11/`, `tools/`,
  `test/`, `bench/`.

Approximate file count: 15 `.c` files, ~6000 LoC of meaningful
implementation.

```bash
SRC="$SRC_DIR/src"
KEEP_C=(
    atom.c context.c keymap.c keysym.c state.c utils.c
    scanner-utils.c utf8.c keymap-priv.c
    keymap-format-text-v1.c
    parser.c scanner.c    # pre-generated artifacts in upstream tree
)

for f in "${KEEP_C[@]}"; do
    cp "$SRC/$f" "$WORK/"
done
cp -r "$SRC_DIR/include/xkbcommon" "$WORK/include/"

# libxkbcommon uses an internal `xkbcommon/xkbcommon-priv.h`. Copy
# the priv headers too.
mkdir -p "$WORK/include/_priv"
cp "$SRC/"*.h "$WORK/include/_priv/"

cd "$WORK"
wasm32posix-cc -c -O2 \
    -I./include -I./include/_priv \
    -DDFLT_XKB_CONFIG_ROOT='"/usr/share/X11/xkb"' \
    -DDFLT_XKB_CONFIG_EXTRA_PATH='""' \
    -DXLOCALEDIR='"/usr/share/locale"' \
    -DDEFAULT_XKB_LAYOUT='"us"' \
    -DDEFAULT_XKB_MODEL='"pc105"' \
    -DDEFAULT_XKB_VARIANT='""' \
    -DDEFAULT_XKB_OPTIONS='""' \
    "${KEEP_C[@]}"
llvm-ar rcs "$OUT_DIR/lib/libxkbcommon.a" *.o
cp -r include/xkbcommon "$OUT_DIR/include/"
```

**Cargo test:** `cargo xtask build-deps resolve libxkbcommon` exits 0;
`$OUT_DIR/lib/libxkbcommon.a` exists; smoke-link a tiny C file
calling `xkb_context_new(0)`.

**Commit:** `sysroot(input): libxkbcommon — hand-rolled Makefile subset (~150 KB static lib)`

### Task A3: XKB data files

The keymap parser reads `/usr/share/X11/xkb/{symbols,types,rules,
keycodes,compat}` text files at runtime. Vendor the minimal set:

- `symbols/us` — US keyboard symbols (~150 lines).
- `symbols/pc` — PC base symbol map.
- `types/complete` — modifier types.
- `keycodes/evdev` — evdev keycode names (~250 lines).
- `compat/complete` — compatibility map.
- `rules/evdev` — rules engine config.

Total ~2 MB across ~30 files. Vendor under
`examples/libs/libxkbcommon/share/`; install to
`$OUT_DIR/share/X11/xkb/` at build time.

License: MIT/X consortium — permissive, ship LICENSE alongside.

**Commit:** `sysroot(input): libxkbcommon — XKB data files (us layout + evdev keycodes)`

### Task A4: xkbcommon smoke program

```c
// programs/xkbcommon_smoke.c
#include <xkbcommon/xkbcommon.h>
#include <stdio.h>
int main(void) {
    struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!ctx) return 1;
    struct xkb_rule_names names = {
        .rules = "evdev", .model = "pc105", .layout = "us",
        .variant = "", .options = ""
    };
    struct xkb_keymap *km = xkb_keymap_new_from_names(
        ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!km) { xkb_context_unref(ctx); return 2; }
    /* KEY_A = 38 evdev keycode → XKB keysym 'a' */
    xkb_keysym_t sym = xkb_keymap_key_get_sym(km, 38 + 8, 0);
    char buf[16];
    xkb_keysym_get_name(sym, buf, sizeof buf);
    printf("KEY_A → %s\n", buf);
    xkb_keymap_unref(km);
    xkb_context_unref(ctx);
    return 0;
}
```

**Vitest:** assert stdout has `KEY_A → a` (the lowercase letter
'a'); exit 0.

**Commit:** `examples(input): xkbcommon_smoke — keymap compile + keysym lookup`

### Task A5: Phase A — full gauntlet + open PR #1

PR title: `[explore-dri] sysroot(input): libxkbcommon — real upstream port (1.6.0)`

Body covers: subset extraction rationale, XKB data files vendored,
smoke test exercises layout compile + keysym lookup. ABI impact:
none.

---

## Phase B — sysroot: libinput (PR #2)

Port upstream libinput 1.25.0 as a static library, replacing plan
7's `libinput-lite` stub. Compositor is the v1 sole consumer.

### Task B1: Package scaffold

```toml
# examples/libs/libinput/package.toml
name = "libinput"
version = "1.25.0"
license = "MIT"
description = "Generic input library — replaces plan 7's libinput-lite stub"

[source]
type = "git"
url = "https://gitlab.freedesktop.org/libinput/libinput.git"
commit = "1.25.0"

[deps]
libevdev = "1.13.1"   # B2 ships this as a separate sub-package

[build]
script_path = "build.sh"
```

```toml
# examples/libs/libinput/build.toml
script_path = "build.sh"
repo_url = "https://gitlab.freedesktop.org/libinput/libinput.git"
commit = "1.25.0"
revision = 1

[binary]
index_url = "https://github.com/<repo>/releases/download/binaries-abi-v{abi}/index.toml"
```

**Commit:** `sysroot(input): scaffold libinput + libevdev packages`

### Task B2: libevdev — sub-package

libinput requires libevdev for `struct input_event` parsing + event
queue management. Plan 5's evdev surface gives us the raw records;
libevdev adds the per-device state tracking (which keys are
currently pressed, which axes have absinfo, etc.).

```toml
# examples/libs/libevdev/package.toml
name = "libevdev"
version = "1.13.1"
license = "MIT"
description = "Event device library — userspace-side input event parsing"

[source]
type = "git"
url = "https://gitlab.freedesktop.org/libevdev/libevdev.git"
commit = "1.13.1"

[deps]
# No external deps — pure libc.

[build]
script_path = "build.sh"
```

Build script extracts the subset:

- **Keep:** `libevdev/libevdev.c`, `libevdev/libevdev-uinput.c` (no
  — uinput-only, drop), `libevdev/libevdev-names.c`,
  `libevdev/libevdev-util.c`.
- **Drop:** `tools/`, `test/`, `doc/`.

Compile with `wasm32posix-cc -O2`; archive to
`sysroot/lib/libevdev.a`.

**Commit:** `sysroot(input): libevdev — userspace event device parsing`

### Task B3: libinput — actual build

libinput's meson build wraps many drivers (touchpad, tablet,
trackpoint, switch, …). We need: keyboard, pointer, gesture,
touch. Skip tablet/trackpoint for v1.

```bash
SRC="$SRC_DIR/src"
KEEP_C=(
    # Core
    libinput.c libinput-util.c libinput-private.c
    libinput-version.c
    # Path-mode (no libudev)
    path-seat.c
    # Generic device evdev parsing
    evdev.c evdev-fallback.c evdev-debounce.c
    # Pointer
    evdev-mt-touchpad.c        # but skip tablet
    evdev-mt-touchpad-gestures.c
    evdev-mt-touchpad-tap.c
    evdev-mt-touchpad-buttons.c
    evdev-mt-touchpad-edge-scroll.c
    # Filter
    filter.c filter-low-dpi.c filter-mouse.c filter-touchpad.c
    filter-trackpoint-flat.c
    # Keyboard
    evdev-fallback.c   # keyboards use the fallback driver
    # Quirks
    quirks.c
    # Timer subsystem
    timer.c
)

cd "$WORK"
wasm32posix-cc -c -O2 \
    -I./include -I"$WPK_SYSROOT/include/libevdev-1.0" \
    -DHAVE_LIBUNWIND=0 \
    -DHAVE_LIBWACOM=0 \
    -DHAVE_LIBUDEV=0 \
    -DDEFAULT_QUIRKS_DIR='"/usr/share/libinput"' \
    -DLIBINPUT_DATA_DIR='"/usr/share/libinput"' \
    "${KEEP_C[@]}"
llvm-ar rcs "$OUT_DIR/lib/libinput.a" *.o
cp -r "$SRC_DIR/src/libinput.h" "$OUT_DIR/include/"
```

**Risk:** libinput is ~50 kLoC; the subset may need iteration as
unresolved symbols surface during the smoke link in B4. Expect
2-3 build rounds before clean.

**Commit:** `sysroot(input): libinput — subset compile (keyboard + pointer + gesture; no tablet/trackpoint)`

### Task B4: libinput quirks data

libinput reads quirks files at `/usr/share/libinput/*.quirks` —
small INI-ish format describing device-specific tuning (per-device
acceleration profiles, palm rejection thresholds). v1 ships a
minimal default-quirks file covering the synthetic evdev devices
plan 5 creates (kbd at event0, ptr at event1 with `BUS_VIRTUAL`).

Vendor: `examples/libs/libinput/share/30-default-virtual.quirks`:

```ini
[Generic VIRTUAL Keyboard]
MatchBus=virtual
MatchUdevType=keyboard
ModelGenericKeyboard=1

[Generic VIRTUAL Pointer]
MatchBus=virtual
MatchUdevType=mouse
ModelGenericMouse=1
```

Install to `$OUT_DIR/share/libinput/30-default-virtual.quirks`.

**Commit:** `sysroot(input): libinput — default quirks for v1 BUS_VIRTUAL devices`

### Task B5: libinput smoke program

```c
// programs/libinput_smoke.c — adds event0 + event1, reads N
// events, prints types.
#include <libinput.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

static int open_restricted(const char *path, int flags, void *user) {
    (void)user; return open(path, flags);
}
static void close_restricted(int fd, void *user) { (void)user; close(fd); }

static const struct libinput_interface ifc = {
    .open_restricted = open_restricted,
    .close_restricted = close_restricted,
};

int main(void) {
    struct libinput *li = libinput_path_create_context(&ifc, NULL);
    libinput_path_add_device(li, "/dev/input/event0");
    libinput_path_add_device(li, "/dev/input/event1");
    for (int i = 0; i < 20; i++) {
        libinput_dispatch(li);
        struct libinput_event *ev;
        while ((ev = libinput_get_event(li))) {
            enum libinput_event_type t = libinput_event_get_type(ev);
            printf("event type: %d\n", t);
            libinput_event_destroy(ev);
        }
    }
    libinput_unref(li);
    return 0;
}
```

**Vitest:** harness injects 5 keyboard presses + 5 pointer motions
via plan 5's `kernel_input_event`; assert the smoke prints 10+
event types (LIBINPUT_EVENT_KEYBOARD_KEY + LIBINPUT_EVENT_POINTER_MOTION).

**Commit:** `examples(input): libinput_smoke — event0 + event1 via path-mode`

### Task B6: Phase B — full gauntlet + open PR #2

PR title: `[explore-dri] sysroot(input): libinput + libevdev — real upstream port replacing libinput-lite`

Body: subset selection, libudev-disabled path-mode, quirks file,
smoke test confirms libinput dispatches events from plan 5's
seat-shared fanout cleanly.

---

## Phase C — sysroot: libwpkclient (PR #3)

Static library that SDL2 + wpkdraw + (any future client) links to
talk to the compositor.

### Task C1: Package scaffold + public headers

```toml
# examples/libs/libwpkclient/package.toml
name = "libwpkclient"
version = "0.1.0"
license = "MIT"
description = "Client-side wire to wpkcompositor (custom protocol over AF_UNIX)"

[source]
type = "local"

[deps]
# No external deps — talks directly to AF_UNIX + SCM_RIGHTS via libc.

[build]
script_path = "build.sh"
```

```c
// include/wpkclient/wpkclient.h
#ifndef WPKCLIENT_H
#define WPKCLIENT_H

#include <stdint.h>

struct wpk_client;

/** Connect to the compositor at /run/wpk/comp. Returns NULL on
 * failure (errno set: ENOENT = no compositor; EACCES = permission;
 * ECONNREFUSED = compositor not listening). Caller should fall
 * back to a non-compositor path on NULL. */
struct wpk_client *wpk_client_connect(void);

void wpk_client_disconnect(struct wpk_client *c);

/** Allocate a surface_id on the compositor. Returns 0 on failure
 * (errno set). */
uint32_t wpk_client_create_surface(struct wpk_client *c,
                                   int width, int height,
                                   uint32_t format);

/** Send ATTACH_BUFFER + the prime fd via SCM_RIGHTS. Returns 0
 * on success, -1 on failure. */
int wpk_client_attach_buffer(struct wpk_client *c,
                             uint32_t surface_id, int prime_fd);

/** Send COMMIT — atomic "this buffer is now the surface". */
int wpk_client_commit(struct wpk_client *c, uint32_t surface_id);

int wpk_client_set_title(struct wpk_client *c, uint32_t surface_id,
                         const char *title);
int wpk_client_set_type(struct wpk_client *c, uint32_t surface_id,
                        int type);  /* 0 = toplevel, 1 = popup, 2 = panel */
int wpk_client_destroy_surface(struct wpk_client *c, uint32_t surface_id);

/** Event drain. Returns count written into out_ev[]. */
struct wpk_client_event {
    enum {
        WPK_CLIENT_KEY,
        WPK_CLIENT_POINTER_MOTION,
        WPK_CLIENT_POINTER_BUTTON,
        WPK_CLIENT_FOCUS_IN, WPK_CLIENT_FOCUS_OUT,
        WPK_CLIENT_WINDOW_CLOSE,
    } type;
    union {
        struct { int keycode; uint32_t keysym; int pressed; int modifiers; } key;
        struct { int x, y; uint32_t surface_id; } pointer_motion;
        struct { int button; int pressed; uint32_t surface_id; } pointer_button;
        struct { uint32_t surface_id; } focus_in, focus_out, window_close;
    };
};

int wpk_client_poll(struct wpk_client *c,
                    struct wpk_client_event *out_ev, int max_events);

#endif /* WPKCLIENT_H */
```

**Commit:** `sysroot(wpk): scaffold libwpkclient package + public headers`

### Task C2: Wire format implementation

```c
// src/wire.c — ~120 LoC
#define _GNU_SOURCE
#include <wpkclient/wpkclient.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "wpk_wire.h"   /* internal — shared with the compositor's parser */

struct wpk_client {
    int fd;
    /* Inbound event queue, drained by wpk_client_poll. */
    struct wpk_client_event events[64];
    int event_head, event_tail;
};

struct wpk_client *wpk_client_connect(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return NULL;
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    strncpy(addr.sun_path, "/run/wpk/comp", sizeof addr.sun_path - 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        close(fd);
        return NULL;
    }
    struct wpk_client *c = calloc(1, sizeof *c);
    if (!c) { close(fd); errno = ENOMEM; return NULL; }
    c->fd = fd;
    return c;
}

void wpk_client_disconnect(struct wpk_client *c) {
    if (!c) return;
    close(c->fd);
    free(c);
}

/* Serialise + send a wire frame. The frame header is
 * (u32 length | u32 type); payload follows. */
static int send_frame(struct wpk_client *c, uint32_t type,
                      const void *payload, size_t payload_len) {
    struct wpk_msg hdr = {
        .length = sizeof hdr + payload_len,
        .type = type,
    };
    struct iovec iov[2] = {
        { &hdr, sizeof hdr },
        { (void *)payload, payload_len },
    };
    struct msghdr msg = { .msg_iov = iov, .msg_iovlen = 2 };
    if (sendmsg(c->fd, &msg, 0) < 0) return -1;
    return 0;
}

/* Variant with an SCM_RIGHTS fd attached. */
static int send_frame_with_fd(struct wpk_client *c, uint32_t type,
                              const void *payload, size_t payload_len,
                              int passed_fd) {
    struct wpk_msg hdr = {
        .length = sizeof hdr + payload_len,
        .type = type,
    };
    struct iovec iov[2] = {
        { &hdr, sizeof hdr },
        { (void *)payload, payload_len },
    };
    union { struct cmsghdr cm; char buf[CMSG_SPACE(sizeof(int))]; } u = {0};
    struct cmsghdr *cmsg = (struct cmsghdr *)u.buf;
    cmsg->cmsg_len = CMSG_LEN(sizeof(int));
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    *(int *)CMSG_DATA(cmsg) = passed_fd;
    struct msghdr msg = {
        .msg_iov = iov, .msg_iovlen = 2,
        .msg_control = u.buf, .msg_controllen = sizeof u.buf,
    };
    if (sendmsg(c->fd, &msg, 0) < 0) return -1;
    return 0;
}

/* Synchronous request/reply for CREATE_SURFACE. v1 protocol uses a
 * blocking call; v2 may add async with a request_id. */
uint32_t wpk_client_create_surface(struct wpk_client *c,
                                   int width, int height,
                                   uint32_t format) {
    struct wpk_msg_create_surface req = {
        .width = width, .height = height, .format = format,
    };
    if (send_frame(c, WPK_MSG_CREATE_SURFACE, &req, sizeof req) < 0)
        return 0;
    struct wpk_msg_create_surface_reply rep;
    if (read(c->fd, &rep, sizeof rep) != (ssize_t)sizeof rep) return 0;
    return rep.surface_id;
}

int wpk_client_attach_buffer(struct wpk_client *c, uint32_t surface_id,
                             int prime_fd) {
    struct wpk_msg_attach_buffer req = { .surface_id = surface_id };
    return send_frame_with_fd(c, WPK_MSG_ATTACH_BUFFER,
                              &req, sizeof req, prime_fd);
}

int wpk_client_commit(struct wpk_client *c, uint32_t surface_id) {
    struct wpk_msg_commit req = { .surface_id = surface_id };
    return send_frame(c, WPK_MSG_COMMIT, &req, sizeof req);
}

/* … set_title, set_type, destroy_surface, poll follow similar patterns … */
```

**Commit:** `sysroot(wpk): libwpkclient — wire format + connect/disconnect/CREATE_SURFACE/ATTACH_BUFFER/COMMIT`

### Task C3: Client poll + event drain

```c
// src/poll.c
int wpk_client_poll(struct wpk_client *c,
                    struct wpk_client_event *out_ev, int max_events) {
    /* Non-blocking drain of incoming wire frames; route to typed
     * events. */
    int n = 0;
    struct wpk_msg hdr;
    while (n < max_events) {
        ssize_t r = recv(c->fd, &hdr, sizeof hdr, MSG_DONTWAIT | MSG_PEEK);
        if (r < (ssize_t)sizeof hdr) break;
        /* Read the full frame. */
        char payload_buf[1024];
        if (hdr.length > sizeof payload_buf) {
            errno = EMSGSIZE; return -1;
        }
        if (recv(c->fd, payload_buf, hdr.length, 0) != (ssize_t)hdr.length)
            break;
        const void *payload = payload_buf + sizeof hdr;
        switch (hdr.type) {
        case WPK_MSG_INPUT_KEYBOARD: {
            const struct wpk_msg_input_keyboard *m = payload;
            out_ev[n].type = WPK_CLIENT_KEY;
            out_ev[n].key.keycode = m->keycode;
            out_ev[n].key.keysym = m->keysym;
            out_ev[n].key.pressed = m->state;
            out_ev[n].key.modifiers = m->modifiers;
            n++;
            break;
        }
        case WPK_MSG_INPUT_POINTER_MOTION: { /* … */ break; }
        case WPK_MSG_INPUT_POINTER_BUTTON: { /* … */ break; }
        case WPK_MSG_FOCUS_IN: { /* … */ break; }
        case WPK_MSG_FOCUS_OUT: { /* … */ break; }
        case WPK_MSG_WINDOW_CLOSE: { /* … */ break; }
        default: break;  /* unknown frame; v1 ignores forwards-compat */
        }
    }
    return n;
}
```

**Commit:** `sysroot(wpk): libwpkclient — poll + event drain`

### Task C4: wpkclient smoke

```c
// programs/wpkclient_smoke.c
#include <wpkclient/wpkclient.h>
#include <stdio.h>
int main(void) {
    struct wpk_client *c = wpk_client_connect();
    if (!c) {
        printf("no compositor — expected if compositor not running\n");
        return 0;  /* not a failure; tests both paths */
    }
    uint32_t sid = wpk_client_create_surface(c, 640, 480, 0x34325241);  /* ARGB8888 */
    printf("created surface %u\n", sid);
    wpk_client_disconnect(c);
    return 0;
}
```

**Vitest:** spawn the compositor (via E1 below), then run
`wpkclient_smoke`; assert it prints `created surface 1`.

**Commit:** `examples(wpk): wpkclient_smoke — connect + CREATE_SURFACE round-trip`

### Task C5: Phase C — full gauntlet + open PR #3

PR title: `[explore-dri] sysroot(wpk): libwpkclient — compositor client wire (custom protocol over AF_UNIX)`

Body: wire format from design §9.2, SCM_RIGHTS prime-fd attach,
poll/event drain, smoke verifies the connect-or-fallback path.

---

## Phase D — examples: wpkcompositor server (PR #4)

The compositor itself — PID 2 boot, KMS master, EGL, unix socket,
event loop, surface composition.

### Task D1: Init amendment — fork-exec wpkcompositor

**Files:**
- Modify: `examples/init/init.c` (or wherever the existing PID 1
  lives) — add a fork-exec of `/etc/wpk/compositor` if the file
  exists, before starting the user shell.
- Create: `examples/programs/wpkcompositor/etc-wpk-compositor` —
  one-line config file `/etc/wpk/compositor` (the file's presence
  is the trigger; its contents document the binary path).

```c
/* In init's main loop, after /dev mounts: */
if (access("/etc/wpk/compositor", F_OK) == 0) {
    pid_t pid = fork();
    if (pid == 0) {
        execl("/usr/bin/wpkcompositor", "wpkcompositor", NULL);
        _exit(127);
    }
    /* PID 2 is reserved for the compositor; init doesn't wait
     * on it (it's a long-lived service). */
}
/* Then exec user shell as PID 3+. */
```

**Commit:** `examples(wpk): init — fork-exec wpkcompositor as PID 2 if /etc/wpk/compositor exists`

### Task D2: Compositor scaffold

**Files:**
- Create: `examples/programs/wpkcompositor/main.c` — top-level
  bring-up + event loop skeleton.
- Create: `examples/programs/wpkcompositor/wpk_wire.h` — shared
  with libwpkclient.
- Create: `examples/programs/wpkcompositor/Makefile` — wired into
  `scripts/build-programs.sh`.

```c
// main.c — top-level
#define _GNU_SOURCE
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <xf86drm.h>
#include <xf86drmMode.h>
#include <gbm.h>
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <libinput.h>
#include <xkbcommon/xkbcommon.h>

#include "wpk_wire.h"
#include "compositor.h"

struct compositor C;

int main(void) {
    /* 1. Open card0, take KMS master. */
    C.card0 = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    if (C.card0 < 0) { perror("open card0"); return 1; }
    if (drmSetMaster(C.card0) < 0) { perror("drmSetMaster"); return 1; }

    /* 2. Resolve connector + CRTC + mode (single-output v1). */
    if (compositor_setup_kms(&C) < 0) return 1;

    /* 3. Set up EGL + gbm_surface. */
    C.gbm = gbm_create_device(C.card0);
    C.gbm_surface = gbm_surface_create(C.gbm, C.width, C.height,
        GBM_FORMAT_ARGB8888, GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
    /* … EGL init, eglCreateWindowSurface(C.gbm_surface), eglMakeCurrent … */

    /* 4. Unix socket. */
    mkdir("/run/wpk", 0755);
    C.sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    struct sockaddr_un sa = { .sun_family = AF_UNIX };
    strcpy(sa.sun_path, "/run/wpk/comp");
    unlink("/run/wpk/comp");  /* clean stale */
    if (bind(C.sock, (struct sockaddr *)&sa, sizeof sa) < 0) {
        perror("bind"); return 1;
    }
    listen(C.sock, 16);

    /* 5. libinput context. */
    static const struct libinput_interface ifc = {
        .open_restricted = compositor_open_restricted,
        .close_restricted = compositor_close_restricted,
    };
    C.input = libinput_path_create_context(&ifc, NULL);
    libinput_path_add_device(C.input, "/dev/input/event0");
    libinput_path_add_device(C.input, "/dev/input/event1");

    /* 6. xkbcommon — load default keymap. */
    C.xkb_ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    struct xkb_rule_names names = {
        .rules = "evdev", .model = "pc105", .layout = "us",
        .variant = "", .options = ""
    };
    C.xkb_keymap = xkb_keymap_new_from_names(
        C.xkb_ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    C.xkb_state = xkb_state_new(C.xkb_keymap);

    /* 7. Event loop. */
    return compositor_event_loop(&C);
}
```

**Commit:** `examples(wpk): wpkcompositor — scaffold (boot, KMS master, EGL, gbm_surface, socket, libinput, xkb)`

### Task D3: Surface state + commit + composition

```c
// surface.c — ~250 LoC
struct compositor_surface {
    uint32_t id;
    struct compositor_client *owner;
    int width, height;
    uint32_t format;
    struct gbm_bo *pending_bo;   /* set on ATTACH_BUFFER, drained on COMMIT */
    struct gbm_bo *current_bo;
    int x, y;                    /* compositor-assigned position */
    int type;                    /* toplevel | popup | panel */
    char *title;
    int focused;
};

void compositor_handle_create_surface(struct compositor_client *cl,
                                      const struct wpk_msg_create_surface *m) {
    struct compositor_surface *s = calloc(1, sizeof *s);
    s->id = compositor_next_surface_id();
    s->owner = cl;
    s->width = m->width;
    s->height = m->height;
    s->format = m->format;
    compositor_register_surface(s);
    /* Reply with the id. */
    struct wpk_msg_create_surface_reply rep = { .surface_id = s->id };
    send_frame(cl->fd, WPK_MSG_CREATE_SURFACE_REPLY, &rep, sizeof rep);
}

void compositor_handle_attach_buffer(struct compositor_client *cl,
                                     uint32_t surface_id, int prime_fd) {
    struct compositor_surface *s = compositor_find_surface(surface_id);
    if (!s || s->owner != cl) { close(prime_fd); return; }
    /* Import the prime fd as a gbm_bo. */
    struct gbm_import_fd_data data = {
        .fd = prime_fd, .width = s->width, .height = s->height,
        .stride = s->width * 4, .format = s->format,
    };
    struct gbm_bo *bo = gbm_bo_import(C.gbm, GBM_BO_IMPORT_FD, &data, 0);
    close(prime_fd);  /* gbm_bo holds a kernel-side ref */
    if (!bo) { perror("gbm_bo_import"); return; }
    if (s->pending_bo) gbm_bo_destroy(s->pending_bo);
    s->pending_bo = bo;
}

void compositor_handle_commit(struct compositor_client *cl,
                              uint32_t surface_id) {
    struct compositor_surface *s = compositor_find_surface(surface_id);
    if (!s || s->owner != cl || !s->pending_bo) return;
    if (s->current_bo) gbm_bo_destroy(s->current_bo);
    s->current_bo = s->pending_bo;
    s->pending_bo = NULL;
    /* Mark dirty; the event loop's next frame composites. */
    compositor_mark_dirty();
}
```

```c
// composite.c — composit all surfaces onto the compositor's
// gbm_surface back buffer, then eglSwapBuffers.
void compositor_render_frame(struct compositor *c) {
    glClearColor(0.1f, 0.1f, 0.15f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    /* Iterate surfaces in z-order (panels behind toplevels behind
     * popups; v1 has a fixed strip-of-3). For each surface:
     *   - bind its current_bo as a GL texture (via plan 3's
     *     foreign-texture path);
     *   - draw a textured quad at the surface's (x, y, w, h)
     *     position.
     */
    for (struct compositor_surface *s = c->surfaces; s; s = s->next) {
        if (!s->current_bo) continue;
        compositor_draw_textured_quad(c, s);
    }
    /* Window decorations: drawn via libwpkdraw (statically linked
     * into the compositor binary). Title bar + border per surface. */
    compositor_draw_decorations(c);
    eglSwapBuffers(c->egl_dpy, c->egl_surf);
}
```

**Commit:** `examples(wpk): wpkcompositor — surface state + CREATE/ATTACH/COMMIT + composition`

### Task D4: Input dispatch — libinput → focused client

```c
// input.c
void compositor_handle_libinput_event(struct compositor *c,
                                      struct libinput_event *ev) {
    enum libinput_event_type t = libinput_event_get_type(ev);
    switch (t) {
    case LIBINPUT_EVENT_KEYBOARD_KEY: {
        struct libinput_event_keyboard *k = libinput_event_get_keyboard_event(ev);
        uint32_t key = libinput_event_keyboard_get_key(k);
        enum libinput_key_state state = libinput_event_keyboard_get_key_state(k);
        /* xkb translation. */
        xkb_keycode_t kc = key + 8;  /* evdev offset */
        xkb_keysym_t sym = xkb_state_key_get_one_sym(c->xkb_state, kc);
        xkb_state_update_key(c->xkb_state, kc,
            state == LIBINPUT_KEY_STATE_PRESSED ? XKB_KEY_DOWN : XKB_KEY_UP);
        uint32_t mods = xkb_state_serialize_mods(c->xkb_state,
            XKB_STATE_MODS_EFFECTIVE);
        /* Route to focused client. */
        if (c->focus_surface && c->focus_surface->owner) {
            struct wpk_msg_input_keyboard m = {
                .keycode = key, .keysym = sym,
                .state = (state == LIBINPUT_KEY_STATE_PRESSED),
                .modifiers = mods,
            };
            send_frame(c->focus_surface->owner->fd,
                       WPK_MSG_INPUT_KEYBOARD, &m, sizeof m);
        }
        /* Compositor-global hotkeys: Super+Tab cycles focus. */
        if (sym == XKB_KEY_Tab && (mods & XKB_MOD_LOGO)) {
            compositor_cycle_focus(c);
        }
        break;
    }
    case LIBINPUT_EVENT_POINTER_MOTION: {
        struct libinput_event_pointer *p = libinput_event_get_pointer_event(ev);
        double dx = libinput_event_pointer_get_dx(p);
        double dy = libinput_event_pointer_get_dy(p);
        c->cursor_x += dx; c->cursor_y += dy;
        compositor_clamp_cursor(c);
        /* Hit-test → route to surface under cursor. */
        struct compositor_surface *s = compositor_pick(c, c->cursor_x, c->cursor_y);
        if (s && s->owner) {
            struct wpk_msg_input_pointer_motion m = {
                .surface_id = s->id,
                .x = c->cursor_x - s->x, .y = c->cursor_y - s->y,
            };
            send_frame(s->owner->fd, WPK_MSG_INPUT_POINTER_MOTION,
                       &m, sizeof m);
        }
        compositor_mark_dirty();  /* redraw cursor */
        break;
    }
    case LIBINPUT_EVENT_POINTER_BUTTON: { /* … focus click + route … */ break; }
    /* … gesture / scroll / touch … */
    default: break;
    }
}
```

**Commit:** `examples(wpk): wpkcompositor — libinput dispatch + xkb keymap + route to focused client`

### Task D5: Event loop assembly

```c
// loop.c
int compositor_event_loop(struct compositor *c) {
    int li_fd = libinput_get_fd(c->input);
    while (!c->quitting) {
        /* Build pollfd array: card0 + sock + libinput_fd + per-client fds. */
        struct pollfd fds[2 + 1 + MAX_CLIENTS];
        int nfds = 0;
        fds[nfds++] = (struct pollfd){ c->card0, POLLIN, 0 };
        fds[nfds++] = (struct pollfd){ c->sock, POLLIN, 0 };
        fds[nfds++] = (struct pollfd){ li_fd, POLLIN, 0 };
        for (struct compositor_client *cl = c->clients; cl; cl = cl->next)
            fds[nfds++] = (struct pollfd){ cl->fd, POLLIN | POLLHUP, 0 };

        int n = poll(fds, nfds, c->dirty ? 0 : -1);
        if (n < 0) { if (errno == EINTR) continue; perror("poll"); return 1; }

        if (fds[0].revents & POLLIN) compositor_drain_drm_events(c);
        if (fds[1].revents & POLLIN) compositor_accept_client(c);
        if (fds[2].revents & POLLIN) {
            libinput_dispatch(c->input);
            struct libinput_event *ev;
            while ((ev = libinput_get_event(c->input))) {
                compositor_handle_libinput_event(c, ev);
                libinput_event_destroy(ev);
            }
        }
        /* Per-client drain. */
        for (int i = 3; i < nfds; i++) {
            if (fds[i].revents & POLLHUP) {
                compositor_drop_client_by_fd(c, fds[i].fd);
                continue;
            }
            if (fds[i].revents & POLLIN)
                compositor_drain_client(c, fds[i].fd);
        }

        if (c->dirty) {
            compositor_render_frame(c);
            c->dirty = 0;
        }
    }
    return 0;
}
```

**Commit:** `examples(wpk): wpkcompositor — event loop (poll-driven)`

### Task D6: Window decorations + cursor

The compositor draws title bars + borders + a software cursor.
Statically links `libwpkdraw.a` for the 2D primitives + DejaVu Sans
font (already vendored by plan 8).

```c
// decorations.c
void compositor_draw_decorations(struct compositor *c) {
    /* Render decorations into an off-screen wpkdraw surface bound
     * to the compositor's gbm_surface back-buffer. */
    /* For each surface, draw title bar (24 px top bar) + border. */
    for (struct compositor_surface *s = c->surfaces; s; s = s->next) {
        wpk_rect(c->wpk, s->x, s->y - 24, s->width, 24,
                 s->focused ? WPK_RGB(60, 120, 180)
                            : WPK_RGB(80, 80, 80));
        if (s->title)
            wpk_text(c->wpk, c->font, s->x + 8, s->y - 8,
                     s->title, WPK_RGB(220, 220, 230));
    }
    /* Software cursor. */
    wpk_rect(c->wpk, c->cursor_x, c->cursor_y, 12, 16,
             WPK_RGB(255, 255, 255));
    wpk_line(c->wpk, c->cursor_x, c->cursor_y,
             c->cursor_x + 11, c->cursor_y + 15, WPK_RGB(0, 0, 0));
}
```

**Commit:** `examples(wpk): wpkcompositor — window decorations + software cursor (libwpkdraw-backed)`

### Task D7: Phase D — full gauntlet + open PR #4

PR title: `[explore-dri] examples(wpk): wpkcompositor — PID 2 server + custom protocol`

Body: design §9 implementation, 24-message wire from §9.2, libinput +
xkb pipeline, surface composition + decorations + cursor, event-
loop poll architecture, ~1.2 kLoC total.

---

## Phase E — wpkdraw client-mode amendment + demo + browser (PR #5)

Plan 8's wpkdraw gains a "compositor client mode" so the existing
demos seamlessly switch between direct-KMS (when no compositor) and
compositor-client (when one is present).

### Task E1: wpkdraw amendment — detect compositor + switch modes

**Files:**
- Modify: `examples/libs/wpkdraw/src/wpkdraw.c` — add compositor-
  client mode under a runtime check; ~50 LoC.

```c
// In wpkdraw.c — add at the top of wpk_surface_create:
struct wpk_surface *wpk_surface_create(int *out_w, int *out_h) {
    /* Detect compositor first. */
    struct wpk_client *cl = wpk_client_connect();
    if (cl)
        return wpk_surface_create_via_compositor(cl, out_w, out_h);
    /* Fall back to direct KMS master mode (existing plan 8 code). */
    return wpk_surface_create_direct_kms(out_w, out_h);
}

/* New internal function: allocate bos via renderD128 (no master),
 * send to compositor via ATTACH_BUFFER. */
struct wpk_surface *wpk_surface_create_via_compositor(
        struct wpk_client *cl, int *out_w, int *out_h) {
    struct wpk_surface *s = calloc(1, sizeof *s);
    s->client = cl;
    /* Compositor tells us the surface dims (it's authoritative). */
    s->width = 640; s->height = 480;  /* default; could be negotiated */
    s->surface_id = wpk_client_create_surface(cl, s->width, s->height,
                                              GBM_FORMAT_ARGB8888);
    /* Allocate two bos via renderD128 (no master needed). */
    s->fd_render = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    s->gbm = gbm_create_device(s->fd_render);
    s->bo_front = gbm_bo_create(s->gbm, s->width, s->height,
                                GBM_FORMAT_ARGB8888,
                                GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
    s->bo_back = gbm_bo_create(s->gbm, s->width, s->height,
                               GBM_FORMAT_ARGB8888,
                               GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
    s->back_pixels = gbm_bo_map(s->bo_back, 0, 0, s->width, s->height,
                                GBM_BO_TRANSFER_WRITE, NULL, &s->back_map_data);
    s->back_stride = gbm_bo_get_stride(s->bo_back);
    /* Attach the back bo via prime fd; compositor scans out from
     * the *committed* one, which we toggle on each present. */
    if (out_w) *out_w = s->width;
    if (out_h) *out_h = s->height;
    return s;
}
```

```c
/* wpk_surface_present under compositor-client mode: swap bos +
 * send ATTACH_BUFFER + COMMIT to the compositor. */
int wpk_surface_present_via_compositor(struct wpk_surface *s) {
    /* Swap front/back. */
    struct gbm_bo *tmp = s->bo_front;
    s->bo_front = s->bo_back;
    s->bo_back = tmp;
    /* Re-acquire back-pixel mapping for the (now) back bo. */
    s->back_pixels = gbm_bo_map(s->bo_back, 0, 0, s->width, s->height,
                                GBM_BO_TRANSFER_WRITE, NULL, &s->back_map_data);
    s->back_stride = gbm_bo_get_stride(s->bo_back);
    /* Export the front bo as prime fd. */
    int pfd = gbm_bo_get_fd(s->bo_front);
    if (pfd < 0) return -1;
    if (wpk_client_attach_buffer(s->client, s->surface_id, pfd) < 0) {
        close(pfd); return -1;
    }
    close(pfd);  /* compositor holds a ref via gbm_bo_import */
    return wpk_client_commit(s->client, s->surface_id);
}
```

The `wpk_widget_pump_events` in compositor-client mode is also
amended — instead of reading from `/dev/input/event0` + `event1`,
it calls `wpk_client_poll` and converts WPK_CLIENT_KEY /
WPK_CLIENT_POINTER_* events into the existing `wpk_event` shape.
Direct-KMS callers see no change.

```c
int wpk_widget_pump_events_via_compositor(struct wpk_surface *s,
        struct wpk_button *buttons, int n_buttons,
        struct wpk_event *out_ev, int max_events) {
    struct wpk_client_event cev[64];
    int n = wpk_client_poll(s->client, cev, n_buttons ? max_events : 0);
    int out_n = 0;
    for (int i = 0; i < n; i++) {
        switch (cev[i].type) {
        case WPK_CLIENT_KEY:
            if (cev[i].key.keycode == KEY_ESC && cev[i].key.pressed) {
                out_ev[out_n++].type = WPK_EV_QUIT;
            } else {
                out_ev[out_n].type = WPK_EV_KEY;
                out_ev[out_n].key.keycode = cev[i].key.keycode;
                out_ev[out_n].key.pressed = cev[i].key.pressed;
                out_n++;
            }
            break;
        case WPK_CLIENT_POINTER_MOTION:
            /* Use absolute coords from the compositor's hit-test. */
            out_ev[out_n].type = WPK_EV_POINTER_MOTION;
            out_ev[out_n].pointer_motion.x = cev[i].pointer_motion.x;
            out_ev[out_n].pointer_motion.y = cev[i].pointer_motion.y;
            out_n++;
            break;
        /* … pointer_button + window_close → quit … */
        default: break;
        }
    }
    return out_n;
}
```

**Commit:** `sysroot(wpkdraw): compositor-client mode — surface_create + present + pump_events fall-through`

### Task E2: wpkdraw_demo in compositor-client mode

The existing `programs/wpkdraw_demo.c` from plan 8 doesn't need
changes — the wpkdraw library auto-detects the compositor inside
`wpk_surface_create`. The demo just works in both modes.

Add a new vitest spec `host/test/wpk-multiplex.spec.ts`:
- Spawn wpkcompositor; wait for `/run/wpk/comp` socket.
- Spawn wpkdraw_demo (auto-detects compositor).
- Spawn a second wpkdraw_demo (also auto-detects, gets its own
  surface id).
- Assert the compositor renders BOTH demos visibly (count GL draw
  calls to the host's gl_draw_textured_quad; expect 2 per frame).
- Assert clicking the first demo's "Cycle" button fires its
  on_click, NOT the second demo's.
- Assert ESC on the focused window quits ONLY that window.

**Commit:** `examples(wpk): wpk-multiplex vitest — two wpkdraw clients under wpkcompositor`

### Task E3: Manual browser verification (the gate)

CLAUDE.md item 6. Build the compositor + two demos, wire into
`examples/browser/pages/wpk-multiplex/`. The browser page mounts
the wpkcompositor at PID 2 + two wpkdraw_demo instances; clicking
"Run" boots:

1. wpkcompositor takes KMS master, listens on `/run/wpk/comp`.
2. wpkdraw_demo #1 connects, creates a 640×480 surface at
   compositor-chosen (50, 50).
3. wpkdraw_demo #2 connects, creates a 640×480 surface at
   compositor-chosen (250, 200).
4. Both windows render with title-bar decorations (a 24 px blue/
   grey strip with the title text).
5. Mouse over either window highlights its border; clicking
   focuses it; keystrokes route to the focused window.
6. ESC on the focused window quits IT, not the other one.
7. Quitting both demos returns the compositor to the empty desktop.
8. Killing the compositor (signal 9 from a test harness) causes
   both still-running demos to fall back to direct-KMS mode (but
   one fails on `drmSetMaster` EBUSY — the design constraint).

If the cursor doesn't track, libinput dispatch failed — check
`/dev/input/event1` is being read.

If decorations don't render, the compositor's `eglSwapBuffers` isn't
hitting plan 4's PAGE_FLIP path — check `host_kms_page_flip`
counts.

**No commit yet for this task — verification only.**

### Task E4: Phase E — final gauntlet + open PR #5

PR title: `[explore-dri] sysroot(wpkdraw)+examples(wpk): wpkdraw compositor-client mode + multiplex demo + browser spec`

Body covers: wpkdraw amendment (additive, doesn't break direct-KMS
callers), two-demo vitest, manual browser confirmation of
multiplexing + focus + decorations + ESC routing. ABI impact: none.

---

## Final coordinated merge

When all five PRs are reviewed and approved, the browser
verification passes:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 (libxkbcommon) → PR #2's base.
3. Squash-merge PR #2 (libinput) → PR #3's base.
4. Squash-merge PR #3 (libwpkclient) → PR #4's base.
5. Squash-merge PR #4 (wpkcompositor) → PR #5's base.
6. Squash-merge PR #5 (wpkdraw amendment + demo) → plan 8's
   `…-wpkdraw-demo` (or wherever plan 8's tip lives at the time).
7. Tag: `[explore-dri-wpkcompositor] plan 9 merged at <sha>` in the
   next session-handoff doc.

**Do not push to upstream until v1 + plans 2–9 are all merged
upstream as a coherent chain.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **Custom protocol, not Wayland.** Per design §9.5 — 1 week vs 6
  weeks. Post-v1 Wayland compat layer (`libwayland-server` bridge)
  re-uses the same KMS/GBM/multiplexer surface; the work isn't
  wasted. 24 message types, no global registry, no version
  negotiation, no xdg-shell state machine.
- **libxkbcommon real, not hand-rolled.** Hand-rolled would be
  ~3000 LoC of keymap-text parser + symbol tables — error-prone
  and error-replicating-Linux-existing-bugs. Port real (1.6.0,
  ~6000 LoC subset, ~150 KB static lib).
- **libinput real, not lite stub.** Plan 7's libinput-lite stub
  was sufficient for SDL2's basic key+button needs but lacks
  gesture detection, palm rejection, multi-device fan-out
  semantics. Compositor needs these. Port real (1.25.0, ~50 kLoC
  upstream, ~400 KB subset).
- **Path-mode libinput, no libudev.** v1 has no udev daemon;
  libinput's `libinput_path_create_context` + explicit
  `libinput_path_add_device("/dev/input/event0", …)` /
  `event1` works. No device hotplug in v1 (the canvas-as-display
  abstraction is fixed at boot).
- **No tablet / trackpoint / touchscreen drivers in libinput
  subset.** Keyboard + pointer only. v2 may add.
- **Compositor is single-threaded, single-poll.** No worker
  threads, no GL command queueing beyond plan 3's submit queue.
  Per design §9 + the no-pthreads rule.
- **24 message types, hand-rolled C serialiser.** No protobuf,
  no flatbuffers. Wire format is `(u32 length | u32 type | u8
  payload[])`; payload is a `repr(C)` struct per message type.
  SCM_RIGHTS on AF_UNIX for prime-fd attach.
- **Per-client state in a `struct compositor_client *` linked
  list.** No map, no hash table — N clients in v1 is ≤ 16
  (limited by `listen(sock, 16)`); linear scan is fine.
- **Window placement is compositor-chosen.** v1 doesn't expose
  a "set position" message; the compositor picks (50, 50),
  (250, 200), … in a cascade. v2 may add xdg-positioner.
- **Software cursor.** Hardware cursor planes are a v2 feature
  (would require plan 4 to expose `MODE_CURSOR2`).
- **PID 2 is the compositor.** Init reserves the slot via the
  fork-exec amendment. Plan 11 (seed apps) start at PID 3+.
- **Compositor crash → clients fall back to direct-KMS** (where
  possible). One client can recover; subsequent clients hit
  EBUSY on `drmSetMaster` — they exit with an error message.
  v2: a compositor-restart watchdog is post-v1.
- **No multi-monitor.** Single CRTC, single connector, single
  mode — matches plans 4's invariant.
- **`gbm_surface_*` from plan 2's follow-up.** Compositor uses
  `gbm_surface_create_with_modifiers` + `gbm_surface_lock_front_buffer`
  for its own back-buffer rotation; clients use raw `gbm_bo`s.
- **Compositor links libwpkdraw statically for decorations.**
  Title bars + cursor + borders use plan 8's 2D primitives + the
  DejaVu Sans font. No new font dependency.
- **No animation framework.** Compositor's compositing is per-
  frame redraw on `dirty` flag; no tween, no animation timer.
- **Zero ABI impact.** No kernel exports, no host imports, no
  ioctls, no device nodes added. All surface is userspace +
  existing SCM_RIGHTS + existing KMS/GBM/evdev/sockets surfaces.

---

## Risk register

1. **plan-6-sockets-plan's SCM_RIGHTS path may not be landed when
   plan 9 implementation starts.** The plan exists in
   `docs/plans/2026-03-08-phase6-sockets-plan.md` and is
   load-bearing for the compositor's prime-fd attach. *Mitigation:*
   audit + complete the sockets plan BEFORE plan 9 implementation
   opens; if not landed, plan 9 carries an inline sub-plan to ship
   it (extending phase scope by ~1 week).
2. **libxkbcommon + libinput cross-compile under wasm32posix-cc.**
   Both are real upstream code with meson build systems; meson +
   wasm32 is a known footgun (plan 7 A2 line 648 explicitly
   bypasses meson). Hand-rolled Makefile per A2 + B3 expected to
   take 2-3 build rounds for clean subset compile. *Mitigation:*
   budget 2 extra days in Phase A + Phase B for symbol-resolution
   iteration.
3. **Compositor's EGL + gbm_surface ordering with plan 4's vblank
   tick.** The compositor calls `eglSwapBuffers(gbm_surface)`
   internally; the EGL stub calls `gbm_surface_lock_front_buffer`;
   the resulting `MODE_PAGE_FLIP` fires plan 4's vblank tick on
   the next host RAF. If the tick fires *during* the next
   `eglSwapBuffers`, the lock-front-buffer call might see the
   previous bo still locked (PAGE_FLIP outstanding). *Mitigation:*
   the compositor's event loop drains `card0` POLLIN BEFORE
   calling `compositor_render_frame`, so FLIP_COMPLETE records
   are consumed first. Verify in Phase E vitest.
4. **libinput's filter chain is sluggish for v1's synthetic
   evdev devices.** libinput's acceleration profiles + palm
   rejection are tuned for real hardware (mouse jitter, touch
   noise); on plan 5's BUS_VIRTUAL synthetic devices the inputs
   are perfectly clean and libinput may over-process. *Mitigation:*
   the quirks file (B4) marks the devices as
   `ModelGenericKeyboard=1` / `ModelGenericMouse=1`, which
   disables most filtering. Profile in E3; revisit if cursor
   feels laggy.
5. **xkbcommon data files (2 MB at `/usr/share/X11/xkb/`)** bloat
   the rootfs. v1's WordPress demo rootfs is ~30 MB; +2 MB is
   marginal. *Mitigation:* strip to absolute minimum (us layout
   only, no compose, no extras). Already done in A3.
6. **Wire format versioning.** v1's protocol has no version
   negotiation; if v2 changes a message struct, client + server
   must be rebuilt together. *Mitigation:* document as a v1
   constraint; reserve a `WPK_MSG_VERSION` message type for v2.
   No code in v1.
7. **Compositor as PID 2 vs existing init.** The amendment to
   init in D1 must NOT break the WordPress demo's boot path
   (which doesn't ship `/etc/wpk/compositor`). *Mitigation:* the
   check is `access("/etc/wpk/compositor", F_OK) == 0` — absent
   file = no compositor; matches existing behaviour byte-for-byte.
8. **wpkdraw + SDL2 contending for compositor focus.** In Phase
   E's two-client demo, both clients receive INPUT_KEYBOARD when
   focused; the unfocused one receives nothing. Focus cycle is
   `Super+Tab` (hardcoded in D4). *Mitigation:* document the
   focus model + the hotkey in the compositor's --help (which
   v1 doesn't have; defer to v2).
9. **`/run/wpk/comp` socket leaks if the compositor SIGKILLed.**
   `unlink("/run/wpk/comp")` happens at compositor bind time, so
   a re-launch will clear stale state. *Mitigation:* sufficient
   for v1.
10. **GL context loss during compositor → client switch.** Plan
    3's per-OFD GL context model means each client has its own
    context (texture upload, shader, FBO). The compositor's
    sampling of a client's bo as a foreign texture requires plan
    3 A4's `WPK_BIND_FOREIGN_TEXTURE`. *Mitigation:* plan 3 already
    ships this; verify the binding works through
    `gbm_bo_import` → host-side WebGLTexture mapping → compositor's
    GL context sees the texture.

---

## What this plan doesn't cover (deferred)

- **Wayland wire compatibility** (post-v1, §15) — bridges
  `libwayland-server` to this plan's custom wire so unmodified
  Wayland apps work. ~6 weeks.
- **SDL2 backend amendment for the wpk protocol.** Plan 11 (seed
  apps) ships an SDL2 video backend `SDL_wpkvideo.c` that uses
  libwpkclient instead of the KMSDRM path. v1's SDL2 demo (plan 7)
  uses KMSDRM directly and is incompatible with the compositor;
  v2's SDL2 demo uses the wpk backend.
- **XDG-shell-style state machine.** Wayland has explicit
  `configure` / `ack_configure` / `commit` rounds; v1's protocol
  is simpler — `COMMIT` is the atomic boundary. v2 may add
  configure rounds.
- **Multi-monitor.** Single CRTC, single connector — matches plan 4.
- **Output rotation / scaling / DPI awareness.** v1 is 1.0× only.
- **Hardware cursor plane.** Software cursor only.
- **Touch / pen / tablet input.** libinput's keyboard + pointer
  subset only.
- **Client surface scaling (e.g., HiDPI).** v1 surfaces are 1:1
  pixel-mapped to compositor backbuffer; no resampling.
- **Window resize messages from compositor → client.** v1's
  surface dimensions are client-chosen at CREATE_SURFACE time and
  immutable. v2 may add `RESIZE`.
- **Cursor theme / animated cursors.** Software cursor is a
  hardcoded white-arrow-with-black-outline. v2 may add themes.
- **Pop-up menus + tooltips.** Plan 8's wpk_widget surface is
  in-process; the compositor doesn't manage popup-menu z-order
  beyond a flat "panel | toplevel | popup" three-tier ordering.
  Stacked popups are v2.
- **Drag-and-drop / clipboard.** Design §9.2 reserves
  CLIPBOARD_SET / CLIPBOARD_REQUEST / CLIPBOARD_DATA message
  types; v1 plan 9 doesn't implement them. Plan 11 (seed apps)
  or v2 may add.
- **Compositor restart watchdog.** A dead compositor leaves
  clients orphaned; restart is manual via the launcher.
- **Plumbing for SDL2 audio thread.** Plan 7's open-architecture
  #1 (audio thread via libpthread shim OR SDL2 polling patch)
  is INDEPENDENT of plan 9; the compositor doesn't manage audio.

---

End of plan.
