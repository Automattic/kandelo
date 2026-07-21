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

_wasm_objdump_abi_export_function_index() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2
    command -v wasm-objdump >/dev/null 2>&1 || return 2

    # Keep the structural decoder's potentially large output in a pipe. Ruby's
    # 20 MiB executable produces more than 16 MiB of `wasm-objdump -x` text,
    # while the only evidence needed here is one export mapping and the exact
    # signature assigned to that function.
    _wasm_stream_awk '
        /^ - type\[[0-9]+\] / {
            type_index = $0
            sub(/^ - type\[/, "", type_index)
            sub(/\].*$/, "", type_index)
            signature = $0
            sub(/^ - type\[[0-9]+\] /, "", signature)
            type_signatures[type_index] = signature
        }
        /^ - func\[[0-9]+\] sig=[0-9]+/ {
            function_index = $0
            sub(/^ - func\[/, "", function_index)
            sub(/\].*$/, "", function_index)
            signature_index = $0
            sub(/^.* sig=/, "", signature_index)
            sub(/[^0-9].*$/, "", signature_index)
            function_signatures[function_index] = signature_index
        }
        / -> "__abi_version"$/ {
            named_exports++
            if ($0 ~ /^ - func\[[0-9]+\].* -> "__abi_version"$/) {
                mapped_exports++
                target = $0
                sub(/^ - func\[/, "", target)
                sub(/\].*$/, "", target)
            }
        }
        END {
            if (named_exports == 0) exit 1
            if (named_exports != 1 || mapped_exports != 1) exit 3
            if (!(target in function_signatures)) exit 3
            signature_index = function_signatures[target]
            if (!(signature_index in type_signatures) ||
                type_signatures[signature_index] != "() -> i32") exit 3
            print target
        }
    ' wasm-objdump -x "$path"
}

_wasm_objdump_candidate_signatures_are_valid() {
    local path="${1:-}"
    local void_function_index="${2:-}"
    local i32_function_index="${3:-}"
    [[ "$void_function_index" =~ ^[0-9]*$ ]] || return 1
    [[ "$i32_function_index" =~ ^[0-9]*$ ]] || return 1
    [ -n "$void_function_index$i32_function_index" ] || return 1

    WASM_ARTIFACT_VOID_FUNC_INDEX="$void_function_index" \
    WASM_ARTIFACT_I32_FUNC_INDEX="$i32_function_index" \
    _wasm_stream_awk '
        /^ - type\[[0-9]+\] / {
            type_index = $0
            sub(/^ - type\[/, "", type_index)
            sub(/\].*$/, "", type_index)
            signature = $0
            sub(/^ - type\[[0-9]+\] /, "", signature)
            type_signatures[type_index] = signature
        }
        /^ - func\[[0-9]+\] sig=[0-9]+/ {
            function_index = $0
            sub(/^ - func\[/, "", function_index)
            sub(/\].*$/, "", function_index)
            signature_index = $0
            sub(/^.* sig=/, "", signature_index)
            sub(/[^0-9].*$/, "", signature_index)
            function_signatures[function_index] = signature_index
        }
        END {
            void_target = ENVIRON["WASM_ARTIFACT_VOID_FUNC_INDEX"]
            i32_target = ENVIRON["WASM_ARTIFACT_I32_FUNC_INDEX"]
            if (void_target != "") {
                if (!(void_target in function_signatures)) exit 1
                signature_index = function_signatures[void_target]
                if (!(signature_index in type_signatures) ||
                    type_signatures[signature_index] != "() -> nil") exit 1
            }
            if (i32_target != "") {
                if (!(i32_target in function_signatures)) exit 1
                signature_index = function_signatures[i32_target]
                if (!(signature_index in type_signatures) ||
                    type_signatures[signature_index] != "() -> i32") exit 1
            }
        }
    ' wasm-objdump -x "$path"
}

# Resolve body-shape evidence emitted by the numeric wasm-objdump parsers.
# Wrapper calls are accepted only when their targets have the exact signatures
# that make the recognized instruction sequence a valid ABI-returning thunk.
_wasm_resolve_objdump_abi_candidate() {
    local path="${1:-}"
    local candidate="${2:-}"
    local kind first second third extra version signature_status=0
    IFS=$'\t' read -r kind first second third extra <<< "$candidate"
    [ -z "$extra" ] || return 1

    case "$kind" in
        constant)
            [ -n "$first" ] && [ -z "$second" ] && [ -z "$third" ] || return 1
            version="$first"
            ;;
        folded)
            [ -n "$first" ] && [ -n "$second" ] && [ -z "$third" ] || return 1
            _wasm_objdump_candidate_signatures_are_valid \
                "$path" "$first" "" || signature_status=$?
            [ "$signature_status" -eq 0 ] || return "$signature_status"
            version="$second"
            ;;
        delegated)
            [ -n "$first" ] && [ -n "$second" ] && [ -n "$third" ] || return 1
            _wasm_objdump_candidate_signatures_are_valid \
                "$path" "$first" "$second" || signature_status=$?
            [ "$signature_status" -eq 0 ] || return "$signature_status"
            version="$third"
            ;;
        *)
            return 1
            ;;
    esac

    [[ "$version" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$version"
}

_wasm_extract_constant_i32_body() {
    local function_index="${1:-}"
    [[ "$function_index" =~ ^[0-9]+$ ]] || return 1

    awk -v function_index="$function_index" '
        index($0, " func[" function_index "]") && /:$/ {
            in_function = 1
            next
        }
        in_function {
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

            if (instruction_name == "end") {
                if (instruction_count == 2 && first_instruction == "i32.const") {
                    kind = "constant"
                    value = first_instruction_text
                } else if (instruction_count == 3 && first_instruction == "i32.const" &&
                           second_instruction == "return") {
                    kind = "constant"
                    value = first_instruction_text
                } else if (instruction_count == 3 && first_instruction == "call" &&
                           first_instruction_text ~ /^call[[:space:]]+[0-9]+([[:space:]]|$)/ &&
                           second_instruction == "i32.const") {
                    kind = "folded"
                    callee = first_instruction_text
                    sub(/^call[[:space:]]+/, "", callee)
                    sub(/[[:space:]].*$/, "", callee)
                    value = second_instruction_text
                } else {
                    exit 1
                }
                sub(/^i32\.const[[:space:]]+/, "", value)
                if (value !~ /^[0-9]+$/) exit 1
                if (kind == "folded") print kind "\t" callee "\t" value
                else print kind "\t" value
                exit
            }
        }
    '
}

wasm_extract_abi_version_with_binaryen() {
    local path="${1:-}"
    local function_index="${2:-}"
    command -v wasm-opt >/dev/null 2>&1 || return 2
    [[ "$function_index" =~ ^[0-9]+$ ]] || return 3

    local extracted details extracted_function_index signature_index dump candidate abi
    extracted="$(mktemp)" || return 2
    if ! wasm-opt "$path" "--extract-function-index=$function_index" -o "$extracted" 2>/dev/null; then
        rm -f "$extracted"
        return 2
    fi
    details="$(wasm-objdump -x "$extracted" 2>/dev/null)" || {
        rm -f "$extracted"
        return 2
    }
    extracted_function_index="$(
        sed -nE 's/^ - func\[([0-9]+)\].* -> ".*"$/\1/p' <<< "$details"
    )"
    [[ "$extracted_function_index" =~ ^[0-9]+$ ]] || {
        rm -f "$extracted"
        return 3
    }
    signature_index="$(
        sed -nE "s/^ - func\\[$extracted_function_index\\] sig=([0-9]+).*/\\1/p" <<< "$details"
    )"
    [[ "$signature_index" =~ ^[0-9]+$ ]] &&
        grep -Fqx " - type[$signature_index] () -> i32" <<< "$details" || {
        rm -f "$extracted"
        return 3
    }
    dump="$(wasm-objdump -d "$extracted" 2>/dev/null)" || {
        rm -f "$extracted"
        return 2
    }
    candidate="$(_wasm_extract_constant_i32_body "$extracted_function_index" <<< "$dump")" || {
        rm -f "$extracted"
        return 3
    }
    abi="$(_wasm_resolve_objdump_abi_candidate "$extracted" "$candidate")" || {
        rm -f "$extracted"
        return 3
    }
    rm -f "$extracted"
    printf '%s\n' "$abi"
}

# Print a constant ABI export and return 0. Return 1 only when a valid Wasm
# module genuinely has no optional ABI export; all inspection or semantic
# failures return a status greater than 1 so resolver predicates fail closed.
wasm_extract_abi_version() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2
    command -v wasm-objdump >/dev/null 2>&1 || return 2
    # The export name and the function's optional debug name are separate Wasm
    # concepts. SDK binaries export the internal function
    # `__wasm_posix_user_abi_version` as `__abi_version`, and stripped binaries
    # have no function names at all. Resolve the export to its numeric function
    # index first; that index is stable in `wasm-objdump` output regardless of
    # the custom name section.
    local func_index details_status=0
    func_index="$(_wasm_objdump_abi_export_function_index "$path")" || details_status=$?
    case "$details_status" in
        0) ;;
        1) return 1 ;;
        *) return "$details_status" ;;
    esac
    [[ "$func_index" =~ ^[0-9]+$ ]] || return 3

    # Accept only constants that form the direct return value. This avoids
    # mistaking an unrelated instrumentation constant in the same function for
    # the ABI marker. A final `i32.const; end` is accepted only when that `end`
    # is the last instruction in the function. wasm-ld may export a command
    # thunk that calls constructors and then delegates to the real ABI function.
    # The linker can also fold the constant implementation into that thunk,
    # producing `call; i32.const; end`. Accept that folded shape only when it is
    # the exported target; a delegating wrapper must end at a pure constant body.
    local candidate version disassembly_status=0 resolve_status=0
    candidate="$(
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
            function constant_value(value) {
                sub(/^i32\.const[[:space:]]+/, "", value)
                return value
            }
            function finish_function(first_callee, callee) {
                if (!in_function) return
                if (instruction_count == 2 && first_instruction == "i32.const" &&
                    second_instruction == "end") {
                    pure_constant_versions[current] = constant_value(first_instruction_text)
                } else if (instruction_count == 3 && first_instruction == "i32.const" &&
                           second_instruction == "return" && third_instruction == "end") {
                    pure_constant_versions[current] = constant_value(first_instruction_text)
                } else if (instruction_count == 3 && first_instruction == "call" &&
                           second_instruction == "i32.const" && third_instruction == "end" &&
                           call_index(first_instruction_text) != "") {
                    folded_wrapper_versions[current] = constant_value(second_instruction_text)
                    wrapper_leading_callees[current] = call_index(first_instruction_text)
                }
                if (instruction_count == 3 && first_instruction == "call" &&
                    second_instruction == "call" && third_instruction == "end") {
                    first_callee = call_index(first_instruction_text)
                    callee = call_index(second_instruction_text)
                    if (first_callee != "" && callee != "") {
                        wrapper_leading_callees[current] = first_callee
                        wrapper_callees[current] = callee
                    }
                }
                in_function = 0
            }
            BEGIN {
                target = ENVIRON["WASM_ARTIFACT_ABI_FUNC_INDEX"]
            }
            {
                index_value = function_index($2)
                if (index_value != "") {
                    finish_function()
                    current = index_value
                    in_function = 1
                    instruction_count = 0
                    first_instruction = ""
                    second_instruction = ""
                    third_instruction = ""
                    first_instruction_text = ""
                    second_instruction_text = ""
                    next
                }
                if (!in_function) next

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
            }
            END {
                finish_function()
                if (target in pure_constant_versions) {
                    print "constant\t" pure_constant_versions[target]
                } else if (target in folded_wrapper_versions) {
                    print "folded\t" wrapper_leading_callees[target] "\t" \
                        folded_wrapper_versions[target]
                } else if (target in wrapper_callees &&
                           wrapper_callees[target] in pure_constant_versions) {
                    print "delegated\t" wrapper_leading_callees[target] "\t" \
                        wrapper_callees[target] "\t" \
                        pure_constant_versions[wrapper_callees[target]]
                } else {
                    exit 1
                }
            }
        ' wasm-objdump -d "$path"
    )" || disassembly_status=$?
    if [ "$disassembly_status" -eq 0 ]; then
        version="$(_wasm_resolve_objdump_abi_candidate "$path" "$candidate")" || \
            resolve_status=$?
        if [ "$resolve_status" -eq 0 ]; then
            printf '%s\n' "$version"
            return 0
        fi
        # A complete structural decode with a wrong body or callee signature is
        # a semantic rejection. A later decoder failure may use the strict
        # Binaryen fallback instead of being mislabeled as malformed ABI data.
        [ "$resolve_status" -eq 1 ] && return 3
        disassembly_status="$resolve_status"
    fi
    # A successful full disassembly that does not have one of the exact
    # constant-return shapes is a semantic rejection, not a reason to try a
    # more permissive decoder.
    [ "$disassembly_status" -eq 1 ] && return 3

    # Large fork dispatchers can make full WABT disassembly fail before it
    # reaches the ABI export. Extract the mapped function into a small module
    # first; direct constant exports can then be checked with the same strict
    # body shape without materializing the full dispatcher.
    version=""
    if version="$(wasm_extract_abi_version_with_binaryen "$path" "$func_index")" &&
        [[ "$version" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$version"
        return 0
    fi

    # WABT 1.0.37 can read the export section of current LLVM output but may
    # fail later while disassembling modern exception-reference instructions.
    # Binaryen handles those modules. Its text format retains the export-to-
    # function mapping, so follow that mapped identifier rather than looking
    # for a function whose debug name happens to match the export. As above,
    # recognize only the exact delegated or constant-folded command thunks.
    command -v wasm-dis >/dev/null 2>&1 || return "$disassembly_status"
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
        function call_target(value, target) {
            if (value !~ /^\(call[[:space:]]+\$[^[:space:]()]+\)$/) return ""
            target = value
            sub(/^\(call[[:space:]]+/, "", target)
            sub(/\)$/, "", target)
            return target
        }
        function record_function_signature(declaration, start, function_declaration, name,
                                           prefix, suffix) {
            start = index(declaration, "(func $")
            if (start == 0) return
            function_declaration = substr(declaration, start)
            name = function_declaration
            sub(/^\(func[[:space:]]+/, "", name)
            sub(/[[:space:])].*$/, "", name)
            prefix = "(func " name
            if (index(function_declaration, prefix) != 1) return
            suffix = substr(function_declaration, length(prefix) + 1)
            if (suffix == "" || suffix == ")" || suffix == "))") {
                void_functions[name] = 1
            } else if (suffix == " (result i32)" || suffix == " (result i32))" ||
                       suffix == " (result i32)))") {
                i32_functions[name] = 1
            }
        }
        function finish_function(callee) {
            if (!in_function) return
            if (body_expression_count == 1 && candidate_count == 1) {
                pure_constant_versions[current] = candidate_version
            } else if (body_expression_count == 2 && first_call != "" &&
                       candidate_count == 1 && candidate_expression == 2 &&
                       candidate_is_direct) {
                folded_wrapper_versions[current] = candidate_version
                wrapper_leading_callees[current] = first_call
            }
            if (body_expression_count == 2 && first_call != "" && second_call != "") {
                wrapper_leading_callees[current] = first_call
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

            if (!in_function && index(text, "(import ") == 1) {
                record_function_signature(text)
            }

            if (!in_function && text ~ /^\(func[[:space:]]+\$[^[:space:]()]+/) {
                current = text
                sub(/^\(func[[:space:]]+/, "", current)
                sub(/[[:space:])].*$/, "", current)
                record_function_signature(text)
                in_function = 1
                depth = paren_delta(text)
                candidate_count = 0
                candidate_version = ""
                candidate_expression = 0
                candidate_is_direct = 0
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
                candidate_version = constant_value(text)
                candidate_count++
                candidate_expression = body_expression_count
                candidate_is_direct = 1
            } else if (depth_before == 1 &&
                       text ~ /^\(return[[:space:]]+\(i32\.const[[:space:]]+-?[0-9]+\)\)$/) {
                candidate_version = constant_value(text)
                candidate_count++
                candidate_expression = body_expression_count
                candidate_is_direct = 0
            } else if (depth_before == 1 && text == "(return") {
                return_depth = depth_before + 1
            } else if (return_depth != 0 && depth_before == return_depth &&
                       text ~ /^\(i32\.const[[:space:]]+-?[0-9]+\)$/) {
                candidate_version = constant_value(text)
                candidate_count++
                candidate_expression = body_expression_count
                candidate_is_direct = 0
            }

            depth += paren_delta(text)
            if (return_depth != 0 && depth < return_depth) return_depth = 0
            if (depth == 0) finish_function()
        }
        END {
            finish_function()
            if (target in i32_functions && target in pure_constant_versions) {
                print pure_constant_versions[target]
            } else if (target in i32_functions && target in folded_wrapper_versions &&
                       wrapper_leading_callees[target] in void_functions) {
                print folded_wrapper_versions[target]
            } else if (target in i32_functions && target in wrapper_callees &&
                       wrapper_leading_callees[target] in void_functions &&
                       wrapper_callees[target] in i32_functions &&
                       wrapper_callees[target] in pure_constant_versions) {
                print pure_constant_versions[wrapper_callees[target]]
            } else {
                exit 1
            }
        }
    ' wasm-dis "$path" -o -)" || disassembly_status=$?
    if [ "$disassembly_status" -eq 0 ] && [[ "$version" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$version"
        return 0
    fi
    [ "$disassembly_status" -le 1 ] && return 3
    return "$disassembly_status"
}

wasm_has_stale_abi() {
    local path="${1:-}"
    local current_abi="${2:-}"
    [ -n "$current_abi" ] || return 1

    local artifact_abi extract_status=0
    artifact_abi="$(wasm_extract_abi_version "$path")" || extract_status=$?
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

# Inspect the complete fork-instrumentation contract with one structural
# decoder pass. Large programs such as Ruby produce tens of megabytes of
# `wasm-objdump -x` output; decoding that output once also keeps a transient
# decoder failure from being misreported as one arbitrarily missing export.
#
# Output fields are, in order:
#   relocatable, imports kernel.kernel_fork, unwind begin/end,
#   rewind begin/end, and state export.
_wasm_fork_contract_inventory() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    command -v wasm-objdump >/dev/null 2>&1 || return 2

    _wasm_stream_awk '
        /name: "(linking|reloc\.)/ { relocatable = 1 }
        /<- kernel\.kernel_fork/ { imports_fork = 1 }
        /-> "wpk_fork_unwind_begin"/ { unwind_begin = 1 }
        /-> "wpk_fork_unwind_end"/ { unwind_end = 1 }
        /-> "wpk_fork_rewind_begin"/ { rewind_begin = 1 }
        /-> "wpk_fork_rewind_end"/ { rewind_end = 1 }
        /-> "wpk_fork_state"/ { state = 1 }
        END {
            printf "%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
                relocatable + 0, imports_fork + 0,
                unwind_begin + 0, unwind_end + 0,
                rewind_begin + 0, rewind_end + 0, state + 0
        }
    ' wasm-objdump -x "$path"
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
    # Raw bytes cannot distinguish an export name from an unrelated data
    # segment. Export completeness is a security/provenance predicate, so a
    # missing structural decoder is unsafe rather than evidence of presence.
    return 2
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
        case "$export_status" in
            0) ;;
            1) return 0 ;;
            *) return 0 ;; # Decoder failure: classify as unsafe/missing.
        esac
    done
    return 1
}

wasm_require_exports() {
    local path="${1:-}"
    shift || true
    local missing=()
    local name export_status decoder_failed=0
    for name in "$@"; do
        export_status=0
        wasm_has_export "$path" "$name" || export_status=$?
        case "$export_status" in
            0) ;;
            1) missing+=("$name") ;;
            *) decoder_failed=1 ;;
        esac
    done
    if [ "$decoder_failed" -eq 1 ]; then
        echo "ERROR: unable to inspect required wasm exports: $path" >&2
        return 1
    fi
    if [ ${#missing[@]} -gt 0 ]; then
        echo "ERROR: refusing wasm artifact missing required exports: $path" >&2
        printf '       missing: %s\n' "${missing[*]}" >&2
        return 1
    fi
}

wasm_has_complete_fork_instrumentation() {
    local path="${1:-}"
    local inventory inventory_status=0
    local relocatable imports_fork unwind_begin unwind_end rewind_begin rewind_end state extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    [ "$inventory_status" -eq 0 ] || return "$inventory_status"
    IFS=$'\t' read -r relocatable imports_fork unwind_begin unwind_end \
        rewind_begin rewind_end state extra <<< "$inventory"
    [ -z "$extra" ] || return 2
    [ "$unwind_begin$unwind_end$rewind_begin$rewind_end$state" = 11111 ]
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

wasm_memory_arch() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    command -v wasm-objdump >/dev/null 2>&1 || return 2
    _wasm_stream_awk '
        / - memory\[[0-9]+\] pages:/ {
            count += 1
            arch = ($0 ~ / i64( |$)/) ? "wasm64" : "wasm32"
        }
        END {
            if (count != 1) exit 2
            print arch
        }
    ' wasm-objdump -x "$path"
}

wasm_has_any_wpk_fork_export() {
    local path="${1:-}"
    local inventory inventory_status=0
    local relocatable imports_fork unwind_begin unwind_end rewind_begin rewind_end state extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    case "$inventory_status" in
        0) ;;
        1) return 1 ;;
        *) return 0 ;; # Decoder failure: classify as unsafe/present.
    esac
    IFS=$'\t' read -r relocatable imports_fork unwind_begin unwind_end \
        rewind_begin rewind_end state extra <<< "$inventory"
    [ -z "$extra" ] || return 0
    [ "$unwind_begin$unwind_end$rewind_begin$rewind_end$state" != 00000 ]
}

wasm_has_missing_fork_instrumentation() {
    local path="${1:-}"
    local inventory inventory_status=0
    local relocatable imports_fork unwind_begin unwind_end rewind_begin rewind_end state extra
    wasm_is_binary "$path" || return 1

    if ! command -v wasm-objdump >/dev/null 2>&1; then
        case "$path" in
            *.o) return 1 ;;
            *) return 0 ;;
        esac
    fi

    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    [ "$inventory_status" -eq 0 ] || return 0 # Decoder failure: unsafe.
    IFS=$'\t' read -r relocatable imports_fork unwind_begin unwind_end \
        rewind_begin rewind_end state extra <<< "$inventory"
    [ -z "$extra" ] || return 0
    [ "$relocatable" = 1 ] && return 1

    local exports="$unwind_begin$unwind_end$rewind_begin$rewind_end$state"
    [ "$exports" = 11111 ] && return 1
    [ "$imports_fork" = 0 ] && [ "$exports" = 00000 ] && return 1
    return 0
}

wasm_require_fork_instrumentation_if_needed() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 0

    if ! command -v wasm-objdump >/dev/null 2>&1; then
        case "$path" in
            *.o) return 0 ;;
        esac
        echo "ERROR: unable to inspect fork instrumentation: $path" >&2
        echo "       wasm-objdump is required for structural export validation." >&2
        return 1
    fi

    local inventory inventory_status=0
    local relocatable imports_fork unwind_begin unwind_end rewind_begin rewind_end state extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    if [ "$inventory_status" -ne 0 ]; then
        echo "ERROR: unable to inspect fork instrumentation: $path" >&2
        echo "       wasm-objdump failed with status $inventory_status." >&2
        return 1
    fi
    IFS=$'\t' read -r relocatable imports_fork unwind_begin unwind_end \
        rewind_begin rewind_end state extra <<< "$inventory"
    if [ -n "$extra" ]; then
        echo "ERROR: unable to inspect fork instrumentation: $path" >&2
        echo "       wasm-objdump returned an invalid fork-contract inventory." >&2
        return 1
    fi
    [ "$relocatable" = 1 ] && return 0

    local exports="$unwind_begin$unwind_end$rewind_begin$rewind_end$state"
    [ "$exports" = 11111 ] && return 0
    [ "$imports_fork" = 0 ] && [ "$exports" = 00000 ] && return 0

    local missing=()
    [ "$unwind_begin" = 1 ] || missing+=(wpk_fork_unwind_begin)
    [ "$unwind_end" = 1 ] || missing+=(wpk_fork_unwind_end)
    [ "$rewind_begin" = 1 ] || missing+=(wpk_fork_rewind_begin)
    [ "$rewind_end" = 1 ] || missing+=(wpk_fork_rewind_end)
    [ "$state" = 1 ] || missing+=(wpk_fork_state)
    echo "ERROR: refusing wasm artifact with incomplete/missing fork instrumentation: $path" >&2
    printf '       missing: %s\n' "${missing[*]}" >&2
    echo "       Binaries that import kernel.kernel_fork must be processed with scripts/run-wasm-fork-instrument.sh." >&2
    return 1
}

wasm_require_no_fork_instrumentation() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 0
    local inventory inventory_status=0
    local relocatable imports_fork unwind_begin unwind_end rewind_begin rewind_end state extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    if [ "$inventory_status" -ne 0 ]; then
        echo "ERROR: unable to inspect fork instrumentation policy: $path" >&2
        return 1
    fi
    IFS=$'\t' read -r relocatable imports_fork unwind_begin unwind_end \
        rewind_begin rewind_end state extra <<< "$inventory"
    if [ -n "$extra" ]; then
        echo "ERROR: unable to inspect fork instrumentation policy: $path" >&2
        return 1
    fi
    if [ "$unwind_begin$unwind_end$rewind_begin$rewind_end$state" != 00000 ]; then
        echo "ERROR: refusing wasm artifact with disabled fork instrumentation policy: $path" >&2
        echo "       Rebuild it without scripts/run-wasm-fork-instrument.sh." >&2
        return 1
    fi
}
