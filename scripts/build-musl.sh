#!/bin/bash
set -euo pipefail

# Build musl libc as a static library targeting wasm32 or wasm64.
#
# Usage:
#   scripts/build-musl.sh              # build wasm32posix (default)
#   scripts/build-musl.sh --arch wasm64posix   # build wasm64posix
#
# Approach:
#   1. Copy overlay files from musl-overlay/ into musl/arch/<ARCH>/
#   2. Write config.mak directly (bypassing configure which doesn't know our arch)
#   3. Run make to build libc.a and CRT objects
#   4. Install headers + libs into sysroot/

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUSL_DIR="$REPO_ROOT/musl"
OVERLAY_DIR="$REPO_ROOT/musl-overlay"

# Parse arguments
ARCH="wasm32posix"
while [ $# -gt 0 ]; do
    case "$1" in
        --arch) ARCH="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

case "$ARCH" in
    wasm32posix)
        TARGET="wasm32-unknown-unknown"
        SYSROOT="$REPO_ROOT/sysroot"
        SETJMP_DIR="wasm32"
        SIGSETJMP_DIR="wasm32posix"
        ;;
    wasm64posix)
        TARGET="wasm64-unknown-unknown"
        SYSROOT="$REPO_ROOT/sysroot64"
        SETJMP_DIR="wasm32"  # TODO: may need wasm64 variant
        SIGSETJMP_DIR="wasm32posix"  # Same signal implementation
        ;;
    *)
        echo "Error: unsupported arch '$ARCH'. Use wasm32posix or wasm64posix." >&2
        exit 1
        ;;
esac

# Use Homebrew LLVM 21 toolchain (override via LLVM_BIN env)
LLVM_BIN="${LLVM_BIN:-/opt/homebrew/opt/llvm/bin}"
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
echo "==> Copying overlay files for $ARCH..."
rm -rf "$MUSL_DIR/arch/$ARCH"
cp -r "$OVERLAY_DIR/arch/$ARCH" "$MUSL_DIR/arch/"

# Copy source file overlays (e.g., Wasm-specific __libc_start_main.c)
# First, clean arch-specific dirs in musl tree to remove stale overlay files
if [ -d "$OVERLAY_DIR/src" ]; then
    find "$OVERLAY_DIR/src" -type d -name wasm32posix | while read dir; do
        rel="${dir#$OVERLAY_DIR/src/}"
        rm -rf "$MUSL_DIR/src/$rel"
    done
    cp -r "$OVERLAY_DIR/src/"* "$MUSL_DIR/src/"

    # For wasm64posix: copy wasm32posix source overrides as wasm64posix
    # (same source code, just different arch dir name for musl's build system)
    if [ "$ARCH" = "wasm64posix" ]; then
        find "$OVERLAY_DIR/src" -type d -name wasm32posix | while read dir; do
            rel="${dir#$OVERLAY_DIR/src/}"
            parent="$(dirname "$rel")"
            rm -rf "$MUSL_DIR/src/$parent/wasm64posix"
            cp -r "$dir" "$MUSL_DIR/src/$parent/wasm64posix"
        done
    fi
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
ARCH = $ARCH
srcdir = .
prefix = $SYSROOT
CC = $CC --target=$TARGET
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
"$CC" --target=$TARGET -O2 -c \
    "$OVERLAY_DIR/src/env/__main_void.c" \
    -o "$SYSROOT/lib/__main_void.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/__main_void.o"

# ---------------------------------------------------------------
# 7. Build setjmp runtime (requires -fwasm-exceptions for __builtin_wasm_throw)
# ---------------------------------------------------------------
echo "==> Building setjmp runtime..."
"$CC" --target=$TARGET -O2 \
    -fwasm-exceptions -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -c "$OVERLAY_DIR/src/setjmp/$SETJMP_DIR/rt.c" \
    -o "$SYSROOT/lib/wasm_setjmp_rt.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/wasm_setjmp_rt.o"

# ---------------------------------------------------------------
# 8. Build sigsetjmp helpers and add to libc.a
# ---------------------------------------------------------------
echo "==> Building sigsetjmp helpers..."
"$CC" --target=$TARGET -O2 \
    -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -c "$OVERLAY_DIR/src/signal/$SIGSETJMP_DIR/sigsetjmp.c" \
    -o "$SYSROOT/lib/sigsetjmp_helpers.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/sigsetjmp_helpers.o"

# ---------------------------------------------------------------
# 9. Install override headers
# ---------------------------------------------------------------
echo "==> Installing override headers..."
bash "$REPO_ROOT/scripts/install-overlay-headers.sh" "$SYSROOT"

echo ""
echo "==> musl build complete!"
echo "    Sysroot: $SYSROOT"
echo "    libc.a:  $SYSROOT/lib/libc.a"
ls -la "$SYSROOT/lib/libc.a" 2>/dev/null || echo "    WARNING: libc.a not found!"
