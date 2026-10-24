#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
output_dir="$(mktemp -d "$repo_root/.context/graphics-gbm.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
# Use only the provisioned public DRM headers, not sysroot libc headers,
# when compiling the actual GBM source for the native test process.
mkdir -p "$output_dir/include/drm"
cp "$repo_root/sysroot/include/libdrm/xf86drm.h" "$output_dir/include/"
cp "$repo_root/sysroot/include/drm/"*.h "$output_dir/include/drm/"
cp "$repo_root/libc/musl-overlay/include/gbm.h" "$output_dir/include/"
clang -g -O1 -pthread -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}" \
    -fno-omit-frame-pointer -fno-sanitize-recover=all \
    -I"$output_dir/include" -I"$output_dir/include/drm" \
    "$repo_root/libc/glue/libgbm_stub.c" \
    "$repo_root/tests/graphics/libc/gbm-surface-metadata.c" \
    -o "$output_dir/gbm-metadata"
"$output_dir/gbm-metadata"
