#!/bin/bash
set -euo pipefail

# Build musl libc as a static library targeting wasm32 or wasm64.
#
# Usage:
#   scripts/build-musl.sh              # build wasm32posix (default)
#   scripts/build-musl.sh --arch wasm64posix   # build wasm64posix
#
# Approach:
#   1. Copy overlay files from libc/musl-overlay/ into libc/musl/arch/<ARCH>/
#   2. Write config.mak directly (bypassing configure which doesn't know our arch)
#   3. Run make to build libc.a and CRT objects
#   4. Install headers + libs into sysroot/

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUSL_DIR="$REPO_ROOT/libc/musl"
OVERLAY_DIR="$REPO_ROOT/libc/musl-overlay"

# Parse arguments
ARCH="wasm32posix"
while [ $# -gt 0 ]; do
    case "$1" in
        --arch) ARCH="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

case "$ARCH" in
    wasm32posix)
        TARGET="wasm32-unknown-unknown"
        SYSROOT="$REPO_ROOT/sysroot"
        SETJMP_DIR="wasm32"
        SIGSETJMP_DIR="wasm32posix"
        ;;
    wasm64posix)
        TARGET="wasm64-unknown-unknown"
        SYSROOT="$REPO_ROOT/sysroot64"
        SETJMP_DIR="wasm32"  # TODO: may need wasm64 variant
        SIGSETJMP_DIR="wasm32posix"  # Same signal implementation
        ;;
    *)
        echo "Error: unsupported arch '$ARCH'. Use wasm32posix or wasm64posix." >&2
        exit 1
        ;;
esac

# Use Homebrew LLVM 21 toolchain (override via LLVM_BIN env)
LLVM_BIN="${LLVM_BIN:-/opt/homebrew/opt/llvm/bin}"
CC="$LLVM_BIN/clang"
AR="$LLVM_BIN/llvm-ar"
RANLIB="$LLVM_BIN/llvm-ranlib"

# Verify toolchain exists
for tool in "$CC" "$AR" "$RANLIB"; do
    if [ ! -x "$tool" ]; then
        echo "Error: $tool not found. Install LLVM via: brew install llvm" >&2
        exit 1
    fi
done

# ---------------------------------------------------------------
# 1. Copy overlay files into musl source tree
# ---------------------------------------------------------------
echo "==> Copying overlay files for $ARCH..."
rm -rf "$MUSL_DIR/arch/$ARCH"
cp -r "$OVERLAY_DIR/arch/$ARCH" "$MUSL_DIR/arch/"

# Copy source file overlays (e.g., Wasm-specific __libc_start_main.c)
# First, clean arch-specific dirs in musl tree to remove stale overlay files
if [ -d "$OVERLAY_DIR/src" ]; then
    find "$OVERLAY_DIR/src" -type d -name wasm32posix | while read dir; do
        rel="${dir#$OVERLAY_DIR/src/}"
        rm -rf "$MUSL_DIR/src/$rel"
    done
    cp -r "$OVERLAY_DIR/src/"* "$MUSL_DIR/src/"

    # For wasm64posix: copy wasm32posix source overrides as wasm64posix
    # (same source code, just different arch dir name for musl's build system)
    if [ "$ARCH" = "wasm64posix" ]; then
        find "$OVERLAY_DIR/src" -type d -name wasm32posix | while read dir; do
            rel="${dir#$OVERLAY_DIR/src/}"
            parent="$(dirname "$rel")"
            rm -rf "$MUSL_DIR/src/$parent/wasm64posix"
            cp -r "$dir" "$MUSL_DIR/src/$parent/wasm64posix"
        done
    fi
fi

# Copy CRT overlay (e.g., Wasm-specific crt1.c with proper main signature)
if [ -d "$OVERLAY_DIR/crt" ]; then
    cp -r "$OVERLAY_DIR/crt/"* "$MUSL_DIR/crt/"
fi

# ---------------------------------------------------------------
# 2. Write config.mak
# ---------------------------------------------------------------
echo "==> Writing config.mak..."
cat > "$MUSL_DIR/config.mak" << EOF
ARCH = $ARCH
srcdir = .
prefix = $SYSROOT
CC = $CC --target=$TARGET
AR = $AR
RANLIB = $RANLIB
CFLAGS = -O2 -matomics -mbulk-memory -fno-exceptions -fno-trapping-math
CFLAGS_AUTO =
LDFLAGS_AUTO =
LIBCC =
# We only want the static library, not shared or tools
SHARED_LIBS =
ALL_LIBS = \$(CRT_LIBS) \$(STATIC_LIBS) \$(EMPTY_LIBS)
ALL_TOOLS =
EOF

# ---------------------------------------------------------------
# 3. Clean previous build
# ---------------------------------------------------------------
echo "==> Cleaning previous build..."
cd "$MUSL_DIR"
make clean 2>/dev/null || true

# ---------------------------------------------------------------
# 4. Build musl
# ---------------------------------------------------------------
NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)

echo "==> Building musl (pass 1: discover failures)..."

# First, try a full build and capture failures
set +e
make -j"$NJOBS" 2>&1 | tee /tmp/musl-build.log
BUILD_RC=${PIPESTATUS[0]}
set -e

if [ $BUILD_RC -ne 0 ]; then
    echo ""
    echo "==> Build had errors. Analyzing failures..."
    # Extract failing source files from the log
    grep -oE 'obj/[^ ]+\.o' /tmp/musl-build.log | sort -u | head -40
    echo ""
    echo "==> See /tmp/musl-build.log for full output"
    exit 1
fi

# ---------------------------------------------------------------
# 5. Install to sysroot
# ---------------------------------------------------------------
echo "==> Installing to sysroot..."
rm -rf "$SYSROOT"
make install

# ---------------------------------------------------------------
# 6. Build __main_void wrapper and add to libc.a
# ---------------------------------------------------------------
echo "==> Building __main_void wrapper..."
"$CC" --target=$TARGET -O2 -c \
    "$OVERLAY_DIR/src/env/__main_void.c" \
    -o "$SYSROOT/lib/__main_void.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/__main_void.o"

# ---------------------------------------------------------------
# 7. Build setjmp runtime (requires -fwasm-exceptions for __builtin_wasm_throw)
# ---------------------------------------------------------------
echo "==> Building setjmp runtime..."
"$CC" --target=$TARGET -O2 \
    -fwasm-exceptions -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -c "$OVERLAY_DIR/src/setjmp/$SETJMP_DIR/rt.c" \
    -o "$SYSROOT/lib/wasm_setjmp_rt.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/wasm_setjmp_rt.o"

# ---------------------------------------------------------------
# 8. Build sigsetjmp helpers and add to libc.a
# ---------------------------------------------------------------
echo "==> Building sigsetjmp helpers..."
"$CC" --target=$TARGET -O2 \
    -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -c "$OVERLAY_DIR/src/signal/$SIGSETJMP_DIR/sigsetjmp.c" \
    -o "$SYSROOT/lib/sigsetjmp_helpers.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/sigsetjmp_helpers.o"

# ---------------------------------------------------------------
# 9. Install override headers
# ---------------------------------------------------------------
echo "==> Installing override headers..."
bash "$REPO_ROOT/scripts/install-overlay-headers.sh" "$SYSROOT"

# ---------------------------------------------------------------
# 10. Install libdrm (upstream 2.4.120, KMS subset only).
#     Recipe at packages/registry/libdrm/; the dep-resolver compiles
#     xf86drm.c / xf86drmMode.c / xf86drmHash.c / xf86drmRandom.c
#     into libdrm.a and stages the UAPI + public headers under a
#     cached prefix. We symlink the artifacts into the sysroot so
#     `-ldrm` resolves and the headers are visible at
#     `$SYSROOT/include/drm/` and `$SYSROOT/include/libdrm/`.
# ---------------------------------------------------------------
echo "==> Resolving libdrm (upstream KMS subset)..."
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libdrm >/dev/null)
LIBDRM_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libdrm)"
if [ ! -f "$LIBDRM_PREFIX/lib/libdrm.a" ]; then
    echo "Error: libdrm resolve succeeded but $LIBDRM_PREFIX/lib/libdrm.a is missing." >&2
    exit 1
fi
ln -sf "$LIBDRM_PREFIX/lib/libdrm.a" "$SYSROOT/lib/libdrm.a"
rm -rf "$SYSROOT/include/drm" "$SYSROOT/include/libdrm"
ln -sfn "$LIBDRM_PREFIX/include/drm"    "$SYSROOT/include/drm"
ln -sfn "$LIBDRM_PREFIX/include/libdrm" "$SYSROOT/include/libdrm"

# ---------------------------------------------------------------
# 11. Build libgbm static archive (DRI buffer-object shim).
#     Implementation: libc/glue/libgbm_stub.c.
#     Header:         libc/musl-overlay/include/gbm.h.
#     Consumers link with -lgbm -ldrm (gbm wraps drm ioctls).
#     `-I$SYSROOT/include/libdrm` matches upstream's pkg-config
#     `--cflags` so `#include <xf86drm.h>` resolves to the file
#     under `$SYSROOT/include/libdrm/`. `-I$SYSROOT/include/drm`
#     resolves the bare `#include <drm.h>` xf86drm.h itself emits
#     (libdrm vendors the UAPI headers under `include/drm/` and
#     expects that directory on the search path).
# ---------------------------------------------------------------
echo "==> Building libgbm static archive..."
"$CC" --target=$TARGET -O2 \
    -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -I"$SYSROOT/include/libdrm" \
    -I"$SYSROOT/include/drm" \
    -c "$REPO_ROOT/libc/glue/libgbm_stub.c" \
    -o "$SYSROOT/lib/libgbm_stub.o"
"$AR" rcs "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libgbm_stub.o"

# ---------------------------------------------------------------
# 11b. Build libEGL + libGLESv2 static archives (in-tree stubs).
#      Implementation: libc/glue/libegl_stub.c + libglesv2_stub.c.
#      Shared header:  libc/glue/gl_abi.h.
#      Consumers (SDL2 KMSDRM, the gltri demo) link
#      `-lEGL -lGLESv2`; both archives talk to the kernel through
#      the GLIO_* ioctls on /dev/dri/renderD128 and share state via
#      the three accessor functions in gl_abi.h (resolved at link
#      time when both archives are pulled in).
#      In-tree-stub approach mirrors libgbm above; the alternative
#      of three out-of-tree packages (libegl-stub / libgles2-stub /
#      libgbm-extended) was rejected as needless ceremony for code
#      that's already first-party in libc/glue/.
# ---------------------------------------------------------------
echo "==> Building libEGL static archive..."
"$CC" --target=$TARGET -O2 \
    -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -I"$REPO_ROOT/libc/glue" \
    -c "$REPO_ROOT/libc/glue/libegl_stub.c" \
    -o "$SYSROOT/lib/libegl_stub.o"
"$AR" rcs "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libegl_stub.o"

echo "==> Building libGLESv2 static archive..."
"$CC" --target=$TARGET -O2 \
    -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -I"$REPO_ROOT/libc/glue" \
    -c "$REPO_ROOT/libc/glue/libglesv2_stub.c" \
    -o "$SYSROOT/lib/libglesv2_stub.o"
"$AR" rcs "$SYSROOT/lib/libGLESv2.a" "$SYSROOT/lib/libglesv2_stub.o"

# ---------------------------------------------------------------
# 12. Install libinput-lite (in-tree no-op stub).
#     Recipe at packages/registry/libinput-lite/. SDL2 2.30's
#     configure probes for <libinput.h>; the stub satisfies the
#     probe without pulling in a real libinput, and every entry
#     point returns NULL so SDL2 falls back to its direct evdev
#     backend (plan 5).
# ---------------------------------------------------------------
echo "==> Resolving libinput-lite (in-tree no-op stub)..."
LIBINPUT_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libinput-lite >/dev/null && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libinput-lite)"
if [ ! -f "$LIBINPUT_PREFIX/lib/libinput.a" ]; then
    echo "Error: libinput-lite resolve succeeded but $LIBINPUT_PREFIX/lib/libinput.a is missing." >&2
    exit 1
fi
ln -sf "$LIBINPUT_PREFIX/lib/libinput.a"      "$SYSROOT/lib/libinput.a"
ln -sf "$LIBINPUT_PREFIX/include/libinput.h"  "$SYSROOT/include/libinput.h"

# ---------------------------------------------------------------
# 13. Install alsa-lib (PCM-hardware-direct subset).
#     Recipe at packages/registry/alsa-lib/. Wraps the kernel's
#     SNDRV_PCM_IOCTL_* surface (crates/kernel/src/audio/pcm_ioctl.rs)
#     in libasound's snd_pcm_* / snd_ctl_* API so SDL2's audio
#     backend (src/audio/alsa/SDL_alsa_audio.c) and other consumers
#     get a familiar dependency. The subset bypasses upstream's
#     snd_config_* configuration tree via 0001-default-to-hw00.patch;
#     "default" / "hw[:N,M]" / "plughw[:N,M]" route straight to
#     /dev/snd/pcmC0D0p.
# ---------------------------------------------------------------
echo "==> Resolving alsa-lib (PCM-hw-direct subset)..."
ALSA_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve alsa-lib >/dev/null && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path alsa-lib)"
if [ ! -f "$ALSA_PREFIX/lib/libasound.a" ]; then
    echo "Error: alsa-lib resolve succeeded but $ALSA_PREFIX/lib/libasound.a is missing." >&2
    exit 1
fi
ln -sf "$ALSA_PREFIX/lib/libasound.a" "$SYSROOT/lib/libasound.a"
ln -sf "$ALSA_PREFIX/include/alsa"    "$SYSROOT/include/alsa"
# install-overlay-headers.sh installed the in-tree subset of
# <sound/asound.h> at sysroot/include/sound/asound.h. Replace the
# entire directory with alsa-lib's vendored upstream UAPI so that
# both kernel-direct consumers and libasound-linked consumers see
# the same set of struct definitions. The overlay header was a
# strict subset of upstream; layouts agree on the fields the
# kernel marshals (see libc/musl-overlay/include/sound/asound.h
# header comment).
rm -rf "$SYSROOT/include/sound"
ln -sf "$ALSA_PREFIX/include/sound"   "$SYSROOT/include/sound"

echo ""
echo "==> musl build complete!"
echo "    Sysroot: $SYSROOT"
echo "    libc.a:  $SYSROOT/lib/libc.a"
ls -la "$SYSROOT/lib/libc.a" 2>/dev/null || echo "    WARNING: libc.a not found!"
