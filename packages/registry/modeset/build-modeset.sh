#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-$HERE}"
OUT="$OUT_DIR/modeset.wasm"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

if [ ! -f "$WASM_POSIX_SYSROOT/lib/libdrm.a" ] ||
   [ ! -f "$WASM_POSIX_SYSROOT/lib/libgbm.a" ] ||
   [ ! -f "$WASM_POSIX_SYSROOT/lib/libEGL.a" ] ||
   [ ! -f "$WASM_POSIX_SYSROOT/lib/libGLESv2.a" ]; then
    echo "ERROR: DRI/EGL/GLES sysroot libraries are missing." >&2
    echo "Run: scripts/dev-shell.sh bash scripts/build-musl.sh" >&2
    exit 1
fi

PKG_CFLAGS="$(wasm32posix-pkg-config --cflags libdrm gbm egl glesv2)"
PKG_LIBS="$(wasm32posix-pkg-config --libs gbm libdrm egl glesv2)"

echo "==> Building modeset fluid simulation..."
mkdir -p "$OUT_DIR"
wasm32posix-cc \
    -std=c11 \
    -O2 \
    -Wall \
    -Wextra \
    -Wno-unused-parameter \
    -D_DEFAULT_SOURCE \
    $PKG_CFLAGS \
    "$REPO_ROOT/programs/modeset.c" \
    $PKG_LIBS \
    -lm \
    -o "$OUT"

"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$OUT" \
    -o "$OUT.instr"
mv "$OUT.instr" "$OUT"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary modeset "$OUT" modeset.wasm
