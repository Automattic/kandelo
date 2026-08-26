#!/usr/bin/env bash
#
# Build cairomm 1.12.2 (libcairomm-1.0.a) for wasm32-posix-kernel.
#
# 1.12.2 is the last autotools release of the cairomm-1.0 ABI series
# (1.14 moved to meson-only), so the port rides the standard configure
# cross-compile pattern. C++ TUs need -fwasm-exceptions (see
# build-glibmm.sh).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve cairomm`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_CAIRO_DIR        # resolved cairo prefix
#     WASM_POSIX_DEP_LIBSIGCXX_DIR    # resolved libsigc++ prefix
#     WASM_POSIX_DEP_LIBCXX_DIR       # resolved libc++/libc++abi prefix
#     WASM_POSIX_DEP_{GLIB,PIXMAN,FONTCONFIG,FREETYPE,LIBPNG}_DIR
#                                     # cairo.pc Requires.private closure
#                                       (passed via CPPFLAGS below)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/cairomm-src"

CAIROMM_VERSION="${WASM_POSIX_DEP_VERSION:-1.12.2}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/cairomm-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.cairographics.org/releases/cairomm-${CAIROMM_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/cairomm-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

CAIRO_PREFIX="${WASM_POSIX_DEP_CAIRO_DIR:?WASM_POSIX_DEP_CAIRO_DIR not set (must be invoked via cargo xtask build-deps resolve cairomm)}"
LIBSIGCXX_PREFIX="${WASM_POSIX_DEP_LIBSIGCXX_DIR:?WASM_POSIX_DEP_LIBSIGCXX_DIR not set}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"
PIXMAN_PREFIX="${WASM_POSIX_DEP_PIXMAN_DIR:?WASM_POSIX_DEP_PIXMAN_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"
# wasm32posix-c++ resolves libc++ headers through the sysroot. Project a
# private sysroot with the resolved libcxx overlaid: the worktree SDK seed
# is an input tree for every package build and must hold no symlink
# (mariadb pattern — see scripts/package-build-roots.sh).
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot cairomm "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading cairomm $CAIROMM_VERSION..."
    TARBALL="/tmp/cairomm-${CAIROMM_VERSION}.tar.gz"
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

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: cairomm resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

PC_PATH="$CAIRO_PREFIX/lib/pkgconfig"
for prefix in "$LIBSIGCXX_PREFIX" "$GLIB_PREFIX" "$PIXMAN_PREFIX" \
              "$FONTCONFIG_PREFIX" "$FREETYPE_PREFIX" "$LIBPNG_PREFIX"; do
    PC_PATH="$PC_PATH:$prefix/lib/pkgconfig"
done

echo "==> Configuring cairomm for wasm32..."
(
    cd "$BUILD_DIR"
    # cairo-ft.h (pulled in by cairomm/enums.h) includes ft2build.h +
    # fontconfig.h; the host pkg-config does not reliably traverse
    # cairo.pc's Requires.private for --cflags, so pass the closure.
    CPPFLAGS="-I$FONTCONFIG_PREFIX/include -I$FREETYPE_PREFIX/include/freetype2 -I$GLIB_PREFIX/include/glib-2.0 -I$GLIB_PREFIX/lib/glib-2.0/include -I$PIXMAN_PREFIX/include/pixman-1 -I$LIBPNG_PREFIX/include" \
    CXXFLAGS="-O2 -fwasm-exceptions" \
    PKG_CONFIG_PATH="$PC_PATH" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-documentation \
        --disable-tests \
        CC=wasm32posix-cc \
        CXX=wasm32posix-c++ \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building cairomm..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C cairomm

    echo "==> Installing to $INSTALL_DIR..."
    make -C cairomm install
    make install-nodist_pkgconfigDATA
)

if [ ! -f "$INSTALL_DIR/lib/libcairomm-1.0.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libcairomm-1.0.a" >&2
    exit 1
fi

echo "==> cairomm $CAIROMM_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libcairomm-1.0.a"
