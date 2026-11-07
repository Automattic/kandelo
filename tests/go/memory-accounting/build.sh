#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
go_bin="${GO_KANDELO_BIN:-$repo_root/../go-kandelo/bin/go}"
output_dir="$repo_root/.context/go-memory-accounting"
mkdir -p "$output_dir"
(
  cd "$repo_root/tests/go/memory-accounting"
  GO111MODULE=off GOOS=kandelo GOARCH=wasm32 CGO_ENABLED=1 CC=wasm32posix-cc \
    "$go_bin" build -o "$output_dir/raw.wasm" .
)
"$repo_root/scripts/run-wasm-fork-instrument.sh" "$output_dir/raw.wasm" -o "$output_dir/probe.wasm"
REPO_ROOT="$repo_root"
source "$repo_root/scripts/build-programs-abi-stamp.sh"
record_built_program_output "$output_dir/probe.wasm"
stamp_built_program_outputs
