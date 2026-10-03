#!/usr/bin/env bash
# Dynamic fork-stack oracle. Run under scripts/dev-shell.sh from the repo root:
#   oracle.sh <twin.wasm> <installed-binary> <stack-log> -- <command...>
# Instruments the analysis twin (the pre-wasm-opt link with names) with the
# repository instrumenter, temporarily installs it over <installed-binary>
# (e.g. local-binaries/source-only-v1/programs/wasm32/bash.wasm), applies the
# KANDELO_FORK_STACK_LOG host hook, runs the command, then restores both.
# Every fork capture appends the complete JS/Wasm stack to <stack-log>.
set -uo pipefail
ROOT=$(git rev-parse --show-toplevel)
TWIN=$1 DEST=$2 LOG=$3; shift 3; [ "$1" = "--" ] && shift
PATCH="$ROOT/tools/fork-sink-research/fpr/oracle-fork-stack-log.patch"
INSTR="$(dirname "$LOG")/$(basename "$TWIN" .wasm).instr.wasm"
"$ROOT/tools/bin/wasm-fork-instrument" "$TWIN" -o "$INSTR" || exit 1
cp -p "$DEST" "$DEST.oracle-backup" || exit 1
# Process workers load host/dist/worker-entry.js whenever it exists (no
# freshness check), so move it aside to make them bundle the patched source.
DIST="$ROOT/host/dist/worker-entry.js"
[ -f "$DIST" ] && mv "$DIST" "$DIST.oracle-aside"
restore() {
  mv -f "$DEST.oracle-backup" "$DEST"
  git -C "$ROOT" apply -R "$PATCH" 2>/dev/null
  [ -f "$DIST.oracle-aside" ] && mv -f "$DIST.oracle-aside" "$DIST"
}
trap restore EXIT
git -C "$ROOT" apply "$PATCH" || exit 1
cp "$INSTR" "$DEST"
: > "$LOG"
KANDELO_FORK_STACK_LOG="$LOG" "$@"
echo "oracle: command exit=$?; fork captures: $(grep -c '^== ' "$LOG")"
