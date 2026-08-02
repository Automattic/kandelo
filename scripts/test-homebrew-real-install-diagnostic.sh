#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/scripts/run-homebrew-real-install-diagnostic.sh"
CONTRACT="$ROOT/homebrew/real-install-diagnostic.json"

bash -n "$RUNNER"
PYTHONDONTWRITEBYTECODE=1 python3 \
  "$ROOT/scripts/test-homebrew-real-install-diagnostic.py"
PYTHONDONTWRITEBYTECODE=1 python3 \
  "$ROOT/scripts/homebrew-real-install-diagnostic.py" check >/dev/null

jq -e '
  .diagnostic_only == true and
  (.selection.formula_order | length) == 25 and
  (.vfs.formula_order | length) == 24 and
  (.vfs.formula_order | index("homebrew-bootstrap") | not) and
  (.vfs.materialization_policy.embedded_package_order == [
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/ncurses",
    "kandelo-dev/tap-core/bash"
  ])
' "$CONTRACT" >/dev/null

for command in prepare prove-node prove-browser; do
  grep -Fq "$command" "$RUNNER"
done
grep -Fq -- '--image-contract real-install-diagnostic' "$RUNNER"
grep -Fq -- '--selection-tag' "$RUNNER"
grep -Fq 'fetch-selection-release' "$RUNNER"
grep -Fq 'verify-selection-readback' "$RUNNER"
grep -Fq -- '--core-bzip2-sha256' "$RUNNER"
grep -Fq -- '--core-dash-sha256' "$RUNNER"
grep -Fq 'homebrew-real-install-diagnostic.spec.ts' "$RUNNER"
grep -Fq \
  'KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT=' \
  "$RUNNER"

# WHY: the Playwright config alone translates its scoped input into Vite's
# public environment. Exposing the Vite name to the test worker is rejected
# before Chromium starts and would make the live proof impossible to run.
if grep -Fq \
  'VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT=' \
  "$RUNNER"; then
  echo "diagnostic runner bypasses the Playwright environment boundary" >&2
  exit 1
fi

if grep -Fq -- '--selection-root' "$RUNNER" ||
   grep -Fq -- '--selection-authorization' "$RUNNER"; then
  echo "diagnostic runner accepts caller-owned selection state" >&2
  exit 1
fi

# WHY: using either product lock would let a 25-Formula diagnostic appear to
# authorize the 41-Formula shipping shell. This runner owns neither pointer.
if grep -Eq \
  'main-shell-(selection-lock|homebrew-runtime-support)' "$RUNNER"; then
  echo "diagnostic runner references a main-shell product lock" >&2
  exit 1
fi

echo "test-homebrew-real-install-diagnostic: pass"
