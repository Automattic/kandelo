#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
: "${WASM_POSIX_DEP_OUT_DIR:?build through the normal package resolver}"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?declare libcxx dependency}"
: "${WASM_POSIX_DEP_LIBUV_DIR:?declare libuv dependency}"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot v8-tracing "$REPO_ROOT/sysroot" libcxx)"
NODE_SOURCE="$KANDELO_PACKAGE_WORK_DIR/node-source"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/tracing-build"
kandelo_package_stage_primary_source v8-tracing "$NODE_SOURCE" "$KANDELO_PACKAGE_WORK_DIR"
patch -d "$NODE_SOURCE/deps/v8" -p1 < "$SCRIPT_DIR/patches/0001-kandelo-wasm32-config.patch"
cmake -S "$SCRIPT_DIR/cmake" -B "$BUILD_DIR" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_SCAN_FOR_MODULES=OFF \
  -DCMAKE_INSTALL_PREFIX="$WASM_POSIX_DEP_OUT_DIR" \
  -DNODE_SOURCE_DIR="$NODE_SOURCE" \
  -Dlibuv_DIR="$WASM_POSIX_DEP_LIBUV_DIR/lib/cmake/libuv"
cmake --build "$BUILD_DIR" --parallel "${WASM_POSIX_BUILD_JOBS:-8}"
cmake --install "$BUILD_DIR"
