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

wasm_extract_abi_version() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    command -v wasm-objdump >/dev/null 2>&1 || return 1
    local dump
    dump="$(wasm-objdump -d "$path" 2>/dev/null)" || return 1
    awk '
        /<__abi_version>:/ { in_abi = 1; next }
        in_abi && /i32.const/ { print $NF; exit }
        in_abi && / end$/ { exit }
    ' <<< "$dump"
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
