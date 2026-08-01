#!/usr/bin/env bash
# Publish one prepared partial Formula closure without moving tap main.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SELECTION=""
LOCK_ROOT=""
RECEIPT=""
KANDELO_MAIN_CONTAINS_SHA=""
TARGET_MAIN_CONTAINS_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --selection) SELECTION="${2:-}"; shift 2 ;;
    --lock-root) LOCK_ROOT="${2:-}"; shift 2 ;;
    --receipt) RECEIPT="${2:-}"; shift 2 ;;
    --kandelo-main-contains-sha)
      KANDELO_MAIN_CONTAINS_SHA="${2:-}"
      shift 2
      ;;
    --target-main-contains-sha)
      TARGET_MAIN_CONTAINS_SHA="${2:-}"
      shift 2
      ;;
    *)
      echo "publish-homebrew-closed-selection-release: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

for required in \
  SELECTION LOCK_ROOT RECEIPT KANDELO_MAIN_CONTAINS_SHA \
  TARGET_MAIN_CONTAINS_SHA
do
  if [ -z "${!required}" ]; then
    echo "publish-homebrew-closed-selection-release: missing ${required,,}" >&2
    exit 2
  fi
done
for revision in \
  "$KANDELO_MAIN_CONTAINS_SHA" "$TARGET_MAIN_CONTAINS_SHA"
do
  if ! [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo "publish-homebrew-closed-selection-release: authority must be a lowercase 40-character SHA" >&2
    exit 2
  fi
done
if [ ! -d "$SELECTION" ] || [ -L "$SELECTION" ]; then
  echo "publish-homebrew-closed-selection-release: selection must be a real directory" >&2
  exit 2
fi
if [ ! -d "$LOCK_ROOT" ] || [ -L "$LOCK_ROOT" ]; then
  echo "publish-homebrew-closed-selection-release: lock root must be a real directory" >&2
  exit 2
fi
if [ -e "$RECEIPT" ] || [ -L "$RECEIPT" ]; then
  echo "publish-homebrew-closed-selection-release: receipt already exists" >&2
  exit 2
fi
RECEIPT_PARENT="$(dirname "$RECEIPT")"
if [ ! -d "$RECEIPT_PARENT" ] || [ -L "$RECEIPT_PARENT" ]; then
  echo "publish-homebrew-closed-selection-release: receipt parent must be a real directory" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d "$RECEIPT_PARENT/.closed-selection-release.XXXXXX")"
cleanup() {
  # The directory contains only derived public release inputs and receipts.
  # It carries no caller-owned state, so removing it is safe on every exit.
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT
PREPARED="$TMP_ROOT/prepared"
PUBLISH_RECEIPT="$TMP_ROOT/immutable-release-receipt.json"
READBACK="$TMP_ROOT/readback"

# WHY: preparing the release does not need credentials. Keep them out so
# malformed selection data cannot influence a token-bearing process before
# the generic immutable publisher has normalized the complete manifest.
env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  PYTHONDONTWRITEBYTECODE=1 \
  python3 "$SCRIPT_DIR/homebrew-prefix-campaign-executor.py" \
    prepare-selection-release \
    --selection "$SELECTION" \
    --out "$PREPARED"

selection_kandelo_sha="$(jq -er \
  '.selection_manifest.value.campaign.kandelo_commit' \
  "$PREPARED/assets/closed-selection.json")"
selection_tap_sha="$(jq -er \
  '.selection_manifest.value.tap.source_commit' \
  "$PREPARED/assets/closed-selection.json")"
if [ "$selection_kandelo_sha" != "$KANDELO_MAIN_CONTAINS_SHA" ] ||
   [ "$selection_tap_sha" != "$TARGET_MAIN_CONTAINS_SHA" ]; then
  echo "publish-homebrew-closed-selection-release: authority differs from the selection" >&2
  exit 1
fi

bash "$SCRIPT_DIR/publish-immutable-github-release.sh" \
  --manifest "$PREPARED/release-manifest.json" \
  --asset-root "$PREPARED/assets" \
  --lock-root "$LOCK_ROOT" \
  --receipt "$PUBLISH_RECEIPT" \
  --kandelo-main-contains-sha "$KANDELO_MAIN_CONTAINS_SHA" \
  --target-main-contains-sha "$TARGET_MAIN_CONTAINS_SHA"

repository="$(jq -er '.repository' "$PREPARED/release-manifest.json")"
tag="$(jq -er '.tag' "$PREPARED/release-manifest.json")"
# The generic publisher proves exact anonymous bytes. This second readback
# proves their selection semantics, bounded archive inventory, and Git tree
# before emitting the receipt that a shell lock may consume.
env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  PYTHONDONTWRITEBYTECODE=1 \
  python3 "$SCRIPT_DIR/homebrew-prefix-campaign-executor.py" \
    fetch-selection-release \
    --repository "$repository" \
    --tag "$tag" \
    --out "$READBACK" \
    --receipt-out "$RECEIPT"

cmp "$SELECTION/selection.json" "$READBACK/selection.json"
expected_tree="$(jq -er '.tap.prepared_tree_git_oid' \
  "$SELECTION/selection.json")"
observed_tree="$(jq -er '.prepared_tree_git_oid' "$RECEIPT")"
[ "$observed_tree" = "$expected_tree" ] || {
  echo "publish-homebrew-closed-selection-release: semantic readback tree differs" >&2
  exit 1
}
echo "Published closed Homebrew selection: $tag"
