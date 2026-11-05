#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
HOST="$(rustc -vV | awk '/^host/ {print $2}')"
ARTIFACT="local-binaries/kandelo_program_policy32.wasm"
KEY="$(cargo run -q -p xtask --target "$HOST" -- workspace-closure-sha --crates kandelo-program-policy --recipe crates/program-policy/build-wasm.sh)"
if [ "${1:-}" = --verify-fresh ]; then
    test -f "$ARTIFACT" && test -f "$ARTIFACT.build-key" && test "$(cat "$ARTIFACT.build-key")" = "$KEY"
    exit
fi
test "$#" = 0
export RUSTFLAGS="-C target-feature=+bulk-memory -Zunstable-options -C panic=immediate-abort -C opt-level=z -C link-arg=--no-entry -C link-arg=--import-memory -C link-arg=--export-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=134217728"
for name in pp_version pp_begin pp_inspect pp_result pp_allocation_failed; do
    RUSTFLAGS="$RUSTFLAGS -C link-arg=--export=$name"
done
cargo build --release -p kandelo-program-policy --bin kandelo-program-policy-module \
    --features standalone --target wasm32-unknown-unknown -Z build-std=core,alloc
SOURCE="target/wasm32-unknown-unknown/release/kandelo-program-policy-module.wasm"
wasm-opt -Oz --enable-bulk-memory "$SOURCE" -o "$SOURCE.opt"
node --input-type=module - "$SOURCE.opt" <<'JS'
import { readFileSync } from "node:fs";
const module = new WebAssembly.Module(readFileSync(process.argv[2]));
const imports = WebAssembly.Module.imports(module);
if (imports.length !== 1 || imports[0].module !== "env" || imports[0].name !== "memory" || imports[0].kind !== "memory") {
  throw new Error("Policy module may import only its private memory");
}
const instance = new WebAssembly.Instance(module, { env: { memory: new WebAssembly.Memory({ initial: 32, maximum: 2048 }) } });
if (instance.exports.pp_version() !== 1) throw new Error("Unexpected policy module version");
if (instance.exports.memory.buffer instanceof SharedArrayBuffer) throw new Error("Policy memory must be private");
JS
mkdir -p local-binaries
cp "$SOURCE.opt" "$ARTIFACT"
printf '%s\n' "$KEY" > "$ARTIFACT.build-key"
