#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/select-package-archive-source.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

name="libcurl-8.11.1-rev3-abi39-wasm32-d0c9d681.tar.zst"
canonical_sha=$(printf 'a%.0s' {1..64})
staging_sha=$(printf 'b%.0s' {1..64})
cat > "$TMP_ROOT/canonical.json" <<EOF
[{"name":"$name","size":123,"digest":"sha256:$canonical_sha"}]
EOF
cat > "$TMP_ROOT/staging.json" <<EOF
[{"name":"$name","size":124,"digest":"sha256:$staging_sha"}]
EOF

select_source() {
  bash "$SCRIPT" \
    --canonical-assets "$TMP_ROOT/canonical.json" \
    --staging-assets "$TMP_ROOT/staging.json" \
    --canonical-tag binaries-abi-v39 \
    --staging-tag pr-946-staging \
    --prefix libcurl- \
    --suffix -abi39-wasm32-d0c9d681.tar.zst
}

# A conflicting same-name staging envelope must never displace already
# published canonical bytes during stale-ledger repair.
selection=$(select_source)
jq -e \
  --arg name "$name" \
  --arg sha "$canonical_sha" \
  '.source == "canonical" and
   .source_tag == "binaries-abi-v39" and
   .archive_name == $name and
   .archive_sha256 == $sha and
   .archive_size == 123' \
  <<<"$selection" >/dev/null

printf '[]\n' > "$TMP_ROOT/canonical.json"
selection=$(select_source)
jq -e \
  --arg sha "$staging_sha" \
  '.source == "staging" and
   .source_tag == "pr-946-staging" and
   .archive_sha256 == $sha and
   .archive_size == 124' \
  <<<"$selection" >/dev/null

printf '[]\n' > "$TMP_ROOT/staging.json"
selection=$(select_source)
jq -e '.source == "build" and length == 1' <<<"$selection" >/dev/null

# A canonical name without a trustworthy release digest is not allowed to
# fall through to a staging artifact with different bytes.
cat > "$TMP_ROOT/canonical.json" <<EOF
[{"name":"$name","size":123,"digest":""}]
EOF
cat > "$TMP_ROOT/staging.json" <<EOF
[{"name":"$name","size":124,"digest":"sha256:$staging_sha"}]
EOF
if select_source >"$TMP_ROOT/untrusted.out" 2>"$TMP_ROOT/untrusted.err"; then
  echo "selector accepted canonical asset without a sha256 digest" >&2
  exit 1
fi
grep -q 'no trustworthy sha256 digest' "$TMP_ROOT/untrusted.err"

echo "package archive source selection tests passed"
