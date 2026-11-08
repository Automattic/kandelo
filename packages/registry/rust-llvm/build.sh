#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$here"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
out="${WASM_POSIX_DEP_OUT_DIR:?resolve rust-llvm through the package resolver}"
libcxx="${WASM_POSIX_DEP_LIBCXX_DIR:?missing declared libcxx dependency}"
source "$repo/sdk/activate.sh"
src="$work/llvm-source"
kandelo_package_stage_primary_source rust-llvm "$src" "$work"
for patch_file in "$here"/patches/*.patch; do
  patch --fuzz=0 -p1 -d "$src" < "$patch_file"
done
export WASM_POSIX_DEP_WORK_DIR="$work" WASM_POSIX_DEP_LIBCXX_DIR="$libcxx"
export WASM_POSIX_SYSROOT
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot rust-llvm "$repo/sysroot" libcxx)"

# TableGen runs on the build machine. No native executable enters the package.
common=(
  -DCMAKE_BUILD_TYPE=MinSizeRel -DLLVM_TARGETS_TO_BUILD=WebAssembly
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF
  -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_UTILS=OFF
  -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF
  -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_TERMINFO=OFF
  -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_ASSERTIONS=OFF
  -DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF
  -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_BUILD_LLVM_DYLIB=OFF
  -DLLVM_LINK_LLVM_DYLIB=OFF -DBUILD_SHARED_LIBS=OFF
)
cmake -G Ninja -S "$src/llvm" -B "$work/native" "${common[@]}"
cmake --build "$work/native" --target llvm-tblgen llvm-config -j 3
flags="-O1 -g0 -fno-exceptions -fno-rtti -include endian.h -ffile-prefix-map=$repo=/kandelo/source -ffile-prefix-map=$work=/kandelo/build/rust-llvm"
cmake -G Ninja -S "$src/llvm" -B "$work/wasm32" "${common[@]}" \
  -DCMAKE_SYSTEM_NAME=Kandelo -DCMAKE_MODULE_PATH="$repo/sdk/cmake" \
  -DCMAKE_SYSTEM_PROCESSOR=wasm32 -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DCMAKE_C_COMPILER="$(command -v wasm32posix-cc)" \
  -DCMAKE_CXX_COMPILER="$(command -v wasm32posix-c++)" \
  -DCMAKE_AR="$(command -v wasm32posix-ar)" \
  -DCMAKE_RANLIB="$(command -v wasm32posix-ranlib)" \
  -DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags" \
  -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
  -DLLVM_TABLEGEN="$work/native/bin/llvm-tblgen" \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-unknown -DLLVM_ENABLE_THREADS=ON
cmake --build "$work/wasm32" --target llvm-libraries -j "${KANDELO_RUST_LLVM_BUILD_JOBS:-3}"
mkdir -p "$out/lib" "$out/include" "$out/share/kandelo"
# An ordinary archive containing every object preserves compiler facts and
# allows Rust to link LLVM statically without loading a backend plugin.
python3 - "$work/wasm32/lib" "$work/merge.mri" "$out/lib/libLLVM.a" <<'PY'
from pathlib import Path
import sys
libs = sorted(Path(sys.argv[1]).glob('libLLVM*.a'))
if not libs:
    raise SystemExit('LLVM build produced no static libraries')
Path(sys.argv[2]).write_text('create ' + sys.argv[3] + '\n' + ''.join('addlib ' + str(p) + '\n' for p in libs) + 'save\nend\n')
PY
llvm-ar -M < "$work/merge.mri"
cp -R "$src/llvm/include/llvm" "$src/llvm/include/llvm-c" "$out/include/"
cp -R "$work/wasm32/include/llvm"/. "$out/include/llvm/"
if [ -d "$work/wasm32/include/llvm-c" ]; then
  cp -R "$work/wasm32/include/llvm-c"/. "$out/include/llvm-c/"
fi
python3 - "$work/native/bin/llvm-config" "$out/share/kandelo/llvm-config.json" <<'PY'
import json, subprocess, sys
# Only portable configuration facts enter the artifact, never host paths,
# host binaries, or build-directory compiler flags.
config = {key: subprocess.check_output([sys.argv[1], '--' + key], text=True).strip()
          for key in ('version', 'components')}
with open(sys.argv[2], 'w') as f:
    json.dump(config, f, sort_keys=True)
    f.write('\n')
PY
