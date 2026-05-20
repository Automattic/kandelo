#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/libx11-src"
BUILD_DIR="$SCRIPT_DIR/libx11-build"

LIBX11_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBX11_VERSION:-1.8.13}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libx11-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.x.org/releases/individual/lib/libX11-${LIBX11_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

for tool in wasm32posix-cc wasm32posix-ar wasm32posix-ranlib wasm32posix-pkg-config; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Run 'npm link' in sdk/ first." >&2
        exit 1
    fi
done

XORGPROTO_PREFIX="${WASM_POSIX_DEP_XORGPROTO_DIR:-}"
if [ -z "$XORGPROTO_PREFIX" ]; then
    echo "ERROR: xorgproto dependency path not provided" >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libX11 $LIBX11_VERSION..."
    TARBALL="/tmp/libX11-${LIBX11_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring libX11 for wasm32..."
(
    cd "$BUILD_DIR"
    PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}" \
    CFLAGS="-O2 -DMAXHOSTNAMELEN=255 -D_POSIX_THREAD_SAFE_FUNCTIONS=200809L" \
    CC_FOR_BUILD="${CC_FOR_BUILD:-cc}" \
    CPPFLAGS_FOR_BUILD="-I$SRC_DIR/include" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-dependency-tracking \
        --disable-specs \
        --disable-loadable-xcursor \
        --disable-composecache \
        --with-keysymdefdir="$XORGPROTO_PREFIX/include/X11" \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        PKG_CONFIG=wasm32posix-pkg-config

    echo "==> Building libX11..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

rm -f "$INSTALL_DIR/lib/"*.la

if [ -f "$INSTALL_DIR/lib/libX11.a" ] && [ -f "$INSTALL_DIR/lib/pkgconfig/x11.pc" ]; then
    echo "==> libX11 build complete!"
else
    echo "ERROR: libX11 build did not produce expected outputs" >&2
    exit 1
fi
