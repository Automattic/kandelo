#!/usr/bin/env bash
# Build the real upstream SDL2 client and server, including their data tree.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
source "$REPO_ROOT/sdk/activate.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OUT="${WASM_POSIX_DEP_OUT_DIR:?resolve freeciv through the package resolver}"
SRC="$WORK/source"
kandelo_package_stage_verified_source freeciv "$SRC" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK"
for change in "$HERE"/patches/*.patch; do
    patch -d "$SRC" -p1 < "$change"
done
export WASM_POSIX_DEP_WORK_DIR="$WORK"
export WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot \
    freeciv "${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}" libcxx)"
export PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?missing dependency closure}"

# Meson requires a build-machine tolua during cross builds. Compile upstream's
# bundled generator and bundled Lua with the native compiler, independently of
# target configure headers. localluaconf.h supports this portable C default.
mkdir -p "$WORK/native-bin"
lua_sources=()
for file in "$SRC"/dependencies/lua-5.4/src/*.c; do
    case "$(basename "$file")" in lua.c|luac.c) continue ;; esac
    lua_sources+=("$file")
done
clang -O2 -I"$SRC/dependencies/lua-5.4/src" \
    -I"$SRC/dependencies/tolua-5.2/include" \
    "${lua_sources[@]}" "$SRC"/dependencies/tolua-5.2/src/lib/*.c \
    "$SRC/dependencies/tolua-5.2/src/bin/tolua.c" \
    "$SRC/dependencies/tolua-5.2/src/bin/toluabind.c" \
    -lm -o "$WORK/native-bin/tolua"
export PATH="$WORK/native-bin:$PATH"

# Raw find_library and header probes also need resolver paths; pkg-config
# alone only covers upstream dependency() calls. Never probe host headers.
export CFLAGS="" LDFLAGS=""
lib_dirs=()
for dep in SDL2 SDL2_IMAGE SDL2_TTF SDL2_MIXER LIBWAYLAND LIBXKBCOMMON LIBFFI LIBPNG FREETYPE ZLIB LIBCURL OPENSSL ICU LIBCXX SQLITE READLINE NCURSES; do
    key="WASM_POSIX_DEP_${dep}_DIR"
    prefix="${!key:?missing declared dependency}"
    CFLAGS+=" -I$prefix/include"
    LDFLAGS+=" -L$prefix/lib"
    lib_dirs+=("$prefix/lib")
done
# Freeciv's raw curl/readline/ICU finds do not express static link closures.
LDFLAGS+=" -lssl -lcrypto -lz -ltinfow -lc++ -lc++abi"
# Freeciv's cross-build properties default to an empty search directory,
# which modern Meson rejects. Bind both properties to the actual target SDK;
# the per-dependency include/library flags above remain authoritative.
python3 - "$WORK/freeciv-cross.ini" "$WASM_POSIX_SYSROOT" "${lib_dirs[@]}" <<'PY'
import pathlib, sys
path, sdk, *libs = sys.argv[1:]
pathlib.Path(path).write_text(
    "[properties]\n"
    f"cross_inc_path = {str(pathlib.Path(sdk) / 'include')!r}\n"
    f"cross_lib_path = {libs!r}\n"
)
PY
meson setup "$WORK/build" "$SRC" \
    --cross-file "$REPO_ROOT/sdk/meson/wasm32posix.ini" \
    --cross-file "$WORK/freeciv-cross.ini" \
    --prefix /usr --libdir lib -Dbuildtype=release \
    -Dclients=sdl2 -Dserver=enabled '-Dfcmp=[]' '-Dtools=[]' \
    -Daudio=sdl2 -Dnls=false -Dsyslua=false -Dmwand=false \
    -Dreadline=true -Dsvgflags=false
ninja -C "$WORK/build" -j"${WASM_POSIX_BUILD_JOBS:-8}"
meson install -C "$WORK/build" --no-rebuild --destdir "$WORK/install"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$REPO_ROOT/scripts/install-local-binary.sh"
# Keep symbolic stack traces for diagnosing client/server failures. The normal
# installer validates the already-instrumented artifacts before publishing.
for program in freeciv-sdl2 freeciv-server; do
    "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" --require-facts \
        "$WORK/build/$program" --keep-names -o "$WORK/$program.wasm"
    install_local_binary freeciv "$WORK/$program.wasm" "$program.wasm"
done
# Runtime data is independently declared and bundled lazily by the consumer.
mkdir -p "$WORK/data/share"
cp -R "$WORK/install/usr/share/freeciv" "$WORK/data/share/freeciv"
# Only the selected SDL2 client is shipped. Other clients' themes are not
# runtime dependencies and would add another copy of the SDL theme artwork.
rm -rf "$WORK/data/share/freeciv/themes/gui-sdl3" \
    "$WORK/data/share/freeciv/themes/gui-qt" \
    "$WORK/data/share/freeciv/themes/gtk3.22" \
    "$WORK/data/share/freeciv/themes/gtk4"
install -m644 "$SRC/COPYING" "$WORK/data/share/freeciv/COPYING"
# ICU's standard file search uses the upstream data basename, rather than
# Kandelo's PHP-oriented icu.dat name. ICU_DATA is set by the guest launcher.
mkdir -p "$WORK/data/share/icu"
cp "$WASM_POSIX_DEP_ICU_DIR/share/icu.dat" "$WORK/data/share/icu/icudt74l.dat"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" \
    "$WORK/data" "$OUT/freeciv-data.zip"
