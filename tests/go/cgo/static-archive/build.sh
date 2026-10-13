#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
source_dir="$repo_root/tests/go/cgo/static-archive"
output_dir="$repo_root/.context/go-static-archive"
fixture_dir="$output_dir/fixture"
mkdir -p "$fixture_dir/lib"
cp "$source_dir/main.go" "$fixture_dir/main.go"

wasm32posix-cc -O2 -fPIC -c "$source_dir/testdata/square.c" -o "$output_dir/square.o"
wasm32posix-cc -O2 -fPIC -c "$source_dir/testdata/bias.c" -o "$output_dir/bias.o"
wasm32posix-ar rcs "$fixture_dir/lib/libsquare.a" "$output_dir/square.o" "$output_dir/bias.o"

GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc \
    "$repo_root/../go-kandelo/bin/go" build -a -o "$output_dir/probe.wasm" "$fixture_dir/main.go"
wasm-validate --enable-threads "$output_dir/probe.wasm"
"$repo_root/scripts/run-wasm-fork-instrument.sh" "$output_dir/probe.wasm" \
    -o "$output_dir/probe-instrumented.wasm"
REPO_ROOT="$repo_root" bash -c '
    source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
    record_built_program_output "$REPO_ROOT/.context/go-static-archive/probe-instrumented.wasm"
    stamp_built_program_outputs
'
