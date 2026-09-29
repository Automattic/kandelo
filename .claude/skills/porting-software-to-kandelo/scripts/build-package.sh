#!/usr/bin/env bash
# Build one registry package through the normal resolver path (the command in
# docs/porting-guide.md "4. Verify locally") with the log kept out of the
# transcript: full output goes to .context/, the caller sees one status line
# plus a failure summary.
#
# Usage: bash .claude/skills/porting-software-to-kandelo/scripts/build-package.sh <package> [wasm32|wasm64]
set -uo pipefail

pkg="${1:?usage: build-package.sh <package> [wasm32|wasm64]}"
arch="${2:-wasm32}"
repo="$(git rev-parse --show-toplevel)"
here="$(cd "$(dirname "$0")" && pwd)"
log="$repo/.context/build-$pkg-$arch.log"
mkdir -p "$repo/.context"
cd "$repo"

start=$(date +%s)
scripts/dev-shell.sh bash -lc '
  set -euo pipefail
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  cargo run -q -p xtask --target "$host_target" -- build-deps resolve "$1" \
    --arch "$2" --binaries-dir "$(pwd)/binaries"
' _ "$pkg" "$arch" >"$log" 2>&1
rc=$?

echo "build $pkg ($arch): exit=$rc after $(( $(date +%s) - start ))s; full log: $log"
if [ "$rc" -eq 0 ]; then
    echo "resolved: $(tail -n 1 "$log")"
else
    python3 "$here/../../diagnosing-kandelo-build-failures/scripts/diagnose-build-log.py" "$log"
fi
exit "$rc"
