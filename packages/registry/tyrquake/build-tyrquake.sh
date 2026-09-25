#!/usr/bin/env bash
# Cross-compile TyrQuake (software renderer, tyr-quake) for Kandelo using
# wasm32posix-cc. Added vid_fbdev/in_fbdev backends write BGRA32 to the
# /dev/fb0 mmap and read MEDIUMRAW keyboard + /dev/input/mice; the engine's
# existing snd_oss backend writes PCM to /dev/dsp.
#
# A direct build writes packages/registry/tyrquake/quake.wasm. Resolver and
# Formula builds instead write only below their declared work and output roots.
#
# Usage: bash packages/registry/tyrquake/build-tyrquake.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/tyrquake-src"
OUT_BIN="$WORK_DIR/quake.wasm"

# Upstream publishes tags, not release tarballs. Pin the exact commit archive
# the v0.71 tag dereferences to; the sha256 makes it byte-verifiable.
TYRQUAKE_COMMIT="52c707768f7e9b118b1517476c65a7c87a929602"
TYRQUAKE_SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/sezero/tyrquake/archive/${TYRQUAKE_COMMIT}.tar.gz}"
TYRQUAKE_SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-178bfcd6f571c966be7949988af7b0ad6a83cb847c098a17923e1c876663a63c}"
TYRQUAKE_VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

if compgen -G "$HERE/patches/*.patch" > /dev/null; then
    patch_set_sha256="$(shasum -a 256 "$HERE"/patches/*.patch | shasum -a 256 | awk '{print $1}')"
else
    patch_set_sha256="none"
fi
source_marker="$SRC/.kandelo-tyrquake-source"
expected_source_marker="$(printf '%s\n%s\n%s\n%s' \
    "$TYRQUAKE_COMMIT" "$TYRQUAKE_SOURCE_URL" "$TYRQUAKE_SOURCE_SHA256" "$patch_set_sha256")"
if [ -d "$SRC" ] && [ "$(cat "$source_marker" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC" "$OUT_BIN"
fi
if [ ! -d "$SRC" ]; then
    echo "==> Staging pinned TyrQuake source..."
    kandelo_package_stage_verified_source tyrquake "$SRC" \
        "$TYRQUAKE_VERIFIED_SOURCE_DIR" "$TYRQUAKE_SOURCE_URL" \
        "$TYRQUAKE_SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" > "$source_marker"
fi

apply_patches() {
    local patch_file name
    echo "==> Applying patches..."
    for patch_file in "$HERE/patches/"*.patch; do
        [ -f "$patch_file" ] || continue
        name="$(basename "$patch_file")"
        if kandelo_package_git_apply_patch "$SRC" "$patch_file" check \
            >/dev/null 2>&1; then
            echo "    $name"
            kandelo_package_git_apply_patch "$SRC" "$patch_file"
        else
            echo "    $name (already applied or superseded)"
        fi
    done
}
apply_patches

# --- TASK 2+ appends the SDK activation, make invocation, and install here ---
echo "staged"
exit 0
