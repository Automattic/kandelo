#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_TOOL="$REPO_ROOT/scripts/homebrew-main-shell-product-state.py"
EXTRACTOR="$REPO_ROOT/scripts/extract-homebrew-support-data-bottle.ts"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-homebrew-main-shell-product-state: $*" >&2
  exit 1
}

expect_failure() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    fail "command unexpectedly succeeded: $*"
  fi
  grep -Fq -- "$expected" <<<"$output" || {
    printf '%s\n' "$output" >&2
    fail "failure did not contain: $expected"
  }
}

fixture="$TMP_ROOT/product"
mkdir -p \
  "$fixture/homebrew"
cp "$REPO_ROOT/homebrew/main-shell-selection-lock.json" \
  "$fixture/homebrew/main-shell-selection-lock.json"
cp "$REPO_ROOT/homebrew/main-shell-lazy-artifact-lock.json" \
  "$fixture/homebrew/main-shell-lazy-artifact-lock.json"
for input in \
  main-shell.Brewfile \
  kandelo-guest-layout.json \
  main-shell-migration-lock.json \
  main-shell-homebrew-runtime-support.json \
  main-shell-brew-package-tree.json \
  main-shell-demo.json \
  main-shell-materialization-policy.json \
  main-shell-default.json
do
  cp "$REPO_ROOT/homebrew/$input" "$fixture/homebrew/$input"
done

# Product review may append source roots while the checked-in historical locks
# deliberately remain unchanged. Build the coherent pending-lock fixture that
# the review-only finalizer would emit; this test owns state classification,
# not whether the retired closed-selection lane may publish those roots.
brewfile_sha="$(sha256sum "$fixture/homebrew/main-shell.Brewfile")"
brewfile_sha="${brewfile_sha%% *}"
jq --arg sha "$brewfile_sha" \
  '.inputs.brewfile.sha256 = $sha' \
  "$fixture/homebrew/main-shell-selection-lock.json" \
  >"$fixture/homebrew/selection.next"
mv "$fixture/homebrew/selection.next" \
  "$fixture/homebrew/main-shell-selection-lock.json"
selection_sha="$(sha256sum \
  "$fixture/homebrew/main-shell-selection-lock.json")"
selection_sha="${selection_sha%% *}"
jq --arg brewfile "$brewfile_sha" --arg selection "$selection_sha" \
  '.inputs.brewfile_sha256 = $brewfile |
   .inputs.selection_lock_sha256 = $selection' \
  "$fixture/homebrew/main-shell-lazy-artifact-lock.json" \
  >"$fixture/homebrew/artifact.next"
mv "$fixture/homebrew/artifact.next" \
  "$fixture/homebrew/main-shell-lazy-artifact-lock.json"
baseline_selection="$TMP_ROOT/main-shell-selection-lock.json"
cp "$fixture/homebrew/main-shell-selection-lock.json" "$baseline_selection"

[ "$(python3 "$STATE_TOOL" --root "$fixture")" = awaiting-selection ] ||
  fail "pending selection was not classified as awaiting-selection"

# A pending lock is an honest description of missing publication state, not
# permission to ignore changed inputs. Otherwise CI could skip a shell change
# after the checked-in lock stopped describing that change.
printf '\n' >>"$fixture/homebrew/main-shell.Brewfile"
expect_failure \
  "main-shell selection input digest changed: homebrew/main-shell.Brewfile" \
  python3 "$STATE_TOOL" --root "$fixture"
cp "$REPO_ROOT/homebrew/main-shell.Brewfile" \
  "$fixture/homebrew/main-shell.Brewfile"

sed 's/"state": "pending"/"state": "pending", "state": "pending"/' \
  "$REPO_ROOT/homebrew/main-shell-selection-lock.json" \
  >"$fixture/homebrew/main-shell-selection-lock.json"
expect_failure "JSON repeats key 'state'" \
  python3 "$STATE_TOOL" --root "$fixture"
cp "$baseline_selection" \
  "$fixture/homebrew/main-shell-selection-lock.json"

jq '.state = "sealed" | .release = {
  repository: "kandelo-dev/homebrew-tap-core",
  tag: "homebrew-prefix-selection-sha256-1111111111111111111111111111111111111111111111111111111111111111"
}' "$fixture/homebrew/main-shell-selection-lock.json" \
  >"$fixture/homebrew/selection.next"
mv "$fixture/homebrew/selection.next" \
  "$fixture/homebrew/main-shell-selection-lock.json"
selection_sha="$(sha256sum \
  "$fixture/homebrew/main-shell-selection-lock.json")"
selection_sha="${selection_sha%% *}"
jq --arg sha "$selection_sha" \
  '.inputs.selection_lock_sha256 = $sha' \
  "$fixture/homebrew/main-shell-lazy-artifact-lock.json" \
  >"$fixture/homebrew/artifact.next"
mv "$fixture/homebrew/artifact.next" \
  "$fixture/homebrew/main-shell-lazy-artifact-lock.json"
[ "$(python3 "$STATE_TOOL" --root "$fixture")" = candidate ] ||
  fail "sealed selection with pending image was not a candidate"

jq '.state = "sealed" | .image = {
  sha256: "2222222222222222222222222222222222222222222222222222222222222222",
  bytes: 4096
}' "$fixture/homebrew/main-shell-lazy-artifact-lock.json" \
  >"$fixture/homebrew/artifact.next"
mv "$fixture/homebrew/artifact.next" \
  "$fixture/homebrew/main-shell-lazy-artifact-lock.json"
[ "$(python3 "$STATE_TOOL" --root "$fixture")" = publishable ] ||
  fail "sealed selection and image were not publishable"

jq '.state = "pending" | .release = null' \
  "$fixture/homebrew/main-shell-selection-lock.json" \
  >"$fixture/homebrew/selection.next"
mv "$fixture/homebrew/selection.next" \
  "$fixture/homebrew/main-shell-selection-lock.json"
selection_sha="$(sha256sum \
  "$fixture/homebrew/main-shell-selection-lock.json")"
selection_sha="${selection_sha%% *}"
jq --arg sha "$selection_sha" \
  '.inputs.selection_lock_sha256 = $sha' \
  "$fixture/homebrew/main-shell-lazy-artifact-lock.json" \
  >"$fixture/homebrew/artifact.next"
mv "$fixture/homebrew/artifact.next" \
  "$fixture/homebrew/main-shell-lazy-artifact-lock.json"
expect_failure \
  "selection and artifact publication states disagree" \
  python3 "$STATE_TOOL" --root "$fixture"

# A source tap is not a closed product selection. In particular, generated
# Formulae may exist only in a prepared campaign tree. Exercise the real typed
# extractor so CI cannot reintroduce the old raw-tap fallback accidentally.
raw_tap="$TMP_ROOT/raw-tap"
mkdir -p "$raw_tap/Kandelo"
cp "$REPO_ROOT/homebrew/homebrew-tap-core/Kandelo/examples/metadata.json" \
  "$raw_tap/Kandelo/metadata.json"
git -C "$raw_tap" init -q
git -C "$raw_tap" config user.email \
  homebrew-product-state-test@example.invalid
git -C "$raw_tap" config user.name "Homebrew product-state test"
git -C "$raw_tap" add Kandelo/metadata.json
git -C "$raw_tap" commit -qm "[Homebrew/Test] Add raw tap fixture"
raw_sha="$(git -C "$raw_tap" rev-parse HEAD)"
expect_failure \
  'tap metadata must contain exactly one package named "homebrew-bootstrap"' \
  "$REPO_ROOT/node_modules/.bin/tsx" "$EXTRACTOR" \
    --tap-root "$raw_tap" \
    --expected-tap-sha "$raw_sha" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-name kandelo-dev/tap-core \
    --package homebrew-bootstrap \
    --arch wasm32 \
    --expected-abi 15 \
    --output-directory "$TMP_ROOT/raw-output"

grep -Fq \
  "needs.homebrew-main-shell-scope.outputs.selection_ready == 'true'" \
  "$REPO_ROOT/.github/workflows/homebrew-main-shell-ci.yml" ||
  fail "exact product job is not gated by the sealed selection"
grep -Fq 'awaiting-selection:skipped)' \
  "$REPO_ROOT/.github/workflows/homebrew-main-shell-ci.yml" ||
  fail "pending product selection is not reported as an honest skip"
grep -Fq 'git -C "$tap_root" fetch --depth=1 origin "$tap_sha"' \
  "$REPO_ROOT/.github/workflows/homebrew-main-shell-ci.yml" &&
  fail "workflow still substitutes a raw tap for a pending selection"

echo "test-homebrew-main-shell-product-state: ok"
