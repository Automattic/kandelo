#!/bin/bash
set -euo pipefail

# Compile libc/glue/libdrm_stub.c + libc/glue/libgbm_stub.c into
# sysroot/lib/{libdrm.a,libgbm.a}. Run after scripts/build-musl.sh
# has populated the sysroot with the DRI headers from
# libc/musl-overlay/include/{drm,gbm.h,xf86drm*.h}/.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/libc/glue"

# Auto-detect LLVM (matches scripts/build-programs.sh).
find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    local brew_prefix
    if brew_prefix=$(brew --prefix llvm 2>/dev/null) && [ -d "$brew_prefix/bin" ]; then
        echo "$brew_prefix/bin"; return
    fi
    for v in 21 20 19 18 17 16 15; do
        if [ -x "/usr/bin/clang-$v" ]; then echo "/usr/bin"; return; fi
    done
    if command -v clang >/dev/null 2>&1; then echo "$(dirname "$(command -v clang)")"; return; fi
    echo "Error: LLVM/clang not found. Set LLVM_BIN or install LLVM." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"
AR="$LLVM_BIN/llvm-ar"

if [ ! -f "$SYSROOT/include/xf86drm.h" ] || [ ! -f "$SYSROOT/include/gbm.h" ]; then
    echo "Error: DRI headers missing from $SYSROOT/include." >&2
    echo "Run scripts/build-musl.sh first (installs overlay headers)." >&2
    exit 1
fi

CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -I"$GLUE_DIR"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
)

OUT_DIR="$SYSROOT/lib"
PC_DIR="$OUT_DIR/pkgconfig"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT_DIR" "$PC_DIR"

echo "Building libdrm.a (libdrm_stub.c)..."
"$CC" "${CFLAGS[@]}" -c "$GLUE_DIR/libdrm_stub.c" -o "$TMP/libdrm_stub.o"
"$AR" rcs "$OUT_DIR/libdrm.a" "$TMP/libdrm_stub.o"

echo "Building libgbm.a (libgbm_stub.c)..."
"$CC" "${CFLAGS[@]}" -c "$GLUE_DIR/libgbm_stub.c" -o "$TMP/libgbm_stub.o"
"$AR" rcs "$OUT_DIR/libgbm.a" "$TMP/libgbm_stub.o"

echo "DRI stubs installed:"
ls -la "$OUT_DIR/libdrm.a" "$OUT_DIR/libgbm.a"

bash "$REPO_ROOT/scripts/write-graphics-pkgconfig.sh" dri "$PC_DIR"
