#!/usr/bin/env bash
# Decode-time comparison of two FFmpeg builds (with and without wasm
# simd128) as Kandelo processes on the Node host. Results are bounded to
# FFmpeg single-threaded decode of the given input; each run includes
# Kandelo kernel start-up, which is the same for both builds.
#
#   RUNS=5 simd-bench.sh <ffmpeg-with-simd> <ffmpeg-without-simd> <input>
#
# Prints CSV rows: build,run,seconds
set -euo pipefail
exec < /dev/null
REPO_ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
WITH="$1"; WITHOUT="$2"; INPUT="$3"; RUNS="${RUNS:-5}"
TSX_ESM="$(cd "$REPO_ROOT" && node -p 'require("url").pathToFileURL(require.resolve("tsx/esm")).href')"
export KANDELO_RUNNER_BUILTINS=explicit TIMEOUT=3600000
for i in $(seq "$RUNS"); do
  # Interleave the builds so drifting machine load affects both alike.
  for label in with without; do
    bin="$WITH"; [ "$label" = without ] && bin="$WITHOUT"
    s=$EPOCHREALTIME
    node --experimental-wasm-exnref --import "$TSX_ESM" "$REPO_ROOT/examples/run-example.ts" \
      "$bin" -nostdin -v error -threads 1 -i "$INPUT" -map 0:v -f null - > /dev/null
    e=$EPOCHREALTIME
    echo "$label,$i,$(awk -v a="$s" -v b="$e" 'BEGIN{printf "%.3f", b-a}')"
  done
done
