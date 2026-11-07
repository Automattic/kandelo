#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d "$root/.context/egl-release-queues.XXXXXX")"
trap 'rm -rf "$out"' EXIT
: "${KANDELO_GBM_LIBDRM_PREFIX:?explicit libdrm headers required}"
mkdir -p "$out/include/drm"
for name in EGL GLES2 KHR;do cp -R "$root/libc/musl-overlay/include/$name" "$out/include/";done
cp "$root/libc/musl-overlay/include/gbm.h" "$out/include/"
cp "$KANDELO_GBM_LIBDRM_PREFIX"/include/drm/*.h "$out/include/drm/"
cp "$KANDELO_GBM_LIBDRM_PREFIX/include/libdrm/xf86drm.h" "$out/include/"
link_gc='-Wl,--gc-sections';if [ "$(uname -s)" = Darwin ];then link_gc='-Wl,-dead_strip';fi
queue_glue="${KANDELO_EGL_QUEUE_GLUE:-$root/libc/glue}"
flags=();if [ "${KANDELO_EGL_QUEUE_BEFORE:-0}" = 1 ];then flags+=(-DWPK_EGL_QUEUE_BEFORE);fi
clang -std=gnu11 -O1 -g -pthread -fsanitize=undefined -fno-sanitize-recover=all \
 -ffunction-sections -fdata-sections -Wno-ignored-attributes -Wno-pointer-bool-conversion ${flags[@]+"${flags[@]}"} \
 -I"$out/include" -I"$out/include/drm" -I"$queue_glue" -I"$root/tests/graphics/libc" \
 "$root/tests/graphics/libc/egl-release-queues.c" "$link_gc" -o "$out/queues"
controls=("$@");if [ "${#controls[@]}" = 0 ];then controls=(gbm-plain gbm-pending gbm-nested gbm-nested-self gbm-self gbm-exit gbm-mixed-exit gbm-foreign-first gbm-foreign-second wayland-plain wayland-idle-fork wayland-prepare-fail wayland-nested wayland-nested-self wayland-self wayland-inherited wayland-exit wayland-foreign generation-plain generation-after-clear-foreign generation-idle-fork generation-prepare-fail generation-nested generation-nested-self generation-self generation-inherited generation-exit generation-foreign);fi
python3 - "$out/queues" "${controls[@]}" <<'PYRUN'
import json,os,pathlib,subprocess,sys
rows=[]
for control in sys.argv[2:]:
 r=subprocess.run([sys.argv[1],control],capture_output=True,text=True,timeout=15)
 print(r.stdout+r.stderr,end="",flush=True)
 rows.append({'control':control,'returncode':r.returncode,'output':r.stdout+r.stderr,
  'claim':'observed unresolved opaque leaf; custody retained' if any(s in control for s in ('wayland-exit','wayland-foreign','generation-exit','generation-foreign','inherited','idle-fork')) else 'focused queue behavior'})
if os.environ.get('KANDELO_EGL_QUEUE_RESULTS'):
 pathlib.Path(os.environ['KANDELO_EGL_QUEUE_RESULTS']).write_text(json.dumps(rows,indent=2)+'\n')
negative=os.environ.get('KANDELO_EGL_QUEUE_EXPECT_FAILURE')=='1'
assert all((r['returncode']!=0 if negative else r['returncode']==0) for r in rows),rows
PYRUN
