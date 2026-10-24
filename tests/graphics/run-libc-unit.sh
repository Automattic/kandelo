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
default_cases="image-bind-ack image-bind-errors image-bind-render image-external-name image-target-render image-attachment-errors image-unit-growth image-logical-bindings image-target-identity image-record-lifetime encoder-uniform-lookup encoder-uniform-lookup-errors encoder-uniform-reflection encoder-uniform-values encoder-uniform-errors encoder-array-index-render encoder-array-render encoder-array-save names-render names-implicit group-metadata group-parallel names-rollback names-lifetime records-transfer-existing records-basic records-query records-rollback records-transfer records-attributes records-thread lifetime redefine context invalid framebuffer cycle namespace boolean query-vector query-error config-selection config-validation config-list thread-error api-error thread-current destroy-current surface-current terminate-current bind-rollback create-rollback surfaceless-bind release-rollback bind-errors surface-retarget surface-create-ack encoder-allocation encoder-unbound encoder-transfer encoder-strings encoder-delete-array encoder-delete-element encoder-vao-elements encoder-vao-attribs encoder-stage-allocation encoder-vao-name-reuse encoder-buffer-names encoder-large-client encoder-large-fixed encoder-client-overflow encoder-client-guard encoder-index-guard encoder-client-prefix encoder-client-scratch encoder-draw-enums encoder-max-byte encoder-max-short encoder-buffer-query encoder-vertex-query encoder-bound-errors encoder-bound-byte encoder-bound-short encoder-core-source encoder-core-reflection encoder-core-params encoder-core-image encoder-shader-upload encoder-shader-errors encoder-shader-ack encoder-submit-failure display-join-rollback display-generation display-generation-allocation display-generation-release display-generation-thread display-image-acquire display-generation-render image-stale-handles"
for case_name in ${KANDELO_GRAPHICS_LIBC_CASES:-$default_cases}; do
    python3 - "$output_dir/image-ownership" "$case_name" <<'PYTHON' || status=1
import subprocess, sys
try:
    result = subprocess.run(sys.argv[1:], timeout=30)
except subprocess.TimeoutExpired:
    print("FAIL: native graphics case timed out: " + sys.argv[2], flush=True)
    sys.exit(1)
if result.returncode < 0:
    print("FAIL: native graphics case " + sys.argv[2] + " terminated by signal " + str(-result.returncode), flush=True)
sys.exit(result.returncode if result.returncode >= 0 else 1)
PYTHON
done
exit "$status"
