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
  local expected="${2:-$TMP_ROOT/expected.vfs.zst}"
  local stem="${3:-}"
  local args=("$TMP_ROOT/dist" "$expected")
  if [ -n "$stem" ]; then
    args+=("$stem")
  fi
  if "$VERIFIER" "${args[@]}" >/dev/null 2>&1; then
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
printf 'expected shell\n' >"$asset"

# The same verifier binds every package-owned VFS import by an exact, caller-
# selected asset stem. A valid shell asset must not satisfy the LAMP check.
printf 'expected LAMP VFS\n' >"$TMP_ROOT/expected-lamp.vfs.zst"
lamp_asset="$TMP_ROOT/dist/assets/lamp.vfs-Lamp789.zst"
cp "$TMP_ROOT/expected-lamp.vfs.zst" "$lamp_asset"
lamp_actual="$(
  "$VERIFIER" \
    "$TMP_ROOT/dist" "$TMP_ROOT/expected-lamp.vfs.zst" lamp.vfs
)"
[ "$lamp_actual" = "$lamp_asset" ] || fail "reported the wrong LAMP VFS asset"
printf 'different LAMP VFS\n' >"$lamp_asset"
expect_rejected \
  "a hashed LAMP asset with different bytes" \
  "$TMP_ROOT/expected-lamp.vfs.zst" lamp.vfs
expect_rejected \
  "an unsafe asset stem" \
  "$TMP_ROOT/expected-lamp.vfs.zst" '../lamp.vfs'

echo "test-verify-browser-shell-vfs-asset: ok"
