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

The package recipes are `freeciv`, `sdl2-image`, `sdl2-ttf`, and
`freeciv-browser-bundle`. They are included in the local supported set.
Freeciv is built through upstream Meson, using the SDK cross file and
resolver-owned dependencies. Its native tolua generator is built from
the Lua and tolua sources in the same verified upstream archive.

The first port selects the SDL2 client and server, with GNU readline
for the server console. Audio, translations, the modpack installer,
extra clients, and editing tools are disabled through upstream options.
The resulting server links GPLv3 readline and is a GPLv3 aggregate.

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
single grid. The browser presents the complete scene at 150% scale.

There is no Freeciv DPI conversion, renderer logical-size transform, font
point conversion, or compensating font/layout patch. Upstream's theme size
10 remains size 10 in the guest, displayed at about 15 CSS pixels here.
This is bitmap scaling, not independent native-density glyph rasterization.
The shared connector minimum is 640×480, so smaller panes fit that mode.
DPI-aware compositor profiles omit `displayScale` and retain native output.

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

## Remaining application corrections

The package keeps bounded corrections for upstream Freeciv defects:

- Probe readline's integer variable as data rather than a function.
- Migrate first-run defaults before command-line overrides, preserving
  the explicitly requested fullscreen mode.
- Use SDL color cursors instead of manually painting cursor sprites.
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

The peer fixture uses two isolated Chromium contexts on one host. Its
recorded ICE candidates can use the host's LAN interface; allowing loopback
does not guarantee a loopback route. ICE setup can fail before
Freeciv joins, independently of the application controls. Successful game
playthroughs do not establish reliable connectivity without a TURN relay.
Internet NAT traversal, Firefox, WebKit, and Freeciv inside Wayland have not
been verified for this port. See the PR for the exact validation performed
against its current head; earlier results do not prove a later revision.
