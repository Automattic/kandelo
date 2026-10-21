# Freeciv

The Freeciv package builds the upstream 3.2.6 SDL2 client and dedicated
server. The shell image carries them, their rulesets, Lua scripts,
tilesets, theme, fonts, and ICU data in the lazy `freeciv.zip` archive.
Opening another machine does not download that archive until Freeciv is
used.

## Build and run

```sh
./run.sh browser
```

Choose **Freeciv** in the computer gallery. Its initial command is
`freeciv-play`, which opens Freeciv's ordinary main menu. **Start New Game**
uses the client's upstream local-server launch path.

The package recipes are `freeciv`, `sdl2-image`, `sdl2-ttf`, `sdl2-mixer`, and
`freeciv-browser-bundle`. They are included in the local supported set.
Freeciv is built through upstream Meson, using the SDK cross file and
resolver-owned dependencies. Its native tolua generator is built from
the Lua and tolua sources in the same verified upstream archive.

The first port selects the SDL2 client and server, with GNU readline
for the server console. Audio uses the upstream SDL2_mixer backend through
Kandelo's existing OSS `/dev/dsp` device. Translations, the modpack installer,
extra clients, and editing tools are disabled through upstream options.
The resulting server links GPLv3 readline and is a GPLv3 aggregate.

## Measured build cost

One SourceOnly build on 2026-10-19 used an Apple M5 Max (18 CPUs, 48 GiB
RAM), the declared Nix toolchain, and LLVM 21.1.7. Freeciv's Ninja build
used eight jobs while up to sixteen package nodes ran concurrently.
Dependencies and downloaded sources were already available when its node
started. The build system's per-node timings include compilation, fork
instrumentation, artifact validation, and publication.

| Source build stage | Wall time |
|---|---:|
| Freeciv 3.2.6 revision 21, client and server | 490.6 s (8m 11s) |
| Browser archive bundle | 68.5 s (1m 9s) |
| Sequential Freeciv and bundle nodes | 559.1 s (9m 19s) |

This is a single measurement under competing build load, excluding the
cost of building dependencies and fetching uncached sources. It is not a
measured increase in the entire build's elapsed time: independent work can
run in parallel with Freeciv.

Separate cached `xtask build-deps --source-only --arch=wasm32 resolve`
invocations took 24.4 seconds for Freeciv and 29.4 seconds for the complete
browser bundle. These checks reused the exact published entries without
running either recipe. The bundle lookup includes checking Freeciv and its
dependencies, so these cached times must not be added together. An aggregate
build can skip current nodes before launching these individual checks.

The source-cache timing history records the build under Freeciv cache key
`4a477f20bda301964adc0d4a24be37f7f3a31bf6654a6d8e3f17ab7fe8871ddc`
and bundle key
`1821b4224c6d1cb514c02411423454a67d610abe11de1b5a4ed6149f77e4539f`.

## Display backends

The SDL package includes both Wayland and direct KMSDRM backends. The
Freeciv wrapper leaves backend selection to SDL when a compositor socket
exists; otherwise it selects KMSDRM and the absolute evdev pointer. The
gallery currently uses that direct-display path.

Wayland can centralize window focus, keyboard mapping, pointer routing,
cursor ownership, and output scale behind the same protocols used by other
desktop applications. Freeciv has not yet been acceptance-tested through
that path. In particular, Kandelo's current `wlcompositor` ignores client
cursor surfaces and relies on the browser pointer. Client cursors need a
shared compositor implementation before this can preserve Freeciv's
contextual cursors. Switching backends alone does not establish correct
bitmap UI scaling or fix Freeciv widget defects.

## Audio

The port enables Freeciv's standard sound effects and menu music, using the
shared `sdl2-mixer` package and the shipped `stdsounds`/`stdmusic` Ogg files.
There is no Freeciv-specific browser audio path. SDL opens `/dev/dsp`; the
machine's normal PCM transport and AudioWorklet play the result.

The launcher seeds Freeciv's normal **Sound volume** setting at 25% on
first launch, affecting menu music and sound effects. Change it under
**Options → Local options → Sound** and save local options to keep your
choice. Existing settings, legacy settings awaiting migration, and explicit
`FREECIV_OPT` files are preserved.

Click the graphics pane, or the audio status toast's **Enable** button, to
satisfy browser audio activation. The standard music set contains menu music
only; silence between in-game sound effects is expected. Additional in-game
music sets are not bundled.

## Multiplayer

1. Open the **Network** panel and create a network session.
2. In the Freeciv machine's **Multiplayer** menu, choose **Host a game**.
3. Share the network session's invitation link with the other players.
4. Each player opens the link, clicks **Join session**, then chooses
   **Multiplayer → Join session host**.
5. Configure and start the game through Freeciv once the players have
   joined. The first connected player has control of the server settings.

Hosting starts a real `freeciv-server` process listening on IPv4 TCP port
5556 and connects the host's client to `127.0.0.1`. Joining connects to
the session's `host` DNS name (`10.89.0.1`). Each launcher chooses a
screen name from guest entropy to avoid collisions between machines
that all use the `maker` account. Set `FREECIV_PLAYER` when invoking
`freeciv-play` from a terminal to choose a name explicitly.

```sh
FREECIV_PLAYER=Alice freeciv-play host
FREECIV_PLAYER=Bob freeciv-play join
```

The launcher owns its client and server children, forwards termination,
and waits for them when the game is closed or restarted. The standard
client and server wrappers are also available as `freeciv`,
`freeciv-sdl2`, and `freeciv-server`.

Freeciv's LAN discovery uses IPv4 multicast. Kandelo's current multicast
delivery does not reach other peer machines, so the wrappers select the
upstream `--Announce none` option and use direct TCP connections.
Browser clients connect to servers on Kandelo peer machines; public native
Freeciv servers require outbound raw TCP, which the browser host does not
provide.
The existing network-session STUN/TURN and browser limitations still
apply; see [browser networking](browser-support.md#purpose-checked-browser-peer-connections).

## Playing with the SDL2 controls

Click the game canvas to give it keyboard focus. The minimap toolbar's
upper-right gear is **Turn Done** (hover for its tooltip); **Shift+Enter**
performs the same action. **W** puts the selected unit on the wait list and
selects the next available unit. **Space** marks it done for this turn and
advances focus. **G**, followed by a click on the map, orders the selected unit
to that tile. Arrow keys move one step; the numeric keypad supports eight
movement directions. Without a keypad, Home/Page Up/End/Page Down provide
the diagonals. Keypad 5 recalls the previous focused unit. The **C** key
centers the map on the current unit.

To pan the map, right-click the desired place on the minimap, or give the main map a short right-click. **C** centers the selected
unit. The SDL client also edge-scrolls when the pointer reaches the map edge;
the mouse wheel is not its map-panning control. Holding right-click for at
least half a second opens a terrain/unit context menu instead of recentering.
**Escape** closes that menu.

Clicking the game captures the pointer inside the display. A brief
**Press Esc to release** hint appears. Move to an edge to scroll, then move
back into the map to stop. **Escape** releases the pointer. Switching panes,
leaving the browser window, or hiding the tab also releases it. Touch taps
never capture the pointer.

This is the shared KMS display behavior; there are no pointer-capture dock
controls, image settings, or Freeciv changes. The initial click reaches the
guest before capture begins.

**G** begins a pending destination; moving the pointer previews a route and
left-click commits it. Right-click panning does not cancel the pending order.
**Escape** now cancels the map command before the global Options shortcut;
modal dialogs retain their own Escape bindings. If waypoints were added,
Escape removes the last one before leaving Go To. To clear already assigned
orders, select the unit and press **Space** (which also marks it done for the
turn). Other SDL shortcuts remain the upstream bindings, not Freeciv-web's.

The nation picker counts visible rows within the selected nation set rather
than treating global nation IDs as row positions. Random defaults and
replacement selections also come from the actual available nations; taken
nations stay disabled, and availability updates tolerate nations omitted from
the dialog. This prevents a blank initial Core list and invalid random choices
in filtered sets.

## Saves and runtime files

The multiplayer host saves under `$HOME/.freeciv/saves`. Single-player
uses Freeciv's own save management. Saves belong to the running machine's
filesystem; download the save files to retain them beyond that
machine's lifetime.

The wrappers set `FREECIV_DATA_PATH=/usr/share/freeciv` and
`ICU_DATA=/usr/share/icu`. The bundle installs the resolver's ICU data
under its upstream name, `icudt74l.dat`, so Freeciv's Unicode operations
use the actual data rather than a stub library alone.

The Node host can run the dedicated server and the clients' CLI options.
Graphical presentation uses the browser's GLES2 bridge, like the other
SDL2 programs; Node supplies no GL context. The bare-display launcher
selects Freeciv's fullscreen option so its drawing and pointer coordinates
match the display mode. Inside Wayland it uses a normal window. An
explicit `--` GUI argument block overrides the fullscreen default.

## Display and input ownership

The image declares Kandelo's generic `presentation.displayScale: 1.5`.
This selects a readable virtual monitor from the pane's CSS size,
independently of browser density. At a 1440×810 CSS display, Freeciv sees
960×540 pixels at both 1× and 2× density. Its unmodified fonts, bitmap art,
map tiles, widget dimensions, mouse state, and hit targets all use that
single grid. The browser presents the complete scene at 150% CSS scale,
compensating for the display's physical pixel density.

There is no Freeciv DPI conversion, renderer logical-size transform, font
point conversion, or compensating font/layout patch. Upstream's theme size
10 remains size 10 in the guest, displayed at about 15 CSS pixels here.
This is bitmap scaling, not independent native-density glyph rasterization.
The shared connector minimum is 640×480, so smaller panes fit that mode.
DPI-aware compositor profiles omit `displayScale` and retain native output.

There is no host-side scaling menu. A preferred monitor resolution does
not resize a running SDL application, and Freeciv can reuse its saved mode
on relaunch. Presenting that preference as adjustable UI scaling was
misleading. The whole scene and cursor fit the pane up or down without
clipping or scrollbars. Use the game's resolution option to change the UI
size; the 150% image preference remains the first-launch default.

The normal game menu exposes resolutions under **Options → Local options →
Interface → Screen resolution**. Kandelo's virtual monitor advertises 17
standard modes from 640×480 to 3840×2160, plus the pane-derived preferred
mode when its size is not already in that list. Smaller resolutions make
the whole bitmap UI larger; larger resolutions show more map and smaller
controls. The browser fits the selected aspect ratio with letterboxing.
Selecting a mode overrides the preferred mode; the default presentation
uses 1.5 CSS pixels per guest pixel independently of display density.

Freeciv's SDL2 resolution callback originally only rearranged widgets.
The client correction calls SDL's window/display mode APIs, recreates its
surfaces after closing the settings panel, then reflows the UI. Fullscreen
uses the chosen display mode instead of SDL's desktop-fullscreen mode,
which deliberately ignores resolution requests. First launch selects the
monitor's preferred mode; saved choices apply on subsequent launches.
This application correction contains no Kandelo-specific dimensions.
Kandelo keeps the absolute pointer's 0–65535 device range fixed across mode
changes, rather than changing the range already cached by SDL/libinput.
The SDK forwards GBM native-window dimensions through the ordinary EGL
surface API. The GL bridge retains that resized drawable independently of the
old scanout, and retires destroyed contexts' objects and cached state
before recreating them on the shared native WebGL context.
SDL's KMS backend prepares pending drawable changes when the renderer
queries its output size, with the window's context current. Deferring
recreation until swap can discard part of an already submitted frame.

Kandelo supplies a virtual KMS cursor plane through Linux's `MODE_CURSOR`
and `MODE_CURSOR2` ioctls. It retains cursor images, positions, hotspots,
and visibility separately from the application framebuffer. The browser
worker presents changes on a transparent cursor surface at vblank without
uploading or repainting the scene. The same device state works on Node,
which supplies no visible canvas by default.

Freeciv uses SDL's standard color-cursor API for its animated color sprites
and retains its monochrome option. Its custom scene/cursor compositor and
invented default-arrow drawing have been removed. SDL supplies the normal
arrow. This is an application use of a platform cursor facility; the KMS
implementation also serves other SDL and libdrm applications.

The cursor transport uses optional kernel exports, with no new required
host import under ABI 50. The host negotiates protocol 1 through
`kernel_kms_cursor_configure` and reads coalesced complete state through
`kernel_kms_cursor_read` before presenting a frame. Hosts that do not
negotiate support see zero cursor dimensions and can still instantiate the
kernel. Requests reaching the kernel fail with `ENOTSUP`; older host
adapters may reject an unknown ioctl earlier with `EINVAL`. Clients should
query the capability before using the plane. This is an explicit
unsupported-device boundary, not an automatic SDL software-cursor fallback.
Both exports are scheduled to become required at ABI 51. This establishes
the next host baseline without requiring a cursor-specific ABI bump.

SDL's shared evdev backend supplies printable US ASCII `SDL_TEXTINPUT` when
no console keymap is available, including Shift, Caps Lock, repeats, and
Num Lock keypad digits. Control/Alt/GUI shortcuts do not insert text.
Non-US layouts, compose sequences, and IME input remain unsupported by this
fallback. Wayland uses its existing keymap path. Keyboard and pointer read
batches are merged by monotonic timestamps, preserving click/key order.

The browser input adapters retain gesture ownership, read complete button
snapshots, and release held keys/buttons on cancellation, lost capture, or
blur. SDL resynchronizes ordinary mouse state after `SYN_DROPPED` using
`EVIOCGKEY` and `EVIOCGABS`; the kernel retains the actual absolute position
independently of an evdev reader's overflowed ring. These are shared platform
or SDL fixes, not Freeciv resets or synthesized clicks.

SDL maps inclusive absolute-axis bounds to inclusive display pixels,
including overflow recovery. A maximum device sample reaches `width - 1`
or `height - 1`, never the first pixel outside the window. Leaving the
graphics pane can produce such an edge sample; mapping it outside would
clear SDL's mouse focus and hide the cursor even after returning.

## Future work: report SDL's absolute-pointer endpoint bug

- [ ] Report the SDL2 direct evdev absolute-mouse conversion upstream and
  propose a general fix. No upstream report has been filed yet.

SDL 2.32.10's `src/core/linux/SDL_evdev.c` scales an axis with
`(value - minimum) * width / (maximum - minimum)`. At the advertised
maximum this produces `width`, outside the window's valid `0..width - 1`
pixels. SDL can then clear mouse focus and hide the KMS cursor; later
motion uses that lost focus and does not restore the cursor. This was
reproduced on Kandelo, independently of Freeciv's widgets.

Before filing, check the current upstream implementation and create a
standalone native Linux KMSDRM reproduction with an absolute evdev device;
that native reproduction has not been run. Include endpoint and
out-of-range sample regressions, and distinguish this path from relative
mice and desktop Wayland/X11 input. The local shared correction is
[`0007-scale-inclusive-absolute-axes.patch`](../packages/registry/sdl2/patches/0007-scale-inclusive-absolute-axes.patch),
with coverage in the SDL package runtime test and browser cursor-edge
tests. Retire the local patch once a verified upstream release supplies
the fix; preserve the same bounds in local overflow recovery.

## Future work: report SDL's deferred drawable recreation

SDL 2.32.10's KMS backend recreates a dirty EGL surface during the first
swap after a mode change. Shader compilation can flush a clear beforehand,
so that clear is lost while subsequent queued draws reach the new surface.
The SDL package implements the standard `GL_GetDrawableSize` driver hook
to prepare the drawable before the GLES renderer submits commands, while
retaining the upstream swap-time fallback for other callers. The browser
regression checks a clear plus translucent texture at three resolutions.
Reproduce this ordering defect on native Linux KMSDRM before reporting it
upstream. That native reproduction and upstream report remain future work.

## Message contrast

The shipped upstream SDL2 Human theme uses a translucent `bg2.png` message
panel (alpha 179/255, about 70% opaque) and yellow `(255, 255, 0)`
unvisited location links. Other message
text is dark. These assets and colors are unchanged by the port; terrain
showing through the panel can reduce contrast. Changing monitor resolution
scales this whole image and does not repair that color contrast. A native
full-game pixel comparison has not been run; the theme/source comparison
alone must not be presented as proof of identical SDL blending.

## Remaining application corrections

The package keeps bounded corrections for upstream Freeciv defects:

- Probe readline's integer variable as data rather than a function.
- Migrate first-run defaults before command-line overrides, preserving
  the explicitly requested fullscreen mode.
- Use SDL color cursors instead of manually painting cursor sprites.
- Apply Screen resolution through SDL instead of only repositioning widgets;
  retire the old map surface when replacing the rendering surfaces.
- Preserve a callback's quit result while draining queued input.
- Avoid `SDL_SetEventFilter` when entering/leaving a drag. That SDL API
  discards queued events, including a release already following the press.
- Start native drags from the triggering event, rather than current mouse
  state that can already be at the end of a queued gesture.
- Keep scrollbar paint, hit rectangles, and drag limits the same size.
- Use filtered list positions rather than sparse global nation IDs.
- Dispatch Escape to an active map command before the global Options
  shortcut, and guard a NULL tile at non-wrapping map boundaries.

These application semantics cannot be repaired by changing the platform's
input stream or SDL API behavior. Their source-level causes are independent
of display density. An unpatched native Freeciv comparison has not been run.
The port preserves upstream's right-button minimap control and edit behavior:
a click outside an active text editor commits and leaves the editor; click
again to activate the target control. In particular, dismiss the repeating
lobby chat editor before clicking Start after entering server commands.

Shared host graphics code also restores framebuffer bindings after an EGL
surface is recreated. Shared dock code waits for a new command's complete
first line before treating shell output as a return. The kernel's recursive
`mkdir` behavior checks an occupied final name before parent write permission,
while preserving ancestor search checks. See [POSIX status](posix-status.md).

## Validation boundaries

Package tests run the shipped client and server on the dedicated Node kernel
worker as uid 1000. They check CLI versions, real rulesets, AI turns,
compressed saves, and reloading a save. The SDL input fixture checks actual
public events, keyboard/pointer ordering, and recovery after losing a button
release to 1,200 queued motions. A raw guest C fixture exercises cursor
capabilities, show, move, invalid flags, hide, and cleanup through the real
syscall channel. Kernel tests cover cursor permissions and buffer lifetime;
session tests cover bitmap resolution at 1×, 2×, and 3× browser density and
preservation of native compositor output.

Browser acceptance uses trusted mouse/keyboard events and screenshots of
native dialogs, map state, dragging, settings text, and exiting the client.
Save-file checks observe real unit orders and city production. Cursor tests
count scene uploads separately from cursor-plane presentations, and a second
SDL application exercises the shared default cursor. These checks support
specific paths; they do not establish general application performance.

The peer fixture uses two isolated Chromium contexts on one host. It grants
media permission inside those disposable test contexts, without opening a
microphone, to enumerate loopback candidates. This follows
[Chromium's IP-permission test](https://github.com/chromium/chromium/blob/main/content/browser/webrtc/webrtc_ip_permissions_browsertest.cc).
The application requests no media permission. The fixture verifies a
selected candidate pair with a loopback endpoint and retains the production
ICE server list and signalling behavior.

A standalone native WebRTC comparison reproduced the local failure outside
Kandelo: six exchanges without media permission failed (three with STUN and
three without), while six with permission connected. The failing contexts
published default-interface LAN/public candidates; the granted contexts
also enumerated loopback. This identifies a local test route boundary; it
does not establish Internet connectivity or explain why this machine's LAN
route failed. The fixture records descriptions actually published, candidate
arrival times, and live candidate-pair statistics so failures retain evidence.
Internet NAT traversal, Firefox, WebKit, and Freeciv inside Wayland have not
been verified for this port. See the PR for the exact validation performed
against its current head; earlier results do not prove a later revision.
