#!/usr/bin/env bash
#
# Build ScummVM (SCUMM engine only, with the scumm-7-8 sub-engine for
# v7/v8 games — Full Throttle, The Dig, Curse of Monkey Island) against
# the Kandelo SDL2 stack:
# Wayland video under wlcompositor (KMSDRM stays compiled into
# libSDL2.a as the console path) + GLES2 (forced via
# --opengl-mode=gles2, presented by the OpenGL SDL graphics manager
# through wayland-egl), OSS audio through SDL2's dsp backend and its
# audio thread, seat input from the compositor.
#
# Patches:
#   0001-kandelo-host-triple.patch
#       configure host case `wasm32posix` → _host_os=linux, so the
#       generic POSIX/SDL backend builds instead of the Emscripten
#       port that every `wasm32-*` triple selects.
#   0002-kandelo-opengl-default-graphics-manager.patch
#       -DKANDELO: the OpenGL graphics manager as default (SDL_Render
#       is compiled out of Kandelo's SDL2, so SurfaceSDL cannot
#       present). Timer and audio run on real SDL threads on this
#       platform — no Emscripten-style polling patch.
#
# Honors the dep-resolver build-script contract; see
# docs/package-management.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-scummvm.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

SCUMMVM_VERSION="${WASM_POSIX_DEP_VERSION:-2026.3.0}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://downloads.scummvm.org/frs/scummvm/${SCUMMVM_VERSION}/scummvm-${SCUMMVM_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-b863a81e1598df8bc4aa0c33e3d9b1c8bbede1879d94d91568a4f200057677e7}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?WASM_POSIX_DEP_OUT_DIR must name the resolver staging directory}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
SDL2_PREFIX="${WASM_POSIX_DEP_SDL2_DIR:?resolver did not provide the direct sdl2 dependency}"
LIBDRM_PREFIX="${WASM_POSIX_DEP_LIBDRM_DIR:?resolver did not provide the direct libdrm dependency}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?resolver did not provide the direct libwayland dependency}"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?resolver did not provide the direct libffi dependency}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?resolver did not provide the direct libxkbcommon dependency}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?resolver did not provide the direct zlib dependency}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?resolver did not provide the direct libpng dependency}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?resolver did not provide the direct freetype dependency}"
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?resolver did not provide the direct libcxx dependency}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: scummvm currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$WASM_POSIX_SYSROOT"
CC=wasm32posix-cc
CXX=wasm32posix-c++
AR=wasm32posix-ar
RANLIB=wasm32posix-ranlib
STRIP=wasm32posix-strip
for tool in "$CC" "$CXX" "$AR" "$RANLIB" "$STRIP" \
    make patch curl tar shasum; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: required build tool not found: $tool" >&2
        exit 1
    }
done

test -f "$SDL2_PREFIX/lib/libSDL2.a"
test -f "$SDL2_PREFIX/include/SDL2/SDL.h"
test -f "$LIBWAYLAND_PREFIX/lib/libwayland-client.a"
test -f "$LIBFFI_PREFIX/lib/libffi.a"
test -f "$LIBWAYLAND_PREFIX/lib/libwayland-cursor.a"
test -f "$LIBWAYLAND_PREFIX/lib/libwayland-egl.a"
test -f "$LIBXKBCOMMON_PREFIX/lib/libxkbcommon.a"
test -f "$ZLIB_PREFIX/lib/libz.a"
test -f "$LIBPNG_PREFIX/lib/libpng.a"
test -f "$FREETYPE_PREFIX/lib/libfreetype.a"
test -f "$FREETYPE_PREFIX/lib/pkgconfig/freetype2.pc"
test -f "$LIBCXX_PREFIX/lib/libc++.a"

# clang++ resolves -lc++ / -lc++abi and the libc++ header tree through
# the sysroot. Under the resolver, project a private sysroot with the
# resolved libcxx overlaid: the worktree SDK seed is an input tree for
# every package build and must hold no symlink (same pattern as
# build-mariadb.sh). A direct invocation has no resolver work dir and
# indexes the artifacts into the worktree sysroot instead.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/package-build-roots.sh"
    SYSROOT="$(
        kandelo_package_prepare_private_sysroot scummvm "$SYSROOT" libcxx
    )"
    export WASM_POSIX_SYSROOT="$SYSROOT"
fi

mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

# The source tree persists across runs (sdl2-src pattern): the 225 MB
# tarball downloads once and `make` stays incremental. `rm -rf
# scummvm-src` forces a fresh download + re-patch.
SRC_DIR="$SCRIPT_DIR/scummvm-src"
DEST_DIR="$WORK_DIR/dest"
REPRO_FLAGS="-ffile-prefix-map=$SRC_DIR=/usr/src/scummvm -fdebug-prefix-map=$SRC_DIR=/usr/src/scummvm -fmacro-prefix-map=$SRC_DIR=/usr/src/scummvm"
mkdir -p "$DEST_DIR"

if [ ! -d "$SRC_DIR" ]; then
    TARBALL="$WORK_DIR/scummvm.tar.xz"
    echo "==> Downloading ScummVM $SCUMMVM_VERSION..."
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
    echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1

    echo "==> Applying Kandelo patches..."
    for p in "$SCRIPT_DIR"/patches/*.patch; do
        echo "    $(basename "$p")"
        patch -p1 -d "$SRC_DIR" < "$p"
    done
fi

# ScummVM's configure is hand-written (not autoconf); it honors the
# CXX/AR/RANLIB/STRIP env vars and probes SDL through sdl2-config.
# libSDL2.a is static, so the Wayland/KMSDRM/GL dependency archives
# must ride the final link line — LDFLAGS carries them
# (libwayland-egl.a is the glue's wl_egl_window shim, staged into the
# sysroot by the libwayland package).
#
# -lc++ -lc++abi is mandatory: the SDK links -nostdlib with
# --allow-undefined, so a missing libc++abi does not fail the link —
# __dynamic_cast becomes a stubbed host import that returns its
# argument unadjusted and every typeinfo vtable pointer relocates to
# 0. ScummVM's graphics-manager casts then dispatch through garbage
# ("null function or function signature mismatch" in initBackend).
SDL_DEP_LIBS="-lwayland-client -lwayland-cursor -lwayland-egl -lffi -lxkbcommon -lgbm -ldrm -lEGL -lGLESv2 -lc++ -lc++abi"

# ScummVM's hand-written configure probes SDL exclusively through
# sdl2-config, but the sdl2 package strips bin/ (only the .a, headers
# and sdl2.pc ship). Synthesize the three queries configure makes from
# the package prefix and hand the shim over via --with-sdl-prefix.
SDL_SHIM_PREFIX="$WORK_DIR/sdl2-shim"
mkdir -p "$SDL_SHIM_PREFIX/bin"
cat > "$SDL_SHIM_PREFIX/bin/sdl2-config" <<SHIM
#!/bin/sh
while [ \$# -gt 0 ]; do
    case "\$1" in
        --version) echo "2.32.10" ;;
        --prefix) echo "$SDL2_PREFIX" ;;
        --cflags) echo "-I$SDL2_PREFIX/include/SDL2 -D_REENTRANT" ;;
        --libs|--static-libs) echo "-L$SDL2_PREFIX/lib -lSDL2" ;;
    esac
    shift
done
SHIM
chmod +x "$SDL_SHIM_PREFIX/bin/sdl2-config"

echo "==> Configuring ScummVM (SCUMM engine, GLES2, SDL2 backend)..."
(
    cd "$SRC_DIR"
    CXX="$CXX" AR="$AR" RANLIB="$RANLIB" STRIP="$STRIP" \
    CXXFLAGS="-O2 -DKANDELO $REPRO_FLAGS" \
    LDFLAGS="-L$SYSROOT/lib -L$SDL2_PREFIX/lib -L$LIBDRM_PREFIX/lib -L$LIBWAYLAND_PREFIX/lib -L$LIBFFI_PREFIX/lib -L$LIBXKBCOMMON_PREFIX/lib -L$ZLIB_PREFIX/lib -L$LIBPNG_PREFIX/lib -L$FREETYPE_PREFIX/lib $SDL_DEP_LIBS" \
    PKG_CONFIG_LIBDIR="$FREETYPE_PREFIX/lib/pkgconfig" \
    ./configure \
        --host=wasm32posix \
        --backend=sdl \
        --with-sdl-prefix="$SDL_SHIM_PREFIX" \
        --disable-all-engines \
        --enable-engine=scumm,scumm-7-8 \
        --opengl-mode=gles2 \
        --enable-release \
        --enable-verbose-build \
        --prefix=/usr \
        --datadir=/usr/share/scummvm \
        --with-zlib-prefix="$ZLIB_PREFIX" \
        --with-png-prefix="$LIBPNG_PREFIX" \
        --disable-mt32emu \
        --disable-alsa \
        --disable-fluidsynth \
        --disable-seq-midi \
        --disable-timidity \
        --disable-ogg --disable-vorbis --disable-tremor \
        --disable-mad --disable-flac \
        --disable-jpeg --disable-gif \
        --disable-faad --disable-mpeg2 --disable-a52 \
        --disable-theoradec --disable-vpx \
        --enable-freetype2 --disable-fribidi \
        --disable-libcurl --disable-cloud --disable-sdlnet --disable-enet \
        --disable-discord --disable-taskbar --disable-updates \
        --disable-tts \
        --disable-eventrecorder
)

echo "==> Compiling ScummVM..."
make -C "$SRC_DIR" -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

echo "==> Installing ScummVM data files..."
make -C "$SRC_DIR" install DESTDIR="$DEST_DIR"
mkdir -p "$INSTALL_DIR/share/scummvm"
# Only the [[runtime_files]] the manifest declares. `make install` also
# produces translation, CJK-font, ImGui-font, Macintosh-font, shader, help
# and achievement data (~103 MB) that the SCUMM launcher never reads.
for data_file in \
    scummremastered.zip \
    scummmodern.zip \
    scummclassic.zip \
    gui-icons.dat \
    fonts.dat; do
    cp "$DEST_DIR/usr/share/scummvm/$data_file" "$INSTALL_DIR/share/scummvm/$data_file"
done

echo "==> Fork-instrumenting scummvm.wasm..."
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$SRC_DIR/scummvm" \
    -o "$INSTALL_DIR/scummvm.wasm"

test -f "$INSTALL_DIR/scummvm.wasm"
test -f "$INSTALL_DIR/share/scummvm/scummclassic.zip"
echo "==> ScummVM $SCUMMVM_VERSION package complete"
