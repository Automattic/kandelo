#!/usr/bin/env bash
# The native mode operates only a newly launched, owned browser window.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
[[ "$(uname -s)" == Darwin ]] || { echo 'Requires the installed macOS compiler.' >&2; exit 2; }
mode="${2:-headless}"
case "$mode" in headless|native) ;; *) echo 'Mode must be headless or native.' >&2; exit 2;; esac
if [[ -n "${1:-}" ]];then
  case "$1" in /*) out="$1";; *) out="$PWD/$1";; esac
  mkdir -p "$(dirname "$out")";mkdir "$out"
else
  mkdir -p "$root/.scratch";out="$(mktemp -d "$root/.scratch/cursor-control-XXXXXXXX")"
fi
printf 'Cursor observer control (%s): %s\n' "$mode" "$out"
mac_tool() { /usr/bin/env -u DEVELOPER_DIR -u SDKROOT /usr/bin/xcrun "$@"; }
mac_tool swift --version > "$out/swift-version.txt" 2>&1
/usr/bin/sw_vers > "$out/os-version.txt"
mac_tool swiftc -O -parse-as-library "$root/benchmarks/desktop-latency/pixel-matcher.swift" "$root/benchmarks/desktop-latency/pixel-matcher-offline.swift" -o "$out/pixel-matcher-offline" > "$out/compile-offline.log" 2>&1
mac_tool swiftc -O -parse-as-library "$root/benchmarks/desktop-latency/window-capture.swift" "$root/benchmarks/desktop-latency/display-capture-authority.swift" "$root/benchmarks/desktop-latency/pixel-matcher.swift" -o "$out/window-capture" > "$out/compile-native.log" 2>&1
cd "$root"
shasum -a 256 benchmarks/desktop-latency/*.{ts,swift,sh} "$out/pixel-matcher-offline" "$out/window-capture" apps/browser-demos/node_modules/playwright-core/{package.json,browsers.json} > "$out/inputs.sha256"
mkdir "$out/source";cp benchmarks/desktop-latency/*.{ts,swift,sh} "$out/source/"
export KPERF_CURSOR_CONTROL_OUT="$out" KPERF_CURSOR_OBSERVER="$mode"
if [[ "$mode" == native ]];then
  "$out/window-capture" --preflight > "$out/preflight.json" 2> "$out/preflight-error.log"
  /usr/bin/caffeinate -di npx --no-install tsx benchmarks/desktop-latency/cursor-observer-control.ts > "$out/run.log" 2>&1
else
  npx --no-install tsx benchmarks/desktop-latency/cursor-observer-control.ts > "$out/run.log" 2>&1
fi
