#!/usr/bin/env bash
#
# Shared checks for wasm artifacts that enter resolver-visible locations.
# Asyncify is retired in this repo; any wasm still exporting or naming
# `asyncify_*` is a stale fork-continuation artifact, regardless of ABI
# metadata.

wasm_is_binary() {
    local path="${1:-}"
    [ -f "$path" ] || return 1
    [ "$(od -An -tx1 -N4 "$path" 2>/dev/null | tr -d ' \n')" = "0061736d" ]
}

wasm_has_legacy_asyncify() {
    wasm_is_binary "${1:-}" || return 1
    grep -a -q 'asyncify_' "$1" 2>/dev/null
}

wasm_require_no_legacy_asyncify() {
    local path="${1:-}"
    if wasm_has_legacy_asyncify "$path"; then
        echo "ERROR: refusing legacy Asyncify wasm artifact: $path" >&2
        echo "       Rebuild it with scripts/run-wasm-fork-instrument.sh for fork-capable binaries." >&2
        return 1
    fi
}

wasm_current_abi_version() {
    local repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);/\1/p' \
        "$repo_root/crates/shared/src/lib.rs" | head -1
}

_wasm_extract_constant_i32_body() {
    local function_index="${1:-}"
    [[ "$function_index" =~ ^[0-9]+$ ]] || return 1

    awk -v function_index="$function_index" '
        index($0, " func[" function_index "]") && /:$/ {
            in_function = 1
            valid = 1
            next
        }
        in_function && /\| i32.const [0-9]+$/ {
            if (seen_constant || seen_return) valid = 0
            value = $NF
            seen_constant = 1
            next
        }
        in_function && /\| return$/ {
            if (!seen_constant || seen_return) valid = 0
            seen_return = 1
            next
        }
        in_function && /\| end$/ {
            if (valid && seen_constant) print value
            exit
        }
        in_function && !/^[[:space:]]*$/ { valid = 0 }
    '
}

wasm_extract_abi_version_with_binaryen() {
    local path="${1:-}"
    local function_index="${2:-}"
    command -v wasm-opt >/dev/null 2>&1 || return 1
    [[ "$function_index" =~ ^[0-9]+$ ]] || return 1

    local extracted details extracted_function_index signature_index dump abi
    extracted="$(mktemp)" || return 1
    if ! wasm-opt "$path" "--extract-function-index=$function_index" -o "$extracted" 2>/dev/null; then
        rm -f "$extracted"
        return 1
    fi
    details="$(wasm-objdump -x "$extracted" 2>/dev/null)" || {
        rm -f "$extracted"
        return 1
    }
    extracted_function_index="$(
        sed -nE 's/^ - func\[([0-9]+)\].* -> ".*"$/\1/p' <<< "$details"
    )"
    [[ "$extracted_function_index" =~ ^[0-9]+$ ]] || {
        rm -f "$extracted"
        return 1
    }
    signature_index="$(
        sed -nE "s/^ - func\\[$extracted_function_index\\] sig=([0-9]+).*/\\1/p" <<< "$details"
    )"
    [[ "$signature_index" =~ ^[0-9]+$ ]] &&
        grep -Fqx " - type[$signature_index] () -> i32" <<< "$details" || {
        rm -f "$extracted"
        return 1
    }
    dump="$(wasm-objdump -d "$extracted" 2>/dev/null)" || {
        rm -f "$extracted"
        return 1
    }
    rm -f "$extracted"
    abi="$(_wasm_extract_constant_i32_body "$extracted_function_index" <<< "$dump")"
    [[ "$abi" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$abi"
}

wasm_extract_abi_version() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    command -v wasm-objdump >/dev/null 2>&1 || return 1
    local details function_index signature_index
    details="$(wasm-objdump -x "$path" 2>/dev/null)" || return 1
    function_index="$(
        sed -nE 's/^ - func\[([0-9]+)\].* -> "__abi_version"$/\1/p' <<< "$details"
    )"
    [[ "$function_index" =~ ^[0-9]+$ ]] || return 1
    signature_index="$(
        sed -nE "s/^ - func\\[$function_index\\] sig=([0-9]+).*/\\1/p" <<< "$details"
    )"
    [[ "$signature_index" =~ ^[0-9]+$ ]] || return 1
    grep -Fqx " - type[$signature_index] () -> i32" <<< "$details" || return 1

    local dump abi
    if dump="$(wasm-objdump -d "$path" 2>/dev/null)"; then
        abi="$(_wasm_extract_constant_i32_body "$function_index" <<< "$dump")"
        if [[ "$abi" =~ ^[0-9]+$ ]]; then
            printf '%s\n' "$abi"
            return 0
        fi
    fi

    # Fork instrumentation can produce a large dispatcher that WABT cannot
    # finish disassembling. Its section details remain readable, so use the
    # exported function index to extract only the ABI function with Binaryen.
    wasm_extract_abi_version_with_binaryen "$path" "$function_index"
}

wasm_has_stale_abi() {
    local path="${1:-}"
    local current_abi="${2:-}"
    [ -n "$current_abi" ] || return 1

    local artifact_abi
    artifact_abi="$(wasm_extract_abi_version "$path" || true)"
    [ -n "$artifact_abi" ] && [ "$artifact_abi" != "$current_abi" ]
}

wasm_imports_kernel_fork() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    if command -v wasm-objdump >/dev/null 2>&1; then
        local dump
        dump="$(wasm-objdump -x "$path" 2>/dev/null)" || return 1
        grep -q '<- kernel\.kernel_fork' <<< "$dump"
        return $?
    fi
    # Fallback for environments without wabt/binaryen tools. The field name is
    # stored as plain UTF-8 in the import section.
    grep -a -q 'kernel_fork' "$path" 2>/dev/null
}

wasm_has_wpk_fork_export() {
    local path="${1:-}"
    local name="${2:-}"
    [ -n "$name" ] || return 1
    wasm_is_binary "$path" || return 1
    if command -v wasm-objdump >/dev/null 2>&1; then
        local dump
        dump="$(wasm-objdump -x "$path" 2>/dev/null)" || return 1
        grep -q -- "-> \"$name\"" <<< "$dump"
        return $?
    fi
    grep -a -q "$name" "$path" 2>/dev/null
}

wasm_has_export() {
    wasm_has_wpk_fork_export "$@"
}

wasm_has_missing_exports() {
    local path="${1:-}"
    shift || true
    local name
    for name in "$@"; do
        if ! wasm_has_export "$path" "$name"; then
            return 0
        fi
    done
    return 1
}

wasm_require_exports() {
    local path="${1:-}"
    shift || true
    local missing=()
    local name
    for name in "$@"; do
        if ! wasm_has_export "$path" "$name"; then
            missing+=("$name")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo "ERROR: refusing wasm artifact missing required exports: $path" >&2
        printf '       missing: %s\n' "${missing[*]}" >&2
        return 1
    fi
}

wasm_has_complete_fork_instrumentation() {
    local path="${1:-}"
    wasm_has_wpk_fork_export "$path" wpk_fork_unwind_begin &&
        wasm_has_wpk_fork_export "$path" wpk_fork_unwind_end &&
        wasm_has_wpk_fork_export "$path" wpk_fork_rewind_begin &&
        wasm_has_wpk_fork_export "$path" wpk_fork_rewind_end &&
        wasm_has_wpk_fork_export "$path" wpk_fork_state
}

wasm_is_relocatable_object() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    if command -v wasm-objdump >/dev/null 2>&1; then
        local dump
        dump="$(wasm-objdump -x "$path" 2>/dev/null)" || return 1
        grep -q -E 'name: "(linking|reloc\.)' <<< "$dump"
        return $?
    fi
    case "$path" in
        *.o) return 0 ;;
        *) return 1 ;;
    esac
}

wasm_has_any_wpk_fork_export() {
    local path="${1:-}"
    wasm_has_wpk_fork_export "$path" wpk_fork_unwind_begin ||
        wasm_has_wpk_fork_export "$path" wpk_fork_unwind_end ||
        wasm_has_wpk_fork_export "$path" wpk_fork_rewind_begin ||
        wasm_has_wpk_fork_export "$path" wpk_fork_rewind_end ||
        wasm_has_wpk_fork_export "$path" wpk_fork_state
}

wasm_has_missing_fork_instrumentation() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    wasm_is_relocatable_object "$path" && return 1
    if wasm_imports_kernel_fork "$path" && ! wasm_has_complete_fork_instrumentation "$path"; then
        return 0
    fi
    if wasm_has_any_wpk_fork_export "$path" && ! wasm_has_complete_fork_instrumentation "$path"; then
        return 0
    fi
    return 1
}

wasm_require_fork_instrumentation_if_needed() {
    local path="${1:-}"
    if wasm_has_missing_fork_instrumentation "$path"; then
        echo "ERROR: refusing wasm artifact with incomplete/missing fork instrumentation: $path" >&2
        echo "       Binaries that import kernel.kernel_fork must be processed with scripts/run-wasm-fork-instrument.sh." >&2
        return 1
    fi
}

wasm_require_no_fork_instrumentation() {
    local path="${1:-}"
    if wasm_has_any_wpk_fork_export "$path"; then
        echo "ERROR: refusing wasm artifact with disabled fork instrumentation policy: $path" >&2
        echo "       Rebuild it without scripts/run-wasm-fork-instrument.sh." >&2
        return 1
    fi
}
