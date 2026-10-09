#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
go_bin="${GO_KANDELO_BIN:-$repo_root/../go-kandelo/bin/go}"
output_dir="$repo_root/.context/go-c-link-only"
mkdir -p "$output_dir"
cd "$repo_root"

wasm32posix-cc -O2 -fPIC -c "$repo_root/tests/go/cgo/link-only/testdata/functions.c" -o "$output_dir/functions.o"
wasm32posix-cc -O2 -fPIC -c "$repo_root/tests/go/cgo/link-only/testdata/data.c" -o "$output_dir/data.o"

if GO111MODULE=off CGO_ENABLED=0 GOOS=kandelo GOARCH=wasm GOTMPDIR="$output_dir" \
    "$go_bin" build -x -work -o "$output_dir/base.wasm" ./tests/go/cgo/link-only \
    > "$output_dir/build.log" 2>&1; then
  echo "expected the unlinked C function to be unresolved" >&2
  exit 1
fi
if ! rg -q 'relocation target c_target not defined' "$output_dir/build.log"; then
  tail -30 "$output_dir/build.log" >&2
  exit 1
fi

work_dir="$(sed -n 's/^WORK=//p' "$output_dir/build.log" | tail -1)"
if [[ ! -f "$work_dir/b001/importcfg.link" ]]; then
  echo "Go build did not retain the link config" >&2
  exit 1
fi
if [[ ! -f "$work_dir/b001/_pkg_.a" ]]; then
  cached_archive="$(awk -F= '/^packagefile _/ { print $2; exit }' "$work_dir/b001/importcfg.link")"
  if [[ ! -f "$cached_archive" ]]; then
    echo "Go build did not retain or cache the package archive" >&2
    exit 1
  fi
  cp "$cached_archive" "$work_dir/b001/_pkg_.a"
fi

"$go_bin" tool pack r "$work_dir/b001/_pkg_.a" "$output_dir/functions.o" "$output_dir/data.o"
GOROOT="$("$go_bin" env GOROOT)" GOOS=kandelo GOARCH=wasm \
  "$go_bin" tool link -linkmode=internal -o "$output_dir/combined.wasm" \
  -importcfg "$work_dir/b001/importcfg.link" "$work_dir/b001/_pkg_.a"
wasm-validate --enable-threads "$output_dir/combined.wasm"
wasm-objdump -d "$output_dir/combined.wasm" > "$output_dir/disassembly.log"
wasm-objdump -x "$output_dir/combined.wasm" > "$output_dir/sections.log"
if ! rg -q 'call [0-9]+ <triple>' "$output_dir/disassembly.log"; then
  echo "linked C function does not call the relocated C target" >&2
  exit 1
fi
if ! rg -q 'global.get 10' "$output_dir/disassembly.log" || ! rg -q '0700 0000' "$output_dir/sections.log"; then
  echo "linked C data is missing its memory base or initialized bytes" >&2
  exit 1
fi
node "$repo_root/tests/go/cgo/link-only/test-run.mjs" "$output_dir/combined.wasm" "$output_dir/sections.log"
node "$repo_root/tests/go/cgo/link-only/test-run-browser.mjs" "$output_dir/combined.wasm" "$output_dir/sections.log"
printf 'Go/C function-and-data link passed: %s\n' "$output_dir/combined.wasm"
