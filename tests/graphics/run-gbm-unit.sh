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
cp "$repo_root/libc/glue/gbm_window.h" "$output_dir/include/"
[ $# -le 1 ] || { echo "Usage: $0 [git-ref]" >&2; exit 1; }
native_flags=(-g -O1 -pthread -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}"
    -fno-omit-frame-pointer -fno-sanitize-recover=all
    -I"$output_dir/include" -I"$output_dir/include/drm")
if [ $# -eq 1 ]; then
    git -C "$repo_root" show "$1:libc/glue/libgbm_stub.c" > "$output_dir/gbm.c"
else
    cp "$repo_root/libc/glue/libgbm_stub.c" "$output_dir/gbm.c"
fi
clang "${native_flags[@]}" -include "$repo_root/tests/graphics/libc/gbm-map-double.h" \
    -c "$output_dir/gbm.c" -o "$output_dir/gbm.o"
python3 - "$repo_root/libc/musl-overlay/include/gbm.h" "$output_dir/gbm.o" <<'PY'
import re, subprocess, sys
from pathlib import Path
declared = set(re.findall(r"^(gbm_\w+)\s*\(", Path(sys.argv[1]).read_text(), re.M))
symbols = subprocess.check_output(["llvm-nm", "--defined-only", "--extern-only", sys.argv[2]], text=True)
defined = {line.split()[-1].lstrip("_") for line in symbols.splitlines() if line.split()}
missing = sorted(declared - defined)
if not declared or missing:
    raise SystemExit(f"GBM public symbol inventory failed: {missing}")
print(f"PASS all {len(declared)} public GBM header symbols defined (native source)")
PY
clang "${native_flags[@]}" -include "$repo_root/tests/graphics/libc/gbm-map-double.h" \
    -DKANDELO_GBM_TEST_PROCESS=1 -c "$repo_root/tests/graphics/libc/gbm-surface-metadata.c" -o "$output_dir/test.o"
clang "${native_flags[@]}" \
    "$output_dir/gbm.o" "$output_dir/test.o" \
    "$repo_root/tests/graphics/libc/gbm-file-double.c" \
    -o "$output_dir/gbm-metadata"
python3 - "$output_dir/gbm-metadata" <<'PY'
import subprocess, sys
try:
    result = subprocess.run(sys.argv[1:], timeout=30)
except subprocess.TimeoutExpired:
    raise SystemExit("FAIL: native GBM process did not finish within 30s")
sys.exit(result.returncode if result.returncode >= 0 else 128 - result.returncode)
PY
