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
helper signatures used by direct callers. Native calling conventions can tolerate omitted arguments;
WebAssembly's typed indirect calls cannot. Clean patch application and
Wasm32 syntax/type controls pass, with the original three type controls and six further registration
controls failing on the original source. These checks do not establish a working application.

Normal package and image builds, Node sessions, real headless Chromium,
Firefox and WebKit menu/launch/focus/close checks, and repeated memory
switching remain validation gates. No payload, memory or performance
measurement is claimed yet.
