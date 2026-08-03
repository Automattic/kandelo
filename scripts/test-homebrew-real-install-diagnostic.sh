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

for command in prepare prove-node prove-browser verify-independent-tap; do
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

# WHY: a syntactically valid revision can still predate the independent
# Formula or its generated bottle metadata. Fetch the exact public commit now
# so this mistake fails before an expensive VFS composition or guest boot.
independent_test_root="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-independent-tap.XXXXXX")"
cleanup_independent_test() {
  rm -rf -- "$independent_test_root"
}
trap cleanup_independent_test EXIT
"$RUNNER" verify-independent-tap \
  --work-dir "$independent_test_root/check"
jq -e \
  --arg revision "$(jq -er '.lifecycle.independent_revision' "$CONTRACT")" '
  .schema == 1 and
  .kind == "kandelo-homebrew-real-install-independent-tap-check" and
  .revision == $revision and
  (.formula_sha256 | test("^[0-9a-f]{64}$")) and
  (.metadata_sha256 | test("^[0-9a-f]{64}$")) and
  (.bottle_sha256 | test("^[0-9a-f]{64}$")) and
  (.bottle_bytes | type == "number" and . > 0) and
  (.bottle_url == (
    "https://ghcr.io/v2/brandonpayton/homebrew-kandelo-canary/" +
    "m4-canary/blobs/sha256:" + .bottle_sha256
  ))
' "$independent_test_root/check/independent-tap-check.json" >/dev/null

echo "test-homebrew-real-install-diagnostic: pass"
