#!/usr/bin/env bash
# Build upstream SDL2_ttf statically with resolver-owned dependencies.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
source "$REPO_ROOT/sdk/activate.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OUT="${WASM_POSIX_DEP_OUT_DIR:?resolve sdl2-ttf through the package resolver}"
SRC="$WORK/source"
kandelo_package_stage_verified_source sdl2-ttf "$SRC" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK"

export PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?missing dependency closure}"
export PKG_CONFIG=wasm32posix-pkg-config
export CPPFLAGS="" LDFLAGS=""
for dep in SDL2 LIBWAYLAND LIBXKBCOMMON LIBFFI FREETYPE ZLIB; do
    key="WASM_POSIX_DEP_${dep}_DIR"
    prefix="${!key:?missing declared dependency}"
    CPPFLAGS+=" -I$prefix/include"
    LDFLAGS+=" -L$prefix/lib"
done
# Link checks need SDL's complete static closure, rather than a host SDL.
export SDL_CFLAGS="$(wasm32posix-pkg-config --cflags sdl2)"
export SDL_LIBS="$(wasm32posix-pkg-config --static --libs sdl2)"
export LIBS="$SDL_LIBS"
cd "$SRC"
wasm32posix-configure --prefix="$OUT" \
    --enable-static --disable-shared --disable-sdltest \
    --disable-freetype-builtin --disable-harfbuzz --disable-harfbuzz-builtin
make -j"${WASM_POSIX_BUILD_JOBS:-8}"
make install
