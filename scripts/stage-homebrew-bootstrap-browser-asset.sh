#!/usr/bin/env bash
set -euo pipefail

source_archive="${1:-}"
browser_asset="${2:-}"

fail() {
  echo "stage-homebrew-bootstrap-browser-asset: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] ||
  fail "usage: scripts/stage-homebrew-bootstrap-browser-asset.sh <source> <destination>"
[ -f "$source_archive" ] && [ ! -L "$source_archive" ] ||
  fail "canonical package output must be a regular non-symlink file"
[ -s "$source_archive" ] || fail "canonical package output must be nonempty"

browser_parent="$(dirname "$browser_asset")"
[ -d "$browser_parent" ] && [ ! -L "$browser_parent" ] ||
  fail "browser asset parent must be a real directory"
if [ -e "$browser_asset" ] || [ -L "$browser_asset" ]; then
  [ -f "$browser_asset" ] && [ ! -L "$browser_asset" ] ||
    fail "browser asset must be absent or a regular non-symlink file"
fi

staged="$(mktemp "$browser_parent/.homebrew-bootstrap.zip.XXXXXX")"
cleanup() {
  if [ -n "$staged" ]; then
    rm -f -- "$staged"
  fi
}
trap cleanup EXIT
cp -- "$source_archive" "$staged"
chmod 0644 "$staged"
cmp "$source_archive" "$staged" || fail "temporary copy changed package bytes"
mv -f -- "$staged" "$browser_asset"
staged=""
cmp "$source_archive" "$browser_asset" || fail "staged browser asset changed package bytes"
