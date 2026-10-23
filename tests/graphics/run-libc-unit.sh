#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
output_dir="$(mktemp -d "$repo_root/.context/graphics-libc.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
mkdir -p "$output_dir/include" "$output_dir/glue"
for name in EGL GLES2 KHR; do
    cp -R "$repo_root/libc/musl-overlay/include/$name" "$output_dir/include/"
done
for name in gl_abi.h libegl_stub.c libglesv2_stub.c; do
    if [ $# -eq 1 ]; then
        git -C "$repo_root" show "$1:libc/glue/$name" > "$output_dir/glue/$name"
    else
        cp "$repo_root/libc/glue/$name" "$output_dir/glue/$name"
    fi
done
clang -g -O1 -pthread -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}" -fno-omit-frame-pointer \
    -I"$output_dir/include" -I"$output_dir/glue" \
    -include "$repo_root/tests/graphics/libc/device-double.h" \
    "$output_dir/glue/libegl_stub.c" "$output_dir/glue/libglesv2_stub.c" \
    "$repo_root/tests/graphics/libc/image-ownership.c" -o "$output_dir/image-ownership"
status=0
for case_name in lifetime redefine context invalid framebuffer cycle namespace boolean query-vector query-error config-selection config-validation config-list thread-error api-error thread-current destroy-current surface-current terminate-current bind-rollback; do
    python3 - "$output_dir/image-ownership" "$case_name" <<'PYTHON' || status=1
import subprocess, sys
try:
    result = subprocess.run(sys.argv[1:], timeout=30)
except subprocess.TimeoutExpired:
    print("FAIL: native graphics case timed out: " + sys.argv[2], flush=True)
    sys.exit(1)
sys.exit(result.returncode if result.returncode >= 0 else 1)
PYTHON
done
exit "$status"
