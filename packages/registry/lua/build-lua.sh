#!/usr/bin/env bash
#
# Build Lua as an embeddable static library for wasm32posix.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/lua-src"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/build"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?missing resolver output directory}"
LUA_VERSION="$WASM_POSIX_DEP_VERSION"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_stage_primary_source lua "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"
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
