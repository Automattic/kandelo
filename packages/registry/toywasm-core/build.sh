#!/usr/bin/env bash
set -euo pipefail

recipe=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$recipe/../../.." && pwd)
source "$root/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$recipe"
source "$root/sdk/activate.sh"

test "${WASM_POSIX_DEP_NAME:?build through the package resolver}" = toywasm-core
test "${WASM_POSIX_DEP_TARGET_ARCH:?}" = wasm32
work=$(kandelo_package_make_work_dir toywasm-core)
out=${WASM_POSIX_DEP_OUT_DIR:?}
src="$work/source"
build="$work/build"
kandelo_package_stage_primary_source toywasm-core "$src" "$work"

# The source archive has no Git metadata. Prevent upstream's version probe
# from seeing a surrounding checkout if the resolver is using a local cache.
export GIT_CEILING_DIRECTORIES="$work"
cmake -S "$src" -B "$build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_SYSTEM_NAME=Kandelo \
    -DCMAKE_MODULE_PATH="$root/sdk/cmake" -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER="$(command -v wasm32posix-cc)" \
    -DCMAKE_AR="$(command -v wasm32posix-ar)" \
    -DCMAKE_RANLIB="$(command -v wasm32posix-ranlib)" \
    -DTOYWASM_ENABLE_WASM_THREADS=ON -DTOYWASM_USE_USER_SCHED=OFF \
    -DTOYWASM_ENABLE_WASI=OFF -DTOYWASM_USE_TAILCALL=OFF \
    -DTOYWASM_SORT_EXPORTS=OFF -DTOYWASM_BUILD_UNITTEST=OFF -DBUILD_TESTING=OFF
cmake --build "$build" --target toywasm-lib-core --parallel "${WASM_POSIX_BUILD_JOBS:-2}"
cmake --install "$build/lib" --prefix "$out"

install -d "$out/lib/pkgconfig" "$out/share/licenses/toywasm-core"
install -m644 "$src/LICENSE" "$out/share/licenses/toywasm-core/LICENSE"
cat > "$out/lib/pkgconfig/toywasm-core.pc" <<PCEOF
prefix=\${pcfiledir}/../..
libdir=\${prefix}/lib
includedir=\${prefix}/include/toywasm

Name: toywasm-core
Description: Portable WebAssembly interpreter core
Version: $WASM_POSIX_DEP_VERSION
Libs: -L\${libdir} -ltoywasm-core -pthread
Cflags: -I\${includedir} -pthread -fshort-enums
PCEOF
