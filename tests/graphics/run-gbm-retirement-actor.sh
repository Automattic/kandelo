#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d "$root/.context/gbm-retirement.XXXXXX")"
trap 'rm -rf "$out"' EXIT
: "${KANDELO_GBM_LIBDRM_PREFIX:?explicit libdrm headers required}"
mkdir -p "$out/include/drm"
cp "$root/libc/musl-overlay/include/gbm.h" "$out/include/"
cp "$KANDELO_GBM_LIBDRM_PREFIX"/include/drm/*.h "$out/include/drm/"
cp "$KANDELO_GBM_LIBDRM_PREFIX/include/libdrm/xf86drm.h" "$out/include/"
link_gc='-Wl,--gc-sections';if [ "$(uname -s)" = Darwin ];then link_gc='-Wl,-dead_strip';fi
flags=();if [ "${KANDELO_GBM_RETIREMENT_BEFORE:-0}" = 1 ];then flags+=(-DWPK_GBM_RETIREMENT_BEFORE);fi
clang -std=gnu11 -O1 -g -pthread -fsanitize=undefined -fno-sanitize-recover=all \
 -ffunction-sections -fdata-sections ${flags[@]+"${flags[@]}"} \
 -I"$out/include" -I"$out/include/drm" -I"$root/libc/glue" -I"$root/tests/graphics/libc" \
 "$root/tests/graphics/libc/gbm-retirement-actor.c" "$link_gc" -o "$out/actor"
controls=("$@");if [ "${#controls[@]}" = 0 ];then controls=(plain public device first second surface-first surface-second callback-fork callback-exit public-callback-fork public-callback-exit public-callback-nested ordinary-destroy-first ordinary-destroy-second ordinary-last-first ordinary-last-second ordinary-callback-fork ordinary-callback-exit ordinary-last-callback-fork ordinary-last-callback-exit public-admission surface-admission public-preparation-failure surface-preparation-failure);fi
for control in "${controls[@]}";do
 python3 - "$out/actor" "$control" <<'PY'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=15)
raise SystemExit(r.returncode if r.returncode>=0 else 1)
PY
done
