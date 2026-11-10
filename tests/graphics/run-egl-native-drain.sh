#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.scratch"
out="$(mktemp -d "$root/.scratch/egl-native-drain.XXXXXX")"
trap 'rm -rf "$out"' EXIT
: "${KANDELO_GBM_LIBDRM_PREFIX:?explicit libdrm headers required}"
mkdir -p "$out/include/drm"
for name in EGL GLES2 KHR;do cp -R "$root/libc/musl-overlay/include/$name" "$out/include/";done
cp "$root/libc/musl-overlay/include/gbm.h" "$out/include/"
cp "$KANDELO_GBM_LIBDRM_PREFIX"/include/drm/*.h "$out/include/drm/"
cp "$KANDELO_GBM_LIBDRM_PREFIX/include/libdrm/xf86drm.h" "$out/include/"
link_gc=-Wl,--gc-sections;if [ "$(uname -s)" = Darwin ];then link_gc=-Wl,-dead_strip;fi
for backend in peer optional;do
flags=();if [ "$backend" = optional ];then flags+=(-DWPK_EGL_PENDING_OPTIONAL "$root/tests/graphics/libc/native-graphics-optional.c");fi
clang "${flags[@]}" -std=gnu11 -O1 -g -pthread -fsanitize=undefined -fno-sanitize-recover=all \
 -ffunction-sections -fdata-sections -Wno-ignored-attributes -Wno-pointer-bool-conversion \
 -I"$out/include" -I"$out/include/drm" -I"$root/libc/glue" -I"$root/tests/graphics/libc" \
 "$root/tests/graphics/libc/egl-native-drain.c" "$link_gc" -o "$out/control-$backend"
for mode in 0 1 2 3 4;do "$out/control-$backend" "$mode";done
done
"$out/control-optional" optional-empty
python3 - "$out/control-optional" <<'PYOPTIONAL'
import signal,subprocess,sys
for mode in ['unsupported-window-live','unsupported-window-retired','unsupported-display-live','unsupported-display-retired']:
 r=subprocess.run([sys.argv[1],mode],capture_output=True,text=True,timeout=12)
 assert r.returncode==-signal.SIGABRT,(mode,r.returncode,r.stdout,r.stderr)
 print('PASS optional native peer fails loudly for '+mode)
PYOPTIONAL
