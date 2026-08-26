#!/usr/bin/env bash
#
# Build libwayland (libwayland-client.a + libwayland-server.a) for
# wasm32-posix-kernel, pinned to wayland 1.24.0.
#
# We bypass upstream's meson build: it runs host-side feature probes that
# misreport against the wasm sysroot (e.g. it would detect macOS-only
# struct xucred / BSD ucred). Instead we mirror alsa-lib's approach —
# compile the handful of core TUs directly with a hand-curated config.h
# (src/config.h) and the generated protocol glue.
#
# The version MUST stay coherent with:
#   - packages/registry/wayland-protocols/xml/wayland.xml (wayland 1.24.0)
#   - the host wayland-scanner (flake.nix, 1.24.0)
# so the wire opcodes/interfaces match. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §3.
#
# libwayland's only libffi use is wl_closure_invoke; on wasm32 every
# Wayland argument is one i32 word, so we link the PR1 Wayland-scoped ffi
# shim (its include/ffi.h resolves the <ffi.h> the sources #include).
#
# Honors the dep-resolver build-script contract (docs/package-management.md).
# When invoked via `cargo xtask build-deps resolve libwayland`, the resolver
# builds the deps first and sets:
#
#     WASM_POSIX_DEP_OUT_DIR                     # install prefix (lib/ + include/)
#     WASM_POSIX_DEP_VERSION                     # upstream version (1.24.0)
#     WASM_POSIX_DEP_SOURCE_URL                  # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256               # expected sha256
#     WASM_POSIX_DEP_LIBFFI_DIR                  # libffi shim prefix (ffi.h)
#     WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR   # vendored protocol XML (xml/)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/wayland-src"

WL_VERSION="${WASM_POSIX_DEP_VERSION:-1.24.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libwayland-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://gitlab.freedesktop.org/wayland/wayland/-/releases/${WL_VERSION}/downloads/wayland-${WL_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

# --- Toolchain + deps ---------------------------------------------------
for tool in wasm32posix-cc wasm32posix-ar wayland-scanner; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh (provides the" >&2
        echo "       wasm toolchain + wayland-scanner from flake.nix)." >&2
        exit 1
    fi
done

LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set (invoke via cargo xtask build-deps resolve libwayland)}"
PROTO_SRC="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR not set (invoke via cargo xtask build-deps resolve libwayland)}"
WAYLAND_XML="$PROTO_SRC/xml/wayland.xml"

if [ ! -f "$LIBFFI_PREFIX/include/ffi.h" ]; then
    echo "ERROR: libffi shim header not found at $LIBFFI_PREFIX/include/ffi.h" >&2
    exit 1
fi
if [ ! -f "$WAYLAND_XML" ]; then
    echo "ERROR: vendored wayland.xml not found at $WAYLAND_XML" >&2
    exit 1
fi

# --- Fetch + verify source ---------------------------------------------
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading wayland $WL_VERSION..."
    TARBALL="/tmp/wayland-${WL_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

# Fresh build + install each run — stale objects would shadow config/glue
# changes and the cache key varies per build.
BUILD_DIR="$SCRIPT_DIR/wayland-build"
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/include"

WLSRC="$SRC_DIR/src"

# --- Generate config.h + wayland-version.h ------------------------------
# config.h lives at the source root (wayland-os.c does #include "../config.h").
cp "$SCRIPT_DIR/src/config.h" "$SRC_DIR/config.h"

VMAJOR="${WL_VERSION%%.*}"
VREST="${WL_VERSION#*.}"
VMINOR="${VREST%%.*}"
VMICRO="${VREST#*.}"
sed -e "s/@WAYLAND_VERSION_MAJOR@/$VMAJOR/g" \
    -e "s/@WAYLAND_VERSION_MINOR@/$VMINOR/g" \
    -e "s/@WAYLAND_VERSION_MICRO@/$VMICRO/g" \
    -e "s/@WAYLAND_VERSION@/$WL_VERSION/g" \
    "$WLSRC/wayland-version.h.in" > "$WLSRC/wayland-version.h"

# --- Generate protocol glue from the vendored core wayland.xml ----------
# `public-code` (upstream's choice for the shipped libs) exports the
# wl_*_interface symbols so consumers linking the archive resolve them.
echo "==> Generating protocol glue with $(wayland-scanner --version 2>&1 | head -1)..."
wayland-scanner public-code   "$WAYLAND_XML" "$WLSRC/wayland-protocol.c"
wayland-scanner client-header "$WAYLAND_XML" "$WLSRC/wayland-client-protocol.h"
wayland-scanner client-header -c "$WAYLAND_XML" "$WLSRC/wayland-client-protocol-core.h"
wayland-scanner server-header "$WAYLAND_XML" "$WLSRC/wayland-server-protocol.h"
wayland-scanner server-header -c "$WAYLAND_XML" "$WLSRC/wayland-server-protocol-core.h"

# --- Compile ------------------------------------------------------------
CFLAGS=(
    -O2 -fPIC -fvisibility=hidden -std=gnu11
    -DHAVE_CONFIG_H
    # (sources #define _GNU_SOURCE themselves; don't redefine on the cmdline)
    "-I$SRC_DIR"          # config.h at source root
    "-I$WLSRC"            # sources + generated headers
    "-I$LIBFFI_PREFIX/include"  # ffi.h shim
    -Wno-unused-parameter
    -Wno-unused-function
    -Wno-unused-variable
)

compile() {
    local tu="$1"
    local obj="$BUILD_DIR/$(basename "$tu" .c).o"
    # Progress to stderr so command substitution captures only the obj path.
    echo "    $(basename "$tu")" >&2
    wasm32posix-cc -c "${CFLAGS[@]}" "$WLSRC/$tu" -o "$obj"
    echo "$obj"
}

echo "==> Compiling shared TUs (util + private + generated protocol)..."
UTIL_OBJ="$(compile wayland-util.c)"
CONN_OBJ="$(compile connection.c)"
OS_OBJ="$(compile wayland-os.c)"
PROTO_OBJ="$(compile wayland-protocol.c)"
SHARED_OBJS=("$UTIL_OBJ" "$CONN_OBJ" "$OS_OBJ" "$PROTO_OBJ")

echo "==> Compiling client TU..."
CLIENT_OBJ="$(compile wayland-client.c)"

echo "==> Compiling server TUs..."
SERVER_MAIN_OBJ="$(compile wayland-server.c)"
SHM_OBJ="$(compile wayland-shm.c)"
LOOP_OBJ="$(compile event-loop.c)"

echo "==> Archiving libwayland-client.a + libwayland-server.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libwayland-client.a" \
    "${SHARED_OBJS[@]}" "$CLIENT_OBJ"
wasm32posix-ar rcs "$INSTALL_DIR/lib/libwayland-server.a" \
    "${SHARED_OBJS[@]}" "$SERVER_MAIN_OBJ" "$SHM_OBJ" "$LOOP_OBJ"

# --- Install public headers --------------------------------------------
echo "==> Installing headers..."
for h in \
    wayland-util.h \
    wayland-version.h \
    wayland-client.h wayland-client-core.h wayland-client-protocol.h \
    wayland-server.h wayland-server-core.h wayland-server-protocol.h
do
    cp "$WLSRC/$h" "$INSTALL_DIR/include/$h"
done

echo "==> libwayland $WL_VERSION installed at $INSTALL_DIR"
echo "    lib/libwayland-client.a ($(wc -c < "$INSTALL_DIR/lib/libwayland-client.a") bytes)"
echo "    lib/libwayland-server.a ($(wc -c < "$INSTALL_DIR/lib/libwayland-server.a") bytes)"
