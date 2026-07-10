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

# Run a producer into awk without inheriting either errexit or pipefail from
# the caller, then return the producer's status before the consumer's. This
# keeps large Wasm inspections streaming while ensuring a decoder failure can
# never be mistaken for a successful negative match.
_wasm_stream_awk() {
    local program="${1:-}"
    shift || true
    [ -n "$program" ] && [ "$#" -gt 0 ] || return 1

    local restore_errexit=0
    local restore_pipefail=0
    case "$-" in
        *e*) restore_errexit=1; set +e ;;
    esac
    if shopt -qo pipefail; then
        restore_pipefail=1
        set +o pipefail
    fi

    "$@" 2>/dev/null | awk "$program"
    local statuses=("${PIPESTATUS[@]}")

    if [ "$restore_pipefail" -eq 1 ]; then
        set -o pipefail
    fi
    if [ "$restore_errexit" -eq 1 ]; then
        set -e
    fi

    if [ "${statuses[0]:-1}" -ne 0 ]; then
        # Status 1 is also awk's ordinary "predicate did not match" result.
        # Map a producer's status 1 to a distinct decoder-error status so
        # callers can preserve the predicate's tri-state contract.
        if [ "${statuses[0]}" -eq 1 ]; then
            return 2
        fi
        return "${statuses[0]}"
    fi
    return "${statuses[1]:-1}"
}

wasm_extract_abi_version() {
    local path="${1:-}"
    local version
    wasm_is_binary "$path" || return 1
    # Keep the disassembly streaming. Large package binaries (PHP is roughly
    # 37 MiB) can produce hundreds of MiB of text and must not be captured in a
    # shell variable merely to inspect one function. Prefer Binaryen here:
    # WABT 1.0.37 cannot finish disassembling LLVM 21 exception-reference code
    # after fork instrumentation, even though the module is valid in V8.
    if command -v wasm-dis >/dev/null 2>&1; then
        version="$(_wasm_stream_awk '
            index($0, "(export \"__abi_version\" (func $") {
                target = $0
                sub(/^.*\(func \$/, "", target)
                sub(/\).*$/, "", target)
            }
            target != "" && index($0, "(func $" target " ") {
                in_abi = 1
                next
            }
            in_abi && match($0, /\(i32.const -?[0-9]+\)/) {
                version = substr($0, RSTART + 11, RLENGTH - 12)
                in_abi = 0
            }
            END {
                if (version != "") print version
                else exit 1
            }
        ' wasm-dis "$path" -o -)" || return $?
        printf '%s\n' "$version"
        return
    fi
    command -v wasm-objdump >/dev/null 2>&1 || return 1
    version="$(_wasm_stream_awk '
        /<__abi_version>:/ { in_abi = 1; next }
        in_abi && version == "" && /i32.const/ { version = $NF; in_abi = 0 }
        in_abi && / end$/ { in_abi = 0 }
        END {
            if (version != "") print version
            else exit 1
        }
    ' wasm-objdump -d "$path")" || return $?
    printf '%s\n' "$version"
}

wasm_has_stale_abi() {
    local path="${1:-}"
    local current_abi="${2:-}"
    [ -n "$current_abi" ] || return 1

    local artifact_abi extract_status=0
    artifact_abi="$(wasm_extract_abi_version "$path")" || extract_status=$?
    # A missing ABI export remains "not stale" for artifacts whose policy does
    # not require one. A decoder failure is different: fail closed and let the
    # caller reject the artifact rather than accepting uninspected bytes.
    if [ "$extract_status" -gt 1 ]; then
        return 0
    fi
    [ -n "$artifact_abi" ] && [ "$artifact_abi" != "$current_abi" ]
}

wasm_imports_kernel_fork() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    if command -v wasm-objdump >/dev/null 2>&1; then
        _wasm_stream_awk '
            /<- kernel\.kernel_fork/ { found = 1 }
            END { exit(found ? 0 : 1) }
        ' wasm-objdump -x "$path"
        return
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
        WASM_ARTIFACT_EXPORT_NAME="$name" \
        _wasm_stream_awk '
            index($0, "-> \"" ENVIRON["WASM_ARTIFACT_EXPORT_NAME"] "\"") { found = 1 }
            END { exit(found ? 0 : 1) }
        ' wasm-objdump -x "$path"
        return
    fi
    grep -a -q "$name" "$path" 2>/dev/null
}

wasm_has_export() {
    wasm_has_wpk_fork_export "$@"
}

wasm_has_missing_exports() {
    local path="${1:-}"
    shift || true
    local name export_status
    for name in "$@"; do
        export_status=0
        wasm_has_export "$path" "$name" || export_status=$?
        if [ "$export_status" -ne 0 ]; then
            return 0
        fi
    done
    return 1
}

wasm_require_exports() {
    local path="${1:-}"
    shift || true
    local missing=()
    local name export_status
    for name in "$@"; do
        export_status=0
        wasm_has_export "$path" "$name" || export_status=$?
        if [ "$export_status" -ne 0 ]; then
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
        _wasm_stream_awk '
            /name: "(linking|reloc\.)/ { found = 1 }
            END { exit(found ? 0 : 1) }
        ' wasm-objdump -x "$path"
        return
    fi
    case "$path" in
        *.o) return 0 ;;
        *) return 1 ;;
    esac
}

wasm_has_any_wpk_fork_export() {
    local path="${1:-}"
    local name export_status
    for name in \
        wpk_fork_unwind_begin \
        wpk_fork_unwind_end \
        wpk_fork_rewind_begin \
        wpk_fork_rewind_end \
        wpk_fork_state; do
        export_status=0
        wasm_has_wpk_fork_export "$path" "$name" || export_status=$?
        case "$export_status" in
            0) return 0 ;;
            1) ;;
            *) return 0 ;; # Decoder failure: fail closed as an unsafe artifact.
        esac
    done
    return 1
}

wasm_has_missing_fork_instrumentation() {
    local path="${1:-}"
    local predicate_status complete_status
    wasm_is_binary "$path" || return 1

    predicate_status=0
    wasm_is_relocatable_object "$path" || predicate_status=$?
    case "$predicate_status" in
        0) return 1 ;;
        1) ;;
        *) return 0 ;; # Decoder failure: reject as uninspectable.
    esac

    predicate_status=0
    wasm_imports_kernel_fork "$path" || predicate_status=$?
    case "$predicate_status" in
        0)
            complete_status=0
            wasm_has_complete_fork_instrumentation "$path" || complete_status=$?
            [ "$complete_status" -eq 0 ] && return 1
            return 0
            ;;
        1) ;;
        *) return 0 ;;
    esac

    predicate_status=0
    wasm_has_any_wpk_fork_export "$path" || predicate_status=$?
    case "$predicate_status" in
        0)
            complete_status=0
            wasm_has_complete_fork_instrumentation "$path" || complete_status=$?
            [ "$complete_status" -eq 0 ] && return 1
            return 0
            ;;
        1) return 1 ;;
        *) return 0 ;;
    esac
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
