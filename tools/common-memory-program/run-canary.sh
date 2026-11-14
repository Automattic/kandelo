#!/usr/bin/env bash
set -euo pipefail
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
out="${1:?usage: run-canary.sh fresh-output-directory}"
profile="${2:-expanded}"
options=()
case "$profile" in
  expanded) ;;
  outlined) options=(--outline-accesses) ;;
  *) echo "unknown access profile: $profile" >&2; exit 2 ;;
esac
mkdir -p "$out"
bash tools/common-memory-program/build-helpers.sh "$out"
host_target="$(rustc -vV | sed -n 's/^host: //p')"
cargo build --manifest-path tools/common-memory-program/instrument/Cargo.toml --target "$host_target"
instrument="tools/common-memory-program/instrument/target/$host_target/debug/common-memory-program-instrument"
"$LLVM_BIN/clang" --target=wasm32-unknown-unknown -ffreestanding -fno-builtin \
  -O2 -matomics -mbulk-memory -msimd128 -nostdlib -fuse-ld="$LLVM_BIN/wasm-ld" \
  -Wl,--no-entry -Wl,--import-memory -Wl,--initial-memory=131072 \
  -Wl,--max-memory=16777216 -Wl,--shared-memory \
  tools/common-memory-program/canary.c -o "$out/canary-native.wasm"
"$instrument" "$out/canary-native.wasm" "$out/helpers.wasm" "$out/canary-vm.wasm" "${options[@]}" > "$out/translation.json"
wasm2wat --enable-threads "$out/canary-vm.wasm" -o "$out/canary-vm.wat"
node tools/common-memory-program/check-canary.mjs "$out"
wat2wasm --enable-threads tools/common-memory-program/access-forms.wat -o "$out/access-native.wasm"
"$instrument" "$out/access-native.wasm" "$out/helpers.wasm" "$out/access-vm.wasm" "${options[@]}" > "$out/access-translation.json"
node tools/common-memory-program/check-access-forms.mjs "$out/access-vm.wasm"
