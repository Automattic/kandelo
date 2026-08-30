#!/usr/bin/env bash
#
# Build gtk-layer-shell 0.9.2 (libgtk-layer-shell.a) for
# wasm32-posix-kernel.
#
# gtk-layer-shell is meson-only upstream, so this bypasses meson like
# mako/atk: wayland-scanner generates the protocol glue meson would
# (wlr-layer-shell from the tarball's protocol/, xdg-shell from the
# vendored wayland-protocols XML, `<basename>-client.h` naming per
# protocol/meson.build), then the upstream src/meson.build TU list
# compiles directly. The ext-session-lock glue upstream also generates
# is skipped — no 0.9.2 source references it, and the vendored
# wayland-protocols set does not carry it. 0.9.2 has no generated
# version header; src/meson.build passes the version as -D defines.
#
# No callback-arity patch: every signal handler, class-closure
# override, and wl_*_listener slot in 0.9.2 already has the exact
# marshal arity (checked against docs/porting-guide.md "Callback casts
# that change arity").
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve gtk-layer-shell`, env vars are set
# by the resolver:
#
#     WASM_POSIX_DEP_OUT_DIR                    # install prefix
#     WASM_POSIX_DEP_VERSION                    # upstream version
#     WASM_POSIX_DEP_SOURCE_URL                 # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256              # expected sha256
#     WASM_POSIX_DEP_GTK3_DIR                   # resolved gtk3 prefix
#     WASM_POSIX_DEP_GLIB_DIR                   # resolved glib prefix
#     WASM_POSIX_DEP_ATK_DIR                    # resolved atk prefix
#     WASM_POSIX_DEP_PANGO_DIR                  # resolved pango prefix
#     WASM_POSIX_DEP_CAIRO_DIR                  # resolved cairo prefix
#     WASM_POSIX_DEP_GDK_PIXBUF_DIR             # resolved gdk-pixbuf prefix
#     WASM_POSIX_DEP_LIBWAYLAND_DIR             # resolved libwayland prefix
#     WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR  # staged protocol XML

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/gtk-layer-shell-src"

GTK_LAYER_SHELL_VERSION="${WASM_POSIX_DEP_VERSION:-0.9.2}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/gtk-layer-shell-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/wmww/gtk-layer-shell/archive/refs/tags/v${GTK_LAYER_SHELL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/gtk-layer-shell-build"

for tool in wasm32posix-cc wayland-scanner; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

GTK3_PREFIX="${WASM_POSIX_DEP_GTK3_DIR:?WASM_POSIX_DEP_GTK3_DIR not set (must be invoked via cargo xtask build-deps resolve gtk-layer-shell)}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"
ATK_PREFIX="${WASM_POSIX_DEP_ATK_DIR:?WASM_POSIX_DEP_ATK_DIR not set}"
PANGO_PREFIX="${WASM_POSIX_DEP_PANGO_DIR:?WASM_POSIX_DEP_PANGO_DIR not set}"
CAIRO_PREFIX="${WASM_POSIX_DEP_CAIRO_DIR:?WASM_POSIX_DEP_CAIRO_DIR not set}"
GDK_PIXBUF_PREFIX="${WASM_POSIX_DEP_GDK_PIXBUF_DIR:?WASM_POSIX_DEP_GDK_PIXBUF_DIR not set}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set}"
PROTOCOLS_XML="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR not set}/xml"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading gtk-layer-shell $GTK_LAYER_SHELL_VERSION..."
    TARBALL="/tmp/gtk-layer-shell-${GTK_LAYER_SHELL_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: gtk-layer-shell resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
GEN="$BUILD_DIR/gen"
mkdir -p "$GEN" "$INSTALL_DIR/lib"

echo "==> Generating protocol glue..."
PROTOCOLS=(
    "$SRC_DIR/protocol/wlr-layer-shell-unstable-v1.xml"
    "$PROTOCOLS_XML/xdg-shell.xml"
)
for xml in "${PROTOCOLS[@]}"; do
    base="$(basename "$xml" .xml)"
    wayland-scanner client-header "$xml" "$GEN/$base-client.h"
    wayland-scanner private-code  "$xml" "$GEN/$base.c"
done

CFLAGS=(
    -O2 -std=gnu11
    -DGTK_LAYER_SHELL_MAJOR="${GTK_LAYER_SHELL_VERSION%%.*}"
    -DGTK_LAYER_SHELL_MINOR="$(echo "$GTK_LAYER_SHELL_VERSION" | cut -d. -f2)"
    -DGTK_LAYER_SHELL_MICRO="${GTK_LAYER_SHELL_VERSION##*.}"
    -DGLIB_DISABLE_DEPRECATION_WARNINGS
    "-I$GEN"
    "-I$SRC_DIR/include"
    "-I$SRC_DIR/gtk-priv/h"
    "-I$GTK3_PREFIX/include/gtk-3.0"
    "-I$ATK_PREFIX/include/atk-1.0"
    "-I$GDK_PIXBUF_PREFIX/include/gdk-pixbuf-2.0"
    "-I$PANGO_PREFIX/include/pango-1.0"
    "-I$GLIB_PREFIX/include/glib-2.0"
    "-I$GLIB_PREFIX/include"
    "-I$CAIRO_PREFIX/include/cairo"
    "-I$LIBWAYLAND_PREFIX/include"
)

# Upstream meson srcs list (src/meson.build).
TUS=(
    api.c
    gtk-wayland.c
    custom-shell-surface.c
    layer-surface.c
    xdg-popup-surface.c
    xdg-toplevel-surface.c
    gtk-priv-access.c
    simple-conversions.c
)

echo "==> Compiling gtk-layer-shell for wasm32..."
OBJS=()
for tu in "${TUS[@]}"; do
    echo "    src/$tu"
    obj="$BUILD_DIR/${tu%.c}.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/src/$tu" -o "$obj"
    OBJS+=("$obj")
done
for xml in "${PROTOCOLS[@]}"; do
    base="$(basename "$xml" .xml)"
    echo "    gen/$base.c"
    obj="$BUILD_DIR/proto-$base.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$GEN/$base.c" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Archiving..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libgtk-layer-shell.a" "${OBJS[@]}"

echo "==> Installing headers..."
INC="$INSTALL_DIR/include/gtk-layer-shell"
mkdir -p "$INC"
cp "$SRC_DIR/include/gtk-layer-shell.h" "$INC/"

echo "==> Writing pkg-config file..."
PC_DIR="$INSTALL_DIR/lib/pkgconfig"
mkdir -p "$PC_DIR"
cat > "$PC_DIR/gtk-layer-shell-0.pc" <<EOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: gtk-layer-shell
Description: Use the Layer Shell Wayland protocol with GTK
URL: https://github.com/wmww/gtk-layer-shell
Version: $GTK_LAYER_SHELL_VERSION
Requires: gtk+-3.0 wayland-client
Libs: -L\${libdir} -lgtk-layer-shell
Cflags: -I\${includedir}/gtk-layer-shell
EOF

echo "==> gtk-layer-shell $GTK_LAYER_SHELL_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libgtk-layer-shell.a"
