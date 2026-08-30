#!/usr/bin/env bash
#
# Build atkmm 2.28.0 (libatkmm-1.6.a) for wasm32-posix-kernel.
#
# 2.28.0 is the last autotools release of the atkmm-1.6 ABI series
# (2.28.1 moved to meson-only), so the port rides the standard
# configure cross-compile pattern. C++ TUs need -fwasm-exceptions (see
# build-glibmm.sh).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve atkmm`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_ATK_DIR          # resolved atk prefix
#     WASM_POSIX_DEP_GLIBMM_DIR       # resolved glibmm prefix
#     WASM_POSIX_DEP_GLIB_DIR         # resolved glib prefix
#     WASM_POSIX_DEP_LIBSIGCXX_DIR    # resolved libsigc++ prefix
#     WASM_POSIX_DEP_LIBCXX_DIR       # resolved libc++/libc++abi prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/atkmm-src"

ATKMM_VERSION="${WASM_POSIX_DEP_VERSION:-2.28.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/atkmm-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/atkmm/2.28/atkmm-${ATKMM_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/atkmm-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

ATK_PREFIX="${WASM_POSIX_DEP_ATK_DIR:?WASM_POSIX_DEP_ATK_DIR not set (must be invoked via cargo xtask build-deps resolve atkmm)}"
GLIBMM_PREFIX="${WASM_POSIX_DEP_GLIBMM_DIR:?WASM_POSIX_DEP_GLIBMM_DIR not set}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"
LIBSIGCXX_PREFIX="${WASM_POSIX_DEP_LIBSIGCXX_DIR:?WASM_POSIX_DEP_LIBSIGCXX_DIR not set}"
# wasm32posix-c++ resolves libc++ headers through the sysroot. Project a
# private sysroot with the resolved libcxx overlaid: the worktree SDK seed
# is an input tree for every package build and must hold no symlink
# (mariadb pattern — see scripts/package-build-roots.sh).
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot atkmm "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading atkmm $ATKMM_VERSION..."
    TARBALL="/tmp/atkmm-${ATKMM_VERSION}.tar.xz"
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
        echo "ERROR: atkmm resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

PC_PATH="$ATK_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$GLIBMM_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$GLIB_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$LIBSIGCXX_PREFIX/lib/pkgconfig"

echo "==> Configuring atkmm for wasm32..."
(
    cd "$BUILD_DIR"
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

    echo "==> Building atkmm..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C atk/atkmm

    echo "==> Installing to $INSTALL_DIR..."
    make -C atk/atkmm install
    make install-data-am
)

if [ ! -f "$INSTALL_DIR/lib/libatkmm-1.6.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libatkmm-1.6.a" >&2
    exit 1
fi

echo "==> atkmm $ATKMM_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libatkmm-1.6.a"
