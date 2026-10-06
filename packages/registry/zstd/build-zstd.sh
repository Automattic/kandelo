#!/usr/bin/env bash
set -euo pipefail

# Build Zstandard 1.5.7 for wasm32-posix-kernel.
#
# Plain Makefile build with CC/AR/RANLIB overrides.
# HAVE_THREAD=0 is critical (no pthreads support).
# Output: bin/zstd.wasm under the resolver work root (beside this
# script when run standalone).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
ZSTD_VERSION="$WASM_POSIX_DEP_VERSION"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/zstd-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

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
kandelo_package_stage_primary_source zstd "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"

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
