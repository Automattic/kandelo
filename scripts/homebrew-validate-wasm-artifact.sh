#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
    echo "usage: homebrew-validate-wasm-artifact.sh <wasm> <expected-abi> <wasm32|wasm64> <payload|executable|path-executable>" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=wasm-artifact-guards.sh
source "$SCRIPT_DIR/wasm-artifact-guards.sh"

wasm_path="$1"
expected_abi="$2"
expected_arch="$3"
declared_role="$4"
if ! [[ "$expected_abi" =~ ^[1-9][0-9]*$ ]] || [ "$expected_abi" -gt 4294967295 ]; then
    echo "homebrew-validate-wasm-artifact.sh: invalid expected ABI: $expected_abi" >&2
    exit 2
fi
case "$expected_arch" in
    wasm32|wasm64) ;;
    *)
        echo "homebrew-validate-wasm-artifact.sh: invalid expected architecture: $expected_arch" >&2
        exit 2
        ;;
esac
case "$declared_role" in
    payload|executable|path-executable) ;;
    *)
        echo "homebrew-validate-wasm-artifact.sh: invalid declared artifact role: $declared_role" >&2
        exit 2
        ;;
esac
if ! wasm_is_binary "$wasm_path"; then
    echo "homebrew-validate-wasm-artifact.sh: input is not a Wasm binary: $wasm_path" >&2
    exit 1
fi

wasm_require_no_legacy_asyncify "$wasm_path"

artifact_identity_row=""
identity_status=0
used_artifact_identity=0
artifact_imports_kernel_fork=0
artifact_imports_side_fork=0
artifact_has_fork_exports=0
artifact_identity_row="$(wasm_artifact_identity "$wasm_path")" || identity_status=$?
if [ "$identity_status" -eq 0 ]; then
    # WHY: ABI 43 helpers use Wasm reference and exception proposals that
    # older WABT releases cannot disassemble. One bounded wasmparser request
    # owns executable and side-module classification, memory width, import
    # boundaries, and the exact constant ABI export on every release host.
    artifact_relocatable=""
    artifact_memory_count=""
    artifact_memory64_count=""
    artifact_abi_state=""
    artifact_abi=""
    artifact_imports_kernel_fork=""
    artifact_imports_side_fork=""
    artifact_has_fork_exports=""
    artifact_dylink_count=""
    artifact_dylink_first=""
    artifact_env_memory_count=""
    artifact_unsupported_side_import_count=""
    extra=""
    IFS=$'\t' read -r artifact_relocatable artifact_memory_count \
        artifact_memory64_count artifact_abi_state artifact_abi \
        artifact_imports_kernel_fork artifact_imports_side_fork \
        artifact_has_fork_exports artifact_dylink_count \
        artifact_dylink_first artifact_env_memory_count \
        artifact_unsupported_side_import_count extra \
        <<<"$artifact_identity_row"
    if [ -n "$extra" ] ||
        [[ ! "$artifact_relocatable" =~ ^[01]$ ]] ||
        [[ ! "$artifact_memory_count" =~ ^[0-9]+$ ]] ||
        [[ ! "$artifact_memory64_count" =~ ^[0-9]+$ ]] ||
        [[ ! "$artifact_imports_kernel_fork" =~ ^[0-9]+$ ]] ||
        [[ ! "$artifact_imports_side_fork" =~ ^[0-9]+$ ]] ||
        [[ ! "$artifact_has_fork_exports" =~ ^[01]$ ]] ||
        [[ ! "$artifact_dylink_count" =~ ^[0-9]+$ ]] ||
        [[ ! "$artifact_dylink_first" =~ ^[01]$ ]] ||
        [[ ! "$artifact_env_memory_count" =~ ^[0-9]+$ ]] ||
        [[ ! "$artifact_unsupported_side_import_count" =~ ^[0-9]+$ ]]; then
        echo "homebrew-validate-wasm-artifact.sh: cannot inspect Wasm object kind: $wasm_path" >&2
        exit 1
    fi
    case "$artifact_abi_state" in
        present)
            [[ "$artifact_abi" =~ ^[0-9]+$ ]] || {
                echo "homebrew-validate-wasm-artifact.sh: cannot validate __abi_version: $wasm_path" >&2
                exit 1
            }
            ;;
        missing|invalid)
            [ "$artifact_abi" = - ] || {
                echo "homebrew-validate-wasm-artifact.sh: cannot validate __abi_version: $wasm_path" >&2
                exit 1
            }
            ;;
        *)
            echo "homebrew-validate-wasm-artifact.sh: cannot validate __abi_version: $wasm_path" >&2
            exit 1
            ;;
    esac
    used_artifact_identity=1
    if [ "$artifact_relocatable" = 1 ]; then
        echo "homebrew-validate-wasm-artifact.sh: artifact is a relocatable Wasm object: $wasm_path" >&2
        exit 1
    fi
    if [ "$artifact_dylink_count" = 0 ] && [ "$artifact_dylink_first" = 0 ]; then
        artifact_role=executable
    elif [ "$artifact_dylink_count" = 1 ] && [ "$artifact_dylink_first" = 1 ]; then
        artifact_role=side-module
    else
        echo "homebrew-validate-wasm-artifact.sh: malformed or misplaced dylink.0 artifact role: $wasm_path" >&2
        exit 1
    fi
elif [ "$identity_status" -eq 127 ]; then
    relocatable_status=0
    wasm_is_relocatable_object "$wasm_path" || relocatable_status=$?
    case "$relocatable_status" in
        0)
            echo "homebrew-validate-wasm-artifact.sh: artifact is a relocatable Wasm object: $wasm_path" >&2
            exit 1
            ;;
        1) ;;
        *)
            echo "homebrew-validate-wasm-artifact.sh: cannot inspect Wasm object kind: $wasm_path" >&2
            exit 1
            ;;
    esac

    artifact_role=""
    role_status=0
    artifact_role="$(wasm_artifact_role "$wasm_path")" || role_status=$?
    if [ "$role_status" -ne 0 ]; then
        echo "homebrew-validate-wasm-artifact.sh: malformed or misplaced dylink.0 artifact role: $wasm_path" >&2
        exit 1
    fi
else
    echo "homebrew-validate-wasm-artifact.sh: cannot inspect Wasm object kind: $wasm_path" >&2
    exit 1
fi

# WHY: a mode bit or `.so` suffix is not enough to decide how Wasm is loaded.
# PATH files are declared launch entrypoints and must remain process modules;
# other payload Wasm may opt into the runtime's structural `dylink.0` contract.
# This prevents a side module from bypassing executable ABI checks merely by
# moving under `bin/`, while allowing real shared modules to omit executable-
# only exports that the dynamic linker never consumes.
if [ "$declared_role" != "payload" ] && [ "$artifact_role" != "executable" ]; then
    echo "homebrew-validate-wasm-artifact.sh: declared executable is a dylink.0 side module: $wasm_path" >&2
    exit 1
fi
if [ "$declared_role" = "executable" ]; then
    artifact_role="executable"
fi

artifact_arch=""
arch_status=0
if [ "$used_artifact_identity" -eq 1 ]; then
    if [ "$artifact_role" = "side-module" ]; then
        if [ "$artifact_memory_count" != 1 ] ||
            { [ "$artifact_memory64_count" != 0 ] && [ "$artifact_memory64_count" != 1 ]; } ||
            [ "$artifact_env_memory_count" != 1 ] ||
            [ "$artifact_unsupported_side_import_count" != 0 ]; then
            echo "homebrew-validate-wasm-artifact.sh: side module has an unsupported memory or import contract: $wasm_path" >&2
            exit 1
        fi
    elif [ "$artifact_memory_count" != 1 ] ||
        { [ "$artifact_memory64_count" != 0 ] && [ "$artifact_memory64_count" != 1 ]; }; then
        echo "homebrew-validate-wasm-artifact.sh: executable must define or import exactly one inspectable memory: $wasm_path" >&2
        exit 1
    fi
    if [ "$artifact_memory64_count" = 1 ]; then
        artifact_arch=wasm64
    else
        artifact_arch=wasm32
    fi
elif [ "$artifact_role" = "side-module" ]; then
    artifact_arch="$(wasm_validate_side_module_imports "$wasm_path")" || arch_status=$?
    if [ "$arch_status" -ne 0 ]; then
        echo "homebrew-validate-wasm-artifact.sh: side module has an unsupported memory or import contract: $wasm_path" >&2
        exit 1
    fi
else
    artifact_arch="$(wasm_memory_arch "$wasm_path")" || arch_status=$?
    if [ "$arch_status" -ne 0 ]; then
        echo "homebrew-validate-wasm-artifact.sh: executable must define or import exactly one inspectable memory: $wasm_path" >&2
        exit 1
    fi
fi
if [ "$artifact_arch" != "$expected_arch" ]; then
    echo "homebrew-validate-wasm-artifact.sh: $artifact_role architecture $artifact_arch does not match expected architecture $expected_arch: $wasm_path" >&2
    exit 1
fi

if [ "$artifact_role" = "executable" ]; then
    if { [ "$used_artifact_identity" -eq 1 ] && [ "$artifact_imports_side_fork" != 0 ]; } ||
        { [ "$used_artifact_identity" -eq 0 ] && wasm_imports_side_module_fork "$wasm_path"; }; then
        echo "homebrew-validate-wasm-artifact.sh: executable imports side-module-only env.fork: $wasm_path" >&2
        exit 1
    fi

    if [ "$used_artifact_identity" -eq 1 ]; then
        case "$artifact_abi_state" in
            present) ;;
            missing)
                echo "homebrew-validate-wasm-artifact.sh: executable lacks __abi_version: $wasm_path" >&2
                exit 1
                ;;
            *)
                echo "homebrew-validate-wasm-artifact.sh: cannot validate __abi_version: $wasm_path" >&2
                exit 1
                ;;
        esac
    else
        artifact_abi=""
        abi_status=0
        artifact_abi="$(wasm_extract_abi_version "$wasm_path")" || abi_status=$?
        case "$abi_status" in
            0) ;;
            1)
                echo "homebrew-validate-wasm-artifact.sh: executable lacks __abi_version: $wasm_path" >&2
                exit 1
                ;;
            *)
                echo "homebrew-validate-wasm-artifact.sh: cannot validate __abi_version: $wasm_path" >&2
                exit 1
                ;;
        esac
    fi
    if [ "$artifact_abi" != "$expected_abi" ]; then
        echo "homebrew-validate-wasm-artifact.sh: executable ABI $artifact_abi does not match expected ABI $expected_abi: $wasm_path" >&2
        exit 1
    fi
else
    if { [ "$used_artifact_identity" -eq 1 ] && [ "$artifact_imports_kernel_fork" != 0 ]; } ||
        { [ "$used_artifact_identity" -eq 0 ] && wasm_imports_kernel_fork "$wasm_path"; }; then
        echo "homebrew-validate-wasm-artifact.sh: side module imports executable-only kernel.kernel_fork: $wasm_path" >&2
        exit 1
    fi
fi

wasm_require_fork_instrumentation_if_needed "$wasm_path"

fork_required=0
if [ "$used_artifact_identity" -eq 1 ]; then
    if { [ "$artifact_role" = "side-module" ] && [ "$artifact_imports_side_fork" != 0 ]; } ||
        { [ "$artifact_role" = "executable" ] && [ "$artifact_imports_kernel_fork" != 0 ]; } ||
        [ "$artifact_has_fork_exports" = 1 ]; then
        fork_required=1
    fi
else
    predicate_status=0
    if [ "$artifact_role" = "side-module" ]; then
        wasm_imports_side_module_fork "$wasm_path" || predicate_status=$?
    else
        wasm_imports_kernel_fork "$wasm_path" || predicate_status=$?
    fi
    case "$predicate_status" in
        0) fork_required=1 ;;
        1) ;;
        *)
            echo "homebrew-validate-wasm-artifact.sh: cannot inspect $artifact_role fork import: $wasm_path" >&2
            exit 1
            ;;
    esac
    predicate_status=0
    wasm_has_any_wpk_fork_export "$wasm_path" || predicate_status=$?
    case "$predicate_status" in
        0) fork_required=1 ;;
        1) ;;
        *)
            echo "homebrew-validate-wasm-artifact.sh: cannot inspect fork exports: $wasm_path" >&2
            exit 1
            ;;
    esac
fi

if [ "$fork_required" -eq 1 ]; then
    printf 'required\n'
else
    printf 'not-required\n'
fi
