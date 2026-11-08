#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$package_dir/../../.." && pwd)"
source "$package_dir/build-jobs.sh"
build_jobs="$(graphics_cts_build_jobs)"
source "$repo_root/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$package_dir"
source "$repo_root/sdk/activate.sh"
arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
[[ "$arch" == wasm32 ]] || { echo "graphics-cts currently targets wasm32 only" >&2; exit 2; }
kandelo_package_prepare_build_roots "$package_dir" "$arch"
work="$KANDELO_PACKAGE_WORK_DIR"
src="$work/upstream"
build="$work/build"
for dep in LIBCXX LIBDRM LIBPNG ZLIB JSONCPP; do
    key="WASM_POSIX_DEP_${dep}_DIR"
    [[ -n "${!key:-}" ]] || { echo "graphics-cts: resolver must supply $key" >&2; exit 2; }
done
kandelo_package_stage_verified_source graphics-cts "$src" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" "$WASM_POSIX_DEP_SOURCE_SHA256" "$work"
python3 "$package_dir/prepare-source.py" "$src"
for source_patch in "$package_dir"/patches/*.patch; do
    patch --directory "$src" -p1 --fuzz=0 --batch < "$source_patch"
done
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot graphics-cts "$repo_root/sysroot" libcxx libdrm)"
export WASM_POSIX_SYSROOT
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
export CFLAGS="-ffile-prefix-map=$work=/usr/src/graphics-cts"
export CXXFLAGS="-fwasm-exceptions -isystem $WASM_POSIX_SYSROOT/include/c++/v1 -ffile-prefix-map=$work=/usr/src/graphics-cts"
cmake -S "$src" -B "$build" \
    -DCMAKE_TOOLCHAIN_FILE="$repo_root/sdk/cmake/kandelo-toolchain.cmake" \
    -DCMAKE_BUILD_TYPE=RelWithAsserts -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
    -DZLIB_LIBRARY="$WASM_POSIX_DEP_ZLIB_DIR/lib/libz.a" \
    -DZLIB_INCLUDE_DIR="$WASM_POSIX_DEP_ZLIB_DIR/include" \
    -DPNG_LIBRARY_RELEASE="$WASM_POSIX_DEP_LIBPNG_DIR/lib/libpng16.a" \
    -DPNG_PNG_INCLUDE_DIR="$WASM_POSIX_DEP_LIBPNG_DIR/include/libpng16" \
    -DJSONCPP_LIBRARY="$WASM_POSIX_DEP_JSONCPP_DIR/lib/libjsoncpp.a" \
    -DJSONCPP_INCLUDE_DIR="$WASM_POSIX_DEP_JSONCPP_DIR/include" \
    -DDRM_INCLUDE_DIR="$WASM_POSIX_DEP_LIBDRM_DIR/include/drm" \
    -DDRM_PUBLIC_INCLUDE_DIR="$WASM_POSIX_DEP_LIBDRM_DIR/include/libdrm"
cmake --build "$build" --target deqp-egl deqp-gles2 --parallel "$build_jobs"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$repo_root/scripts/install-local-binary.sh"
install_local_binary graphics-cts "$build/modules/egl/deqp-egl.wasm" deqp-egl.wasm
install_local_binary graphics-cts "$build/modules/gles2/deqp-gles2.wasm" deqp-gles2.wasm

# Preserve every upstream GLES2 asset with paths expected by --deqp-archive-dir.
python3 - "$src/data/gles2" "$work/deqp-data.zip" <<'PY'
from pathlib import Path
import sys
import zipfile
root = Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], "x", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise SystemExit(f"unexpected upstream data symlink: {path}")
        if path.is_file():
            info = zipfile.ZipInfo("gles2/" + path.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
PY
# WHY: the executables need fork preparation, but this declared data output
# is not a program. Keep the per-call policy aligned with its manifest instead
# of letting the executable-wide auto setting reject the archive install.
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary graphics-cts "$work/deqp-data.zip" deqp-data.zip
