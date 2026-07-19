#!/usr/bin/env bash
#
# Build SDL2 (libSDL2.a) — KMSDRM + Wayland + ALSA + evdev backends — for
# wasm32-posix-kernel. The kandelo demos (the sdl2 playground binary
# + future `sysroot(sdl2-demo)` work) call into the standard SDL2 API
# (SDL_Init, SDL_CreateWindow, SDL_OpenAudio, SDL_PumpEvents) and
# fan out through:
#
#   src/video/kmsdrm/    → libdrm + libgbm + GL stack
#   src/video/wayland/   → libwayland-client + wl_egl_window shim
#                          (libwayland-egl.a) + libxkbcommon; runs GL
#                          clients against wlcompositor (step 12).
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

# --- Link-time deps from the resolver ---
# The dep-resolver topologically builds libdrm + alsa-lib +
# libinput-lite first and passes each install root via
# `WASM_POSIX_DEP_<NAME>_DIR`. Headers live under <prefix>/include,
# archives under <prefix>/lib — matching the canonical pattern in
# other registry build scripts (see git/build-git.sh, libcurl/, etc.).
LIBDRM_PREFIX="${WASM_POSIX_DEP_LIBDRM_DIR:?WASM_POSIX_DEP_LIBDRM_DIR not set (must be invoked via cargo xtask build-deps resolve sdl2)}"
ALSA_PREFIX="${WASM_POSIX_DEP_ALSA_LIB_DIR:?WASM_POSIX_DEP_ALSA_LIB_DIR not set (must be invoked via cargo xtask build-deps resolve sdl2)}"
LIBINPUT_PREFIX="${WASM_POSIX_DEP_LIBINPUT_LITE_DIR:?WASM_POSIX_DEP_LIBINPUT_LITE_DIR not set (must be invoked via cargo xtask build-deps resolve sdl2)}"
# Wayland backend deps (step 12b): libwayland provides
# libwayland-{client,cursor}.a + wayland-egl/cursor headers + the
# wayland-{client,egl,cursor,scanner}.pc files; libxkbcommon provides
# libxkbcommon.a + xkbcommon.pc. Their pkgconfig dirs feed SDL2's
# configure gate (see the CheckWayland short-circuit below).
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set (must be invoked via cargo xtask build-deps resolve sdl2)}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set (must be invoked via cargo xtask build-deps resolve sdl2)}"

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

# --- Wayland pkg-config wiring (step 12b) ------------------------------
# SDL2's configure gates the Wayland backend on a hard pkg-config probe
# (configure.ac CheckWayland ~L1742):
#   $PKG_CONFIG --exists 'wayland-client >= 1.18' wayland-scanner \
#               wayland-egl wayland-cursor egl 'xkbcommon >= 0.5.0'
# The wayland-* .pc files ship in libwayland's prefix, xkbcommon.pc in
# libxkbcommon's. egl.pc has no owning resolver package (our libEGL is the
# build-programs.sh stub), so we synthesize a minimal one here purely to
# satisfy the --exists gate — SDL compiles against its own bundled khronos
# EGL headers (src/video/khronos), and the wayland backend links libEGL.a
# explicitly at client-link time (step 12c), so egl.pc's Libs/Cflags are
# never consumed. PKG_CONFIG points at the cross wrapper, which reads
# PKG_CONFIG_PATH (kandelo cache + this build dir pass its host-path filter).
export PKG_CONFIG=wasm32posix-pkg-config
PC_LOCAL="$BUILD_DIR/pkgconfig"
mkdir -p "$PC_LOCAL"
cat > "$PC_LOCAL/egl.pc" <<EOF
Name: egl
Description: EGL (kandelo libEGL stub; headers via SDL khronos, lib linked at client-link)
Version: 1.5
Libs: -lEGL
Cflags:
EOF
export PKG_CONFIG_PATH="$LIBWAYLAND_PREFIX/lib/pkgconfig:$LIBXKBCOMMON_PREFIX/lib/pkgconfig:$PC_LOCAL"

# Sanity: fail loudly if the gate probe won't pass, rather than letting
# configure silently report "Wayland support: no".
if ! "$PKG_CONFIG" --exists 'wayland-client >= 1.18' wayland-scanner \
        wayland-egl wayland-cursor egl 'xkbcommon >= 0.5.0'; then
    echo "ERROR: wayland pkg-config gate failed. PKG_CONFIG_PATH=$PKG_CONFIG_PATH" >&2
    "$PKG_CONFIG" --exists --print-errors 'wayland-client >= 1.18' \
        wayland-scanner wayland-egl wayland-cursor egl 'xkbcommon >= 0.5.0' >&2 || true
    exit 1
fi

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
# Configure overrides for the wasm32 sysroot. Per CLAUDE.md
# "Cross-Compilation and Configure Scripts": autoconf checks that
# detect host-side functions must be force-no'd when the wasm sysroot
# lacks the symbol or header.
#
#   sysctlbyname    - link-test succeeds (weak/undef-tolerant) but
#                     <sys/sysctl.h> is not in the sysroot.
#   {alsa,kmsdrm}-shared    - dlopen is unavailable; libraries link
#                     statically into libSDL2.a.
#   alsatest        - acinclude/alsa.m4 link-tests `-lasound -lm -ldl
#                     -lpthread`; the synthetic test program produces a
#                     wasm-ld output that wasm-validate rejects ("parse
#                     exception"). Skipping this stage is safe — we've
#                     verified libasound.a is in the install dir.
#
# PKG_CHECK_MODULES pre-set vars: libdrm + gbm don't ship .pc files in
# our wasm sysroot, but SDL2 only consults pkg-config to populate
# CFLAGS/LIBS — providing them up-front via `LIBDRM_CFLAGS` /
# `LIBDRM_LIBS` / `LIBGBM_CFLAGS` / `LIBGBM_LIBS` short-circuits the
# pkg-config path (see acinclude/pkg.m4 `_PKG_CONFIG` first branch).
#
# `-DDYNAPI_NEEDS_DLOPEN`: with --disable-loadso, HAVE_DLOPEN stays
# undefined, so SDL_dynapi.h flips `SDL_DYNAMIC_API` to 0 — required
# because src/dynapi/SDL_dynapi.c has no wasm32 platform branch.
#
# `-DSDL_VIDEO_STATIC_ANGLE=1`: forces src/video/SDL_egl.c's LOAD_FUNC
# macro down the static-link branch so `_this->egl_data->eglFoo`
# resolves to the libEGL.a symbol directly instead of going through
# SDL_LoadFunction(egl_dll_handle, ...). With --disable-loadso our
# SDL_LoadObject is a stub that returns NULL, so the dlopen-driven
# path errors out with "Could not initialize OpenGL / GLES library"
# before any window can be created. ANGLE in the macro name is
# misleading — it just means "EGL symbols are linked in, not loaded
# at runtime"; matches the path the Vita / WinRT static-EGL builds
# take.
ac_cv_func_feenableexcept=no \
ac_cv_func_pthread_setname_np=no \
ac_cv_func_clock_nanosleep=no \
ac_cv_func_getpriority=no \
ac_cv_func_setpriority=no \
ac_cv_func_mprotect=no \
ac_cv_func_posix_madvise=no \
ac_cv_func_sysctlbyname=no \
ac_cv_func__strrev=no \
ac_cv_func__strupr=no \
ac_cv_func__strlwr=no \
ac_cv_func_itoa=no \
ac_cv_func__ltoa=no \
ac_cv_func__uitoa=no \
ac_cv_func__ultoa=no \
ac_cv_func__i64toa=no \
ac_cv_func__ui64toa=no \
ac_cv_func__wcsdup=no \
ac_cv_func__wcsicmp=no \
ac_cv_func__wcsnicmp=no \
ac_cv_func__stricmp=no \
ac_cv_func__strnicmp=no \
ac_cv_func_elf_aux_info=no \
ac_cv_func_getauxval=no \
LIBDRM_CFLAGS="-I$LIBDRM_PREFIX/include -I$LIBDRM_PREFIX/include/libdrm -I$LIBDRM_PREFIX/include/drm" \
LIBDRM_LIBS="-L$LIBDRM_PREFIX/lib -ldrm" \
LIBGBM_CFLAGS="-I${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}/include" \
LIBGBM_LIBS="-lgbm" \
CC=wasm32posix-cc \
AR=wasm32posix-ar \
RANLIB=wasm32posix-ranlib \
NM=wasm32posix-nm \
CPPFLAGS="-I$LIBDRM_PREFIX/include -I$LIBDRM_PREFIX/include/libdrm -I$LIBDRM_PREFIX/include/drm -I$ALSA_PREFIX/include -I$LIBINPUT_PREFIX/include -DDYNAPI_NEEDS_DLOPEN -DSDL_VIDEO_STATIC_ANGLE=1 -include $SCRIPT_DIR/src/sdl2-evdev-shim.h" \
LDFLAGS="-L$LIBDRM_PREFIX/lib -L$ALSA_PREFIX/lib -L$LIBINPUT_PREFIX/lib" \
"$SRC_DIR/configure" \
    --host=wasm32-unknown-linux-musl \
    --prefix="$INSTALL_DIR" \
    --enable-static --disable-shared \
    \
    --enable-video --enable-video-kmsdrm --disable-kmsdrm-shared \
    --disable-video-x11 \
    --enable-video-wayland --disable-wayland-shared --disable-libdecor \
    --disable-video-vivante --disable-video-cocoa \
    --disable-video-directfb --disable-video-offscreen \
    --enable-video-opengl --enable-video-opengles2 \
    \
    --enable-audio --enable-alsa --disable-alsa-shared --disable-alsatest \
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
    --disable-rpath \
    \
    --disable-pthreads --disable-pthread-sem

echo "==> Compiling SDL2..."
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" V=1

echo "==> Installing SDL2..."
make install

echo "==> SDL2 $SDL2_VERSION installed at $INSTALL_DIR"
echo "    lib/libSDL2.a ($(wc -c < "$INSTALL_DIR/lib/libSDL2.a") bytes)"
