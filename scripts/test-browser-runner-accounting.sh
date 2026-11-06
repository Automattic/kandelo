#!/usr/bin/env bash
# The browser conformance wrappers (scripts/run-browser-{libc,posix,sortix}-
# tests.sh) must fail, and count every selected test as an ERROR, when the
# browser runner cannot start. Why: a section whose Vite server could not
# bind its port used to print an error and vanish from the totals, and the
# run could still exit 0. A fake `npx` simulates that startup failure, so
# this needs no browser.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

missing=()
[ -f "$REPO_ROOT/sysroot/lib/libc.a" ] || missing+=("sysroot/lib/libc.a")
"$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm >/dev/null 2>&1 || missing+=("kernel.wasm")
[ -d "$REPO_ROOT/tests/libc/libc-test/src/functional" ] || missing+=("tests/libc/libc-test")
[ -d "$REPO_ROOT/tests/sortix/os-test/malloc" ] || missing+=("tests/sortix/os-test")
[ -x "$REPO_ROOT/tools/bin/wasm-fork-instrument" ] || missing+=("tools/bin/wasm-fork-instrument")

if [ "${#missing[@]}" -gt 0 ]; then
    echo "SKIP: missing browser runner accounting prerequisites: ${missing[*]}" >&2
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

# check_wrapper <label> <first-error-id> <wrapper> <args...>
check_wrapper() {
    local label="$1" first_id="$2"
    shift 2
    local log="$tmpdir/$label.log" rc
    set +e
    PATH="$tmpdir:$PATH" bash "$@" > "$log" 2>&1
    rc=$?
    set -e
    fail() { echo "FAIL ($label): $1" >&2; tail -40 "$log" >&2; exit 1; }
    [ "$rc" -ne 0 ] || fail "wrapper returned success after a simulated runner startup failure"
    grep -F "ERROR ${first_id}: browser runner exited with status 1 before reporting result" "$log" >/dev/null \
        || fail "missing per-test ERROR for an unreported test"
    local total errors
    total=$(sed -n 's/^TOTAL: *\([0-9][0-9]*\)$/\1/p' "$log" | tail -1)
    errors=$(sed -n 's/^ERROR: *\([0-9][0-9]*\)$/\1/p' "$log" | tail -1)
    [ -n "$total" ] && [ "$total" -gt 0 ] || fail "summary TOTAL is missing or zero"
    [ "$errors" = "$total" ] || fail "summary counts $errors ERRORs for $total selected tests"
    echo "PASS ($label): $errors of $total selected tests counted as ERROR; exit $rc"
}

check_wrapper libc functional/snprintf scripts/run-browser-libc-tests.sh functional snprintf
check_wrapper sortix malloc/malloc-0 scripts/run-browser-sortix-tests.sh malloc
check_wrapper posix sigpending/1-1 scripts/run-browser-posix-tests.sh sigpending
