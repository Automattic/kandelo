#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/pthread-stubs-src"
BUILD_DIR="$SCRIPT_DIR/pthread-stubs-build"

PTHREAD_STUBS_VERSION="${WASM_POSIX_DEP_VERSION:-${PTHREAD_STUBS_VERSION:-0.5}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pthread-stubs-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.x.org/releases/individual/lib/libpthread-stubs-${PTHREAD_STUBS_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading pthread-stubs $PTHREAD_STUBS_VERSION..."
    TARBALL="/tmp/libpthread-stubs-${PTHREAD_STUBS_VERSION}.tar.xz"
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

echo "==> Configuring pthread-stubs..."
(
    cd "$BUILD_DIR"
    "$SRC_DIR/configure" \
        --prefix="$INSTALL_DIR" \
        --disable-dependency-tracking

    echo "==> Installing to $INSTALL_DIR..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    make install
)

if [ -f "$INSTALL_DIR/lib/pkgconfig/pthread-stubs.pc" ]; then
    echo "==> pthread-stubs install complete!"
else
    echo "ERROR: pthread-stubs install did not produce pthread-stubs.pc" >&2
    exit 1
fi
