#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "usage: homebrew-validate-wasm-executable.sh <wasm> <expected-abi> <wasm32|wasm64>" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
exec bash "$SCRIPT_DIR/homebrew-validate-wasm-artifact.sh" "$@" executable
