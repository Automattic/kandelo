#!/usr/bin/env bash
# Build upstream SDL_mixer's unmodified playwave sample against Kandelo SDL2.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
MIXER_VERSION="$WASM_POSIX_DEP_VERSION"
WORK_DIR="$(kandelo_package_make_work_dir sdl2-mixer-playwave)"
trap 'rm -rf "$WORK_DIR"' EXIT

# shellcheck source=/dev/null

SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?WASM_POSIX_DEP_OUT_DIR must name the resolver staging directory}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
SDL2_PREFIX="${WASM_POSIX_DEP_SDL2_DIR:?resolver did not provide the direct sdl2 dependency}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: SDL_mixer playwave currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
CC=wasm32posix-cc
CXX=wasm32posix-c++
AR=wasm32posix-ar
RANLIB=wasm32posix-ranlib
NM=wasm32posix-nm
STRIP=wasm32posix-strip
for tool in "$CC" "$CXX" "$AR" "$RANLIB" "$NM" "$STRIP" \
    make curl tar shasum; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: required build tool not found: $tool" >&2
        exit 1
    }
done

test -f "$SDL2_PREFIX/lib/libSDL2.a"
test -f "$SDL2_PREFIX/include/SDL2/SDL.h"
test -f "$SDL2_PREFIX/lib/pkgconfig/sdl2.pc"

TARBALL="$WORK_DIR/SDL2_mixer.tar.gz"
SRC_DIR="$WORK_DIR/source"
BUILD_DIR="$WORK_DIR/build"
REPRO_FLAGS="-ffile-prefix-map=$WORK_DIR=/usr/src/sdl2-mixer -fdebug-prefix-map=$WORK_DIR=/usr/src/sdl2-mixer -fmacro-prefix-map=$WORK_DIR=/usr/src/sdl2-mixer"

kandelo_package_stage_primary_source sdl2-mixer-playwave "$SRC_DIR" "$WORK_DIR"

mkdir -p "$BUILD_DIR" "$INSTALL_DIR"

# sdl2.pc names -lwayland-{client,egl,cursor}, -lxkbcommon and -lffi for
# libSDL2.a's Wayland video backend; those archives live in the libwayland,
# libxkbcommon and libffi packages, so give the link their search paths.
SDL2_DEP_LDFLAGS="-L${WASM_POSIX_DEP_LIBWAYLAND_DIR:?resolver did not provide the direct libwayland dependency}/lib -L${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?resolver did not provide the direct libxkbcommon dependency}/lib -L${WASM_POSIX_DEP_LIBFFI_DIR:?resolver did not provide the direct libffi dependency}/lib"

echo "==> Configuring upstream playwave with only built-in WAVE support..."
(
    cd "$BUILD_DIR"
    export PKG_CONFIG_PATH="$SDL2_PREFIX/lib/pkgconfig"
    export PKG_CONFIG_LIBDIR="$SDL2_PREFIX/lib/pkgconfig"
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$WORK_DIR/install-unused" \
        --enable-static \
        --disable-shared \
        --disable-sdltest \
        --disable-music-cmd \
        --enable-music-wave \
        --disable-music-mod \
        --disable-music-midi \
        --disable-music-gme \
        --disable-music-ogg \
        --disable-music-flac \
        --disable-music-mp3 \
        --disable-music-opus \
        --disable-music-wavpack \
        CC="$CC" CXX="$CXX" AR="$AR" RANLIB="$RANLIB" \
        NM="$NM" STRIP="$STRIP" \
        CFLAGS="-O2 -DSDL_MAIN_HANDLED $REPRO_FLAGS" \
        LDFLAGS="$SDL2_DEP_LDFLAGS"

    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" build/playwave
)

test -f "$BUILD_DIR/build/playwave"
cp "$BUILD_DIR/build/playwave" "$INSTALL_DIR/playwave.uninstrumented.wasm"
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$INSTALL_DIR/playwave.uninstrumented.wasm" \
    -o "$INSTALL_DIR/playwave.wasm"
rm -f "$INSTALL_DIR/playwave.uninstrumented.wasm"

test -f "$INSTALL_DIR/playwave.wasm"
echo "==> SDL_mixer playwave fixture complete"
