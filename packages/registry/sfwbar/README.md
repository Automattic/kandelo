# SFWBar

Pinned upstream `v1.0_beta17` supplies a shared panel for the Sway and Labwc
demos. The configuration selects a Start menu, a task list with focus and
window operations, and a clock. The menu enumerates actual XDG desktop
entries for Terminal, ScummVM and Paint. It launches ordinary guest programs.

Sway supervises `/usr/local/bin/kandelo-sfwbar`, which selects the packaged
configuration and forwards its bar ID and inherited Wayland socket. Sway's
`swaybar_command` takes an executable pathname, so arguments belong in this
launcher. Labwc starts SFWBar through its configured shell session.

The recipe uses the normal SDK, dependency resolver and fork instrumenter.
GTK3 and SFWBar's core link statically; the unchanged `appmenu` implementation
is a genuine shared WebAssembly module at `/usr/lib/sfwbar/appmenu.so`.
Its application imports must resolve from the main executable before and
when checked after instrumentation. Relocation objects come from the real
dynamic linker; exact versioned fork imports come from each module's process
activation owner. They are not application exports. The recipe decodes real
modules with the declared Node runtime, checks symbol kinds and fails on
malformed artifacts or missing symbols. It avoids linking a second GTK
object/type registry and preserves upstream module signature, version and
initialization checks. This symbol check does not instantiate the module or
establish working runtime activation and menu behavior.

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

With the pinned GTK layer-shell API, the bar requests on-demand keyboard
focus before mapping and keeps that eligibility when the pointer leaves.
On-demand focus lets the compositor focus the bar on a click without
reserving the keyboard. Requesting it only on pointer entry races the
compositor's click-time focus decision: the click can arrive before the
request and its surface commit. The old boolean API retains upstream's
hover policy because it has no on-demand mode. A real menu keyboard,
application refocus and cooperative-exit check remain required for the
rebuilt panel; the captured late request alone does not prove the cause
of every input failure.
