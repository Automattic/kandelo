#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
: "${WASM_POSIX_DEP_OUT_DIR:?build simdutf through the package resolver}"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?declare libcxx in depends_on}"
source "$REPO_ROOT/sdk/activate.sh"
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot simdutf "$REPO_ROOT/sysroot" libcxx)"
export WASM_POSIX_SYSROOT

NODE_SOURCE="$KANDELO_PACKAGE_WORK_DIR/node-source"
kandelo_package_stage_primary_source simdutf "$NODE_SOURCE" "$KANDELO_PACKAGE_WORK_DIR"
SOURCE_DIR="$NODE_SOURCE/deps/v8/third_party/simdutf"
# This bundled distribution is an amalgamation with a Chromium GN source_set,
# not the standalone project's CMake tree. Compile that entire original unit.
wasm32posix-c++ -std=c++20 -O2 -ffunction-sections -fdata-sections \
  -fno-exceptions -fno-rtti -I "$SOURCE_DIR" \
  -c "$SOURCE_DIR/simdutf.cpp" -o "$KANDELO_PACKAGE_WORK_DIR/simdutf.o"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig" "$WASM_POSIX_DEP_OUT_DIR/include" \
  "$WASM_POSIX_DEP_OUT_DIR/share/doc/simdutf"
wasm32posix-ar rcs "$WASM_POSIX_DEP_OUT_DIR/lib/libsimdutf.a" "$KANDELO_PACKAGE_WORK_DIR/simdutf.o"
install -m 644 "$SOURCE_DIR/simdutf.h" "$WASM_POSIX_DEP_OUT_DIR/include/simdutf.h"
install -m 644 "$SOURCE_DIR/LICENSE" "$SOURCE_DIR/README.chromium" "$WASM_POSIX_DEP_OUT_DIR/share/doc/simdutf/"
cat > "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig/simdutf.pc" <<'PC'
prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include

Name: simdutf
Description: Node-vendored Unicode and base64 primitives
Version: 7.7.0
Libs: -L${libdir} -lsimdutf
Cflags: -I${includedir}
PC
