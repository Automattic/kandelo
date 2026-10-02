#!/usr/bin/env bash
# Apply or remove the fork-stack hook and rebuild host/dist so both the kernel
# worker and process workers run it. Usage: oracle-host.sh on|off
# (under scripts/dev-shell.sh, repo root).
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
PATCH="$ROOT/tools/fork-path-research/oracle-fork-stack-log.patch"
case "$1" in
  on) git -C "$ROOT" apply --check "$PATCH" && git -C "$ROOT" apply "$PATCH" ;;
  off) git -C "$ROOT" apply -R --check "$PATCH" && git -C "$ROOT" apply -R "$PATCH" ;;
esac
(cd "$ROOT/host" && npx tsup > "$ROOT/.context/fpr/oracle/tsup-$1.log" 2>&1)
echo "host hook $1; dist rebuilt"
