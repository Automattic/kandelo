#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$here"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
llvm="${WASM_POSIX_DEP_RUST_LLVM_DIR:?missing declared Rust LLVM dependency}"
zlib="${WASM_POSIX_DEP_ZLIB_DIR:?missing declared profile compression dependency}"
source "$repo/sdk/activate.sh"
export WASM_POSIX_SYSROOT
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot rust-coverage-tools "$repo/sysroot" libcxx)"
src="$work/llvm-source"
kandelo_package_stage_primary_source rust-coverage-tools "$src" "$work"

# rust-llvm supplies the exact generated configuration and merged LLVM
# archive. Build only the upstream tool translation units, without another
# LLVM library build or native configuration facts leaking into the target.
python3 - "$src" "$work/sources.txt" <<'PY'
from pathlib import Path
import re, sys
source = Path(sys.argv[1]) / 'llvm/tools'
rows = []
for tool in ('llvm-cov', 'llvm-profdata'):
    directory = source / tool
    cmake = (directory / 'CMakeLists.txt').read_text()
    files = re.findall(r'^\s*([A-Za-z0-9_-]+\.cpp)\s*$', cmake, re.MULTILINE)
    if not files or len(files) > 32 or len(set(files)) != len(files):
        raise SystemExit(f'unexpected pinned {tool} source list')
    for name in files:
        if not (directory / name).is_file():
            raise SystemExit(f'missing pinned {tool} source: {name}')
        rows.append(f'{tool}/{name}')
Path(sys.argv[2]).write_text('\n'.join(rows) + '\n')
PY
# The compiler's LLVM library does not need zlib, but Rust emits compressed
# profile names. Build LLVM's compression implementation for the reporter
# with its declared zlib dependency. Its public ABI is unchanged; explicit
# object linking supplies these definitions before the static LLVM archive.
# All other LLVM objects and generated configuration remain the dependency's.
mkdir -p "$work/include/llvm/Config"
python3 - "$llvm/include/llvm/Config/llvm-config.h" "$work/include/llvm/Config/llvm-config.h" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
old = '#define LLVM_ENABLE_ZLIB 0'
if source.count(old) != 1:
    raise SystemExit('unexpected Rust LLVM zlib configuration')
Path(sys.argv[2]).write_text(source.replace(old, '#define LLVM_ENABLE_ZLIB 1'))
PY
flags=(
  -std=c++17 -O2 -g0 -fno-exceptions -fno-rtti -include endian.h
  -I"$work/include" -I"$llvm/include" -I"$zlib/include"
  "-ffile-prefix-map=$repo=/kandelo/source"
  "-ffile-prefix-map=$work=/kandelo/build/rust-coverage-tools"
)
mkdir -p "$work/objects/llvm-cov" "$work/objects/llvm-profdata"
wasm32posix-c++ "${flags[@]}" -c "$src/llvm/lib/Support/Compression.cpp" -o "$work/objects/Compression.o"
while IFS= read -r file; do
  wasm32posix-c++ "${flags[@]}" -c "$src/llvm/tools/$file" -o "$work/objects/$file.o"
done < "$work/sources.txt"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
export BINARYEN_CORES=1
source "$repo/scripts/install-local-binary.sh"
for tool in llvm-cov llvm-profdata; do
  wasm32posix-c++ "${flags[@]}" "$work/objects/$tool/"*.o \
    "$work/objects/Compression.o" "$llvm/lib/libLLVM.a" "$zlib/lib/libz.a" -o "$work/$tool.wasm"
  install_local_binary rust-coverage-tools "$work/$tool.wasm" "$tool.wasm"
done
