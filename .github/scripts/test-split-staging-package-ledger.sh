#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="$SCRIPT_DIR/split-staging-package-ledger.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-split-staging-package-ledger: $*" >&2
  exit 1
}

cat > "$TMP_ROOT/expected.json" <<'JSON'
{
  "abi_version": 42,
  "entries": [
    {
      "package": "bash",
      "kind": "program",
      "arch": "wasm32",
      "version": "5.2",
      "revision": 1,
      "cache_key_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "git_inputs": []
    },
    {
      "package": "homebrew-bootstrap",
      "kind": "program",
      "arch": "wasm32",
      "version": "6.0.4",
      "revision": 4,
      "cache_key_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "git_inputs": []
    },
    {
      "package": "shell",
      "kind": "program",
      "arch": "wasm32",
      "version": "0.1.0",
      "revision": 2,
      "cache_key_sha": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "git_inputs": []
    }
  ]
}
JSON

cat > "$TMP_ROOT/matrix.json" <<'JSON'
[
  {
    "package": "homebrew-bootstrap",
    "arch": "wasm32",
    "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "version": "6.0.4",
    "revision": 4
  }
]
JSON

bash "$HELPER" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --selected-matrix "$TMP_ROOT/matrix.json" \
  --selected-output "$TMP_ROOT/selected.json" \
  --complement-output "$TMP_ROOT/complement.json"

jq -e '
  .abi_version == 42 and
  [.entries[].package] == ["homebrew-bootstrap"]
' "$TMP_ROOT/selected.json" >/dev/null ||
  fail "selected output does not contain only the exact PR entry"
jq -e '
  .abi_version == 42 and
  [.entries[].package] == ["bash", "shell"]
' "$TMP_ROOT/complement.json" >/dev/null ||
  fail "canonical complement does not contain every unchanged entry"

expect_rejected() {
  local name="$1"
  local matrix="$2"
  if bash "$HELPER" \
      --expected-ledger "$TMP_ROOT/expected.json" \
      --selected-matrix "$matrix" \
      --selected-output "$TMP_ROOT/$name-selected.json" \
      --complement-output "$TMP_ROOT/$name-complement.json" \
      >/dev/null 2>&1; then
    fail "accepted invalid selected matrix: $name"
  fi
}

for field in package arch sha version revision; do
  jq --arg field "$field" '
    .[0] |= if $field == "package" then .package = "missing"
      elif $field == "arch" then .arch = "wasm64"
      elif $field == "sha" then .sha = ("d" * 64)
      elif $field == "version" then .version = "older"
      else .revision = 3 end
  ' "$TMP_ROOT/matrix.json" > "$TMP_ROOT/wrong-$field.json"
  expect_rejected "wrong-$field" "$TMP_ROOT/wrong-$field.json"
done

jq '. + [.[0]]' "$TMP_ROOT/matrix.json" > "$TMP_ROOT/duplicate.json"
expect_rejected duplicate "$TMP_ROOT/duplicate.json"
jq '.[0].unexpected = true' "$TMP_ROOT/matrix.json" > "$TMP_ROOT/extra.json"
expect_rejected extra "$TMP_ROOT/extra.json"
printf '[]\n' > "$TMP_ROOT/empty.json"
expect_rejected empty "$TMP_ROOT/empty.json"

echo "test-split-staging-package-ledger: all tests passed"
