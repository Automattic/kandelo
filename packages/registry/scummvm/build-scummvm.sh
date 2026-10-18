#!/usr/bin/env bash
#
# Build ScummVM against the Kandelo SDL2 stack, with every engine as a
# dlopen()ed plugin (lib<engine>.so) so a machine downloads only the engine
# of the game it runs. The engines are the SCUMM engine (with the
# scumm-7-8 sub-engine for v7/v8 games — Full Throttle, The Dig, Curse of
# Monkey Island) plus each engine of a freeware game the ScummVM demo can
# fetch: Sky, Drascula, DreamWeb, Queen, God of Thunder, Griffon, Lure,
# ADL, Parallaction, CGE, CGE2, SLUDGE and WAGE. The stack:
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
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
# Per-run scratch (tarball, install DESTDIR, sdl2-config shim): inside the
# resolver work root when there is one, else a unique TMPDIR directory.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    WORK_DIR="$(mktemp -d "$KANDELO_PACKAGE_WORK_DIR/kandelo-scummvm.XXXXXX")"
else
    WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-scummvm.XXXXXX")"
fi
trap 'rm -rf "$WORK_DIR"' EXIT

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

SCUMMVM_VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
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
LIBMAD_PREFIX="${WASM_POSIX_DEP_LIBMAD_DIR:?resolver did not provide the direct libmad dependency}"
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
test -f "$LIBMAD_PREFIX/lib/libmad.a"
test -f "$LIBMAD_PREFIX/include/mad.h"
test -f "$LIBCXX_PREFIX/lib/libc++.a"

# clang++ resolves -lc++ / -lc++abi and the libc++ header tree through
# the sysroot. Under the resolver, project a private sysroot with the
# resolved libcxx overlaid: the worktree SDK seed is an input tree for
# every package build and must hold no symlink (same pattern as
# build-mariadb.sh). A direct invocation has no resolver work dir and
# indexes the artifacts into the worktree sysroot instead.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
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

# A standalone run keeps the source tree beside this script across runs
# (sdl2-src pattern): the 225 MB tarball downloads once and `make` stays
# incremental. `rm -rf scummvm-src` forces a fresh download + re-patch.
# A resolver build extracts and builds it in its own work root.
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/scummvm-src"
DEST_DIR="$WORK_DIR/dest"
# Under the resolver the SDK's later work-root map takes precedence for
# these paths; a standalone run (no work root) relies on this map.
REPRO_FLAGS="-ffile-prefix-map=$SRC_DIR=/usr/src/scummvm -fdebug-prefix-map=$SRC_DIR=/usr/src/scummvm -fmacro-prefix-map=$SRC_DIR=/usr/src/scummvm"
mkdir -p "$DEST_DIR"

kandelo_package_stage_primary_source scummvm "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"
if [ -d "$SRC_DIR" ]; then
    echo "==> Applying Kandelo patches..."
    for p in "$SCRIPT_DIR"/patches/*.patch; do
        echo "    $(basename "$p")"
        patch -p1 -d "$SRC_DIR" < "$p"
    done
fi

# ScummVM's configure is hand-written (not autoconf); it honors the
# CXX/AR/RANLIB/STRIP env vars and probes SDL through sdl2-config.
#
# configure asks plain `pkg-config` for freetype2 and libpng. The dev shell
# exports a PKG_CONFIG_PATH of /nix/store directories, and pkg-config searches
# PKG_CONFIG_PATH in addition to PKG_CONFIG_LIBDIR, so libpng resolved to the
# build machine's libpng-apng: every object compiled against its 1.6.55
# headers while linking the libpng 1.6.43 package. Clearing PKG_CONFIG_PATH
# and listing exactly the declared dependencies' .pc directories (libpng's
# Requires.private names zlib) keeps every flag inside resolver outputs.
# libSDL2.a is static, so the Wayland/KMSDRM/GL dependency archives
# must ride the final link line — LDFLAGS carries them
# (libwayland-egl.a is the glue's wl_egl_window shim, shipped by the
# libwayland package).
#
# Every declared dependency's lib dir comes BEFORE the sysroot's. The
# sysroot holds copies of some package archives (build-programs.sh stages
# libwayland-egl.a there for program links), and those copies are only
# as fresh as the last build-programs.sh run: searched first, a stale
# copy silently won over the libwayland this package depends on.
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

# Engine plugins.
#
# --enable-plugins --default-dynamic builds every engine as a side module;
# game detection stays in the main program, so the launcher recognizes any
# game without loading an engine. ScummVM's Linux plugin mode (patch 0001
# maps the host there) links plugins with -shared and the program with
# -export-dynamic, and adds -ldl so dlopen is Kandelo's real loader rather
# than musl's stub. Three things differ on Kandelo:
#
# - UNCACHED_PLUGINS is ScummVM's own mode for ports that cannot afford to
#   keep every engine loaded (Emscripten, Dingux): a launch opens only the
#   one plugin its game needs, located by engine id (sky → libsky.so). Here
#   each plugin is a lazy file, so a plugin opened is a plugin downloaded.
# - PLUGIN_LDFLAGS is just -shared. Linux mode appends $(LDFLAGS), which
#   carries the static SDL/Wayland/GL and libc++ archives this program
#   needs; linked into a plugin they duplicate state the program already
#   owns. A plugin resolves every such symbol against the program instead.
# - The program links with --export-all. wasm-ld's -export-dynamic exports
#   only symbols the program itself defines and keeps; plugins also import
#   libc/libc++ members the program never pulled in. Those are found after
#   the first link and forced in with -u (see "Exporting plugin imports").
SCUMMVM_ENGINES=scumm,scumm-7-8,sky,drascula,dreamweb,queen,got,griffon,lure,adl,parallaction,cge,cge2,sludge,wage

echo "==> Configuring ScummVM (engine plugins, GLES2, SDL2 backend)..."
(
    cd "$SRC_DIR"
    CXX="$CXX" AR="$AR" RANLIB="$RANLIB" STRIP="$STRIP" \
    CXXFLAGS="-O2 -DKANDELO -DUNCACHED_PLUGINS $REPRO_FLAGS" \
    LDFLAGS="-L$SDL2_PREFIX/lib -L$LIBDRM_PREFIX/lib -L$LIBWAYLAND_PREFIX/lib -L$LIBFFI_PREFIX/lib -L$LIBXKBCOMMON_PREFIX/lib -L$ZLIB_PREFIX/lib -L$LIBPNG_PREFIX/lib -L$FREETYPE_PREFIX/lib -L$LIBCXX_PREFIX/lib -L$SYSROOT/lib $SDL_DEP_LIBS" \
    MAD_CFLAGS="-I$LIBMAD_PREFIX/include" \
    MAD_LIBS="-L$LIBMAD_PREFIX/lib" \
    PKG_CONFIG_PATH= \
    PKG_CONFIG_LIBDIR="$FREETYPE_PREFIX/lib/pkgconfig:$LIBPNG_PREFIX/lib/pkgconfig:$ZLIB_PREFIX/lib/pkgconfig" \
    ./configure \
        --host=wasm32posix \
        --backend=sdl \
        --with-sdl-prefix="$SDL_SHIM_PREFIX" \
        --disable-all-engines \
        --enable-engine="$SCUMMVM_ENGINES" \
        --enable-plugins \
        --default-dynamic \
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
        --enable-mad --disable-flac \
        --disable-jpeg --disable-gif \
        --disable-faad --disable-mpeg2 --disable-a52 \
        --disable-theoradec --disable-vpx \
        --enable-freetype2 --disable-fribidi \
        --disable-libcurl --disable-cloud --disable-sdlnet --disable-enet \
        --disable-discord --disable-taskbar --disable-updates \
        --disable-tts \
        --disable-eventrecorder
)
grep -q '^#define USE_MAD' "$SRC_DIR/config.h"

JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
scummvm_make() {
    make -C "$SRC_DIR" -j"$JOBS" \
        PLUGIN_LDFLAGS=-shared \
        PRE_OBJS_FLAGS="-Wl,--export-all $EXTRA_EXPORTS -Wl,-whole-archive" \
        "$@"
}

echo "==> Compiling ScummVM..."
EXTRA_EXPORTS=
scummvm_make

# Exporting plugin imports.
#
# Every function a plugin imports from `env` must be an export of the
# program; the loader has nowhere else to resolve it. A libc member only a
# plugin calls (strncat, for one) is not in the program at all, so
# --export-all cannot export it. Force each such member in with -u and
# relink once, then require an exact match: a remaining gap would surface
# only at dlopen time, on the one game that needs it.
export LC_ALL=C  # sort and comm must agree on one collation
plugin_env_imports() {
    for so in "$SRC_DIR"/plugins/*.so; do
        wasm-objdump -x -j Import "$so" | sed -n 's/.*<- env\.\([^ ]*\)$/\1/p'
    done | grep -v -x -e memory -e __indirect_function_table \
        -e __stack_pointer -e __memory_base -e __table_base | sort -u
}
program_exports() {
    wasm-objdump -x -j Export "$SRC_DIR/scummvm" \
        | sed -n 's/.*-> "\([^"]*\)"$/\1/p' | sort -u
}
MISSING="$(comm -23 <(plugin_env_imports) <(program_exports))"
if [ -n "$MISSING" ]; then
    echo "==> Exporting plugin imports the program does not define: $(echo $MISSING)"
    EXTRA_EXPORTS="$(printf -- '-Wl,-u,%s ' $MISSING)"
    rm -f "$SRC_DIR/scummvm"
    scummvm_make scummvm
    STILL_MISSING="$(comm -23 <(plugin_env_imports) <(program_exports))"
    if [ -n "$STILL_MISSING" ]; then
        echo "ERROR: plugins import symbols the program cannot export: $(echo $STILL_MISSING)" >&2
        exit 1
    fi
fi

echo "==> Installing ScummVM data files..."
scummvm_make install DESTDIR="$DEST_DIR"
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

echo "==> Fork-instrumenting scummvm.wasm and its engine plugins..."
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$SRC_DIR/scummvm" \
    -o "$INSTALL_DIR/scummvm.wasm"
mkdir -p "$INSTALL_DIR/lib/scummvm"
for so in "$SRC_DIR"/plugins/*.so; do
    "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
        "$so" \
        -o "$INSTALL_DIR/lib/scummvm/$(basename "$so")"
done

test -f "$INSTALL_DIR/scummvm.wasm"
test -f "$INSTALL_DIR/share/scummvm/scummclassic.zip"
for engine in scumm sky drascula dreamweb queen got griffon lure adl \
    parallaction cge cge2 sludge wage; do
    test -f "$INSTALL_DIR/lib/scummvm/lib$engine.so"
done
echo "==> ScummVM $SCUMMVM_VERSION package complete"
