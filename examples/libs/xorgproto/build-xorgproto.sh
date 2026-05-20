#!/usr/bin/env bash
#
# Build/install xorgproto headers and pkg-config metadata.
#
# This package is target-independent source data, but it still installs
# into the wasm32 dependency cache so downstream X.Org packages can use
# the resolver's normal WASM_POSIX_DEP_*_DIR and pkg-config path flow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/xorgproto-src"
BUILD_DIR="$SCRIPT_DIR/xorgproto-build"

XORGPROTO_VERSION="${WASM_POSIX_DEP_VERSION:-${XORGPROTO_VERSION:-2025.1}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/xorgproto-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.x.org/releases/individual/proto/xorgproto-${XORGPROTO_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading xorgproto $XORGPROTO_VERSION..."
    TARBALL="/tmp/xorgproto-${XORGPROTO_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring xorgproto..."
(
    cd "$BUILD_DIR"
    "$SRC_DIR/configure" \
        --prefix="$INSTALL_DIR" \
        --disable-dependency-tracking \
        --disable-specs \
        --enable-legacy

    echo "==> Installing to $INSTALL_DIR..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    make install
)

# xorgproto installs .pc files under share/pkgconfig because it is
# header-only. The resolver currently composes dependency pkg-config
# search paths from lib/pkgconfig, so mirror them there.
mkdir -p "$INSTALL_DIR/lib/pkgconfig"
if [ -d "$INSTALL_DIR/share/pkgconfig" ]; then
    cp "$INSTALL_DIR/share/pkgconfig/"*.pc "$INSTALL_DIR/lib/pkgconfig/"
fi

rm -rf "$INSTALL_DIR/share/doc" "$INSTALL_DIR/share/man"

if [ -f "$INSTALL_DIR/lib/pkgconfig/xproto.pc" ] && [ -d "$INSTALL_DIR/include/X11" ]; then
    echo "==> xorgproto install complete!"
    ls "$INSTALL_DIR/lib/pkgconfig/xproto.pc" "$INSTALL_DIR/lib/pkgconfig/inputproto.pc"
else
    echo "ERROR: xorgproto install did not produce expected headers/pkg-config files" >&2
    exit 1
fi
