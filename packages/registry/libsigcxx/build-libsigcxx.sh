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

LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?WASM_POSIX_DEP_LIBCXX_DIR not set (must be invoked via cargo xtask build-deps resolve libsigcxx)}"

# wasm32posix-c++ resolves libc++ headers through the sysroot, so index
# the resolved libcxx artifacts in (mariadb pattern).
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

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
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
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
