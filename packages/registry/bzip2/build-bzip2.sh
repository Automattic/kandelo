#!/usr/bin/env bash
set -euo pipefail

# Build bzip2 1.0.8 for wasm32-posix-kernel.
#
# Plain Makefile build with CC/AR/RANLIB overrides.
# Output: bin/bzip2.wasm under the declared recipe work root.
# Also installs libbz2.a + bzlib.h to sysroot.

BZIP2_VERSION="${WASM_POSIX_DEP_VERSION:-${BZIP2_VERSION:-1.0.8}}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
source "$REPO_ROOT/sdk/activate.sh"
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/bzip2-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
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

# Rebuild from the resolver's immutable verified input, never old ABI objects.
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://sourceware.org/pub/bzip2/bzip2-${BZIP2_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269}"
rm -rf "$SRC_DIR"
kandelo_package_stage_verified_source bzip2 "$SRC_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
    "$KANDELO_PACKAGE_WORK_DIR"

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
