#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
go_bin="${GO_KANDELO_BIN:-$repo_root/../go-kandelo/bin/go}"
output_dir="$repo_root/.context/go-browser"

if [[ ! -x "$go_bin" ]]; then
  echo "Go fork binary not found: $go_bin" >&2
  exit 1
fi

mkdir -p "$output_dir"

build_probe() {
  local source_dir="$1"
  local output_name="$2"
  local package="${3:-.}"
  (
    cd "$repo_root/tests/go/$source_dir"
    GOOS=kandelo GOARCH=wasm "$go_bin" build -o "$output_dir/$output_name.wasm" "$package"
  )
}

build_probe browser-basic basic
build_probe second-m second-m
build_probe clone-handoff clone-handoff
build_probe scheduler scheduler
build_probe scheduler exit-worker ./exit-worker

printf 'Go browser fixtures built in %s\n' "$output_dir"
