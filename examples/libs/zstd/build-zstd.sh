#!/usr/bin/env bash
set -euo pipefail

# Build Zstandard 1.5.7 for wasm32-posix-kernel.
#
# Plain Makefile build with CC/AR/RANLIB overrides.
# HAVE_THREAD=0 is critical (no pthreads support).
# Output: examples/libs/zstd/bin/zstd.wasm

ZSTD_VERSION="${ZSTD_VERSION:-1.5.7}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/zstd-src"
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

# --- Download zstd source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading zstd $ZSTD_VERSION..."
    TARBALL="zstd-${ZSTD_VERSION}.tar.gz"
    URL="https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Build ---
echo "==> Building zstd..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    -C programs \
    CC=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    HAVE_THREAD=0 \
    HAVE_ZLIB=0 \
    HAVE_LZMA=0 \
    HAVE_LZ4=0 \
    ZSTD_LEGACY_SUPPORT=0 \
    2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/programs/zstd" ]; then
    cp "$SRC_DIR/programs/zstd" "$BIN_DIR/zstd.wasm"
    echo "==> Built zstd"
    ls -lh "$BIN_DIR/zstd.wasm"
else
    echo "ERROR: zstd binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> zstd built successfully!"
echo "Binary: $BIN_DIR/zstd.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary zstd "$SCRIPT_DIR/bin/zstd.wasm"
