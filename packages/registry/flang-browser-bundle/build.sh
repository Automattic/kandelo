#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$script_dir/../../.." && pwd -P)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$script_dir"
kandelo_package_prepare_build_roots "$script_dir" wasm32
source "$repo/sdk/activate.sh"

work="$KANDELO_PACKAGE_WORK_DIR"
source_dir="$work/llvm-project"
host_build="$work/host"
guest_build="$work/guest"
runtime_build="$work/runtime"
jobs="${KANDELO_FLANG_BUILD_JOBS:-4}"
target=wasm32-unknown-unknown

export WASM_POSIX_DEP_WORK_DIR="$work" WASM_POSIX_GLUE_DIR="$repo/libc/glue"
export WASM_POSIX_SYSROOT
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot flang "${WASM_POSIX_SYSROOT:-$repo/sysroot}" libcxx)"
kandelo_package_stage_primary_source flang-browser-bundle "$source_dir" "$work"
for patch_file in "$script_dir"/patches/*.patch; do
    patch -p1 -d "$source_dir" < "$patch_file"
done

# The native build supplies generators and compiles the target intrinsic modules.
llvm_flags=(
    -DLLVM_ENABLE_PROJECTS=flang -DLLVM_TARGETS_TO_BUILD=WebAssembly
    -DLLVM_APPEND_VC_REV=OFF
    -DLLVM_INCLUDE_TESTS=OFF -DCLANG_INCLUDE_TESTS=OFF -DMLIR_INCLUDE_TESTS=OFF
    -DFLANG_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF
    -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF
    -DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF
    -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_PLUGIN_SUPPORT=OFF -DFLANG_PLUGIN_SUPPORT=OFF
)
cmake -G Ninja -S "$source_dir/llvm" -B "$host_build" "${llvm_flags[@]}" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=cc -DCMAKE_CXX_COMPILER=c++ \
    -DCMAKE_C_FLAGS_RELEASE="-O1 -DNDEBUG" -DCMAKE_CXX_FLAGS_RELEASE="-O1 -DNDEBUG"
cmake --build "$host_build" --parallel "$jobs" \
    --target flang llvm-tblgen clang-tblgen mlir-tblgen mlir-src-sharder mlir-linalg-ods-yaml-gen

# Native Flang must give any Fortran runtime objects the same target features
# as the Kandelo C/C++ toolchain and the in-guest driver.
fortran_flags="-Xflang -target-feature -Xflang +atomics -Xflang -target-feature -Xflang +bulk-memory"
fortran_flags+=" -Xflang -target-feature -Xflang +mutable-globals -Xflang -target-feature -Xflang +sign-ext"
cmake -G Ninja -S "$source_dir/runtimes" -B "$runtime_build" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE="$repo/sdk/cmake/kandelo-toolchain.cmake" \
    -DLLVM_DEFAULT_TARGET_TRIPLE="$target" -DLLVM_ENABLE_RUNTIMES=flang-rt -DLLVM_INCLUDE_TESTS=OFF \
    -DCMAKE_Fortran_COMPILER="$host_build/bin/flang" -DCMAKE_Fortran_COMPILER_TARGET="$target" \
    -DCMAKE_Fortran_FLAGS="$fortran_flags" \
    -DRUNTIMES_FORTRAN_MODULES=ON -DFLANG_RT_ENABLE_SHARED=OFF -DFLANG_RT_INCLUDE_TESTS=OFF
cmake --build "$runtime_build" --parallel "$jobs" --target flang-rt flang-rt-mod

# LLVM's Unix headers use the BSD name for the endian header on this target.
mkdir -p "$work/compat/machine"
printf '#include <endian.h>\n' > "$work/compat/machine/endian.h"
flags="-O1 -DNDEBUG -g0 -fno-exceptions -fno-rtti -isystem \"$work/compat\" \"-ffile-prefix-map=$work=/kandelo-build/flang\" -DCLANG_BUILD_STATIC -DLLVM_BUILD_STATIC"
cmake -G Ninja -S "$source_dir/llvm" -B "$guest_build" "${llvm_flags[@]}" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE="$repo/sdk/cmake/kandelo-toolchain.cmake" \
    -DCMAKE_C_FLAGS_RELEASE="$flags" -DCMAKE_CXX_FLAGS_RELEASE="$flags" \
    -DCMAKE_EXE_LINKER_FLAGS="-Wl,--threads=1" -DCMAKE_DISABLE_PRECOMPILE_HEADERS=ON \
    -DLLVM_DEFAULT_TARGET_TRIPLE="$target" -DLLVM_HOST_TRIPLE="$target" \
    -DLLVM_NATIVE_TOOL_DIR="$host_build/bin" \
    -DLLVM_TABLEGEN="$host_build/bin/llvm-tblgen" -DCLANG_TABLEGEN="$host_build/bin/clang-tblgen" \
    -DMLIR_TABLEGEN="$host_build/bin/mlir-tblgen" \
    -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_ENABLE_BACKTRACES=OFF
cmake --build "$guest_build" --parallel "$jobs" --target flang

module="$(find "$runtime_build" -name iso_c_binding.mod -print -quit)"
archive="$(find "$runtime_build" -name libflang_rt.runtime.a -print -quit)"
: "${module:?Flang intrinsic modules did not build}" "${archive:?Flang runtime did not build}"

# Generate the upstream CommandGuide and its TableGen options as flang(1).
source "$repo/scripts/install-package-man-pages.sh"
release_date="$(kandelo_man_pages_release_date "$WASM_POSIX_DEP_VERSION" 23.1.3=2026-10-06)"
mkdir -p "$work/man-source"
cp "$source_dir/flang/docs/CommandGuide/index.rst" "$work/man-source/"
cat > "$work/man-source/conf.py" <<'PY'
project = "Flang"
man_pages = [("index", "flang", "the Flang Fortran compiler", ["Flang Contributors"], 1)]
PY
"$host_build/bin/clang-tblgen" -gen-opt-docs -I "$source_dir/llvm/include" \
    -I "$source_dir/clang/include/clang/Options" "$source_dir/flang/docs/FlangOptionsMan.td" \
    -o "$work/man-source/FlangCommandLineOptions.rst"
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$release_date")" \
    sphinx-build -q -b man -D version="${WASM_POSIX_DEP_VERSION%%.*}" \
    -D release="$WASM_POSIX_DEP_VERSION" "$work/man-source" "$work/man-output"

bundle="$work/flang.zip"
bash "$script_dir/stage-bundle.sh" "$guest_build/bin/flang.wasm" "$archive" \
    "$guest_build/lib/libflang-complex-builtins.a" "$(dirname "$module")" \
    "$source_dir/LICENSE.TXT" "$work/man-output/flang.1" "$bundle"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$repo/scripts/install-local-binary.sh"
install_local_binary flang-browser-bundle "$bundle" flang.zip
