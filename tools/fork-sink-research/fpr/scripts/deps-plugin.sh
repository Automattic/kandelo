#!/usr/bin/env bash
# Rebuild quickshell's C dependencies through their normal recipes into a
# scratch cache root, with the plugin shim first on PATH. Run in dev shell.
set -u
C=$PWD/.context
export WASM_POSIX_BINARY_CACHE_ROOT=$C/depcache
export WASM_POSIX_LLVM_DIR=$C/llvm-shim
H=$(rustc -vV | awk '/^host/ {print $2}')
cargo build -p xtask --target "$H" --quiet 2>/dev/null
X=$PWD/target/$H/debug/xtask
for p in zlib libpng freetype expat libxml2 libiconv libffi libdbus libwayland libxkbcommon libdrm fontconfig harfbuzz; do
  before=$(ls $C/ir/plugin-deps | wc -l)
  start=$(date +%s)
  "$X" build-deps --arch wasm32 resolve "$p" --force-source-build > "$C/ir/deps-$p.log" 2>&1
  rc=$?
  echo "$p rc=$rc secs=$(( $(date +%s) - start )) sidefiles=+$(( $(ls $C/ir/plugin-deps | wc -l) - before ))"
done
