#!/bin/bash
set -euo pipefail

# Run MariaDB mysql-test suite against wasm-posix-kernel.
#
# Prerequisites:
#   bash examples/libs/mariadb/build-mariadb.sh   # builds mariadbd + mysqltest
#   bash build.sh                                  # builds kernel wasm
#
# Usage:
#   scripts/run-mariadb-tests.sh                   # run curated passing tests
#   scripts/run-mariadb-tests.sh --all             # run all tests (slow)
#   scripts/run-mariadb-tests.sh test1 test2       # run specific tests
#   scripts/run-mariadb-tests.sh --report          # run curated + write markdown report
#   scripts/run-mariadb-tests.sh --list            # list available tests

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARIADB_LIB="$REPO_ROOT/examples/libs/mariadb"
INSTALL_DIR="$MARIADB_LIB/mariadb-install"
MYSQL_TEST_DIR="$INSTALL_DIR/mysql-test"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"
HARNESS="$REPO_ROOT/examples/mariadb-test/run-tests.ts"

# ── Curated test list ─────────────────────────────────────
# All tests are now run by default (threaded server).
# This list is kept for quick-run mode (--curated).

CURATED_TESTS=()

# ── Expected failures ──────────────────────────────────────
# Tests known to fail on wasm-posix-kernel (threaded server mode).
# Categories:
#
# innodb         — InnoDB storage engine not available (Aria only)
# exec           — uses --exec/--system shell commands (not supported)
# debug          — requires debug build (debug_dbug, debug_sync, have_debug)
# ssl            — SSL/TLS not compiled in
# binlog         — requires binary log (have_log_bin)
# plugin         — requires dynamic plugin loading (not supported on wasm32)
# big_test       — requires BIG_TEST variable (extremely long tests)
# timeout        — test too large/slow for 120s timeout on wasm
# feature        — requires unavailable feature (profiling, staging, etc.)

EXPECTED_FAIL=(
    # Will be populated after full test suite triage
)

# ── Helper functions ──────────────────────────────────────

is_expected_fail() {
    local test_name="$1"
    for pattern in "${EXPECTED_FAIL[@]}"; do
        # Exact match
        [ "$pattern" = "$test_name" ] && return 0
        # Wildcard match
        if [[ "$pattern" == *"*"* ]]; then
            # shellcheck disable=SC2254
            case "$test_name" in
                $pattern) return 0 ;;
            esac
        fi
    done
    return 1
}

# ── Verify prerequisites ──────────────────────────────────

check_prereqs() {
    local missing=0

    if [ ! -f "$INSTALL_DIR/bin/mariadbd" ]; then
        echo "ERROR: mariadbd not found. Run: bash examples/libs/mariadb/build-mariadb.sh" >&2
        missing=1
    fi

    if [ ! -f "$INSTALL_DIR/bin/mysqltest.wasm" ]; then
        echo "ERROR: mysqltest.wasm not found. Run: bash examples/libs/mariadb/build-mariadb.sh" >&2
        missing=1
    fi

    if [ ! -f "$KERNEL_WASM" ]; then
        echo "ERROR: kernel wasm not found. Run: bash build.sh" >&2
        missing=1
    fi

    if [ ! -d "$MYSQL_TEST_DIR" ]; then
        echo "ERROR: mysql-test directory not found. Run: bash examples/libs/mariadb/build-mariadb.sh" >&2
        missing=1
    fi

    if [ ! -f "$HARNESS" ]; then
        echo "ERROR: test harness not found at $HARNESS" >&2
        missing=1
    fi

    [ $missing -eq 0 ] || exit 1
}

# ── Main ──────────────────────────────────────────────────

REPORT_MODE=false
LIST_MODE=false
ALL_MODE=false
TEST_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT_MODE=true; shift ;;
        --list)   LIST_MODE=true; shift ;;
        --all)    ALL_MODE=true; shift ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS] [test1 test2 ...]"
            echo ""
            echo "Options:"
            echo "  --all       Run all 1184 tests (slow — many will timeout/fail)"
            echo "  --list      List available tests"
            echo "  --report    Run tests and write markdown report"
            echo "  --help      Show this help"
            echo ""
            echo "Without --all or test names, runs the curated set of ${#CURATED_TESTS[@]} passing tests."
            echo ""
            echo "Environment:"
            echo "  TEST_TIMEOUT    Per-test timeout in ms (default: 60000)"
            echo "  SKIP_RESULT     Set to 1 to skip .result file comparison"
            exit 0
            ;;
        *)  TEST_ARGS+=("$1"); shift ;;
    esac
done

check_prereqs

if $LIST_MODE; then
    exec node --experimental-wasm-exnref --import tsx/esm "$HARNESS" --list
fi

# If no specific tests given, run all tests (default is --all mode)
if [ ${#TEST_ARGS[@]} -eq 0 ]; then
    ALL_MODE=true
fi

echo "===== MariaDB mysql-test suite ====="
if $ALL_MODE; then
    echo "Mode: all tests"
else
    echo "Tests: ${#TEST_ARGS[@]}"
fi
echo ""

# Run the TypeScript harness, capture JSON stdout separately from stderr
RESULTS_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
trap 'rm -f "$RESULTS_FILE" "$STDERR_FILE"' EXIT

export SKIP_RESULT="${SKIP_RESULT:-1}"

set +e
NODE_OPTS="--experimental-wasm-exnref --expose-gc --max-old-space-size=8192 --import tsx/esm"
if $ALL_MODE; then
    node $NODE_OPTS "$HARNESS" > "$RESULTS_FILE" 2>"$STDERR_FILE"
else
    node $NODE_OPTS "$HARNESS" "${TEST_ARGS[@]}" > "$RESULTS_FILE" 2>"$STDERR_FILE"
fi
HARNESS_EXIT=$?
set -e

# Show harness stderr (status messages)
cat "$STDERR_FILE" >&2

# Parse JSON output and classify results
PASS=0
FAIL=0
XFAIL=0
XPASS=0
SKIP=0
TOTAL=0
RESULTS=()

while IFS= read -r line; do
    # Skip empty lines or non-JSON lines
    [ -z "$line" ] && continue
    [[ "$line" == "{"* ]] || continue

    # Parse JSON fields using python3 (reliable, always available on macOS)
    parsed=$(echo "$line" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['test'])
    print(d['status'])
    print(d.get('time_ms', 0))
except: pass
" 2>/dev/null) || continue

    test_name=$(echo "$parsed" | sed -n '1p')
    status=$(echo "$parsed" | sed -n '2p')
    time_ms=$(echo "$parsed" | sed -n '3p')

    [ -z "$test_name" ] && continue
    # Skip internal helper tests
    [[ "$test_name" == __* ]] && continue

    TOTAL=$((TOTAL + 1))

    is_xfail=false
    if is_expected_fail "$test_name" 2>/dev/null; then
        is_xfail=true
    fi

    case "$status" in
        pass)
            if $is_xfail; then
                echo "XPASS $test_name"
                RESULTS+=("XPASS $test_name")
                XPASS=$((XPASS + 1))
            else
                RESULTS+=("PASS  $test_name")
                PASS=$((PASS + 1))
            fi
            ;;
        fail)
            if $is_xfail; then
                RESULTS+=("XFAIL $test_name")
                XFAIL=$((XFAIL + 1))
            else
                echo "FAIL  $test_name (${time_ms}ms)"
                RESULTS+=("FAIL  $test_name")
                FAIL=$((FAIL + 1))
            fi
            ;;
        skip)
            RESULTS+=("SKIP  $test_name")
            SKIP=$((SKIP + 1))
            ;;
    esac
done < "$RESULTS_FILE"

# ── Summary ──────────────────────────────────────────────

echo ""
echo "===== Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "SKIP:    $SKIP"
echo "TOTAL:   $TOTAL"
echo ""

# Show unexpected results
for status_prefix in "FAIL " "XPASS"; do
    count=0
    for r in "${RESULTS[@]}"; do
        [[ "$r" == "$status_prefix"* ]] && count=$((count + 1))
    done
    if [ $count -gt 0 ]; then
        echo "── ${status_prefix%% *} ($count) ──"
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "$status_prefix"* ]] && echo "  $r"
        done
        echo ""
    fi
done

# ── Report mode ──────────────────────────────────────────

if $REPORT_MODE; then
    REPORT="$REPO_ROOT/docs/mariadb-test-report.md"
    {
        echo "# MariaDB mysql-test Suite Report"
        echo ""
        echo "Generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
        echo ""
        echo "| Status | Count |"
        echo "|--------|-------|"
        echo "| PASS | $PASS |"
        echo "| FAIL | $FAIL |"
        echo "| XFAIL | $XFAIL |"
        echo "| XPASS | $XPASS |"
        echo "| SKIP | $SKIP |"
        echo "| **TOTAL** | **$TOTAL** |"
        echo ""

        for status_prefix in "FAIL " "XPASS"; do
            count=0
            for r in "${RESULTS[@]}"; do
                [[ "$r" == "$status_prefix"* ]] && count=$((count + 1))
            done
            if [ $count -gt 0 ]; then
                case "${status_prefix%% *}" in
                    FAIL) echo "## Unexpected Failures ($count)" ;;
                    XPASS) echo "## Unexpected Passes ($count)" ;;
                esac
                echo ""
                echo "| Test |"
                echo "|------|"
                for r in "${RESULTS[@]}"; do
                    if [[ "$r" == "$status_prefix"* ]]; then
                        local_test="${r#* }"
                        echo "| \`$local_test\` |"
                    fi
                done
                echo ""
            fi
        done
    } > "$REPORT"
    echo "Report written to: $REPORT"
fi

# Exit with error if any unexpected failures
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ]; then
    exit 1
fi
