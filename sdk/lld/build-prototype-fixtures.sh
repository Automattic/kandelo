#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root in scripts/dev-shell.sh.
arch="${1:-wasm32posix}"
case "$arch" in
    wasm32posix) out="$PWD/.scratch" ;;
    wasm64posix) out="$PWD/.scratch/dynsym-wasm64" ;;
    *) echo "usage: $0 [wasm32posix|wasm64posix]" >&2; exit 2 ;;
esac
cc="sdk/bin/$arch-cc"
mkdir -p "$out/dynsym-needed"
if [[ -n "${KANDELO_PROTOTYPE_WASM_LD:-}" ]]; then
    tool_dir="$PWD/.scratch/dynsym-sdk-bin"
    mkdir -p "$tool_dir"
    for name in clang clang++ llvm-ar llvm-ranlib llvm-nm; do
        ln -sfn "$LLVM_BIN/$name" "$tool_dir/$name"
    done
    ln -sfn "$KANDELO_PROTOTYPE_WASM_LD" "$tool_dir/wasm-ld"
    export WASM_POSIX_LLVM_DIR="$tool_dir"
fi
"$cc" -O2 -rdynamic -DPROCESS_DYNSYM_LOOKUP_ONLY host/test/fixtures/process-dynsym.c -o "$out/process-dynsym.linked.wasm"
"$cc" -O2 -fPIC -shared -Ilibc/glue host/test/fixtures/process-dynsym-side.c -o "$out/process-dynsym-side.linked.so"
"$cc" -O2 -rdynamic host/test/fixtures/process-dynsym.c -o "$out/process-dynsym-mapped.linked.wasm"
"$cc" -O2 -fPIC -shared -Ilibc/glue \
    host/test/fixtures/process-dynsym-dependency.c -o "$out/dynsym-needed/dynsym-dependency.so"
"$cc" -O2 -fPIC -shared -Ilibc/glue \
    -DPROCESS_DYNSYM_NEEDED host/test/fixtures/process-dynsym-side.c \
    "$out/dynsym-needed/dynsym-dependency.so" -o "$out/dynsym-needed-consumer.linked.so"
"$cc" -O2 -fPIC -shared -Ilibc/glue \
    host/test/fixtures/process-dynsym-lifecycle-side.c "$out/dynsym-needed/dynsym-dependency.so" \
    -o "$out/dynsym-lifecycle.linked.so"
"$cc" -O2 -rdynamic \
    host/test/fixtures/process-dynsym-lifecycle.c \
    -o "$out/process-dynsym-lifecycle.linked.wasm"
instrument=scripts/run-wasm-fork-instrument.sh
bash "$instrument" "$out/dynsym-needed/dynsym-dependency.so" -o "$out/dynsym-dependency.so"
bash "$instrument" "$out/dynsym-needed-consumer.linked.so" --entry env.fork -o "$out/dynsym-needed-consumer.so"
bash "$instrument" "$out/process-dynsym.linked.wasm" -o "$out/process-dynsym.wasm"
bash "$instrument" "$out/process-dynsym-side.linked.so" --entry env.fork -o "$out/process-dynsym-side.so"
bash "$instrument" "$out/process-dynsym-mapped.linked.wasm" --side-modules=assume-all-entries-fork-returning -o "$out/process-dynsym-mapped.wasm"
bash "$instrument" "$out/dynsym-lifecycle.linked.so" -o "$out/dynsym-lifecycle.so"
bash "$instrument" "$out/process-dynsym-lifecycle.linked.wasm" --side-modules=assume-all-entries-fork-returning \
    -o "$out/process-dynsym-lifecycle.wasm"
