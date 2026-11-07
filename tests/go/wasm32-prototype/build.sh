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
stamp_built_program_outputs

mkdir -p "$output"
mv "$stage/runtime.wasm" "$stage/basic.wasm" "$output/"
