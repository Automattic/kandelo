#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
source "$root/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
out="$KANDELO_PACKAGE_OUT_DIR"
: "${WASM_POSIX_DEP_KANDELO_FFI_ADAPTER_DIR:?declare typed adapter dependency}"
source "$root/sdk/activate.sh"
node="$work/node-source"
kandelo_package_stage_source_dependency node-core-source "$node" "$work"
ffi="$node/deps/libffi"
for patch_file in "$here"/patches/*.patch; do
  patch --batch -F0 -p1 -d "$ffi" < "$patch_file"
done
mkdir -p "$ffi/src/kandelo" "$work/include" "$work/objects"
cp "$here/src/ffitarget.h" "$ffi/src/kandelo/ffitarget.h"
python3 "$ffi/generate-headers.py" --output-dir "$work/include" --os kandelo --target-arch wasm32
objects=()
for unit in types prep_cif raw_api java_raw_api debug; do
  object="$work/objects/$unit.o"
  wasm32posix-cc -O2 -fPIC -I "$work/include" -I "$ffi/include" -c "$ffi/src/$unit.c" -o "$object"
  objects+=("$object")
done
wasm32posix-cc -O2 -fPIC -I "$work/include" -I "$ffi/include" \
  -I "$WASM_POSIX_DEP_KANDELO_FFI_ADAPTER_DIR/include" -c "$here/src/ffi.c" -o "$work/objects/kandelo.o"
objects+=("$work/objects/kandelo.o")
mkdir -p "$out/include" "$out/lib/pkgconfig" "$out/share/licenses/node-libffi"
llvm-ar crs "$out/lib/libffi.a" "${objects[@]}"
install -m644 "$work/include/ffi.h" "$work/include/ffitarget.h" \
  "$here/src/ffi-kandelo-private.h" "$out/include/"
install -m644 "$ffi/LICENSE" "$out/share/licenses/node-libffi/LICENSE.libffi"
cat > "$out/lib/pkgconfig/libffi.pc" <<PC
prefix=\${pcfiledir}/../..
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: libffi
Description: Pinned upstream libffi portable core with the Kandelo Node scalar target
Version: 3.8.0
Requires.private: kandelo-ffi-adapter = 0.1.0
Libs: -L\${libdir} -lffi
Libs.private: -ldl -pthread
Cflags: -I\${includedir}
PC
# Static consumers resolve the declared adapter through Requires.private;
# no undeclared absolute cache paths are written into relocatable metadata.
