#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
PR_TOML="$REPO_ROOT/packages/registry/zlib/package.pr.toml"
HAD_PR_TOML=false
if [ -f "$PR_TOML" ]; then
  HAD_PR_TOML=true
  cp "$PR_TOML" "$TMP/package.pr.toml.backup"
fi
cleanup() {
  if [ "$HAD_PR_TOML" = true ]; then
    cp "$TMP/package.pr.toml.backup" "$PR_TOML"
  else
    rm -f "$PR_TOML"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
rm -f "$PR_TOML"
cd "$REPO_ROOT"

ARCHIVE_ROOT="$TMP/artifacts"
mkdir -p "$ARCHIVE_ROOT/zlib-wasm32"
printf 'archive-one' > "$ARCHIVE_ROOT/zlib-wasm32/one.tar.zst"

bash scripts/materialize-pr-overlays.sh "$ARCHIVE_ROOT" "$TMP/stage"
grep -Fqx '[binary.wasm32]' "$PR_TOML"

if bash scripts/materialize-pr-overlays.sh "$ARCHIVE_ROOT" "$TMP/stage-duplicate" \
  > "$TMP/duplicate.stdout" 2> "$TMP/duplicate.stderr"; then
  echo 'expected duplicate overlay materialization to fail' >&2
  exit 1
fi
grep -Fq 'duplicate overlay for zlib (wasm32)' "$TMP/duplicate.stderr"

rm -f "$PR_TOML"
printf 'archive-two' > "$ARCHIVE_ROOT/zlib-wasm32/two.tar.zst"
if bash scripts/materialize-pr-overlays.sh "$ARCHIVE_ROOT" "$TMP/stage-multiple" \
  > "$TMP/multiple.stdout" 2> "$TMP/multiple.stderr"; then
  echo 'expected multiple archives in one artifact to fail' >&2
  exit 1
fi
grep -Fq 'must contain exactly one .tar.zst; found 2' "$TMP/multiple.stderr"

rm -rf "$ARCHIVE_ROOT/zlib-wasm32"
mkdir -p "$ARCHIVE_ROOT/not-an-artifact"
printf 'archive' > "$ARCHIVE_ROOT/not-an-artifact/one.tar.zst"
if bash scripts/materialize-pr-overlays.sh "$ARCHIVE_ROOT" "$TMP/stage-invalid" \
  > "$TMP/invalid.stdout" 2> "$TMP/invalid.stderr"; then
  echo 'expected malformed artifact name to fail' >&2
  exit 1
fi
grep -Fq 'does not end in -wasm32 or -wasm64' "$TMP/invalid.stderr"

echo 'materialize PR overlay tests passed'
