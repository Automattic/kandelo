#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.scratch"
out="$(mktemp -d "$root/.scratch/egl-import-custody.XXXXXX")"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/include"
for name in EGL GLES2 KHR;do cp -R "$root/libc/musl-overlay/include/$name" "$out/include/";done
cp "$root/libc/musl-overlay/include/gbm.h" "$out/include/"
flags=(-g -O1 -pthread -fsanitize=undefined -fno-sanitize-recover=all -fno-omit-frame-pointer
 -Wno-ignored-attributes -Wno-pointer-bool-conversion -I"$out/include"
 -I"$root/libc/glue" -I"$root/tests/graphics/libc")
clang "${flags[@]}" -include "$root/tests/graphics/libc/device-double.h" \
 -c "$root/tests/graphics/libc/egl-import-device.c" -o "$out/device.o"
clang "${flags[@]}" -include "$root/tests/graphics/libc/device-double.h" \
 -c "$root/libc/glue/libglesv2_stub.c" -o "$out/gles.o"
clang "${flags[@]}" "$root/tests/graphics/libc/egl-import-custody.c" "$out/device.o" "$out/gles.o" \
 "$root/tests/graphics/libc/egl-import-peer.c" "$root/tests/graphics/libc/native-graphics-optional.c" -o "$out/control"
python3 - "$out/control" <<'PY'
import json,os,pathlib,subprocess,sys
rows=[]
for mode in ['prime','bo','retain','replace','format-failure','unknown','live-caller','live-session']:
 r=subprocess.run([sys.argv[1],mode],capture_output=True,text=True,timeout=20)
 print(r.stdout+r.stderr,end='',flush=True)
 rows.append({'mode':mode,'returncode':r.returncode,'output':r.stdout+r.stderr})
if os.environ.get('KANDELO_EGL_IMPORT_RESULTS'):
 pathlib.Path(os.environ['KANDELO_EGL_IMPORT_RESULTS']).write_text(json.dumps(rows,indent=2)+'\n')
assert all(x['returncode']==0 for x in rows),rows
PY
