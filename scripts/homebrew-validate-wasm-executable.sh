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

artifact_identity=""
identity_status=0
used_artifact_identity=0
artifact_imports_kernel_fork=0
artifact_has_fork_exports=0
artifact_identity="$(wasm_artifact_identity "$wasm_path")" || identity_status=$?
if [ "$identity_status" -eq 0 ]; then
    # WHY: ABI 43 helpers use Wasm reference/exception proposals that older
    # WABT releases cannot disassemble. The production wasmparser tool owns one
    # bounded structural request for object kind, memory width, and the exact
    # constant ABI export; source-only environments retain the compatibility
    # path below.
    relocatable=""
    memory_count=""
    memory64_count=""
    abi_state=""
    artifact_abi=""
    artifact_imports_kernel_fork=""
    artifact_has_fork_exports=""
    extra=""
    IFS=$'\t' read -r relocatable memory_count memory64_count abi_state artifact_abi \
        artifact_imports_kernel_fork artifact_has_fork_exports extra <<<"$artifact_identity"
    if [ -n "$extra" ] ||
        [[ ! "$relocatable" =~ ^[01]$ ]] ||
        [[ ! "$memory_count" =~ ^[0-9]+$ ]] ||
        [[ ! "$memory64_count" =~ ^[0-9]+$ ]] ||
        [[ ! "$artifact_imports_kernel_fork" =~ ^[01]$ ]] ||
        [[ ! "$artifact_has_fork_exports" =~ ^[01]$ ]]; then
        echo "homebrew-validate-wasm-executable.sh: cannot inspect Wasm object kind: $wasm_path" >&2
        exit 1
    fi
    used_artifact_identity=1
    if [ "$relocatable" = 1 ]; then
        echo "homebrew-validate-wasm-executable.sh: executable is a relocatable Wasm object: $wasm_path" >&2
        exit 1
    fi
    if [ "$memory_count" != 1 ] ||
        { [ "$memory64_count" != 0 ] && [ "$memory64_count" != 1 ]; }; then
        echo "homebrew-validate-wasm-executable.sh: executable must define or import exactly one inspectable memory: $wasm_path" >&2
        exit 1
    fi
    if [ "$memory64_count" = 1 ]; then
        artifact_arch=wasm64
    else
        artifact_arch=wasm32
    fi
    case "$abi_state" in
        present)
            if [[ ! "$artifact_abi" =~ ^[0-9]+$ ]]; then
                echo "homebrew-validate-wasm-executable.sh: cannot validate __abi_version: $wasm_path" >&2
                exit 1
            fi
            ;;
        missing)
            echo "homebrew-validate-wasm-executable.sh: executable lacks __abi_version: $wasm_path" >&2
            exit 1
            ;;
        invalid)
            echo "homebrew-validate-wasm-executable.sh: cannot validate __abi_version: $wasm_path" >&2
            exit 1
            ;;
        *)
            echo "homebrew-validate-wasm-executable.sh: cannot validate __abi_version: $wasm_path" >&2
            exit 1
            ;;
    esac
elif [ "$identity_status" -eq 127 ]; then
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
else
    echo "homebrew-validate-wasm-executable.sh: cannot inspect Wasm object kind: $wasm_path" >&2
    exit 1
fi

if [ "$artifact_arch" != "$expected_arch" ]; then
    echo "homebrew-validate-wasm-executable.sh: executable architecture $artifact_arch does not match expected architecture $expected_arch: $wasm_path" >&2
    exit 1
fi

if [ "$artifact_abi" != "$expected_abi" ]; then
    echo "homebrew-validate-wasm-executable.sh: executable ABI $artifact_abi does not match expected ABI $expected_abi: $wasm_path" >&2
    exit 1
fi

wasm_require_fork_instrumentation_if_needed "$wasm_path"

fork_required=0
if [ "$used_artifact_identity" -eq 1 ]; then
    if [ "$artifact_imports_kernel_fork" = 1 ] ||
        [ "$artifact_has_fork_exports" = 1 ]; then
        fork_required=1
    fi
else
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
fi

if [ "$fork_required" -eq 1 ]; then
    printf 'required\n'
else
    printf 'not-required\n'
fi
