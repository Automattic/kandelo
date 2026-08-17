#!/usr/bin/env bash
#
# Build glibmm 2.62.0 (libglibmm-2.4.a + libgiomm-2.4.a) for
# wasm32-posix-kernel.
#
# 2.62.0 is the last autotools release of the glibmm-2.4 ABI series
# (2.64 moved to meson-only), so the port rides the standard configure
# cross-compile pattern. C++ TUs need -fwasm-exceptions: glibmm throws
# Glib::Error across the C/C++ boundary, and without the flag clang
# lowers try/catch to `__cxa_throw; unreachable`.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve glibmm`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_GLIB_DIR         # resolved glib prefix
#     WASM_POSIX_DEP_LIBSIGCXX_DIR    # resolved libsigc++ prefix
#     WASM_POSIX_DEP_LIBCXX_DIR       # resolved libc++/libc++abi prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
SRC_DIR="$SCRIPT_DIR/glibmm-src"

GLIBMM_VERSION="${WASM_POSIX_DEP_VERSION:-2.62.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/glibmm-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/glibmm/2.62/glibmm-${GLIBMM_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/glibmm-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set (must be invoked via cargo xtask build-deps resolve glibmm)}"
LIBSIGCXX_PREFIX="${WASM_POSIX_DEP_LIBSIGCXX_DIR:?WASM_POSIX_DEP_LIBSIGCXX_DIR not set}"
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?WASM_POSIX_DEP_LIBCXX_DIR not set}"

# wasm32posix-c++ resolves libc++ headers through the sysroot; index the
# resolved cache contents in (same idiom as build-mariadb.sh).
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading glibmm $GLIBMM_VERSION..."
    TARBALL="/tmp/glibmm-${GLIBMM_VERSION}.tar.xz"
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
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/libcxx-contenttype-string.patch"
fi

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

PC_PATH="$GLIB_PREFIX/lib/pkgconfig"
PC_PATH="$PC_PATH:$LIBSIGCXX_PREFIX/lib/pkgconfig"

echo "==> Configuring glibmm for wasm32..."
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

    echo "==> Building glibmm..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C glib/glibmm
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C gio/giomm

    echo "==> Installing to $INSTALL_DIR..."
    make -C glib/glibmm install
    make -C gio/giomm install
    # Top-level install-data-am places the umbrella headers (glibmm.h,
    # giomm.h), the generated config headers, and the .pc files without
    # recursing into tools/tests/examples the way `make install` would.
    make install-data-am
)

for lib in libglibmm-2.4.a libgiomm-2.4.a; do
    if [ ! -f "$INSTALL_DIR/lib/$lib" ]; then
        echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/$lib" >&2
        exit 1
    fi
done

echo "==> glibmm $GLIBMM_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/"lib*mm-2.4.a
