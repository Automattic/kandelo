#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"

for tool in wat2wasm wasm-objdump wasm-opt wasm-dis; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required test tool is unavailable: $tool" >&2
        exit 1
    fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat >"$work/abi.wat" <<'WAT'
(module
  (func $internal_abi_name (export "__abi_version") (result i32)
    i32.const 18))
WAT
wat2wasm --debug-names "$work/abi.wat" -o "$work/abi.wasm"

real_objdump="$(command -v wasm-objdump)"
mkdir "$work/bin"
cat >"$work/bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-d" ] && [ "${2:-}" = "${FAIL_WASM_OBJDUMP_PATH:-}" ]; then
    exit 1
fi
exec "$REAL_WASM_OBJDUMP" "$@"
SH
chmod +x "$work/bin/wasm-objdump"

assert_extracts_abi() {
    local path="$1"
    local description="$2"
    local actual

    actual="$(wasm_extract_abi_version "$path")"
    [ "$actual" = 18 ] || {
        echo "ERROR: primary ABI extraction returned $actual for $description" >&2
        exit 1
    }
    actual="$(
        PATH="$work/bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" FAIL_WASM_OBJDUMP_PATH="$path" \
            wasm_extract_abi_version "$path"
    )"
    [ "$actual" = 18 ] || {
        echo "ERROR: Binaryen ABI extraction returned $actual for $description" >&2
        exit 1
    }
}

assert_rejects_abi() {
    local path="$1"
    local description="$2"

    if wasm_extract_abi_version "$path" >/dev/null 2>&1; then
        echo "ERROR: primary ABI extraction accepted $description" >&2
        exit 1
    fi
    if PATH="$work/bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" FAIL_WASM_OBJDUMP_PATH="$path" \
        wasm_extract_abi_version "$path" >/dev/null 2>&1; then
        echo "ERROR: Binaryen ABI extraction accepted $description" >&2
        exit 1
    fi
}

assert_classifies_unsafe_abi() {
    local path="$1"
    local description="$2"
    local extract_status=0

    wasm_extract_abi_version "$path" >/dev/null 2>&1 || extract_status=$?
    [ "$extract_status" -gt 1 ] || {
        echo "ERROR: ABI extraction classified $description as an absent export (status $extract_status)" >&2
        exit 1
    }
    if ! wasm_has_stale_abi "$path" 18; then
        echo "ERROR: stale-ABI predicate accepted $description" >&2
        exit 1
    fi

    extract_status=0
    PATH="$work/bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" FAIL_WASM_OBJDUMP_PATH="$path" \
        wasm_extract_abi_version "$path" >/dev/null 2>&1 || extract_status=$?
    [ "$extract_status" -gt 1 ] || {
        echo "ERROR: fallback ABI extraction classified $description as absent (status $extract_status)" >&2
        exit 1
    }
    if ! PATH="$work/bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" FAIL_WASM_OBJDUMP_PATH="$path" \
        wasm_has_stale_abi "$path" 18; then
        echo "ERROR: stale-ABI predicate accepted $description after the primary decoder failed" >&2
        exit 1
    fi
}

assert_extracts_abi "$work/abi.wasm" "an implicit return"

cat >"$work/folded-command-wrapper-abi.wat" <<'WAT'
(module
  (func $__wasm_call_ctors)
  (func $__wasm_posix_user_abi_version.command_export
      (export "__abi_version") (result i32)
    call $__wasm_call_ctors
    i32.const 18))
WAT
wat2wasm --debug-names "$work/folded-command-wrapper-abi.wat" \
    -o "$work/folded-command-wrapper-abi.wasm"
assert_extracts_abi \
    "$work/folded-command-wrapper-abi.wasm" \
    "a constant-folded wasm-ld command wrapper"

cat >"$work/malformed-folded-leading-signature-abi.wat" <<'WAT'
(module
  (func $unexpected_result (result i32)
    i32.const 7)
  (func (export "__abi_version") (result i32)
    call $unexpected_result
    i32.const 18))
WAT
wat2wasm --no-check --debug-names "$work/malformed-folded-leading-signature-abi.wat" \
    -o "$work/malformed-folded-leading-signature-abi.wasm"
assert_rejects_abi \
    "$work/malformed-folded-leading-signature-abi.wasm" \
    "a folded wrapper whose leading callee is not () -> ()"
assert_classifies_unsafe_abi \
    "$work/malformed-folded-leading-signature-abi.wasm" \
    "a malformed folded wrapper signature"

cat >"$work/malformed-delegated-leading-signature-abi.wat" <<'WAT'
(module
  (func $unexpected_result (result i32)
    i32.const 7)
  (func $constant_abi (result i32)
    i32.const 18)
  (func (export "__abi_version") (result i32)
    call $unexpected_result
    call $constant_abi))
WAT
wat2wasm --no-check --debug-names "$work/malformed-delegated-leading-signature-abi.wat" \
    -o "$work/malformed-delegated-leading-signature-abi.wasm"
assert_rejects_abi \
    "$work/malformed-delegated-leading-signature-abi.wasm" \
    "a delegated wrapper whose leading callee is not () -> ()"
assert_classifies_unsafe_abi \
    "$work/malformed-delegated-leading-signature-abi.wasm" \
    "a malformed delegated leading signature"

cat >"$work/malformed-delegated-abi-signature.wat" <<'WAT'
(module
  (func $initializer)
  (func $wrong_result (result i64)
    i32.const 18)
  (func (export "__abi_version") (result i32)
    call $initializer
    call $wrong_result))
WAT
wat2wasm --no-check --debug-names "$work/malformed-delegated-abi-signature.wat" \
    -o "$work/malformed-delegated-abi-signature.wasm"
assert_rejects_abi \
    "$work/malformed-delegated-abi-signature.wasm" \
    "a delegated constant callee that is not () -> i32"
assert_classifies_unsafe_abi \
    "$work/malformed-delegated-abi-signature.wasm" \
    "a malformed delegated ABI signature"

cat >"$work/nested-folded-command-wrapper-abi.wat" <<'WAT'
(module
  (func $__wasm_call_ctors)
  (func $__wasm_posix_user_abi_version.folded (result i32)
    call $__wasm_call_ctors
    i32.const 18)
  (func $__wasm_posix_user_abi_version.command_export
      (export "__abi_version") (result i32)
    call $__wasm_call_ctors
    call $__wasm_posix_user_abi_version.folded))
WAT
wat2wasm --debug-names "$work/nested-folded-command-wrapper-abi.wat" \
    -o "$work/nested-folded-command-wrapper-abi.wasm"
assert_rejects_abi \
    "$work/nested-folded-command-wrapper-abi.wasm" \
    "a delegating wrapper that targets another folded wrapper"

cat >"$work/explicit-return-abi.wat" <<'WAT'
(module
  (func $internal_abi_name (export "__abi_version") (result i32)
    i32.const 18
    return))
WAT
wat2wasm --debug-names "$work/explicit-return-abi.wat" -o "$work/explicit-return-abi.wasm"
assert_extracts_abi "$work/explicit-return-abi.wasm" "an explicit return"

cat >"$work/dynamic-abi.wat" <<'WAT'
(module
  (global $abi i32 (i32.const 18))
  (func (export "__abi_version") (result i32)
    i32.const 18
    drop
    global.get $abi))
WAT
wat2wasm "$work/dynamic-abi.wat" -o "$work/dynamic-abi.wasm"
assert_rejects_abi "$work/dynamic-abi.wasm" "a nonconstant export"

cat >"$work/conditional-dynamic-abi.wat" <<'WAT'
(module
  (global $choose i32 (i32.const 0))
  (global $abi i32 (i32.const 19))
  (func (export "_start"))
  (func (export "__abi_version") (result i32)
    global.get $choose
    if
      i32.const 18
      return
    end
    global.get $abi))
WAT
wat2wasm "$work/conditional-dynamic-abi.wat" -o "$work/conditional-dynamic-abi.wasm"
assert_rejects_abi "$work/conditional-dynamic-abi.wasm" "a conditionally constant export"
assert_classifies_unsafe_abi "$work/conditional-dynamic-abi.wasm" "a conditionally computed ABI export"
if wasm_has_missing_exports "$work/conditional-dynamic-abi.wasm" __abi_version _start; then
    echo "ERROR: resolver-shaped fixture is missing its required exports" >&2
    exit 1
fi
if wasm_has_missing_fork_instrumentation "$work/conditional-dynamic-abi.wasm"; then
    echo "ERROR: resolver-shaped fixture unexpectedly requires fork instrumentation" >&2
    exit 1
fi

cat >"$work/multiple-constant-abi.wat" <<'WAT'
(module
  (func (export "__abi_version") (result i32)
    i32.const 18
    i32.const 19
    drop))
WAT
wat2wasm "$work/multiple-constant-abi.wat" -o "$work/multiple-constant-abi.wasm"
assert_rejects_abi "$work/multiple-constant-abi.wasm" "multiple constants"

cat >"$work/argument-abi.wat" <<'WAT'
(module
  (func (export "__abi_version") (param i32) (result i32)
    i32.const 18))
WAT
wat2wasm "$work/argument-abi.wat" -o "$work/argument-abi.wasm"
assert_rejects_abi "$work/argument-abi.wasm" "an argument-bearing export"
assert_classifies_unsafe_abi "$work/argument-abi.wasm" "an argument-bearing ABI export"

cat >"$work/no-abi.wat" <<'WAT'
(module
  (func (export "_start")))
WAT
wat2wasm "$work/no-abi.wat" -o "$work/no-abi.wasm"
no_abi_status=0
wasm_extract_abi_version "$work/no-abi.wasm" >/dev/null 2>&1 || no_abi_status=$?
[ "$no_abi_status" -eq 1 ] || {
    echo "ERROR: absent optional ABI export returned status $no_abi_status instead of 1" >&2
    exit 1
}
if wasm_has_stale_abi "$work/no-abi.wasm" 18; then
    echo "ERROR: stale-ABI predicate rejected a genuinely absent optional ABI export" >&2
    exit 1
fi

# The bottle inspector limits each validator child to 16 MiB of regular-file
# output. Large programs such as Ruby legitimately produce more structural
# decoder text than that, so ABI validation must consume it as a stream rather
# than asking Bash to materialize it as a here-string temporary file.
mkdir "$work/inflated-details-bin"
cat >"$work/inflated-details-bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-x" ]; then
    awk 'BEGIN {
        line = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        for (i = 0; i < 265000; i++) print line
    }'
fi
exec "$REAL_WASM_OBJDUMP" "$@"
SH
chmod +x "$work/inflated-details-bin/wasm-objdump"
inflated_details_bytes="$(
    PATH="$work/inflated-details-bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" \
        wasm-objdump -x "$work/abi.wasm" | wc -c | tr -d ' '
)"
[ "$inflated_details_bytes" -gt $((16 * 1024 * 1024)) ] || {
    echo "ERROR: large ABI fixture did not cross the inspector's 16 MiB boundary" >&2
    exit 1
}

cat >"$work/validated-abi.wat" <<'WAT'
(module
  (memory (export "memory") 1)
  (func (export "__abi_version") (result i32)
    i32.const 18))
WAT
wat2wasm "$work/validated-abi.wat" -o "$work/validated-abi.wasm"

python3 - \
    "$REPO_ROOT/scripts/wasm-artifact-guards.sh" \
    "$REPO_ROOT/scripts/homebrew-validate-wasm-executable.sh" \
    "$work/abi.wasm" \
    "$work/no-abi.wasm" \
    "$work/argument-abi.wasm" \
    "$work/validated-abi.wasm" \
    "$work/inflated-details-bin" \
    "$real_objdump" <<'PY'
import os
import resource
import subprocess
import sys

(
    guards,
    validator,
    valid_abi,
    missing_abi,
    malformed_abi,
    validated_abi,
    inflated_bin,
    real_objdump,
) = sys.argv[1:]
limit = 16 * 1024 * 1024
environment = os.environ.copy()
environment["PATH"] = f"{inflated_bin}:{environment['PATH']}"
environment["REAL_WASM_OBJDUMP"] = real_objdump


def set_file_limit() -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))


def extract(path: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"\nshift\nwasm_extract_abi_version "$1"',
            "_",
            guards,
            path,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        preexec_fn=set_file_limit,
    )


valid = extract(valid_abi)
if valid.returncode != 0 or valid.stdout.strip() != "18":
    raise SystemExit(
        f"large streamed ABI extraction failed ({valid.returncode}): {valid.stderr}"
    )

missing = extract(missing_abi)
if missing.returncode != 1 or missing.stdout:
    raise SystemExit(
        "large streamed ABI extraction did not report an absent export truthfully: "
        f"status={missing.returncode} stdout={missing.stdout!r} stderr={missing.stderr!r}"
    )

malformed = extract(malformed_abi)
if malformed.returncode <= 1 or malformed.stdout:
    raise SystemExit(
        "large streamed ABI extraction did not classify a malformed export as unsafe: "
        f"status={malformed.returncode} stdout={malformed.stdout!r} "
        f"stderr={malformed.stderr!r}"
    )

validated = subprocess.run(
    ["bash", validator, validated_abi, "18", "wasm32"],
    check=False,
    capture_output=True,
    text=True,
    env=environment,
    preexec_fn=set_file_limit,
)
if validated.returncode != 0 or validated.stdout.strip() != "not-required":
    raise SystemExit(
        f"large streamed Wasm validation failed ({validated.returncode}): "
        f"{validated.stderr}"
    )
PY

cat >"$work/complete-fork.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\04\08\03\00\20\00\00\00\18\00\00\00\10\00\00\00")
  (import "kernel" "kernel_fork" (func $kernel_fork))
  (import "env" "__wpk_fork_frame_reserve"
    (func $frame_reserve (param i32) (result i32)))
  (import "env" "__wpk_fork_frame_commit"
    (func $frame_commit (param i32)))
  (import "env" "__wpk_fork_frame_next"
    (func $frame_next (param i32) (result i32)))
  (func (export "wpk_fork_abort_begin") (param i32))
  (func (export "wpk_fork_abort_end"))
  (func (export "wpk_fork_unwind_begin") (param i32))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin") (param i32))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state") (result i32)
    i32.const 0)
  (func (export "_start")
    call $kernel_fork))
WAT
wat2wasm --enable-annotations "$work/complete-fork.wat" -o "$work/complete-fork.wasm"
if ! wasm_has_complete_fork_instrumentation "$work/complete-fork.wasm"; then
    echo "ERROR: complete fork instrumentation was rejected" >&2
    exit 1
fi
if wasm_has_missing_fork_instrumentation "$work/complete-fork.wasm"; then
    echo "ERROR: complete fork instrumentation was classified as missing" >&2
    exit 1
fi
wasm_require_fork_instrumentation_if_needed "$work/complete-fork.wasm"

cat >"$work/partial-fork.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\04\08\03\00\20\00\00\00\18\00\00\00\10\00\00\00")
  (import "kernel" "kernel_fork" (func $kernel_fork))
  (import "env" "__wpk_fork_frame_reserve"
    (func $frame_reserve (param i32) (result i32)))
  (import "env" "__wpk_fork_frame_commit"
    (func $frame_commit (param i32)))
  (import "env" "__wpk_fork_frame_next"
    (func $frame_next (param i32) (result i32)))
  (func (export "wpk_fork_abort_begin") (param i32))
  (func (export "wpk_fork_abort_end"))
  (func (export "wpk_fork_unwind_begin") (param i32))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin") (param i32))
  (func (export "wpk_fork_rewind_end"))
  (func (export "_start")
    call $kernel_fork))
WAT
wat2wasm --enable-annotations "$work/partial-fork.wat" -o "$work/partial-fork.wasm"
partial_fork_error="$work/partial-fork.error"
if wasm_require_fork_instrumentation_if_needed \
    "$work/partial-fork.wasm" 2>"$partial_fork_error"; then
    echo "ERROR: incomplete fork instrumentation was accepted" >&2
    exit 1
fi
grep -Fqx '       missing: wpk_fork_state' "$partial_fork_error" || {
    echo "ERROR: incomplete fork instrumentation did not report its exact missing export" >&2
    cat "$partial_fork_error" >&2
    exit 1
}

# A section name is not sufficient evidence. Publication must reject a missing
# payload, malformed layout fields, or a partially installed transaction hook.
sed '/(@custom/,+1d' "$work/complete-fork.wat" >"$work/missing-fork-descriptor.wat"
wat2wasm --enable-annotations "$work/missing-fork-descriptor.wat" \
    -o "$work/missing-fork-descriptor.wasm"
if wasm_require_fork_instrumentation_if_needed \
    "$work/missing-fork-descriptor.wasm" >/dev/null 2>&1; then
    echo "ERROR: fork instrumentation without its descriptor was accepted" >&2
    exit 1
fi

sed 's/\\03\\00\\20/\\01\\00\\20/' \
    "$work/complete-fork.wat" >"$work/malformed-fork-descriptor.wat"
wat2wasm --enable-annotations "$work/malformed-fork-descriptor.wat" \
    -o "$work/malformed-fork-descriptor.wasm"
if wasm_require_fork_instrumentation_if_needed \
    "$work/malformed-fork-descriptor.wasm" >/dev/null 2>&1; then
    echo "ERROR: fork instrumentation with incomplete descriptor flags was accepted" >&2
    exit 1
fi

sed '/__wpk_fork_frame_reserve/,+1d' \
    "$work/complete-fork.wat" >"$work/missing-frame-reserve.wat"
wat2wasm --enable-annotations "$work/missing-frame-reserve.wat" \
    -o "$work/missing-frame-reserve.wasm"
missing_import_error="$work/missing-frame-reserve.error"
if wasm_require_fork_instrumentation_if_needed \
    "$work/missing-frame-reserve.wasm" 2>"$missing_import_error"; then
    echo "ERROR: fork instrumentation with a partial frame transaction was accepted" >&2
    exit 1
fi
grep -F 'env.__wpk_fork_frame_reserve' "$missing_import_error" >/dev/null || {
    echo "ERROR: partial frame transaction did not report its missing reserve hook" >&2
    cat "$missing_import_error" >&2
    exit 1
}
if ! wasm_has_any_fork_instrumentation "$work/missing-frame-reserve.wasm"; then
    echo "ERROR: partial frame transaction was mistaken for a clean input" >&2
    exit 1
fi

cat >"$work/inert-fork.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\04\08\03\00\20\00\00\00\18\00\00\00\10\00\00\00")
  (func (export "wpk_fork_abort_begin") (param i32))
  (func (export "wpk_fork_abort_end"))
  (func (export "wpk_fork_unwind_begin") (param i32))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin") (param i32))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state") (result i32)
    i32.const 0)
  (func (export "_start")))
WAT
wat2wasm --enable-annotations "$work/inert-fork.wat" -o "$work/inert-fork.wasm"
wasm_require_fork_instrumentation_if_needed "$work/inert-fork.wasm"
if wasm_require_no_fork_instrumentation "$work/inert-fork.wasm" >/dev/null 2>&1; then
    echo "ERROR: disabled fork policy accepted an inert instrumented runtime" >&2
    exit 1
fi

cat >"$work/wasm64-linked-frame-descriptor.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\08\08\03\00\38\00\00\00\20\00\00\00\10\00\00\00"))
WAT
wat2wasm --enable-annotations "$work/wasm64-linked-frame-descriptor.wat" \
    -o "$work/wasm64-linked-frame-descriptor.wasm"
[ "$(wasm_linked_frame_descriptor_pointer_width \
    "$work/wasm64-linked-frame-descriptor.wasm")" = 8 ] || {
    echo "ERROR: valid wasm64 linked-frame descriptor was rejected" >&2
    exit 1
}

mkdir "$work/counting-bin"
cat >"$work/counting-bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${1:-}" >> "$WASM_OBJDUMP_COUNT_FILE"
exec "$REAL_WASM_OBJDUMP" "$@"
SH
chmod +x "$work/counting-bin/wasm-objdump"
count_file="$work/wasm-objdump.count"
: >"$count_file"
(
    export PATH="$work/counting-bin:$PATH"
    export REAL_WASM_OBJDUMP="$real_objdump"
    export WASM_OBJDUMP_COUNT_FILE="$count_file"
    wasm_require_fork_instrumentation_if_needed "$work/complete-fork.wasm"
)
[ "$(grep -c '^-x$' "$count_file")" = 1 ] &&
    [ "$(grep -c '^-s$' "$count_file")" = 1 ] &&
    [ "$(wc -l <"$count_file" | tr -d ' ')" = 2 ] || {
    echo "ERROR: fork validation did not use one structure pass and one descriptor pass" >&2
    cat "$count_file" >&2
    exit 1
}

mkdir "$work/failing-bin"
cat >"$work/failing-bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$work/failing-bin/wasm-objdump"

decoder_path="$work/failing-bin:$PATH"
if ! PATH="$decoder_path" wasm_has_stale_abi "$work/abi.wasm" 18; then
    echo "ERROR: stale-ABI predicate accepted an artifact after decoder failure" >&2
    exit 1
fi
if ! PATH="$decoder_path" wasm_has_missing_exports "$work/abi.wasm" __abi_version; then
    echo "ERROR: missing-export predicate accepted an artifact after decoder failure" >&2
    exit 1
fi
if PATH="$decoder_path" wasm_require_exports "$work/abi.wasm" __abi_version >/dev/null 2>&1; then
    echo "ERROR: required-export guard accepted an artifact after decoder failure" >&2
    exit 1
fi
if ! PATH="$decoder_path" wasm_has_missing_fork_instrumentation "$work/abi.wasm"; then
    echo "ERROR: fork predicate accepted an artifact after decoder failure" >&2
    exit 1
fi
if PATH="$decoder_path" wasm_require_fork_instrumentation_if_needed "$work/abi.wasm" >/dev/null 2>&1; then
    echo "ERROR: fork guard accepted an artifact after decoder failure" >&2
    exit 1
fi
if PATH="$decoder_path" wasm_require_no_fork_instrumentation "$work/abi.wasm" >/dev/null 2>&1; then
    echo "ERROR: disabled-fork guard accepted an artifact after decoder failure" >&2
    exit 1
fi

cat >"$work/fake-fork-exports.wat" <<'WAT'
(module
  (import "kernel" "kernel_fork" (func $kernel_fork))
  (memory 1)
  (data (i32.const 0)
    "wpk_fork_unwind_begin wpk_fork_unwind_end wpk_fork_rewind_begin wpk_fork_rewind_end wpk_fork_state")
  (func (export "_start")
    call $kernel_fork))
WAT
wat2wasm "$work/fake-fork-exports.wat" -o "$work/fake-fork-exports.wasm"
if ! wasm_has_missing_fork_instrumentation "$work/fake-fork-exports.wasm"; then
    echo "ERROR: fork guard accepted data-segment strings as instrumentation exports" >&2
    exit 1
fi
if ! PATH=/usr/bin:/bin wasm_has_missing_fork_instrumentation "$work/fake-fork-exports.wasm"; then
    echo "ERROR: decoder-free fork predicate accepted raw export-name strings" >&2
    exit 1
fi
if PATH=/usr/bin:/bin wasm_require_fork_instrumentation_if_needed \
    "$work/fake-fork-exports.wasm" >/dev/null 2>&1; then
    echo "ERROR: decoder-free fork guard accepted raw export-name strings" >&2
    exit 1
fi

echo "test-wasm-artifact-guards.sh: ok"
