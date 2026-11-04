#!/usr/bin/env bash
# macOS-only external display observer; it does not build Kandelo artifacts.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The native display observer requires macOS ScreenCaptureKit.' >&2
  exit 2
fi
mode="${2:-dom}"
case "$mode" in dom|offscreen) ;; *) echo 'Mode must be dom or offscreen.' >&2; exit 2;; esac
if [[ -n "${1:-}" ]]; then
  case "$1" in /*) out="$1";; *) out="$PWD/$1";; esac
  mkdir -p "$(dirname "$out")"
  # Refuse to overwrite a previous run, including its compiler and inputs.
  mkdir "$out"
else
  mkdir -p "$root/.context"
  out="$(mktemp -d "$root/.context/native-display-control-XXXXXXXX")"
fi
printf 'Native display control output: %s\n' "$out"
# This auxiliary observer uses Apple's installed SDK and frameworks. Resolve
# its declared native tools separately from the Nix SDK used for Kandelo.
# No PATH or canonical development-shell keep-list is expanded.
mac_tool() { /usr/bin/env -u DEVELOPER_DIR -u SDKROOT /usr/bin/xcrun "$@"; }
mac_tool swift --version > "$out/swift-version.txt" 2>&1
/usr/bin/sw_vers > "$out/os-version.txt"
mac_tool swiftc -O -parse-as-library "$root/benchmarks/desktop-latency/window-capture.swift" "$root/benchmarks/desktop-latency/pixel-matcher.swift" -o "$out/window-capture" > "$out/compile.log" 2>&1
cd "$root"
shasum -a 256 benchmarks/desktop-latency/{observer-control.ts,window-capture.swift,pixel-matcher.swift,clock-bounds.ts,observer-promises.ts,run-control.sh} "$out/window-capture" apps/browser-demos/node_modules/playwright-core/{package.json,browsers.json} > "$out/inputs.sha256"
cp benchmarks/desktop-latency/{observer-control.ts,window-capture.swift,pixel-matcher.swift,clock-bounds.ts,observer-promises.ts} "$out/"
"$out/window-capture" --preflight > "$out/preflight.json" 2> "$out/preflight-error.log"
export KPERF_NATIVE_METHOD_OUT="$out" KPERF_NATIVE_MODE="$mode"
# Keep this already-unlocked display awake only for this owned measurement.
# A manual lock still invalidates the run; no persistent setting is changed.
/usr/bin/caffeinate -di npx --no-install tsx benchmarks/desktop-latency/observer-control.ts > "$out/run.log" 2>&1
