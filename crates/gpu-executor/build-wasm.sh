#!/usr/bin/env bash
# Builds the kgpu executor module the kernel-spawned GPU worker instantiates
# (crates/gpu-executor). Its memory is private and imported (never shared):
# the executor reads commands only from bytes the worker shell copied into
# it, so no other agent can change them after validation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
HOST="$(rustc -vV | awk '/^host/ {print $2}')"
ARTIFACT="local-binaries/kandelo_gpu_executor32.wasm"
KEY="$(cargo run -q -p xtask --target "$HOST" -- workspace-closure-sha --crates kandelo-gpu-executor,kgpu-stream,wasm-posix-shared --recipe crates/gpu-executor/build-wasm.sh)"
if [ "${1:-}" = --verify-fresh ]; then
    test -f "$ARTIFACT" && test -f "$ARTIFACT.build-key" && test "$(cat "$ARTIFACT.build-key")" = "$KEY"
    exit
fi
test "$#" = 0
# 2 MiB initial, 256 MiB maximum: room for a maximal record and stream plus
# per-context state, while bounding what one worker can reserve.
export RUSTFLAGS="-C target-feature=+bulk-memory -Zunstable-options -C panic=immediate-abort -C opt-level=z -C link-arg=--no-entry -C link-arg=--import-memory -C link-arg=--export-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=268435456"
for name in ge_version ge_alloc ge_free ge_handle; do
    RUSTFLAGS="$RUSTFLAGS -C link-arg=--export=$name"
done
cargo build --release -p kandelo-gpu-executor --bin kandelo-gpu-executor-module \
    --features standalone --target wasm32-unknown-unknown -Z build-std=core,alloc
SOURCE="target/wasm32-unknown-unknown/release/kandelo-gpu-executor-module.wasm"
# [RUNTIME-WORKAROUND: BINARYEN-133-CONSTRAINT-ANALYSIS] -Oz schedules
# Binaryen 133's constraint-analysis pass, which aborts on some LLVM 23 code
# and measured no worthwhile win; Kandelo skips it everywhere until a
# re-measured decision (docs/future-improvements.md) says otherwise.
wasm-opt -Oz --skip-pass=constraint-analysis --enable-bulk-memory "$SOURCE" -o "$SOURCE.opt"
node --input-type=module - "$SOURCE.opt" <<'JS'
import { readFileSync } from "node:fs";
const module = new WebAssembly.Module(readFileSync(process.argv[2]));
// The executor may reach the platform only through its declared backend.
const backend = {
  create_context: "function", destroy_context: "function", create_surface: "function",
  destroy_surface: "function", bind_surface: "function", viewport: "function",
  clear_color: "function", clear: "function", read_pixels: "function", is_lost: "function",
};
const imports = WebAssembly.Module.imports(module);
const seen = new Set();
for (const { module: from, name, kind } of imports) {
  const ok = (from === "env" && name === "memory" && kind === "memory")
    || (from === "kgpu_backend" && backend[name] === kind);
  if (!ok) throw new Error(`Executor module imports ${from}.${name} (${kind}), outside its backend`);
  seen.add(`${from}.${name}`);
}
for (const name of ["env.memory", ...Object.keys(backend).map((n) => `kgpu_backend.${n}`)]) {
  if (!seen.has(name)) throw new Error(`Executor module does not import ${name}`);
}
// wasm-ld always exports the two layout globals; nothing else may appear.
const exportNames = WebAssembly.Module.exports(module).map((e) => e.name)
  .filter((n) => n !== "__data_end" && n !== "__heap_base").sort();
const expected = ["ge_alloc", "ge_free", "ge_handle", "ge_version", "memory"];
if (JSON.stringify(exportNames) !== JSON.stringify(expected)) {
  throw new Error(`Executor module exports ${exportNames.join(",")}, expected ${expected.join(",")}`);
}
// Smoke the crossing with a backend that has no renderer: a context create
// must come back ContextLost (2) with -ENODEV, per the null-renderer rule.
const memory = new WebAssembly.Memory({ initial: 32, maximum: 4096 });
const stub = Object.fromEntries(Object.keys(backend).map((n) => [n, () => 0]));
stub.create_context = () => -19;
const instance = new WebAssembly.Instance(module, { env: { memory }, kgpu_backend: stub });
const e = instance.exports;
if (e.ge_version() !== 1) throw new Error("Unexpected executor protocol version");
if (e.memory.buffer instanceof SharedArrayBuffer) throw new Error("Executor memory must be private");
const record = e.ge_alloc(24);
const out = e.ge_alloc(24);
if (record === 0 || out === 0) throw new Error("ge_alloc failed");
const view = new DataView(e.memory.buffer);
for (let i = 0; i < 24; i += 4) view.setUint32(record + i, 0, true);
view.setUint32(record, 2, true); // ContextCreate
view.setUint32(record + 4, 7, true);
if (e.ge_handle(record, 24, 0, 0, out) !== 24) throw new Error("ge_handle refused a valid record");
const done = new DataView(e.memory.buffer, out, 24);
if (done.getUint32(0, true) !== 2 || done.getUint32(4, true) !== 7 || done.getInt32(16, true) !== -19) {
  throw new Error("A renderer-less context create did not answer ContextLost/-ENODEV");
}
if (e.ge_handle(record, 24, 0, 0, 16) !== -14) throw new Error("ge_handle accepted an unallocated output");
e.ge_free(record, 24);
e.ge_free(out, 24);
JS
mkdir -p local-binaries
cp "$SOURCE.opt" "$ARTIFACT"
printf '%s\n' "$KEY" > "$ARTIFACT.build-key"
