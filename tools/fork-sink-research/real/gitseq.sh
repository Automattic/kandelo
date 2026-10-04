#!/usr/bin/env bash
# gitseq.sh <git.wasm> <label>   (guest /tmp is the host /tmp: start clean)
ROOT=$(git rev-parse --show-toplevel); G=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); B=$ROOT/local-binaries/source-only-v1/programs/wasm32
rm -rf /tmp/r
SEQ_EXEC="/opt/gx/git=$G,/opt/gx/sh=$B/dash.wasm" SEQ_ENV="GIT_EXEC_PATH=/opt/gx" \
  npx tsx "$ROOT/tools/fork-sink-research/real/run-seq.ts" "$G" git "$ROOT/tools/fork-sink-research/real/git-cmds.json" > "$ROOT/.context/real/$2.out" 2>&1
echo "$2 exit=$? $(grep -c ' -> 0$' "$ROOT/.context/real/$2.out") ok of $(grep -c '^\[run-seq\]' "$ROOT/.context/real/$2.out")"
rm -rf /tmp/r
