#!/usr/bin/env bash
set -euo pipefail

# Run MariaDB's mysql-test/main project unit suite on Kandelo hosts and keep
# reusable logs/counts for PR updates.
#
# Examples:
#   scripts/run-mariadb-project-tests.sh --host both --all
#   scripts/run-mariadb-project-tests.sh --host node --all --timeout-ms 300000
#   scripts/run-mariadb-project-tests.sh --host browser 1st type_num
#
# Outputs per-host logs plus summary.md/summary.json under:
#   test-runs/mariadb-project/<UTC timestamp>/

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="both"
ALL_MODE=false
RESULTS_DIR=""
TIMEOUT_MS="${TEST_TIMEOUT:-}"
CHUNK_SIZE=0
TEST_ARGS=()
ORIGINAL_COMMAND="$0 $*"

usage() {
  sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'

Options:
  --host node|browser|both  Host(s) to run (default: both).
  --all                    Run every mysql-test/main/*.test file.
  --results-dir DIR        Directory for logs and summaries.
  --timeout-ms N           Per-test timeout passed as TEST_TIMEOUT.
  --chunk-size N           Split --all into chunks of N tests per process.
  -h, --help               Show this help.

Without --all or explicit test names, this wrapper runs the underlying
host harness defaults: node currently means full mysql-test/main, browser
means the curated browser set. Use --all for the full MariaDB project suite.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      if [ "$HOST" != "node" ] && [ "$HOST" != "browser" ] && [ "$HOST" != "both" ]; then
        echo "ERROR: --host must be node, browser, or both" >&2
        exit 2
      fi
      shift 2
      ;;
    --all) ALL_MODE=true; shift ;;
    --results-dir) RESULTS_DIR="$(mkdir -p "${2:-}" && cd "${2:-}" && pwd)"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="${2:-}"; shift 2 ;;
    --chunk-size) CHUNK_SIZE="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    --) shift; TEST_ARGS+=("$@"); break ;;
    -*) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) TEST_ARGS+=("$1"); shift ;;
  esac
done

if [ -z "$RESULTS_DIR" ]; then
  RESULTS_DIR="$REPO_ROOT/test-runs/mariadb-project/$(date -u '+%Y%m%dT%H%M%SZ')"
fi
mkdir -p "$RESULTS_DIR"

HOSTS=()
if [ "$HOST" = "both" ]; then
  HOSTS=(node browser)
else
  HOSTS=("$HOST")
fi

extract_count() {
  local label="$1" log="$2"
  awk -v label="$label" '$1 == label":" { value += $2 } END { print value + 0 }' "$log"
}

discover_all_tests() {
  local main_dir="$REPO_ROOT/packages/registry/mariadb/mariadb-install/mysql-test/main"
  if [ ! -d "$main_dir" ]; then
    echo "ERROR: MariaDB mysql-test main directory missing at $main_dir" >&2
    exit 2
  fi
  find "$main_dir" -maxdepth 1 -type f -name '*.test' \
    | sed 's#.*/##; s#\.test$##' \
    | sort
}

write_summary() {
  local exit_code="$1"
  local summary_md="$RESULTS_DIR/summary.md"
  local summary_json="$RESULTS_DIR/summary.json"

  {
    echo "# MariaDB project mysql-test run"
    echo ""
    echo "Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    echo "Results dir: \`$RESULTS_DIR\`"
    echo "Command: \`$ORIGINAL_COMMAND\`"
    echo ""
    echo "| Host | PASS | FAIL | XFAIL | XPASS | SKIP | TOTAL | Exit | Log |"
    echo "|------|------|------|-------|-------|------|-------|------|-----|"
    for h in "${HOSTS[@]}"; do
      local log="$RESULTS_DIR/$h.log"
      if [ -f "$log" ]; then
        local pass fail xfail xpass skip total host_exit
        pass=$(extract_count PASS "$log")
        fail=$(extract_count FAIL "$log")
        xfail=$(extract_count XFAIL "$log")
        xpass=$(extract_count XPASS "$log")
        skip=$(extract_count SKIP "$log")
        total=$(extract_count TOTAL "$log")
        host_exit=$(cat "$RESULTS_DIR/$h.exit")
        echo "| $h | $pass | $fail | $xfail | $xpass | $skip | $total | $host_exit | \`$h.log\` |"
      else
        echo "| $h | 0 | 0 | 0 | 0 | 0 | 0 | not-run | \`$h.log\` |"
      fi
    done
    echo ""
    echo "Overall exit: $exit_code"
  } > "$summary_md"

  {
    echo "{"
    echo "  \"generated_at\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\","
    echo "  \"results_dir\": \"$RESULTS_DIR\","
    echo "  \"hosts\": {"
    local first=1
    for h in "${HOSTS[@]}"; do
      local log="$RESULTS_DIR/$h.log"
      [ "$first" -eq 1 ] || echo ","
      first=0
      if [ -f "$log" ]; then
        printf '    "%s": {"pass": %s, "fail": %s, "xfail": %s, "xpass": %s, "skip": %s, "total": %s, "exit": %s, "log": "%s"}' \
          "$h" \
          "$(extract_count PASS "$log")" \
          "$(extract_count FAIL "$log")" \
          "$(extract_count XFAIL "$log")" \
          "$(extract_count XPASS "$log")" \
          "$(extract_count SKIP "$log")" \
          "$(extract_count TOTAL "$log")" \
          "$(cat "$RESULTS_DIR/$h.exit")" \
          "$RESULTS_DIR/$h.log"
      else
        printf '    "%s": {"pass": 0, "fail": 0, "xfail": 0, "xpass": 0, "skip": 0, "total": 0, "exit": null, "log": "%s"}' "$h" "$RESULTS_DIR/$h.log"
      fi
    done
    echo ""
    echo "  },"
    echo "  \"exit\": $exit_code"
    echo "}"
  } > "$summary_json"
}

run_command_logged() {
  local log="$1"; shift
  local cmd=("$@")
  set +e
  if [ -n "$TIMEOUT_MS" ]; then
    TEST_TIMEOUT="$TIMEOUT_MS" "${cmd[@]}" 2>&1 | tee -a "$log"
  else
    "${cmd[@]}" 2>&1 | tee -a "$log"
  fi
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

run_host() {
  local h="$1"
  local log="$RESULTS_DIR/$h.log"
  : > "$log"

  echo "===== MariaDB project tests: $h =====" | tee -a "$log"
  echo "Results: $log" | tee -a "$log"
  echo "" | tee -a "$log"

  local base_cmd=()
  case "$h" in
    node) base_cmd=("$REPO_ROOT/scripts/run-mariadb-tests.sh") ;;
    browser) base_cmd=("$REPO_ROOT/scripts/run-browser-mariadb-tests.sh") ;;
  esac

  local status=0
  if $ALL_MODE && [ "$CHUNK_SIZE" -gt 0 ]; then
    mapfile -t all_tests < <(discover_all_tests)
    if [ "$h" = "browser" ]; then
      echo "Preparing full MariaDB browser VFS image for chunked run..." | tee -a "$log"
      bash "$REPO_ROOT/images/vfs/scripts/build-mariadb-test-vfs-image.sh" --all 2>&1 | tee -a "$log" || status=1
    fi
    local total=${#all_tests[@]}
    local chunk=0
    for ((start=0; start<total; start+=CHUNK_SIZE)); do
      chunk=$((chunk + 1))
      local chunk_tests=("${all_tests[@]:start:CHUNK_SIZE}")
      local cmd=("${base_cmd[@]}" "${chunk_tests[@]}")
      if [ "$h" = "node" ]; then
        local chunk_data_dir="$RESULTS_DIR/node-test-data/chunk-$chunk"
        rm -rf "$chunk_data_dir"
        mkdir -p "$chunk_data_dir"
        cmd=(env "MARIADB_TEST_DATA_DIR=$chunk_data_dir" "${cmd[@]}")
      fi
      echo "" | tee -a "$log"
      echo "===== Chunk $chunk: tests $((start + 1))-$((start + ${#chunk_tests[@]})) of $total =====" | tee -a "$log"
      echo "Command: TEST_TIMEOUT=${TIMEOUT_MS:-<default>} ${cmd[*]}" | tee -a "$log"
      if ! run_command_logged "$log" "${cmd[@]}"; then
        status=1
      fi
    done
  else
    local cmd=("${base_cmd[@]}")
    if $ALL_MODE; then cmd+=(--all); fi
    cmd+=("${TEST_ARGS[@]}")
    if [ "$h" = "node" ]; then
      local host_data_dir="$RESULTS_DIR/node-test-data/full"
      rm -rf "$host_data_dir"
      mkdir -p "$host_data_dir"
      cmd=(env "MARIADB_TEST_DATA_DIR=$host_data_dir" "${cmd[@]}")
    fi
    echo "Command: TEST_TIMEOUT=${TIMEOUT_MS:-<default>} ${cmd[*]}" | tee -a "$log"
    if ! run_command_logged "$log" "${cmd[@]}"; then
      status=1
    fi
  fi

  echo "$status" > "$RESULTS_DIR/$h.exit"
  return "$status"
}

OVERALL=0
for h in "${HOSTS[@]}"; do
  if ! run_host "$h"; then
    OVERALL=1
  fi
done

write_summary "$OVERALL"
echo ""
echo "Summary written to: $RESULTS_DIR/summary.md"
cat "$RESULTS_DIR/summary.md"
exit "$OVERALL"
