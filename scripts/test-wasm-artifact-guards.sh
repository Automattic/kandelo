#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"

for tool in wat2wasm wasm-objdump wasm-opt; do
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

assert_extracts_abi "$work/abi.wasm" "an implicit return"

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

echo "test-wasm-artifact-guards.sh: ok"
