#!/usr/bin/env bash
#
# Build Lua as an embeddable static library for wasm32posix.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LUA_VERSION="${WASM_POSIX_DEP_VERSION:-${LUA_VERSION:-5.2.4}}"
SRC_DIR="$SCRIPT_DIR/lua-$LUA_VERSION-src"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/lua-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.lua.org/ftp/lua-$LUA_VERSION.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

if [ ! -f "$SRC_DIR/src/lua.h" ]; then
    echo "==> Downloading Lua $LUA_VERSION..."
    rm -rf "$SRC_DIR"
    tmp="/tmp/lua-$LUA_VERSION.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$tmp"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $tmp" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$tmp" -C "$SRC_DIR" --strip-components=1
    rm -f "$tmp"
fi

BUILD_DIR="$SRC_DIR/build-wasm32posix"
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/include" "$INSTALL_DIR/lib/pkgconfig"

echo "==> Compiling Lua $LUA_VERSION..."
mapfile -t LUA_SOURCES < <(
    cd "$SRC_DIR/src"
    find . -maxdepth 1 -name '*.c' -print |
        sed 's#^\./##' |
        grep -Ev '^(lua|luac|print)\.c$' |
        sort
)
OBJS=()
for src in "${LUA_SOURCES[@]}"; do
    obj="$BUILD_DIR/${src%.c}.o"
    wasm32posix-cc -O2 -DLUA_COMPAT_ALL -I"$SRC_DIR/src" -c "$SRC_DIR/src/$src" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Creating liblua.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/liblua.a" "${OBJS[@]}"
wasm32posix-ranlib "$INSTALL_DIR/lib/liblua.a"

cp "$SRC_DIR/src/lua.h" \
   "$SRC_DIR/src/luaconf.h" \
   "$SRC_DIR/src/lualib.h" \
   "$SRC_DIR/src/lauxlib.h" \
   "$INSTALL_DIR/include/"
if [ -f "$SRC_DIR/src/lua.hpp" ]; then
    cp "$SRC_DIR/src/lua.hpp" "$INSTALL_DIR/include/"
fi

PC_FILE="$INSTALL_DIR/lib/pkgconfig/lua${LUA_VERSION%.*}.pc"
cat > "$PC_FILE" <<PCEOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: Lua
Description: Lua language engine
Version: $LUA_VERSION
Libs: -L\${libdir} -llua -lm
Cflags: -I\${includedir}
PCEOF

echo "==> Lua build complete."
ls -lh "$INSTALL_DIR/lib/liblua.a"
