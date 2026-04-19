#!/usr/bin/env bash
set -euo pipefail

LIBPNG_VERSION="${LIBPNG_VERSION:-1.6.43}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/libpng-src"
BUILD_DIR="$SCRIPT_DIR/libpng-build"
INSTALL_DIR="$SCRIPT_DIR/libpng-install"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# Ensure zlib is in sysroot
if [ ! -f "$SYSROOT/lib/libz.a" ]; then
    echo "ERROR: zlib not found in sysroot. Build zlib first." >&2
    exit 1
fi

# Download
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libpng $LIBPNG_VERSION..."
    TARBALL="libpng-${LIBPNG_VERSION}.tar.xz"
    curl -fsSL "https://download.sourceforge.net/libpng/${TARBALL}" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

# Build
echo "==> Building libpng for wasm32..."
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

CFLAGS="-O2" \
ac_cv_func_feenableexcept=no \
"$SRC_DIR/configure" \
    --host=wasm32-unknown-none \
    --prefix="$INSTALL_DIR" \
    --enable-static \
    --disable-shared \
    --with-zlib-prefix="$SYSROOT" \
    CC=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    CPPFLAGS="-I$SYSROOT/include" \
    LDFLAGS="-L$SYSROOT/lib"

make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
make install

cd "$REPO_ROOT"

if [ -f "$INSTALL_DIR/lib/libpng.a" ] || [ -f "$INSTALL_DIR/lib/libpng16.a" ]; then
    echo "==> libpng build complete!"
    ls -lh "$INSTALL_DIR/lib/"libpng*.a
else
    echo "ERROR: Build failed — library not found" >&2
    exit 1
fi
