# wayland-protocols (vendored v1 XML)

`kind = "source"` package providing the Wayland protocol XML the DRI
compositor and clients need. See
[`docs/plans/2026-07-08-dri-wayland-compositor-plan.md`](../../../docs/plans/2026-07-08-dri-wayland-compositor-plan.md)
for the roadmap.

This is **PR2** of the Wayland port: the host code-gen toolchain
(`wayland-scanner`) + the protocol data it consumes. The scanner itself
is a **host tool provided by `flake.nix`** (`pkgs.wayland-scanner`), not
a registry package — host build tools live in the flake alongside
`cmake`, `flex`, `bison`, etc.

## What's here

| File | Purpose |
|---|---|
| `xml/wayland.xml` | Core protocol — `wl_display`, `wl_registry`, `wl_callback`, `wl_compositor`, `wl_surface`, `wl_shm`/`wl_shm_pool`/`wl_buffer`, `wl_seat`/`wl_keyboard`/`wl_pointer`, `wl_output` |
| `xml/xdg-shell.xml` | `xdg_wm_base`, `xdg_surface`, `xdg_toplevel` |
| `build-wayland-protocols.sh` | Stages `xml/` into the resolver cache |
| `test/generate-and-verify.sh` | Runs the scanner and asserts the full v1 interface set is generated (driven by `host/test/wayland-protocols-scanner.test.ts`) |

The XML is **vendored in-tree**, not fetched: the core `wayland.xml`
ships only inside the Linux-only `wayland` library (`meta.badPlatforms`
includes darwin), so vendoring is the only way to give macOS and Linux
identical inputs. It also pins the wire ABI explicitly and keeps the
dependency edge simple.

## Version pin (KEEP COHERENT)

| Piece | Version | Source |
|---|---|---|
| `xml/wayland.xml` | wayland **1.24.0** | `protocol/wayland.xml` |
| `xml/xdg-shell.xml` | wayland-protocols **1.45** | `stable/xdg-shell/xdg-shell.xml` |
| host `wayland-scanner` | **1.24.0** | `flake.nix` (nixpkgs-25.11) |

**PR3's `libwayland` MUST pin wayland 1.24.0** so its runtime
`wl_interface`/`wl_message` tables match the glue generated from this
`wayland.xml`. Bumping any of these is an ABI-affecting change to the
generated glue: bump `build.toml.revision` so consumers regenerate.

## How consumers use it

A wasm consumer (libwayland, the compositor, a client) lists this
package in `depends_on` and declares the scanner as a host tool:

```toml
depends_on = ["wayland-protocols"]

[[host_tools]]
name = "wayland-scanner"
version_constraint = ">=1.24"
[host_tools.install_hints]
darwin = "nix develop (provided by flake.nix)"
linux  = "nix develop (provided by flake.nix), or apt install wayland-scanner"
```

Then in the build script (`$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR`
is injected by the resolver):

```bash
XML="$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR/xml/xdg-shell.xml"
wayland-scanner client-header "$XML" xdg-shell-client-protocol.h
wayland-scanner private-code  "$XML" xdg-shell-protocol.c
wasm32posix-cc -c xdg-shell-protocol.c -o xdg-shell-protocol.o   # links into the client
```

Core `wayland.xml` glue is compiled into `libwayland` itself (PR3); most
clients only regenerate the **extension** protocols (xdg-shell).
