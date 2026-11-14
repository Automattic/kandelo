#!/usr/bin/env bash
# Build upstream libjpeg-turbo's libjpeg API as a static library for Kandelo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
LIBJPEG_VERSION="$WASM_POSIX_DEP_VERSION"
WORK_DIR="$(kandelo_package_make_work_dir libjpeg-turbo)"
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
REPRO_FLAGS="-ffile-prefix-map=$WORK_DIR=/usr/src/libjpeg-turbo -fdebug-prefix-map=$WORK_DIR=/usr/src/libjpeg-turbo -fmacro-prefix-map=$WORK_DIR=/usr/src/libjpeg-turbo"

kandelo_package_stage_primary_source libjpeg-turbo "$SRC_DIR" "$WORK_DIR"

echo "==> Configuring libjpeg-turbo $LIBJPEG_VERSION..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG $REPRO_FLAGS" \
    -DENABLE_SHARED=OFF \
    -DENABLE_STATIC=ON \
    -DWITH_SIMD=OFF \
    -DWITH_TURBOJPEG=OFF \
    -DWITH_TOOLS=OFF \
    -DWITH_TESTS=OFF

cmake --build "$BUILD_DIR" --parallel
cmake --install "$BUILD_DIR"

# The resolver atomically moves this staging tree, so pkg-config metadata
# stays relative and the CMake package files that name the staging prefix
# are not shipped.
sed -i.bak "s|$INSTALL_DIR|\\\${pcfiledir}/../..|g" \
    "$INSTALL_DIR/lib/pkgconfig/libjpeg.pc"
rm -f "$INSTALL_DIR/lib/pkgconfig/libjpeg.pc.bak"
rm -rf "$INSTALL_DIR/lib/cmake" "$INSTALL_DIR/share" "$INSTALL_DIR/bin"
test -f "$INSTALL_DIR/lib/libjpeg.a"
test -f "$INSTALL_DIR/include/jpeglib.h"
test -f "$INSTALL_DIR/lib/pkgconfig/libjpeg.pc"
echo "==> libjpeg-turbo $LIBJPEG_VERSION static package complete"
