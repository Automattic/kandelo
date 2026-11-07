#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
go_bin="${GO_KANDELO_BIN:-$repo_root/../go-kandelo/bin/go}"
cd "$repo_root"
mkdir -p .context/go-signals
for mode in pure cgo; do
  if [[ "$mode" = cgo ]]; then cgo=1; else cgo=0; fi
  GO111MODULE=off GOOS=kandelo GOARCH=wasm32 CGO_ENABLED="$cgo" CC=wasm32posix-cc \
    "$go_bin" build -o ".context/go-signals/$mode-raw.wasm" ./tests/go/signal-basic
  if [[ "$mode" = cgo ]]; then
    scripts/run-wasm-fork-instrument.sh ".context/go-signals/$mode-raw.wasm" -o ".context/go-signals/$mode.wasm"
  else
    cp ".context/go-signals/$mode-raw.wasm" ".context/go-signals/$mode.wasm"
  fi
  GOOS=kandelo GOARCH=wasm32 CGO_ENABLED="$cgo" CC=wasm32posix-cc \
    "$go_bin" test -c -o ".context/go-signals/$mode-stdlib-raw.wasm" os/signal
  if [[ "$mode" = cgo ]]; then
    scripts/run-wasm-fork-instrument.sh ".context/go-signals/$mode-stdlib-raw.wasm" -o ".context/go-signals/$mode-stdlib.wasm"
  else
    cp ".context/go-signals/$mode-stdlib-raw.wasm" ".context/go-signals/$mode-stdlib.wasm"
  fi
done
REPO_ROOT="$repo_root"
source scripts/build-programs-abi-stamp.sh
record_built_program_output .context/go-signals/pure.wasm
record_built_program_output .context/go-signals/cgo.wasm
record_built_program_output .context/go-signals/pure-stdlib.wasm
record_built_program_output .context/go-signals/cgo-stdlib.wasm
stamp_built_program_outputs
