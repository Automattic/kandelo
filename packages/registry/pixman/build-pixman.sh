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
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/pixman-src"

PIXMAN_VERSION="${WASM_POSIX_DEP_VERSION:-0.42.2}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pixman-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.cairographics.org/releases/pixman-${PIXMAN_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-ea1480efada2fd948bc75366f7c349e1c96d3297d09a3fe62626e38e234a625e}"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/pixman-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified pixman $PIXMAN_VERSION source..."
    kandelo_package_stage_verified_source pixman "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: pixman resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
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
