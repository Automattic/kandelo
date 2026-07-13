#!/usr/bin/env bash
# Build deterministic SDL2 and SDL3 /dev/dsp pacing fixtures.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?WASM_POSIX_DEP_OUT_DIR must name the resolver staging directory}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
SDL2_PREFIX="${WASM_POSIX_DEP_SDL2_DIR:?resolver did not provide the direct sdl2 dependency}"
SDL3_PREFIX="${WASM_POSIX_DEP_SDL3_DIR:?resolver did not provide the direct sdl3 dependency}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: SDL dsp fixtures currently support only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
CC=wasm32posix-cc
command -v "$CC" >/dev/null || {
    echo "ERROR: $CC not found after sourcing sdk/activate.sh" >&2
    exit 1
}

test -f "$SDL2_PREFIX/lib/libSDL2.a"
test -f "$SDL3_PREFIX/lib/libSDL3.a"
mkdir -p "$INSTALL_DIR"
REPRO_FLAGS=(
    "-ffile-prefix-map=$REPO_ROOT=/usr/src/kandelo"
    "-fdebug-prefix-map=$REPO_ROOT=/usr/src/kandelo"
    "-fmacro-prefix-map=$REPO_ROOT=/usr/src/kandelo"
)

echo "==> Building the SDL2 blocking-write pacing fixture..."
"$CC" -O2 "${REPRO_FLAGS[@]}" -DSDL_MAIN_HANDLED \
    -I"$SDL2_PREFIX/include/SDL2" \
    "$SCRIPT_DIR/src/sdl2-dsp-test.c" \
    "$SDL2_PREFIX/lib/libSDL2.a" -lm \
    -o "$INSTALL_DIR/sdl2-dsp-test.wasm"

echo "==> Building the SDL3 GETOSPACE pacing fixture..."
"$CC" -O2 "${REPRO_FLAGS[@]}" -DSDL_MAIN_HANDLED \
    -I"$SDL3_PREFIX/include" \
    "$SCRIPT_DIR/src/sdl3-dsp-test.c" \
    "$SDL3_PREFIX/lib/libSDL3.a" -lm \
    -o "$INSTALL_DIR/sdl3-dsp-test.wasm"

for output in sdl2-dsp-test.wasm sdl3-dsp-test.wasm; do
    "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
        "$INSTALL_DIR/$output" -o "$INSTALL_DIR/$output.instrumented"
    mv "$INSTALL_DIR/$output.instrumented" "$INSTALL_DIR/$output"
done

test -f "$INSTALL_DIR/sdl2-dsp-test.wasm"
test -f "$INSTALL_DIR/sdl3-dsp-test.wasm"
echo "==> SDL /dev/dsp fixtures complete"
