#!/usr/bin/env bash
# Build a decompress-only libzstd as an exact, relocatable resolver package.
# Compiles zstd's official single-file DECODER amalgamation (zstddeclib.c).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
case "$TARGET_ARCH" in
    wasm32|wasm64) ;;
    *) echo "ERROR: libzstd supports wasm32 and wasm64, got $TARGET_ARCH" >&2; exit 1 ;;
esac
kandelo_package_prepare_build_roots "$SCRIPT_DIR" "$TARGET_ARCH"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/zstd-src"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

ZSTD_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libzstd-install}"

case "$TARGET_ARCH" in
    wasm32) SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}" ;;
    wasm64) SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot64}" ;;
    *) echo "ERROR: libzstd supports wasm32 and wasm64, got $TARGET_ARCH" >&2; exit 1 ;;
esac
export WASM_POSIX_SYSROOT="$SYSROOT"

CC="${TARGET_ARCH}posix-cc"
AR="${TARGET_ARCH}posix-ar"
RANLIB="${TARGET_ARCH}posix-ranlib"
for tool in "$CC" "$AR" "$RANLIB"; do
    command -v "$tool" >/dev/null || { echo "ERROR: $tool not found after sdk/activate.sh" >&2; exit 1; }
done

echo "==> Staging verified zstd $ZSTD_VERSION..."
kandelo_package_stage_primary_source libzstd "$SRC_DIR" "$WORK_DIR"

echo "==> Generating single-file decoder amalgamation..."
( cd "$SRC_DIR/build/single_file_libs" && bash create_single_file_decoder.sh )
test -f "$SRC_DIR/build/single_file_libs/zstddeclib.c"

echo "==> Compiling libzstd.a (decode only) for $TARGET_ARCH..."
"$CC" -O2 -ffile-prefix-map="$WORK_DIR=/usr/src/libzstd" -c "$SRC_DIR/build/single_file_libs/zstddeclib.c" -o "$WORK_DIR/zstddeclib.o"
"$AR" rcs "$WORK_DIR/libzstd.a" "$WORK_DIR/zstddeclib.o"
"$RANLIB" "$WORK_DIR/libzstd.a"

echo "==> Staging declared package outputs..."
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include"
cp "$WORK_DIR/libzstd.a" "$INSTALL_DIR/lib/"
cp "$SRC_DIR/lib/zstd.h" "$INSTALL_DIR/include/"

test -f "$INSTALL_DIR/lib/libzstd.a"
test -f "$INSTALL_DIR/include/zstd.h"
echo "==> libzstd (decode) build complete!"
ls -lh "$INSTALL_DIR/lib/libzstd.a"
