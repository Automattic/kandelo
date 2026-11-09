#!/usr/bin/env bash
# This benchmark's authored Swift/TS execution is sealed before compilation.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
[[ "$(uname -s)" == Darwin ]] || { echo 'Requires the installed macOS compiler.' >&2; exit 2; }
if [[ "${1:-}" == --sealed ]];then
  origin="$2";out="$3";mode="$4"
else
  mode="${2:-headless}"
  case "$mode" in headless|native) ;; *) echo 'Mode must be headless or native.' >&2; exit 2;; esac
  if [[ -n "${1:-}" ]];then
    case "$1" in /*) out="$1";; *) out="$PWD/$1";; esac
    mkdir -p "$(dirname "$out")";mkdir "$out"
  else
    mkdir -p "$root/.context";out="$(mktemp -d "$root/.context/response-control-XXXXXXXX")"
  fi
  python3 "$root/benchmarks/desktop-latency/response-source-custody.py" freeze "$root" "$out"
  # Re-exec the copied launcher too; later edits cannot change its command flow.
  exec bash "$out/source/benchmarks/desktop-latency/run-response-control.sh" --sealed "$root" "$out" "$mode"
fi
case "$mode" in headless|native) ;; *) echo 'Invalid sealed mode.' >&2; exit 2;; esac
finish() {
  local result="$?" verify=0
  trap - EXIT
  printf '%s\n' "$result" > "$out/command.exit"
  python3 "$root/benchmarks/desktop-latency/response-source-custody.py" verify "$origin" "$out" post || verify=$?
  if [[ "$verify" != 0 ]];then exit "$verify";fi
  exit "$result"
}
trap finish EXIT
python3 "$root/benchmarks/desktop-latency/response-source-custody.py" verify "$origin" "$out" pre
printf 'Complete response-ROI control (%s): %s\n' "$mode" "$out"
mac_tool() { /usr/bin/env -u DEVELOPER_DIR -u SDKROOT /usr/bin/xcrun "$@"; }
mac_tool swift --version > "$out/swift-version.txt" 2>&1
/usr/bin/sw_vers > "$out/os-version.txt"
mac_tool swiftc -O -parse-as-library "$root/benchmarks/desktop-latency/pixel-matcher.swift" "$root/benchmarks/desktop-latency/pixel-matcher-offline.swift" -o "$out/pixel-matcher-offline" > "$out/compile-offline.log" 2>&1
mac_tool swiftc -O -parse-as-library "$root/benchmarks/desktop-latency/window-capture.swift" "$root/benchmarks/desktop-latency/display-capture-authority.swift" "$root/benchmarks/desktop-latency/pixel-matcher.swift" -o "$out/window-capture" > "$out/compile-native.log" 2>&1
shasum -a 256 "$out/pixel-matcher-offline" "$out/window-capture" "$root/apps/browser-demos/node_modules/playwright-core/"{package.json,browsers.json} > "$out/binary-inputs.sha256"
cd "$root"
export KPERF_CURSOR_CONTROL_OUT="$out" KPERF_CURSOR_OBSERVER="$mode"
if [[ "$mode" == native ]];then
  "$out/window-capture" --preflight > "$out/preflight.json" 2> "$out/preflight-error.log"
  /usr/bin/caffeinate -di node_modules/.bin/tsx benchmarks/desktop-latency/response-observer-control.ts > "$out/run.log" 2>&1
else
  node_modules/.bin/tsx benchmarks/desktop-latency/response-observer-control.ts > "$out/run.log" 2>&1
fi
