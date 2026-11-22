# SFWBar

Pinned upstream `v1.0_beta17` supplies the panel for the Sway configuration.
The configuration selects a Start menu, a task list with focus and window
operations, a workspace pager and a clock. The menu enumerates actual XDG
desktop entries for Terminal and ScummVM and launches guest programs.
The Labwc recipe remains available for explicit builds but is excluded from
the supported gallery and default build.

Sway supervises `/usr/bin/kandelo-sfwbar`, which selects the packaged
configuration and forwards its bar ID and inherited Wayland socket. Sway's
`swaybar_command` takes an executable pathname, so arguments belong in this
launcher.

The recipe uses the normal SDK, dependency resolver and fork instrumenter.
GTK3, the SFWBar core and the actual upstream `modules/appmenu.c` link in
one executable. An explicit Meson option retains `module("appmenu")` as the
configuration entry point and calls its unchanged main-thread initializer.
This avoids a second GTK object/type registry and supports the intentional
boundary that grouped programs cannot load dynamic side modules. The recipe
checks that the initializer is exported, but that alone does not establish
working runtime menu activation or launch behavior. The static recipe exports
only the normal SDK surface and its menu initializer: the previous
`--export-all` was needed for dynamic menu imports and unnecessarily retained
unreachable GTK functions in the static build. Size and rendered behavior
still require the rebuilt package. Other module names
retain upstream loader behavior; the packaged configuration requests only
the built-in application menu. Ordinary and SDK-prepared shared-memory
artifacts use the same implementation.

Other optional modules for audio services, networking, Bluetooth,
notifications, idle protocols and keyboard layout are disabled explicitly.
They are not required for this panel configuration. The recipe does not
substitute successful no-ops for those services.

The callback patches supply complete GTK signal signatures, boolean
event results and GLib source callback results. Adapter functions retain
helper signatures used by direct callers. The complete types are required
by the callback APIs and WebAssembly's typed indirect calls. Patch application and
Wasm32 syntax/type controls pass, with the original three type controls
and six further registration controls failing on the original source.
Five ignored Wayland event callbacks also use their generated protocol
argument lists instead of casting a zero-argument handler. Separate
translation-unit Wasm32 controls trap on all five original registrations
and return normally with the replacements. These checks do not establish
a working application.

Collection and trigger registrations use typed adapters that preserve the
direct helper interfaces and stable callback identities for removal.
Popup associations use object-bound unmap/destroy handlers and a retained
snapshot during collapse; cleanup receives the actual stored list data.
The [popup regression runner](test/README.md) verifies the pinned source
archive and exercises the actual source with native GLib/GObject signals.
It proves ownership transitions, separately from rendered GTK behavior.

File-monitor finalization and tray-menu destruction also use complete
registered signatures, releasing the retained file and removing sources
for the actual menu widget. Optional MPD, ALSA and notification callbacks
have typed adapters without changing the disabled-module selection.
All five original indirect calls trap in separate-translation-unit Wasm
controls; the repaired calls preserve their arguments and return values.
The full 74-file core passes typed-callback syntax checks. These checks do
not establish optional service behavior or a working desktop.

Normal package and image builds, Node sessions, real headless Chromium,
Firefox and WebKit menu/launch/focus/close checks, and repeated memory
switching remain validation gates. No payload, memory or performance
measurement is claimed yet.

The common panel includes a native workspace pager. Sway supplies its real
numbered workspaces through IPC; clicking uses its ordinary workspace
activation command. Labwc supplies its configured workspace names through
the existing ext-workspace protocol. No synthetic workspace pins or focus
state are supplied. The normal rebuilt panel and workspace click round trip
remain required consumer checks.

The shared dark panel clears the theme's button background images for
pager and task buttons, so their light labels remain readable in the
normal, focused and hovered states. This follows upstream's button reset;
the GTK theme otherwise paints a light image above a dark background color.
The normal image rebuild and rendered contrast checks remain required.

The bar keeps upstream's keyboard policy unpatched: it maps with no
keyboard interactivity, requests on-demand focus when the pointer enters
it and drops back to none when the pointer leaves. Revision 6 removes a
Kandelo patch that requested on-demand focus before mapping. The pinned
Labwc 0.20.2 `layers.c` gives keyboard focus to any on-demand TOP or
OVERLAY surface when it maps, so with that patch the panel took the
keyboard from the first terminal as soon as it appeared. A protocol trace
of the stock Labwc session showed `set_keyboard_interactivity(2)` before
the bar's first configure, `wl_keyboard.leave` on Foot and
`wl_keyboard.enter` on the bar at its map, no pointer event on the bar,
and every later key delivered to SFWBar. Sway focuses on-demand layers
only on click, so it did not show the symptom.

Under the upstream policy a click on the bar focuses it only if the
bar's on-demand request was committed before the button reached the
compositor. A person hovers before clicking; automated input must too.
By source review, Labwc also focuses a layer popup that requests a grab,
so its menus should receive keys either way; Sway has no such rule. The
rebuilt panel's menu keyboard checks have not run yet. `apps/browser-demos/test/kandelo-labwc.spec.ts`
waits for the painted panel before its first keystroke and requires that
input to reach Foot.

The desktop ScummVM entry uses `scummvm-static` with `TryExec` so the shared-memory desktop does not launch the unsupported dynamic side-module engine. The ordinary shell’s separate `scummvm` command remains unchanged.
