#!/bin/bash
set -euo pipefail

# Build musl libc as a static library targeting wasm32.
#
# Approach:
#   1. Copy overlay files from musl-overlay/ into musl/arch/wasm32posix/
#   2. Write config.mak directly (bypassing configure which doesn't know wasm32posix)
#   3. Run make to build libc.a and CRT objects
#   4. Install headers + libs into sysroot/

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUSL_DIR="$REPO_ROOT/musl"
OVERLAY_DIR="$REPO_ROOT/musl-overlay"
SYSROOT="$REPO_ROOT/sysroot"

# Use Homebrew LLVM 21 toolchain
LLVM_BIN="/opt/homebrew/opt/llvm/bin"
CC="$LLVM_BIN/clang"
AR="$LLVM_BIN/llvm-ar"
RANLIB="$LLVM_BIN/llvm-ranlib"

# Verify toolchain exists
for tool in "$CC" "$AR" "$RANLIB"; do
    if [ ! -x "$tool" ]; then
        echo "Error: $tool not found. Install LLVM via: brew install llvm" >&2
        exit 1
    fi
done

# ---------------------------------------------------------------
# 1. Copy overlay files into musl source tree
# ---------------------------------------------------------------
echo "==> Copying arch overlay files..."
rm -rf "$MUSL_DIR/arch/wasm32posix"
cp -r "$OVERLAY_DIR/arch/wasm32posix" "$MUSL_DIR/arch/"

# ---------------------------------------------------------------
# 2. Write config.mak
# ---------------------------------------------------------------
echo "==> Writing config.mak..."
cat > "$MUSL_DIR/config.mak" << EOF
ARCH = wasm32posix
srcdir = .
prefix = $SYSROOT
CC = $CC --target=wasm32-unknown-unknown
AR = $AR
RANLIB = $RANLIB
CFLAGS = -O2 -matomics -mbulk-memory -fno-exceptions -fno-trapping-math
CFLAGS_AUTO =
LDFLAGS_AUTO =
LIBCC =
# We only want the static library, not shared or tools
SHARED_LIBS =
ALL_LIBS = \$(CRT_LIBS) \$(STATIC_LIBS) \$(EMPTY_LIBS)
ALL_TOOLS =
EOF

# ---------------------------------------------------------------
# 3. Clean previous build
# ---------------------------------------------------------------
echo "==> Cleaning previous build..."
cd "$MUSL_DIR"
make clean 2>/dev/null || true

# ---------------------------------------------------------------
# 4. Build musl
# ---------------------------------------------------------------
NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)

echo "==> Building musl (pass 1: discover failures)..."

# First, try a full build and capture failures
set +e
make -j"$NJOBS" 2>&1 | tee /tmp/musl-build.log
BUILD_RC=${PIPESTATUS[0]}
set -e

if [ $BUILD_RC -ne 0 ]; then
    echo ""
    echo "==> Build had errors. Analyzing failures..."
    # Extract failing source files from the log
    grep -oE 'obj/[^ ]+\.o' /tmp/musl-build.log | sort -u | head -40
    echo ""
    echo "==> See /tmp/musl-build.log for full output"
    exit 1
fi

# ---------------------------------------------------------------
# 5. Install to sysroot
# ---------------------------------------------------------------
echo "==> Installing to sysroot..."
rm -rf "$SYSROOT"
make install

echo ""
echo "==> musl build complete!"
echo "    Sysroot: $SYSROOT"
echo "    libc.a:  $SYSROOT/lib/libc.a"
ls -la "$SYSROOT/lib/libc.a" 2>/dev/null || echo "    WARNING: libc.a not found!"
