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

_wasm_extract_abi_version_wabt() {
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
    case "$export_status" in
        0) [ -n "$func_index" ] || return 1 ;;
        1) return 1 ;;
        *) return "$export_status" ;;
    esac

    # Accept only constants that form the direct return value. This avoids
    # mistaking an unrelated instrumentation constant in the same function for
    # the ABI marker. A final `i32.const; end` is accepted only when that `end`
    # is the last instruction in the function. wasm-ld may export a command
    # thunk that calls constructors and then delegates to the real ABI function;
    # accept only that exact two-call body and apply the same constant-return
    # check to its final callee.
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
            function call_index(value, target) {
                if (value !~ /^call[[:space:]]+[0-9]+([[:space:]]|$)/) return ""
                target = value
                sub(/^call[[:space:]]+/, "", target)
                sub(/[[:space:]].*$/, "", target)
                return target
            }
            function record(value) {
                if (candidate_count == 0) candidate_version = value
                else if (candidate_version != value) ambiguous = 1
                candidate_count++
            }
            function finish_function(callee) {
                if (in_target && end_candidate != "") record(end_candidate)
                if (!in_target) return
                if (candidate_count > 0 && !ambiguous) {
                    direct_versions[current] = candidate_version
                }
                if (instruction_count == 3 && first_instruction == "call" &&
                    second_instruction == "call" && third_instruction == "end") {
                    callee = call_index(second_instruction_text)
                    if (call_index(first_instruction_text) != "" && callee != "") {
                        wrapper_callees[current] = callee
                    }
                }
            }
            BEGIN {
                target = ENVIRON["WASM_ARTIFACT_ABI_FUNC_INDEX"]
            }
            {
                index_value = function_index($2)
                if (index_value != "") {
                    finish_function()
                    current = index_value
                    in_target = 1
                    pending = ""
                    end_candidate = ""
                    candidate_count = 0
                    candidate_version = ""
                    ambiguous = 0
                    instruction_count = 0
                    first_instruction = ""
                    second_instruction = ""
                    third_instruction = ""
                    first_instruction_text = ""
                    second_instruction_text = ""
                    next
                }
                if (!in_target) next

                instruction = $0
                if (!sub(/^.*\|[[:space:]]*/, "", instruction)) next
                instruction_count++
                instruction_name = instruction
                sub(/[[:space:]].*$/, "", instruction_name)
                if (instruction_count == 1) {
                    first_instruction = instruction_name
                    first_instruction_text = instruction
                } else if (instruction_count == 2) {
                    second_instruction = instruction_name
                    second_instruction_text = instruction
                } else if (instruction_count == 3) {
                    third_instruction = instruction_name
                }
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
                finish_function()
                if (target in direct_versions) {
                    print direct_versions[target]
                } else if (target in wrapper_callees &&
                           wrapper_callees[target] in direct_versions) {
                    print direct_versions[wrapper_callees[target]]
                } else {
                    exit 1
                }
            }
        ' wasm-objdump -d "$path"
    )" || disassembly_status=$?
    if [ "$disassembly_status" -eq 0 ] && [ -n "$version" ]; then
        printf '%s\n' "$version"
        return 0
    fi
    [ "$disassembly_status" -eq 0 ] && return 1
    return "$disassembly_status"
}

_wasm_extract_abi_version_binaryen() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    # WABT 1.0.37 can read the export section of current LLVM output but may
    # fail later while disassembling modern exception-reference instructions.
    # Binaryen handles those modules. Its text format retains the export-to-
    # function mapping, so follow that mapped identifier rather than looking
    # for a function whose debug name happens to match the export. As above,
    # recognize only a two-call command thunk and inspect its final callee.
    command -v wasm-dis >/dev/null 2>&1 || return 1
    local version disassembly_status=0
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
            if (candidate_count == 0) candidate_version = value
            else if (candidate_version != value) ambiguous = 1
            candidate_count++
        }
        function call_target(value, target) {
            if (value !~ /^\(call[[:space:]]+\$[^[:space:]()]+\)$/) return ""
            target = value
            sub(/^\(call[[:space:]]+/, "", target)
            sub(/\)$/, "", target)
            return target
        }
        function finish_function(callee) {
            if (!in_function) return
            if (candidate_count > 0 && !ambiguous) {
                direct_versions[current] = candidate_version
            }
            if (body_expression_count == 2 && first_call != "" && second_call != "") {
                wrapper_callees[current] = second_call
            }
            in_function = 0
        }
        {
            text = trim($0)

            if (index(text, "(export \"__abi_version\" (func $") == 1) {
                target = text
                sub(/^.*\(func /, "", target)
                sub(/\)\).*$/, "", target)
                next
            }

            if (!in_function && text ~ /^\(func[[:space:]]+\$[^[:space:]()]+/) {
                current = text
                sub(/^\(func[[:space:]]+/, "", current)
                sub(/[[:space:])].*$/, "", current)
                in_function = 1
                depth = paren_delta(text)
                candidate_count = 0
                candidate_version = ""
                ambiguous = 0
                return_depth = 0
                body_expression_count = 0
                first_call = ""
                second_call = ""
                if (depth == 0) finish_function()
                next
            }
            if (!in_function) next

            depth_before = depth
            if (depth_before == 1 && text != ")") {
                body_expression_count++
                callee = call_target(text)
                if (body_expression_count == 1) first_call = callee
                else if (body_expression_count == 2) second_call = callee
            }
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
            if (depth == 0) finish_function()
        }
        END {
            finish_function()
            if (target in direct_versions) {
                print direct_versions[target]
            } else if (target in wrapper_callees &&
                       wrapper_callees[target] in direct_versions) {
                print direct_versions[wrapper_callees[target]]
            } else {
                exit 1
            }
        }
    ' wasm-dis "$path" -o -)" || disassembly_status=$?
    if [ "$disassembly_status" -eq 0 ] && [ -n "$version" ]; then
        printf '%s\n' "$version"
        return 0
    fi
    [ "$disassembly_status" -eq 0 ] && return 1
    return "$disassembly_status"
}

wasm_extract_abi_version() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1

    # Keep the disassembly streaming. Large package binaries (PHP is roughly
    # 37 MiB) can produce hundreds of MiB of text and must not be captured in a
    # shell variable merely to inspect one function. Prefer Binaryen here:
    # WABT 1.0.37 cannot finish disassembling LLVM 21 exception-reference code
    # after fork instrumentation, even though the module is valid in V8.
    local version extract_status=1 decoder_status=0
    if command -v wasm-dis >/dev/null 2>&1; then
        extract_status=0
        version="$(_wasm_extract_abi_version_binaryen "$path")" || extract_status=$?
        case "$extract_status" in
            0)
                [ -n "$version" ] || return 1
                printf '%s\n' "$version"
                return 0
                ;;
            1) return 1 ;;
            *) decoder_status="$extract_status" ;;
        esac
    fi

    # Binaryen is optional, and a decoder failure there does not make a module
    # uninspectable when WABT can still parse both the export and code sections.
    # A clean WABT negative is authoritative; only propagate a decoder error
    # when no available decoder completed the inspection.
    if command -v wasm-objdump >/dev/null 2>&1; then
        extract_status=0
        version="$(_wasm_extract_abi_version_wabt "$path")" || extract_status=$?
        case "$extract_status" in
            0)
                [ -n "$version" ] || return 1
                printf '%s\n' "$version"
                return 0
                ;;
            1) return 1 ;;
            *) return "$extract_status" ;;
        esac
    fi

    [ "$decoder_status" -gt 1 ] && return "$decoder_status"
    return 1
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
