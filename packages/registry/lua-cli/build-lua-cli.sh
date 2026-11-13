#!/usr/bin/env bash
#
# Build the `lua` interpreter for Kandelo by linking upstream's lua.c against
# the lua library package's liblua.a.
#
# A direct build writes the work directory below packages/registry/lua-cli.
# Resolver builds write only below their declared work and output roots.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/lua-src"
OUT_BIN="$WORK_DIR/lua.wasm"
LUA_DIR="${WASM_POSIX_DEP_LUA_DIR:?resolver did not provide the lua dependency}"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

source "$REPO_ROOT/sdk/activate.sh"

echo "==> Staging pinned Lua source for lua.c..."
kandelo_package_stage_primary_source lua-cli "$SRC" "$WORK_DIR"

echo "==> Linking lua against liblua.a..."
wasm32posix-cc -O2 -DLUA_COMPAT_ALL -DLUA_USE_POSIX \
    -I"$LUA_DIR/include" \
    "$SRC/src/lua.c" \
    -L"$LUA_DIR/lib" -llua -lm \
    -o "$OUT_BIN"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lua-cli "$OUT_BIN" lua.wasm
