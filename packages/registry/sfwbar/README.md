# SFWBar

Pinned upstream `v1.0_beta17` supplies a shared panel for the Sway and Labwc
demos. The configuration selects a Start menu, a task list with focus and
window operations, and a clock. The menu enumerates actual XDG desktop
entries for Terminal, ScummVM and Paint. It launches ordinary guest programs.

The recipe uses the normal SDK, dependency resolver and fork instrumenter.
GTK3 and SFWBar's core link statically; the unchanged `appmenu` implementation
is a genuine shared WebAssembly module at `/usr/lib/sfwbar/appmenu.so`.
Its imported symbols must be exported by the main executable, both before
and after instrumentation. This avoids linking a second GTK object/type
registry into the module. It preserves upstream module signature, version
and initialization checks.

Other optional modules for audio services, networking, Bluetooth,
notifications, idle protocols and keyboard layout are disabled explicitly.
They are not required for this panel configuration. The recipe does not
substitute successful no-ops for those services.

The callback patch supplies all arguments required by three GTK signal
signatures. Native calling conventions can tolerate omitted arguments;
WebAssembly's typed indirect calls cannot. Clean patch application and
Wasm32 syntax/type controls pass, with all three type controls failing on
the original source. These checks do not establish a working application.

Normal package and image builds, Node sessions, real headless Chromium,
Firefox and WebKit menu/launch/focus/close checks, and repeated memory
switching remain validation gates. No payload, memory or performance
measurement is claimed yet.
