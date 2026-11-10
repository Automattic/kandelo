#!/usr/bin/env bash
# Build upstream json-c as a static library for Kandelo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
JSONC_VERSION="$WASM_POSIX_DEP_VERSION"
WORK_DIR="$(kandelo_package_make_work_dir json-c)"
trap 'rm -rf "$WORK_DIR"' EXIT

INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?WASM_POSIX_DEP_OUT_DIR must name the resolver staging directory}"

export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
for tool in wasm32posix-cc wasm32posix-ar wasm32posix-ranlib cmake; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: required build tool not found: $tool" >&2
        exit 1
    }
done

SRC_DIR="$WORK_DIR/source"
BUILD_DIR="$WORK_DIR/build"
REPRO_FLAGS="-ffile-prefix-map=$WORK_DIR=/usr/src/json-c -fdebug-prefix-map=$WORK_DIR=/usr/src/json-c -fmacro-prefix-map=$WORK_DIR=/usr/src/json-c"

kandelo_package_stage_primary_source json-c "$SRC_DIR" "$WORK_DIR"

echo "==> Configuring json-c $JSONC_VERSION..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG $REPRO_FLAGS" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_STATIC_LIBS=ON \
    -DBUILD_APPS=OFF \
    -DBUILD_TESTING=OFF \
    -DDISABLE_EXTRA_LIBS=ON

cmake --build "$BUILD_DIR" --parallel
cmake --install "$BUILD_DIR"

# The resolver atomically moves this staging tree, so pkg-config metadata
# stays relative and the CMake package files that name the staging prefix
# are not shipped.
sed -i.bak "s|$INSTALL_DIR|\\\${pcfiledir}/../..|g" \
    "$INSTALL_DIR/lib/pkgconfig/json-c.pc"
rm -f "$INSTALL_DIR/lib/pkgconfig/json-c.pc.bak"
rm -rf "$INSTALL_DIR/lib/cmake"
test -f "$INSTALL_DIR/lib/libjson-c.a"
test -f "$INSTALL_DIR/include/json-c/json.h"
test -f "$INSTALL_DIR/lib/pkgconfig/json-c.pc"
echo "==> json-c $JSONC_VERSION static package complete"
