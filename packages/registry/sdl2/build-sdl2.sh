#!/usr/bin/env bash
# Build upstream SDL 2 for Kandelo with its unmodified OSS dsp audio
# backend, its KMSDRM video backend, and its direct evdev input path.

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

# The KMSDRM backend links libdrm and libgbm. libdrm is a package the
# resolver stages for us; libgbm is a sysroot library scripts/
# build-dri-stubs.sh builds, so it is read from the sysroot directly.
LIBDRM_PREFIX="${WASM_POSIX_DEP_LIBDRM_DIR:?WASM_POSIX_DEP_LIBDRM_DIR must name the staged libdrm prefix (resolve sdl2 through cargo xtask build-deps)}"

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

echo "==> Configuring SDL2 with the OSS, KMSDRM and evdev backends..."
# Kandelo exposes neither the non-POSIX sysctl header nor its matching API.
# Pin the cross-compile probe so SDL uses its portable sysconf path.
# Executable links intentionally permit unresolved host imports, so link-only
# Autoconf probes cannot prove optional functions. Pin only helpers absent from
# the Kandelo musl headers/library; SDL provides portable fallbacks for them.
#
# libdrm and gbm ship no .pc files in the Kandelo sysroot. SDL consults
# pkg-config only to populate CFLAGS/LIBS, so presetting the four
# variables short-circuits the lookup (acinclude/pkg.m4, _PKG_CONFIG's
# first branch).
#
# SDL_VIDEO_STATIC_ANGLE forces src/video/SDL_egl.c's LOAD_FUNC macro
# down its static-link branch, so `_this->egl_data->eglFoo` binds to the
# libEGL.a symbol instead of going through SDL_LoadFunction. With
# --disable-loadso that loader returns NULL and EGL init fails before a
# window can exist. The ANGLE in the name means "EGL symbols are linked
# in, not dlopened" — the same path the Vita and WinRT builds take.
(
    cd "$BUILD_DIR"
    LIBDRM_CFLAGS="-I$LIBDRM_PREFIX/include -I$LIBDRM_PREFIX/include/libdrm -I$LIBDRM_PREFIX/include/drm" \
    LIBDRM_LIBS="-L$LIBDRM_PREFIX/lib -ldrm" \
    LIBGBM_CFLAGS="-I$WASM_POSIX_SYSROOT/include" \
    LIBGBM_LIBS="-L$WASM_POSIX_SYSROOT/lib -lgbm" \
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
        --enable-video \
        --enable-video-kmsdrm \
        --disable-kmsdrm-shared \
        --disable-video-x11 \
        --disable-video-wayland \
        --disable-video-vivante \
        --disable-video-cocoa \
        --disable-video-directfb \
        --disable-video-offscreen \
        --disable-video-dummy \
        --disable-video-opengl \
        --enable-video-opengl-es2 \
        --enable-events \
        --enable-input-events \
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
        CFLAGS="-O2 $REPRO_FLAGS -DSDL_VIDEO_STATIC_ANGLE=1" \
        CPPFLAGS="-I$LIBDRM_PREFIX/include -I$LIBDRM_PREFIX/include/libdrm -I$LIBDRM_PREFIX/include/drm" \
        LDFLAGS="-L$LIBDRM_PREFIX/lib -L$WASM_POSIX_SYSROOT/lib" \
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

# Autoconf silently drops a backend whose probe fails, which would leave a
# library that links but cannot open a window. Fail the build instead.
for feature in SDL_VIDEO_DRIVER_KMSDRM SDL_VIDEO_OPENGL_ES2 \
    SDL_VIDEO_OPENGL_EGL SDL_INPUT_LINUXEV SDL_AUDIO_DRIVER_OSS; do
    grep -q "^#define $feature 1" "$INSTALL_DIR/include/SDL2/SDL_config.h" || {
        echo "ERROR: configure did not enable $feature" >&2
        exit 1
    }
done
echo "==> SDL2 static package complete (KMSDRM video, evdev input, OSS audio)"
