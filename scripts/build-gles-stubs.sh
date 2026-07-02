#!/bin/bash
set -euo pipefail

# Compile libc/glue/libegl_stub.c + libc/glue/libglesv2_stub.c into
# sysroot/lib/{libEGL.a,libGLESv2.a}. Run after scripts/build-musl.sh
# has populated the sysroot with the Khronos headers from
# libc/musl-overlay/include/{EGL,GLES2,KHR}/. The two archives share session
# globals via accessor functions in libc/glue/gl_abi.h (libEGL defines them,
# libGLESv2 externs them) — splitting object sources here matches that
# split.

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

if [ ! -f "$SYSROOT/include/EGL/egl.h" ]; then
    echo "Error: $SYSROOT/include/EGL/egl.h missing." >&2
    echo "Run scripts/build-musl.sh first (step 9 installs overlay headers)." >&2
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

echo "Building libEGL.a (libegl_stub.c)..."
"$CC" "${CFLAGS[@]}" -c "$GLUE_DIR/libegl_stub.c" -o "$TMP/libegl_stub.o"
"$AR" rcs "$OUT_DIR/libEGL.a" "$TMP/libegl_stub.o"

echo "Building libGLESv2.a (libglesv2_stub.c)..."
"$CC" "${CFLAGS[@]}" -c "$GLUE_DIR/libglesv2_stub.c" -o "$TMP/libglesv2_stub.o"
"$AR" rcs "$OUT_DIR/libGLESv2.a" "$TMP/libglesv2_stub.o"

echo "GL stubs installed:"
ls -la "$OUT_DIR/libEGL.a" "$OUT_DIR/libGLESv2.a"

cat > "$PC_DIR/egl.pc" <<EOF
prefix=$SYSROOT
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: egl
Description: Kandelo wasm EGL userspace shim
Version: 1.0.0
Libs: -L\${libdir} -lEGL
Cflags: -I\${includedir}
EOF

cat > "$PC_DIR/glesv2.pc" <<EOF
prefix=$SYSROOT
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: glesv2
Description: Kandelo wasm GLESv2 userspace shim
Version: 1.0.0
Libs: -L\${libdir} -lGLESv2
Cflags: -I\${includedir}
EOF
