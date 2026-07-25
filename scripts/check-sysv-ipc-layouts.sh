#!/usr/bin/env bash
#
# Keep Rust/host epoll and bounded SysV IPC layouts synchronized with the
# actual musl structures installed in both Kandelo target sysroots.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_file="$repo_root/tests/abi/sysv-ipc-layouts.c"
layout_tmp="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-ipc-layouts.XXXXXX")"

cleanup() {
    rm -f "$layout_tmp/wasm32.o" "$layout_tmp/wasm64.o"
    rmdir "$layout_tmp"
}
trap cleanup EXIT

wasm32posix-cc -std=c11 -Wall -Wextra -Werror \
    -c "$source_file" -o "$layout_tmp/wasm32.o"
wasm64posix-cc -std=c11 -Wall -Wextra -Werror \
    -c "$source_file" -o "$layout_tmp/wasm64.o"

echo "native-ipc-layouts: wasm32 and wasm64 musl layouts match"
