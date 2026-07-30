#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFIER="$SCRIPT_DIR/verify-browser-shell-vfs-asset.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-verify-browser-shell-vfs-asset: $*" >&2
  exit 1
}

expect_rejected() {
  local label="$1"
  if "$VERIFIER" "$TMP_ROOT/dist" "$TMP_ROOT/expected.vfs.zst" \
      >/dev/null 2>&1; then
    fail "accepted $label"
  fi
}

mkdir -p "$TMP_ROOT/dist/assets"
printf 'expected shell\n' >"$TMP_ROOT/expected.vfs.zst"

# WHY: model the original failure directly. A stale public copy must not hide
# the hashed asset that Chromium actually loads from the product bundle.
printf 'stale public copy\n' >"$TMP_ROOT/dist/shell.vfs.zst"
expect_rejected "a missing hashed asset"

asset="$TMP_ROOT/dist/assets/shell.vfs-Current123.zst"
cp "$TMP_ROOT/expected.vfs.zst" "$asset"
actual="$("$VERIFIER" "$TMP_ROOT/dist" "$TMP_ROOT/expected.vfs.zst")"
[ "$actual" = "$asset" ] || fail "reported the wrong hashed asset"

second_asset="$TMP_ROOT/dist/assets/shell.vfs-Other456.zst"
cp "$TMP_ROOT/expected.vfs.zst" "$second_asset"
expect_rejected "ambiguous hashed assets"
rm "$second_asset"

printf 'different shell\n' >"$asset"
expect_rejected "a hashed asset with different bytes"

echo "test-verify-browser-shell-vfs-asset: ok"
