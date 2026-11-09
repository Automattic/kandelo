#!/usr/bin/env bash
# Focused GTK accessibility signal-handler control; supplements normal rebuilt
# GTK consumer acceptance. See README.md.
set -euo pipefail
source_root=${1:?patched pinned GTK source root is required}
before_root=${2:?pinned GTK source root before wasm-a11y-signal-contracts.patch is required}
work_dir=${3:?private output directory is required}
: "${KANDELO_DEV_SHELL_TOOL_PATH:?enter scripts/dev-shell.sh}"
wasm_cc="${LLVM_PREFIX:?enter the declared dev shell}/bin/clang"
test_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$work_dir"

python3 "$test_dir/a11y-signal-contracts.py" "$source_root" "$before_root" "$work_dir"

# Separate translation units, no LTO: the caller cannot see the handler type,
# so only Wasm's call_indirect signature check decides each case.
for optimization in 0 2; do
  "$wasm_cc" --target=wasm32-unknown-unknown -O"$optimization" -ffreestanding -nostdlib \
    -c "$work_dir/invoke.c" -o "$work_dir/invoke-O$optimization.o"
  for state in before after; do
    "$wasm_cc" --target=wasm32-unknown-unknown -O"$optimization" -ffreestanding -nostdlib \
      -c "$work_dir/$state.c" -o "$work_dir/$state-O$optimization.o"
    "$LLVM_PREFIX/bin/wasm-ld" --no-entry --export=run_case --export=recorded_arg \
      "$work_dir/$state-O$optimization.o" "$work_dir/invoke-O$optimization.o" \
      -o "$work_dir/$state-O$optimization.wasm"
  done
  node "$test_dir/run-a11y-signal-contracts.mjs" "$work_dir" "$optimization"
done
