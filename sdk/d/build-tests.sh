#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
    printf 'Usage: %s <D SDK directory> <output-directory> [druntime|phobos2]\n' "$0" >&2
    exit 2
fi

case "${3:-}" in
    '') suites=(druntime phobos2) ;;
    druntime|phobos2) suites=("$3") ;;
    *) printf 'Unknown D test suite: %s\n' "$3" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runtime="$(cd "$1/runtime-build" && pwd)"
output="$2"
source "$REPO_ROOT/sdk/activate.sh"
source "$REPO_ROOT/scripts/abi-contract-stamp.sh"

cmake --build "$runtime" --parallel "${KANDELO_D_BUILD_JOBS:-2}" \
    --target "${suites[@]/%/-test-runner}"
abi_contract_stamp_prepare

mkdir -p "$output"
temporary="$(mktemp -d "$output/.kandelo-d-tests.XXXXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
for suite in "${suites[@]}"; do
    filename="$suite-test-runner.wasm"
    "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$runtime/$filename" -o "$temporary/$filename"
    abi_contract_stamp "$temporary/$filename"
done
mv -- "$temporary/"*-test-runner.wasm "$output/"
