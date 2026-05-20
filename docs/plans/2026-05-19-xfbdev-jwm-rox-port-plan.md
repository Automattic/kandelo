# Xfbdev + JWM + ROX-Filer Port Plan

Date: 2026-05-19

## Goal

Build a real upstream-style Unix graphical stack in Kandelo while preserving
Kandelo's POSIX-first device policy.

The first target path is now running:

1. `Xfbdev` or another TinyX/KDrive-style X server opens `/dev/fb0`, a VT, and
   input devices.
2. `JWM` runs as the window manager on `DISPLAY=:0`.
3. A lightweight file manager exposes the Kandelo VFS through normal POSIX
   paths.

`kdesktop` remains useful as a direct-framebuffer fallback because it is a
small, deterministic probe of the same fbdev/evdev/VFS contract. ROX-Filer
remains a possible next file manager, but the current milestone uses a small
Xlib `xvfs-browser` to avoid pulling GTK2/GLib into the first working desktop
path.

## Why This Stack

`Xfbdev` is the right first upstream component because it exercises the
standard devices Kandelo now exposes without requiring DRM/KMS, GBM, Mesa, or a
GPU driver. It is also a better architectural stepping stone than adding a
Kandelo-specific browser display protocol.

`JWM` is small and mature. It depends on Xlib and common X extensions rather
than a full desktop shell. It does not provide a file explorer, so it needs a
separate file manager.

`ROX-Filer` is a plausible first file manager because it is lightweight and
maps well to a path-based VFS. It is heavier than JWM because it brings GTK,
GLib, font, and image dependencies. If that dependency chain is too expensive,
use a smaller Xlib file manager first, then return to ROX-Filer.

## Existing Kandelo Support

The current repo already has the pieces an Xfbdev-style server is likely to
probe first:

- POSIX files, directories, stat, symlinks, pipes, processes, fork/exec, wait,
  signals, mmap, and shared mappings.
- PTYs and controlling-terminal-style APIs for ordinary text programs.
- AF_UNIX stream sockets, bind/listen/connect/accept, and socketpair.
- `poll`, `select`, `ppoll`, eventfd, timerfd, and epoll-style APIs.
- `/dev/fb0` with fbdev GET/PUT screeninfo, mmap/write presentation, blanking,
  pan display acknowledgement, and wait-for-vsync acknowledgement.
- `/dev/input/event0`, `/dev/input/event1`, and `/dev/input/mice`.
- `/dev/tty0` and `/dev/tty1` with a minimal KD/VT ioctl subset.

## Expected Gaps

The first port attempt should expect failures in configure probes and early
runtime startup. Likely areas:

- More Linux headers in `musl-overlay/include/linux`.
- Additional X server ioctls on ttys, input devices, or framebuffer structs.
- `fcntl`, `mmap`, `shm`, or `poll` edge cases used by X libraries.
- Font path and runtime data layout under `/usr/share`.
- AF_UNIX socket pathname behavior for `/tmp/.X11-unix/X0`.
- Threading or TLS assumptions in GLib/GTK if ROX-Filer comes early.
- Dynamic module loading assumptions if using a newer Xorg server instead of a
  smaller static TinyX/KDrive source base.

These gaps should be handled by implementing standard POSIX/Linux behavior,
not by adding Xfbdev-, JWM-, or ROX-specific kernel branches.

## Port Order

1. Keep `fbseat-probe` green and running before the desktop gallery entry.
   Done for the current gallery entry.
2. Add a repo-local build skeleton for `tinyx-xfbdev` that can fetch/unpack an
   upstream TinyX/KDrive source archive or git revision.
   Done as `scripts/ports/attempt-xfbdev.sh`.
3. Drive the first build until configure or compile fails, then record the
   first missing syscall/header/library precisely.
   Done across the package and patch sequence below.
4. Port only the minimum dependencies needed for a static `Xfbdev` binary.
   Done for the current Xfbdev path.
5. Add `xserver-preflight` or extend `fbseat-probe` for any new generic device
   behavior Xfbdev needs.
   Done as `fbseat-probe`.
6. Start `Xfbdev :0 -screen 640x480x32` from a Kandelo gallery profile.
   Done in `desktop-jwm`.
7. Add a tiny X client smoke test before adding a window manager.
   Done with `xvfs-browser`, then expanded with `xclock` and `xeyes`.
8. Port JWM and run it as the first real window manager.
   Done.
9. Port a small file manager. Done as the Xlib bridge `xvfs-browser`.
   ROX-Filer remains deferred until the GTK dependency chain is worth taking.
10. Replace `kdesktop` in the gallery once Xfbdev + WM + file manager can
    browse `/`, `/home`, and `/usr/bin` through the Kandelo VFS.
    Done for the primary path; `kdesktop` remains fallback-only.

## Attempt 1: Xfbdev Configure Harness

Added `scripts/ports/attempt-xfbdev.sh` as a repo-local port harness. It is not
part of the package matrix yet; it fetches and verifies
`xorg-server-1.19.7.tar.gz`, then configures the KDrive/Xfbdev candidate with
`wasm32posix-cc`.

Result from the first run:

- The source fetch and sha256 verification succeeded.
- `--host=wasm32-unknown-unknown` failed because this older `config.sub` does
  not recognize that triplet.
- Switching the harness to the repo's existing `wasm32-unknown-none` configure
  triplet got past compiler detection and most platform probes.
- The harness uses `wasm32posix-pkg-config` so host libraries are filtered out.
- The first real wasm-target blocker is now `pixman-1 >= 0.27.2`.

## Attempt 2: Pixman Package

Added `examples/libs/pixman/` as a normal wasm32 dependency package using
upstream `pixman-0.42.2.tar.gz` from X.Org. The build is static-only and
disables optional CPU-specific acceleration, OpenMP, GTK, and libpng support.

Result:

- `cargo xtask build-deps resolve pixman` succeeds and installs
  `lib/libpixman-1.a`, `include/pixman-1`, and
  `lib/pkgconfig/pixman-1.pc` into the shared dependency cache.
- `scripts/ports/attempt-xfbdev.sh` now resolves the `pixman` package and
  prepends its pkg-config path before running Xfbdev configure.
- Xfbdev configure now reports `checking for PIXMAN... yes`; the previous
  `pixman-1 >= 0.27.2` blocker is cleared.
- The next blocker is the X server dependency set behind `XSERVERCFLAGS`:
  `fixesproto`, `damageproto`, `xcmiscproto`, `xtrans`, `bigreqsproto`,
  `xproto`, `randrproto`, `renderproto`, `xextproto`, `inputproto`,
  `kbproto`, `fontsproto`, `videoproto`, `compositeproto`, `recordproto`,
  `scrnsaverproto`, `resourceproto`, `xkbfile`, `xfont2`, and `xau`.

The next concrete port step is to add the X protocol/header packages and the
small X support libraries (`xtrans`, `libXau`, `libxkbfile`, `libXfont2`) one
package layer at a time, then rerun:

```sh
scripts/ports/attempt-xfbdev.sh
```

The detailed configure log is written under `.build-cache/ports/`, which is a
local build cache and should not be committed.

## Attempt 3: Real Xfbdev Client Path

The desktop gallery entry now starts the real Xfbdev wasm port and a small
libX11 file browser client, `xvfs-browser`, on `DISPLAY=:0`.

Result:

- `fbseat-probe` validates `/dev/fb0`, `/dev/input/event0`,
  `/dev/input/event1`, `/dev/input/mice`, `/dev/tty0`, and the VT/KD ioctl
  subset before the desktop starts.
- Xfbdev uses `/dev/fb0` for rendering and the evdev devices for pointer and
  keyboard input.
- `xvfs-browser` lists Kandelo VFS directories through POSIX
  `opendir`/`readdir`/`stat` and receives ordinary X pointer events.
- Browser-host pointer mapping is now exposed as a reusable framebuffer handle
  operation, so absolute canvas positions are translated once at the seat
  boundary instead of being reimplemented by each pane.

## Attempt 4: JWM

Added `scripts/ports/attempt-jwm.sh` for JWM 2.4.6. The port builds a static
libX11 JWM binary with optional image/font/X extension integrations disabled
for the first lightweight desktop milestone.

Result:

- `local-binaries/programs/wasm32/jwm.wasm` builds reproducibly.
- The script applies a small upstream-source patch so the generated Makefile
  does not depend on an in-source wildcard header rule.
- The final link uses the full static X11 dependency closure
  (`libX11`, `libxcb`, `libXau`), avoiding unresolved `env.xcb_*` imports.
- The desktop profile seeds `/home/.jwmrc`, starts JWM after Xfbdev, then
  starts `xvfs-browser` as the VFS file browser in the JWM session.
- The focused Playwright regression verifies framebuffer paint, JWM tray
  pixels, X client input, `fbseat-probe`, and absence of Xfbdev/JWM startup
  failure.

ROX-Filer remains deferred. It is still a reasonable candidate, but the GTK2
and GLib dependency chain is larger than the current Xfbdev/JWM milestone. The
current bridge is the small Xlib `xvfs-browser` file browser.

## Attempt 5: Multi-Client Desktop Stability

The desktop gallery entry now starts Xfbdev, JWM, and three X clients:
`xvfs-browser`, `xclock`, and `xeyes`.

Result:

- The X server remains alive after startup and accepts multiple libX11 clients
  through AF_UNIX sockets.
- The JWM window menu close and kill commands work without taking down Xfbdev.
  The main fix was matching the wasm `epoll_event` layout at 16 bytes with the
  data field at offset 8, then removing stale epoll interest mirrors when file
  descriptors close.
- Browser pointer input is mapped from the host cursor's absolute canvas
  position to framebuffer pixels, then injected as the relative movement needed
  to keep the guest-drawn cursor under the host cursor. The native browser
  cursor is hidden while the framebuffer is active.
- Xfbdev's button-only events preserve the current pointer position, so clicks
  do not jump away from the visible cursor.
- JWM menu selection updates on button press as well as pointer motion, so menu
  commands work reliably even when the browser delivers an accurate click
  without a fresh motion event first.
- `xvfs-browser`, `xclock`, and `xeyes` render through off-screen X pixmaps and
  copy complete frames to their visible windows. This removes the client-side
  partial-frame flicker seen while dragging windows or moving the mouse over
  `xeyes`.
- The browser canvas renderer snapshots the guest framebuffer before swizzling
  to RGBA, so a browser frame is not built from multiple concurrent guest draw
  states.

Verification at this point:

```sh
./scripts/ports/build-x11-demos.sh
./scripts/ports/build-xvfs-browser.sh
npm --prefix host run build
npm --prefix examples/browser run build
cd examples/browser
PLAYWRIGHT_PORT=5333 ./node_modules/.bin/playwright test test/kandelo-desktop.spec.ts --project=chromium --workers=1
```

The latest drag sampler run checked 42 frames while moving `xclock` and 42
frames while moving `xvfs-browser`; both reported 0 bad frames. That sampler is
still ad hoc and should become a real regression test.

## Acceptance Tests

The browser regression should evolve in this order:

- `fbseat-probe` passes.
- `Xfbdev` binds `/dev/fb0`, creates `/tmp/.X11-unix/X0`, and stays alive.
- A small X client connects to `DISPLAY=:0`.
- Pointer and keyboard events reach the X server through evdev or mousedev.
- JWM starts and owns the root window.
- The file manager can list VFS directories and open a file metadata view.
- The framebuffer pane remains nonblank, hides the native cursor when bound,
  and keeps the guest cursor synced with the host cursor.
- Dragging `xclock`, `xeyes`, and `xvfs-browser` windows does not expose blank
  or partially rendered client frames.
- JWM close, minimize, and kill commands continue to work without crashing
  Xfbdev.

## Resume Checklist

For a fresh agent session, start here:

1. Read `docs/kandelo-desktop-demo.md` and this plan.
2. Build the local wasm artifacts with the scripts in the demo doc.
3. Start `examples/browser` on a free port and open
   `/pages/kandelo/?demo=desktop-jwm`.
4. Run the focused Playwright desktop spec.
5. If continuing the desktop path, turn the drag/flicker sampler into a checked
   Playwright test.
6. Then choose the next real X client: a small terminal (`xterm`, `rxvt`, or
   similar) to exercise PTY/text input, or a richer file manager such as
   ROX-Filer if taking on GTK2/GLib dependencies is acceptable.
7. Keep all new guest-visible behavior behind POSIX or standard Linux device
   interfaces, and extend `fbseat-probe` for any new seat contract.

## Non-Goals

Do not add DRM/KMS, DRI, WebGL, or WebGPU as guest-visible APIs for this port
unless fbdev/evdev/VT cannot carry a real upstream X server. The browser host
may change its internal renderer later, but guest programs should continue to
see standard Unix device files.
