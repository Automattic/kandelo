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
# never be mistaken for a successful parse.
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
    wasm_is_binary "$path" || return 1
    command -v wasm-objdump >/dev/null 2>&1 || return 1

    # The export name and the function's optional debug name are separate Wasm
    # concepts. SDK binaries export the internal function
    # `__wasm_posix_user_abi_version` as `__abi_version`, and stripped binaries
    # have no function names at all. Resolve the export to its numeric function
    # index first; that index is stable in `wasm-objdump` output regardless of
    # the custom name section.
    local func_index export_status=0
    func_index="$(_wasm_stream_awk '
        index($0, "-> \"__abi_version\"") {
            line = $0
            if (match(line, /func\[[0-9]+\]/)) {
                target = substr(line, RSTART + 5, RLENGTH - 6)
            }
        }
        END {
            if (target != "") print target
            else exit 1
        }
    ' wasm-objdump -x "$path")" || export_status=$?
    [ "$export_status" -eq 0 ] && [ -n "$func_index" ] || return 1

    # Accept only constants that form the direct return value. This avoids
    # mistaking an unrelated instrumentation constant in the same function for
    # the ABI marker. A final `i32.const; end` is accepted only when that `end`
    # is the last instruction in the function.
    local version disassembly_status=0
    version="$(
        WASM_ARTIFACT_ABI_FUNC_INDEX="$func_index" \
        _wasm_stream_awk '
            function function_index(token, value) {
                if (token !~ /^func\[[0-9]+\]:?$/) return ""
                value = token
                sub(/^func\[/, "", value)
                sub(/\]:?$/, "", value)
                return value
            }
            function record(value) {
                if (candidate_count == 0) version = value
                else if (version != value) ambiguous = 1
                candidate_count++
            }
            function finish_target() {
                if (in_target && end_candidate != "") record(end_candidate)
            }
            BEGIN {
                target = ENVIRON["WASM_ARTIFACT_ABI_FUNC_INDEX"]
            }
            {
                index_value = function_index($2)
                if (index_value != "") {
                    finish_target()
                    in_target = (index_value == target)
                    pending = ""
                    end_candidate = ""
                    next
                }
                if (!in_target) next

                instruction = $0
                if (!sub(/^.*\|[[:space:]]*/, "", instruction)) next
                if (instruction ~ /^i32\.const[[:space:]]+-?[0-9]+$/) {
                    pending = instruction
                    sub(/^i32\.const[[:space:]]+/, "", pending)
                    end_candidate = ""
                    next
                }
                if (pending != "") {
                    if (instruction == "return") record(pending)
                    else if (instruction == "end") end_candidate = pending
                    pending = ""
                    next
                }

                # Any instruction after a possible `const; end` means that end
                # closed a nested block rather than the function body.
                end_candidate = ""
            }
            END {
                finish_target()
                if (candidate_count > 0 && !ambiguous) print version
                else exit 1
            }
        ' wasm-objdump -d "$path"
    )" || disassembly_status=$?
    if [ "$disassembly_status" -eq 0 ] && [ -n "$version" ]; then
        printf '%s\n' "$version"
        return 0
    fi

    # WABT 1.0.37 can read the export section of current LLVM output but may
    # fail later while disassembling modern exception-reference instructions.
    # Binaryen handles those modules. Its text format retains the export-to-
    # function mapping, so follow that mapped identifier rather than looking
    # for a function whose debug name happens to match the export.
    command -v wasm-dis >/dev/null 2>&1 || return 1
    disassembly_status=0
    version="$(_wasm_stream_awk '
        function trim(value) {
            sub(/^[[:space:]]+/, "", value)
            sub(/[[:space:]]+$/, "", value)
            return value
        }
        function paren_delta(value, opens, closes) {
            opens = value
            closes = value
            return gsub(/\(/, "", opens) - gsub(/\)/, "", closes)
        }
        function constant_value(value) {
            sub(/^.*\(i32\.const[[:space:]]+/, "", value)
            sub(/\).*$/, "", value)
            return value
        }
        function record(value) {
            if (candidate_count == 0) version = value
            else if (version != value) ambiguous = 1
            candidate_count++
        }
        {
            text = trim($0)

            if (index(text, "(export \"__abi_version\" (func $") == 1) {
                target = text
                sub(/^.*\(func /, "", target)
                sub(/\)\).*$/, "", target)
                next
            }

            if (!in_target && target != "" &&
                index(text, "(func " target) == 1 &&
                substr(text, length("(func " target) + 1, 1) ~ /[[:space:])]/) {
                in_target = 1
                depth = paren_delta(text)
                next
            }
            if (!in_target) next

            depth_before = depth
            if (depth_before == 1 && text ~ /^\(i32\.const[[:space:]]+-?[0-9]+\)$/) {
                record(constant_value(text))
            } else if (depth_before == 1 &&
                       text ~ /^\(return[[:space:]]+\(i32\.const[[:space:]]+-?[0-9]+\)\)$/) {
                record(constant_value(text))
            } else if (depth_before == 1 && text == "(return") {
                return_depth = depth_before + 1
            } else if (return_depth != 0 && depth_before == return_depth &&
                       text ~ /^\(i32\.const[[:space:]]+-?[0-9]+\)$/) {
                record(constant_value(text))
            }

            depth += paren_delta(text)
            if (return_depth != 0 && depth < return_depth) return_depth = 0
            if (depth == 0) in_target = 0
        }
        END {
            if (candidate_count > 0 && !ambiguous) print version
            else exit 1
        }
    ' wasm-dis "$path" -o -)" || disassembly_status=$?
    [ "$disassembly_status" -eq 0 ] && [ -n "$version" ] || return 1
    printf '%s\n' "$version"
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
