#!/usr/bin/env bash
#
# Build fribidi (libfribidi.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). Plain autoconf cross-build like expat.

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
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/fribidi-src"

FRIBIDI_VERSION="${WASM_POSIX_DEP_VERSION:-1.0.16}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/fribidi-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/fribidi/fribidi/releases/download/v${FRIBIDI_VERSION}/fribidi-${FRIBIDI_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-1b1cde5b235d40479e91be2f0e88a309e3214c8ab470ec8a2744d82a5a9ea05c}"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/fribidi-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified fribidi $FRIBIDI_VERSION source..."
    kandelo_package_stage_verified_source fribidi "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

# Fresh build + install dir each run — autoconf bakes --prefix into
# Makefiles.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: fribidi resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

echo "==> Configuring fribidi for wasm32..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-debug \
        --disable-deprecated \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building fribidi..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C lib

    echo "==> Installing to $INSTALL_DIR..."
    make -C lib install
    make install-pkgconfigDATA
)

if [ -f "$INSTALL_DIR/lib/libfribidi.a" ]; then
    echo "==> fribidi build complete!"
    ls -lh "$INSTALL_DIR/lib/libfribidi.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libfribidi.a" >&2
    exit 1
fi
