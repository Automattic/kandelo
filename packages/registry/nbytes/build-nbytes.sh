#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
: "${WASM_POSIX_DEP_OUT_DIR:?build nbytes through the package resolver}"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?declare libcxx in depends_on}"
source "$REPO_ROOT/sdk/activate.sh"
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot nbytes "$REPO_ROOT/sysroot" libcxx)"
export WASM_POSIX_SYSROOT

NODE_SOURCE="$KANDELO_PACKAGE_WORK_DIR/node-source"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/nbytes-build"
kandelo_package_stage_primary_source nbytes "$NODE_SOURCE" "$KANDELO_PACKAGE_WORK_DIR"
SOURCE_DIR="$NODE_SOURCE/deps/nbytes"
cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_SCAN_FOR_MODULES=OFF \
  -DCMAKE_CXX_FLAGS="-fno-exceptions -fno-rtti" \
  -DCMAKE_INSTALL_PREFIX="$WASM_POSIX_DEP_OUT_DIR" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DNBYTES_ENABLE_TESTING=OFF
cmake --build "$BUILD_DIR" --parallel "${WASM_POSIX_BUILD_JOBS:-8}"
cmake --install "$BUILD_DIR"
install -D "$SOURCE_DIR/LICENSE" "$WASM_POSIX_DEP_OUT_DIR/share/doc/nbytes/LICENSE"

# The resolver moves the install tree after sealing it. Keep upstream's
# generated metadata usable at its final location and by relocated consumers.
python3 - "$WASM_POSIX_DEP_OUT_DIR" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1]);p=root/'lib/pkgconfig/nbytes.pc';text=p.read_text()
for old,new in [(f'prefix={root}', 'prefix=${pcfiledir}/../..'),
                (f'libdir={root}/lib', 'libdir=${prefix}/lib'),
                (f'includedir={root}/include', 'includedir=${prefix}/include')]:
    if old not in text:raise SystemExit('unexpected upstream nbytes pkg-config layout: '+old)
    text=text.replace(old,new)
if str(root) in text:raise SystemExit('nbytes metadata retained staging path')
p.write_text(text)
PY
