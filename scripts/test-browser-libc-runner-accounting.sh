#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

missing=()
[ -f "$REPO_ROOT/sysroot/lib/libc.a" ] || missing+=("sysroot/lib/libc.a")
"$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm >/dev/null 2>&1 || missing+=("kernel.wasm")
[ -d "$REPO_ROOT/tests/libc/libc-test/src/functional" ] || missing+=("tests/libc/libc-test")
[ -x "$REPO_ROOT/tools/bin/wasm-fork-instrument" ] || missing+=("tools/bin/wasm-fork-instrument")

if [ "${#missing[@]}" -gt 0 ]; then
    echo "SKIP: missing browser libc runner accounting prerequisites: ${missing[*]}" >&2
    exit 77
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

cat > "$tmpdir/npx" <<'SH'
#!/usr/bin/env bash
echo "Error: Vite startup error: simulated runner startup failure" >&2
exit 1
SH
chmod +x "$tmpdir/npx"

set +e
PATH="$tmpdir:$PATH" bash scripts/run-browser-libc-tests.sh functional snprintf > "$tmpdir/output.log" 2>&1
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
    echo "FAIL: browser libc wrapper returned success after simulated runner startup failure" >&2
    cat "$tmpdir/output.log" >&2
    exit 1
fi

grep -F "ERROR functional/snprintf: browser runner exited with status 1 before reporting result" "$tmpdir/output.log" >/dev/null || {
    echo "FAIL: missing per-test ERROR for unreported selected test" >&2
    cat "$tmpdir/output.log" >&2
    exit 1
}

grep -F "ERROR:   1" "$tmpdir/output.log" >/dev/null || {
    echo "FAIL: summary did not count the missing test as ERROR" >&2
    cat "$tmpdir/output.log" >&2
    exit 1
}

grep -F "TOTAL:   1" "$tmpdir/output.log" >/dev/null || {
    echo "FAIL: summary did not preserve selected-test TOTAL" >&2
    cat "$tmpdir/output.log" >&2
    exit 1
}

echo "PASS: browser libc wrapper fails when the runner reports no selected-test results"
