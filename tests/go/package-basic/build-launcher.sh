#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
source "$repo_root/sdk/activate.sh"
output_dir="$repo_root/.context/go-package"
mkdir -p "$output_dir"
wasm32posix-cc -O2 "$repo_root/tests/go/package-basic/launcher.c" \
    -o "$output_dir/launcher.wasm"
host_target="$(rustc -vV | sed -n 's/^host: //p')"
(cd "$repo_root" && cargo run -p xtask --target "$host_target" --quiet -- \
    stamp-abi-contract "$output_dir/launcher.wasm")
