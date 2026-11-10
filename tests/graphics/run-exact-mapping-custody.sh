#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.scratch"
out="$(mktemp -d "$root/.scratch/exact-mapping.XXXXXX")"
trap 'rm -rf "$out"' EXIT
flags=(-std=gnu11 -O1 -g -pthread -fsanitize=undefined -fno-sanitize-recover=all -I"$root/libc/glue" -I"$root/tests/graphics/libc")
clang "${flags[@]}" "$root/tests/graphics/libc/exact-mapping-custody.c" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/receiver"
for mode in ordinary failed lost-map lost-map-acked lost-unmap lost-unmap-acked partial fork-before fork-after;do
 python3 - "$out/receiver" "$mode" <<'PY'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=15);raise SystemExit(r.returncode)
PY
done
# Race an unrelated FILE publisher; the fixture also denies retired sources.
clang "${flags[@]}" "$root/tests/graphics/libc/exact-mapping-concurrent.c" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/concurrent"
python3 - "$out/concurrent" <<'PYCONCURRENT'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=30);raise SystemExit(r.returncode)
PYCONCURRENT
: "${KANDELO_GBM_LIBDRM_PREFIX:?explicit resolver-owned libdrm headers required}"
mkdir -p "$out/include/drm"
cp "$root/libc/musl-overlay/include/gbm.h" "$out/include/"
cp "$KANDELO_GBM_LIBDRM_PREFIX"/include/drm/*.h "$out/include/drm/"
cp "$KANDELO_GBM_LIBDRM_PREFIX/include/libdrm/xf86drm.h" "$out/include/"
link_gc=-Wl,--gc-sections;if [ "$(uname -s)" = Darwin ];then link_gc=-Wl,-dead_strip;fi
clang "${flags[@]}" -ffunction-sections -fdata-sections -I"$out/include" -I"$out/include/drm" "$root/tests/graphics/libc/gbm-exact-mapping.c" "$link_gc" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/gbm"
for mode in ordinary lost-reply lost-actor replacement;do
 python3 - "$out/gbm" "$mode" <<'PY'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=15);raise SystemExit(r.returncode)
PY
done
