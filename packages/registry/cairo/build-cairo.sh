#!/usr/bin/env bash
#
# Build cairo 1.16.0 (libcairo.a) for wasm32-posix-kernel.
#
# 1.16.0 is the last autotools release (1.18 moved to meson), so the
# port rides the standard configure cross-compile pattern. Image
# surfaces only per plan §4 (PR23): freetype/fontconfig fonts and png
# I/O; no GL, no X, no quartz/win32, no vector backends.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve cairo`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_PIXMAN_DIR       # resolved pixman prefix
#     WASM_POSIX_DEP_FREETYPE_DIR     # resolved freetype prefix
#     WASM_POSIX_DEP_FONTCONFIG_DIR   # resolved fontconfig prefix
#     WASM_POSIX_DEP_LIBPNG_DIR       # resolved libpng prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/cairo-src"

CAIRO_VERSION="${WASM_POSIX_DEP_VERSION:-1.16.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/cairo-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.cairographics.org/releases/cairo-${CAIRO_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/cairo-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

PIXMAN_PREFIX="${WASM_POSIX_DEP_PIXMAN_DIR:?WASM_POSIX_DEP_PIXMAN_DIR not set (must be invoked via cargo xtask build-deps resolve cairo)}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading cairo $CAIRO_VERSION..."
    TARBALL="/tmp/cairo-${CAIRO_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
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

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring cairo for wasm32 (pixman at $PIXMAN_PREFIX)..."
(
    cd "$BUILD_DIR"
    # The png feature probe ignores png_CFLAGS/png_LIBS and asks
    # pkg-config; png_REQUIRES pins the module name and
    # PKG_CONFIG_PATH points at the resolved libpng prefix.
    CFLAGS="-O2" \
    PKG_CONFIG_PATH="$LIBPNG_PREFIX/lib/pkgconfig" \
    png_REQUIRES="libpng16" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --enable-ft \
        --enable-fc \
        --enable-png \
        --disable-gl \
        --disable-glesv2 \
        --disable-glesv3 \
        --disable-xlib \
        --disable-xlib-xrender \
        --disable-xcb \
        --disable-xcb-shm \
        --disable-quartz \
        --disable-quartz-font \
        --disable-quartz-image \
        --disable-win32 \
        --disable-win32-font \
        --disable-pdf \
        --disable-ps \
        --disable-svg \
        --disable-script \
        --disable-interpreter \
        --disable-gobject \
        --disable-trace \
        --disable-symbol-lookup \
        --disable-valgrind \
        --disable-gtk-doc \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        pixman_CFLAGS="-I$PIXMAN_PREFIX/include/pixman-1" \
        pixman_LIBS="-L$PIXMAN_PREFIX/lib -lpixman-1" \
        FREETYPE_CFLAGS="-I$FREETYPE_PREFIX/include/freetype2" \
        FREETYPE_LIBS="-L$FREETYPE_PREFIX/lib -lfreetype" \
        FONTCONFIG_CFLAGS="-I$FONTCONFIG_PREFIX/include" \
        FONTCONFIG_LIBS="-L$FONTCONFIG_PREFIX/lib -lfontconfig" \
        png_CFLAGS="-I$LIBPNG_PREFIX/include" \
        png_LIBS="-L$LIBPNG_PREFIX/lib -lpng"

    echo "==> Building cairo..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C src

    echo "==> Installing to $INSTALL_DIR..."
    make -C src install
)

if [ -f "$INSTALL_DIR/lib/libcairo.a" ]; then
    echo "==> cairo build complete!"
    ls -lh "$INSTALL_DIR/lib/"libcairo*.a
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libcairo.a" >&2
    exit 1
fi
