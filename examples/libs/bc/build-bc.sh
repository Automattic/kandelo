#!/usr/bin/env bash
set -euo pipefail

# Build GNU bc 1.07.1 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Output: examples/libs/bc/bin/bc.wasm
#
# bc needs a host-native build first: during compilation, it builds 'fbc'
# (a temporary bc binary) to process libmath.b into libmath.h. Since fbc
# must run on the host, we do a native build first to generate libmath.h,
# then cross-compile with that pre-generated file.

BC_VERSION="${BC_VERSION:-1.07.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/bc-src"
HOST_BUILD_DIR="$SCRIPT_DIR/bc-host-build"
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

if ! command -v flex &>/dev/null; then
    echo "ERROR: flex not found. Install with: brew install flex" >&2
    exit 1
fi

if ! command -v yacc &>/dev/null && ! command -v bison &>/dev/null; then
    echo "ERROR: yacc/bison not found. Install with: brew install bison" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Download bc source ---
download_bc() {
    local dest="$1"
    echo "==> Downloading bc $BC_VERSION to $dest..."
    TARBALL="bc-${BC_VERSION}.tar.gz"
    URL="https://ftp.gnu.org/gnu/bc/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$dest"
    tar xzf "/tmp/$TARBALL" -C "$dest" --strip-components=1
    rm "/tmp/$TARBALL"
}

if [ ! -d "$SRC_DIR" ]; then
    download_bc "$SRC_DIR"
fi

# --- Step 1: Host-native build to generate libmath.h ---
if [ ! -f "$SCRIPT_DIR/libmath.h" ]; then
    echo "==> Building host-native bc to generate libmath.h..."
    if [ ! -d "$HOST_BUILD_DIR" ]; then
        download_bc "$HOST_BUILD_DIR"
    fi
    cd "$HOST_BUILD_DIR"
    if [ ! -f Makefile ]; then
        ./configure --with-readline=no 2>&1 | tail -10
    fi
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -10
    cp "$HOST_BUILD_DIR/bc/libmath.h" "$SCRIPT_DIR/libmath.h"
    echo "==> libmath.h generated"
fi

# --- Step 2: Cross-compile for wasm32 ---
cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring bc for wasm32..."

    # Cross-compilation values
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes
    export ac_cv_func_strerror_r=yes
    export ac_cv_func_strerror_r_char_p=no
    export ac_cv_have_decl_strerror_r=yes

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4

    wasm32posix-configure \
        --with-readline=no \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# Place libmath.h from host build.
cp "$SCRIPT_DIR/libmath.h" "$SRC_DIR/bc/libmath.h"

# Patch the Makefile to skip fbc/libmath.h regeneration.
# The Makefile rule rebuilds libmath.h via fbc (a host-native binary) from
# libmath.b. Since fbc is cross-compiled to wasm and can't run on the host,
# we replace the rule with a no-op that uses our pre-generated libmath.h.
sed -i.bak '/^libmath\.h:/,/rm -f \.\/fbc/c\
libmath.h: libmath.b\
	@echo "Using pre-generated libmath.h (cross-compilation)"' "$SRC_DIR/bc/Makefile"

# --- Build ---
echo "==> Building bc..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/bc/bc" ]; then
    cp "$SRC_DIR/bc/bc" "$BIN_DIR/bc.wasm"
    echo "==> Built bc"
    ls -lh "$BIN_DIR/bc.wasm"
else
    echo "ERROR: bc binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> bc built successfully!"
echo "Binary: $BIN_DIR/bc.wasm"
