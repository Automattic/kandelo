#!/usr/bin/env bash
# Build the pinned Node archive's genuine libuv with its upstream CMake build.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
: "${WASM_POSIX_DEP_OUT_DIR:?build libuv through the package resolver}"
source "$REPO_ROOT/sdk/activate.sh"

NODE_SOURCE="$KANDELO_PACKAGE_WORK_DIR/node-source"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/libuv-build"
kandelo_package_stage_primary_source libuv "$NODE_SOURCE" "$KANDELO_PACKAGE_WORK_DIR"
SOURCE_DIR="$NODE_SOURCE/deps/uv"
patch -d "$SOURCE_DIR" -p1 < "$SCRIPT_DIR/patches/0001-kandelo-posix-backend.patch"
patch -d "$SOURCE_DIR" -p1 < "$SCRIPT_DIR/patches/0002-typed-pthread-entry.patch"
cp "$SCRIPT_DIR/src/kandelo-proctitle.c" "$SOURCE_DIR/src/unix/kandelo-proctitle.c"

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$WASM_POSIX_DEP_OUT_DIR" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_INSTALL_DOCDIR=share/doc/libuv \
  -DLIBUV_BUILD_SHARED=OFF \
  -DLIBUV_BUILD_TESTS=OFF \
  -DLIBUV_BUILD_BENCH=OFF
cmake --build "$BUILD_DIR" --parallel "${WASM_POSIX_BUILD_JOBS:-8}"
cmake --install "$BUILD_DIR"
