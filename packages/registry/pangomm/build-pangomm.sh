#!/usr/bin/env bash
#
# Build pangomm 2.42.0 (libpangomm-1.4.a) for wasm32-posix-kernel.
#
# 2.42.0 is the last autotools release of the pangomm-1.4 ABI series
# (2.42.1 moved to meson-first), so the port rides the standard
# configure cross-compile pattern. C++ TUs need -fwasm-exceptions (see
# build-glibmm.sh).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve pangomm`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_PANGO_DIR        # resolved pango prefix
#     WASM_POSIX_DEP_GLIBMM_DIR       # resolved glibmm prefix
#     WASM_POSIX_DEP_CAIROMM_DIR      # resolved cairomm prefix
#     WASM_POSIX_DEP_GLIB_DIR         # resolved glib prefix
#     WASM_POSIX_DEP_CAIRO_DIR        # resolved cairo prefix
#     WASM_POSIX_DEP_LIBSIGCXX_DIR    # resolved libsigc++ prefix
#     WASM_POSIX_DEP_LIBCXX_DIR       # resolved libc++/libc++abi prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
SRC_DIR="$SCRIPT_DIR/pangomm-src"

PANGOMM_VERSION="${WASM_POSIX_DEP_VERSION:-2.42.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pangomm-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/pangomm/2.42/pangomm-${PANGOMM_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/pangomm-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

PANGO_PREFIX="${WASM_POSIX_DEP_PANGO_DIR:?WASM_POSIX_DEP_PANGO_DIR not set (must be invoked via cargo xtask build-deps resolve pangomm)}"
GLIBMM_PREFIX="${WASM_POSIX_DEP_GLIBMM_DIR:?WASM_POSIX_DEP_GLIBMM_DIR not set}"
CAIROMM_PREFIX="${WASM_POSIX_DEP_CAIROMM_DIR:?WASM_POSIX_DEP_CAIROMM_DIR not set}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"
CAIRO_PREFIX="${WASM_POSIX_DEP_CAIRO_DIR:?WASM_POSIX_DEP_CAIRO_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
LIBSIGCXX_PREFIX="${WASM_POSIX_DEP_LIBSIGCXX_DIR:?WASM_POSIX_DEP_LIBSIGCXX_DIR not set}"
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?WASM_POSIX_DEP_LIBCXX_DIR not set}"

mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading pangomm $PANGOMM_VERSION..."
    TARBALL="/tmp/pangomm-${PANGOMM_VERSION}.tar.xz"
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

PC_PATH="$PANGO_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$GLIBMM_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$CAIROMM_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$GLIB_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$CAIRO_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$LIBSIGCXX_PREFIX/lib/pkgconfig"

echo "==> Configuring pangomm for wasm32..."
(
    cd "$BUILD_DIR"
    # cairomm's headers pull cairo-ft.h; the host pkg-config does not
    # reliably traverse Requires.private for --cflags (see
    # build-cairomm.sh), so pass the freetype/fontconfig includes.
    CPPFLAGS="-I$FONTCONFIG_PREFIX/include -I$FREETYPE_PREFIX/include/freetype2" \
    CXXFLAGS="-O2 -fwasm-exceptions" \
    PKG_CONFIG_PATH="$PC_PATH" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-documentation \
        CC=wasm32posix-cc \
        CXX=wasm32posix-c++ \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building pangomm..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C pango/pangomm

    echo "==> Installing to $INSTALL_DIR..."
    make -C pango/pangomm install
    make install-data-am
)

if [ ! -f "$INSTALL_DIR/lib/libpangomm-1.4.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libpangomm-1.4.a" >&2
    exit 1
fi

echo "==> pangomm $PANGOMM_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libpangomm-1.4.a"
