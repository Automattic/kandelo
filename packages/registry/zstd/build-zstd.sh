#!/usr/bin/env bash
set -euo pipefail

# Build Zstandard for wasm32-posix-kernel.
#
# Plain Makefile build with CC/AR/RANLIB overrides.
# HAVE_THREAD=0 is critical (no pthreads support).
# Output: packages/registry/zstd/bin/zstd.wasm

ZSTD_VERSION="${ZSTD_VERSION:-${WASM_POSIX_DEP_VERSION:-1.5.6}}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-$WORK_DIR/zstd-src}"
BIN_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/bin}"
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
    URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/${TARBALL}}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "/tmp/$TARBALL"
    if [ -n "${WASM_POSIX_DEP_SOURCE_SHA256:-}" ]; then
        actual_sha256="$(shasum -a 256 "/tmp/$TARBALL" | awk '{print $1}')"
        if [ "$actual_sha256" != "$WASM_POSIX_DEP_SOURCE_SHA256" ]; then
            echo "ERROR: checksum mismatch for $URL" >&2
            echo "expected: $WASM_POSIX_DEP_SOURCE_SHA256" >&2
            echo "actual:   $actual_sha256" >&2
            exit 1
        fi
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# Upstream programs/util.h declares UTIL_isConsole(FILE*) but does not include
# stdio.h itself. Some host libc/header combinations pull FILE in indirectly;
# the wasm sysroot does not, so patch the package source explicitly.
if ! grep -q '#include <stdio.h>' programs/util.h; then
    sed -i.bak '/#include <stddef.h>/a\
#include <stdio.h>       /* FILE */' programs/util.h
fi

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
install_local_binary zstd "$BIN_DIR/zstd.wasm"
