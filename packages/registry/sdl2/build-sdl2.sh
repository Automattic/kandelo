#!/usr/bin/env bash
# Build upstream SDL 2 with its unmodified OSS dsp backend for Kandelo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-sdl2.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

SDL_VERSION="${WASM_POSIX_DEP_VERSION:-2.32.10}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/libsdl-org/SDL/releases/download/release-${SDL_VERSION}/SDL2-${SDL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-5f5993c530f084535c65a6879e9b26ad441169b3e25d789d83287040a9ca5165}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?WASM_POSIX_DEP_OUT_DIR must name the resolver staging directory}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: SDL2 currently supports only wasm32, got $TARGET_ARCH" >&2
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
    make patch curl shasum; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: required build tool not found: $tool" >&2
        exit 1
    }
done

TARBALL="$WORK_DIR/SDL2.tar.gz"
SRC_DIR="$WORK_DIR/source"
BUILD_DIR="$WORK_DIR/build"
REPRO_FLAGS="-ffile-prefix-map=$WORK_DIR=/usr/src/sdl2 -fdebug-prefix-map=$WORK_DIR=/usr/src/sdl2 -fmacro-prefix-map=$WORK_DIR=/usr/src/sdl2"

echo "==> Downloading SDL2 $SDL_VERSION..."
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
    -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR" "$BUILD_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

echo "==> Applying the Kandelo platform-classification patch..."
patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/patches/0001-recognize-kandelo-as-unix.patch"

echo "==> Configuring SDL2 with only the OSS playback backend..."
# Kandelo exposes neither the non-POSIX sysctl header nor its matching API.
# Pin the cross-compile probe so SDL uses its portable sysconf path.
# Executable links intentionally permit unresolved host imports, so link-only
# Autoconf probes cannot prove optional functions. Pin only helpers absent from
# the Kandelo musl headers/library; SDL provides portable fallbacks for them.
(
    cd "$BUILD_DIR"
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --enable-audio \
        --enable-oss \
        --disable-alsa \
        --disable-pulseaudio \
        --disable-pipewire \
        --disable-jack \
        --disable-sndio \
        --disable-arts \
        --disable-esd \
        --disable-nas \
        --disable-fusionsound \
        --disable-libsamplerate \
        --disable-diskaudio \
        --disable-dummyaudio \
        --disable-video \
        --disable-render \
        --disable-joystick \
        --disable-haptic \
        --disable-hidapi \
        --disable-sensor \
        --disable-power \
        --disable-loadso \
        --disable-libudev \
        --disable-dbus \
        --disable-ime \
        --disable-ibus \
        --disable-fcitx \
        --disable-assembly \
        CC="$CC" CXX="$CXX" AR="$AR" RANLIB="$RANLIB" \
        NM="$NM" STRIP="$STRIP" \
        CFLAGS="-O2 $REPRO_FLAGS" \
        ac_cv_func_dlopen=no \
        ac_cv_func_sysctlbyname=no \
        ac_cv_func_elf_aux_info=no \
        ac_cv_func_pthread_set_name_np=no \
        ac_cv_func__wcsdup=no \
        ac_cv_func__wcsicmp=no \
        ac_cv_func__wcsnicmp=no \
        ac_cv_func__strrev=no \
        ac_cv_func__strupr=no \
        ac_cv_func__strlwr=no \
        ac_cv_func_itoa=no \
        ac_cv_func__ltoa=no \
        ac_cv_func__uitoa=no \
        ac_cv_func__ultoa=no \
        ac_cv_func__i64toa=no \
        ac_cv_func__ui64toa=no \
        ac_cv_func__stricmp=no \
        ac_cv_func__strnicmp=no

    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    make install
)

# The resolver atomically moves this staging tree, so generated metadata must
# locate the package relative to itself instead of retaining the temp prefix.
sed -i.bak 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
    "$INSTALL_DIR/lib/pkgconfig/sdl2.pc"
rm -f "$INSTALL_DIR/lib/pkgconfig/sdl2.pc.bak"
rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/share" "$INSTALL_DIR/lib/cmake"
rm -f "$INSTALL_DIR/lib/"*.la

test -f "$INSTALL_DIR/lib/libSDL2.a"
test -f "$INSTALL_DIR/include/SDL2/SDL.h"
test -f "$INSTALL_DIR/lib/pkgconfig/sdl2.pc"
echo "==> SDL2 OSS-only static package complete"
