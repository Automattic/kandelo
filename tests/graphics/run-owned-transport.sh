#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d "$root/.context/drm-owned-transport.XXXXXX")"
trap 'rm -rf "$out"' EXIT
clang -std=c11 -g -O1 -Wall -Wextra -Werror -Wno-unused-command-line-argument -pthread \
  -fsanitize=undefined -fno-sanitize-recover=all \
  -I"$root/libc/glue" -include "$root/tests/graphics/libc/drm-owned-double.h" \
  "$root/libc/glue/drm_owned.c" "$root/tests/graphics/libc/drm-owned-transport.c" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/transport"
for name in ${KANDELO_OWNED_TRANSPORT_CASES:-metadata-contended metadata-fork-locked source-pending capture-parent-first poll-basic poll-cancel retain retire-unknown borrowed-alias borrowed-recycled bo-proofs consume-error release-live-error release-consumed-error basic cold-nonentry cold-loss cold-unknown cold-corrupt cold-ack invalid-acquire cancellation release-loss release-unknown release-ack io-loss capture-unknown capture-nonentry capture-absent captured-fd fd-reuse fd-lost-reused fork-locked capture-allocation};do
  python3 - "$out/transport" "$name" <<'PY'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=20)
raise SystemExit(r.returncode if r.returncode>=0 else 1)
PY
done
