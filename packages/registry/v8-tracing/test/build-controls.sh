#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$REPO_ROOT"
source sdk/activate.sh
source scripts/package-build-roots.sh
PROBE_OUT="${1:?usage: build-controls.sh <absolute-output-directory>}"
case "$PROBE_OUT" in /*) ;; *) echo 'absolute output directory required' >&2;exit 2;; esac
mkdir -p "$PROBE_OUT"
export WASM_POSIX_DEP_WORK_DIR="$PROBE_OUT"
HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
resolve_dep(){ cargo run -q -p xtask --target "$HOST_TARGET" -- build-deps resolve "$1" --arch wasm32 --binaries-dir "$REPO_ROOT/binaries"; }
export WASM_POSIX_DEP_LIBCXX_DIR="$(resolve_dep libcxx)"
TRACING_PREFIX="$(resolve_dep v8-tracing)"
LIBUV_PREFIX="$(resolve_dep libuv)"
export WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot tracing-controls "$REPO_ROOT/sysroot" libcxx)"
printf '%s\n' "$TRACING_PREFIX" > "$PROBE_OUT/library-prefix.txt"
cmake -S "$SCRIPT_DIR" -B "$PROBE_OUT/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
  -Dv8-tracing_DIR="$TRACING_PREFIX/lib/cmake/v8-tracing" \
  -Dlibuv_DIR="$LIBUV_PREFIX/lib/cmake/libuv" -DCMAKE_BUILD_TYPE=Debug
cmake --build "$PROBE_OUT/build" --verbose
scripts/run-wasm-fork-instrument.sh "$PROBE_OUT/build/v8-tracing-component-controls.wasm" \
  --keep-names -o "$PROBE_OUT/v8-tracing-component-controls.wasm"
