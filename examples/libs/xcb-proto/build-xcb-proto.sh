#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/xcb-proto-src"
BUILD_DIR="$SCRIPT_DIR/xcb-proto-build"

XCB_PROTO_VERSION="${WASM_POSIX_DEP_VERSION:-${XCB_PROTO_VERSION:-1.17.0}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/xcb-proto-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.x.org/releases/individual/xcb/xcb-proto-${XCB_PROTO_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading xcb-proto $XCB_PROTO_VERSION..."
    TARBALL="/tmp/xcb-proto-${XCB_PROTO_VERSION}.tar.xz"
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

echo "==> Configuring xcb-proto..."
(
    cd "$BUILD_DIR"
    "$SRC_DIR/configure" \
        --prefix="$INSTALL_DIR"

    echo "==> Installing to $INSTALL_DIR..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    make install
)

mkdir -p "$INSTALL_DIR/lib/pkgconfig"
if [ -d "$INSTALL_DIR/share/pkgconfig" ]; then
    cp "$INSTALL_DIR/share/pkgconfig/"*.pc "$INSTALL_DIR/lib/pkgconfig/"
fi

if [ -f "$INSTALL_DIR/lib/pkgconfig/xcb-proto.pc" ] \
    && [ -d "$INSTALL_DIR/share/xcb" ] \
    && find "$INSTALL_DIR" -path '*/xcbgen/__init__.py' -print -quit | grep -q .; then
    echo "==> xcb-proto install complete!"
else
    echo "ERROR: xcb-proto install did not produce expected files" >&2
    exit 1
fi
