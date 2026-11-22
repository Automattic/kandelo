#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
HOST="$(rustc -vV | awk '/^host/ {print $2}')"
ARTIFACT="local-binaries/kandelo_memory_instrument32.wasm"
KEY="$(cargo run -q -p xtask --target "$HOST" -- workspace-closure-sha --crates memory-instrument --recipe crates/memory-instrument/build-wasm.sh)"
if [ "${1:-}" = --verify-fresh ]; then
    test -f "$ARTIFACT" && test -f "$ARTIFACT.build-key" && test "$(cat "$ARTIFACT.build-key")" = "$KEY"
    exit
fi
test "$#" = 0
export RUSTFLAGS="-C target-feature=+bulk-memory -Zunstable-options -C panic=immediate-abort -C link-arg=--no-entry -C link-arg=--export-memory"
for name in mi_begin mi_instrument_side_module mi_result; do
    RUSTFLAGS="$RUSTFLAGS -C link-arg=--export=$name"
done
cargo build --profile instrumenter -p memory-instrument --bin kandelo-memory-instrument-module \
    --no-default-features --features standalone --target wasm32-unknown-unknown -Z build-std=std,panic_abort
SOURCE="target/wasm32-unknown-unknown/instrumenter/kandelo-memory-instrument-module.wasm"
wasm-opt -O3 --enable-bulk-memory "$SOURCE" -o "$SOURCE.opt"
node --input-type=module - "$SOURCE.opt" <<'JS'
import { readFileSync } from "node:fs";
const module = new WebAssembly.Module(readFileSync(process.argv[2]));
if (WebAssembly.Module.imports(module).length !== 0) throw new Error("Memory-instrument module must import nothing");
const instance = new WebAssembly.Instance(module);
if (instance.exports.memory.buffer instanceof SharedArrayBuffer) throw new Error("Memory-instrument memory must be private");
JS
mkdir -p local-binaries
cp "$SOURCE.opt" "$ARTIFACT"
printf '%s\n' "$KEY" > "$ARTIFACT.build-key"
