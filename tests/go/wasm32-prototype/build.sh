#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${GO_KANDELO_BIN:?Set GO_KANDELO_BIN to the isolated wasm32 prototype compiler}"
export GOROOT="$(cd "$(dirname "$GO_KANDELO_BIN")/.." && pwd)"
output="$repo_root/.context/go-wasm32-prototype"
mkdir -p "$repo_root/.context"
stage="$(mktemp -d "$repo_root/.context/go-wasm32-build-XXXXXX")"
trap 'rm -rf "$stage"' EXIT
export GOENV=off GOTOOLCHAIN=local GO111MODULE=off GOOS=kandelo GOARCH=wasm32 CGO_ENABLED=0
"$GO_KANDELO_BIN" build -o "$stage/runtime.wasm" "$repo_root/tests/go/wasm32-prototype/main.go"
"$GO_KANDELO_BIN" build -o "$stage/basic.wasm" "$repo_root/tests/go/browser-basic/main.go"
REPO_ROOT="$repo_root"
source "$repo_root/scripts/build-programs-abi-stamp.sh"
record_built_program_output "$stage/runtime.wasm"
record_built_program_output "$stage/basic.wasm"
if [[ "${KANDELO_GO_WASM32_CGO_TESTS:-0}" == 1 ]]; then
  build_cgo() {
    local directory="$1" name="$2"
    (
      cd "$directory"
      CGO_ENABLED=1 CC=wasm32posix-cc "$GO_KANDELO_BIN" build -o "$stage/$name-raw.wasm" .
    )
    "$repo_root/scripts/run-wasm-fork-instrument.sh" "$stage/$name-raw.wasm" -o "$stage/$name.wasm"
    rm "$stage/$name-raw.wasm"
    record_built_program_output "$stage/$name.wasm"
  }
  build_cgo "$repo_root/tests/go/cgo" cgo-basic
  build_cgo "$repo_root/tests/go/wasm32-prototype/cgo" cgo-typed
  build_cgo "$repo_root/tests/go/cgo/callback-same" cgo-callback-same
  build_cgo "$repo_root/tests/go/cgo/callback" cgo-callback-pthread
fi
stamp_built_program_outputs

mkdir -p "$output"
mv "$stage/"*.wasm "$output/"
node --input-type=module - "$GOROOT" "$output" <<'JS'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const [root, output] = process.argv.slice(2);
const names = ["runtime.wasm", "basic.wasm", ...(process.env.KANDELO_GO_WASM32_CGO_TESTS === "1"
  ? ["cgo-basic.wasm", "cgo-typed.wasm", "cgo-callback-same.wasm", "cgo-callback-pthread.wasm"] : [])];
const manifest = {
  target: "kandelo/wasm32",
  compilerVersion: execFileSync(join(root, "bin/go"), ["version"], { encoding: "utf8" }).trim(),
  sourceCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceDirty: execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
  sha256: Object.fromEntries(names.map(name => [name, createHash("sha256").update(readFileSync(join(output, name))).digest("hex")])),
};
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
JS
