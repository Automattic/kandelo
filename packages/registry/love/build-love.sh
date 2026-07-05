#!/usr/bin/env bash
#
# Build the native Kandelo LÖVE runtime.
#
# This intentionally does not use Emscripten. The result is a POSIX/Wasm
# program linked by wasm32posix-c++ that prefers /dev/dri/card0 KMS/EGL/GLES
# presentation and falls back to /dev/fb0 when direct rendering is unavailable.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
BYTEPATH_SRC="$HERE/bytepath-src"
SNKRX_SRC="$HERE/snkrx-src"
GAME_DEMOS_SRC="$HERE/game-demos"
BUILD="$HERE/build"
SRC="$BUILD/love-src"

LOVE_COMMIT="6eb8d546736d5915a8b5af30b2cf33456dfdcb1a" # 11.5
BYTEPATH_COMMIT="51ee3086ae3369a2c80e4e47d4b62d480af4fe89"
SNKRX_COMMIT="6b93a64d694d59472375467648868ae4521d6706"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

find_llvm_bin() {
    if [ -n "${WASM_POSIX_LLVM_DIR:-}" ]; then echo "$WASM_POSIX_LLVM_DIR"; return; fi
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    if [ -n "${LLVM_PREFIX:-}" ] && [ -d "$LLVM_PREFIX/bin" ]; then echo "$LLVM_PREFIX/bin"; return; fi
    local brew_prefix
    if brew_prefix=$(brew --prefix llvm 2>/dev/null) && [ -d "$brew_prefix/bin" ]; then
        echo "$brew_prefix/bin"
        return
    fi
    if command -v clang++ >/dev/null 2>&1; then
        dirname "$(command -v clang++)"
        return
    fi
    echo "ERROR: LLVM/clang++ not found. Set WASM_POSIX_LLVM_DIR." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"
CXX="$LLVM_BIN/clang++"
GLUE_DIR="$REPO_ROOT/libc/glue"

LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_PREFIX" ]; then
    for candidate in "$WASM_POSIX_SYSROOT" "$HERE/../libcxx/libcxx-install"; do
        if [ -f "$candidate/lib/libc++.a" ] &&
           [ -f "$candidate/lib/libc++abi.a" ] &&
           [ -f "$candidate/include/c++/v1/algorithm" ]; then
            LIBCXX_PREFIX="$candidate"
            break
        fi
    done
fi
if [ ! -f "$LIBCXX_PREFIX/lib/libc++.a" ] ||
   [ ! -f "$LIBCXX_PREFIX/lib/libc++abi.a" ] ||
   [ ! -f "$LIBCXX_PREFIX/include/c++/v1/algorithm" ]; then
    echo "ERROR: libcxx dependency not found at $LIBCXX_PREFIX" >&2
    echo "Resolve libcxx first or build through cargo xtask build-deps resolve love." >&2
    exit 1
fi

COMMON_NATIVE_FLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$WASM_POSIX_SYSROOT"
    -matomics -mbulk-memory
    -mexception-handling
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=false
    -fno-trapping-math
    -DLOVE_LINUX=1
    -DLOVE_KANDELO=1
    -DENABLE_OPT=0
)
if [ "${LOVE_WASM_DEBUG:-0}" = "1" ]; then
    COMMON_NATIVE_FLAGS+=(-g)
fi
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
    -fexceptions
    -Wno-c++11-narrowing
    -isystem "$LIBCXX_PREFIX/include/c++/v1"
    -I"$SRC/src"
    -I"$SRC/src/modules"
    -I"$SRC/src/libraries"
    -I"$SRC/src/libraries/lodepng"
    -I"$SRC/src/libraries/glslang"
    -I"$SRC/src/libraries/glslang/glslang/Include"
)
LDFLAGS_NATIVE=(
    -nostdlib
    -Wl,--entry=_start
    -Wl,--export=_start
    -Wl,--export=__heap_base
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--global-base=1114112
    -Wl,--table-base=3
    -Wl,--export-table
    -Wl,--growable-table
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__tls_base
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__stack_pointer
    -Wl,--export=__wasm_thread_init
    -Wl,--export=__abi_version
)
if [ -n "${LOVE_WASM_LINK_MAP:-}" ]; then
    LDFLAGS_NATIVE+=("-Wl,--Map=$LOVE_WASM_LINK_MAP")
fi

LUA_PREFIX="${WASM_POSIX_DEP_LUA_DIR:-}"
if [ -z "$LUA_PREFIX" ]; then
    LUA_PREFIX="$HERE/../lua/lua-install"
    LUA_VERSION_NUM="$(awk '/^#define LUA_VERSION_NUM[ \t]+/ {print $3}' "$LUA_PREFIX/include/lua.h" 2>/dev/null || true)"
    if [ ! -f "$LUA_PREFIX/lib/liblua.a" ] || [ ! -f "$LUA_PREFIX/include/lua.h" ] ||
       [ "$LUA_VERSION_NUM" != "502" ]; then
        echo "==> Building Lua dependency..."
        bash "$HERE/../lua/build-lua.sh"
    fi
fi
if [ ! -f "$LUA_PREFIX/lib/liblua.a" ] || [ ! -f "$LUA_PREFIX/include/lua.h" ]; then
    echo "ERROR: Lua dependency not found at $LUA_PREFIX" >&2
    exit 1
fi

FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:-}"
if [ -z "$FREETYPE_PREFIX" ]; then
    FREETYPE_PREFIX="$HERE/../freetype/freetype-install"
    if [ ! -f "$FREETYPE_PREFIX/lib/libfreetype.a" ] ||
       [ ! -f "$FREETYPE_PREFIX/include/freetype2/ft2build.h" ]; then
        echo "==> Building FreeType dependency..."
        bash "$HERE/../freetype/build-freetype.sh"
    fi
fi
if [ ! -f "$FREETYPE_PREFIX/lib/libfreetype.a" ] ||
   [ ! -f "$FREETYPE_PREFIX/include/freetype2/ft2build.h" ]; then
    echo "ERROR: FreeType dependency not found at $FREETYPE_PREFIX" >&2
    exit 1
fi

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    ZLIB_PREFIX="$HERE/../zlib/zlib-install"
    if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ] || [ ! -f "$ZLIB_PREFIX/include/zlib.h" ]; then
        echo "==> Building zlib dependency..."
        bash "$HERE/../zlib/build-zlib.sh"
    fi
fi
if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ] || [ ! -f "$ZLIB_PREFIX/include/zlib.h" ]; then
    echo "ERROR: zlib dependency not found at $ZLIB_PREFIX" >&2
    exit 1
fi

CFLAGS_NATIVE+=(
    -I"$LUA_PREFIX/include"
    -I"$FREETYPE_PREFIX/include/freetype2"
    -I"$ZLIB_PREFIX/include"
)
CXXFLAGS_NATIVE+=(
    -I"$LUA_PREFIX/include"
    -I"$FREETYPE_PREFIX/include/freetype2"
    -I"$ZLIB_PREFIX/include"
)

DRI_LIBS=(
    "$WASM_POSIX_SYSROOT/lib/libgbm.a"
    "$WASM_POSIX_SYSROOT/lib/libdrm.a"
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

rm -rf "$BUILD"
mkdir -p "$BUILD/obj"

if [ ! -d "$SRC/.git" ]; then
    echo "==> Preparing LÖVE $LOVE_COMMIT..."
    mkdir -p "$SRC"
    git -C "$SRC" init -q
    git -C "$SRC" remote add origin https://github.com/love2d/love.git
fi
if [ "$(cd "$SRC" && git rev-parse HEAD 2>/dev/null || true)" != "$LOVE_COMMIT" ]; then
    echo "==> Checking out LÖVE $LOVE_COMMIT..."
    (cd "$SRC" && git fetch --depth 1 origin "$LOVE_COMMIT" && git checkout --detach "$LOVE_COMMIT")
fi
for patch in "$HERE"/patches/*.patch; do
    [ -e "$patch" ] || continue
    if (cd "$SRC" && git apply --reverse --check "$patch" >/dev/null 2>&1); then
        continue
    fi
    echo "==> Applying $(basename "$patch")..."
    (cd "$SRC" && git apply "$patch")
done

if [ ! -d "$BYTEPATH_SRC/.git" ]; then
    echo "==> Cloning BYTEPATH $BYTEPATH_COMMIT..."
    git clone --depth 1 https://github.com/a327ex/BYTEPATH.git "$BYTEPATH_SRC"
fi
if [ "$(cd "$BYTEPATH_SRC" && git rev-parse HEAD)" != "$BYTEPATH_COMMIT" ]; then
    echo "==> Checking out BYTEPATH $BYTEPATH_COMMIT..."
    (cd "$BYTEPATH_SRC" && git fetch --depth 1 origin "$BYTEPATH_COMMIT" && git checkout "$BYTEPATH_COMMIT")
fi

if [ ! -d "$SNKRX_SRC/.git" ]; then
    echo "==> Cloning SNKRX $SNKRX_COMMIT..."
    git clone --depth 1 https://github.com/a327ex/SNKRX.git "$SNKRX_SRC"
fi
if [ "$(cd "$SNKRX_SRC" && git rev-parse HEAD)" != "$SNKRX_COMMIT" ]; then
    echo "==> Checking out SNKRX $SNKRX_COMMIT..."
    (cd "$SNKRX_SRC" && git fetch --depth 1 origin "$SNKRX_COMMIT" && git checkout "$SNKRX_COMMIT")
fi

obj_for() {
    local rel="${1#$REPO_ROOT/}"
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
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$GLUE_DIR/cxxrt.c"
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
    "$WASM_POSIX_SYSROOT/lib/crt1.o" \
    "$LUA_PREFIX/lib/liblua.a" \
    "$FREETYPE_PREFIX/lib/libfreetype.a" \
    "$ZLIB_PREFIX/lib/libz.a" \
    "${DRI_LIBS[@]}" \
    "$LIBCXX_PREFIX/lib/libc++.a" \
    "$LIBCXX_PREFIX/lib/libc++abi.a" \
    "$WASM_POSIX_SYSROOT/lib/libc.a" \
    "${LDFLAGS_NATIVE[@]}" \
    -o "$HERE/love.wasm"

echo "==> Bundling Love game demos..."
EXAMPLES_BUILD="$BUILD/examples"
BYTEPATH_BUILD="$EXAMPLES_BUILD/bytepath"
SNKRX_BUILD="$EXAMPLES_BUILD/snkrx"
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

rm -f "$HERE/love-examples.zip"
(cd "$EXAMPLES_BUILD" && zip -qr "$HERE/love-examples.zip" . -x '*.DS_Store')

ls -lh "$HERE/love.wasm" "$HERE/love-examples.zip"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary love "$HERE/love.wasm"
install_local_binary love "$HERE/love-examples.zip"

# Keep direct ad-hoc builds useful even in minimal environments without cargo,
# where install-local-binary.sh cannot ask xtask for multi-output paths.
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
mkdir -p "$REPO_ROOT/local-binaries/programs/$ARCH/love"
cp "$HERE/love.wasm" "$REPO_ROOT/local-binaries/programs/$ARCH/love/love.wasm"
cp "$HERE/love-examples.zip" "$REPO_ROOT/local-binaries/programs/$ARCH/love/love-examples.zip"
