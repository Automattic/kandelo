#!/usr/bin/env bash
#
# Build the native Kandelo LÖVE runtime.
#
# This intentionally does not use Emscripten. The result is a POSIX/Wasm
# program linked by wasm32posix-c++ that prefers /dev/dri/card0 KMS/EGL/GLES
# presentation. The runtime fails explicitly if native rendering is unavailable.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
BUILD="$WORK/build"
SRC="$WORK/love-src"
BYTEPATH_SRC="$WORK/bytepath-src"
SNKRX_SRC="$WORK/snkrx-src"
GAME_DEMOS_SRC="$HERE/game-demos"

source "$REPO_ROOT/sdk/activate.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?resolve love through the package resolver}"
LIBDRM_PREFIX="${WASM_POSIX_DEP_LIBDRM_DIR:?missing libdrm dependency}"
LUA_PREFIX="${WASM_POSIX_DEP_LUA_DIR:?missing lua dependency}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?missing freetype dependency}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?missing zlib dependency}"
export WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot love "$SDK_SYSROOT" libcxx)"
# Lua exposes os.execute, so let the normal installer detect/instrument
# the linked fork-call closure instead of disabling it for these games.
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0

# The SDK owns target, exception, memory, syscall and ABI flags.
CC=wasm32posix-cc
CXX=wasm32posix-c++
HOST_ZIP_BIN=zip
COMMON_NATIVE_FLAGS=(-DLOVE_LINUX=1 -DLOVE_KANDELO=1 -DENABLE_OPT=0)
CFLAGS_NATIVE=(
    "${COMMON_NATIVE_FLAGS[@]}"
    -I"$SRC/src"
    -I"$SRC/src/modules"
    -I"$SRC/src/libraries"
    -I"$SRC/src/libraries/lodepng"
    -I"$SRC/src/libraries/glslang"
    -I"$SRC/src/libraries/glslang/glslang/Include"
)
CXXFLAGS_NATIVE=(
    "${COMMON_NATIVE_FLAGS[@]}"
    -fwasm-exceptions
    -Wno-c++11-narrowing
    -isystem "$WASM_POSIX_SYSROOT/include/c++/v1"
    -I"$SRC/src"
    -I"$SRC/src/modules"
    -I"$SRC/src/libraries"
    -I"$SRC/src/libraries/lodepng"
    -I"$SRC/src/libraries/glslang"
    -I"$SRC/src/libraries/glslang/glslang/Include"
)
CFLAGS_NATIVE+=(
    -I"$LIBDRM_PREFIX/include"
    -I"$LIBDRM_PREFIX/include/libdrm"
    -I"$LIBDRM_PREFIX/include/drm"
    -I"$LUA_PREFIX/include"
    -I"$FREETYPE_PREFIX/include/freetype2"
    -I"$ZLIB_PREFIX/include"
)
CXXFLAGS_NATIVE+=(
    -I"$LIBDRM_PREFIX/include"
    -I"$LIBDRM_PREFIX/include/libdrm"
    -I"$LIBDRM_PREFIX/include/drm"
    -I"$LUA_PREFIX/include"
    -I"$FREETYPE_PREFIX/include/freetype2"
    -I"$ZLIB_PREFIX/include"
)

DRI_LIBS=(
    "$WASM_POSIX_SYSROOT/lib/libgbm.a"
    "$LIBDRM_PREFIX/lib/libdrm.a"
    "$WASM_POSIX_SYSROOT/lib/libEGL.a"
    "$WASM_POSIX_SYSROOT/lib/libGLESv2.a"
)
for lib in "${DRI_LIBS[@]}"; do
    if [ ! -f "$lib" ]; then
        echo "ERROR: DRI/EGL/GLES sysroot library is missing: $lib" >&2
        echo "Run: scripts/dev-shell.sh bash scripts/build-musl.sh" >&2
        exit 1
    fi
done

mkdir -p "$BUILD/obj"
kandelo_package_stage_primary_source love "$SRC" "$WORK"
for patch in "$HERE"/patches/*.patch; do
    echo "==> Applying $(basename "$patch")..."
    (cd "$SRC" && git apply "$patch")
done
kandelo_package_stage_source_dependency bytepath-source "$BYTEPATH_SRC" "$WORK"
for patch in "$HERE"/patches/bytepath/*.patch; do
    echo "==> Applying BYTEPATH $(basename "$patch")..."
    (cd "$BYTEPATH_SRC" && git apply "$patch")
done
kandelo_package_stage_source_dependency snkrx-source "$SNKRX_SRC" "$WORK"

obj_for() {
    local rel="${1#$SRC/}"
    rel="${rel#$HERE/}"
    rel="${rel//\//_}"
    echo "$BUILD/obj/${rel}.o"
}

OBJECTS=()
compile_c() {
    local src="$1"
    local obj
    obj="$(obj_for "$src")"
    echo "  CC  ${src#$REPO_ROOT/}"
    "$CC" "${CFLAGS_NATIVE[@]}" -O2 -c "$src" -o "$obj"
    OBJECTS+=("$obj")
}

compile_cxx() {
    local src="$1"
    local obj
    obj="$(obj_for "$src")"
    echo "  CXX ${src#$REPO_ROOT/}"
    "$CXX" "${CXXFLAGS_NATIVE[@]}" -O2 -std=c++17 -c "$src" -o "$obj"
    OBJECTS+=("$obj")
}

LOVE_CXX_SOURCES=(
    "$HERE/src/lovefb.cpp"
    "$HERE/src/kandelo_native.cpp"
    "$SRC/src/common/deprecation.cpp"
    "$SRC/src/common/b64.cpp"
    "$SRC/src/common/types.cpp"
    "$SRC/src/common/pixelformat.cpp"
    "$SRC/src/common/Exception.cpp"
    "$SRC/src/common/Module.cpp"
    "$SRC/src/common/Object.cpp"
    "$SRC/src/common/Data.cpp"
    "$SRC/src/common/Stream.cpp"
    "$SRC/src/common/Variant.cpp"
    "$SRC/src/common/Matrix.cpp"
    "$SRC/src/common/Reference.cpp"
    "$SRC/src/common/runtime.cpp"
    "$SRC/src/common/Vector.cpp"
    "$SRC/src/common/StringMap.cpp"
    "$SRC/src/common/utf8.cpp"
    "$SRC/src/common/floattypes.cpp"
    "$SRC/src/common/memory.cpp"
    "$SRC/src/modules/audio/Source.cpp"
    "$SRC/src/modules/video/VideoStream.cpp"
    "$SRC/src/modules/timer/Timer.cpp"
    "$SRC/src/modules/window/Window.cpp"
    "$SRC/src/modules/window/wrap_Window.cpp"
    "$SRC/src/modules/data/ByteData.cpp"
    "$SRC/src/modules/data/CompressedData.cpp"
    "$SRC/src/modules/data/Compressor.cpp"
    "$SRC/src/modules/data/DataModule.cpp"
    "$SRC/src/modules/data/DataView.cpp"
    "$SRC/src/modules/data/HashFunction.cpp"
    "$SRC/src/modules/data/wrap_ByteData.cpp"
    "$SRC/src/modules/data/wrap_CompressedData.cpp"
    "$SRC/src/modules/data/wrap_Data.cpp"
    "$SRC/src/modules/data/wrap_DataModule.cpp"
    "$SRC/src/modules/data/wrap_DataView.cpp"
    "$SRC/src/modules/math/BezierCurve.cpp"
    "$SRC/src/modules/math/MathModule.cpp"
    "$SRC/src/modules/math/RandomGenerator.cpp"
    "$SRC/src/modules/math/Transform.cpp"
    "$SRC/src/modules/math/wrap_BezierCurve.cpp"
    "$SRC/src/modules/math/wrap_Math.cpp"
    "$SRC/src/modules/math/wrap_RandomGenerator.cpp"
    "$SRC/src/modules/math/wrap_Transform.cpp"
    "$SRC/src/modules/filesystem/DroppedFile.cpp"
    "$SRC/src/modules/filesystem/File.cpp"
    "$SRC/src/modules/filesystem/FileData.cpp"
    "$SRC/src/modules/filesystem/Filesystem.cpp"
    "$SRC/src/modules/filesystem/wrap_DroppedFile.cpp"
    "$SRC/src/modules/filesystem/wrap_File.cpp"
    "$SRC/src/modules/filesystem/wrap_FileData.cpp"
    "$SRC/src/modules/filesystem/wrap_Filesystem.cpp"
    "$SRC/src/modules/image/CompressedImageData.cpp"
    "$SRC/src/modules/image/CompressedSlice.cpp"
    "$SRC/src/modules/image/FormatHandler.cpp"
    "$SRC/src/modules/image/Image.cpp"
    "$SRC/src/modules/image/ImageData.cpp"
    "$SRC/src/modules/image/ImageDataBase.cpp"
    "$SRC/src/modules/image/magpie/ASTCHandler.cpp"
    "$SRC/src/modules/image/magpie/EXRHandler.cpp"
    "$SRC/src/modules/image/magpie/KTXHandler.cpp"
    "$SRC/src/modules/image/magpie/PKMHandler.cpp"
    "$SRC/src/modules/image/magpie/PNGHandler.cpp"
    "$SRC/src/modules/image/magpie/PVRHandler.cpp"
    "$SRC/src/modules/image/magpie/STBHandler.cpp"
    "$SRC/src/modules/image/magpie/ddsHandler.cpp"
    "$SRC/src/modules/image/wrap_CompressedImageData.cpp"
    "$SRC/src/modules/image/wrap_Image.cpp"
    "$SRC/src/modules/image/wrap_ImageData.cpp"
    "$SRC/src/modules/font/BMFontRasterizer.cpp"
    "$SRC/src/modules/font/Font.cpp"
    "$SRC/src/modules/font/GlyphData.cpp"
    "$SRC/src/modules/font/ImageRasterizer.cpp"
    "$SRC/src/modules/font/Rasterizer.cpp"
    "$SRC/src/modules/font/TrueTypeRasterizer.cpp"
    "$SRC/src/modules/font/freetype/Font.cpp"
    "$SRC/src/modules/font/freetype/TrueTypeRasterizer.cpp"
    "$SRC/src/modules/font/wrap_Font.cpp"
    "$SRC/src/modules/font/wrap_GlyphData.cpp"
    "$SRC/src/modules/font/wrap_Rasterizer.cpp"
    "$SRC/src/modules/graphics/Buffer.cpp"
    "$SRC/src/modules/graphics/Canvas.cpp"
    "$SRC/src/modules/graphics/Deprecations.cpp"
    "$SRC/src/modules/graphics/Drawable.cpp"
    "$SRC/src/modules/graphics/Font.cpp"
    "$SRC/src/modules/graphics/Graphics.cpp"
    "$SRC/src/modules/graphics/Image.cpp"
    "$SRC/src/modules/graphics/Mesh.cpp"
    "$SRC/src/modules/graphics/ParticleSystem.cpp"
    "$SRC/src/modules/graphics/Polyline.cpp"
    "$SRC/src/modules/graphics/Quad.cpp"
    "$SRC/src/modules/graphics/Shader.cpp"
    "$SRC/src/modules/graphics/ShaderStage.cpp"
    "$SRC/src/modules/graphics/SpriteBatch.cpp"
    "$SRC/src/modules/graphics/StreamBuffer.cpp"
    "$SRC/src/modules/graphics/Text.cpp"
    "$SRC/src/modules/graphics/Texture.cpp"
    "$SRC/src/modules/graphics/Video.cpp"
    "$SRC/src/modules/graphics/Volatile.cpp"
    "$SRC/src/modules/graphics/depthstencil.cpp"
    "$SRC/src/modules/graphics/vertex.cpp"
    "$SRC/src/modules/graphics/wrap_Canvas.cpp"
    "$SRC/src/modules/graphics/wrap_Font.cpp"
    "$SRC/src/modules/graphics/wrap_Graphics.cpp"
    "$SRC/src/modules/graphics/wrap_Image.cpp"
    "$SRC/src/modules/graphics/wrap_Mesh.cpp"
    "$SRC/src/modules/graphics/wrap_ParticleSystem.cpp"
    "$SRC/src/modules/graphics/wrap_Quad.cpp"
    "$SRC/src/modules/graphics/wrap_Shader.cpp"
    "$SRC/src/modules/graphics/wrap_SpriteBatch.cpp"
    "$SRC/src/modules/graphics/wrap_Text.cpp"
    "$SRC/src/modules/graphics/wrap_Texture.cpp"
    "$SRC/src/modules/graphics/wrap_Video.cpp"
    "$SRC/src/modules/graphics/opengl/Buffer.cpp"
    "$SRC/src/modules/graphics/opengl/Canvas.cpp"
    "$SRC/src/modules/graphics/opengl/FenceSync.cpp"
    "$SRC/src/modules/graphics/opengl/Graphics.cpp"
    "$SRC/src/modules/graphics/opengl/Image.cpp"
    "$SRC/src/modules/graphics/opengl/OpenGL.cpp"
    "$SRC/src/modules/graphics/opengl/Shader.cpp"
    "$SRC/src/modules/graphics/opengl/ShaderStage.cpp"
    "$SRC/src/modules/graphics/opengl/StreamBuffer.cpp"
    "$SRC/src/libraries/lodepng/lodepng.cpp"
    "$SRC/src/libraries/ddsparse/ddsparse.cpp"
    "$SRC/src/libraries/noise1234/noise1234.cpp"
    "$SRC/src/libraries/noise1234/simplexnoise1234.cpp"
    "$SRC/src/libraries/glad/glad.cpp"
)

LOVE_C_SOURCES=(
    "$SRC/src/libraries/lua53/lstrlib.c"
    "$SRC/src/libraries/lua53/lutf8lib.c"
    "$SRC/src/libraries/Wuff/wuff.c"
    "$SRC/src/libraries/Wuff/wuff_convert.c"
    "$SRC/src/libraries/Wuff/wuff_memory.c"
    "$SRC/src/libraries/lz4/lz4.c"
    "$SRC/src/libraries/lz4/lz4hc.c"
    "$SRC/src/libraries/xxHash/xxhash.c"
)

mapfile -t GLSLANG_CXX_SOURCES < <(
    find \
        "$SRC/src/libraries/glslang/glslang/GenericCodeGen" \
        "$SRC/src/libraries/glslang/glslang/MachineIndependent" \
        "$SRC/src/libraries/glslang/glslang/MachineIndependent/preprocessor" \
        "$SRC/src/libraries/glslang/glslang/OSDependent/Unix" \
        "$SRC/src/libraries/glslang/OGLCompilersDLL" \
        -maxdepth 1 -name '*.cpp' | sort
)

mapfile -t PHYSICS_CXX_SOURCES < <(
    find "$SRC/src/modules/physics" -name '*.cpp' | sort
)

mapfile -t BOX2D_CXX_SOURCES < <(
    find "$SRC/src/libraries/Box2D" -name '*.cpp' | sort
)

echo "==> Compiling native LÖVE runtime and renderer..."
for src in "${LOVE_CXX_SOURCES[@]}" "${GLSLANG_CXX_SOURCES[@]}" "${PHYSICS_CXX_SOURCES[@]}" "${BOX2D_CXX_SOURCES[@]}"; do
    compile_cxx "$src"
done
for src in "${LOVE_C_SOURCES[@]}"; do
    compile_c "$src"
done

echo "==> Linking love.wasm..."
"$CXX" "${COMMON_NATIVE_FLAGS[@]}" -O2 \
    "${OBJECTS[@]}" \
    "$LUA_PREFIX/lib/liblua.a" \
    "$FREETYPE_PREFIX/lib/libfreetype.a" \
    "$ZLIB_PREFIX/lib/libz.a" \
    "${DRI_LIBS[@]}" \
    "$LIBCXX_PREFIX/lib/libc++.a" \
    "$LIBCXX_PREFIX/lib/libc++abi.a" \
    -o "$BUILD/love.wasm"

echo "==> Bundling Love game demos..."
ARCHIVE_ROOT="$BUILD/archive"
EXAMPLES_BUILD="$ARCHIVE_ROOT/share/love/examples"
BYTEPATH_BUILD="$EXAMPLES_BUILD/bytepath"
SNKRX_BUILD="$EXAMPLES_BUILD/snkrx"
rm -rf "$EXAMPLES_BUILD"
mkdir -p "$EXAMPLES_BUILD" "$BYTEPATH_BUILD" "$SNKRX_BUILD"
cp -R "$GAME_DEMOS_SRC"/. "$EXAMPLES_BUILD"/

# BYTEPATH is packaged from its upstream game tree with real fonts, images,
# sounds, shaders, and game code. Steamworks is an external native SDK boundary
# and is disabled for this non-Steam demo runtime.
find "$BYTEPATH_SRC" -mindepth 1 -maxdepth 1 \
    ! -name '.git' \
    ! -name 'tutorial' \
    ! -name 'love' \
    -exec cp -R {} "$BYTEPATH_BUILD"/ \;
perl -0pi -e "s/^Steam = require 'libraries\\/steamworks'\nif type\(Steam\) == 'boolean' then Steam = nil end/Steam = nil/m" "$BYTEPATH_BUILD/main.lua"

# SNKRX is also packaged from its upstream game tree with its real assets and
# rendering code. Steamworks is an external native SDK boundary, so only that
# integration is shimmed; the game otherwise uses its normal native LÖVE path.
find "$SNKRX_SRC" -mindepth 1 -maxdepth 1 \
    ! -name '.git' \
    ! -name 'builds' \
    -exec cp -R {} "$SNKRX_BUILD"/ \;
rm -rf "$SNKRX_BUILD/engine/love"

cat > "$SNKRX_BUILD/luasteam.lua" <<'LUA'
local function noop() end
return {
  init = noop,
  shutdown = noop,
  runCallbacks = noop,
  friends = {setRichPresence = noop},
  userStats = {
    requestCurrentStats = noop,
    setAchievement = noop,
    storeStats = noop,
    resetAllStats = noop,
  },
}
LUA

cat > "$SNKRX_BUILD/kandelo_runtime.lua" <<'LUA'
steam = steam or require('luasteam')
LUA
perl -0pi -e 's/^/require "kandelo_runtime"\n/' "$SNKRX_BUILD/main.lua"

# Each core game gets a normal game directory, selectable by the dock menu.
# Reuse the gallery implementation; the entry point chooses its initial game.
for game in pong snake breakout asteroids; do
    mkdir -p "$EXAMPLES_BUILD/$game"
    printf 'KANDELO_EXAMPLE = "%s"\ndofile(love.filesystem.getSource() .. "/../main.lua")\n' "$game" > "$EXAMPLES_BUILD/$game/main.lua"
done

# Deterministic archive metadata; no host-dependent permissions/timestamps.
find "$ARCHIVE_ROOT" -type d -exec chmod 755 {} +
find "$ARCHIVE_ROOT" -type f -exec chmod 644 {} +
find "$ARCHIVE_ROOT" -exec touch -t 198001010000 {} +
(cd "$ARCHIVE_ROOT" && find . -type f | LC_ALL=C sort | "$HOST_ZIP_BIN" -Xq "$BUILD/love-examples.zip" -@)

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary love "$BUILD/love.wasm" "love.wasm"
install_local_runtime_file love "$BUILD/love-examples.zip" "share/love-examples.zip"
