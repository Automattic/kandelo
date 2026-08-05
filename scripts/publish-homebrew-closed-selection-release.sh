#!/usr/bin/env bash
# Publish one prepared partial Formula closure without moving tap main.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREPARED_RELEASE=""
CAMPAIGN=""
LOCK_ROOT=""
RECEIPT=""
SELECTION_PLAN=""
SELECTION_PLAN_SHA256=""
EXACT_EXECUTION_KANDELO_MAIN_SHA=""
EXACT_EXECUTION_TARGET_MAIN_SHA=""
KANDELO_MAIN_CONTAINS_SHA=""
TARGET_MAIN_CONTAINS_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prepared-release) PREPARED_RELEASE="${2:-}"; shift 2 ;;
    --campaign) CAMPAIGN="${2:-}"; shift 2 ;;
    --lock-root) LOCK_ROOT="${2:-}"; shift 2 ;;
    --receipt) RECEIPT="${2:-}"; shift 2 ;;
    --selection-plan) SELECTION_PLAN="${2:-}"; shift 2 ;;
    --selection-plan-sha256)
      SELECTION_PLAN_SHA256="${2:-}"
      shift 2
      ;;
    --exact-execution-kandelo-main-sha)
      EXACT_EXECUTION_KANDELO_MAIN_SHA="${2:-}"
      shift 2
      ;;
    --exact-execution-target-main-sha)
      EXACT_EXECUTION_TARGET_MAIN_SHA="${2:-}"
      shift 2
      ;;
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
  PREPARED_RELEASE CAMPAIGN LOCK_ROOT RECEIPT SELECTION_PLAN \
  SELECTION_PLAN_SHA256 EXACT_EXECUTION_KANDELO_MAIN_SHA \
  EXACT_EXECUTION_TARGET_MAIN_SHA KANDELO_MAIN_CONTAINS_SHA \
  TARGET_MAIN_CONTAINS_SHA
do
  if [ -z "${!required}" ]; then
    echo "publish-homebrew-closed-selection-release: missing ${required,,}" >&2
    exit 2
  fi
done
for revision in \
  "$EXACT_EXECUTION_KANDELO_MAIN_SHA" \
  "$EXACT_EXECUTION_TARGET_MAIN_SHA" \
  "$KANDELO_MAIN_CONTAINS_SHA" "$TARGET_MAIN_CONTAINS_SHA"
do
  if ! [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo "publish-homebrew-closed-selection-release: authority must be a lowercase 40-character SHA" >&2
    exit 2
  fi
done
if ! [[ "$SELECTION_PLAN_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "publish-homebrew-closed-selection-release: plan digest must be a lowercase SHA-256" >&2
  exit 2
fi
if [ ! -d "$PREPARED_RELEASE" ] || [ -L "$PREPARED_RELEASE" ]; then
  echo "publish-homebrew-closed-selection-release: prepared release must be a real directory" >&2
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
READBACK_RECEIPT="$TMP_ROOT/readback-receipt.json"

# WHY: Actions artifact transport preserves ordinary file bytes but not a raw
# tree's hidden-path or executable-mode semantics. The read-only job therefore
# transports the deterministic release archive and manifests. Snapshot and
# validate those exact files before any token-bearing process observes them.
env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  PYTHONDONTWRITEBYTECODE=1 \
  python3 "$SCRIPT_DIR/homebrew-prefix-campaign-executor.py" \
    snapshot-selection-release \
    --prepared-release "$PREPARED_RELEASE" \
    --out "$PREPARED"

env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  PYTHONDONTWRITEBYTECODE=1 \
  python3 "$SCRIPT_DIR/homebrew-closed-selection-controller.py" \
    verify \
    --selection-plan "$SELECTION_PLAN" \
    --selection-plan-sha256 "$SELECTION_PLAN_SHA256" \
    --prepared-release "$PREPARED" \
    --campaign "$CAMPAIGN" \
    --executor "$SCRIPT_DIR/homebrew-prefix-campaign-executor.py"

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
  --exact-execution-kandelo-main-sha \
    "$EXACT_EXECUTION_KANDELO_MAIN_SHA" \
  --exact-execution-target-main-sha \
    "$EXACT_EXECUTION_TARGET_MAIN_SHA" \
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
    --receipt-out "$READBACK_RECEIPT"

# WHY: a successful public readback is not sufficient if it describes a
# different coherent selection. Compare it with the immutable private snapshot
# before making the requested receipt visible to downstream consumers.
jq -e --slurpfile observed "$READBACK/selection.json" \
  '.selection_manifest.value == $observed[0]' \
  "$PREPARED/assets/closed-selection.json" >/dev/null
expected_tree="$(jq -er '.tap.prepared_tree_git_oid' \
  "$READBACK/selection.json")"
observed_tree="$(jq -er '.prepared_tree_git_oid' "$READBACK_RECEIPT")"
[ "$observed_tree" = "$expected_tree" ] || {
  echo "publish-homebrew-closed-selection-release: semantic readback tree differs" >&2
  exit 1
}
# WHY: hard-linking within the receipt parent is an atomic no-clobber install.
# A failed comparison leaves no success receipt and an unchanged retry can
# safely reconcile the already immutable release.
ln "$READBACK_RECEIPT" "$RECEIPT"
echo "Published closed Homebrew selection: $tag"
