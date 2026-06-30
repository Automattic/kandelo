#!/usr/bin/env bash
set -euo pipefail

# Run Mozilla's official SpiderMonkey JS shell test harnesses on Kandelo.
#
# The upstream Python harnesses expect an executable native `js` shell. This
# script provides wrapper executables that launch Kandelo's wasm32 SpiderMonkey
# shell on either the Node host or a browser host.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_WRAPPER="$REPO_ROOT/scripts/kandelo-js-shell-wrapper.sh"
BROWSER_WRAPPER="$REPO_ROOT/scripts/kandelo-browser-js-shell-wrapper.sh"
source "$REPO_ROOT/scripts/spidermonkey-known-skips.sh"

HOST="both"
SUITE="both"
JOBS="${SPIDERMONKEY_OFFICIAL_JOBS:-1}"
TIMEOUT="${SPIDERMONKEY_OFFICIAL_TIMEOUT:-60}"
XUL_INFO="${SPIDERMONKEY_XUL_INFO:-wasm32:Linux:false}"
WPT_MODE="${SPIDERMONKEY_OFFICIAL_WPT:-disabled}"
FORMAT="${SPIDERMONKEY_OFFICIAL_FORMAT:-automation}"
JSTEST_JITFLAGS="${SPIDERMONKEY_OFFICIAL_JSTEST_JITFLAGS:-none}"
JITFLAGS="${SPIDERMONKEY_OFFICIAL_JITFLAGS:-all}"
EXTRA_ARGS=()
JS_SHELL_WRAPPER="$NODE_WRAPPER"
NODE_SERVER_PID=""
BROWSER_SERVER_PID=""
FILTERED_JSTEST_ARGS=()
KANDELO_KNOWN_SKIP_FILES=()

usage() {
  cat <<EOF
Usage: $0 [OPTIONS] [-- suite-specific-selector...]

Options:
  --host node|browser|both       Host to run on (default: both)
  --suite jstests|jit-tests|both Official SpiderMonkey harness (default: both)
  --jobs N                       Upstream harness worker count (default: 1)
  --timeout SECONDS              Upstream per-test timeout (default: 60)
  --smoke                        Run one small test from each selected suite
  --format FORMAT                Upstream output format (default: automation)
  --jstest-jitflags VARIANT      jstests jitflags variant (default: none)
  --jitflags VARIANT             jit-tests jitflags variant (default: all)
  --help                         Show this help

Examples:
  $0 --host node --suite jstests --smoke
  $0 --host browser --suite jit-tests -- --read-tests /tmp/jit-list.txt
  $0 --host both --suite jstests -- non262/Array/array-001.js

The browser host uses a persistent Playwright/Vite shell bridge so the Mozilla
harness still invokes an executable 'js' shell path.
EOF
}

SMOKE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      if [ "$HOST" != "node" ] && [ "$HOST" != "browser" ] && [ "$HOST" != "both" ]; then
        echo "ERROR: --host must be node, browser, or both" >&2
        exit 1
      fi
      shift 2
      ;;
    --suite)
      SUITE="${2:-}"
      if [ "$SUITE" != "jstests" ] && [ "$SUITE" != "jit-tests" ] && [ "$SUITE" != "both" ]; then
        echo "ERROR: --suite must be jstests, jit-tests, or both" >&2
        exit 1
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
    --smoke)
      SMOKE=true
      shift
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
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*)
      return 1
      ;;
    *)
      [ "$1" -gt 0 ]
      ;;
  esac
}

guard_browser_jobs() {
  if ! is_positive_integer "$JOBS"; then
    echo "ERROR: --jobs must be a positive integer" >&2
    exit 2
  fi
  case "$HOST" in
    browser|both)
      if [ "$JOBS" -gt 1 ] && [ "${SPIDERMONKEY_ALLOW_BROWSER_MULTIWORKER_SINGLE_BRIDGE:-0}" != "1" ]; then
        echo "ERROR: browser --jobs $JOBS through one bridge is non-authoritative; use scripts/run-spidermonkey-browser-sharded.sh for multi-lane browser parallelism." >&2
        exit 2
      fi
      ;;
  esac
}

guard_browser_jobs

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

ensure_kernel
ensure_js_wasm
SM_SOURCE="$("$REPO_ROOT/scripts/ensure-spidermonkey-source.sh")"
export SPIDERMONKEY_SOURCE_DIR="$SM_SOURCE"

if [ ! -d "$SM_SOURCE/js/src/tests" ] || [ ! -d "$SM_SOURCE/js/src/jit-test" ]; then
  echo "ERROR: SpiderMonkey source tree not found at $SM_SOURCE" >&2
  exit 1
fi

chmod +x "$NODE_WRAPPER" "$BROWSER_WRAPPER"

filter_kandelo_known_jstest_args() {
  local host="$1"
  shift
  FILTERED_JSTEST_ARGS=()
  KANDELO_KNOWN_SKIP_FILES=()

  local selector normalized path child rel
  for selector in "$@"; do
    normalized="${selector%/}"
    path="$SM_SOURCE/js/src/tests/$normalized"
    if [ -f "$path" ]; then
      rel="$(kandelo_rel_jstest_path "$path")"
      if kandelo_known_jstest_skip_reason "$host" "$rel" >/dev/null; then
        KANDELO_KNOWN_SKIP_FILES+=("$path")
      else
        FILTERED_JSTEST_ARGS+=("$selector")
      fi
    elif [ -d "$path" ]; then
      local dir_filtered=()
      local dir_known=()
      while IFS= read -r -d '' child; do
        rel="$(kandelo_rel_jstest_path "$child")"
        if kandelo_known_jstest_skip_reason "$host" "$rel" >/dev/null; then
          dir_known+=("$child")
        else
          dir_filtered+=("$rel")
        fi
      done < <(find "$path" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print0 | sort -z)

      if [ "${#dir_known[@]}" -gt 0 ]; then
        KANDELO_KNOWN_SKIP_FILES+=("${dir_known[@]}")
        FILTERED_JSTEST_ARGS+=("${dir_filtered[@]+"${dir_filtered[@]}"}")
      else
        FILTERED_JSTEST_ARGS+=("$selector")
      fi
    else
      FILTERED_JSTEST_ARGS+=("$selector")
    fi
  done
}

stop_shell_bridge_pid() {
  local pid="$1" name="$2" timeout killer_pid
  timeout="${SPIDERMONKEY_SHELL_BRIDGE_SHUTDOWN_TIMEOUT_SECONDS:-15}"
  [ -n "$pid" ] || return 0

  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  (
    sleep "$timeout"
    if kill -0 "$pid" 2>/dev/null; then
      echo "WARNING: $name did not exit after ${timeout}s; sending SIGKILL" >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
  killer_pid=$!
  wait "$pid" 2>/dev/null || true
  kill "$killer_pid" 2>/dev/null || true
  wait "$killer_pid" 2>/dev/null || true
}

start_browser_shell_bridge() {
  local port="${SPIDERMONKEY_BROWSER_JS_SHELL_PORT:-5312}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_PORT="$port"
  export SPIDERMONKEY_BROWSER_JS_SHELL_URL="http://127.0.0.1:$port/run"
  export SPIDERMONKEY_OFFICIAL_REBUILD_VFS="${SPIDERMONKEY_OFFICIAL_REBUILD_VFS:-0}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_RECYCLE_INTERVAL="${SPIDERMONKEY_BROWSER_JS_SHELL_RECYCLE_INTERVAL:-25}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_BROWSER_RECYCLE_INTERVAL="${SPIDERMONKEY_BROWSER_JS_SHELL_BROWSER_RECYCLE_INTERVAL:-100}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_WASM_OOB_RETRIES="${SPIDERMONKEY_BROWSER_JS_SHELL_WASM_OOB_RETRIES:-1}"

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
  if [ -n "${BROWSER_SERVER_PID:-}" ]; then
    stop_shell_bridge_pid "$BROWSER_SERVER_PID" "browser js shell bridge"
    BROWSER_SERVER_PID=""
  fi
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
  if [ -n "${NODE_SERVER_PID:-}" ]; then
    stop_shell_bridge_pid "$NODE_SERVER_PID" "node js shell bridge"
    NODE_SERVER_PID=""
  fi
  unset SPIDERMONKEY_NODE_JS_SHELL_URL
}

run_jstests() {
  local args=()
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    args=("${EXTRA_ARGS[@]}")
  fi
  if $SMOKE && [ ${#args[@]} -eq 0 ]; then
    args=(non262/Array/array-001.js)
  fi

  echo "===== Official SpiderMonkey jstests on Kandelo $CURRENT_HOST host ====="
  filter_kandelo_known_jstest_args "$CURRENT_HOST" "${args[@]+"${args[@]}"}"
  if [ "${#KANDELO_KNOWN_SKIP_FILES[@]}" -gt 0 ]; then
    kandelo_write_known_skip_entries jstests "$CURRENT_HOST" "${KANDELO_KNOWN_SKIP_FILES[@]}"
    if [ "${#FILTERED_JSTEST_ARGS[@]}" -eq 0 ]; then
      return 0
    fi
  fi

  export SPIDERMONKEY_WRAPPER_TIMEOUT_MS="${SPIDERMONKEY_WRAPPER_TIMEOUT_MS:-$((TIMEOUT * 1000 + 30000))}"
  python3 "$SM_SOURCE/js/src/tests/jstests.py" \
    --no-progress \
    --no-xdr \
    --xul-info "$XUL_INFO" \
    --wpt "$WPT_MODE" \
    --format "$FORMAT" \
    --jitflags "$JSTEST_JITFLAGS" \
    --worker-count "$JOBS" \
    --timeout "$TIMEOUT" \
    "$JS_SHELL_WRAPPER" \
    ${FILTERED_JSTEST_ARGS[@]+"${FILTERED_JSTEST_ARGS[@]}"}
}

run_jit_tests() {
  local args=()
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    args=("${EXTRA_ARGS[@]}")
  fi
  local smoke_list=""
  if $SMOKE && [ ${#args[@]} -eq 0 ]; then
    smoke_list="$(mktemp)"
    printf '%s\n' "$SM_SOURCE/js/src/jit-test/tests/basic/bug908915.js" > "$smoke_list"
    args=(--read-tests "$smoke_list")
  fi

  echo "===== Official SpiderMonkey jit-tests on Kandelo $CURRENT_HOST host ====="
  export SPIDERMONKEY_WRAPPER_TIMEOUT_MS="${SPIDERMONKEY_WRAPPER_TIMEOUT_MS:-$((TIMEOUT * 1000 + 30000))}"
  set +e
  python3 "$SM_SOURCE/js/src/jit-test/jit_test.py" \
    --no-progress \
    --no-xdr \
    --worker-count "$JOBS" \
    --timeout "$TIMEOUT" \
    --format "$FORMAT" \
    --jitflags "$JITFLAGS" \
    ${args[@]+"${args[@]}"} \
    "$JS_SHELL_WRAPPER"
  local status=$?
  set -e

  if [ -n "$smoke_list" ]; then
    rm -f "$smoke_list"
  fi
  return "$status"
}

run_selected_suites() {
  case "$SUITE" in
    jstests)
      run_jstests
      ;;
    jit-tests)
      run_jit_tests
      ;;
    both)
      local status=0
      run_jstests || status=1
      run_jit_tests || status=1
      return "$status"
      ;;
  esac
}

FAIL=0
HOSTS=()
if [ "$HOST" = "both" ]; then
  HOSTS=(node browser)
else
  HOSTS=("$HOST")
fi

for CURRENT_HOST in "${HOSTS[@]}"; do
  case "$CURRENT_HOST" in
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

  run_selected_suites || FAIL=1

  case "$CURRENT_HOST" in
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

exit "$FAIL"
