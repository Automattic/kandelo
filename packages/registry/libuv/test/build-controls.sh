#!/usr/bin/env bash
# Focused static guest probe; all build writes stay under the caller's directory.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$REPO_ROOT"
source sdk/activate.sh
PROBE_OUT="${1:?usage: build-controls.sh <absolute-output-directory>}"
case "$PROBE_OUT" in
  /*) ;;
  *) echo "ERROR: probe output directory must be absolute" >&2; exit 2 ;;
esac
mkdir -p "$PROBE_OUT"
HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
LIBUV_PREFIX="$(cargo run -q -p xtask --target "$HOST_TARGET" -- build-deps resolve libuv --arch wasm32 --binaries-dir "$REPO_ROOT/binaries")"
printf '%s\n' "$LIBUV_PREFIX" > "$PROBE_OUT/library-prefix.txt"
cmake -S "$SCRIPT_DIR" -B "$PROBE_OUT/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
  -Dlibuv_DIR="$LIBUV_PREFIX/lib/cmake/libuv" -DCMAKE_BUILD_TYPE=Debug
cmake --build "$PROBE_OUT/build" --verbose
scripts/run-wasm-fork-instrument.sh "$PROBE_OUT/build/libuv-backend-controls.wasm" \
  --keep-names -o "$PROBE_OUT/libuv-backend-controls.wasm"
