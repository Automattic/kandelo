#!/usr/bin/env bash
set -euo pipefail

# Exhaustively run the upstream SpiderMonkey shell harnesses in chunks.
#
# `run-spidermonkey-official-tests.sh` can run a whole upstream suite in one
# invocation, but jstests.py spends a long time feature-probing the complete
# tree before it emits progress. Chunking by upstream directory makes the run
# resumable and leaves one log per area for kernel-bug triage. This runner is
# exhaustive: it enumerates every runnable SpiderMonkey jstest and jit-test
# file from the Mozilla source checkout, rather than maintaining a hand-picked
# selector list.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_WRAPPER="$REPO_ROOT/scripts/kandelo-js-shell-wrapper.sh"
BROWSER_WRAPPER="$REPO_ROOT/scripts/kandelo-browser-js-shell-wrapper.sh"
source "$REPO_ROOT/scripts/spidermonkey-known-skips.sh"

HOST="both"
SUITE="both"
JOBS="${SPIDERMONKEY_OFFICIAL_JOBS:-1}"
TIMEOUT="${SPIDERMONKEY_OFFICIAL_TIMEOUT:-120}"
XUL_INFO="${SPIDERMONKEY_XUL_INFO:-wasm32:Linux:false}"
WPT_MODE="${SPIDERMONKEY_OFFICIAL_WPT:-disabled}"
FORMAT="${SPIDERMONKEY_OFFICIAL_FORMAT:-automation}"
JSTEST_JITFLAGS="${SPIDERMONKEY_OFFICIAL_JSTEST_JITFLAGS:-none}"
JITFLAGS="${SPIDERMONKEY_OFFICIAL_JITFLAGS:-all}"
RESULTS_DIR="$REPO_ROOT/test-results/spidermonkey-official"
CONTINUE=1
RUN_SLOW="${SPIDERMONKEY_OFFICIAL_RUN_SLOW:-1}"
JSTEST_CHUNK_SIZE="${SPIDERMONKEY_OFFICIAL_JSTEST_CHUNK_SIZE:-500}"
JIT_CHUNK_SIZE="${SPIDERMONKEY_OFFICIAL_JIT_CHUNK_SIZE:-500}"
START_AT="${SPIDERMONKEY_OFFICIAL_START_AT:-}"
STARTED=0
RESTART_BRIDGE_PER_CHUNK="${SPIDERMONKEY_OFFICIAL_RESTART_BRIDGE_PER_CHUNK:-0}"
JS_SHELL_WRAPPER="$NODE_WRAPPER"
NODE_SERVER_PID=""
BROWSER_SERVER_PID=""
FILTERED_JIT_FILES=()
KANDELO_KNOWN_SKIP_FILES=()
NEXT_KNOWN_SKIP_FILES=()

FILTERED_JSTEST_SELECTORS=()

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --host node|browser|both       Host to run on (default: both)
  --suite jstests|jit-tests|both Official suite(s) to run (default: both)
  --jobs N                       Upstream harness worker count per chunk (default: 1)
  --timeout SECONDS              Upstream per-test timeout (default: 120)
  --format FORMAT                Upstream output format (default: automation)
  --jstest-jitflags VARIANT      jstests jitflags variant (default: none)
  --jitflags VARIANT             jit-tests jitflags variant (default: all)
  --no-slow                      Use upstream defaults and skip tests marked slow
  --results-dir DIR              Directory for logs and summaries
  --start-at CHUNK               Skip chunks until CHUNK, suite/CHUNK, or host/suite/CHUNK
  --restart-bridge-per-chunk     Restart the host bridge before each chunk
  --fail-fast                    Stop after the first failing chunk
  --help                         Show this help
EOF
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
    --suite)
      SUITE="${2:-}"
      if [ "$SUITE" != "jstests" ] && [ "$SUITE" != "jit-tests" ] && [ "$SUITE" != "both" ]; then
        echo "ERROR: --suite must be jstests, jit-tests, or both" >&2
        exit 2
      fi
      shift 2
      ;;
    --jobs)
      JOBS="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    --format)
      FORMAT="${2:-}"
      shift 2
      ;;
    --jstest-jitflags)
      JSTEST_JITFLAGS="${2:-}"
      shift 2
      ;;
    --jitflags)
      JITFLAGS="${2:-}"
      shift 2
      ;;
    --no-slow)
      RUN_SLOW=0
      shift
      ;;
    --results-dir)
      RESULTS_DIR="${2:-}"
      shift 2
      ;;
    --start-at)
      START_AT="${2:-}"
      shift 2
      ;;
    --restart-bridge-per-chunk)
      RESTART_BRIDGE_PER_CHUNK=1
      shift
      ;;
    --fail-fast)
      CONTINUE=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

ensure_kernel() {
  if "$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Building kernel.wasm for SpiderMonkey official tests..." >&2
  bash "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"
}

resolve_js_wasm() {
  local candidate

  candidate="${SPIDERMONKEY_WASM:-}"
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/js.wasm 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/spidermonkey.wasm 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$REPO_ROOT/packages/registry/spidermonkey/bin/js.wasm"
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

ensure_js_wasm() {
  local js_wasm host_target
  if js_wasm="$(resolve_js_wasm)"; then
    export SPIDERMONKEY_WASM="$js_wasm"
    return 0
  fi

  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    echo "==> Resolving SpiderMonkey js.wasm via package registry..." >&2
    host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    (
      cd "$REPO_ROOT"
      cargo --config "build.target=\"$host_target\"" run -p xtask --quiet -- \
        build-deps --arch wasm32 --binaries-dir "$REPO_ROOT/binaries" resolve spidermonkey
    ) >&2 || true
  fi

  if js_wasm="$(resolve_js_wasm)"; then
    export SPIDERMONKEY_WASM="$js_wasm"
    return 0
  fi

  echo "ERROR: SpiderMonkey js.wasm not found." >&2
  echo "Run: bash packages/registry/spidermonkey/build-spidermonkey.sh" >&2
  exit 1
}

ensure_browser_rootfs() {
  if [ -f "$REPO_ROOT/host/wasm/rootfs.vfs" ] ||
      "$REPO_ROOT/scripts/resolve-binary.sh" rootfs.vfs >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Building minimal rootfs.vfs for the browser test host..." >&2
  node --import tsx/esm "$REPO_ROOT/scripts/build-minimal-rootfs-vfs.ts"
}

SM_SOURCE="$("$REPO_ROOT/scripts/ensure-spidermonkey-source.sh")"
ensure_kernel
ensure_js_wasm
export SPIDERMONKEY_SOURCE_DIR="$SM_SOURCE"
chmod +x "$NODE_WRAPPER" "$BROWSER_WRAPPER"
mkdir -p "$RESULTS_DIR"
SUMMARY="$RESULTS_DIR/summary.tsv"
printf 'host\tsuite\tchunk\tstatus\tpass\tknown_skip\tunexpected\tlog\n' > "$SUMMARY"
INVENTORY="$RESULTS_DIR/inventory.tsv"

safe_name() {
  printf '%s' "$1" | tr '/ ' '__'
}

count_pattern() {
  local pattern="$1"
  local file="$2"
  grep -c "$pattern" "$file" 2>/dev/null || true
}

record_result() {
  local host="$1"
  local suite="$2"
  local chunk="$3"
  local status="$4"
  local log="$5"
  local pass known unexpected
  pass="$(count_pattern 'TEST-PASS' "$log")"
  known="$(count_pattern 'TEST-KNOWN-FAIL' "$log")"
  unexpected="$(count_pattern 'TEST-UNEXPECTED' "$log")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$host" "$suite" "$chunk" "$status" "$pass" "$known" "$unexpected" "$log" \
    | tee -a "$SUMMARY"
}

rel_jit_test_path() {
  local file="$1"
  printf '%s\n' "${file#$SM_SOURCE/js/src/jit-test/tests/}"
}

rel_jstest_path() {
  local file="$1"
  printf '%s\n' "${file#$SM_SOURCE/js/src/tests/}"
}

is_kandelo_known_jstest_skip() {
  local host="$1"
  local file="$2"
  local rel
  rel="$(rel_jstest_path "$file")"
  kandelo_known_jstest_skip_reason "$host" "$rel" >/dev/null
}

is_kandelo_browser_wasm32_known_jstest_skip_dir() {
  local host="$1"
  local dir="$2"
  local rel
  if [ "$host" != "browser" ]; then
    return 1
  fi
  rel="${dir#$SM_SOURCE/js/src/tests/}"
  rel="${rel%/}"
  case "$rel" in
    test262/built-ins/Atomics/*/bigint)
      return 0
      ;;
  esac
  return 1
}

is_kandelo_browser_wasm32_known_jit_skip() {
  local host="$1"
  local file="$2"
  local rel
  rel="$(rel_jit_test_path "$file")"
  kandelo_known_jit_skip_reason "$host" "$rel" >/dev/null
}

filter_kandelo_known_jit_skips() {
  local host="$1"
  shift
  FILTERED_JIT_FILES=()
  KANDELO_KNOWN_SKIP_FILES=()
  local file
  for file in "$@"; do
    if is_kandelo_browser_wasm32_known_jit_skip "$host" "$file"; then
      KANDELO_KNOWN_SKIP_FILES+=("$file")
    else
      FILTERED_JIT_FILES+=("$file")
    fi
  done
}

filter_kandelo_known_jstest_skips() {
  local host="$1"
  shift
  FILTERED_JSTEST_SELECTORS=()
  KANDELO_KNOWN_SKIP_FILES=()
  local selector file
  for selector in "$@"; do
    file="$SM_SOURCE/js/src/tests/$selector"
    if [ -f "$file" ] && is_kandelo_known_jstest_skip "$host" "$file"; then
      KANDELO_KNOWN_SKIP_FILES+=("$file")
    else
      FILTERED_JSTEST_SELECTORS+=("$selector")
    fi
  done
}

queue_known_skip_entries() {
  NEXT_KNOWN_SKIP_FILES=()
  if [ "$#" -gt 0 ]; then
    NEXT_KNOWN_SKIP_FILES=("$@")
  fi
}

write_known_skip_entries() {
  local suite="$1"
  shift
  kandelo_write_known_skip_entries "$suite" "$CURRENT_HOST" "$@"
}

should_skip_chunk() {
  local host="$1"
  local suite="$2"
  local chunk="$3"
  if [ -z "$START_AT" ] || [ "$STARTED" = "1" ]; then
    return 1
  fi
  if [ "$chunk" = "$START_AT" ] ||
      [ "$suite/$chunk" = "$START_AT" ] ||
      [ "$host/$suite/$chunk" = "$START_AT" ]; then
    STARTED=1
    return 1
  fi
  echo "Skipping $host $suite $chunk before --start-at $START_AT" | tee -a "$RESULTS_DIR/progress.log"
  return 0
}

start_node_shell_bridge() {
  local port="${SPIDERMONKEY_NODE_JS_SHELL_PORT:-5311}"
  export SPIDERMONKEY_NODE_JS_SHELL_PORT="$port"
  export SPIDERMONKEY_NODE_JS_SHELL_URL="http://127.0.0.1:$port/run"

  node --experimental-wasm-exnref --import tsx/esm "$REPO_ROOT/scripts/kandelo-node-js-shell-server.ts" &
  NODE_SERVER_PID=$!

  for _ in $(seq 1 120); do
    if node -e "fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$NODE_SERVER_PID" 2>/dev/null; then
      echo "ERROR: node js shell bridge exited early" >&2
      return 1
    fi
    sleep 1
  done
  echo "ERROR: node js shell bridge did not become ready" >&2
  return 1
}

stop_node_shell_bridge() {
  if [ -n "$NODE_SERVER_PID" ]; then
    kill "$NODE_SERVER_PID" 2>/dev/null || true
    wait "$NODE_SERVER_PID" 2>/dev/null || true
    NODE_SERVER_PID=""
  fi
  unset SPIDERMONKEY_NODE_JS_SHELL_URL
}

start_browser_shell_bridge() {
  local port="${SPIDERMONKEY_BROWSER_JS_SHELL_PORT:-5312}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_PORT="$port"
  export SPIDERMONKEY_BROWSER_JS_SHELL_URL="http://127.0.0.1:$port/run"
  export SPIDERMONKEY_OFFICIAL_REBUILD_VFS="${SPIDERMONKEY_OFFICIAL_REBUILD_VFS:-0}"

  node --import tsx/esm "$REPO_ROOT/scripts/kandelo-browser-js-shell-server.ts" &
  BROWSER_SERVER_PID=$!

  for _ in $(seq 1 180); do
    if node -e "fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$BROWSER_SERVER_PID" 2>/dev/null; then
      echo "ERROR: browser js shell bridge exited early" >&2
      return 1
    fi
    sleep 1
  done
  echo "ERROR: browser js shell bridge did not become ready" >&2
  return 1
}

stop_browser_shell_bridge() {
  if [ -n "$BROWSER_SERVER_PID" ]; then
    kill "$BROWSER_SERVER_PID" 2>/dev/null || true
    wait "$BROWSER_SERVER_PID" 2>/dev/null || true
    BROWSER_SERVER_PID=""
  fi
}

restart_shell_bridge_for_chunk() {
  local host="$1"
  if [ "$RESTART_BRIDGE_PER_CHUNK" != "1" ]; then
    return 0
  fi
  case "$host" in
    node)
      stop_node_shell_bridge
      start_node_shell_bridge
      ;;
    browser)
      stop_browser_shell_bridge
      start_browser_shell_bridge
      ;;
  esac
}

has_runnable_jstest_files() {
  local dir="$1"
  [ -n "$(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print -quit)" ]
}

count_runnable_jstest_files() {
  local dir="$1"
  find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' | wc -l | tr -d ' '
}

write_inventory() {
  local dir count total
  printf 'suite\tchunk\trunnable_js_files\n' > "$INVENTORY"

  total=0
  for dir in "$SM_SOURCE/js/src/tests"/*/; do
    [ -d "$dir" ] || continue
    if has_runnable_jstest_files "$dir"; then
      count="$(count_runnable_jstest_files "$dir")"
      total=$((total + count))
      printf 'jstests\t%s\t%s\n' "$(basename "$dir")" "$count" >> "$INVENTORY"
    fi
  done
  printf 'jstests\t_ALL_\t%s\n' "$total" >> "$INVENTORY"

  total=0
  count="$(find "$SM_SOURCE/js/src/jit-test/tests" -mindepth 1 -maxdepth 1 -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' | wc -l | tr -d ' ')"
  if [ "$count" -gt 0 ]; then
    total=$((total + count))
    printf 'jit-tests\t_files\t%s\n' "$count" >> "$INVENTORY"
  fi
  for dir in "$SM_SOURCE/js/src/jit-test/tests"/*/; do
    [ -d "$dir" ] || continue
    count="$(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' | wc -l | tr -d ' ')"
    if [ "$count" -gt 0 ]; then
      total=$((total + count))
      printf 'jit-tests\t%s\t%s\n' "$(basename "$dir")" "$count" >> "$INVENTORY"
    fi
  done
  printf 'jit-tests\t_ALL_\t%s\n' "$total" >> "$INVENTORY"

  echo "Inventory written to $INVENTORY"
}

run_chunk() {
  local host="$1"
  local suite="$2"
  local chunk="$3"
  shift 3
  local log="$RESULTS_DIR/$(safe_name "$host-$suite-$chunk").log"
  local known_skip_files=("${NEXT_KNOWN_SKIP_FILES[@]+"${NEXT_KNOWN_SKIP_FILES[@]}"}")
  NEXT_KNOWN_SKIP_FILES=()

  if should_skip_chunk "$host" "$suite" "$chunk"; then
    return 0
  fi
  restart_shell_bridge_for_chunk "$host"

  echo "===== $(date -u +%FT%TZ) $host $suite $chunk =====" | tee -a "$RESULTS_DIR/progress.log"
  set +e
  if [ "${#known_skip_files[@]}" -gt 0 ]; then
    write_known_skip_entries "$suite" "${known_skip_files[@]}" > "$log"
    run_upstream_chunk "$suite" "$@" >> "$log" 2>&1
  else
    run_upstream_chunk "$suite" "$@" > "$log" 2>&1
  fi
  local status=$?
  set -e

  record_result "$host" "$suite" "$chunk" "$status" "$log"
  if [ "$status" -ne 0 ] && [ "$CONTINUE" = "0" ]; then
    echo "Stopping after failing chunk $host/$suite/$chunk" >&2
    exit "$status"
  fi
}

record_known_skip_only_chunk() {
  local host="$1"
  local suite="$2"
  local chunk="$3"
  shift 3
  local log="$RESULTS_DIR/$(safe_name "$host-$suite-$chunk").log"

  if should_skip_chunk "$host" "$suite" "$chunk"; then
    return 0
  fi

  echo "===== $(date -u +%FT%TZ) $host $suite $chunk =====" | tee -a "$RESULTS_DIR/progress.log"
  write_known_skip_entries "$suite" "$@" > "$log"
  record_result "$host" "$suite" "$chunk" 0 "$log"
}

run_upstream_chunk() {
  local suite="$1"
  shift
  local jstest_slow_args=()
  local jit_slow_args=()
  if [ "$RUN_SLOW" = "1" ]; then
    jstest_slow_args=(--run-slow-tests)
    jit_slow_args=(--slow)
  fi
  export SPIDERMONKEY_WRAPPER_TIMEOUT_MS="${SPIDERMONKEY_WRAPPER_TIMEOUT_MS:-$((TIMEOUT * 1000 + 30000))}"
  case "$suite" in
    jstests)
      echo "===== Official SpiderMonkey jstests on Kandelo $CURRENT_HOST host ====="
      python3 "$SM_SOURCE/js/src/tests/jstests.py" \
        --no-progress \
        --no-xdr \
        --xul-info "$XUL_INFO" \
        --wpt "$WPT_MODE" \
        --format "$FORMAT" \
        --jitflags "$JSTEST_JITFLAGS" \
        ${jstest_slow_args[@]+"${jstest_slow_args[@]}"} \
        --worker-count "$JOBS" \
        --timeout "$TIMEOUT" \
        "$JS_SHELL_WRAPPER" \
        "$@"
      ;;
    jit-tests)
      echo "===== Official SpiderMonkey jit-tests on Kandelo $CURRENT_HOST host ====="
      python3 "$SM_SOURCE/js/src/jit-test/jit_test.py" \
        --no-progress \
        --no-xdr \
        --worker-count "$JOBS" \
        --timeout "$TIMEOUT" \
        --format "$FORMAT" \
        --jitflags "$JITFLAGS" \
        ${jit_slow_args[@]+"${jit_slow_args[@]}"} \
        "$@" \
        "$JS_SHELL_WRAPPER"
      ;;
    *)
      echo "ERROR: unknown suite $suite" >&2
      return 2
      ;;
  esac
}

run_jstest_empty_chunk() {
  local host="$1"
  local chunk="$2"
  local log="$RESULTS_DIR/$(safe_name "$host-jstests-$chunk").log"
  if should_skip_chunk "$host" jstests "$chunk"; then
    return 0
  fi
  printf 'No runnable jstests in %s; only harness helper files were present.\n' "$chunk" > "$log"
  record_result "$host" jstests "$chunk" 0 "$log"
}

run_jstest_selector_group() {
  local host="$1"
  local chunk="$2"
  shift 2
  if [ "$#" -eq 0 ]; then
    return 0
  fi
  filter_kandelo_known_jstest_skips "$host" "$@"
  if [ "${#FILTERED_JSTEST_SELECTORS[@]}" -gt 0 ]; then
    queue_known_skip_entries "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
    run_chunk "$host" jstests "$chunk" "${FILTERED_JSTEST_SELECTORS[@]}"
  else
    record_known_skip_only_chunk "$host" jstests "$chunk" "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
  fi
}

run_jstest_file_groups() {
  local host="$1"
  local chunk_prefix="$2"
  shift 2
  local selectors=("$@")
  local total="${#selectors[@]}"
  local index=0
  local part=1
  local group=()

  while [ "$index" -lt "$total" ]; do
    group=("${selectors[@]:$index:$JSTEST_CHUNK_SIZE}")
    run_jstest_selector_group "$host" "${chunk_prefix}#part-$(printf '%04d' "$part")" "${group[@]}"
    index=$((index + JSTEST_CHUNK_SIZE))
    part=$((part + 1))
  done
}

run_jstest_dir_recursive() {
  local host="$1"
  local dir="$2"
  local chunk="$3"
  local count child child_chunk direct_files=() known_skip_files=() selectors=()

  count="$(count_runnable_jstest_files "$dir")"
  if [ "$count" -eq 0 ]; then
    run_jstest_empty_chunk "$host" "$chunk"
    return 0
  fi

  if is_kandelo_browser_wasm32_known_jstest_skip_dir "$host" "$dir"; then
    while IFS= read -r -d '' child; do
      known_skip_files+=("$child")
    done < <(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print0 | sort -z)
    record_known_skip_only_chunk "$host" jstests "$chunk" "${known_skip_files[@]+"${known_skip_files[@]}"}"
    return 0
  fi

  if [ "$count" -le "$JSTEST_CHUNK_SIZE" ]; then
    if [ "$host" = "browser" ]; then
      while IFS= read -r -d '' child; do
        selectors+=("${child#$SM_SOURCE/js/src/tests/}")
      done < <(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print0 | sort -z)
      filter_kandelo_known_jstest_skips "$host" "${selectors[@]}"
      if [ "${#KANDELO_KNOWN_SKIP_FILES[@]}" -gt 0 ]; then
        if [ "${#FILTERED_JSTEST_SELECTORS[@]}" -gt 0 ]; then
          queue_known_skip_entries "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
          run_chunk "$host" jstests "$chunk" "${FILTERED_JSTEST_SELECTORS[@]}"
        else
          record_known_skip_only_chunk "$host" jstests "$chunk" "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
        fi
        return 0
      fi
    fi
    run_chunk "$host" jstests "$chunk" "$chunk/"
    return 0
  fi

  # Large directories are split recursively. Any runnable files directly under
  # this directory are still included; helper files named shell.js/browser.js
  # are excluded because the upstream manifest loads them as harness support.
  while IFS= read -r -d '' child; do
    direct_files+=("${child#$SM_SOURCE/js/src/tests/}")
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print0 | sort -z)
  if [ "${#direct_files[@]}" -gt 0 ]; then
    run_jstest_file_groups "$host" "$chunk/_files" "${direct_files[@]}"
  fi

  while IFS= read -r -d '' child; do
    child_chunk="$chunk/$(basename "$child")"
    run_jstest_dir_recursive "$host" "$child" "$child_chunk"
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
}

run_jstests_for_host() {
  local host="$1"
  local dir
  for dir in "$SM_SOURCE/js/src/tests"/*/; do
    [ -d "$dir" ] || continue
    if has_runnable_jstest_files "$dir"; then
      run_jstest_dir_recursive "$host" "$dir" "$(basename "$dir")"
    fi
  done
}

run_jit_tests_for_host() {
  local host="$1"
  local dir files=() total index part group list_file chunk
  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(find "$SM_SOURCE/js/src/jit-test/tests" -mindepth 1 -maxdepth 1 -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' -print0 | sort -z)
  total="${#files[@]}"
  if [ "$total" -gt 0 ]; then
    index=0
    part=1
    while [ "$index" -lt "$total" ]; do
      group=("${files[@]:$index:$JIT_CHUNK_SIZE}")
      if [ "$total" -le "$JIT_CHUNK_SIZE" ]; then
        chunk="_files"
      else
        chunk="_files#part-$(printf '%04d' "$part")"
      fi
      list_file="$RESULTS_DIR/jit-$(safe_name "$chunk").txt"
      filter_kandelo_known_jit_skips "$host" "${group[@]}"
      if [ "${#FILTERED_JIT_FILES[@]}" -gt 0 ]; then
        printf '%s\n' "${FILTERED_JIT_FILES[@]}" > "$list_file"
        queue_known_skip_entries "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
        run_chunk "$host" jit-tests "$chunk" --read-tests "$list_file"
      else
        : > "$list_file"
        record_known_skip_only_chunk "$host" jit-tests "$chunk" "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
      fi
      index=$((index + JIT_CHUNK_SIZE))
      part=$((part + 1))
    done
  fi

  for dir in "$SM_SOURCE/js/src/jit-test/tests"/*/; do
    [ -d "$dir" ] || continue
    files=()
    while IFS= read -r -d '' file; do
      files+=("$file")
    done < <(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' -print0 | sort -z)
    total="${#files[@]}"
    if [ "$total" -eq 0 ]; then
      continue
    fi
    index=0
    part=1
    while [ "$index" -lt "$total" ]; do
      group=("${files[@]:$index:$JIT_CHUNK_SIZE}")
      if [ "$total" -le "$JIT_CHUNK_SIZE" ]; then
        chunk="$(basename "$dir")"
      else
        chunk="$(basename "$dir")#part-$(printf '%04d' "$part")"
      fi
      list_file="$RESULTS_DIR/jit-$(safe_name "$chunk").txt"
      filter_kandelo_known_jit_skips "$host" "${group[@]}"
      if [ "${#FILTERED_JIT_FILES[@]}" -gt 0 ]; then
        printf '%s\n' "${FILTERED_JIT_FILES[@]}" > "$list_file"
        queue_known_skip_entries "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
        run_chunk "$host" jit-tests "$chunk" --read-tests "$list_file"
      else
        : > "$list_file"
        record_known_skip_only_chunk "$host" jit-tests "$chunk" "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
      fi
      index=$((index + JIT_CHUNK_SIZE))
      part=$((part + 1))
    done
  done
}

HOSTS=()
if [ "$HOST" = "both" ]; then
  HOSTS=(node browser)
else
  HOSTS=("$HOST")
fi

write_inventory

for host in "${HOSTS[@]}"; do
  CURRENT_HOST="$host"
  case "$host" in
    node)
      JS_SHELL_WRAPPER="$NODE_WRAPPER"
      start_node_shell_bridge || exit 1
      trap stop_node_shell_bridge EXIT
      ;;
    browser)
      JS_SHELL_WRAPPER="$BROWSER_WRAPPER"
      ensure_browser_rootfs
      start_browser_shell_bridge || exit 1
      trap stop_browser_shell_bridge EXIT
      ;;
  esac

  case "$SUITE" in
    jstests)
      run_jstests_for_host "$host"
      ;;
    jit-tests)
      run_jit_tests_for_host "$host"
      ;;
    both)
      run_jstests_for_host "$host"
      run_jit_tests_for_host "$host"
      ;;
  esac

  case "$host" in
    node)
      stop_node_shell_bridge
      trap - EXIT
      ;;
    browser)
      stop_browser_shell_bridge
      trap - EXIT
      ;;
  esac
done

echo "Summary written to $SUMMARY"
