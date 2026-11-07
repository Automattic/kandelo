#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d "$root/.context/graphics-native-fork-epoch.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/include"
# Only the explicit musl-state boundary is doubled. Execute the actual child
# rebinding source so counter ordering cannot diverge into a fixture model.
printf '#define hidden\ntypedef struct epoch_thread *epoch_pthread_t;\n' > "$out/include/pthread_impl.h"
printf '#define SYS_set_tid_address 17\n' > "$out/include/syscall.h"
clang -std=gnu11 -g -O1 -fsanitize=undefined -fno-sanitize-recover=all \
    "-DWPK_POST_FORK_SOURCE=\"$root/libc/musl-overlay/src/process/wasm32posix/post_fork_child.c\"" \
    -I"$out/include" "$root/tests/graphics/libc/native-fork-epoch.c" -o "$out/control"
"$out/control"
