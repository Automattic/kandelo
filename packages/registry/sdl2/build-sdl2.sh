#!/usr/bin/env bash
#
# Build SDL2 (libSDL2.a) — KMSDRM + ALSA + evdev backends only — for
# wasm32-posix-kernel. The kandelo demos (sdl2_demo + future
# `sysroot(sdl2-demo)` work) call into the standard SDL2 API
# (SDL_Init, SDL_CreateWindow, SDL_OpenAudio, SDL_PumpEvents) and
# fan out through:
#
#   src/video/kmsdrm/    → libdrm + libgbm + GL stack
#   src/audio/alsa/      → libasound (subset, packages/registry/alsa-lib)
#   src/core/linux/      → /dev/input/event[0-31] direct via evdev
#
# Cross-compile via wasm32posix-cc. Configure overrides per CLAUDE.md
# "Cross-Compilation and Configure Scripts" rule force-disable host-
# detected functions not in our wasm sysroot.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve sdl2`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to install lib/ + include/
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#
# ============================================================
# STATUS: B1 scaffold only.
#   The configure invocation below documents the intended override
#   set per docs/plans/2026-06-29-sdl2-port-plan.md task B2. The
#   first run will reveal additional `ac_cv_*=no` overrides needed
#   for the wasm sysroot — iterate until the build succeeds, then
#   document the final list above this block in the next commit.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/sdl2-src"

SDL2_VERSION="${WASM_POSIX_DEP_VERSION:-${SDL2_VERSION:-2.30.0}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/sdl2-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/libsdl-org/SDL/releases/download/release-${SDL2_VERSION}/SDL2-${SDL2_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# --- Resolve link-time deps from the registry ---
# alsa-lib + libdrm + libinput-lite expose their static archives
# under $WASM_POSIX_DEP_OUT_DIR/lib and headers under
# $WASM_POSIX_DEP_OUT_DIR/include. Each resolve installs into the
# shared cache and prints the install path on stdout.
echo "==> Resolving link-time deps..."
LIBDRM_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --quiet -- build-deps resolve libdrm >/dev/null && cargo run -p xtask --quiet -- build-deps path libdrm)"
ALSA_PREFIX="$(cd "$REPO_ROOT"  && cargo run -p xtask --quiet -- build-deps resolve alsa-lib >/dev/null && cargo run -p xtask --quiet -- build-deps path alsa-lib)"
LIBINPUT_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --quiet -- build-deps resolve libinput-lite >/dev/null && cargo run -p xtask --quiet -- build-deps path libinput-lite)"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading SDL2 $SDL2_VERSION..."
    TARBALL="/tmp/SDL2-${SDL2_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification — populate"
        echo "    [source].sha256 in package.toml after first successful build)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"

    # --- Apply patches (B5/open-arch #1) ---
    # patches/0001-polling-audio-eagain.patch — drives SDL_RunAudio
    #   from SDL_PumpAudio instead of SDL_CreateThread, and treats
    #   EAGAIN from SNDRV_PCM_IOCTL_WRITEI_FRAMES as "ring full,
    #   try again next pump" rather than an error. Required because
    #   our musl wasm32 has no pthread_create.
    for p in "$SCRIPT_DIR"/patches/*.patch; do
        [ -e "$p" ] || continue
        echo "    $(basename "$p")"
        patch -p1 -d "$SRC_DIR" < "$p"
    done
fi

# Fresh build dir each run — stale objects would shadow header
# changes from the resolved deps.
BUILD_DIR="$SCRIPT_DIR/sdl2-build"
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# --- Configure ---
# Backend matrix:
#   --enable-video --enable-video-kmsdrm — only video backend.
#   --enable-audio --enable-alsa          — only audio backend.
#   --enable-events --enable-input-events — evdev path.
#   --disable-libudev                     — fall back to scan-and-
#                                           open of /dev/input/event*.
#   --disable-pthreads                    — wasm32 musl has no
#                                           pthread_create; SDL_thread
#                                           emulation runs single-
#                                           threaded (open-arch #1).
#   --disable-loadso                      — no dlopen on wasm32.
#   --disable-render                      — no 2D render fallback;
#                                           demos drive GL directly.
#   --disable-joystick / --haptic /
#     --sensor / --power / --filesystem   — none of these have a
#                                           wasm32 backend in v1.
ac_cv_func_feenableexcept=no \
ac_cv_func_pthread_setname_np=no \
ac_cv_func_clock_nanosleep=no \
ac_cv_func_getpriority=no \
ac_cv_func_setpriority=no \
ac_cv_func_mprotect=no \
ac_cv_func_posix_madvise=no \
CC=wasm32posix-cc \
CPPFLAGS="-I$LIBDRM_PREFIX/include -I$LIBDRM_PREFIX/include/libdrm -I$ALSA_PREFIX/include -I$LIBINPUT_PREFIX/include" \
LDFLAGS="-L$LIBDRM_PREFIX/lib -L$ALSA_PREFIX/lib -L$LIBINPUT_PREFIX/lib" \
"$SRC_DIR/configure" \
    --host=wasm32-unknown-none \
    --prefix="$INSTALL_DIR" \
    --enable-static --disable-shared \
    \
    --enable-video --enable-video-kmsdrm \
    --disable-video-x11 --disable-video-wayland \
    --disable-video-vivante --disable-video-cocoa \
    --disable-video-directfb --disable-video-offscreen \
    --enable-video-opengl --enable-video-opengles2 \
    \
    --enable-audio --enable-alsa --disable-alsa-shared \
    --disable-pulseaudio --disable-jack --disable-pipewire \
    --disable-sndio --disable-oss --disable-arts --disable-esd \
    --disable-nas --disable-fusionsound \
    \
    --enable-events --enable-input-events \
    --disable-libudev \
    \
    --disable-haptic --disable-joystick --disable-sensor \
    --disable-power --disable-filesystem --disable-loadso \
    --disable-render --disable-render-d3d \
    --disable-test --disable-rpath \
    \
    --disable-pthreads --disable-pthread-sem \
    \
    -Wno-error

echo "==> Compiling SDL2..."
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" V=1

echo "==> Installing SDL2..."
make install

echo "==> SDL2 $SDL2_VERSION installed at $INSTALL_DIR"
echo "    lib/libSDL2.a ($(wc -c < "$INSTALL_DIR/lib/libSDL2.a") bytes)"
