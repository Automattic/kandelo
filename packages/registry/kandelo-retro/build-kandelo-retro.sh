#!/usr/bin/env bash
# Build the three kandelo-retro programs and install their starter ROMs.
#
# One core-agnostic frontend (frontend/main.c) is linked statically against
# each libretro core. FCEUmm is this package's primary, hash-verified source;
# Genesis Plus GX, Snes9x and two of the ROM archives are source-kind direct
# dependencies the resolver verifies and extracts. Every tree is copied into
# this build's private work root before its Makefile runs.
#
# Honors the dep-resolver build-script contract; see
# docs/package-management.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"

: "${WASM_POSIX_DEP_WORK_DIR:?kandelo-retro is built through the package resolver (no work root)}"
: "${WASM_POSIX_DEP_OUT_DIR:?kandelo-retro is built through the package resolver (no output root)}"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"

# A resolver caller owns the declared work and output roots. Keep the reviewed
# checkout read-only and suppress the developer-only local mirror. None of the
# three programs forks, so none is fork-instrumented.
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?resolver did not provide the direct zlib dependency}"
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?resolver did not provide the direct libcxx dependency}"
GENESIS_SOURCE="$(kandelo_package_source_dependency_dir genesis-plus-gx-source)"
SNES9X_SOURCE="$(kandelo_package_source_dependency_dir snes9x-source)"
MD_ROM_SOURCE="$(kandelo_package_source_dependency_dir retro-rom-240p-md)"
SNES_ROM_SOURCE="$(kandelo_package_source_dependency_dir retro-rom-240p-snes)"

FCEUMM_COMMIT="0d610d9a6401697157f693a5407adf450a0e52fb"
FCEUMM_SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/libretro/libretro-fceumm/archive/${FCEUMM_COMMIT}.tar.gz}"
FCEUMM_SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-fa4bd76278221ea5416da3085559ea4473c37f305bc96f804c79a3937207f0a1}"
# The upstream Makefiles report `git describe` output as the core version.
# There is no checkout here, so pass the pinned commits. The quotes keep the
# leading space each Makefile expects inside its GIT_VERSION definition.
FCEUMM_CORE_VERSION='" 0d610d9"'
GENESIS_CORE_VERSION='" fa4dca56"'
SNES9X_CORE_VERSION='" 185488cd"'

# The NES starter ROM. Upstream publishes it only as a bare release asset, and
# a bare file is not an archive the resolver's source provider can extract, so
# this one input is fetched here and checked against its pinned digest. The
# other two ROMs arrive as verified source-kind dependencies.
NES_ROM_URL="https://github.com/pinobatch/240p-test-mini/releases/download/v0.23/240pee.nes"
NES_ROM_SHA256="04f01d7372f66ea2befe325b9bd655a9fcc395a31fa46d9466286bb8f9d2e62e"
MD_ROM_SHA256="1776009ab324c18e4f046b4781fed11b897281f407ec04f2ac43649bcebae28f"
SNES_ROM_SHA256="404917504fe5e3bcd070d9527fafdd6eeaf04dee75b4010792907499d536c22a"

require_file() {
    if [ ! -f "$1" ]; then
        echo "ERROR: required build input missing: $1" >&2
        exit 1
    fi
}

require_sha256() {
    local file="$1" expected="$2" actual
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    if [ "$actual" != "$expected" ]; then
        echo "ERROR: sha256 mismatch for $file" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
}

require_file "$GENESIS_SOURCE/Makefile.libretro"
require_file "$GENESIS_SOURCE/LICENSE.txt"
require_file "$SNES9X_SOURCE/libretro/Makefile"
require_file "$SNES9X_SOURCE/LICENSE"
require_file "$MD_ROM_SOURCE/240pSuite-1.21.bin"
require_file "$SNES_ROM_SOURCE/240pSuite.sfc"
require_file "$SNES_ROM_SOURCE/GPLv2.txt"
require_file "$ZLIB_PREFIX/include/zlib.h"
require_file "$ZLIB_PREFIX/lib/libz.a"
require_file "$LIBCXX_PREFIX/lib/libc++.a"
require_file "$LIBCXX_PREFIX/lib/libc++abi.a"
require_file "$HERE/LICENSE-MAP.md"
if [ ! -d "$LIBCXX_PREFIX/include/c++/v1" ]; then
    echo "ERROR: libcxx headers missing under $LIBCXX_PREFIX" >&2
    exit 1
fi

FCEUMM_SRC="$WORK_DIR/fceumm"
GENESIS_SRC="$WORK_DIR/genesis-plus-gx"
SNES9X_SRC="$WORK_DIR/snes9x"
STAGE="$WORK_DIR/stage"
rm -rf "$FCEUMM_SRC" "$GENESIS_SRC" "$SNES9X_SRC" "$STAGE"
mkdir -p "$STAGE/roms" "$STAGE/licenses"

echo "==> Staging pinned FCEUmm source..."
kandelo_package_stage_verified_source fceumm "$FCEUMM_SRC" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$FCEUMM_SOURCE_URL" \
    "$FCEUMM_SOURCE_SHA256" "$WORK_DIR"
mkdir -p "$GENESIS_SRC" "$SNES9X_SRC"
cp -R "$GENESIS_SOURCE/." "$GENESIS_SRC/"
cp -R "$SNES9X_SOURCE/." "$SNES9X_SRC/"
chmod -R u+w "$GENESIS_SRC" "$SNES9X_SRC"
require_file "$FCEUMM_SRC/Makefile"
require_file "$FCEUMM_SRC/Copying"

# Use this worktree's SDK and base sysroot. Package libraries are not staged
# into that sysroot; their resolver prefixes are passed explicitly below.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

# libretro-common sources a static frontend must provide. A core built with
# STATIC_LINKING=1 leaves these objects out, on the assumption that the
# frontend (normally RetroArch) supplies them. Cores vendor different
# snapshots, so compile whichever of these the selected core tree has.
LRC_SUPPORT_CANDIDATES=(
    compat/compat_posix_string.c
    compat/compat_snprintf.c
    compat/compat_strcasestr.c
    compat/compat_strl.c
    compat/fopen_utf8.c
    encodings/encoding_utf.c
    file/file_path.c
    file/file_path_io.c
    file/retro_dirent.c
    streams/file_stream.c
    streams/file_stream_transforms.c
    string/stdstring.c
    time/rtime.c
    vfs/vfs_implementation.c
)

link_binary() {
    local out="$1" archive="$2" incdir="$3" lrc="$4"
    shift 4
    local compile_inputs=("$HERE/frontend/main.c")
    local candidate
    if [ -n "$lrc" ]; then
        for candidate in "${LRC_SUPPORT_CANDIDATES[@]}"; do
            if [ -f "$lrc/$candidate" ]; then
                compile_inputs+=("$lrc/$candidate")
            fi
        done
    fi

    echo "==> Linking $(basename "$out")..."
    wasm32posix-cc -O2 -Wall \
        -ffile-prefix-map="$WORK_DIR"=/usr/src/kandelo-retro \
        -ffile-prefix-map="$HERE"=/usr/src/kandelo-retro \
        -I"$incdir" \
        "${compile_inputs[@]}" \
        "$archive" \
        -lm "$@" \
        -o "$out"

    # The SDK links with --allow-undefined, so a symbol nobody defines becomes
    # a wasm import that traps when called, and the kernel reports that trap
    # as a segmentation fault. Fail the build instead.
    local unresolved
    unresolved="$(wasm32posix-nm "$out" 2>/dev/null \
        | awk '$1=="U"{print $2}' | grep -v '^kernel_' | grep -v '__channel_base' || true)"
    if [ -n "$unresolved" ]; then
        echo "ERROR: unresolved non-kernel wasm imports in $(basename "$out"):" >&2
        echo "$unresolved" >&2
        exit 1
    fi
}

make_core_archive() {
    local src="$1" makefile="$2" archive_name="$3" dest="$4"
    shift 4
    local jobs
    jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
    # platform=unix only stops the Makefiles from detecting the build host
    # (they would pick macOS rules on a Mac). Its -fPIC and -shared defaults
    # are switched off: the cores are archived, not linked as shared objects.
    make -C "$src" -f "$makefile" -j"$jobs" \
        platform=unix STATIC_LINKING=1 fpic= SHARED= \
        CC=wasm32posix-cc CXX=wasm32posix-c++ AR=wasm32posix-ar "$@"
    if [ ! -f "$src/$archive_name" ] || [ "$(head -c7 "$src/$archive_name")" != "!<arch>" ]; then
        echo "ERROR: static archive $archive_name not found or not an archive" >&2
        exit 1
    fi
    cp "$src/$archive_name" "$dest"
}

echo "==> Building FCEUmm core..."
make_core_archive "$FCEUMM_SRC" "Makefile" "fceumm_libretro.so" \
    "$WORK_DIR/libfceumm.a" \
    EXTERNAL_ZLIB=1 WANT_32BPP=1 GIT_VERSION="$FCEUMM_CORE_VERSION"
FCEUMM_LRC="$FCEUMM_SRC/src/drivers/libretro/libretro-common"
link_binary "$STAGE/kandelo-retro.wasm" "$WORK_DIR/libfceumm.a" \
    "$FCEUMM_LRC/include" "$FCEUMM_LRC"

echo "==> Building Genesis Plus GX core..."
make_core_archive "$GENESIS_SRC" "Makefile.libretro" "genesis_plus_gx_libretro.so" \
    "$WORK_DIR/libgenesis_plus_gx.a" \
    GIT_VERSION="$GENESIS_CORE_VERSION"
GENESIS_LRC="$GENESIS_SRC/libretro/libretro-common"
link_binary "$STAGE/kandelo-retro-genesis.wasm" "$WORK_DIR/libgenesis_plus_gx.a" \
    "$GENESIS_LRC/include" "$GENESIS_LRC" \
    -I"$ZLIB_PREFIX/include" -L"$ZLIB_PREFIX/lib" -lz

echo "==> Building Snes9x core..."
# Snes9x's Makefile only archives when STATIC_LINKING_LINK=1 (not
# STATIC_LINKING), defaults to LTO, and is C++.
make_core_archive "$SNES9X_SRC/libretro" "Makefile" "snes9x_libretro.so" \
    "$WORK_DIR/libsnes9x.a" \
    GIT_VERSION="$SNES9X_CORE_VERSION" \
    STATIC_LINKING_LINK=1 LTO= PLATFORM_DEFINES="-fwasm-exceptions" \
    CPPFLAGS="-I$ZLIB_PREFIX/include -nostdinc++ -isystem $LIBCXX_PREFIX/include/c++/v1"
link_binary "$STAGE/kandelo-retro-snes.wasm" "$WORK_DIR/libsnes9x.a" \
    "$SNES9X_SRC/libretro" "" \
    -I"$ZLIB_PREFIX/include" \
    -L"$ZLIB_PREFIX/lib" -L"$LIBCXX_PREFIX/lib" \
    -lz -fwasm-exceptions -lc++ -lc++abi

echo "==> Staging starter ROMs..."
kandelo_package_download_source_archive "$NES_ROM_URL" "$STAGE/roms/240pee.nes"
cp "$MD_ROM_SOURCE/240pSuite-1.21.bin" "$STAGE/roms/240pSuite-md-1.21.bin"
cp "$SNES_ROM_SOURCE/240pSuite.sfc" "$STAGE/roms/240pSuite-snes-1.03.sfc"
chmod 0644 "$STAGE"/roms/*
require_sha256 "$STAGE/roms/240pee.nes" "$NES_ROM_SHA256"
require_sha256 "$STAGE/roms/240pSuite-md-1.21.bin" "$MD_ROM_SHA256"
require_sha256 "$STAGE/roms/240pSuite-snes-1.03.sfc" "$SNES_ROM_SHA256"

cd "$REPO_ROOT"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
for program in kandelo-retro kandelo-retro-genesis kandelo-retro-snes; do
    install_local_binary kandelo-retro "$STAGE/$program.wasm" "$program.wasm"
done
for rom in 240pee.nes 240pSuite-md-1.21.bin 240pSuite-snes-1.03.sfc; do
    install_local_runtime_file kandelo-retro "$STAGE/roms/$rom" \
        "share/kandelo-retro/roms/$rom"
done

# Upstream notices travel with the archive; LICENSE-MAP.md says which notice
# covers which output and ROM.
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/licenses"
cp "$FCEUMM_SRC/Copying" "$WASM_POSIX_DEP_OUT_DIR/licenses/FCEUMM-COPYING.txt"
cp "$GENESIS_SRC/LICENSE.txt" "$WASM_POSIX_DEP_OUT_DIR/licenses/GENESIS-PLUS-GX-LICENSE.txt"
cp "$SNES9X_SRC/LICENSE" "$WASM_POSIX_DEP_OUT_DIR/licenses/SNES9X-LICENSE.txt"
cp "$SNES_ROM_SOURCE/GPLv2.txt" "$WASM_POSIX_DEP_OUT_DIR/licenses/240P-TEST-SUITE-GPLv2.txt"
cp "$HERE/LICENSE-MAP.md" "$WASM_POSIX_DEP_OUT_DIR/licenses/LICENSE-MAP.md"

echo "==> Built kandelo-retro{,-genesis,-snes}.wasm and three starter ROMs"
