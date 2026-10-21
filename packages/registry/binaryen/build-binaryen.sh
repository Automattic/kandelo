#!/usr/bin/env bash
set -euo pipefail

# Cross-build Binaryen's wasm-opt to wasm32 for Kandelo, so the in-guest
# compiler can run the same post-link optimization the host SDK runs.
# Build in resolver-owned roots using the worktree SDK and declared libcxx.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR/binaryen-work" wasm32

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
SRC_DIR="$WORK_DIR/binaryen-${WASM_POSIX_DEP_VERSION}"
BUILD_DIR="$WORK_DIR/build-wasm32"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

[ "$ARCH" = wasm32 ] || { echo "ERROR: binaryen supports wasm32 only" >&2; exit 1; }
[ -f "$SYSROOT/lib/libc.a" ] || { echo "ERROR: sysroot missing; run scripts/build-musl.sh" >&2; exit 1; }
for _t in wasm32posix-cc wasm32posix-c++ wasm32posix-ar wasm32posix-ranlib wasm32posix-nm; do
  command -v "$_t" >/dev/null || { echo "ERROR: SDK wrapper $_t not on PATH; source sdk/activate.sh" >&2; exit 1; }
done

if [ -z "$LIBCXX_DIR" ] && [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
  LIBCXX_DIR="$(cd "$REPO_ROOT" && cargo run -q -p xtask --target "$HOST_TARGET" -- build-deps resolve libcxx --arch wasm32)"
fi
[ -f "$LIBCXX_DIR/lib/libc++.a" ] || { echo "ERROR: libcxx dependency missing" >&2; exit 1; }

export WASM_POSIX_DEP_WORK_DIR="$WORK_DIR"
export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_DIR"
SYSROOT="$(kandelo_package_prepare_private_sysroot binaryen "$SYSROOT" libcxx)"
export WASM_POSIX_SYSROOT="$SYSROOT"

echo "==> Staging verified Binaryen ${WASM_POSIX_DEP_VERSION} source..."
kandelo_package_stage_primary_source binaryen "$SRC_DIR" "$WORK_DIR"

# Binaryen reports malformed input by throwing (its parsers and validator
# use C++ exceptions), so exceptions stay on and are lowered to wasm-EH.
COMMON_FLAGS=(
  "-ffile-prefix-map=$REPO_ROOT=/kandelo"
  "-ffile-prefix-map=$WORK_DIR=/kandelo-build/binaryen"
  -O2 -g0 -fwasm-exceptions
)
LINK_FLAGS=(-fwasm-exceptions "$LIBCXX_DIR/lib/libc++.a" "$LIBCXX_DIR/lib/libc++abi.a")

cmake -G "Unix Makefiles" -S "$SRC_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_SYSTEM_NAME=Kandelo \
  -DCMAKE_MODULE_PATH="$REPO_ROOT/sdk/cmake" \
  -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
  -DCMAKE_C_COMPILER="$(command -v wasm32posix-cc)" \
  -DCMAKE_CXX_COMPILER="$(command -v wasm32posix-c++)" \
  -DCMAKE_AR="$(command -v wasm32posix-ar)" \
  -DCMAKE_RANLIB="$(command -v wasm32posix-ranlib)" \
  -DCMAKE_NM="$(command -v wasm32posix-nm)" \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DCMAKE_C_FLAGS="${COMMON_FLAGS[*]}" -DCMAKE_CXX_FLAGS="${COMMON_FLAGS[*]}" \
  -DCMAKE_EXE_LINKER_FLAGS="${LINK_FLAGS[*]}" \
  -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
  -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY \
  -DBUILD_TESTS=OFF -DBUILD_FUZZTEST=OFF -DBUILD_STATIC_LIB=ON \
  -DBYN_ENABLE_LTO=OFF -DENABLE_WERROR=OFF -DINSTALL_LIBS=OFF

echo "==> Building wasm-opt..."
cmake --build "$BUILD_DIR" --target wasm-opt -j"${KANDELO_BINARYEN_BUILD_JOBS:-4}"

STAGE_DIR="$WORK_DIR/stage-bin"
mkdir -p "$STAGE_DIR"
cp -L "$BUILD_DIR/bin/wasm-opt.wasm" "$STAGE_DIR/wasm-opt.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary binaryen "$STAGE_DIR/wasm-opt.wasm" wasm-opt.wasm

echo "==> binaryen package build complete."
