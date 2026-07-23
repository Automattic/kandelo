#!/usr/bin/env bash
#
# Resolve one repository artifact through the same TypeScript resolver used by
# Node and browser build tooling. The Rust-generated program package projection
# therefore governs shell, TypeScript, external registries, and installed host
# packages without a second manifest parser.
#
# Usage:
#   scripts/resolve-binary.sh kernel.wasm
#   scripts/resolve-binary.sh programs/dash.wasm
#   scripts/resolve-binary.sh programs/cpython/python.wasm

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
if [ $# -ne 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    sed -n '3,12p' "$0"
    exit 0
fi

repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"
exec node "$script_dir/resolve-binary.bundle.mjs" "$1"
