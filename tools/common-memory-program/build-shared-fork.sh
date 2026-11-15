#!/usr/bin/env bash
set -euo pipefail
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
out="${1:?usage: build-shared-fork.sh fresh-output-directory}"
mkdir -p "$out"
sdk/bin/wasm32posix-cc -O2 -pthread tools/common-memory-program/shared-fork.c -o "$out/shared-fork.linked.wasm"
scripts/run-wasm-fork-instrument.sh "$out/shared-fork.linked.wasm" -o "$out/shared-fork.native.wasm"
host_target="$(rustc -vV | sed -n 's/^host: //p')"
cargo run -p xtask --target "$host_target" --quiet -- stamp-abi-contract "$out/shared-fork.native.wasm"
bash tools/common-memory-program/build-helpers.sh "$out"
tools/common-memory-program/instrument/target/"$host_target"/debug/common-memory-program-instrument \
  "$out/shared-fork.native.wasm" "$out/helpers.wasm" \
  "$out/shared-fork.vm.wasm" > "$out/translation.json"
