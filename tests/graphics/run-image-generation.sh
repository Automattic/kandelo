#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.scratch"
out="$(mktemp -d "$root/.scratch/image-generation.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/include"
for name in EGL GLES2 KHR;do cp -R "$root/libc/musl-overlay/include/$name" "$out/include/";done
cp "$root/libc/musl-overlay/include/gbm.h" "$out/include/"
link_gc='-Wl,--gc-sections';if [ "$(uname -s)" = Darwin ];then link_gc='-Wl,-dead_strip';fi
flags=();if [ "${KANDELO_IMAGE_GENERATION_BEFORE:-0}" != 1 ];then flags+=(-DWPK_IMAGE_GENERATION_OWNED);fi
clang -DWPK_BORROW_NEW -std=gnu11 -O1 -g -pthread -ffunction-sections -fdata-sections \
 -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}" -fno-sanitize-recover=all ${flags[@]+"${flags[@]}"} \
 -I"$out/include" -I"$root/libc/glue" -I"$root/tests/graphics/libc" \
 "$root/tests/graphics/libc/image-generation.c" "$link_gc" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/image-generation"
controls=("$@");if [ "${#controls[@]}" = 0 ];then controls=(lookup generation reuse source publication saturation);fi
for control in "${controls[@]}";do
 ASAN_OPTIONS=detect_leaks=0 python3 - "$out/image-generation" "$control" <<'PY'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=15)
raise SystemExit(r.returncode if r.returncode>=0 else 1)
PY
done
