#!/usr/bin/env bash
# Build zlib as an exact, relocatable resolver package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
ZLIB_VERSION="$WASM_POSIX_DEP_VERSION"
WORK_DIR="$(kandelo_package_make_work_dir zlib)"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"

# shellcheck source=/dev/null

INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/zlib-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

case "$TARGET_ARCH" in
    wasm32)
        SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
        ;;
    wasm64)
        SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot64}"
        ;;
    *)
        echo "ERROR: zlib supports wasm32 and wasm64, got $TARGET_ARCH" >&2
        exit 1
        ;;
esac
export WASM_POSIX_SYSROOT="$SYSROOT"

CC="${TARGET_ARCH}posix-cc"
AR="${TARGET_ARCH}posix-ar"
RANLIB="${TARGET_ARCH}posix-ranlib"
for tool in "$CC" "$AR" "$RANLIB"; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: $tool not found after sourcing sdk/activate.sh" >&2
        exit 1
    }
done

kandelo_package_stage_primary_source zlib "$SRC_DIR" "$WORK_DIR"

cd "$SRC_DIR"
echo "==> Configuring zlib for $TARGET_ARCH..."
CC="$CC" AR="$AR" RANLIB="$RANLIB" \
    LDSHARED="$CC -shared" \
    ./configure --static --prefix=/usr

# On macOS zlib's configure may select Xcode libtool. Pin the SDK archiver.
sed -i.bak \
    -e "s|^AR=.*|AR=$AR|" \
    -e 's|^ARFLAGS=.*|ARFLAGS=rcs|' \
    -e "s|^RANLIB=.*|RANLIB=$RANLIB|" \
    -e "s|libtool -o|$AR rcs|g" \
    Makefile
rm -f Makefile.bak

echo "==> Building zlib..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" libz.a

echo "==> Staging declared package outputs..."
mkdir -p "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include"
cp libz.a "$INSTALL_DIR/lib/"
cp zlib.h zconf.h "$INSTALL_DIR/include/"
cat > "$INSTALL_DIR/lib/pkgconfig/zlib.pc" <<PCEOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
sharedlibdir=\${libdir}
includedir=\${prefix}/include

Name: zlib
Description: zlib compression library
Version: $ZLIB_VERSION
Requires:
Libs: -L\${libdir} -lz
Cflags: -I\${includedir}
PCEOF

test -f "$INSTALL_DIR/lib/libz.a"
echo "==> zlib build complete!"
ls -lh "$INSTALL_DIR/lib/libz.a"
