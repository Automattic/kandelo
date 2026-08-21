# Omarchy port — building toward a Hyprland-class compositor (tiered plan)

Date: 2026-07-14
Branch: `explore-dri-wayland`
Status: **PLAN ONLY — no implementation, no commits without user approval.**

> **Relationship to other plans.** This document extends
> `2026-07-08-dri-wayland-compositor-plan.md` past its §7 post-v1
> milestones. It does not supersede anything: PR10–PR13 (GPU tier,
> dmabuf, SDL2 wayland backend, wlcube) remain exactly as planned there
> (§7.1) and are the **Tier 0 prerequisite** of this plan. The GTK/glib
> milestone already named in that plan's §7 becomes **Tier 2** here,
> with concrete scope.

---

## §1. What Omarchy is, and what "porting Omarchy" means

[basecamp/omarchy](https://github.com/basecamp/omarchy) is **not an
application**. It is an opinionated Arch Linux setup: ~82% shell
scripts, plus themes (colors/wallpapers/per-app config fragments),
dotfiles, and glue — all layered over a specific desktop stack:

| Omarchy component | What it actually is |
|---|---|
| Hyprland | GL tiling compositor (C++26, aquamarine backend, wlroots lineage) |
| Waybar | Status bar (GTK3), fed by Hyprland's IPC socket |
| Walker | App launcher (GTK4/gtk-layer-shell) |
| mako | Notification daemon (wayland + cairo/pango + dbus) |
| alacritty / ghostty | GPU-accelerated terminals (Rust+GL / Zig+GL) |
| hyprlock / hypridle | Lock screen / idle daemon (Hyprland ecosystem) |
| Chromium, neovim, … | The apps |
| pacman + systemd | Assumed by every install/update script |

So "porting Omarchy" decomposes into two very different goals:

- **Goal I (imitate):** a desktop that *looks and behaves* like Omarchy
  — tiling, SUPER-key bindings, a top bar, a launcher, Omarchy's actual
  themes — built by growing our own `wlcompositor` and clients.
- **Goal L (literal):** *actually running* Hyprland + Waybar + Walker +
  mako unmodified on this kernel. This requires emulating the Linux GPU
  userspace ABI (atomic KMS, GBM, EGL-on-GBM), session plumbing
  (udev/seatd/logind), and the GTK/glib stack — a "become Linux"
  multi-quarter effort.

**This plan tiers the work so Goal I ships first and each step toward
Goal L is separately de-risked and separately cancellable.** Every tier
ends at a go/no-go point with a concrete demo gate; stopping at any
tier still leaves shipped, user-visible value.

### The tier ladder at a glance

| Tier | Name | Outcome | Exit gate |
|---|---|---|---|
| 0 | GPU tier (already planned) | PR10–13: `WPK_CREATE_GPU_BO`, dmabuf, SDL2-wayland, wlcube | existing §7.1 gates |
| 1 | **Imitate** | Omarchy-lookalike desktop on `wlcompositor` | **O1** demo |
| 2 | **Selective ports + GTK/glib** | unmodified foot, then Waybar/mako via real GTK3 stack | **O2** demo |
| 3 | **Driver-shaped stack** | atomic KMS + GBM + EGL-on-GBM + session plumbing; tinywl → sway → Hyprland | **O3/O4/O5** gates |

Explicitly **out of scope at every tier**: Chromium (forever), real
systemd and pacman (replaced/faked — see §6.4), Xwayland, hardware
display timing.

---

## §2. Starting point (what exists as of PR8, commit `2d02785e9`)

The analog layer, PR3–PR8 of the Wayland plan:

- `libwayland` client+server, `libxkbcommon` 1.7.0, real `libinput`
  1.25.0 over `libevdev` + `libudev`/`mtdev` shims.
- DRM/KMS node: dumb bos, PRIME fd-passing over `SCM_RIGHTS`, ADDFB2,
  SETCRTC/PAGE_FLIP + vblank pump, virtual connector with dynamic
  preferred mode. **Legacy KMS only — no planes, no atomic, no
  modifiers.**
- `wlcompositor` (PID 2): `wl_shm`, `xdg_shell` toplevels (no popups,
  no subsurfaces), `wl_seat`/`wl_output`, focus + move-grabs, CSD
  clients, GPU compositing via `WPK_BIND_FOREIGN_TEXTURE` (CPU-tier bos
  uploaded to `WebGLTexture`s, quads on the CRTC canvas), CPU fallback.
- WebGL2 scanout presenter; three-client desktop demo (`/?demo=wayland`)
  with wlclock/wlterm/wlpaint on `libkwl` + `wpkdraw`.

Tier 0 (PR10–13) then converts client GL from "not possible" to
zero-copy: GPU-tier bos as FBO-backed `WebGLTexture`s on one
`GlMuxer`-shared context, `zwp_linux_dmabuf_v1`, SDL2's upstream
wayland backend, `wlcube`. This plan assumes Tier 0 is done; its two
carried risks (process-exit release of GPU bos, SwiftShader behavior)
must be closed before Tier 1 starts (go/no-go **A**, §7).

---

## §3. Tier 1 — Imitate: the Omarchy-lookalike (PR14–PR18)

Grow `wlcompositor` + our own clients into an Omarchy-shaped desktop.
No new library ports; everything builds on `libkwl`/`wpkdraw` and the
protocol code we already generate from vendored XML. This is
deliberately the same "own apps first" strategy that made the Wayland
pivot land (§1 of the Wayland plan).

### PR14 — Tiling window management + `kwlctl` IPC

- **Tiling layout engine** in `wlcompositor`: Hyprland's default
  *dwindle* layout (recursive binary split, new window splits the
  focused leaf along its longer side), master/stack as a second layout,
  floating override per window. Gaps + border colors (theme-driven,
  PR17). Tiled windows get their geometry dictated via
  `xdg_toplevel.configure`; interactive move-grab switches a window to
  floating (Hyprland behavior).
- **Workspaces**: N workspaces on the single output; per-workspace
  window lists; switch/move-to-workspace operations.
- **Keybinding engine**: compositor-side SUPER-key bindings mirroring
  Omarchy defaults (SUPER+Return terminal, SUPER+Space launcher,
  SUPER+W close, SUPER+J/K focus cycle, SUPER+1..N workspaces,
  SUPER+SHIFT+1..N move-to-workspace, SUPER+F fullscreen/float toggle).
  Config file `/etc/kandelo/wlcompositor.conf` in an
  hyprland.conf-shaped `bind = SUPER, RETURN, exec, wlterm` syntax
  subset — same *shape* as Omarchy's config so themes/dotfiles can
  carry binding fragments later.
- **`kwlctl`**: a control socket (`/tmp/kwlctl-0`, AF_UNIX) + CLI
  mirroring `hyprctl`'s role, because *this is how Omarchy actually
  works* — its scripts and Waybar modules talk to Hyprland's IPC
  socket. v1 verbs: `dispatch <op>` (exec/close/workspace/movetoworkspace/
  fullscreen), `workspaces` / `clients` / `activewindow` (JSON output),
  `keyword` (runtime config set), and an event-subscribe mode
  (`kwlctl --listen`) streaming workspace/focus/title events — the feed
  the Tier 1 bar (and later real Waybar's `hyprland/workspaces`-style
  module) consumes.
- **xdg-decoration** (`zxdg_decoration_manager_v1`): server-side
  decoration mode so tiled windows drop CSD; `libkwl` honors the mode
  (title bars off when tiled). Protocol XML vendored alongside the
  existing set.

Gates: node smoke (`host/test/wlcompositor-tiling-smoke.test.ts`) —
spawn 3 clients, assert dwindle geometry via `kwlctl clients`; keybind
smoke — inject SUPER+combos through evdev, assert workspace/focus
changes via `kwlctl --listen`; all existing wayland gates stay green
(floating three-client demo must keep working — the `/?demo=wayland`
demo becomes "floating mode" of the same compositor).

### PR15 — `wlr-layer-shell` + `kbar` (status bar)

- **`zwlr_layer_shell_v1`** in `wlcompositor`: layers
  (background/bottom/top/overlay), anchors, exclusive zones (tiling
  area shrinks under an anchored bar — this integrates with PR14's
  layout engine, which is why layer-shell lands right after tiling),
  keyboard-interactivity modes. This protocol is the single most
  load-bearing one for the whole plan: the Tier 1 bar and launcher,
  Tier 2's Waybar and mako, all speak it. Vendor the upstream XML.
- **`kbar`**: `libkwl`/`wpkdraw` layer-shell client, top-anchored,
  exclusive zone. Modules mirroring Omarchy's Waybar default lineup at
  imitation fidelity: workspaces (via `kwlctl --listen`), focused
  window title, clock, and a status area (kernel-real stats where cheap
  — e.g. `/proc`-style uptime/mem if exposed; otherwise omit rather
  than fake).
- **Wallpaper via layer-shell background layer**: move wlcompositor's
  built-in wallpaper to a `kwallpaper` client on the background layer
  (or keep internal but layer-aware) — decides how Omarchy's
  swaybg-shaped wallpaper slot maps.

Gates: layer-shell node smoke (exclusive zone shrinks tiling area —
assert via `kwlctl clients` geometry); browser demo gains the bar.

### PR16 — `klauncher` + `xdg_popup`

- **`klauncher`**: Walker-shaped fuzzy launcher — overlay-layer
  layer-shell surface, keyboard-exclusive, type-to-filter over a
  desktop-entry-like registry (`/usr/share/kandelo/apps/*.toml`:
  name/exec/icon-color), Enter → compositor `exec` via `kwlctl`,
  ESC closes. Bound to SUPER+Space.
- **`xdg_popup` + positioner**: still missing from `wlcompositor`
  (deferred since the original PR8). Needed eventually by every real
  toolkit (GTK menus/tooltips in Tier 2); land it now while the
  compositor's surface-role code is hot, with a `libkwl` context-menu
  helper + smoke test as the consumer.

Gates: launcher node smoke (spawn via injected keys → new client
appears in `kwlctl clients`); popup smoke (positioner-constrained
placement asserted).

### PR17 — Omarchy theme system

Omarchy's theme system is its most distinctive user-facing feature and
it is *just files*: `~/.config/omarchy/themes/<name>/` directories
holding per-app config fragments (hyprland colors, waybar CSS,
alacritty colors, mako ini, …) + `backgrounds/`, switched by re-linking
`current` and poking each app. That design ports almost 1:1:

- **Theme package**: vendor 2–3 actual Omarchy themes' *assets*
  (colors + wallpapers; upstream is MIT-licensed — verify per-theme
  wallpaper licensing before vendoring, some wallpapers carry separate
  licenses; substitute free wallpapers where unclear) under a
  `packages/registry/omarchy-themes/` data package into the VFS at
  `/usr/share/kandelo/themes/<name>/`.
- **Theme schema**: `theme.toml` (border/focus/background/foreground/
  accent colors) + `backgrounds/`. A translator script in the package
  build converts the Omarchy fragment formats into `theme.toml` so
  upstream theme drops stay importable.
- **Runtime switching**: `kwlctl dispatch theme <name>` — compositor
  reloads border/gap colors + wallpaper live; `kbar`/`klauncher`
  subscribe via `kwlctl --listen` and re-read the theme. SUPER+CTRL+
  SHIFT+Space cycles themes (Omarchy's binding).
- Per CLAUDE.md, demo presentation prefs stay in the VFS image
  (`/etc/kandelo/demo.json` via `writeKandeloDemoConfig()`), not the
  app loader.

Gates: theme-switch node smoke (border color change observable via a
compositor sample marker; wallpaper bo swap); browser gate asserts a
visible palette change across a cycle.

### PR18 — The **O1** demo: "Omarchy imitation" browser gate

Integration PR: `/?demo=omarchy` boots wlcompositor in tiling mode +
`kbar` + wallpaper, `wlterm` on SUPER+Return, `klauncher` on
SUPER+Space, 2–3 themes cycling. Playwright gate
(`apps/browser-demos/test/kandelo-omarchy.spec.ts`):

1. bar visible with workspaces + clock (pixel/marker assertions);
2. SUPER+Return twice → two terminals *tiled side-by-side* (geometry
   from `kwlctl` matches dwindle);
3. SUPER+2 → empty workspace; SUPER+1 → windows return;
4. launcher opens, type-filter, Enter spawns wlpaint into the tiling;
5. theme cycle changes border+wallpaper pixels;
6. all existing wayland/modeset/sdl2 gates stay green, both hosts.

**O1 = this gate green.** That is the concrete definition of "an
Omarchy-shaped desktop exists on kandelo".

Tier 1 risk notes: low library risk (no new ports). The two real risks
are compositor complexity creep in C (`wlcompositor.c` is already the
largest program; PR14 should split it into `layout.c` / `ipc.c` /
`render.c` TUs) and keybinding/grab interaction bugs with the
peg-and-jump pointer emulation (regression-covered by the existing
drag gates).

---

## §4. Tier 2 — Selective ports + the GTK/glib milestone (PR19–PR24)

Goal: run *unmodified upstream* pieces of the Omarchy stack that don't
require a new graphics driver model — proving app-compat before
touching the driver tier. Two sub-tiers with an internal ordering
rationale: `foot` first because it exercises the font stack without
glib; then the glib stack; then GTK.

### PR19 — Font stack + `foot` (unmodified wayland-native terminal)

- Ports: **freetype**, **fontconfig** (minimal config, fonts vendored
  into the VFS image), **pixman**, **fcft**, **utf8proc** → **foot**
  (C, wayland-native, wl_shm rendering, no glib, no GL required).
- foot is the cheapest "unmodified real app" proof and each dep is
  reused by everything after (pixman/fontconfig/freetype → cairo/pango
  → GTK). Server-side: foot needs `xdg-decoration` (PR14 ✓),
  `presentation-time` (add here — thin: clock_id + feedback events off
  the existing PAGE_FLIP timestamps) and gracefully degrades without
  the rest.
- Gate: foot boots under the compositor, runs `dash`, types/echoes
  (reuse the wlterm smoke pattern), tiles correctly.

### PR20 — Full libffi (**the** Tier 2 technical crux)

glib/gobject need real `ffi_call` (doubles, by-value structs) and —
the hard part — **`ffi_closure`**, which on native targets JIT-writes
trampolines. wasm32 cannot generate code at runtime.

- **Approach: static trampoline pool** (the pattern emscripten's libffi
  port proved viable): a compile-time-generated table of N trampoline
  functions per signature class, each baked into the function table;
  `ffi_prep_closure_loc` allocates one from the pool and records
  cif+user-data in a side table; the trampoline indexes the side table
  and dispatches through a generic marshaller. Pool exhaustion aborts
  loudly (size generously; gobject creates closures per signal
  connection).
- Extend, don't replace: the PR1 Wayland-scoped shim's call path grows
  real type classification (floats/doubles/structs per the wasm32 C
  ABI: structs >1 word passed by pointer — verify against clang's
  actual lowering, this is where silent corruption would live).
- **De-risk first, like PR1 did for the shim**: the PR starts with an
  exhaustive native+wasm unit test matrix (arities × {i32, i64, f32,
  f64, small-struct, big-struct} × call/closure) before any glib work.
- Gate: `host/test/libffi-full-unit.test.ts` matrix green under the
  kernel.

### PR21 — glib/gobject/gio

- Port glib 2.x: gmain loop (epoll/poll — already proven primitives),
  gthread over pthreads (kernel has clone/futex), gobject (closures →
  PR20), gio *minus* gdbus initially. `GSpawn` uses
  fork/exec — fork instrumentation is **mandatory** per CLAUDE.md
  (`scripts/run-wasm-fork-instrument.sh` in the build).
- Meson-heavy build → same bypass pattern as libxkbcommon/libinput
  (hand-curated `config.h`, curated TU list). glib is much bigger;
  budget accordingly.
- Gate: glib testsuite subset (mainloop, gobject signals, gspawn) as a
  kernel smoke.

### PR22 — dbus (needed by mako, tray, and most of the GTK world)

- Port a session **dbus daemon** (reference `dbus-daemon` or the
  smaller `dbus-broker` — pick after a build-surface probe;
  dbus-broker assumes more Linux-isms, reference daemon is autoconf +
  our cross-compile pattern) + `libdbus`/gdbus client side.
  AF_UNIX + SCM_RIGHTS + epoll are already proven, so this is
  port-shaped, not kernel-shaped.
- Gate: two-process gdbus ping smoke; `notify-send`-shaped client →
  daemon → monitor round trip.

### PR23 — cairo + pango + harfbuzz

- cairo (image surface only — no cairo-gl; GTK3 renders to wl_shm via
  image surfaces), pango + harfbuzz on the PR19 font stack.
- Gate: pango-cairo render smoke (text into a wl_shm buffer, pixel
  hash under the kernel).

### PR24 — GTK3 + **Waybar** + **mako**: the **O2** gate

- GTK3 (wayland backend only; no X11, no broadway) — the single
  biggest port of Tier 2. Then **Waybar** (GTK3; its Hyprland modules
  speak Hyprland's IPC — point them at `kwlctl`'s socket, implementing
  the small JSON surface they consume, which PR14 designed for exactly
  this) and **mako** (layer-shell + cairo + gdbus, needs PR22).
- Compositor protocol additions surfaced by GTK: `wl_subsurface`,
  `xdg-output`, `viewporter`, `fractional-scale-v1` (can ship fixed
  scale-1 initially), clipboard (`wl_data_device_manager` — first real
  clipboard consumer).
- **O2 gate**: `/?demo=omarchy` swaps `kbar` → *unmodified Waybar*
  rendering with Omarchy's actual waybar config (translated), mako
  showing a real notification via gdbus, foot as the terminal. This is
  the "unmodified GTK app runs" milestone the Wayland plan's §7 named.

Tier 2 risks, ranked: (1) ffi_closure correctness (PR20 — mitigated by
the test-matrix-first rule); (2) GTK3 port sheer size (PR24 —
mitigated: every dep lands as its own gated PR, and a mid-tier
go/no-go **B′** after PR21 checks glib actually works before
cairo/GTK); (3) dbus daemon semantics (PR22 — scope to session bus,
no activation, no policy language beyond allow-all).

---

## §5. Tier 3 — The driver-shaped stack: toward literal Hyprland (PR25+)

Everything above runs on our *analog* of Linux graphics. A real
compositor (wlroots, aquamarine/Hyprland) is a **DRM master**: it
programs planes via atomic KMS, allocates scanout via GBM, and brings
up EGL on a GBM device. This tier emulates that userspace ABI. It is
the "become Linux" tier: multi-quarter, and only entered deliberately
(go/no-go **C**).

### PR25 — Timeboxed spike: `tinywl` gap audit (cheap probe, no port)

Before committing to the tier: compile **wlroots** (targeting its
DRM+libinput backends and GLES2 renderer, `WLR_RENDERER=gles2`) and
**tinywl** against the sysroot *without fixing anything*, and produce
the definitive missing-symbol/missing-ioctl list: every undefined
symbol, every ENOSYS/ENOTTY ioctl hit, every EGL entry point. The
Wayland pivot's feasibility table (§2 of that plan) is the model — a
verified inventory before investment. **Output: a gap report appended
to this doc + a revised Tier 3 estimate.** Go/no-go C is decided on
that report, not on this plan's guesses.

### PR26 — Atomic KMS (kernel)

- Universal planes (`DRM_CLIENT_CAP_UNIVERSAL_PLANES`): expose the
  existing single CRTC's primary plane as a real plane object
  (+ optional cursor plane later); `GETPLANERESOURCES`/`GETPLANE`.
- Property system: `OBJ_GETPROPERTIES`/`GETPROPERTY` on connector/
  CRTC/plane with the standard property set (`FB_ID`, `CRTC_ID`,
  `SRC_*`/`CRTC_*`, `MODE_ID`, `ACTIVE`, `IN_FENCE_FD` rejected
  cleanly), `CREATEPROPBLOB`/`GETPROPBLOB`.
- `DRM_IOCTL_MODE_ATOMIC` (TEST_ONLY + commit + page-flip event),
  mapping internally onto the proven SETCRTC/PAGE_FLIP/latch machinery.
- Format modifiers: advertise `LINEAR` only (`IN_FORMATS` blob,
  `ADDFB2` modifier validation).
- ABI review mandatory (new ioctls are additive; `check-abi-version.sh`
  per CLAUDE.md).
- Gates: kernel unit tests per ioctl + a C `atomic_smoke` doing a full
  atomic modeset+flip; legacy path regression-covered (all existing
  KMS gates stay green — legacy and atomic share the latch).

### PR27 — Real GBM semantics + EGL-on-GBM

- `gbm_surface` with a real N-buffer swapchain (`lock_front_buffer`/
  `release_buffer` age semantics), `gbm_bo_get_modifier`,
  modifier-aware `gbm_surface_create_with_modifiers` (LINEAR),
  GPU-tier bos (PR10) as the backing store.
- EGL: `eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR)`,
  `EGL_KHR_surfaceless_context`, `EGL_EXT_image_dma_buf_import` as the
  *real* extension (the `wpkEgl*` stand-ins become its implementation),
  `OES_EGL_image` + `glEGLImageTargetTexture2DOES` in the GLES stub,
  `EGL_KHR_fence_sync` (submit-queue order already gives the ordering;
  the fence objects are bookkeeping).
- Gate: `kmscube` (the upstream reference app) unmodified — atomic +
  GBM + EGL in one consumer, and famous enough that passing it means
  the ABI is genuinely Linux-shaped.

### PR28 — Session plumbing: udev monitor + libseat

- Extend the PR5b libudev shim: real `udev_enumerate` over
  `/dev/input/*` + `card0`, `udev_monitor` with hotplug events
  (kernel input hotplug → monitor fd readiness), the `drm` subsystem
  surface wlroots' backend queries.
- **libseat** port with a custom `kandelo` backend (the `noop`
  backend is the template: single-seat, opens devices directly, no
  seatd daemon, no VT switching — `open_device` = plain open + no
  master-drop since we're always the only session).
- logind: **not ported**; wlroots works via libseat alone. Omarchy
  scripts' `systemctl`/`loginctl` calls are Tier 3c adaptation work.
- Gate: wlroots' libinput backend enumerates devices through this path
  (part of PR29's boot).

### PR29 — wlroots + `tinywl`: the **O3** gate

- Port wlroots (DRM backend + libinput backend + GLES2 renderer +
  the protocol implementations we need; disable everything else —
  Xwayland, vulkan, session=libseat only).
- **O3 gate**: *unmodified* `tinywl` boots on the kernel, renders,
  tiles two clients (foot + wlpaint), handles keyboard/pointer, under
  both hosts + browser demo. This is the "a real compositor stack
  runs" proof — the single most information-dense gate of the plan.

### PR30 — `sway`: the **O4** gate ("Hyprland-class" proven)

- sway is C, wlroots-native, tiling, actively maintained, and far
  smaller than Hyprland's C++26 + aquamarine + hypr* ecosystem. It is
  the honest first "Hyprland-class compositor".
- **O4 gate**: sway boots with an i3-syntax config translated from
  Omarchy's bindings, Waybar (O2) runs on it via its sway IPC modules
  (native support — no shim needed), mako + foot + klauncher-equivalent
  (wofi would need GTK — reuse Walker only if Tier 2 reached GTK4,
  else keep `klauncher`).

### PR31+ — literal Hyprland: the **O5** gate (stretch)

- Hyprland proper: C++26 toolchain viability on wasm32 (exceptions,
  RTTI, threads — SpiderMonkey proved big C++ ports are possible),
  aquamarine (its own DRM/GBM/EGL backend — PR26–28 surface must
  satisfy it too), hyprutils/hyprlang/hyprcursor/hyprgraphics.
- **O5 gate = "Omarchy literal"**: Hyprland boots reading a real
  Omarchy `hyprland.conf` (bindings + theme colors subset), Waybar/
  mako/Walker on top, Omarchy's theme-switch script working end-to-end
  with `pacman`/`systemctl` calls mapped onto the kandelo package
  system (§6.4). Decided at go/no-go **D**, only after O4.

---

## §6. Cross-cutting concerns

### §6.1 Protocol surface roadmap (compositor-side, cumulative)

| Protocol | Tier / PR | Consumer that forces it |
|---|---|---|
| xdg-decoration | 1 / PR14 | tiled windows (CSD off), foot |
| wlr-layer-shell | 1 / PR15 | kbar, klauncher; Waybar, mako |
| xdg_popup + positioner | 1 / PR16 | GTK menus (Tier 2), libkwl menus |
| presentation-time | 2 / PR19 | foot |
| wl_subsurface, xdg-output, viewporter, fractional-scale (fixed 1), wl_data_device (clipboard) | 2 / PR24 | GTK3 |
| cursor-shape, foreign-toplevel, screencopy, idle-notify, session-lock | 3 (as consumers demand) | sway/Hyprland ecosystem, hyprlock/hypridle analogs |

### §6.2 Docs (per CLAUDE.md, every PR)

`docs/architecture.md` (compositor/IPC/atomic-KMS changes),
`docs/posix-status.md` (new ioctls/syscalls), `docs/browser-support.md`
(demo + Kandelo demo metadata), `docs/porting-guide.md` (each library
port pattern), `README.md` at O1/O2/O3 milestones.

### §6.3 Dual-host parity

Every host-touching PR (presenter, pump, input bridge, `kwlctl`
routing if host-visible) lands Node + browser in the same commit, with
the symmetry grep from CLAUDE.md. Playwright gates for browser,
vitest smokes for Node, per the established pattern.

### §6.4 pacman / systemd

Never ported. Omarchy's install/update scripts are adapted at Tier 3c:
`pacman -S x` → the kandelo package/VFS-image system; `systemctl
--user` units for hypridle-alikes → compositor-internal timers or a
tiny supervisor. This is script translation, not system emulation —
and it's the part of Omarchy that is *pure shell*, which the kernel
already runs.

### §6.5 Fork instrumentation

glib's GSpawn, dbus activation (excluded), sway/Hyprland `exec`
dispatchers all fork+exec: every new package build script runs
`scripts/run-wasm-fork-instrument.sh`; missing instrumentation must
fail the build (CLAUDE.md policy — no Asyncify anywhere).

---

## §7. Go/no-go points

| Point | When | Question decided | Default |
|---|---|---|---|
| **A** | after Tier 0 (PR13) | GPU tier stable? (process-exit bo release + SwiftShader risks from §7.1 closed?) If not, Tier 1 proceeds on the CPU compositing path (it doesn't strictly need PR10) but PR12/13 block. | GO to Tier 1 |
| **B** | after **O1** (PR18) | Is the lookalike enough, or invest in the GTK/glib tier? Tier 2 is ~6 ports incl. the two hardest (libffi-closures, GTK3). Stopping here still leaves a complete themed tiling desktop. | user decides |
| **B′** | after PR21 (glib) | glib actually works (mainloop/gobject/gspawn green)? If ffi_closure or gspawn proves unsound, stop Tier 2 at foot+PR19 value. | continue if green |
| **C** | after **O2** (PR24) | Enter the driver tier? Decided **on the PR25 spike report**, not on estimates. This is the multi-quarter commitment line. | spike first, then user decides |
| **D** | after **O4** (sway) | Literal Hyprland (C++26/aquamarine, O5) or declare sway-class the destination and adapt Omarchy's configs to it? | user decides |

## §8. What "Omarchy possible" concretely means — the gate ladder

- **O1** — imitation: `/?demo=omarchy` tiling + bar + launcher + real
  Omarchy themes, Playwright-gated (PR18 §3).
- **O2** — app compat: unmodified foot + Waybar (Omarchy's actual
  waybar config) + mako running on `wlcompositor` (PR24 §4).
- **O3** — compositor stack: unmodified tinywl on wlroots on
  atomic-KMS/GBM/EGL/libseat (PR29 §5).
- **O4** — Hyprland-class: sway + Waybar + mako with Omarchy-derived
  config (PR30 §5).
- **O5** — Omarchy literal: Hyprland + the Omarchy script/theme layer
  over the kandelo package system (PR31+ §5).

Each rung is independently demoable and independently a stopping
point. "Porting Omarchy is possible" is *proven* at O3 and *done in
spirit* at O4; O1 is the product milestone that makes the demo look
like Omarchy this quarter rather than next year.

## §9. Verification (per CLAUDE.md, every PR)

- `cargo test -p kandelo --target aarch64-apple-darwin --lib` (0 fail)
- `cd host && npx vitest run` (baseline 3 pre-existing failures only)
- `scripts/run-libc-tests.sh` exit 0; `scripts/run-posix-tests.sh` 0 FAIL
- `bash scripts/check-abi-version.sh` — Tier 1/2 expected additive;
  PR26 atomic-KMS ioctls reviewed explicitly
- Browser demo verification by hand for every demo-affecting PR
  (`./run.sh browser`, or the vite workaround while abi-v17 binaries
  are unpublished — see the session-8 handoff)
- Builds inside `scripts/dev-shell.sh`; new host tools go in
  `flake.nix`, never via PATH leakage

---

*Commits remain gated on user approval. This document is the plan
deliverable; no implementation has been started.*
