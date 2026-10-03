#!/usr/bin/env bash
# Run fpa on one captured link: fpa-run.sh <shim-dir> <runtime-dir> <link-id-prefix> [fpa args...]
set -euo pipefail
SHIMS=$1 RT=$2 ID=$3; shift 3
L=$(ls "$SHIMS"/links/"$ID"-*.wasm | head -1); L=${L%.wasm}
F=$(dirname "$0")/../fpa/target/$(rustc -vV | awk '/^host/ {print $2}')/release/fpa
exec "$F" --wasm "$L.wasm" --map "$L.map" --inputs "$L.inputs" --side-dir "$SHIMS/side" --aliases "$RT/aliases.tsv" "$@"
