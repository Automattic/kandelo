#!/usr/bin/env bash
# Build zlib as an exact, relocatable resolver package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-zlib.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

ZLIB_VERSION="${WASM_POSIX_DEP_VERSION:-${ZLIB_VERSION:-1.3.1}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/zlib-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23}"
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

echo "==> Downloading zlib $ZLIB_VERSION..."
TARBALL="$WORK_DIR/zlib.tar.gz"
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "==> Verifying source sha256..."
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

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
rm -rf "$INSTALL_DIR"
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
