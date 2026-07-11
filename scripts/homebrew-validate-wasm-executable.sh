#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "usage: homebrew-validate-wasm-executable.sh <wasm> <expected-abi> <wasm32|wasm64>" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=wasm-artifact-guards.sh
source "$SCRIPT_DIR/wasm-artifact-guards.sh"

wasm_path="$1"
expected_abi="$2"
expected_arch="$3"
if ! [[ "$expected_abi" =~ ^[1-9][0-9]*$ ]] || [ "$expected_abi" -gt 4294967295 ]; then
    echo "homebrew-validate-wasm-executable.sh: invalid expected ABI: $expected_abi" >&2
    exit 2
fi
case "$expected_arch" in
    wasm32|wasm64) ;;
    *)
        echo "homebrew-validate-wasm-executable.sh: invalid expected architecture: $expected_arch" >&2
        exit 2
        ;;
esac
if ! wasm_is_binary "$wasm_path"; then
    echo "homebrew-validate-wasm-executable.sh: input is not a Wasm binary: $wasm_path" >&2
    exit 1
fi

wasm_require_no_legacy_asyncify "$wasm_path"

relocatable_status=0
wasm_is_relocatable_object "$wasm_path" || relocatable_status=$?
case "$relocatable_status" in
    0)
        echo "homebrew-validate-wasm-executable.sh: executable is a relocatable Wasm object: $wasm_path" >&2
        exit 1
        ;;
    1) ;;
    *)
        echo "homebrew-validate-wasm-executable.sh: cannot inspect Wasm object kind: $wasm_path" >&2
        exit 1
        ;;
esac

artifact_arch=""
arch_status=0
artifact_arch="$(wasm_memory_arch "$wasm_path")" || arch_status=$?
if [ "$arch_status" -ne 0 ]; then
    echo "homebrew-validate-wasm-executable.sh: executable must define or import exactly one inspectable memory: $wasm_path" >&2
    exit 1
fi
if [ "$artifact_arch" != "$expected_arch" ]; then
    echo "homebrew-validate-wasm-executable.sh: executable architecture $artifact_arch does not match expected architecture $expected_arch: $wasm_path" >&2
    exit 1
fi

artifact_abi=""
abi_status=0
artifact_abi="$(wasm_extract_abi_version "$wasm_path")" || abi_status=$?
case "$abi_status" in
    0) ;;
    1)
        echo "homebrew-validate-wasm-executable.sh: executable lacks __abi_version: $wasm_path" >&2
        exit 1
        ;;
    *)
        echo "homebrew-validate-wasm-executable.sh: cannot validate __abi_version: $wasm_path" >&2
        exit 1
        ;;
esac
if [ "$artifact_abi" != "$expected_abi" ]; then
    echo "homebrew-validate-wasm-executable.sh: executable ABI $artifact_abi does not match expected ABI $expected_abi: $wasm_path" >&2
    exit 1
fi

wasm_require_fork_instrumentation_if_needed "$wasm_path"

fork_required=0
predicate_status=0
wasm_imports_kernel_fork "$wasm_path" || predicate_status=$?
case "$predicate_status" in
    0) fork_required=1 ;;
    1) ;;
    *)
        echo "homebrew-validate-wasm-executable.sh: cannot inspect kernel fork import: $wasm_path" >&2
        exit 1
        ;;
esac
predicate_status=0
wasm_has_any_wpk_fork_export "$wasm_path" || predicate_status=$?
case "$predicate_status" in
    0) fork_required=1 ;;
    1) ;;
    *)
        echo "homebrew-validate-wasm-executable.sh: cannot inspect fork exports: $wasm_path" >&2
        exit 1
        ;;
esac

if [ "$fork_required" -eq 1 ]; then
    printf 'required\n'
else
    printf 'not-required\n'
fi
