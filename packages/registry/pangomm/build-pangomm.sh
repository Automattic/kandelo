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
# wasm32posix-c++ resolves libc++ headers through the sysroot. Project a
# private sysroot with the resolved libcxx overlaid: the worktree SDK seed
# is an input tree for every package build and must hold no symlink
# (mariadb pattern — see scripts/package-build-roots.sh).
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot pangomm "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

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
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: pangomm resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
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
