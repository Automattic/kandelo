#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
output_dir="$(mktemp -d "$repo_root/.context/graphics-wayland-window.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
mkdir -p "$output_dir/include/drm"
cp "$repo_root"/sysroot/include/wayland*.h "$repo_root/sysroot/include/gbm.h" "$output_dir/include/"
cp "$repo_root"/sysroot/include/drm/*.h "$output_dir/include/drm/"
protocol_xml="${1:-$repo_root/sysroot/share/wayland-protocols/stable/linux-dmabuf/linux-dmabuf-v1.xml}"
if [ ! -f "$protocol_xml" ]; then
    echo "Provide the installed wayland-protocols linux-dmabuf-v1.xml as argument 1" >&2
    exit 1
fi
wayland-scanner client-header "$protocol_xml" "$output_dir/include/linux-dmabuf-v1-client-protocol.h"
clang -g -O1 -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}" -fno-omit-frame-pointer \
    -I"$output_dir/include" -I"$repo_root/libc/glue" \
    "$repo_root/tests/graphics/libc/wayland-window.c" -o "$output_dir/wayland-window"
"$output_dir/wayland-window"
