#!/usr/bin/env bash
# Run from the declared dev shell. Compilers are inputs, not auto-downloaded tools.
set -euo pipefail
if [[ "$#" != 3 ]]; then
    echo "usage: build.sh <baseline-go> <candidate-go> <output-dir>" >&2
    exit 2
fi
baseline_go="$(realpath "$1")"
candidate_go="$(realpath "$2")"
mkdir -p "$3"
output_dir="$(realpath "$3")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GOENV=off GOTOOLCHAIN=local GO111MODULE=off CGO_ENABLED=0
export GOMAXPROCS=4 GOFLAGS=-p=4
for variant in baseline candidate; do
    if [[ "$variant" == baseline ]]; then
        go_bin="$baseline_go"
    else
        go_bin="$candidate_go"
    fi
    export GOROOT="$(dirname "$(dirname "$go_bin")")"
    export GOCACHE="$output_dir/cache-$variant"
    "$go_bin" version > "$output_dir/compiler-$variant.txt"
    git -C "$GOROOT" rev-parse HEAD >> "$output_dir/compiler-$variant.txt"
    git -C "$GOROOT" status --short >> "$output_dir/compiler-$variant.txt"
    GOOS="$("$go_bin" env GOHOSTOS)" GOARCH="$("$go_bin" env GOHOSTARCH)" "$go_bin" build -o "$output_dir/bench-$variant-native" "$script_dir/compile.go"
    GOOS=wasip1 GOARCH=wasm32 "$go_bin" build -o "$output_dir/bench-$variant-wasi.wasm" "$script_dir/compile.go"
done
