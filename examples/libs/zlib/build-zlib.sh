#!/usr/bin/env bash
set -euo pipefail

ZLIB_VERSION="${ZLIB_VERSION:-1.3.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/zlib-src"
INSTALL_DIR="$SCRIPT_DIR/zlib-install"

if ! command -v wasm64posix-cc &>/dev/null; then
    echo "ERROR: wasm64posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading zlib $ZLIB_VERSION..."
    TARBALL="zlib-${ZLIB_VERSION}.tar.gz"
    curl -fsSL "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/$TARBALL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
fi

cd "$SRC_DIR"

echo "==> Configuring zlib for Wasm..."
CC=wasm64posix-cc AR=wasm64posix-ar RANLIB=wasm64posix-ranlib \
    LDSHARED="wasm64posix-cc -shared" \
    ./configure --static --prefix="$INSTALL_DIR"

# On macOS, zlib's configure uses 'libtool' which is the Xcode one — not wasm-aware.
# Patch the Makefile to use wasm64posix-ar instead.
echo "==> Patching Makefile for Wasm ar..."
sed -i.bak \
    -e 's|^AR=.*|AR=wasm64posix-ar|' \
    -e 's|^ARFLAGS=.*|ARFLAGS=rcs|' \
    -e 's|^RANLIB=.*|RANLIB=wasm64posix-ranlib|' \
    -e 's|libtool -o|wasm64posix-ar rcs|g' \
    Makefile && rm -f Makefile.bak

echo "==> Building zlib..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" libz.a

echo "==> Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
make install

if [ -f "$INSTALL_DIR/lib/libz.a" ]; then
    echo "==> zlib build complete!"
    ls -lh "$INSTALL_DIR/lib/libz.a"
else
    echo "ERROR: Build failed — library not found" >&2
    exit 1
fi
