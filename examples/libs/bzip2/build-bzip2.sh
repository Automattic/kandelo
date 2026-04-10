#!/usr/bin/env bash
set -euo pipefail

# Build bzip2 1.0.8 for wasm32-posix-kernel.
#
<<<<<<< HEAD
# Plain Makefile build with CC/AR/RANLIB overrides.
# Output: examples/libs/bzip2/bin/bzip2.wasm
# Also installs libbz2.a + bzlib.h to sysroot.
=======
# bzip2 uses a plain Makefile (no autotools), so we cross-compile by
# setting CC, AR, RANLIB directly.
# Output: examples/libs/bzip2/bin/bzip2.wasm
>>>>>>> 426ec1b (feat: add build scripts for 14 Unix utilities)

BZIP2_VERSION="${BZIP2_VERSION:-1.0.8}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/bzip2-src"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Download bzip2 source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading bzip2 $BZIP2_VERSION..."
    TARBALL="bzip2-${BZIP2_VERSION}.tar.gz"
    URL="https://sourceware.org/pub/bzip2/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Build ---
echo "==> Building bzip2..."
<<<<<<< HEAD
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    CC=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    CFLAGS="-Wall -Winline -O2 -D_FILE_OFFSET_BITS=64" \
    LDFLAGS="" \
    bzip2 bzip2recover libbz2.a \
=======

# Clean any previous build
make clean 2>/dev/null || true

# bzip2's Makefile uses CC, AR, RANLIB directly.
# We override LDFLAGS="" to prevent -s (strip) which wasm-ld doesn't support.
# CFLAGS: the Makefile appends its own -Wall -Winline etc, we just need
# to avoid native flags.
make \
    CC=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    LDFLAGS="" \
    CFLAGS="-O2 -D_FILE_OFFSET_BITS=64" \
    bzip2 \
>>>>>>> 426ec1b (feat: add build scripts for 14 Unix utilities)
    2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/bzip2" ]; then
    cp "$SRC_DIR/bzip2" "$BIN_DIR/bzip2.wasm"
    echo "==> Built bzip2"
    ls -lh "$BIN_DIR/bzip2.wasm"
else
    echo "ERROR: bzip2 binary not found after build" >&2
    exit 1
fi

<<<<<<< HEAD
# --- Install library to sysroot ---
echo "==> Installing libbz2.a and bzlib.h to sysroot..."
cp "$SRC_DIR/libbz2.a" "$SYSROOT/lib/"
cp "$SRC_DIR/bzlib.h" "$SYSROOT/include/"
echo "==> Installed libbz2.a and bzlib.h"

=======
>>>>>>> 426ec1b (feat: add build scripts for 14 Unix utilities)
echo ""
echo "==> bzip2 built successfully!"
echo "Binary: $BIN_DIR/bzip2.wasm"
