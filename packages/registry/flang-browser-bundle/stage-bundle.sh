#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 7 ]; then
    echo "usage: stage-bundle.sh <flang.wasm> <runtime.a> <complex-builtins.a> <module-dir> <license> <flang.1> <output.zip>" >&2
    exit 2
fi

repo="$(cd "$(dirname "$0")/../../.." && pwd -P)"
flang="$1"
archive="$2"
builtins="$3"
modules="$4"
license="$5"
man_page="$6"
output="$7"
stage="$(mktemp -d "$(dirname "$output")/flang-stage.XXXXXX")"
runtime_dir="$stage/lib/kandelo/fortran"
mkdir -p "$stage/bin" "$runtime_dir/mod" "$stage/share/licenses/flang" "$stage/share/man/man1"
cp "$license" "$stage/share/licenses/flang/LICENSE.TXT"
cp "$man_page" "$stage/share/man/man1/flang.1"
cp "$modules"/*.mod "$runtime_dir/mod/"
cp "$archive" "$runtime_dir/libflang_rt.runtime.a"
cp "$builtins" "$runtime_dir/libflang-complex-builtins.a"

source "$repo/scripts/wasm-artifact-guards.sh"
if wasm_imports_kernel_fork "$flang"; then
    BINARYEN_CORES=1 "$repo/scripts/run-wasm-fork-instrument.sh" "$flang" -o "$stage/bin/flang"
else
    # The linker emits template-heavy function names. Keep the ABI metadata
    # and code while discarding these diagnostics and the build-only facts.
    llvm-objcopy --remove-section=name --remove-section=kandelo.calltypes \
        --remove-section=kandelo.calltypes.code-sha256 "$flang" "$stage/bin/flang"
fi
wasm_require_fork_instrumentation_if_needed "$stage/bin/flang"
wasm_drop_compiler_facts "$stage/bin/flang"
chmod 0755 "$stage/bin/flang"

bash "$repo/images/vfs/scripts/create-deterministic-zip.sh" "$stage" "$output"
