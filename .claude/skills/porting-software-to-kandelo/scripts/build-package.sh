#!/usr/bin/env bash
# Build one registry package through the normal resolver path (the command in
# docs/porting-guide.md "4. Verify locally") with the log kept out of the
# transcript: full output goes to .context/, the caller sees one status line
# plus, on failure, the first error lines and the end of the log.
#
# Usage: bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh <package> [wasm32|wasm64]
set -uo pipefail

pkg="${1:?usage: build-package.sh <package> [wasm32|wasm64]}"
arch="${2:-wasm32}"
repo="$(git rev-parse --show-toplevel)"
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
    # The first error is usually the cause; later ones are fallout.
    echo "first error lines:"
    grep -n -m 5 -E 'error:|FAILED|mismatch|NOT match|No such file|not found|exited with' "$log" | cut -c1-300
    echo "last lines:"
    tail -n 15 "$log" | cut -c1-300
fi
exit "$rc"
