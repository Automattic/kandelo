#!/usr/bin/env bash
set -euo pipefail

# Build musl-fts (libfts.a + <fts.h>) for wasm32-posix-kernel with
# upstream's own autotools build: bootstrap.sh regenerates the build system
# from the git tag, exactly as Alpine's and Void's recipes do.
#
# Output: $WASM_POSIX_DEP_OUT_DIR/{lib/libfts.a,include/fts.h,
#         lib/pkgconfig/musl-fts.pc}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/musl-fts-src"
STAGE_DIR="$WORK_DIR/stage"
SYSROOT="$REPO_ROOT/sysroot"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/musl-fts-install}"
VERSION="${WASM_POSIX_DEP_VERSION:-1.2.7}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/void-linux/musl-fts/archive/refs/tags/v${VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-49ae567a96dbab22823d045ffebe0d6b14b9b799925e9ca9274d47d26ff482a6}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi
export WASM_POSIX_SYSROOT="$SYSROOT"

rm -rf "$SRC_DIR" "$STAGE_DIR"
echo "==> Staging verified musl-fts $VERSION source..."
kandelo_package_stage_verified_source musl-fts "$SRC_DIR" \
    "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
cd "$SRC_DIR"

echo "==> Bootstrapping and configuring musl-fts for wasm32..."
sh ./bootstrap.sh 2>&1 | tail -10
wasm32posix-configure --disable-shared --enable-static --prefix=/usr \
    CFLAGS="-O2" 2>&1 | tail -20

echo "==> Building musl-fts..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -20
make install DESTDIR="$STAGE_DIR" 2>&1 | tail -10

mkdir -p "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include"
cp "$STAGE_DIR/usr/lib/libfts.a" "$INSTALL_DIR/lib/"
cp "$STAGE_DIR/usr/include/fts.h" "$INSTALL_DIR/include/"
# Relocatable pkg-config metadata, as the other library packages write it.
cat >"$INSTALL_DIR/lib/pkgconfig/musl-fts.pc" <<PCEOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: musl-fts
Description: Implementation of fts(3) for musl libc
Version: $VERSION
Libs: -L\${libdir} -lfts
Cflags: -I\${includedir}
PCEOF
ls -lh "$INSTALL_DIR/lib/libfts.a"
echo "==> musl-fts build complete."
