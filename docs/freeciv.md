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

To pan the map, click the desired place on the minimap with either mouse
button, or give the main map a short right-click. **C** centers the selected
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
in filtered sets. The leader edit and gender button retain their measured font
heights. The shared icon-button renderer uses signed content offsets, so text
larger than a constrained control cannot wrap its coordinates offscreen.

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

## Display density and text entry

The SDL2 client draws its entire interface into one logical coordinate
space at 96 DPI. For direct KMS output, `SDL_RenderSetLogicalSize` scales
that scene to the reported display DPI. Bitmap controls, minimap, map
tiles, text, pointer, and hit targets therefore retain the same apparent
size at 1× and 2× density. Wayland already supplies logical window
coordinates and retains its compositor-owned output scale.

SDL transforms queued mouse events through the same renderer transform.
Explicit mouse-state reads, including window/scrollbar dragging and map
commands, use `SDL_RenderWindowToLogical` as well. Neither font loading nor
cursor drawing applies physical DPI independently.

Font settings and `-- --Font SIZE` remain logical point sizes, converted
at 96 logical DPI: a base size of 10 rasterizes at about 13 logical pixels.
The complete scene then scales to the physical output. This software-surface
client scales rasterized text and bitmap art together; it is not a vector
interface that independently rasterizes each glyph at native output density.
Settings rows and window titles fit their measured fonts. Restart the client
after changing the base size so all existing widgets use the new font.
Disable **Use theme defined font size** to use **Base Font Size**.

SDL2's direct evdev backend now translates printable US ASCII keys into
`SDL_TEXTINPUT` when no Linux or FreeBSD console keymap is available.
It handles Shift, Caps Lock, keypad digits and decimal with Num Lock, and
repeats; Control, Alt and GUI shortcuts do not insert text. Backspace and
Delete remain key events. This fallback applies to SDL2 applications
generally. It does not implement non-US layouts, compose sequences or IME
input; Wayland continues to use its existing keymap path.

SDL2 merges keyboard and pointer evdev read batches by their monotonic event
timestamps. Draining the keyboard device first could process Tab before an
earlier mouse click: chat would open, the delayed click would close it, and
subsequent letters would activate map shortcuts. Each device retains a bounded
32-event read batch; the fix applies to SDL2 programs on both Kandelo hosts.

The shared browser keyboard source releases held input when the browser loses
focus, preserves the original keycode through keyup, and sends owned releases
even after focus moves to a dock control. Modifier-clicks reconcile keyboard
state before the pointer press. The Modeset pointer bridge releases both its
PS/2 and evdev feeds when a gesture is cancelled, pointer capture is lost, or
the browser loses focus. SDL's native drags therefore receive the same release
as other guest input consumers.

The browser pointer adapters also read complete button snapshots on motion.
Browsers report overlapping mouse-button changes as pointer motion, so
listening only to down/up events lost presses and releases. The shared snapshot
logic preserves these changes and clears held buttons after a missed release.
This correction applies to graphical demos generally.

Freeciv's SDL2 scrollbar layout now applies its minimum thumb size before
rendering. The renderer allocates exactly the widget's requested extent, so
the painted thumb, hit rectangle, and drag limits use the same dimensions.
Previously a long list could have a hit rectangle only a few pixels high,
while rendering enlarged the thumb to fit the theme's end caps. Clicking
that extra painted area reached the containing dialog instead of the bar.
This correction is shared by Freeciv's vertical and horizontal scrollbars.
Text editors return an outside mouse press to the enclosing event loop after
committing their contents. That press is consumed before the next queued SDL
event, preserving press/release order. The repeating lobby chat editor no
longer eats the first click on Start after a command. This handoff applies to
all SDL2 edit widgets; it does not append synthetic clicks behind pending
releases.

Native window and scrollbar drags also take their origin from the triggering
event's logical coordinates. A current-state query can already be at the
end of a gesture when SDL pumps several queued events together; cursor
presentation continues to sample current state independently.

Browser button snapshots cannot repair records lost farther downstream.
After an evdev reader's 1024-record ring overflows, SDL2 restores its ordinary
mouse state from the device's `EVIOCGKEY` and `EVIOCGABS` queries rather than
keeping a stale held button. The kernel retains the real absolute position
independently of that ring. This recovery is shared by SDL2 programs on Node
and browser hosts; it does not depend on a Freeciv-specific reset or Escape.

The production editor reserves its header height from the actual title,
entry count, production text, progress bar, and action-button heights. List
insertions and removals use that same header extent. Unit and building cards
share a measured artwork/name/description layout and a common grid height;
shorter cards are padded without scaling their text. This prevents progress
controls from overlapping and descriptions from being cut off at the bottom
of a fixed-size card.

## Cursor and in-game panels

Freeciv's color-cursor mode draws its normal arrow as well as its animated
map cursors through the SDL renderer. The pointer is composited after each
complete scene, so dialogs and map updates cannot erase it, and moving it
does not leave pixels in the saved background. Cursor textures are cached
per sprite/frame and released before the renderer is recreated. Pointer-only
frames reuse the scene's GPU texture; they do not upload the CPU scene again.
The event loop presents after draining input rather than forcing an upload
and presentation for each queued motion event. Unchanged pointer state does
not force periodic idle frames.

All cursor positions, dimensions, and hotspots use the scene's logical
coordinates. This also works on SDL displays without a hardware cursor
plane, including Kandelo's KMS implementation. Disabling color cursors
selects upstream's hardware cursor path, which Kandelo does not currently
provide.

The lower-right unit panel sizes its minimum width and height from the
configured fonts. The unit name, veteran status, and movement/terrain
information occupy distinct rows instead of being centered into a fixed
104-pixel box. Its minimum size follows both display DPI and the user's
base font size.

## Portability corrections

Freeciv's Meson readline probe treated the integer
`rl_completion_suppress_append` as a function. The package patch uses
its actual header declaration in a link check, because Wasm distinguishes
function and data symbols.

The SDL2 client also migrated legacy defaults after parsing GUI arguments
on its first launch, overwriting `--fullscreen`. A second upstream patch
migrates those defaults before applying command line overrides.

The SDL2 event loop now preserves a callback's exit result when more input is
queued. Previously a mouse/key release could replace the Quit button's result
with `ID_ERROR` after the menu had been removed, leaving the client running
without a menu. The fix stops draining that loop as soon as it receives an exit
result; remaining input stays queued for any enclosing widget loop. Client and
server binaries retain function names through fork instrumentation so browser
stack traces identify the active guest call.

Native window, scrollbar, and slider drags also preserve queued input. They
previously installed and removed an SDL global event filter, which flushes
all pending events and could discard the release ending a drag. The drag
handlers now consume normal motion/release events without that destructive
filter or its fixed pixel threshold.

The navigation patch also permits left-click minimap recentering and guards
held-pointer tile comparisons at non-wrapping map edges, where tile lookup can
return NULL. The Escape priority fix prevents Options from retaining an active
Go To preview behind the dialog.

The shared dock progress reader now ignores a partial old shell prompt
arriving before the new command's first complete line. Such a fragment
does not prove that the replacement program exited.

The port also exercises EGL window-surface recreation. Kandelo now
rebuilds its canvas-backed draw target before the next frame and replays
the new framebuffer binding on the shared GL context. Rebuilding only
at presentation left later frames drawing into the wrong framebuffer.
These are shared host implementation changes; the guest GL interface
and ABI are unchanged.

The port also exposed an existing kernel error-ordering issue affecting
recursive directory creation through root-owned ancestors. `mkdir` and
`mkdirat` now check an already occupied final name before requiring
parent write permission, while preserving ancestor search checks and
write checks for new entries. This also covers dangling symlinks.
The syscall signatures, error numbers, ownership, and successful
operations remain unchanged. ABI 50 is retained: this chooses among
overlapping failure conditions whose order is unspecified by
[POSIX error handling](https://pubs.opengroup.org/onlinepubs/9799919799/functions/V2_chap02.html#tag_16_03).

## Validation scope

A trusted browser mouse test presses left and right together and releases them
separately, observing each actual kernel-worker input message. It also
suppresses release/capture-loss notifications, requires the next motion to
repair the button state, and clicks native Options afterward. A trusted touch
gesture also retains its held button while a separate mouse hovers.

The native New Game checks first require colored nation flags in the initial
Core list and visible text in the leader gender control. They toggle that
control, select different visible rows, commit the nation, and start the game
at both display densities. They then found a city, open its production editor,
check padding beneath the last card text line, select a building, and read the
city's actual production from a server save after committing.

Nation-picker checks switch to the Extended list, drag the portion of the
visible thumb that previously missed hit testing, and require list pixels to
change. Three drag/Cancel/reopen cycles at each density must retain working
dialog clicks. The SDL runtime fixture separately holds a button, loses its
release to 1,200 queued motions, observes real `SYN_DROPPED` and device-state
queries, and requires the next press/release to appear in SDL's public queue.

The SDL2 runtime fixture queues interleaved clicks and keys on both real guest
evdev devices before pumping SDL. It checks the public event stream's order as
well as printable input, modifiers, repeats, and StopTextInput behavior.

Map navigation regressions at both densities pan with both minimap buttons,
repeat short right-click recentering and longer context-menu interactions,
and reopen/close Settings throughout. Interrupted map gestures (cancellation,
lost pointer capture, and browser blur) must leave subsequent Settings clicks
and Escape working. The tests read the human player's unit
coordinates, Go To flags, destinations, and route lengths from actual
uncompressed server saves before and after panning. A native chat/save
round-trip confirms queued input was consumed before checking Escape
cancellation and a subsequent selection click; the latter must not assign a
route from a stale Go To mode.

Lifecycle checks at 1× and 2× quit from the main menu and an active hosted
game, require an actual shell return with exit status zero, and inspect `/proc`
to ensure neither the client nor its launcher-owned server remains.

`apps/browser-demos/test/kandelo-freeciv.spec.ts` exercises the real SDL2
main menu, two clients starting a game through a network session and
ending a turn, their rendered maps, and the upstream single-player server
launch. Separate 1× and 2× game checks observe cursor pixels moving and
being erased in browser screenshots, and check the unit panel height,
separated text rows, and bitmap minimap toolbar size. The game checks also
cycle unit focus with W and observe the header change after ending a turn
with the minimap gear and then Shift+Enter. At both densities it
also drags the font dialog, cancels native drags through pointer cancellation,
lost capture and blur, checks a readable native menu,
replaces the base font size with typed digits, saves the setting through the
upstream UI, reads the real preferences file, and relaunches the client. The
static menu must clear the dock's restart indicator without extra input.
A separate static-menu cursor workload instruments the kernel worker's normal
WebGL calls, counts scene-upload bytes and texture allocations during 120
movements, and checks that warmed cursor-only frames reuse both textures.
`KANDELO_FREECIV_PROBE=before` records a baseline without applying the new
reuse assertions; `KANDELO_FREECIV_PROBE=after` records the candidate. The
instrumented presentation gaps include browser automation pacing and are not
uninstrumented input-latency or general platform performance measurements.
An additional sweep injects trusted mouse input at browser animation-frame
cadence without serially waiting for input acknowledgements. This separates
the renderer's pacing from serial Playwright mouse calls, which can themselves
limit the input rate. A final phase sends 120 motions without frame pacing and
opens Options; observing the dialog measures queue completion, including
Playwright and screenshot-sampling overhead. Reports record browser version,
viewport, density, and the exact archive digest.

A local Chromium 153.0.8010.12 run at a 1440×1000 CSS viewport and 2×
density recorded the following for the same 120-movement serial sweep:

| Work | Previous cursor implementation | Cached scene/cursor implementation |
| --- | ---: | ---: |
| Scene bytes uploaded | 2,220,825,600 | 0 |
| Textures created | 119 | 0 |

The separate frame-paced candidate sweep presented 119 updates in 1,996 ms,
with a median presentation gap of 15.5 ms and a 95th-percentile gap of
26.2 ms. These are focused, instrumented Freeciv measurements. They do not
establish whole-game frame rate, browser-to-visible input latency, or a
platform-wide performance improvement. The serial burst's elapsed time was
dominated by automation input pacing and is not evidence of a proportional
latency improvement from reducing upload bytes.

The local peer fixture uses two isolated Chromium contexts and Chromium's
loopback ICE flag. Internet NAT traversal, Firefox, and WebKit have not been
verified for this port. Freeciv inside Wayland has not been manually verified.
The existing SDL2 editor/shader browser test also passes with the shared
graphics correction.

`packages/registry/freeciv/test/runtime.test.ts` runs the shipped client
and server from the declared lazy archive on the dedicated Node kernel
worker as uid 1000. It checks CLI versions, real ruleset loading, AI
turns, compressed saves, and loading a saved game. Shared host tests cover
EGL surface/context recreation and the dock prompt fragment; the mkdir
change has a guest C regression plus Rust and filesystem conformance
coverage. `packages/registry/sdl2/test/runtime.test.ts` additionally drives
real evdev events through the Node worker and SDL's public event queue,
covering printable text, modifiers, repeats, keypad numbers, editing keys,
and text-input enable/disable behavior. Shared GL tests check presentation
notifications after surface recreation and reject lost-context/no-binding
notifications. ABI 50 and the browser asset checks remain consistent.
