#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
MODESET_SOURCE="$SOURCE_ROOT/programs/modeset.c"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
OUT_BIN="$WORK_DIR/modeset.wasm"

if [ ! -f "$MODESET_SOURCE" ] || [ -L "$MODESET_SOURCE" ]; then
    echo "ERROR: modeset source must be a regular file: $MODESET_SOURCE" >&2
    exit 1
fi

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

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
    "$MODESET_SOURCE" \
    $PKG_LIBS \
    -lm \
    -o "$OUT_BIN"

"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$OUT_BIN" \
    -o "$OUT_BIN.instr"
mv "$OUT_BIN.instr" "$OUT_BIN"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary modeset "$OUT_BIN" modeset.wasm
