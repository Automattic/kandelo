#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.scratch"
out="$(mktemp -d "$root/.scratch/facade-retirement.XXXXXX")"
trap 'rm -rf "$out"' EXIT
if [ -n "${KANDELO_GBM_LIBDRM_PREFIX:-}" ];then
 libdrm_prefix="$KANDELO_GBM_LIBDRM_PREFIX"
else
 host_target="$(rustc -vV | awk '/^host/ {print $2}')"
 libdrm_prefix="$(cd "$root" && cargo run -p xtask --target "$host_target" \
  --quiet -- build-deps resolve libdrm --arch wasm32 --source-only)"
fi
mkdir -p "$out/include/drm"
for name in EGL GLES2 KHR;do cp -R "$root/libc/musl-overlay/include/$name" "$out/include/";done
cp "$root/libc/musl-overlay/include/gbm.h" "$out/include/"
cp "$libdrm_prefix"/include/drm/*.h "$out/include/drm/"
cp "$libdrm_prefix/include/libdrm/xf86drm.h" "$out/include/"
link_gc='-Wl,--gc-sections';if [ "$(uname -s)" = Darwin ];then link_gc='-Wl,-dead_strip';fi
for kind in egl gbm;do
 flags=();if [ "$kind" = gbm ];then flags+=(-DWPK_FACADE_GBM);fi
 clang -std=gnu11 -O1 -g -pthread -ffunction-sections -fdata-sections \
  -fsanitize=undefined -fno-sanitize-recover=all ${flags[@]+"${flags[@]}"} \
  -I"$out/include" -I"$out/include/drm" -I"$root/libc/glue" -I"$root/tests/graphics/libc" \
  "$root/tests/graphics/libc/facade-retirement.c" "$link_gc" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/$kind"
done
for name in image bo device surface;do
 binary=gbm;if [ "$name" = image ];then binary=egl;fi
 python3 - "$out/$binary" "$name" <<'PY'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=15)
raise SystemExit(r.returncode if r.returncode>=0 else 1)
PY
done
