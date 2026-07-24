#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$SCRIPT_DIR/compose-staging-finalization.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
XTASK="${XTASK:-$REPO_ROOT/target/$HOST_TARGET/release/xtask}"
if [ ! -x "$XTASK" ]; then
  cargo build --release -p xtask --target "$HOST_TARGET"
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

make_archive() {
  local name="$1" version="$2" revision="$3" cache_key="$4" output="$5"
  local source="$TMP_ROOT/archive-source-$name-$version-$revision-${cache_key:0:8}"
  mkdir -p "$source/artifacts/lib"
  cat >"$source/manifest.toml" <<EOF
kind = "library"
name = "$name"
version = "$version"
revision = $revision
depends_on = []

[source]
url = "https://example.test/$name.tar.gz"
sha256 = "$(printf '0%.0s' {1..64})"

[license]
spdx = "MIT"

[outputs]
libs = ["lib/lib$name.a"]

[compatibility]
target_arch = "wasm32"
abi_versions = [39]
cache_key_sha = "$cache_key"
EOF
  printf 'archive bytes\n' >"$source/artifacts/lib/lib$name.a"
  (
    cd "$source"
    COPYFILE_DISABLE=1 tar --format=ustar -cf - manifest.toml artifacts |
      zstd -q -o "$output"
  )
}

OLD_KEY="$(printf 'a%.0s' {1..64})"
NEW_KEY="$(printf 'b%.0s' {1..64})"
OLD_NAME="zlib-1.0-rev1-abi39-wasm32-${OLD_KEY:0:8}.tar.zst"
NEW_NAME="zlib-2.0-rev2-abi39-wasm32-${NEW_KEY:0:8}.tar.zst"

mkdir -p "$TMP_ROOT/baseline/archives" "$TMP_ROOT/artifacts/zlib-wasm32"
make_archive zlib 1.0 1 "$OLD_KEY" "$TMP_ROOT/baseline/archives/$OLD_NAME"
make_archive zlib 2.0 2 "$NEW_KEY" "$TMP_ROOT/artifacts/zlib-wasm32/$NEW_NAME"
OLD_ARCHIVE_SHA="$(sha256_file "$TMP_ROOT/baseline/archives/$OLD_NAME")"

cat >"$TMP_ROOT/baseline/archives/index.toml" <<EOF
abi_version = 39
generated_at = "2026-07-23T00:00:00Z"
generator = "test baseline"

[[packages]]
name = "retired"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "retired.tar.zst"
archive_sha256 = "$(printf 'c%.0s' {1..64})"
cache_key_sha = "$(printf 'd%.0s' {1..64})"
built_at = "2026-07-23T00:00:00Z"
built_by = "test"

[[packages]]
name = "zlib"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "$OLD_NAME"
archive_sha256 = "$OLD_ARCHIVE_SHA"
cache_key_sha = "$OLD_KEY"
built_at = "2026-07-23T00:00:00Z"
built_by = "test"
EOF

cat >"$TMP_ROOT/expected.json" <<EOF
{
  "abi_version": 39,
  "entries": [{
    "package": "zlib",
    "kind": "library",
    "arch": "wasm32",
    "version": "2.0",
    "revision": 2,
    "cache_key_sha": "$NEW_KEY",
    "git_inputs": []
  }]
}
EOF
cat >"$TMP_ROOT/matrix.json" <<EOF
[{"package":"zlib","arch":"wasm32","sha":"$NEW_KEY","version":"2.0","revision":2}]
EOF

bash "$SCRIPT" \
  --target-tag pr-1087-staging \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --matrix "$TMP_ROOT/matrix.json" \
  --artifacts-dir "$TMP_ROOT/artifacts" \
  --baseline-dir "$TMP_ROOT/baseline" \
  --output-dir "$TMP_ROOT/success" \
  --xtask "$XTASK" \
  --abi 39 \
  --built-at 2026-07-24T00:00:00Z \
  --built-by https://example.test/run/1

[ "$(cat "$TMP_ROOT/success/had-failures")" = 0 ]
jq -e --arg name "$NEW_NAME" \
  'length == 1 and .[0].name == $name' "$TMP_ROOT/success/assets.json" >/dev/null
jq -e '.packages == [{name:"zlib",arch:"wasm32",status:"built",sha:"'"$NEW_KEY"'"}]' \
  "$TMP_ROOT/success/publish-status.json" >/dev/null
grep -Fq 'version = "2.0"' "$TMP_ROOT/success/index.toml"
if grep -Fq 'retired' "$TMP_ROOT/success/index.toml" ||
   grep -Fq 'version = "1.0"' "$TMP_ROOT/success/index.toml"; then
  echo "compose staging test: stale or unrelated baseline package survived" >&2
  exit 1
fi

# A missing matrix artifact is a package failure, not an incomplete release.
# The complete index keeps the same-version verified baseline as last-green
# and reports the failed current attempt.
FAIL_KEY="$(printf 'e%.0s' {1..64})"
cat >"$TMP_ROOT/failure-expected.json" <<EOF
{
  "abi_version": 39,
  "entries": [{
    "package": "zlib",
    "kind": "library",
    "arch": "wasm32",
    "version": "1.0",
    "revision": 1,
    "cache_key_sha": "$FAIL_KEY",
    "git_inputs": []
  }]
}
EOF
cat >"$TMP_ROOT/failure-matrix.json" <<EOF
[{"package":"zlib","arch":"wasm32","sha":"$FAIL_KEY","version":"1.0","revision":1}]
EOF
mkdir "$TMP_ROOT/no-artifacts"
bash "$SCRIPT" \
  --target-tag pr-1088-staging \
  --expected-ledger "$TMP_ROOT/failure-expected.json" \
  --matrix "$TMP_ROOT/failure-matrix.json" \
  --artifacts-dir "$TMP_ROOT/no-artifacts" \
  --baseline-dir "$TMP_ROOT/baseline" \
  --output-dir "$TMP_ROOT/failure" \
  --xtask "$XTASK" \
  --abi 39 \
  --built-at 2026-07-24T00:00:00Z \
  --built-by https://example.test/run/2

[ "$(cat "$TMP_ROOT/failure/had-failures")" = 1 ]
jq -e --arg name "$OLD_NAME" \
  'length == 1 and .[0].name == $name' "$TMP_ROOT/failure/assets.json" >/dev/null
jq -e '.packages[0].status == "failed"' "$TMP_ROOT/failure/publish-status.json" >/dev/null
grep -Fq 'status = "failed"' "$TMP_ROOT/failure/index.toml"
grep -Fq "fallback_archive_url = \"$OLD_NAME\"" "$TMP_ROOT/failure/index.toml"

echo "staging finalization composition tests passed"
