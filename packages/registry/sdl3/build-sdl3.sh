#!/usr/bin/env bash
# Build upstream SDL 3 with its unmodified OSS dsp backend for Kandelo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-sdl3.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

SDL_VERSION="${WASM_POSIX_DEP_VERSION:-3.4.10}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/libsdl-org/SDL/releases/download/release-${SDL_VERSION}/SDL3-${SDL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-12b34280415ec8418c864408b93d008a20a6530687ee613d60bfbd20411f2785}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?WASM_POSIX_DEP_OUT_DIR must name the resolver staging directory}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: SDL3 currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
for tool in wasm32posix-cc wasm32posix-c++ wasm32posix-ar \
    wasm32posix-ranlib wasm32posix-nm wasm32posix-strip \
    cmake patch curl shasum; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: required build tool not found: $tool" >&2
        exit 1
    }
done

TARBALL="$WORK_DIR/SDL3.tar.gz"
SRC_DIR="$WORK_DIR/source"
BUILD_DIR="$WORK_DIR/build"
REPRO_FLAGS="-ffile-prefix-map=$WORK_DIR=/usr/src/sdl3 -fdebug-prefix-map=$WORK_DIR=/usr/src/sdl3 -fmacro-prefix-map=$WORK_DIR=/usr/src/sdl3"

echo "==> Downloading SDL3 $SDL_VERSION..."
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
    -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

echo "==> Applying the Kandelo platform-classification patch..."
patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/patches/0001-recognize-kandelo-platform.patch"

echo "==> Configuring SDL3 with only the OSS playback backend..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_TOOLCHAIN_FILE="$SCRIPT_DIR/cmake/kandelo-toolchain.cmake" \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG $REPRO_FLAGS" \
    -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG $REPRO_FLAGS" \
    -DSDL_INSTALL=ON \
    -DSDL_INSTALL_DOCS=OFF \
    -DSDL_UNINSTALL=OFF \
    -DSDL_RELOCATABLE=ON \
    -DSDL_SHARED=OFF \
    -DSDL_STATIC=ON \
    -DSDL_TEST_LIBRARY=OFF \
    -DSDL_TESTS=OFF \
    -DSDL_EXAMPLES=OFF \
    -DSDL_AUDIO=ON \
    -DSDL_OSS=ON \
    -DSDL_UNIX_CONSOLE_BUILD=ON \
    -DSDL_ALSA=OFF \
    -DSDL_JACK=OFF \
    -DSDL_PIPEWIRE=OFF \
    -DSDL_PULSEAUDIO=OFF \
    -DSDL_SNDIO=OFF \
    -DSDL_DISKAUDIO=OFF \
    -DSDL_DUMMYAUDIO=OFF \
    -DSDL_VIDEO=OFF \
    -DSDL_GPU=OFF \
    -DSDL_RENDER=OFF \
    -DSDL_CAMERA=OFF \
    -DSDL_JOYSTICK=OFF \
    -DSDL_HAPTIC=OFF \
    -DSDL_HIDAPI=OFF \
    -DSDL_POWER=OFF \
    -DSDL_SENSOR=OFF \
    -DSDL_DIALOG=OFF \
    -DSDL_TRAY=OFF \
    -DSDL_DBUS=OFF \
    -DSDL_LIBURING=OFF \
    -DSDL_IBUS=OFF \
    -DSDL_LIBUDEV=OFF \
    -DSDL_ASSEMBLY=OFF \
    -DSDL_OFFSCREEN=OFF \
    -DSDL_RPATH=OFF

cmake --build "$BUILD_DIR" --parallel
cmake --install "$BUILD_DIR"

# The resolver atomically moves this staging tree. Keep pkg-config metadata
# relative, and reject CMake metadata that retained the temporary prefix.
sed -i.bak 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
    "$INSTALL_DIR/lib/pkgconfig/sdl3.pc"
rm -f "$INSTALL_DIR/lib/pkgconfig/sdl3.pc.bak"
if grep -R -F "$INSTALL_DIR" "$INSTALL_DIR/lib/cmake/SDL3" >/dev/null; then
    echo "ERROR: SDL3 CMake metadata retained its resolver staging prefix" >&2
    exit 1
fi
rm -rf "$INSTALL_DIR/share"
test -f "$INSTALL_DIR/lib/libSDL3.a"
test -f "$INSTALL_DIR/include/SDL3/SDL.h"
test -f "$INSTALL_DIR/lib/pkgconfig/sdl3.pc"
test -d "$INSTALL_DIR/lib/cmake/SDL3"
echo "==> SDL3 OSS-only static package complete"
