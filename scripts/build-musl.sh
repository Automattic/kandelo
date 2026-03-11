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
echo "==> Copying overlay files..."
rm -rf "$MUSL_DIR/arch/wasm32posix"
cp -r "$OVERLAY_DIR/arch/wasm32posix" "$MUSL_DIR/arch/"

# Copy source file overlays (e.g., Wasm-specific __libc_start_main.c)
if [ -d "$OVERLAY_DIR/src" ]; then
    cp -r "$OVERLAY_DIR/src/"* "$MUSL_DIR/src/"
fi

# Copy CRT overlay (e.g., Wasm-specific crt1.c with proper main signature)
if [ -d "$OVERLAY_DIR/crt" ]; then
    cp -r "$OVERLAY_DIR/crt/"* "$MUSL_DIR/crt/"
fi

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

# ---------------------------------------------------------------
# 6. Build __main_void wrapper and add to libc.a
# ---------------------------------------------------------------
echo "==> Building __main_void wrapper..."
"$CC" --target=wasm32-unknown-unknown -O2 -c \
    "$OVERLAY_DIR/src/env/__main_void.c" \
    -o "$SYSROOT/lib/__main_void.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/__main_void.o"

# ---------------------------------------------------------------
# 7. Build setjmp runtime (requires -fwasm-exceptions for __builtin_wasm_throw)
# ---------------------------------------------------------------
echo "==> Building setjmp runtime..."
"$CC" --target=wasm32-unknown-unknown -O2 \
    -fwasm-exceptions -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -c "$OVERLAY_DIR/src/setjmp/wasm32/rt.c" \
    -o "$SYSROOT/lib/wasm_setjmp_rt.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/wasm_setjmp_rt.o"

# ---------------------------------------------------------------
# 8. Build sigsetjmp helpers and add to libc.a
# ---------------------------------------------------------------
echo "==> Building sigsetjmp helpers..."
"$CC" --target=wasm32-unknown-unknown -O2 \
    -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -c "$OVERLAY_DIR/src/signal/wasm32posix/sigsetjmp.c" \
    -o "$SYSROOT/lib/sigsetjmp_helpers.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/sigsetjmp_helpers.o"

# ---------------------------------------------------------------
# 9. Install override headers
# ---------------------------------------------------------------
echo "==> Installing override headers..."
if [ -d "$OVERLAY_DIR/include" ]; then
    cp "$OVERLAY_DIR/include/"*.h "$SYSROOT/include/" 2>/dev/null || true
fi

echo ""
echo "==> musl build complete!"
echo "    Sysroot: $SYSROOT"
echo "    libc.a:  $SYSROOT/lib/libc.a"
ls -la "$SYSROOT/lib/libc.a" 2>/dev/null || echo "    WARNING: libc.a not found!"
