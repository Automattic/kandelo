#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d "$root/.context/graphics-owned-peer.XXXXXX")"
trap 'rm -rf "$out"' EXIT
common_source="${KANDELO_OWNED_PEER_SOURCE:-$root/libc/glue/drm_owned.c}"
clang -std=c11 -D_GNU_SOURCE -g -O1 -pthread -Wall -Wextra -Werror -Wno-unused-command-line-argument \
    -fsanitize=undefined -fno-sanitize-recover=all -I"$root/libc/glue" \
    -include "$root/tests/graphics/libc/owned-peer-double.h" \
    "$common_source" "$root/tests/graphics/libc/owned-resource-peer.c" \
    "$root/tests/graphics/libc/owned-peer-controls.c" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/peer"
status=0
for name in ${KANDELO_OWNED_PEER_CASES:-fd-reuse same-file-handle-reuse create-lost dup-lost-reused release-lost fork-parent-first fork-child-first cold-fork-unknown capture-fork-unknown queue-fork-consumed queue-fork-nonentry queue-fork-multiple queue-fork-unknown queue-fork-first}; do
    python3 - "$out/peer" "$name" <<'PY' || status=1
import subprocess,sys
result=subprocess.run(sys.argv[1:],timeout=20)
if result.returncode: print("FAIL owned-peer "+sys.argv[2],flush=True)
raise SystemExit(result.returncode if result.returncode>=0 else 128-result.returncode)
PY
done
exit "$status"
