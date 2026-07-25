#!/usr/bin/env bash
#
# Keep fixed native signal/stat/scheduler records synchronized with the actual
# musl structures installed in both Kandelo target sysroots.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_file="$repo_root/tests/abi/fixed-process-layouts.c"
layout_tmp="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-fixed-layouts.XXXXXX")"

cleanup() {
    rm -f "$layout_tmp/wasm32.o" "$layout_tmp/wasm64.o"
    rmdir "$layout_tmp"
}
trap cleanup EXIT

wasm32posix-cc -std=c11 -Wall -Wextra -Werror \
    -c "$source_file" -o "$layout_tmp/wasm32.o"
wasm64posix-cc -std=c11 -Wall -Wextra -Werror \
    -c "$source_file" -o "$layout_tmp/wasm64.o"

echo "fixed-process-layouts: wasm32 and wasm64 musl layouts match"
