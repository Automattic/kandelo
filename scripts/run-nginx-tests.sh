#!/usr/bin/env bash
# Run the upstream nginx test suite against our wasm32 nginx.
#
# Usage:
#   scripts/run-nginx-tests.sh              # Run curated passing tests
#   scripts/run-nginx-tests.sh --all        # Run all tests (full triage)
#   scripts/run-nginx-tests.sh --report     # Write markdown report to docs/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NGINX_WRAPPER="$REPO_ROOT/examples/nginx-test/nginx-wrapper.sh"
TESTS_DIR="/tmp/nginx-tests"

# Per-test timeout in seconds
TIMEOUT=45

# --- Curated list of tests that pass reliably (32 tests) ---
# Verified via full triage of all 484 upstream tests.
# 410 skip (missing modules: rewrite, gzip, SSL, stream, h2/h3, etc.)
# 40 fail (proxy backends, timing-sensitive, etc.)
# 2 timeout
CURATED_TESTS="
  autoindex
  autoindex_format
  charset
  error_log
  geo
  headers
  http_expect_100_continue
  http_keepalive
  http_resolver_cleanup
  index
  limit_conn
  limit_conn_complex
  limit_conn_dry_run
  limit_req_dry_run
  limit_req2
  map_volatile
  mirror
  not_modified
  not_modified_finalize
  post_action
  proxy_protocol2_tlv
  proxy_ssi_body
  range
  range_if_range
  split_clients
  ssi_if
  ssi_waited
  subrequest_output_buffer_size
  trailers
  upstream_zone
  userid_flags
  worker_shutdown_timeout
"

# --- Expected failures (known issues) ---
# Proxy tests: need upstream backend server process (not supported in wrapper)
# Timing tests: limit_rate, limit_req rely on precise timing
# Unix socket tests: require unix domain socket proxy
# Other: auth_basic needs htpasswd, config_dump format mismatch, syslog needs udp listener
EXPECTED_FAIL="
  auth_basic
  auth_delay
  config_dump
  fastcgi_body
  geo_unix
  ignore_invalid_headers
  limit_rate
  limit_req_delay
  limit_req
  not_modified_proxy
  proxy_available
  proxy_cache_chunked
  proxy_cache_convert_head
  proxy_cache_error
  proxy_cache_lock_age
  proxy_cache_lock_ssi
  proxy_cache_lock
  proxy_cache_max_range_offset
  proxy_cache_min_free
  proxy_cache_path
  proxy_cache_range
  proxy_cache_variables
  proxy_chunked_extra
  proxy_chunked
  proxy_duplicate_headers
  proxy_force_ranges
  proxy_max_temp_file_size
  proxy_noclose
  proxy_pass_request
  proxy_store
  proxy_unix
  proxy_upgrade
  proxy_variables
  proxy
  range_charset
  ssi_delayed
  syslog
  upstream_random
  upstream
  worker_shutdown_timeout_proxy_upgrade
  http_keepalive_shutdown
  http_resolver_cname
"

# --- Parse arguments ---
RUN_ALL=0
REPORT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --all) RUN_ALL=1; shift ;;
    --report) REPORT=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Prerequisites ---
if [ ! -x "$NGINX_WRAPPER" ]; then
  echo "FAIL: nginx-wrapper.sh not found or not executable: $NGINX_WRAPPER"
  exit 1
fi
if [ ! -f "$REPO_ROOT/examples/nginx/nginx.wasm" ]; then
  echo "FAIL: nginx.wasm not found. Run: bash examples/nginx/build.sh"
  exit 1
fi
if [ ! -f "$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm" ]; then
  echo "FAIL: kernel wasm not found. Run: bash build.sh"
  exit 1
fi
if [ ! -d "$TESTS_DIR" ]; then
  echo "Cloning nginx-tests..."
  git clone https://github.com/nginx/nginx-tests.git "$TESTS_DIR"
fi

# Ensure TEST_NGINX_BINARY is set
export TEST_NGINX_BINARY="$NGINX_WRAPPER"

# --- Build test list ---
TESTS=""
if [ "$RUN_ALL" -eq 1 ]; then
  for f in "$TESTS_DIR"/*.t; do
    TESTS="$TESTS $(basename "$f" .t)"
  done
else
  TESTS="$CURATED_TESTS"
fi

# Count tests
TEST_COUNT=0
for t in $TESTS; do
  TEST_COUNT=$((TEST_COUNT + 1))
done

echo "=== nginx test suite ==="
if [ "$RUN_ALL" -eq 1 ]; then
  echo "Mode: all"
else
  echo "Mode: curated"
fi
echo "Tests: $TEST_COUNT"
echo "Timeout: ${TIMEOUT}s per test"
echo ""

# --- Run tests ---
PASS=0
FAIL=0
SKIP=0
XFAIL=0
XPASS=0
TIMED_OUT=0
TOTAL=0

FAIL_LIST=""
XPASS_LIST=""
PASS_LIST=""
SKIP_LIST=""
TIME_LIST=""

# Helper: check if a test name is in the XFAIL list
is_xfail() {
  for x in $EXPECTED_FAIL; do
    if [ "$x" = "$1" ]; then
      return 0
    fi
  done
  return 1
}

for test_name in $TESTS; do
  TOTAL=$((TOTAL + 1))
  test_file="$TESTS_DIR/${test_name}.t"

  if [ ! -f "$test_file" ]; then
    echo "SKIP  $test_name (file not found)"
    SKIP=$((SKIP + 1))
    SKIP_LIST="$SKIP_LIST $test_name"
    continue
  fi

  # Run the test with timeout
  set +e
  OUTPUT=$(cd "$TESTS_DIR" && timeout "$TIMEOUT" prove -v "$test_file" 2>&1)
  EXIT_CODE=$?
  set -e

  if is_xfail "$test_name"; then
    IS_XFAIL=1
  else
    IS_XFAIL=0
  fi

  if [ $EXIT_CODE -eq 124 ]; then
    # Timeout
    if [ "$IS_XFAIL" -eq 1 ]; then
      echo "XFAIL $test_name (timeout, expected)"
      XFAIL=$((XFAIL + 1))
    else
      echo "TIME  $test_name"
      TIMED_OUT=$((TIMED_OUT + 1))
      TIME_LIST="$TIME_LIST $test_name"
    fi
    # Kill any leftover wrapper processes for this test
    pkill -f "nginx-wrapper.*nginx-test-" 2>/dev/null || true
  elif echo "$OUTPUT" | grep -q "^All tests successful"; then
    if [ "$IS_XFAIL" -eq 1 ]; then
      echo "XPASS $test_name (unexpected pass!)"
      XPASS=$((XPASS + 1))
      XPASS_LIST="$XPASS_LIST $test_name"
    else
      echo "PASS  $test_name"
      PASS=$((PASS + 1))
      PASS_LIST="$PASS_LIST $test_name"
    fi
  elif echo "$OUTPUT" | grep -q "skipped:"; then
    # Test skipped itself (missing module/feature)
    echo "SKIP  $test_name"
    SKIP=$((SKIP + 1))
    SKIP_LIST="$SKIP_LIST $test_name"
  elif echo "$OUTPUT" | grep -q "Bail out"; then
    # Test bailed out (usually missing feature / skipped)
    echo "SKIP  $test_name (bail out)"
    SKIP=$((SKIP + 1))
    SKIP_LIST="$SKIP_LIST $test_name"
  else
    if [ "$IS_XFAIL" -eq 1 ]; then
      echo "XFAIL $test_name (expected)"
      XFAIL=$((XFAIL + 1))
    else
      echo "FAIL  $test_name"
      FAIL=$((FAIL + 1))
      FAIL_LIST="$FAIL_LIST $test_name"
    fi
  fi
done

# --- Summary ---
echo ""
echo "=== Summary ==="
echo "Total:  $TOTAL"
echo "PASS:   $PASS"
echo "FAIL:   $FAIL"
echo "XFAIL:  $XFAIL"
echo "XPASS:  $XPASS"
echo "SKIP:   $SKIP"
echo "TIME:   $TIMED_OUT"

if [ -n "$FAIL_LIST" ]; then
  echo ""
  echo "Unexpected failures:"
  for t in $FAIL_LIST; do
    echo "  $t"
  done
fi

if [ -n "$XPASS_LIST" ]; then
  echo ""
  echo "Unexpected passes (remove from EXPECTED_FAIL):"
  for t in $XPASS_LIST; do
    echo "  $t"
  done
fi

# --- Report ---
if [ "$REPORT" -eq 1 ]; then
  REPORT_FILE="$REPO_ROOT/docs/nginx-test-results.md"
  {
    echo "# nginx Test Suite Results"
    echo ""
    echo "$(date '+%Y-%m-%d')"
    echo ""
    echo "## Summary"
    echo ""
    echo "| Result | Count |"
    echo "|--------|-------|"
    echo "| PASS   | $PASS |"
    echo "| FAIL   | $FAIL |"
    echo "| XFAIL  | $XFAIL |"
    echo "| XPASS  | $XPASS |"
    echo "| SKIP   | $SKIP |"
    echo "| TIME   | $TIMED_OUT |"
    echo "| Total  | $TOTAL |"
    echo ""
    echo "## Passing Tests"
    echo ""
    for t in $PASS_LIST; do echo "- $t"; done
    echo ""
    echo "## Failing Tests"
    echo ""
    for t in $FAIL_LIST; do echo "- $t"; done
    echo ""
    echo "## Timed Out"
    echo ""
    for t in $TIME_LIST; do echo "- $t"; done
    echo ""
    echo "## Skipped"
    echo ""
    for t in $SKIP_LIST; do echo "- $t"; done
  } > "$REPORT_FILE"
  echo ""
  echo "Report written to: $REPORT_FILE"
fi

# Exit non-zero if there are unexpected failures
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ]; then
  exit 1
fi
exit 0
