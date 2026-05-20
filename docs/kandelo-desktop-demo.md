# Kandelo Desktop Demo

This demo is the current real browser desktop path for Kandelo. It is not a
React mock: a wasm32 Xfbdev process owns `/dev/fb0`, a wasm32 JWM process
manages the root window, and multiple wasm32 libX11 clients connect to
`DISPLAY=:0`. The VFS browser uses POSIX directory calls; `xclock` and `xeyes`
exercise additional independent X client windows.

## Current State

This branch proves a lightweight desktop stack can run in Kandelo using
standard Unix/Linux compatibility surfaces instead of a Kandelo-specific guest
graphics protocol:

- `fbseat-probe` validates the guest-visible graphical seat before the demo
  starts.
- `Xfbdev` opens `/dev/fb0`, `/dev/input/event0`,
  `/dev/input/event1`, `/dev/input/mice`, and `/dev/tty0`.
- `JWM` runs as the real X window manager.
- `xvfs-browser` renders a path-based file browser backed by POSIX
  `opendir`, `readdir`, and `stat`.
- `xclock` and `xeyes` prove multiple independent X clients can connect to the
  same server and be managed by JWM.
- `kdesktop` remains as a direct-framebuffer fallback if Xfbdev exits during
  startup.

The kernel does not contain demo-specific desktop or game branches. The added
guest ABI is the reusable graphical-seat surface: fbdev, evdev, mousedev,
minimal VT/KD, AF_UNIX sockets, and the POSIX process/file behavior needed by
the X stack.

## What Landed

The desktop path required changes across four layers.

Kernel and ABI:

- Added Linux-style `/dev/input/event0` pointer evdev and
  `/dev/input/event1` keyboard evdev streams, while keeping text input on
  POSIX terminal paths.
- Kept `/dev/input/mice` as a Linux mousedev fallback and split large pointer
  movement into multiple PS/2 packets so first-frame cursor sync is not
  truncated.
- Added `/dev/tty0` and `/dev/tty1` aliases with the minimal VT/KD ioctl
  acknowledgements that Xfbdev and SDL-style framebuffer stacks commonly
  probe.
- Extended `/dev/fb0` compatibility for Xfbdev-style clients, including mode
  get/set, mmap/write presentation, framebuffer capacity reporting, blanking,
  pan display acknowledgement, and wait-for-vsync acknowledgement.
- Fixed the host/kernel epoll event layout to match wasm libc expectations and
  cleaned stale epoll interest records on close. This removed the Xfbdev crash
  path seen when JWM window commands killed an X client.
- Kept demo names out of the kernel and Linux header overlay; demo-specific
  behavior lives in programs, port scripts, browser gallery setup, and docs.

Browser host and UI:

- Added framebuffer handle operations so browser panes can map CSS-scaled
  pointer coordinates to framebuffer pixels once at the graphical-seat
  boundary.
- Made the framebuffer pane hide the native cursor while a guest framebuffer is
  bound, then inject relative movement required to keep the guest-drawn cursor
  under the host cursor position.
- Added keyboard, pointer, button, and wheel injection paths for the graphical
  seat.
- Changed canvas presentation to snapshot the shared wasm framebuffer into a
  non-shared scratch buffer before BGRA-to-RGBA swizzling. Browser frames are
  now built from one stable guest framebuffer state.

Ports and packages:

- Added wasm package recipes for the X dependency stack: `pixman`,
  `xorgproto`, `xtrans`, `libXau`, `xcb-proto`, `pthread-stubs`, `libxcb`,
  `libX11`, `libfontenc`, `libxkbfile`, and `libXfont2`.
- Added `scripts/ports/attempt-xfbdev.sh` and source patches for the Xfbdev
  wasm port, including built-in XKB fallback and KDrive input fixes.
- Added `scripts/ports/attempt-jwm.sh` and source patches for JWM 2.4.6,
  including a menu-selection compatibility fix for browser click delivery.
- Added build scripts for the local Xlib clients:
  `scripts/ports/build-xvfs-browser.sh` and
  `scripts/ports/build-x11-demos.sh`.

Demo programs:

- Added `programs/fbseat-probe.c` to exercise the graphical-seat device
  contract.
- Added `programs/kdesktop.c` as a direct-framebuffer fallback and deterministic
  smoke test.
- Added `programs/xvfs-browser.c` as the first real X file-browser element.
- Added `programs/xclock.c` and `programs/xeyes.c` as additional independent
  libX11 clients.
- Updated `xvfs-browser`, `xclock`, and `xeyes` to render each frame into an
  off-screen X pixmap, then copy the complete frame to the visible window with
  one `XCopyArea`. This avoids client-side partial-frame flicker while windows
  move or redraw.

## Build Artifacts

From the repo root:

```sh
cargo build --release -p wasm-posix-kernel -Z build-std=core,alloc
mkdir -p local-binaries
cp target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm local-binaries/kernel.wasm
scripts/build-rootfs.sh
scripts/build-programs.sh
scripts/ports/attempt-xfbdev.sh
scripts/ports/attempt-jwm.sh
scripts/ports/build-xvfs-browser.sh
scripts/ports/build-x11-demos.sh
```

Required local files:

- `local-binaries/kernel.wasm`
- `host/wasm/rootfs.vfs`
- `local-binaries/programs/wasm32/fbseat-probe.wasm`
- `local-binaries/programs/wasm32/Xfbdev.wasm`
- `local-binaries/programs/wasm32/jwm.wasm`
- `local-binaries/programs/wasm32/xvfs-browser.wasm`
- `local-binaries/programs/wasm32/xclock.wasm`
- `local-binaries/programs/wasm32/xeyes.wasm`
- `local-binaries/programs/wasm32/kdesktop.wasm`

## Run

```sh
cd examples/browser
npm run dev -- --host 127.0.0.1 --port 5333 --strictPort
```

Open:

```text
http://127.0.0.1:5333/pages/kandelo/?demo=desktop-jwm
```

Expected boot path:

1. Kandelo loads the `desktop-jwm` profile.
2. `fbseat-probe` validates `/dev/fb0`, `/dev/input/event0`,
   `/dev/input/event1`, `/dev/input/mice`, `/dev/tty0`, and VT/KD ioctls.
3. `Xfbdev :0` starts, binds `/dev/fb0`, and exposes an X11 display.
   The wasm port uses a built-in XKB fallback so startup does not fork an
   external `xkbcomp` helper before clients can connect.
4. `jwm` connects to Xfbdev, reads `/home/.jwmrc`, and starts managing the
   X root window.
5. `xvfs-browser`, `xclock`, and `xeyes` connect with libX11 and render inside
   the JWM session.
6. If Xfbdev exits during startup, `kdesktop` starts as the direct-fb fallback.

The clients may paint before the desktop startup window has fully settled. For
destructive window-manager actions such as JWM Kill, wait until the profile logs
`ready` or until Xfbdev has survived the startup window.

## Controls

The current X milestone includes real input: browser pointer and keyboard
events enter Kandelo through the graphical seat, Xfbdev consumes
`/dev/input/event0` and `/dev/input/event1`, and X clients receive ordinary X
events. Direct-fb fallback controls still work when `kdesktop` is used. Xfbdev
runs with `-dumbSched` in the demo to keep scheduling and input
single-threaded in the browser host.

The JWM port carries a small menu-input compatibility patch: menu item
selection is updated on button press as well as motion. That keeps window menu
commands such as minimize, close, and kill working when a browser click arrives
with accurate coordinates but without a preceding X `MotionNotify`.

`xclock` and `xeyes` are small libX11 clients rather than upstream Xt/Xaw
ports. That keeps this milestone focused on proving multiple JWM-managed X
clients over the current ABI before adding the larger classic X toolkit stack.
`xvfs-browser` remains the current file-manager element because it has POSIX
VFS access. ROX-Filer is a plausible next file manager, but it pulls in the
GTK2/GLib stack; that is broader than the current lightweight Xfbdev/JWM
milestone.

## Rendering Notes

There are two buffering boundaries:

- X clients draw into off-screen pixmaps and copy complete frames to their X
  windows.
- The browser host snapshots the guest framebuffer before converting it to
  canvas `ImageData`.

This does not make Xfbdev a compositing server, and it does not add DRM/KMS or
GPU acceleration. It is enough for the current JWM/Xlib milestone and keeps the
guest-visible ABI small. Future WebGL or WebGPU work should be treated as a
host presentation optimization unless Kandelo intentionally adds a standard
guest ABI such as DRM/KMS.

## Test

Run the focused browser regression:

```sh
cd examples/browser
PLAYWRIGHT_PORT=5333 ./node_modules/.bin/playwright test test/kandelo-desktop.spec.ts --project=chromium
```

Use a free `PLAYWRIGHT_PORT` in multi-worktree development. The Playwright
config passes `--strictPort` to Vite so tests fail rather than silently hitting
a server from another worktree.

Useful focused kernel checks:

```sh
cargo test -p wasm-posix-kernel fb_display_control --lib --target aarch64-apple-darwin
cargo test -p wasm-posix-kernel event0 --lib --target aarch64-apple-darwin
cargo test -p wasm-posix-kernel event1 --lib --target aarch64-apple-darwin
cargo test -p wasm-posix-kernel linux_vt --lib --target aarch64-apple-darwin
cargo test -p wasm-posix-kernel mouse --lib --target aarch64-apple-darwin
```

The last verified state for this branch also included:

```sh
npm --prefix host run build
npm --prefix examples/browser run build
PLAYWRIGHT_PORT=5333 ./node_modules/.bin/playwright test test/kandelo-desktop.spec.ts --project=chromium --workers=1
```

Manual smoke checks used Playwright pixel sampling while dragging `xclock`,
`xeyes`, and `xvfs-browser` windows. The latest run sampled 42 frames for both
`xclock` and `xvfs-browser` drags and found 0 bad frames.

## Scope

The demo intentionally uses broad device contracts only:

- POSIX file and directory APIs for VFS access.
- Linux fbdev for the display.
- Linux evdev for pointer, wheel, and keyboard input.
- Linux mousedev as a fallback pointer stream.
- Minimal VT/KD ioctls for framebuffer stack compatibility.
- AF_UNIX sockets for local X11 client/server communication.

There should be no desktop-demo-specific kernel code. Demo behavior belongs in
`programs/xvfs-browser.c`, `programs/kdesktop.c`, `programs/fbseat-probe.c`,
the JWM/Xfbdev port scripts and patches, and the browser host.

## Next Work

The next work should keep the same POSIX-first, standard-device boundary:

1. Promote the Xfbdev and JWM port scripts into the normal dependency/package
   matrix once the source patches settle.
2. Add automated drag/flicker regression coverage for JWM-managed windows,
   based on the ad hoc Playwright pixel sampler used during this branch.
3. Port a richer real X application. Good next candidates are `xterm` or a
   lightweight file manager. ROX-Filer remains attractive for a real desktop
   VFS view, but it likely requires GLib, GTK2, Pango/fontconfig/freetype, and
   image-loader work.
4. Add an X client that exercises text input through the existing PTY/terminal
   stack, then decide whether `xterm`, `rxvt`, or another small terminal is the
   right first target.
5. Make the framebuffer presentation path more efficient without changing the
   guest ABI: dirty-rect tracking, frame pacing, and WebGL/WebGPU texture upload
   are all host-side options.
6. Continue extending `fbseat-probe` whenever a new graphical-seat behavior
   becomes part of the contract.
7. Keep auditing kernel changes with the demo-specific grep in
   `docs/plans/2026-05-18-graphics-seat-device-policy.md`.
