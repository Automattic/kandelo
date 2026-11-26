#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root in scripts/dev-shell.sh after building wasm-ld.
tool_dir="$PWD/.scratch/dynsym-bin"
mkdir -p "$tool_dir" "$PWD/.scratch/dynsym-needed"
linker="${KANDELO_PROTOTYPE_WASM_LD:-$PWD/.scratch/llvm-dynsym/build/bin/wasm-ld}"
if [[ ! -x "$linker" || -z "${LLVM_BIN:-}" ]]; then
    echo "Build the prototype wasm-ld and run this script in the Kandelo dev shell." >&2
    exit 1
fi
for name in clang clang++ llvm-ar llvm-ranlib llvm-nm; do
    ln -sfn "$LLVM_BIN/$name" "$tool_dir/$name"
done
ln -sfn "$linker" "$tool_dir/wasm-ld"
export WASM_POSIX_LLVM_DIR="$tool_dir"
sdk/bin/wasm32posix-cc -O2 -rdynamic host/test/fixtures/process-dynsym.c libc/glue/dynsym.c -o .scratch/process-dynsym.linked.wasm
sdk/bin/wasm32posix-cc -O2 -fPIC -shared -Wl,--kandelo-side-dynsym -Ilibc/glue host/test/fixtures/process-dynsym-side.c -o .scratch/process-dynsym-side.linked.so
sdk/bin/wasm32posix-cc -O2 -rdynamic -DKANDELO_DYNSYM_MAP -Wl,--export=fork host/test/fixtures/process-dynsym.c libc/glue/dynsym.c -o .scratch/process-dynsym-mapped.linked.wasm
sdk/bin/wasm32posix-cc -O2 -fPIC -shared -Wl,--kandelo-side-dynsym -Ilibc/glue \
    host/test/fixtures/process-dynsym-dependency.c -o .scratch/dynsym-needed/dynsym-dependency.so
sdk/bin/wasm32posix-cc -O2 -fPIC -shared -Wl,--kandelo-side-dynsym -Ilibc/glue \
    -DPROCESS_DYNSYM_NEEDED host/test/fixtures/process-dynsym-side.c \
    .scratch/dynsym-needed/dynsym-dependency.so -o .scratch/dynsym-needed-consumer.linked.so
sdk/bin/wasm32posix-cc -O2 -fPIC -shared -Wl,--kandelo-side-dynsym -Ilibc/glue \
    host/test/fixtures/process-dynsym-lifecycle-side.c .scratch/dynsym-needed/dynsym-dependency.so \
    -o .scratch/dynsym-lifecycle.linked.so
sdk/bin/wasm32posix-cc -O2 -rdynamic -DKANDELO_DYNSYM_MAP -Wl,--export=fork \
    host/test/fixtures/process-dynsym-lifecycle.c libc/glue/dynsym.c \
    -o .scratch/process-dynsym-lifecycle.linked.wasm
instrument=scripts/run-wasm-fork-instrument.sh
bash "$instrument" .scratch/dynsym-needed/dynsym-dependency.so -o .scratch/dynsym-dependency.so
bash "$instrument" .scratch/dynsym-needed-consumer.linked.so --entry env.fork -o .scratch/dynsym-needed-consumer.so
bash "$instrument" .scratch/process-dynsym.linked.wasm -o .scratch/process-dynsym.wasm
bash "$instrument" .scratch/process-dynsym-side.linked.so --entry env.fork -o .scratch/process-dynsym-side.so
bash "$instrument" .scratch/process-dynsym-mapped.linked.wasm --side-modules=assume-all-entries-fork-returning -o .scratch/process-dynsym-mapped.wasm
bash "$instrument" .scratch/dynsym-lifecycle.linked.so -o .scratch/dynsym-lifecycle.so
bash "$instrument" .scratch/process-dynsym-lifecycle.linked.wasm --side-modules=assume-all-entries-fork-returning \
    -o .scratch/process-dynsym-lifecycle.wasm
