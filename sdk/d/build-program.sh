#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
    printf 'Usage: %s <D SDK directory> <output.wasm> <LDC inputs and options...>\n' "$0" >&2
    exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(cd "$1" && pwd)"
output="$2"
shift 2
source "$REPO_ROOT/sdk/activate.sh"
source "$REPO_ROOT/scripts/abi-contract-stamp.sh"

temporary="$(mktemp -d "$(dirname "$output")/.kandelo-d.XXXXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
"$work/ldc-build/bin/ldc2" -conf= -O2 \
    -mtriple=wasm32-unknown-kandelo-musl \
    -mattr=+atomics,+bulk-memory,+mutable-globals \
    --wasm-enable-eh --wasm-use-legacy-eh=false \
    -I="$work/release-src/runtime/druntime/src" \
    -I="$work/release-src/runtime/phobos" \
    -I="$work/ldc-build/import" \
    -defaultlib=phobos2-ldc,druntime-ldc,kandelo-continuation "-L-L$work/runtime-build/lib" \
    -gcc=wasm32posix-cc -Xcc=-pthread -of="$temporary/program.wasm" "$@"
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$temporary/program.wasm" -o "$temporary/guest.wasm"
abi_contract_stamp_prepare
abi_contract_stamp "$temporary/guest.wasm"
mv -- "$temporary/guest.wasm" "$output"
