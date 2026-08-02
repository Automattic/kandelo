#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-guest-layout.sh"

homebrew_select_guest_layout ""
[ "$HOMEBREW_GUEST_LAYOUT_MODE" = "canonical" ]
[ "$HOMEBREW_GUEST_PREFIX" = "/opt/kandelo/homebrew" ]
[ "$HOMEBREW_GUEST_CELLAR" = "/opt/kandelo/homebrew/Cellar" ]
[ "$HOMEBREW_GUEST_PATCH_FILE" = \
  "$REPO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch" ]

layout_sha256="$(
  sha256sum "$REPO_ROOT/homebrew/kandelo-guest-layout.json" |
    awk '{print $1}'
)"
homebrew_select_guest_layout "$layout_sha256"
[ "$HOMEBREW_GUEST_LAYOUT_MODE" = "prefix-campaign" ]
[ "$HOMEBREW_GUEST_LAYOUT_SHA256" = "$layout_sha256" ]
[ "$HOMEBREW_GUEST_PREFIX" = "/opt/kandelo/homebrew" ]
[ "$HOMEBREW_GUEST_CELLAR" = "/opt/kandelo/homebrew/Cellar" ]
[ "$HOMEBREW_GUEST_PATCH_FILE" = \
  "$REPO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags-prefix-campaign.patch" ]

if (
  homebrew_select_guest_layout \
    0000000000000000000000000000000000000000000000000000000000000000
); then
  echo "test-homebrew-prefix-campaign-layout: accepted a different layout digest" >&2
  exit 1
fi

active_patch="$REPO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
campaign_patch="$REPO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags-prefix-campaign.patch"
grep -F '"/opt/kandelo/homebrew"' "$active_patch" >/dev/null
grep -F '"/opt/kandelo/homebrew/Cellar"' "$active_patch" >/dev/null
grep -F '"/opt/kandelo/homebrew"' "$campaign_patch" >/dev/null
grep -F '"/opt/kandelo/homebrew/Cellar"' "$campaign_patch" >/dev/null
if ! cmp -s "$active_patch" "$campaign_patch"; then
  echo "test-homebrew-prefix-campaign-layout: bootstrap patches disagree after cutover" >&2
  exit 1
fi

echo "test-homebrew-prefix-campaign-layout: pass"
