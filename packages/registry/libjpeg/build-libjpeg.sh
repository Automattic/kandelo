#!/usr/bin/env bash
#
# Build IJG libjpeg for wasm32-posix-kernel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/libjpeg-src"
BUILD_DIR="$SCRIPT_DIR/libjpeg-build"

LIBJPEG_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBJPEG_VERSION:-9f}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libjpeg-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ijg.org/files/jpegsrc.v${LIBJPEG_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libjpeg $LIBJPEG_VERSION..."
    TARBALL="/tmp/jpegsrc.v${LIBJPEG_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring libjpeg for wasm32..."
(
    cd "$BUILD_DIR"
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        CFLAGS="-O2"

    echo "==> Building libjpeg..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/share"
rm -f "$INSTALL_DIR/lib/libjpeg.la"

if [ -f "$INSTALL_DIR/lib/libjpeg.a" ]; then
    echo "==> libjpeg build complete!"
    ls -lh "$INSTALL_DIR/lib/libjpeg.a"
else
    echo "ERROR: Build failed - library not found at $INSTALL_DIR/lib/libjpeg.a" >&2
    exit 1
fi
