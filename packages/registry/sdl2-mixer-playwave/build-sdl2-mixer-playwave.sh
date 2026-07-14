#!/usr/bin/env bash
# Build upstream SDL_mixer's unmodified playwave sample against Kandelo SDL2.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-sdl2-mixer-playwave.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

MIXER_VERSION="${WASM_POSIX_DEP_VERSION:-2.8.2}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/libsdl-org/SDL_mixer/releases/download/release-${MIXER_VERSION}/SDL2_mixer-${MIXER_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-938dff531d00ace2296557a6599abe6f34599e2f34f0a4a08a397e2ccac8b8f7}"
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

echo "==> Downloading SDL_mixer $MIXER_VERSION..."
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
    -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR" "$BUILD_DIR" "$INSTALL_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

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
        CFLAGS="-O2 -DSDL_MAIN_HANDLED $REPRO_FLAGS"

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
