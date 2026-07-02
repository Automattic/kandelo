#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

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
    -o "$HERE/modeset.wasm"

"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$HERE/modeset.wasm" \
    -o "$HERE/modeset.wasm.instr"
mv "$HERE/modeset.wasm.instr" "$HERE/modeset.wasm"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary modeset "$HERE/modeset.wasm" modeset.wasm
