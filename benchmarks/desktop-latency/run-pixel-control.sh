#!/usr/bin/env bash
# Offline controls: headless browsers and native pixel matching, no screen capture.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
[[ "$(uname -s)" == Darwin ]] || { echo 'The shared native matcher controls require macOS.' >&2; exit 2; }
if [[ -n "${1:-}" ]];then
  case "$1" in /*) out="$1";; *) out="$PWD/$1";; esac
  mkdir -p "$(dirname "$out")"; mkdir "$out"
else
  mkdir -p "$root/.context";out="$(mktemp -d "$root/.context/pixel-control-XXXXXXXX")"
fi
printf 'Headless pixel control output: %s\n' "$out"
mac_tool() { /usr/bin/env -u DEVELOPER_DIR -u SDKROOT /usr/bin/xcrun "$@"; }
mac_tool swift --version > "$out/swift-version.txt" 2>&1
/usr/bin/sw_vers > "$out/os-version.txt"
mac_tool swiftc -O -parse-as-library "$root/benchmarks/desktop-latency/pixel-matcher.swift" "$root/benchmarks/desktop-latency/pixel-matcher-offline.swift" -o "$out/pixel-matcher-offline" > "$out/compile-offline.log" 2>&1
mac_tool swiftc -O -parse-as-library "$root/benchmarks/desktop-latency/window-capture.swift" "$root/benchmarks/desktop-latency/display-capture-authority.swift" "$root/benchmarks/desktop-latency/pixel-matcher.swift" -o "$out/window-capture" > "$out/compile-native.log" 2>&1
cd "$root"
shasum -a 256 benchmarks/desktop-latency/{pixel-matcher.swift,pixel-matcher-offline.swift,pixel-template.ts,pixel-matcher-control.ts,window-capture.swift,display-capture-authority.swift,run-pixel-control.sh} "$out/pixel-matcher-offline" "$out/window-capture" apps/browser-demos/node_modules/playwright-core/{package.json,browsers.json} > "$out/inputs.sha256"
export KPERF_PIXEL_CONTROL_OUT="$out"
npx --no-install tsx benchmarks/desktop-latency/pixel-matcher-control.ts > "$out/run.log" 2>&1
