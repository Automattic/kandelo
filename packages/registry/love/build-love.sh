#!/usr/bin/env bash
#
# Build the native Kandelo framebuffer LÖVE runtime.
#
# This intentionally does not use Emscripten. The result is a POSIX/Wasm
# program linked by wasm32posix-c++ that opens /dev/fb0 at runtime.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$HERE/love-src"
LUA_SRC="$HERE/lua-src"
GAME_DEMOS_SRC="$HERE/game-demos"
BUILD="$HERE/build"

LOVE_COMMIT="6eb8d546736d5915a8b5af30b2cf33456dfdcb1a" # 11.5
LUA_VERSION="5.1.5"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

find_llvm_bin() {
    if [ -n "${WASM_POSIX_LLVM_DIR:-}" ]; then echo "$WASM_POSIX_LLVM_DIR"; return; fi
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
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
CXX="$LLVM_BIN/clang++"
GLUE_DIR="$REPO_ROOT/libc/glue"
CXXFLAGS_NATIVE=(
    --target=wasm32-unknown-unknown
    --sysroot="$WASM_POSIX_SYSROOT"
    -matomics -mbulk-memory
    -fno-trapping-math
    -fno-exceptions
    -fno-rtti
    -isystem "$WASM_POSIX_SYSROOT/include/c++/v1"
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

if [ ! -d "$SRC/.git" ]; then
    echo "==> Cloning LÖVE $LOVE_COMMIT..."
    git clone --filter=blob:none https://github.com/love2d/love.git "$SRC"
fi
if [ "$(cd "$SRC" && git rev-parse HEAD)" != "$LOVE_COMMIT" ]; then
    echo "==> Checking out LÖVE $LOVE_COMMIT..."
    (cd "$SRC" && git fetch --depth 1 origin "$LOVE_COMMIT" && git checkout "$LOVE_COMMIT")
fi

if [ ! -f "$LUA_SRC/src/lua.h" ]; then
    echo "==> Downloading Lua $LUA_VERSION..."
    rm -rf "$LUA_SRC"
    tmp="/tmp/lua-$LUA_VERSION.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "https://www.lua.org/ftp/lua-$LUA_VERSION.tar.gz" -o "$tmp"
    mkdir -p "$LUA_SRC"
    tar xzf "$tmp" -C "$LUA_SRC" --strip-components=1
    rm -f "$tmp"
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/lua"

echo "==> Compiling Lua $LUA_VERSION..."
LUA_SOURCES=(
    lapi.c lauxlib.c lbaselib.c lcode.c ldblib.c ldebug.c ldo.c ldump.c
    lfunc.c lgc.c linit.c liolib.c llex.c lmathlib.c lmem.c loadlib.c
    lobject.c lopcodes.c lparser.c lstate.c lstring.c lstrlib.c
    ltable.c ltablib.c ltm.c lundump.c lvm.c lzio.c
)
for src in "${LUA_SOURCES[@]}"; do
    wasm32posix-cc -O2 -I"$LUA_SRC/src" \
        -c "$LUA_SRC/src/$src" -o "$BUILD/lua/${src%.c}.o"
done

echo "==> Compiling framebuffer runtime..."
"$CXX" "${CXXFLAGS_NATIVE[@]}" -O2 -std=c++17 \
    -I"$LUA_SRC/src" \
    -I"$SRC/src/libraries/lodepng" \
    -c "$HERE/src/lovefb.cpp" -o "$BUILD/lovefb.o"
"$CXX" "${CXXFLAGS_NATIVE[@]}" -O2 -std=c++17 \
    -I"$SRC/src/libraries/lodepng" \
    -c "$SRC/src/libraries/lodepng/lodepng.cpp" -o "$BUILD/lodepng.o"

echo "==> Linking love.wasm..."
"$CXX" "${CXXFLAGS_NATIVE[@]}" -O2 \
    "$BUILD/lovefb.o" "$BUILD/lodepng.o" "$BUILD"/lua/*.o \
    "$GLUE_DIR/channel_syscall.c" \
    "$GLUE_DIR/compiler_rt.c" \
    "$GLUE_DIR/cxxrt.c" \
    "$WASM_POSIX_SYSROOT/lib/crt1.o" \
    "$WASM_POSIX_SYSROOT/lib/libc++.a" \
    "$WASM_POSIX_SYSROOT/lib/libc++abi.a" \
    "$WASM_POSIX_SYSROOT/lib/libc.a" \
    "${LDFLAGS_NATIVE[@]}" \
    -o "$HERE/love.wasm"

echo "==> Bundling Love game demos..."
rm -f "$HERE/love-examples.zip"
(cd "$GAME_DEMOS_SRC" && zip -qr "$HERE/love-examples.zip" . -x '*.DS_Store')

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
