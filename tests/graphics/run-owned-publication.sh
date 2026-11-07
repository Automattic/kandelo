#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d "$root/.context/owned-publication.XXXXXX")"
trap 'rm -rf "$out"' EXIT
clang -std=c11 -g -O1 -Wall -Wextra -Werror -Wno-unused-function -pthread \
 -fsanitize=undefined -fno-sanitize-recover=all -DWPK_CAPTURE_GUARD \
 -I"$root/libc/glue" -I"$root/tests/graphics/libc" \
 "$root/tests/graphics/libc/drm-owned-publication.c" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/publication"
for name in known-child-blocked fork-establish fork-complete fork-recovery-claim fork-recovery-complete fork-recovery-retire fork-completed-claim;do
 python3 - "$out/publication" "$name" <<'PY'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=15)
raise SystemExit(r.returncode if r.returncode>=0 else 1)
PY
done
