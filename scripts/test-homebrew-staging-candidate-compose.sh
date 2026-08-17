#!/usr/bin/env bash
# Focused regression for reconstructing a nonendorsed candidate Formula block.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/tap/Formula" "$TMP_ROOT/tap/Kandelo"
cat >"$TMP_ROOT/tap/Formula/asa.rb" <<'RUBY'
class Asa < Formula
  desc "Miniature candidate composition fixture"
  homepage "https://example.invalid/asa"
  url "https://example.invalid/asa-15.0.0.tar.gz"
  sha256 "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    rebuild 1
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  end
end
RUBY
printf '%s\n' '{"kandelo_abi":7,"packages":[]}' \
  >"$TMP_ROOT/tap/Kandelo/metadata.json"

SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ROOT_URL="https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-8-candidates/asa"
jq -ncS \
  --arg sha256 "$SHA256" --arg root "$ROOT_URL" '
  {asa: {
    bottle: {cellar: "any_skip_relocation", rebuild: 1, root_url: $root,
      tags: {wasm32_kandelo: {sha256: $sha256}}},
    formula: {name: "asa", path:
      "Library/Taps/kandelo-dev/homebrew-tap-core/Formula/asa.rb",
      pkg_version: "15.0.0"}
  }}' >"$TMP_ROOT/bottle.json"

bash "$REPO_ROOT/scripts/homebrew-merge-bottle-json.sh" \
  --tap-root "$TMP_ROOT/tap" \
  --tap-repository kandelo-dev/homebrew-tap-core \
  --formula asa \
  --arch wasm32 \
  --release-tag bottles-abi-v8 \
  --bottle-json "$TMP_ROOT/bottle.json" \
  --expected-sha256 "$SHA256" \
  --expected-root-url "$ROOT_URL" \
  --expected-cellar any_skip_relocation \
  --staging-candidate-abi 8

grep -F "root_url \"$ROOT_URL\"" "$TMP_ROOT/tap/Formula/asa.rb" >/dev/null
grep -F "wasm32_kandelo: \"$SHA256\"" "$TMP_ROOT/tap/Formula/asa.rb" >/dev/null

if bash "$REPO_ROOT/scripts/homebrew-merge-bottle-json.sh" \
    --tap-root "$TMP_ROOT/tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula asa \
    --arch wasm32 \
    --release-tag bottles-abi-v8 \
    --bottle-json "$TMP_ROOT/bottle.json" \
    --expected-sha256 "$SHA256" \
    --expected-root-url \
      https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-9-candidates/asa \
    --expected-cellar any_skip_relocation \
    --staging-candidate-abi 8 >/dev/null 2>&1; then
  echo "candidate composer accepted a different ABI namespace" >&2
  exit 1
fi

echo "homebrew staging candidate compose tests passed"
