#!/usr/bin/env bash
# Build the upstream sample against the reusable SDL_mixer package.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
if [ "${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}" != wasm32 ]; then
    echo "ERROR: SDL_mixer playwave currently supports only wasm32" >&2
    exit 1
fi
kandelo_package_prepare_build_roots "$HERE" wasm32
source "$REPO_ROOT/sdk/activate.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OUT="${WASM_POSIX_DEP_OUT_DIR:?resolve playwave through the package resolver}"
SRC="$WORK/source"
kandelo_package_stage_verified_source sdl2-mixer-playwave "$SRC" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK"
export PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?missing dependency closure}"
flags=()
for dep in SDL2_MIXER SDL2 LIBWAYLAND LIBXKBCOMMON LIBFFI; do
    key="WASM_POSIX_DEP_${dep}_DIR"
    prefix="${!key:?missing declared dependency}"
    flags+=("-I$prefix/include" "-L$prefix/lib")
done
read -r -a mixer_flags <<< "$(wasm32posix-pkg-config --cflags --static --libs SDL2_mixer)"
wasm32posix-cc -O2 -DSDL_MAIN_HANDLED "${flags[@]}" \
    "$SRC/playwave.c" "${mixer_flags[@]}" -o "$WORK/playwave.wasm"
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$WORK/playwave.wasm" -o "$OUT/playwave.wasm"
