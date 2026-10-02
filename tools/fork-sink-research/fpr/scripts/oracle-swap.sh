#!/usr/bin/env bash
# Run a command with an instrumented analysis twin installed over a binary,
# recording fork stacks (requires `oracle-host.sh on`). Restores on exit.
#   oracle-swap.sh <twin.wasm> <installed-binary> <stack-log> -- <command...>
set -uo pipefail
ROOT=$(git rev-parse --show-toplevel)
TWIN=$1 DEST=$2 LOG=$3; shift 3; [ "$1" = "--" ] && shift
INSTR="$(dirname "$LOG")/$(basename "$TWIN" .wasm).instr.wasm"
[ -f "$INSTR" ] || "$ROOT/tools/bin/wasm-fork-instrument" "$TWIN" -o "$INSTR" || exit 1
cp -p "$DEST" "$DEST.oracle-backup" || exit 1
trap 'mv -f "$DEST.oracle-backup" "$DEST"' EXIT
cp "$INSTR" "$DEST"
: > "$LOG"
KANDELO_FORK_STACK_LOG="$LOG" "$@"
echo "oracle: command exit=$?; fork captures: $(grep -c '^== ' "$LOG")"
