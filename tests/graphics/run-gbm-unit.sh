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
native_flags=(-g -O1 -pthread -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}"
    -fno-omit-frame-pointer -fno-sanitize-recover=all
    -I"$output_dir/include" -I"$output_dir/include/drm")
clang "${native_flags[@]}" -include "$repo_root/tests/graphics/libc/gbm-map-double.h" \
    -c "$repo_root/libc/glue/libgbm_stub.c" -o "$output_dir/gbm.o"
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
clang "${native_flags[@]}" \
    "$output_dir/gbm.o" \
    "$repo_root/tests/graphics/libc/gbm-surface-metadata.c" \
    -o "$output_dir/gbm-metadata"
"$output_dir/gbm-metadata"
