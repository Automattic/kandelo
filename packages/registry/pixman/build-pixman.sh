#!/usr/bin/env bash
#
# Build pixman (libpixman-1.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). pixman is meson-only since 0.43, so the
# port builds through upstream's meson build with the SDK cross file
# (sdk/meson/wasm32posix.ini). Every SIMD backend is disabled
# explicitly — wasm32 has none of them, and pixman's generic C paths
# are complete without them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/pixman-src"

PIXMAN_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pixman-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/pixman-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

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

# Fresh build dir each run — meson bakes --prefix into the build tree.
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

echo "==> Configuring pixman $PIXMAN_VERSION for wasm32..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dloongson-mmi=disabled \
    -Dmmx=disabled \
    -Dsse2=disabled \
    -Dssse3=disabled \
    -Dvmx=disabled \
    -Darm-simd=disabled \
    -Dneon=disabled \
    -Da64-neon=disabled \
    -Dmips-dspr2=disabled \
    -Drvv=disabled \
    -Dgnu-inline-asm=disabled \
    -Dopenmp=disabled \
    -Dgtk=disabled \
    -Dlibpng=disabled \
    -Dtests=disabled \
    -Ddemos=disabled

echo "==> Building pixman..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

if [ -f "$INSTALL_DIR/lib/libpixman-1.a" ]; then
    echo "==> pixman build complete!"
    ls -lh "$INSTALL_DIR/lib/libpixman-1.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libpixman-1.a" >&2
    exit 1
fi
