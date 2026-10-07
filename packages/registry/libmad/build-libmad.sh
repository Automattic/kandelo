#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
source "$REPO_ROOT/sdk/activate.sh"

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/libmad-src"
BUILD_DIR="$WORK_DIR/libmad-build"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?resolver did not provide the install directory}"
VERSION="$WASM_POSIX_DEP_VERSION"

if [ "${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}" != wasm32 ]; then
    echo "ERROR: libmad supports only wasm32" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
kandelo_package_stage_primary_source libmad "$SRC_DIR" "$WORK_DIR"

REPRO_FLAGS="-ffile-prefix-map=$WORK_DIR=/usr/src/libmad -fdebug-prefix-map=$WORK_DIR=/usr/src/libmad -fmacro-prefix-map=$WORK_DIR=/usr/src/libmad"
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG $REPRO_FLAGS" \
    -DBUILD_SHARED_LIBS=OFF \
    -DEXAMPLE=OFF \
    -DASO=OFF \
    -DFPM_64BIT=ON \
    -DFPM_DEFAULT=OFF
cmake --build "$BUILD_DIR" --parallel
cmake --install "$BUILD_DIR"

sed -i.bak 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
    "$INSTALL_DIR/lib/pkgconfig/mad.pc"
rm "$INSTALL_DIR/lib/pkgconfig/mad.pc.bak"
test -f "$INSTALL_DIR/lib/libmad.a"
test -f "$INSTALL_DIR/include/mad.h"
test -f "$INSTALL_DIR/lib/pkgconfig/mad.pc"
grep -q '^#define FPM_64BIT' "$INSTALL_DIR/include/mad.h"
echo "==> libmad $VERSION static decoder complete"
