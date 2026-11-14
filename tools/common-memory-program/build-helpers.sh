#!/usr/bin/env bash
set -euo pipefail
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
out="${1:?usage: build-helpers.sh output-directory}"
mkdir -p "$out"
"$LLVM_BIN/clang" --target=wasm32-unknown-unknown -ffreestanding -fno-builtin \
  -O2 -matomics -mbulk-memory -msimd128 -nostdlib \
  -fuse-ld="$LLVM_BIN/wasm-ld" -Wl,--no-entry -Wl,--import-memory \
  -Wl,--shared-memory -Wl,--initial-memory=131072 -Wl,--max-memory=4294967296 \
  tools/common-memory-program/helpers.c -o "$out/helpers.wasm"
wasm-validate --enable-threads "$out/helpers.wasm"
wasm2wat --enable-threads "$out/helpers.wasm" -o "$out/helpers.wat"
