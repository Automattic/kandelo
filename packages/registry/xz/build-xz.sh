#!/usr/bin/env bash
set -euo pipefail

# Build XZ Utils 5.6.4 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# --disable-threads is critical (no pthreads support).
# Output: bin/xz.wasm under the resolver work root (beside this
# script when run standalone).
# Also installs liblzma.a + headers to sysroot.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
XZ_VERSION="$WASM_POSIX_DEP_VERSION"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/xz-src"
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

# --- Download xz source ---
kandelo_package_stage_primary_source xz "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"

sed -i.bak 's/!defined(__wasm__)/!defined(__wasm_no_signal__)/' "$SRC_DIR/src/common/mythread.h"

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring xz for wasm32..."

    # Cross-compilation values
    export ac_cv_func_closedir_void=no
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes

    # No Capsicum (FreeBSD sandbox) or pledge (OpenBSD)
    export ac_cv_header_sys_capsicum_h=no
    export ac_cv_func_cap_rights_limit=no

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4

    wasm32posix-configure \
        --disable-nls \
        --disable-threads \
        --disable-shared \
        --enable-static \
        --disable-doc \
        --disable-scripts \
        --disable-lzmadec \
        --disable-lzmainfo \
        --enable-sandbox=no \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building xz..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/src/xz/xz" ]; then
    cp "$SRC_DIR/src/xz/xz" "$BIN_DIR/xz.wasm"
    echo "==> Built xz"
    ls -lh "$BIN_DIR/xz.wasm"
else
    echo "ERROR: xz binary not found after build" >&2
    exit 1
fi

# --- Install library to sysroot for direct developer builds ---
if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    echo "==> Installing liblzma.a and headers to sysroot..."
    if [ -f "$SRC_DIR/src/liblzma/.libs/liblzma.a" ]; then
        cp "$SRC_DIR/src/liblzma/.libs/liblzma.a" "$SYSROOT/lib/"
        mkdir -p "$SYSROOT/include/lzma"
        cp "$SRC_DIR/src/liblzma/api/lzma.h" "$SYSROOT/include/"
        cp "$SRC_DIR/src/liblzma/api/lzma/"*.h "$SYSROOT/include/lzma/"
        echo "==> Installed liblzma.a and headers"
    fi
else
    echo "==> Skipping legacy shared-sysroot library install for resolver build."
fi

echo ""
echo "==> xz built successfully!"
echo "Binary: $BIN_DIR/xz.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary xz "$BIN_DIR/xz.wasm"
