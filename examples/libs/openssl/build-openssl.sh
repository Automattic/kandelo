#!/usr/bin/env bash
#
# Build OpenSSL static libs (libssl.a, libcrypto.a) for
# wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/dependency-management.md). Falls back to the in-tree
# openssl-install/ layout when invoked without resolver env vars.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/openssl-src"

# --- Resolver contract (with legacy fallbacks) ---
OPENSSL_VERSION="${WASM_POSIX_DEP_VERSION:-${OPENSSL_VERSION:-3.3.2}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/openssl-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading OpenSSL $OPENSSL_VERSION..."
    TARBALL="openssl-${OPENSSL_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "/tmp/${TARBALL}"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  /tmp/${TARBALL}" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

cd "$SRC_DIR"

# Clean previous build so a cache-miss rebuild starts from scratch.
if [ -f Makefile ]; then
    make clean 2>/dev/null || true
fi
rm -rf "$INSTALL_DIR"

# Configure for Wasm using linux-generic32 target.
echo "==> Configuring OpenSSL for Wasm..."
CC=wasm32posix-cc \
AR=wasm32posix-ar \
RANLIB=wasm32posix-ranlib \
perl Configure linux-generic32 \
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
    --prefix="$INSTALL_DIR" \
    --openssldir=/etc/ssl

# Patch Makefile: remove cross-compile prefix + the -m32 that
# linux-generic32 assumes.
echo "==> Patching Makefile..."
sed -i.bak 's/^CROSS_COMPILE=.*/CROSS_COMPILE=/' Makefile
sed -i.bak 's/ -m32 / /g' Makefile
sed -i.bak 's/ -m32$//' Makefile
rm -f Makefile.bak

echo "==> Building OpenSSL..."
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" build_generated libssl.a libcrypto.a

echo "==> Installing..."
make install_sw 2>/dev/null || true

# OpenSSL installs into lib/ on 32-bit targets and lib64/ on some
# 64-bit Linux hosts. The resolver contract pins outputs under lib/,
# so if install landed in lib64/ we merge it across.
if [ -d "$INSTALL_DIR/lib64" ] && [ ! -d "$INSTALL_DIR/lib" ]; then
    mv "$INSTALL_DIR/lib64" "$INSTALL_DIR/lib"
elif [ -d "$INSTALL_DIR/lib64" ]; then
    # Both exist — splice lib64's contents into lib/.
    cp -a "$INSTALL_DIR/lib64/." "$INSTALL_DIR/lib/"
    rm -rf "$INSTALL_DIR/lib64"
fi

if [ -f "$INSTALL_DIR/lib/libssl.a" ] && [ -f "$INSTALL_DIR/lib/libcrypto.a" ]; then
    echo "==> OpenSSL build complete!"
    echo "    Headers:   $INSTALL_DIR/include/openssl/"
    echo "    libssl:    $INSTALL_DIR/lib/libssl.a"
    echo "    libcrypto: $INSTALL_DIR/lib/libcrypto.a"
    ls -lh "$INSTALL_DIR/lib/libssl.a" "$INSTALL_DIR/lib/libcrypto.a"
else
    echo "ERROR: Build failed — libraries not found at expected paths" >&2
    find "$INSTALL_DIR" -name "*.a" 2>/dev/null || true
    exit 1
fi
