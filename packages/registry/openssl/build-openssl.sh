#!/usr/bin/env bash
# Build OpenSSL static libraries with stable guest paths and exact outputs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-openssl.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"
STAGE_DIR="$WORK_DIR/stage"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

OPENSSL_VERSION="${WASM_POSIX_DEP_VERSION:-${OPENSSL_VERSION:-3.3.2}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/openssl-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-2e8a40b01979afe8be0bbfb3de5dc1c6709fedb46d6c89c10da114ab5fc3d281}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

case "$TARGET_ARCH" in
    wasm32)
        CONFIGURE_TARGET=linux-generic32
        SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
        ;;
    wasm64)
        CONFIGURE_TARGET=linux-generic64
        SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot64}"
        ;;
    *)
        echo "ERROR: OpenSSL supports wasm32 and wasm64, got $TARGET_ARCH" >&2
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

echo "==> Downloading OpenSSL $OPENSSL_VERSION..."
TARBALL="$WORK_DIR/openssl.tar.gz"
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "==> Verifying source sha256..."
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"
echo "==> Configuring OpenSSL for $TARGET_ARCH..."
CC="$CC" AR="$AR" RANLIB="$RANLIB" \
CFLAGS="-O2" \
perl Configure "$CONFIGURE_TARGET" \
    -DHAVE_FORK=0 \
    -DOPENSSL_NO_AFALGENG=1 \
    -DOPENSSL_NO_UI_CONSOLE=1 \
    -DNO_SYSLOG=1 \
    no-asm \
    no-threads \
    no-dso \
    no-shared \
    no-async \
    no-engine \
    no-afalgeng \
    no-ui-console \
    no-tests \
    no-apps \
    no-autoerrinit \
    no-posix-io \
    --prefix=/usr \
    --openssldir=/etc/ssl \
    --libdir=lib

# linux-generic targets assume a native compiler driver. Keep their integer
# model but remove host-only compiler switches and any cross prefix.
sed -i.bak \
    -e 's/^CROSS_COMPILE=.*/CROSS_COMPILE=/' \
    -e 's/ -m32 / /g' \
    -e 's/ -m32$//' \
    -e 's/ -m64 / /g' \
    -e 's/ -m64$//' \
    Makefile
rm -f Makefile.bak

echo "==> Building OpenSSL..."
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" build_generated libssl.a libcrypto.a

echo "==> Staging OpenSSL development files..."
make install_dev DESTDIR="$STAGE_DIR"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include"
cp "$STAGE_DIR/usr/lib/libssl.a" "$INSTALL_DIR/lib/"
cp "$STAGE_DIR/usr/lib/libcrypto.a" "$INSTALL_DIR/lib/"
cp -R "$STAGE_DIR/usr/include/openssl" "$INSTALL_DIR/include/"

cat > "$INSTALL_DIR/lib/pkgconfig/libcrypto.pc" <<PCEOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: OpenSSL-libcrypto
Description: OpenSSL cryptography library
Version: $OPENSSL_VERSION
Libs: -L\${libdir} -lcrypto
Cflags: -I\${includedir}
PCEOF

cat > "$INSTALL_DIR/lib/pkgconfig/libssl.pc" <<PCEOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: OpenSSL-libssl
Description: Secure Sockets Layer and cryptography libraries
Version: $OPENSSL_VERSION
Requires.private: libcrypto
Libs: -L\${libdir} -lssl
Cflags: -I\${includedir}
PCEOF

cat > "$INSTALL_DIR/lib/pkgconfig/openssl.pc" <<PCEOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: OpenSSL
Description: Secure Sockets Layer and cryptography libraries and tools
Version: $OPENSSL_VERSION
Requires: libssl libcrypto
PCEOF

test -f "$INSTALL_DIR/lib/libssl.a"
test -f "$INSTALL_DIR/lib/libcrypto.a"
echo "==> OpenSSL build complete!"
ls -lh "$INSTALL_DIR/lib/libssl.a" "$INSTALL_DIR/lib/libcrypto.a"
