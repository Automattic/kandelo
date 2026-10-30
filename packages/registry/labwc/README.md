# labwc port in progress

This recipe targets native Wayland stacking with server-side decorated
windows, a root menu and foot as the configured terminal. The shell image and
gallery compose a `labwc -s foot` session with the normal package outputs.
Runtime validation is in progress; no working Kandelo desktop session is
claimed yet.

The pinned [stable 0.20.2 release](https://github.com/labwc/labwc/releases/tag/0.20.2)
was published on 2026-08-21. The tag resolves to
`97f28877a343e062f3178d201f0248cd9c2610cf`; the archive SHA-256 is
`fae023b6fe022f7057556707a17cdb2d98e0138c5dffaedaa1dade975699f9e8`.
The release's [Meson requirements](https://github.com/labwc/labwc/blob/97f28877a343e062f3178d201f0248cd9c2610cf/meson.build)
accept wlroots 0.20.1 through versions below 0.21, matching the registry's
0.20.2. Wayland, protocols, xkbcommon, DRM, libinput, pixman, XML, GLib,
Cairo, Pango, PNG and librsvg dependencies already exist in the registry.

The selected upstream features are native Wayland, PNG/SVG decorations and
labnag. Window icon lookup is disabled pending a separate libsfdo package;
Xwayland, systemd-session integration, translations, man-page generation and
upstream tests are explicitly disabled. These are upstream feature selections,
not substitutes for missing Kandelo APIs. Both installed executables actually
fork and use normal manifest-driven instrumentation. The recipe adds no target
identity flags, platform stubs, source patches or shared runtime changes.

The rc.xml uses built-in decoration defaults and mouse bindings. Super+Return
or Ctrl+Return starts foot, Alt+Tab cycles windows, Alt+F4 closes the focused
window and Super+Shift+Q or Ctrl+Shift+E exits. The Ctrl bindings avoid browser
and host interception of Super shortcuts. Right-clicking the desktop opens
the supplied root menu. The shell image supplies foot, fonts/fontconfig
configuration and a shell, and unpacks the declared XKB and libinput archives
into their normal guest locations.

Build through the normal resolver in the declared shell:

```sh
bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh labwc wasm32
```

Runtime/menu/input, rendering and lifecycle validation are still required on
both Node and browser hosts.
