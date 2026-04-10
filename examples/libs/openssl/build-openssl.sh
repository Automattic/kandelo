#!/usr/bin/env bash
set -euo pipefail

# OpenSSL version to build
OPENSSL_VERSION="${OPENSSL_VERSION:-3.3.2}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/openssl-src"
INSTALL_DIR="$SCRIPT_DIR/openssl-install"

# Verify SDK tools are available
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# Download OpenSSL if not present
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading OpenSSL $OPENSSL_VERSION..."
    TARBALL="openssl-${OPENSSL_VERSION}.tar.gz"
    curl -fsSL "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/${TARBALL}" \
        -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

cd "$SRC_DIR"

# Clean previous build
if [ -f Makefile ]; then
    make clean 2>/dev/null || true
fi

# Configure for Wasm using linux-generic32 target
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

# Patch Makefile: remove cross-compile settings that conflict
echo "==> Patching Makefile..."
sed -i.bak 's/^CROSS_COMPILE=.*/CROSS_COMPILE=/' Makefile
# Remove -m32 flag if present (linux-generic32 adds it)
sed -i.bak 's/ -m32 / /g' Makefile
sed -i.bak 's/ -m32$//' Makefile
rm -f Makefile.bak

# Build only the static libraries
echo "==> Building OpenSSL..."
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" build_generated libssl.a libcrypto.a 2>&1

# Install headers and libraries
echo "==> Installing..."
rm -rf "$INSTALL_DIR"
make install_sw 2>/dev/null || true

# Verify output — check both possible lib paths
LIBDIR=""
if [ -f "$INSTALL_DIR/lib/libssl.a" ]; then
    LIBDIR="$INSTALL_DIR/lib"
elif [ -f "$INSTALL_DIR/lib64/libssl.a" ]; then
    LIBDIR="$INSTALL_DIR/lib64"
fi

if [ -n "$LIBDIR" ] && [ -f "$LIBDIR/libssl.a" ] && [ -f "$LIBDIR/libcrypto.a" ]; then
    echo "==> OpenSSL build complete!"
    echo "    Headers:   $INSTALL_DIR/include/openssl/"
    echo "    libssl:    $LIBDIR/libssl.a"
    echo "    libcrypto: $LIBDIR/libcrypto.a"
    ls -lh "$LIBDIR/libssl.a" "$LIBDIR/libcrypto.a"
else
    echo "ERROR: Build failed — libraries not found" >&2
    echo "Checked: $INSTALL_DIR/lib/ and $INSTALL_DIR/lib64/" >&2
    find "$INSTALL_DIR" -name "*.a" 2>/dev/null || true
    exit 1
fi
