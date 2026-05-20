#!/usr/bin/env bash
#
# Build pixman (libpixman-1.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). The resolver sets:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to `make install`
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/pixman-src"
BUILD_DIR="$SCRIPT_DIR/pixman-build"

PIXMAN_VERSION="${WASM_POSIX_DEP_VERSION:-${PIXMAN_VERSION:-0.42.2}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pixman-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.x.org/releases/individual/lib/pixman-${PIXMAN_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if ! command -v wasm32posix-ar &>/dev/null; then
    echo "ERROR: wasm32posix-ar not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if ! command -v wasm32posix-ranlib &>/dev/null; then
    echo "ERROR: wasm32posix-ranlib not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading pixman $PIXMAN_VERSION..."
    TARBALL="/tmp/pixman-${PIXMAN_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

# autoconf bakes --prefix into generated Makefiles, so keep each build
# tied to the resolver-provided cache path by using a fresh build dir.
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring pixman for wasm32..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-dependency-tracking \
        --disable-openmp \
        --disable-gtk \
        --disable-libpng \
        --disable-loongson-mmi \
        --disable-mmx \
        --disable-sse2 \
        --disable-ssse3 \
        --disable-vmx \
        --disable-arm-simd \
        --disable-arm-neon \
        --disable-arm-a64-neon \
        --disable-arm-iwmmxt \
        --disable-mips-dspr2 \
        --disable-gcc-inline-asm \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        PKG_CONFIG=wasm32posix-pkg-config

    echo "==> Building pixman..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

rm -rf "$INSTALL_DIR/share"
rm -f "$INSTALL_DIR/lib/"*.la

if [ -f "$INSTALL_DIR/lib/libpixman-1.a" ]; then
    echo "==> pixman build complete!"
    ls -lh "$INSTALL_DIR/lib/libpixman-1.a"
else
    echo "ERROR: Build failed - library not found at $INSTALL_DIR/lib/libpixman-1.a" >&2
    exit 1
fi
