#!/usr/bin/env bash
#
# Build pixman (libpixman-1.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). Autotools cross-build like libpng: every
# SIMD backend is disabled explicitly — wasm32 has none of them, and
# pixman's generic C paths are complete without them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/pixman-src"

PIXMAN_VERSION="${WASM_POSIX_DEP_VERSION:-0.42.2}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pixman-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.cairographics.org/releases/pixman-${PIXMAN_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/pixman-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading pixman $PIXMAN_VERSION..."
    TARBALL="/tmp/pixman-${PIXMAN_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring pixman for wasm32..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-mmx \
        --disable-sse2 \
        --disable-ssse3 \
        --disable-vmx \
        --disable-arm-simd \
        --disable-arm-neon \
        --disable-arm-a64-neon \
        --disable-arm-iwmmxt \
        --disable-mips-dspr2 \
        --disable-openmp \
        --disable-gtk \
        --disable-libpng \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building pixman..."
    # Library only — the test/ and demo/ trees want a runnable host.
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C pixman

    echo "==> Installing to $INSTALL_DIR..."
    make -C pixman install
    make install-pkgconfigDATA
)

if [ -f "$INSTALL_DIR/lib/libpixman-1.a" ]; then
    echo "==> pixman build complete!"
    ls -lh "$INSTALL_DIR/lib/libpixman-1.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libpixman-1.a" >&2
    exit 1
fi
