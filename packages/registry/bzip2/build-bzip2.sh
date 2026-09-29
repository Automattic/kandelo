#!/usr/bin/env bash
set -euo pipefail

# Build bzip2 1.0.8 for wasm32-posix-kernel.
#
# Plain Makefile build with CC/AR/RANLIB overrides.
# Output: <work root>/bin/bzip2.wasm (see the work-root note below)
# Also installs libbz2.a + bzlib.h to sysroot.

BZIP2_VERSION="${BZIP2_VERSION:-1.0.8}"
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
SRC_DIR="$WORK_DIR/bzip2-src"
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

# --- Download bzip2 source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading bzip2 $BZIP2_VERSION..."
    TARBALL="bzip2-${BZIP2_VERSION}.tar.gz"
    URL="https://sourceware.org/pub/bzip2/${TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "$WORK_DIR/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "$WORK_DIR/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$WORK_DIR/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Build ---
echo "==> Building bzip2..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    CC=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    CFLAGS="-Wall -Winline -O2 -D_FILE_OFFSET_BITS=64" \
    LDFLAGS="" \
    bzip2 bzip2recover libbz2.a \
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

# --- Install library to sysroot for direct developer builds ---
if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    echo "==> Installing libbz2.a and bzlib.h to sysroot..."
    cp "$SRC_DIR/libbz2.a" "$SYSROOT/lib/"
    cp "$SRC_DIR/bzlib.h" "$SYSROOT/include/"
    echo "==> Installed libbz2.a and bzlib.h"
else
    echo "==> Skipping legacy shared-sysroot library install for resolver build."
fi

echo ""
echo "==> bzip2 built successfully!"
echo "Binary: $BIN_DIR/bzip2.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary bzip2 "$BIN_DIR/bzip2.wasm"
