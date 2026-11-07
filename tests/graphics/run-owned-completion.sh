#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d "$root/.context/owned-completion.XXXXXX")"
trap 'rm -rf "$out"' EXIT
common_source="${KANDELO_OWNED_COMPLETION_SOURCE:-$root/libc/glue/drm_owned.c}"
clang -std=c11 -D_GNU_SOURCE -g -O1 -pthread -Wall -Wextra -Werror -Wno-unused-function \
 -fsanitize=undefined -fno-sanitize-recover=all -I"$root/libc/glue" -I"$root/tests/graphics/libc" \
 "-DWPK_OWNED_COMMON_SOURCE=\"$common_source\"" \
 "$root/tests/graphics/libc/drm-owned-completion.c" -o "$out/completion"
status=0
for name in ${KANDELO_OWNED_COMPLETION_CASES:-enter recover mid-progress release release-committed release-error nonentry cold-preentry cold-ack cold-ack-owned-error cold-ack-rejected cold-ack-lost cold-acquire-ack}; do
python3 - "$out/completion" "$name" <<'PY' || status=1
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=15)
if r.returncode: print('FAIL completion-publication '+sys.argv[2],flush=True)
raise SystemExit(r.returncode if r.returncode>=0 else 128-r.returncode)
PY
done
exit "$status"
