#!/usr/bin/env bash
# Ship the `ffmpeg` package's manual pages as ffmpeg-docs.zip, a lazy
# archive mounted at /usr/.
#
# Upstream writes them in Texinfo and renders them during its own build:
# configure records the enabled libraries (doc/config.texi), a helper
# built for the build machine prints the codec and format option tables
# (doc/print_options), texi2pod.pl turns each page into POD and pod2man
# into troff. This configures FFmpeg exactly as build-ffmpeg.sh does,
# through the shared configure-flags.sh, and runs upstream's own make
# rules for the section 1 pages its install-man step installs: the three
# programs, their -all variants and the per-library component pages.
# Section 3 (library API) pages are not shipped. pod2man is given a blank
# date by upstream, so the pages carry none.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
FFMPEG_RECIPE="$REPO_ROOT/packages/registry/ffmpeg"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

# configure probes the same dependencies the ffmpeg package builds with.
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
LIBWAYLAND_PREFIX="$(dep_dir LIBWAYLAND libwayland)"
LIBXKBCOMMON_PREFIX="$(dep_dir LIBXKBCOMMON libxkbcommon)"
LIBFFI_PREFIX="$(dep_dir LIBFFI libffi)"
export ZLIB_PREFIX LIBICONV_PREFIX LIBXML2_PREFIX SDL2_PREFIX
export LIBWAYLAND_PREFIX LIBXKBCOMMON_PREFIX LIBFFI_PREFIX

# shellcheck source=/dev/null
source "$FFMPEG_RECIPE/configure-flags.sh"
ffmpeg_configure_env
ffmpeg_configure_flags target

WORK="$KANDELO_PACKAGE_WORK_DIR"
cd "$SRC"
if ! ./configure "${FFMPEG_CONFIGURE_FLAGS[@]}" > "$WORK/configure.log" 2>&1; then
    tail -40 ffbuild/config.log >&2
    exit 1
fi

PROGRAMS=(ffmpeg ffprobe ffplay)
# doc/Makefile's COMPONENTS for the libraries configure enabled.
COMPONENTS=(ffmpeg-utils ffmpeg-scaler ffmpeg-resampler ffmpeg-codecs
    ffmpeg-bitstream-filters ffmpeg-formats ffmpeg-protocols ffmpeg-devices
    ffmpeg-filters)
pages=()
for p in "${PROGRAMS[@]}"; do pages+=("doc/$p.1" "doc/$p-all.1"); done
for c in "${COMPONENTS[@]}"; do pages+=("doc/$c.1"); done
# The list must be what upstream would install: compare it with
# install-man's MANPAGES1 for this configuration. (Reading the Makefile
# first regenerates its included files, which prints GEN lines.)
installed="$(make -s -f - print-manpages1 <<'MK' | tail -1
include Makefile
print-manpages1:
	@echo $(sort $(MANPAGES1))
MK
)"
listed="$(printf '%s\n' "${pages[@]}" | LC_ALL=C sort | tr '\n' ' ')"
if [ "$installed " != "$listed" ]; then
    echo "build-ffmpeg-docs: upstream installs: $installed" >&2
    echo "build-ffmpeg-docs: this script lists: $listed" >&2
    exit 1
fi
make -j4 "${pages[@]}" > "$WORK/make-doc.log" 2>&1 || {
    tail -40 "$WORK/make-doc.log" >&2
    exit 1
}

install_package_man_pages ffmpeg-docs "$SRC" "${pages[@]}"
