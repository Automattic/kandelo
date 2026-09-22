#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
SDL2_DEMO_DIR="$SOURCE_ROOT/programs/sdl2"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
OUT_BIN="$WORK_DIR/sdl2.wasm"

for f in main.c audio.c editor.c renderer.c sound_shader.c; do
    if [ ! -f "$SDL2_DEMO_DIR/$f" ] || [ -L "$SDL2_DEMO_DIR/$f" ]; then
        echo "ERROR: sdl2 source must be a regular file: $SDL2_DEMO_DIR/$f" >&2
        exit 1
    fi
done

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# The resolver builds the sdl2 library first (depends_on) and hands its
# staged prefix over; libgbm / libdrm / libEGL / libGLESv2 are sysroot
# libraries scripts/build-musl.sh installs.
SDL2_PREFIX="${WASM_POSIX_DEP_SDL2_DIR:?WASM_POSIX_DEP_SDL2_DIR must name the staged sdl2 prefix (resolve sdl2-demo through cargo xtask build-deps)}"

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

# renderer.c includes "third_party/inconsolata_ttf.h", generated from the
# checked-in .ttf. The checkout stays read-only, so the header lands in
# the work dir and -I"$WORK_DIR" resolves the quote-include.
echo "==> Generating inconsolata_ttf.h..."
mkdir -p "$WORK_DIR/third_party"
python3 - "$SDL2_DEMO_DIR/third_party/Inconsolata-Regular.ttf" \
    "$WORK_DIR/third_party/inconsolata_ttf.h" <<'PY'
import sys, pathlib
src = pathlib.Path(sys.argv[1]).read_bytes()
dst = pathlib.Path(sys.argv[2])
PER_LINE = 16
lines = [
    ",".join(f"0x{b:02x}" for b in src[i:i + PER_LINE])
    for i in range(0, len(src), PER_LINE)
]
dst.write_text(
    "/* Auto-generated from Inconsolata-Regular.ttf by "
    "build-sdl2-demo.sh. */\n"
    "/* See programs/sdl2/third_party/NOTICE.md for license. */\n"
    "#pragma once\n"
    f"static const unsigned char inconsolata_ttf[] = {{\n"
    + ",\n".join(lines) + "\n};\n"
    f"static const unsigned int inconsolata_ttf_len = {len(src)};\n"
)
PY

PKG_CFLAGS="$(wasm32posix-pkg-config --cflags gbm libdrm egl glesv2)"
PKG_LIBS="$(wasm32posix-pkg-config --libs gbm libdrm egl glesv2)"

echo "==> Building the SDL2 GLSL playground..."
wasm32posix-cc \
    -std=c11 \
    -O2 \
    -Wall \
    -Wextra \
    -Wno-unused-parameter \
    -D_DEFAULT_SOURCE \
    -I"$SDL2_PREFIX/include" \
    -I"$WORK_DIR" \
    $PKG_CFLAGS \
    "$SDL2_DEMO_DIR/main.c" \
    "$SDL2_DEMO_DIR/audio.c" \
    "$SDL2_DEMO_DIR/editor.c" \
    "$SDL2_DEMO_DIR/renderer.c" \
    "$SDL2_DEMO_DIR/sound_shader.c" \
    -L"$SDL2_PREFIX/lib" \
    -lSDL2 \
    $PKG_LIBS \
    -lm \
    -o "$OUT_BIN"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary sdl2-demo "$OUT_BIN" sdl2.wasm
