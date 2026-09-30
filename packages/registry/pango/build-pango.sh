#!/usr/bin/env bash
#
# Build pango 1.42.4 (libpango-1.0.a, libpangoft2-1.0.a,
# libpangocairo-1.0.a) for wasm32-posix-kernel.
#
# 1.42.4 is the last autotools release (1.43 moved to meson), so the
# port rides the standard configure cross-compile pattern. Every dep
# is probed through pkg-config, so the script builds a PKG_CONFIG_PATH
# from the resolved prefixes instead of passing *_CFLAGS/*_LIBS pairs.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve pango`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_GLIB_DIR         # resolved glib prefix
#     WASM_POSIX_DEP_HARFBUZZ_DIR     # resolved harfbuzz prefix
#     WASM_POSIX_DEP_FRIBIDI_DIR      # resolved fribidi prefix
#     WASM_POSIX_DEP_CAIRO_DIR        # resolved cairo prefix
#     WASM_POSIX_DEP_FONTCONFIG_DIR   # resolved fontconfig prefix
#     WASM_POSIX_DEP_FREETYPE_DIR     # resolved freetype prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/pango-src"

PANGO_VERSION="${WASM_POSIX_DEP_VERSION:-1.42.4}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pango-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/pango/1.42/pango-${PANGO_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/pango-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set (must be invoked via cargo xtask build-deps resolve pango)}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set}"
FRIBIDI_PREFIX="${WASM_POSIX_DEP_FRIBIDI_DIR:?WASM_POSIX_DEP_FRIBIDI_DIR not set}"
CAIRO_PREFIX="${WASM_POSIX_DEP_CAIRO_DIR:?WASM_POSIX_DEP_CAIRO_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading pango $PANGO_VERSION..."
    TARBALL="/tmp/pango-${PANGO_VERSION}.tar.xz"
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
    # Route arity-changing (GFunc) casts of 1-argument free functions
    # through 2-argument wrappers. Native ABIs tolerate the extra
    # argument; wasm's typed call_indirect traps on it.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-callback-arity.patch"
fi

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: pango resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

PC_PATH="$GLIB_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$HARFBUZZ_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$FRIBIDI_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$CAIRO_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$FONTCONFIG_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$FREETYPE_PREFIX/lib/pkgconfig"

echo "==> Configuring pango for wasm32..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    PKG_CONFIG_PATH="$PC_PATH" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --with-cairo \
        --disable-gtk-doc \
        --disable-introspection \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building pango..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C pango

    echo "==> Installing to $INSTALL_DIR..."
    make -C pango install
    make install-pkgconfigDATA
)

for lib in libpango-1.0.a libpangoft2-1.0.a libpangocairo-1.0.a; do
    if [ ! -f "$INSTALL_DIR/lib/$lib" ]; then
        echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/$lib" >&2
        exit 1
    fi
done

echo "==> pango $PANGO_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/"libpango*.a
