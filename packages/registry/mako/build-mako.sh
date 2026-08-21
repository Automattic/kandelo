#!/usr/bin/env bash
#
# Build mako (mako.wasm + makoctl.wasm) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). mako is meson-only upstream, so we bypass
# it like foot: generate the client glue for the five protocol XMLs with
# wayland-scanner and compile the meson TU list directly (minus
# cairo-pixbuf.c — built without icons).
#
# One patch: pool-buffer.c allocates wl_shm buffers as renderD128
# dumb-bos passed by prime-fd instead of shm_open memfds — on this
# kernel a plain shm mmap is NOT shared across processes, only the DRI
# bo registry is. Same contract as foot's shm patch.
#
# mako forks its on-notify exec actions and makoctl forks its `menu`
# helper — wasm-fork-instrument is mandatory for both.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/mako-src"

MAKO_VERSION="${WASM_POSIX_DEP_VERSION:-1.10.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/mako-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/emersion/mako/archive/refs/tags/v${MAKO_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/mako-build"

for tool in wasm32posix-cc wayland-scanner; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

BASU_PREFIX="${WASM_POSIX_DEP_BASU_DIR:?WASM_POSIX_DEP_BASU_DIR not set (must be invoked via cargo xtask build-deps resolve mako)}"
CAIRO_PREFIX="${WASM_POSIX_DEP_CAIRO_DIR:?WASM_POSIX_DEP_CAIRO_DIR not set}"
PANGO_PREFIX="${WASM_POSIX_DEP_PANGO_DIR:?WASM_POSIX_DEP_PANGO_DIR not set}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"
PCRE2_PREFIX="${WASM_POSIX_DEP_PCRE2_DIR:?WASM_POSIX_DEP_PCRE2_DIR not set}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set}"
FRIBIDI_PREFIX="${WASM_POSIX_DEP_FRIBIDI_DIR:?WASM_POSIX_DEP_FRIBIDI_DIR not set}"
PIXMAN_PREFIX="${WASM_POSIX_DEP_PIXMAN_DIR:?WASM_POSIX_DEP_PIXMAN_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:?WASM_POSIX_DEP_LIBXML2_DIR not set}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set}"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
PROTOCOLS_XML="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR not set}/xml"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

# --- Fetch + verify + patch source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading mako $MAKO_VERSION..."
    TARBALL="/tmp/mako-${MAKO_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
    echo "==> Applying patches..."
    for p in "$SCRIPT_DIR"/patches/*.patch; do
        patch -p1 -d "$SRC_DIR" < "$p"
    done
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
GEN="$BUILD_DIR/gen"
mkdir -p "$GEN" "$INSTALL_DIR"

echo "==> Generating protocol glue..."
PROTOCOLS=(
    "$PROTOCOLS_XML/xdg-shell.xml"
    "$PROTOCOLS_XML/cursor-shape-v1.xml"
    "$PROTOCOLS_XML/xdg-activation-v1.xml"
    "$PROTOCOLS_XML/tablet-unstable-v2.xml"
    "$SRC_DIR/protocol/wlr-layer-shell-unstable-v1.xml"
)
for xml in "${PROTOCOLS[@]}"; do
    base="$(basename "$xml" .xml)"
    wayland-scanner client-header "$xml" "$GEN/$base-client-protocol.h"
    wayland-scanner private-code  "$xml" "$GEN/$base.c"
done

CFLAGS=(
    -O2 -std=c11
    -D_POSIX_C_SOURCE=200809L
    -DHAVE_BASU
    "-I$SRC_DIR/include"
    "-I$GEN"
    "-I$BASU_PREFIX/include"
    "-I$CAIRO_PREFIX/include"
    "-I$CAIRO_PREFIX/include/cairo"
    "-I$PANGO_PREFIX/include/pango-1.0"
    "-I$GLIB_PREFIX/include/glib-2.0"
    "-I$HARFBUZZ_PREFIX/include/harfbuzz"
    "-I$LIBWAYLAND_PREFIX/include"
    -Wno-unused-parameter -Wno-missing-braces
)

TUS=(
    config.c
    event-loop.c
    dbus/dbus.c
    dbus/mako.c
    dbus/xdg.c
    main.c
    mode.c
    notification.c
    pool-buffer.c
    render.c
    wayland.c
    criteria.c
    types.c
    surface.c
    icon.c
    string-util.c
)

echo "==> Compiling mako for wasm32..."
OBJS=()
for tu in "${TUS[@]}"; do
    obj="$BUILD_DIR/$(echo "${tu%.c}" | tr / -).o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/$tu" -o "$obj"
    OBJS+=("$obj")
done
for xml in "${PROTOCOLS[@]}"; do
    base="$(basename "$xml" .xml)"
    obj="$BUILD_DIR/proto-$base.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$GEN/$base.c" -o "$obj"
    OBJS+=("$obj")
done

# Link order: dependents before dependencies — pangocairo pulls
# pangoft2/pango/cairo, pango pulls harfbuzz/fribidi/gobject/glib,
# cairo pulls pixman/fontconfig/freetype/png, harfbuzz (C++) pulls
# libc++, libffi last so gobject closures and wl_closure_invoke
# resolve. libgbm/libdrm come from the base sysroot.
MAKO_LIBS=(
    "$PANGO_PREFIX/lib/libpangocairo-1.0.a"
    "$PANGO_PREFIX/lib/libpangoft2-1.0.a"
    "$PANGO_PREFIX/lib/libpango-1.0.a"
    "$CAIRO_PREFIX/lib/libcairo.a"
    "$HARFBUZZ_PREFIX/lib/libharfbuzz.a"
    "$FRIBIDI_PREFIX/lib/libfribidi.a"
    "$GLIB_PREFIX/lib/libgobject-2.0.a"
    "$GLIB_PREFIX/lib/libgmodule-2.0.a"
    "$GLIB_PREFIX/lib/libglib-2.0.a"
    "$PCRE2_PREFIX/lib/libpcre2-8.a"
    "$PIXMAN_PREFIX/lib/libpixman-1.a"
    "$FONTCONFIG_PREFIX/lib/libfontconfig.a"
    "$FREETYPE_PREFIX/lib/libfreetype.a"
    "$LIBXML2_PREFIX/lib/libxml2.a"
    "$LIBPNG_PREFIX/lib/libpng.a"
    "$ZLIB_PREFIX/lib/libz.a"
    "$LIBWAYLAND_PREFIX/lib/libwayland-cursor.a"
    "$LIBWAYLAND_PREFIX/lib/libwayland-client.a"
    "$BASU_PREFIX/lib/libbasu.a"
    "$SYSROOT/lib/libgbm.a"
    "$SYSROOT/lib/libdrm.a"
    "$SYSROOT/lib/libc++.a"
    "$SYSROOT/lib/libc++abi.a"
    "$LIBFFI_PREFIX/lib/libffi.a"
)

echo "==> Linking mako.wasm..."
wasm32posix-cc "${OBJS[@]}" "${MAKO_LIBS[@]}" -o "$BUILD_DIR/mako.wasm"

echo "==> Compiling makoctl..."
wasm32posix-cc "${CFLAGS[@]}" "$SRC_DIR/makoctl.c" \
    "$BASU_PREFIX/lib/libbasu.a" \
    -o "$BUILD_DIR/makoctl.wasm"

echo "==> Instrumenting fork paths..."
for out in mako makoctl; do
    bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
        "$BUILD_DIR/$out.wasm" -o "$BUILD_DIR/$out.wasm.instr"
    mv "$BUILD_DIR/$out.wasm.instr" "$BUILD_DIR/$out.wasm"
done

source "$REPO_ROOT/scripts/install-local-binary.sh"
for out in mako makoctl; do
    cp "$BUILD_DIR/$out.wasm" "$INSTALL_DIR/$out.wasm"
    install_local_binary mako "$BUILD_DIR/$out.wasm"
done

echo "==> mako build complete!"
ls -lh "$INSTALL_DIR"/*.wasm
