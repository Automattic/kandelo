#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/libxkbfile-src"
BUILD_DIR="$SCRIPT_DIR/libxkbfile-build"

LIBXKBFILE_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBXKBFILE_VERSION:-1.1.3}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libxkbfile-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.x.org/releases/individual/lib/libxkbfile-${LIBXKBFILE_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

for tool in wasm32posix-cc wasm32posix-ar wasm32posix-ranlib wasm32posix-pkg-config; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Run 'npm link' in sdk/ first." >&2
        exit 1
    fi
done

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libxkbfile $LIBXKBFILE_VERSION..."
    TARBALL="/tmp/libxkbfile-${LIBXKBFILE_VERSION}.tar.xz"
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

echo "==> Configuring libxkbfile for wasm32..."
(
    cd "$BUILD_DIR"
    PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}" \
    CFLAGS="-O2" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-dependency-tracking \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        PKG_CONFIG=wasm32posix-pkg-config

    echo "==> Building libxkbfile..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

rm -f "$INSTALL_DIR/lib/"*.la

if [ -f "$INSTALL_DIR/lib/libxkbfile.a" ] && [ -f "$INSTALL_DIR/lib/pkgconfig/xkbfile.pc" ]; then
    echo "==> libxkbfile build complete!"
else
    echo "ERROR: libxkbfile build did not produce expected outputs" >&2
    exit 1
fi
