#!/usr/bin/env bash
# Run SQLite SQL test suite through sqlite3.wasm.
#
# Usage:
#   scripts/run-sqlite-tests.sh              # Run all SQL tests
#   scripts/run-sqlite-tests.sh --test NAME  # Run single test
#   scripts/run-sqlite-tests.sh --report     # Write markdown report

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQLITE3="$REPO_ROOT/examples/libs/sqlite/sqlite-install/bin/sqlite3.wasm"
TESTS_DIR="$REPO_ROOT/examples/sqlite-test/tests"

# Per-test timeout
TIMEOUT=30

# --- Parse arguments ---
FILTER=""
REPORT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --test) FILTER="$2"; shift 2 ;;
    --report) REPORT=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Prerequisites ---
if [ ! -f "$SQLITE3" ]; then
  echo "FAIL: sqlite3.wasm not found. Run: bash examples/libs/sqlite/build-sqlite.sh"
  exit 1
fi
if [ ! -f "$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm" ]; then
  echo "FAIL: kernel wasm not found. Run: bash build.sh"
  exit 1
fi

# --- Collect tests ---
TESTS=""
for f in "$TESTS_DIR"/*.sql; do
  name="$(basename "$f" .sql)"
  if [ -n "$FILTER" ] && [ "$name" != "$FILTER" ]; then
    continue
  fi
  TESTS="$TESTS $name"
done

TEST_COUNT=0
for t in $TESTS; do TEST_COUNT=$((TEST_COUNT + 1)); done

echo "=== SQLite test suite ==="
echo "Tests: $TEST_COUNT"
echo "Timeout: ${TIMEOUT}s per test"
echo ""

# --- Run tests ---
PASS=0
FAIL=0
ERROR=0
TOTAL=0

PASS_LIST=""
FAIL_LIST=""
ERROR_LIST=""

for test_name in $TESTS; do
  TOTAL=$((TOTAL + 1))
  test_file="$TESTS_DIR/${test_name}.sql"

  set +e
  OUTPUT=$(timeout "$TIMEOUT" npx tsx "$REPO_ROOT/examples/run-example.ts" "$SQLITE3" < "$test_file" 2>&1)
  EXIT_CODE=$?
  set -e

  if [ $EXIT_CODE -eq 124 ]; then
    echo "ERROR $test_name (timeout)"
    ERROR=$((ERROR + 1))
    ERROR_LIST="$ERROR_LIST $test_name"
  elif [ $EXIT_CODE -eq 0 ] && echo "$OUTPUT" | grep -q "^PASS$"; then
    # Verify no "not ok" lines
    if echo "$OUTPUT" | grep -q "^not ok"; then
      echo "FAIL  $test_name"
      FAIL=$((FAIL + 1))
      FAIL_LIST="$FAIL_LIST $test_name"
      echo "$OUTPUT" | grep "^not ok" | head -3 | while read -r line; do
        echo "      $line"
      done
    else
      echo "PASS  $test_name"
      PASS=$((PASS + 1))
      PASS_LIST="$PASS_LIST $test_name"
    fi
  else
    echo "FAIL  $test_name (exit=$EXIT_CODE)"
    FAIL=$((FAIL + 1))
    FAIL_LIST="$FAIL_LIST $test_name"
    # Show first error line
    echo "$OUTPUT" | grep -i "error\|not ok\|FAIL" | head -3 | while read -r line; do
      echo "      $line"
    done
  fi
done

# --- Summary ---
echo ""
echo "=== Summary ==="
echo "Total: $TOTAL"
echo "PASS:  $PASS"
echo "FAIL:  $FAIL"
echo "ERROR: $ERROR"

if [ -n "$FAIL_LIST" ]; then
  echo ""
  echo "Failures:"
  for t in $FAIL_LIST; do echo "  $t"; done
fi
if [ -n "$ERROR_LIST" ]; then
  echo ""
  echo "Errors:"
  for t in $ERROR_LIST; do echo "  $t"; done
fi

# --- Report ---
if [ "$REPORT" -eq 1 ]; then
  REPORT_FILE="$REPO_ROOT/docs/sqlite-test-results.md"
  {
    echo "# SQLite Test Suite Results"
    echo ""
    echo "$(date '+%Y-%m-%d')"
    echo ""
    echo "## Summary"
    echo ""
    echo "| Result | Count |"
    echo "|--------|-------|"
    echo "| PASS   | $PASS |"
    echo "| FAIL   | $FAIL |"
    echo "| ERROR  | $ERROR |"
    echo "| Total  | $TOTAL |"
    echo ""
    echo "## Test Details"
    echo ""
    echo "### Passing"
    for t in $PASS_LIST; do echo "- $t"; done
    echo ""
    echo "### Failing"
    for t in $FAIL_LIST; do echo "- $t"; done
    echo ""
    echo "### Errors"
    for t in $ERROR_LIST; do echo "- $t"; done
  } > "$REPORT_FILE"
  echo ""
  echo "Report written to: $REPORT_FILE"
fi

[ $FAIL -eq 0 ] && [ $ERROR -eq 0 ]
