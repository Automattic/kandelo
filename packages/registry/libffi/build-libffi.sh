#!/usr/bin/env bash
#
# Build libffi (libffi.a) — a Wayland-scoped SHIM of the libffi API,
# NOT a full libffi port — for wasm32-posix-kernel.
#
# The bundled `src/ffi_shim.c` + `include/ffi.h` are the entire
# substitute; there is no source tarball to fetch. libwayland's only
# use of libffi is `wl_closure_invoke`, and on wasm32 every Wayland
# argument is a single 32-bit word, so the shim dispatches by arity
# through a `call_indirect` trampoline instead of porting libffi's
# per-arch assembly. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §4 and
# include/ffi.h for the full rationale. Full libffi (doubles, structs,
# closures) is deferred to the glib/gobject tail.
#
# `package.toml`'s sentinel `[source]` block exists to satisfy the
# resolver schema, not to be downloaded.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libffi`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR  # where to install lib/ + include/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src/ffi_shim.c"
HDR="$SCRIPT_DIR/include/ffi.h"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libffi-install}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi
if ! command -v wasm32posix-ar &>/dev/null; then
    echo "ERROR: wasm32posix-ar not found." >&2
    exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include"

OBJ="$(mktemp -d)/ffi_shim.o"
trap 'rm -rf "$(dirname "$OBJ")"' EXIT

echo "==> Compiling libffi Wayland shim..."
wasm32posix-cc -c -O2 -fPIC \
    -I"$SCRIPT_DIR/include" \
    "$SRC" -o "$OBJ"

echo "==> Archiving libffi.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libffi.a" "$OBJ"

cp "$HDR" "$INSTALL_DIR/include/ffi.h"

echo "==> libffi (Wayland shim) installed at $INSTALL_DIR"
echo "    lib/libffi.a ($(wc -c < "$INSTALL_DIR/lib/libffi.a") bytes)"
