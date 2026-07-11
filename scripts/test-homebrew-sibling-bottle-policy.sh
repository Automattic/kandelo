#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-sibling-bottle-policy.sh"

fail() {
  echo "test-homebrew-sibling-bottle-policy.sh: $*" >&2
  exit 1
}

metadata="$TMPDIR/metadata.json"
missing="$TMPDIR/missing.json"
cat >"$metadata" <<'JSON'
{
  "kandelo_abi": 40,
  "packages": [{
    "name": "sqlite",
    "version": "3.50.2_1",
    "formula_revision": 1,
    "bottle_rebuild": 2
  }]
}
JSON

policy() {
  homebrew_sibling_bottle_policy \
    "$1" sqlite "$2" "$3" "$4" "$5" \
    test-homebrew-sibling-bottle-policy.sh
}

[ "$(policy "$missing" 3.50.2_1 1 2 40)" = discard ] ||
  fail "missing metadata preserved a sibling bottle"
[ "$(policy "$metadata" 3.50.2_1 1 2 40)" = preserve ] ||
  fail "matching metadata discarded a sibling bottle"
[ "$(policy "$metadata" 3.50.3_1 1 2 40)" = discard ] ||
  fail "version transition preserved a sibling bottle"
[ "$(policy "$metadata" 3.50.2_1 2 2 40)" = discard ] ||
  fail "Formula revision transition preserved a sibling bottle"
[ "$(policy "$metadata" 3.50.2_1 1 3 40)" = discard ] ||
  fail "bottle rebuild transition preserved a sibling bottle"
[ "$(policy "$metadata" 3.50.2_1 1 2 41)" = discard ] ||
  fail "ABI transition preserved a sibling bottle"
homebrew_assert_published_abi_not_newer "$metadata" 40 \
  test-homebrew-sibling-bottle-policy.sh ||
  fail "same-ABI publication was rejected"
homebrew_assert_published_abi_not_newer "$metadata" 41 \
  test-homebrew-sibling-bottle-policy.sh ||
  fail "forward ABI transition was rejected"
if homebrew_assert_published_abi_not_newer "$metadata" 39 \
  test-homebrew-sibling-bottle-policy.sh >/dev/null 2>"$TMPDIR/stale.err"; then
  fail "older ABI publication was accepted after a newer ABI"
fi
grep -F "refusing stale ABI 39 publication after ABI 40" "$TMPDIR/stale.err" >/dev/null ||
  fail "stale ABI rejection did not identify both ABIs"
homebrew_assert_published_bottle_not_newer \
  "$metadata" sqlite 3.50.2_1 1 2 40 test-homebrew-sibling-bottle-policy.sh ||
  fail "same bottle rebuild was rejected"
homebrew_assert_published_bottle_not_newer \
  "$metadata" sqlite 3.50.2_1 1 3 40 test-homebrew-sibling-bottle-policy.sh ||
  fail "forward bottle rebuild was rejected"
homebrew_assert_published_bottle_not_newer \
  "$metadata" sqlite 3.50.3_1 1 1 40 test-homebrew-sibling-bottle-policy.sh ||
  fail "version transition was rejected as a stale bottle rebuild"
homebrew_assert_published_bottle_not_newer \
  "$metadata" sqlite 3.50.2_1 2 1 40 test-homebrew-sibling-bottle-policy.sh ||
  fail "Formula revision transition was rejected as a stale bottle rebuild"
if homebrew_assert_published_bottle_not_newer \
  "$metadata" sqlite 3.50.2_1 1 1 40 test-homebrew-sibling-bottle-policy.sh \
  >/dev/null 2>"$TMPDIR/stale-rebuild.err"; then
  fail "older bottle rebuild was accepted for the same package identity"
fi
grep -F "refusing stale sqlite bottle rebuild 1 after rebuild 2" \
  "$TMPDIR/stale-rebuild.err" >/dev/null ||
  fail "stale bottle rebuild rejection did not identify both rebuilds"

jq '.packages += [.packages[0]]' "$metadata" >"$TMPDIR/duplicates.json"
if policy "$TMPDIR/duplicates.json" 3.50.2_1 1 2 40 >/dev/null 2>&1; then
  fail "duplicate package metadata produced a sibling policy"
fi
ln -s metadata.json "$TMPDIR/symlink.json"
if policy "$TMPDIR/symlink.json" 3.50.2_1 1 2 40 >/dev/null 2>&1; then
  fail "symlinked metadata produced a sibling policy"
fi

tap="$TMPDIR/tap"
mkdir -p "$tap/Formula" "$tap/Kandelo"
cp "$metadata" "$tap/Kandelo/metadata.json"
cat >"$tap/Formula/sqlite.rb" <<'RUBY'
class Sqlite < Formula
  desc "fixture"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    rebuild 2
    sha256 cellar: :any_skip_relocation, wasm64_kandelo: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end
end
RUBY
cp "$tap/Formula/sqlite.rb" "$TMPDIR/planned.rb"
selected_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
jq -n --arg sha "$selected_sha" '{
  sqlite: {
    formula: {
      name: "sqlite",
      path: "Library/Taps/automattic/homebrew-kandelo-homebrew/Formula/sqlite.rb",
      pkg_version: "3.50.2_1"
    },
    bottle: {
      root_url: "https://ghcr.io/v2/automattic/kandelo-homebrew",
      cellar: "any_skip_relocation",
      rebuild: 2,
      tags: {wasm32_kandelo: {sha256: $sha}}
    }
  }
}' >"$TMPDIR/bottle.json"

merge_args=(
  --tap-root "$tap"
  --tap-repository Automattic/kandelo-homebrew
  --formula sqlite
  --arch wasm32
  --release-tag bottles-abi-v40
  --bottle-json "$TMPDIR/bottle.json"
  --expected-sha256 "$selected_sha"
  --expected-root-url https://ghcr.io/v2/automattic/kandelo-homebrew
  --expected-cellar any_skip_relocation
)
bash "$REPO_ROOT/scripts/homebrew-merge-bottle-json.sh" "${merge_args[@]}" >/dev/null
grep -F 'wasm64_kandelo: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
  "$tap/Formula/sqlite.rb" >/dev/null ||
  fail "canonical metadata composition discarded a matching sibling bottle"

cp "$TMPDIR/planned.rb" "$tap/Formula/sqlite.rb"
jq '.kandelo_abi = 41' "$metadata" >"$tap/Kandelo/metadata.json"
bash "$REPO_ROOT/scripts/homebrew-merge-bottle-json.sh" "${merge_args[@]}" >/dev/null
if grep -F 'wasm64_kandelo:' "$tap/Formula/sqlite.rb" >/dev/null; then
  fail "canonical metadata composition retained a sibling across an ABI transition"
fi

echo "test-homebrew-sibling-bottle-policy.sh: ok"
