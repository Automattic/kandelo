#!/usr/bin/env bash
#
# Build alsa-lib (libasound.a) — PCM-hardware-direct subset — for
# wasm32-posix-kernel. Wraps the kernel's SNDRV_PCM_IOCTL_* surface
# (crates/kernel/src/audio/pcm_ioctl.rs) in the standard libasound
# API (snd_pcm_open, snd_pcm_hw_params_*, snd_pcm_writei) that SDL2's
# audio backend (src/audio/alsa/SDL_alsa_audio.c) calls.
#
# We bypass upstream's autoconf + libtool dance — it does host-side
# feature probes that misreport against the wasm sysroot, and the
# libtool dance does not cross-compile cleanly. Instead:
#   * Apply patches/0001-default-to-hw00.patch — replaces the body of
#     snd_pcm_open_noupdate so it bypasses snd_config_search_definition
#     (which would otherwise pull in conf.c, confmisc.c, parser.c, ...)
#     and calls snd_pcm_hw_open() directly.
#   * Apply patches/0002-wasm-attribute-alias.patch — replaces
#     alsa-symbols.h's ELF .weak/.set inline-asm symbol-aliasing
#     macros (which wasm-ld doesn't implement) with
#     __attribute__((weak, alias)).
#   * Use the hand-curated src/config.h as the autoconf-generated
#     replacement.
#   * Compile only the PCM-direct subset (10 .c files), plus our
#     src/conf_stubs.c which provides -ENOSYS stubs for the
#     snd_config_*/snd_async_*/snd_output_* symbols the elided
#     TUs would normally satisfy.
#   * Archive into libasound.a.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve alsa-lib`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to install lib/ + include/
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/alsa-lib-src"

ALSA_VERSION="${WASM_POSIX_DEP_VERSION:-${ALSA_VERSION:-1.2.10}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/alsa-lib-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.alsa-project.org/files/pub/lib/alsa-lib-${ALSA_VERSION}.tar.bz2}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi
if ! command -v wasm32posix-ar &>/dev/null; then
    echo "ERROR: wasm32posix-ar not found." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading alsa-lib $ALSA_VERSION..."
    TARBALL="/tmp/alsa-lib-${ALSA_VERSION}.tar.bz2"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xjf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"

    # --- Apply patches ---
    echo "==> Applying patches..."
    for p in "$SCRIPT_DIR"/patches/*.patch; do
        [ -e "$p" ] || continue
        echo "    $(basename "$p")"
        patch -p1 -d "$SRC_DIR" < "$p"
    done

    # --- Install hand-curated config.h (replaces autoconf output) ---
    cp "$SCRIPT_DIR/src/config.h" "$SRC_DIR/include/config.h"
fi

# Fresh build + install dir each run — cache key varies per build and
# stale objects would shadow header changes.
BUILD_DIR="$SCRIPT_DIR/alsa-lib-build"
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/include/alsa" \
         "$INSTALL_DIR/include/sound"

# --- Compile ---
# The subset's translation units. Each .c file lives at the path
# below relative to $SRC_DIR. The conf_stubs.c TU lives outside the
# tarball (under $SCRIPT_DIR/src) and provides ENOSYS-returning
# stubs for the snd_config_*/snd_async_*/snd_output_* symbols the
# elided TUs would have satisfied.
SUBSET_TUS=(
    src/pcm/pcm.c
    src/pcm/pcm_hw.c
    src/pcm/pcm_misc.c
    src/pcm/pcm_params.c
    src/pcm/pcm_mmap.c
    src/pcm/interval.c
    src/pcm/mask.c
    src/control/control.c
    src/control/control_hw.c
    src/error.c
    src/dlmisc.c
)

CFLAGS=(
    -O2 -fPIC -std=gnu11
    -DPIC
    -DHAVE_CONFIG_H
    -D_GNU_SOURCE
    "-I$SRC_DIR/include"
    "-I$SRC_DIR/src"
    "-I$SRC_DIR/src/pcm"
    "-I$SRC_DIR/src/control"
    # Quiet a few benign warnings from upstream code that we don't
    # want to escalate via -Werror — the subset already builds with
    # extra-warnings-off.
    -Wno-unused-but-set-variable
    -Wno-unused-function
    -Wno-unused-parameter
    -Wno-unused-variable
    -Wno-deprecated-declarations
)

echo "==> Compiling alsa-lib PCM-direct subset..."
OBJS=()
for tu in "${SUBSET_TUS[@]}"; do
    src="$SRC_DIR/$tu"
    obj="$BUILD_DIR/$(echo "$tu" | tr '/' '_' | sed 's/\.c$/.o/')"
    echo "    $tu"
    wasm32posix-cc -c "${CFLAGS[@]}" "$src" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Compiling conf_stubs.c (ENOSYS shims for elided TUs)..."
wasm32posix-cc -c "${CFLAGS[@]}" "$SCRIPT_DIR/src/conf_stubs.c" \
    -o "$BUILD_DIR/conf_stubs.o"
OBJS+=("$BUILD_DIR/conf_stubs.o")

echo "==> Archiving libasound.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libasound.a" "${OBJS[@]}"

# --- Install headers ---
# Public headers under include/alsa/ for #include <alsa/asoundlib.h>.
# Tarball's include/alsa is a symlink to .; copy the actual *.h files
# from include/ into a real directory so consumers don't follow a
# dangling link out of the cache.
echo "==> Installing headers..."
for h in "$SRC_DIR"/include/*.h; do
    cp "$h" "$INSTALL_DIR/include/alsa/"
done
# Linux UAPI for ALSA (sound/asound.h, sound/asequencer.h, ...) —
# alsa-lib's public headers (alsa/pcm.h, alsa/control.h, ...)
# #include <sound/asound.h>, so it has to land in include/sound/.
# The top-level sound/asound.h is a 4-line stub that pulls in
# <alsa/sound/uapi/asound.h>, so the uapi/ subdir holds the real
# ioctl/struct definitions — install both layers.
for h in "$SRC_DIR"/include/sound/*.h; do
    cp "$h" "$INSTALL_DIR/include/sound/"
done
mkdir -p "$INSTALL_DIR/include/sound/uapi"
for h in "$SRC_DIR"/include/sound/uapi/*.h; do
    cp "$h" "$INSTALL_DIR/include/sound/uapi/"
done

echo "==> alsa-lib $ALSA_VERSION (subset) installed at $INSTALL_DIR"
echo "    lib/libasound.a ($(wc -c < "$INSTALL_DIR/lib/libasound.a") bytes)"
