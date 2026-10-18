#!/usr/bin/env bash
# FATE --target-exec wrapper: run one target program as a Kandelo process.
#
# FATE's make and shell run on the host; every target program FATE
# launches (ffmpeg, ffprobe, and the libav*/tests helpers) runs here, in a
# fresh Kandelo kernel, with the host filesystem visible.
#
# run-example reads a non-terminal stdin to end-of-file before starting the
# guest, so FATE must be run with stdin from /dev/null (run-fate.sh does);
# a test that pipes data into a program still gets a pipe that closes.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
TSX_ESM="$(cd "$REPO_ROOT" && node -p 'require("url").pathToFileURL(require.resolve("tsx/esm")).href')"
export TIMEOUT="${KANDELO_FATE_TIMEOUT_MS:-600000}"
# FATE programs are resolved by path; no built-in program table is needed.
export KANDELO_RUNNER_BUILTINS=explicit
exec node --experimental-wasm-exnref --import "$TSX_ESM" \
    "$REPO_ROOT/examples/run-example.ts" "$@"
