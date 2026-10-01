#!/usr/bin/env bash
#
# Build libsigc++ 2.10.3 (libsigc-2.0.a) for wasm32-posix-kernel.
#
# The tarball ships both meson and autotools; meson is not in the dev
# shell, so the port rides the configure cross-compile pattern from
# packages/registry/pango/build-pango.sh. -fwasm-exceptions is added so
# the objects are compatible with exception-using consumers (Waybar).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libsigcxx`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR         # install prefix
#     WASM_POSIX_DEP_VERSION         # upstream version
#     WASM_POSIX_DEP_SOURCE_URL      # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256   # expected sha256 of the tarball
#     WASM_POSIX_DEP_LIBCXX_DIR      # resolved libcxx prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/libsigcxx-src"

LIBSIGCXX_VERSION="${WASM_POSIX_DEP_VERSION:-2.10.3}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libsigcxx-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/libsigc++/2.10/libsigc++-${LIBSIGCXX_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/libsigcxx-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# wasm32posix-c++ resolves libc++ headers through the sysroot. Project a
# private sysroot with the resolved libcxx overlaid: the worktree SDK seed
# is an input tree for every package build and must hold no symlink
# (mariadb pattern — see scripts/package-build-roots.sh).
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot libsigcxx "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libsigc++ $LIBSIGCXX_VERSION..."
    TARBALL="/tmp/libsigc++-${LIBSIGCXX_VERSION}.tar.xz"
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
        echo "ERROR: libsigcxx resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

echo "==> Configuring libsigc++ for wasm32..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    CXXFLAGS="-O2 -fwasm-exceptions" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-documentation \
        --disable-benchmark \
        CC=wasm32posix-cc \
        CXX=wasm32posix-c++ \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building libsigc++..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C sigc++

    echo "==> Installing to $INSTALL_DIR..."
    make -C sigc++ install
    make install-nodist_pkgconfigDATA install-nodist_sigc_configHEADERS
)

if [ ! -f "$INSTALL_DIR/lib/libsigc-2.0.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libsigc-2.0.a" >&2
    exit 1
fi

echo "==> libsigc++ $LIBSIGCXX_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libsigc-2.0.a"
