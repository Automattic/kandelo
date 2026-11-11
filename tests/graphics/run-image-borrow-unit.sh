#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.scratch"
out="$(mktemp -d "$root/.scratch/image-borrow.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/include"
for name in EGL GLES2 KHR;do cp -R "$root/libc/musl-overlay/include/$name" "$out/include/";done
cp "$root/libc/musl-overlay/include/gbm.h" "$out/include/"
link_gc='-Wl,--gc-sections'
if [ "$(uname -s)" = Darwin ];then link_gc='-Wl,-dead_strip';fi
clang -std=gnu11 -O1 -g -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}" \
 -fno-sanitize-recover=all -ffunction-sections -fdata-sections -pthread \
 -DWPK_BORROW_NEW -I"$out/include" -I"$root/libc/glue" \
 "$root/tests/graphics/libc/image-borrow-fork.c" "$root/libc/glue/drm_owned.c" \
 "$link_gc" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/image-borrow"
for control in fork storage nested exit cancel oom saturation;do
 python3 - "$out/image-borrow" "$control" <<'PY'
import subprocess,sys
r=subprocess.run(sys.argv[1:],timeout=15)
raise SystemExit(r.returncode if r.returncode>=0 else 1)
PY
done
