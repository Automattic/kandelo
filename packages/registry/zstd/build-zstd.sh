#!/usr/bin/env bash
set -euo pipefail

# Build Zstandard 1.5.7 for wasm32-posix-kernel.
#
# Plain Makefile build with CC/AR/RANLIB overrides.
# HAVE_THREAD=0 is critical (no pthreads support).
# Output: <work root>/bin/zstd.wasm (see the work-root note below)

ZSTD_VERSION="${ZSTD_VERSION:-1.5.7}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# Build under the package work root: the resolver's fresh
# WASM_POSIX_DEP_WORK_DIR, or this directory for a direct invocation. The
# resolver reruns this script only when the package's cache key changed (an
# ABI bump, a toolchain change). A tree kept in the package directory still
# held the previous build's objects, which make treated as up to date, so the
# rebuild shipped stale code (bzip2 kept declaring the old ABI version).
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/zstd-src"
BIN_DIR="$WORK_DIR/bin"
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
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "$WORK_DIR/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "$WORK_DIR/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$WORK_DIR/$TARBALL"
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
install_local_binary zstd "$BIN_DIR/zstd.wasm"
