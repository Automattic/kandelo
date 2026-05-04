#!/usr/bin/env bash
set -euo pipefail

# Build XZ Utils 5.6.4 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# --disable-threads is critical (no pthreads support).
# Output: examples/libs/xz/bin/xz.wasm
# Also installs liblzma.a + headers to sysroot.

XZ_VERSION="${XZ_VERSION:-5.6.4}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/xz-src"
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

# --- Download xz source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading xz $XZ_VERSION..."
    TARBALL="xz-${XZ_VERSION}.tar.gz"
    URL="https://github.com/tukaani-project/xz/releases/download/v${XZ_VERSION}/${TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"

    # Patch: xz excludes __wasm__ from sigprocmask path, but our sysroot has it
    sed -i.bak 's/!defined(__wasm__)/!defined(__wasm_no_signal__)/' "$SRC_DIR/src/common/mythread.h"
    echo "==> Patched mythread.h for wasm signal support"
fi

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

# --- Install library to sysroot ---
echo "==> Installing liblzma.a and headers to sysroot..."
if [ -f "$SRC_DIR/src/liblzma/.libs/liblzma.a" ]; then
    cp "$SRC_DIR/src/liblzma/.libs/liblzma.a" "$SYSROOT/lib/"
    mkdir -p "$SYSROOT/include/lzma"
    cp "$SRC_DIR/src/liblzma/api/lzma.h" "$SYSROOT/include/"
    cp "$SRC_DIR/src/liblzma/api/lzma/"*.h "$SYSROOT/include/lzma/"
    echo "==> Installed liblzma.a and headers"
fi

echo ""
echo "==> xz built successfully!"
echo "Binary: $BIN_DIR/xz.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary xz "$SCRIPT_DIR/bin/xz.wasm"
