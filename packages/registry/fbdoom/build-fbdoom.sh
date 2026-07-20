#!/usr/bin/env bash
# Cross-compile maximevince/fbDOOM for Kandelo using wasm32posix-cc. The
# fbdev frontend writes BGRA32 pixels into the framebuffer mmap; the canvas
# renderer consumes them.
#
# A direct build writes packages/registry/fbdoom/fbdoom.wasm. Resolver and
# Formula builds instead write only below their declared work and output roots.
#
# Usage: bash packages/registry/fbdoom/build-fbdoom.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/fbdoom-src"
CDOOM_SRC="$WORK_DIR/chocolate-doom-src"
OUT_BIN="$WORK_DIR/fbdoom.wasm"

# fbDOOM has no release tarball, so pin the exact upstream commit represented
# by both the package manifest and Homebrew Formula. fbDOOM removed its
# OPL/MIDI/MUS sources with SDL; pin chocolate-doom 3.1.0 for those files.
FBDOOM_COMMIT="17280163bc95e5d954d2efaa0633489b763b4cd1"
FBDOOM_SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/maximevince/fbDOOM/archive/${FBDOOM_COMMIT}.tar.gz}"
FBDOOM_SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-77f57cee68fed438dffdba96f6070b8975c16652a63ddf4fb967994e5585a38a}"
FBDOOM_VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
CDOOM_COMMIT="35fb1372d10756ca27eca05665bd8a7cebc71c05"
CDOOM_SOURCE_URL="${FBDOOM_CHOCOLATE_DOOM_SOURCE_URL:-https://github.com/chocolate-doom/chocolate-doom/archive/${CDOOM_COMMIT}.tar.gz}"
CDOOM_SOURCE_SHA256="${FBDOOM_CHOCOLATE_DOOM_SOURCE_SHA256:-dc62c13cab469e19e0ad295b2dd7e460263c637a39c51d3771e96dabb08ecab2}"
CDOOM_VERIFIED_SOURCE_DIR="${FBDOOM_CHOCOLATE_DOOM_SOURCE_DIR:-}"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

patch_set_sha256="$(shasum -a 256 "$HERE"/patches/*.patch | shasum -a 256 | awk '{print $1}')"
source_marker="$SRC/.kandelo-fbdoom-source"
expected_source_marker="$(printf '%s\n%s\n%s\n%s' \
    "$FBDOOM_COMMIT" "$FBDOOM_SOURCE_URL" "$FBDOOM_SOURCE_SHA256" "$patch_set_sha256")"
if [ -d "$SRC" ] && [ "$(cat "$source_marker" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC" "$OUT_BIN"
fi
if [ ! -d "$SRC" ]; then
    echo "==> Staging pinned fbDOOM source..."
    kandelo_package_stage_verified_source fbdoom "$SRC" \
        "$FBDOOM_VERIFIED_SOURCE_DIR" "$FBDOOM_SOURCE_URL" \
        "$FBDOOM_SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" > "$source_marker"
fi

cdoom_marker="$CDOOM_SRC/.kandelo-chocolate-doom-source"
expected_cdoom_marker="$(printf '%s\n%s\n%s' \
    "$CDOOM_COMMIT" "$CDOOM_SOURCE_URL" "$CDOOM_SOURCE_SHA256")"
if [ -d "$CDOOM_SRC" ] && [ "$(cat "$cdoom_marker" 2>/dev/null || true)" != "$expected_cdoom_marker" ]; then
    rm -rf "$CDOOM_SRC"
fi
if [ ! -d "$CDOOM_SRC" ]; then
    echo "==> Staging pinned chocolate-doom music source..."
    kandelo_package_stage_verified_source chocolate-doom "$CDOOM_SRC" \
        "$CDOOM_VERIFIED_SOURCE_DIR" "$CDOOM_SOURCE_URL" \
        "$CDOOM_SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_cdoom_marker" > "$cdoom_marker"
fi

# Sentinel: last file added by patches/0005-add-music-support.patch. If it is
# present, the source tree is already fully vendored and patched. Re-vendoring
# would clobber the earlier patch's edits to these imported sources.
SENTINEL="$SRC/fbdoom/opl/opl_kernel.c"

apply_patches() {
    local mode="${1:-strict}"
    local name patch_file
    echo "==> Applying patches..."
    for patch_file in "$HERE/patches/"*.patch; do
        [ -f "$patch_file" ] || continue
        name="$(basename "$patch_file")"
        if kandelo_package_git_apply_patch "$SRC" "$patch_file" check \
            >/dev/null 2>&1; then
            echo "    $name"
            kandelo_package_git_apply_patch "$SRC" "$patch_file"
        elif [ "$mode" = "lenient" ]; then
            echo "    $name (already applied or superseded)"
        else
            echo "ERROR: patch $name does not apply cleanly" >&2
            exit 1
        fi
    done
}

if [ -e "$SENTINEL" ]; then
    echo "==> Source tree already vendored (sentinel present); checking patches."
    apply_patches lenient
else
    echo "==> Vendoring OPL/MIDI/MUS sources from chocolate-doom..."
    mkdir -p "$SRC/fbdoom/opl"
    for file in opl.c opl.h opl3.c opl3.h opl_internal.h opl_queue.c opl_queue.h; do
        cp "$CDOOM_SRC/opl/$file" "$SRC/fbdoom/opl/$file"
    done
    for file in mus2mid.c mus2mid.h midifile.c midifile.h; do
        cp "$CDOOM_SRC/src/$file" "$SRC/fbdoom/$file"
    done

    apply_patches strict
fi

# Use this worktree's SDK and sysroot rather than a global npm link, which may
# point at a sibling worktree without Kandelo's linux/fb.h overlay.
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

cd "$SRC/fbdoom"

echo "==> Cleaning previous build..."
make clean || true

echo "==> Cross-compiling fbdoom (wasm32, NOSDL=1)..."
# fbDOOM's Makefile wires NOSDL=1 to the framebuffer and null-audio frontend.
# Passing -lc explicitly would duplicate the SDK-injected channel syscall glue;
# retain -lm because the SDK does not inject libm.
make CC=wasm32posix-cc \
     LD=wasm32posix-cc \
     CFLAGS="-O2 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE -Iopl" \
     LDFLAGS="" \
     LIBS="-lm" \
     NOSDL=1

cp fbdoom "$OUT_BIN"

# fbDOOM does not fork, so it must remain free of fork instrumentation.
ls -la "$OUT_BIN"
echo "==> fbdoom.wasm built."

# No IWAD is bundled. The browser demo fetches the freely redistributable Doom
# shareware IWAD at page load and caches it via the Cache API.
cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary fbdoom "$OUT_BIN" fbdoom.wasm
