#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
go_bin="${GO_KANDELO_BIN:-$repo_root/../go-kandelo/bin/go}"
cd "$repo_root"
mkdir -p .context/go-retirement
for mode in pure cgo; do
  if [[ "$mode" = cgo ]]; then cgo=1; else cgo=0; fi
  GO111MODULE=off GOOS=kandelo GOARCH=wasm32 CGO_ENABLED="$cgo" CC=wasm32posix-cc \
    "$go_bin" build -o ".context/go-retirement/$mode-raw.wasm" ./tests/go/retirement
  if [[ "$mode" = cgo ]]; then
    scripts/run-wasm-fork-instrument.sh ".context/go-retirement/$mode-raw.wasm" -o ".context/go-retirement/$mode.wasm"
  else
    cp ".context/go-retirement/$mode-raw.wasm" ".context/go-retirement/$mode.wasm"
  fi
done
REPO_ROOT="$repo_root"
source scripts/build-programs-abi-stamp.sh
record_built_program_output .context/go-retirement/pure.wasm
record_built_program_output .context/go-retirement/cgo.wasm
stamp_built_program_outputs
