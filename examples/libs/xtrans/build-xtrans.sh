#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/xtrans-src"
BUILD_DIR="$SCRIPT_DIR/xtrans-build"

XTRANS_VERSION="${WASM_POSIX_DEP_VERSION:-${XTRANS_VERSION:-1.6.0}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/xtrans-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.x.org/releases/individual/lib/xtrans-${XTRANS_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading xtrans $XTRANS_VERSION..."
    TARBALL="/tmp/xtrans-${XTRANS_VERSION}.tar.xz"
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

echo "==> Configuring xtrans..."
(
    cd "$BUILD_DIR"
    PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}" \
    "$SRC_DIR/configure" \
        --prefix="$INSTALL_DIR" \
        --disable-dependency-tracking

    echo "==> Installing to $INSTALL_DIR..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    make install
)

mkdir -p "$INSTALL_DIR/lib/pkgconfig"
if [ -d "$INSTALL_DIR/share/pkgconfig" ]; then
    cp "$INSTALL_DIR/share/pkgconfig/"*.pc "$INSTALL_DIR/lib/pkgconfig/"
fi

if [ -f "$INSTALL_DIR/lib/pkgconfig/xtrans.pc" ] && [ -d "$INSTALL_DIR/include/X11/Xtrans" ]; then
    echo "==> xtrans install complete!"
else
    echo "ERROR: xtrans install did not produce expected headers/pkg-config files" >&2
    exit 1
fi
