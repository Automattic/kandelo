#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
output_dir="$(mktemp -d "$repo_root/.context/graphics-wayland-window.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
mkdir -p "$output_dir/include/drm"
if [ -n "${2:-}" ]; then
    source_root="$2"
    cp "$source_root"/src/wayland-{client,client-core,util}.h "$output_dir/include/"
    cp "$repo_root"/libc/glue/wayland-egl-include/*.h "$output_dir/include/"
    wayland-scanner client-header "$source_root/protocol/wayland.xml" "$output_dir/include/wayland-client-protocol.h"
    sed -e 's/@WAYLAND_VERSION_MAJOR@/1/g' -e 's/@WAYLAND_VERSION_MINOR@/24/g' \
        -e 's/@WAYLAND_VERSION_MICRO@/0/g' -e 's/@WAYLAND_VERSION@/1.24.0/g' \
        "$source_root/src/wayland-version.h.in" > "$output_dir/include/wayland-version.h"
    cp "$repo_root/libc/musl-overlay/include/gbm.h" "$output_dir/include/"
    cp "$3"/include/drm/*.h "$output_dir/include/drm/"
else
    cp "$repo_root"/sysroot/include/wayland*.h "$repo_root/sysroot/include/gbm.h" "$output_dir/include/"
    cp "$repo_root"/sysroot/include/drm/*.h "$output_dir/include/drm/"
fi
protocol_xml="${1:-$repo_root/sysroot/share/wayland-protocols/stable/linux-dmabuf/linux-dmabuf-v1.xml}"
if [ ! -f "$protocol_xml" ]; then
    echo "Provide the installed wayland-protocols linux-dmabuf-v1.xml as argument 1" >&2
    exit 1
fi
wayland-scanner client-header "$protocol_xml" "$output_dir/include/linux-dmabuf-v1-client-protocol.h"
clang -g -O1 -pthread -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}" -fno-sanitize-recover=all -fno-omit-frame-pointer \
    -I"$output_dir/include" -I"$repo_root/libc/glue" \
    "$repo_root/tests/graphics/libc/wayland-window.c" -o "$output_dir/wayland-window"
python3 - "$output_dir/wayland-window" <<'PYTHON'
import subprocess,sys
try:
    result=subprocess.run(sys.argv[1:],timeout=30)
except subprocess.TimeoutExpired:
    raise SystemExit("FAIL: native Wayland window case timed out")
sys.exit(result.returncode if result.returncode>=0 else 128-result.returncode)
PYTHON
