#!/usr/bin/env bash
# Reusable SDL_mixer with its bundled WAVE, Vorbis, FLAC and MP3 decoders.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
if [ "${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}" != wasm32 ]; then
    echo "ERROR: SDL_mixer currently supports only wasm32" >&2
    exit 1
fi
kandelo_package_prepare_build_roots "$HERE" wasm32
source "$REPO_ROOT/sdk/activate.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OUT="${WASM_POSIX_DEP_OUT_DIR:?resolve sdl2-mixer through the package resolver}"
SRC="$WORK/source"
kandelo_package_stage_verified_source sdl2-mixer "$SRC" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK"

export PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?missing dependency closure}"
export PKG_CONFIG=wasm32posix-pkg-config
export CPPFLAGS="" LDFLAGS=""
for dep in SDL2 LIBWAYLAND LIBXKBCOMMON LIBFFI; do
    key="WASM_POSIX_DEP_${dep}_DIR"
    prefix="${!key:?missing declared dependency}"
    CPPFLAGS+=" -I$prefix/include"
    LDFLAGS+=" -L$prefix/lib"
done
export SDL_CFLAGS="$(wasm32posix-pkg-config --cflags sdl2)"
export SDL_LIBS="$(wasm32posix-pkg-config --static --libs sdl2)"
export LIBS="$SDL_LIBS"
cd "$SRC"
# Use the upstream bundled decoders. External codec libraries and helpers
# are separate dependencies, not host libraries to discover accidentally.
# A relative srcdir keeps upstream's filename filters independent of
# resolver/workspace directory names (notably "playwave.c").
wasm32posix-configure --srcdir=. --prefix="$OUT" \
    --enable-static --disable-shared --disable-sdltest \
    --disable-music-cmd --enable-music-wave \
    --disable-music-mod --disable-music-midi --disable-music-gme \
    --enable-music-ogg --enable-music-ogg-stb \
    --disable-music-ogg-vorbis --disable-music-ogg-tremor \
    --enable-music-flac --enable-music-flac-drflac --disable-music-flac-libflac \
    --enable-music-mp3 --enable-music-mp3-minimp3 --disable-music-mp3-mpg123 \
    --disable-music-opus --disable-music-wavpack
make -j"${WASM_POSIX_BUILD_JOBS:-8}"
make install
