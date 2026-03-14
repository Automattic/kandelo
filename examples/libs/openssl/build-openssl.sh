#!/usr/bin/env bash
set -euo pipefail

OPENSSL_VERSION="${OPENSSL_VERSION:-3.3.2}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/openssl-src"
INSTALL_DIR="$SCRIPT_DIR/openssl-install"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading OpenSSL $OPENSSL_VERSION..."
    TARBALL="openssl-${OPENSSL_VERSION}.tar.gz"
    curl -fsSL "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/${TARBALL}" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

cd "$SRC_DIR"

if [ -f Makefile ]; then
    make clean 2>/dev/null || true
fi

echo "==> Configuring OpenSSL for Wasm..."
CC=wasm32posix-cc AR=wasm32posix-ar RANLIB=wasm32posix-ranlib \
perl Configure linux-generic32 \
    -DHAVE_FORK=0 \
    -DOPENSSL_NO_AFALGENG=1 \
    -DOPENSSL_NO_UI_CONSOLE=1 \
    no-asm no-threads no-dso no-shared no-async \
    no-engine no-afalgeng no-ui-console \
    no-tests no-apps \
    --prefix="$INSTALL_DIR"

echo "==> Patching Makefile..."
sed -i.bak 's/^CROSS_COMPILE=.*/CROSS_COMPILE=/' Makefile && rm -f Makefile.bak

echo "==> Building OpenSSL..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" build_generated libssl.a libcrypto.a

rm -rf "$INSTALL_DIR"
make install_sw 2>/dev/null || true

if [ -f "$INSTALL_DIR/lib/libssl.a" ] && [ -f "$INSTALL_DIR/lib/libcrypto.a" ]; then
    echo "==> OpenSSL build complete!"
    ls -lh "$INSTALL_DIR/lib/libssl.a" "$INSTALL_DIR/lib/libcrypto.a"
else
    echo "ERROR: Build failed — libraries not found" >&2
    exit 1
fi
