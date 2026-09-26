#!/usr/bin/env bash
# Build upstream FFmpeg n9.0 as Kandelo programs: ffmpeg, ffprobe, ffplay.
#
# Resolver builds write only below the resolver's work and output roots.
# A direct build (bash build-ffmpeg.sh) resolves its dependencies through
# the resolver and keeps its tree at packages/registry/ffmpeg/ffmpeg-src,
# which the hand-run aperture rungs reuse (design §7).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/ffmpeg-src"

# Fork instrumentation follows each output's declared policy (`auto`):
# install_local_binary instruments exactly the programs that import
# kernel_fork. ffplay does, through SDL2; ffmpeg and ffprobe do not.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-7f607a00dd0d28a729d5a4811205812eef01cf6ef6155025febb6f36a9062d52}"

# Direct builds ask the resolver for each declared dependency.
dep_dir() {
    local var="WASM_POSIX_DEP_$1_DIR"
    if [ -n "${!var:-}" ]; then
        printf '%s\n' "${!var}"
    else
        local host_target
        host_target="$(rustc -vV | awk '/^host/ {print $2}')"
        (cd "$REPO_ROOT" && cargo run -p xtask --target "$host_target" --quiet -- \
            build-deps resolve "$2" | tail -1)
    fi
}
ZLIB_PREFIX="$(dep_dir ZLIB zlib)"
LIBICONV_PREFIX="$(dep_dir LIBICONV libiconv)"
LIBXML2_PREFIX="$(dep_dir LIBXML2 libxml2)"
SDL2_PREFIX="$(dep_dir SDL2 sdl2)"
export ZLIB_PREFIX LIBICONV_PREFIX LIBXML2_PREFIX SDL2_PREFIX

rm -rf "$SRC"
echo "==> Staging verified FFmpeg source"
kandelo_package_stage_verified_source ffmpeg "$SRC" "${WASM_POSIX_DEP_SOURCE_DIR:-}" \
    "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

# shellcheck source=/dev/null
source "$HERE/configure-flags.sh"
ffmpeg_configure_env
ffmpeg_configure_flags target

cd "$SRC"
echo "==> Configuring FFmpeg (target configure, design §5)"
if ! ./configure "${FFMPEG_CONFIGURE_FLAGS[@]}"; then
    tail -40 ffbuild/config.log >&2
    exit 1
fi
bash "$HERE/audit-configure.sh" config "$SRC" "$WASM_POSIX_SYSROOT"

echo "==> Building ffmpeg, ffprobe, ffplay"
make -j"$(getconf _NPROCESSORS_ONLN)" ffmpeg ffprobe ffplay

OUT_STAGE="$WORK_DIR/ffmpeg-dist"
rm -rf "$OUT_STAGE"; mkdir -p "$OUT_STAGE"
for p in ffmpeg ffprobe ffplay; do
    cp "$p" "$OUT_STAGE/$p.wasm"
    bash "$HERE/audit-configure.sh" link "$OUT_STAGE/$p.wasm"
done
ls -l "$OUT_STAGE"

cd "$REPO_ROOT"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
for p in ffmpeg ffprobe ffplay; do
    install_local_binary ffmpeg "$OUT_STAGE/$p.wasm" "$p.wasm"
done
