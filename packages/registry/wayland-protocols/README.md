# wayland-protocols (vendored v1 XML)

A `kind = "library"` package that installs the Wayland protocol XML the
compositor (`wlcompositor`) and its clients generate marshalling glue from.
The scanner that reads it, `wayland-scanner`, is a **host tool provided by
`flake.nix`** (`pkgs.wayland-scanner`), not a registry package: host build
tools live in the flake alongside `cmake`, `flex` and `bison`.

**Follow-up (not a real upstream package yet):** the XML is vendored in-tree
behind a placeholder `[source]` (an `example.invalid` URL with a zero
sha256) instead of being fetched from the upstream `wayland` and
`wayland-protocols` release archives. See
[docs/package-management.md](../../../docs/package-management.md#packages-that-are-not-real-upstream-builds-yet)
for the register of such packages and what replacing this one involves.

## What's here

| File | Purpose |
|---|---|
| `xml/wayland.xml` | Core protocol — `wl_display`, `wl_registry`, `wl_callback`, `wl_compositor`, `wl_surface`, `wl_shm`/`wl_shm_pool`/`wl_buffer`, `wl_seat`/`wl_keyboard`/`wl_pointer`, `wl_output` |
| `xml/xdg-shell.xml` | `xdg_wm_base`, `xdg_surface`, `xdg_toplevel` |
| the other `xml/*.xml` files | Extension protocols the desktop stack uses, such as `wlr-layer-shell-unstable-v1`, `linux-dmabuf-v1`, `viewporter`, `fractional-scale-v1`, `xdg-output-unstable-v1` and `presentation-time`. They are not pinned in the table below. |
| `build-wayland-protocols.sh` | Stages `xml/` into the package's resolver-owned output |
| `test/generate-and-verify.sh` | Runs the scanner and asserts the full v1 interface set is generated (driven by `host/test/wayland-protocols-scanner.test.ts`) |

It is a `library`, not a `source` package, because the source-only resolver
requires a `source` package to resolve to a real fetched, sha256-verified
upstream archive, and this one has only the vendored copy. Its outputs are
data files rather than archives and headers, declared through
`[outputs].files`.

## Version pin (keep coherent)

| Piece | Version | Upstream location |
|---|---|---|
| `xml/wayland.xml` | wayland **1.24.0** | `protocol/wayland.xml` |
| `xml/xdg-shell.xml` | wayland-protocols **1.45** | `stable/xdg-shell/xdg-shell.xml` |
| host `wayland-scanner` | **1.24.0** | `flake.nix` (nixpkgs-25.11) |

The `libwayland` package pins wayland 1.24.0 so its runtime
`wl_interface`/`wl_message` tables match the glue generated from this
`wayland.xml`. Bumping any of these changes the generated glue: bump
`build.toml`'s `revision` so consumers regenerate.

## How consumers use it

A wasm consumer (libwayland, the compositor, a client) lists this package in
`depends_on` and declares the scanner as a host tool:

```toml
depends_on = ["wayland-protocols"]

[[host_tools]]
name = "wayland-scanner"
version_constraint = ">=1.24"
[host_tools.install_hints]
darwin = "run the build through scripts/dev-shell.sh (flake.nix provides it)"
linux  = "run the build through scripts/dev-shell.sh (flake.nix provides it)"
```

Then in the build script (the resolver injects
`$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR`):

```bash
XML="$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR/xml/xdg-shell.xml"
wayland-scanner client-header "$XML" xdg-shell-client-protocol.h
wayland-scanner private-code  "$XML" xdg-shell-protocol.c
wasm32posix-cc -c xdg-shell-protocol.c -o xdg-shell-protocol.o   # links into the client
```

The core `wayland.xml` glue is compiled into `libwayland` itself; most
clients only regenerate the extension protocols (xdg-shell).
