#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
source "$repo_root/scripts/package-build-roots.sh"
source "$repo_root/sdk/activate.sh"
arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
kandelo_package_prepare_build_roots "$script_dir" "$arch"
kandelo_package_select_source_root "$repo_root"
source_root="$KANDELO_PACKAGE_SOURCE_ROOT"
python3 "$source_root/tests/graphics/verify-cts-source.py"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?declare libcxx dependency}"
if [ "$arch" != wasm32 ]; then
    echo "graphics-cts-egl requires the supported wasm32 graphics SDK" >&2
    exit 2
fi
base_sysroot="$repo_root/sysroot"
export WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot graphics-cts-egl "$base_sysroot" libcxx)"
"${arch}posix-c++" -std=c++17 -O2 \
    "$source_root/tests/graphics/cts/egl-adapter.cpp" \
    -lgbm -lEGL -lGLESv2 -lc++ -lc++abi -o "$KANDELO_PACKAGE_WORK_DIR/graphics-cts-egl.wasm"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$repo_root/scripts/install-local-binary.sh"
install_local_binary graphics-cts-egl "$KANDELO_PACKAGE_WORK_DIR/graphics-cts-egl.wasm" graphics-cts-egl.wasm
