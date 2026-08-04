#!/usr/bin/env bash
# Fetch and authenticate every public input used to compose the main shell.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT=""

usage() {
  cat <<'EOF'
Usage: scripts/prepare-homebrew-main-shell-inputs.sh \
  --output-directory <new-directory>

Fetch the checked-in immutable closed selection anonymously, verify its exact
Formula closure, and extract Homebrew's support tree from the selected public
bottle. The output is safe to pass to build-homebrew-main-shell-product.sh.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-directory)
      OUTPUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "prepare-homebrew-main-shell-inputs: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$OUTPUT" ] || [ "$OUTPUT" = / ] ||
   [ -e "$OUTPUT" ] || [ -L "$OUTPUT" ]; then
  echo "prepare-homebrew-main-shell-inputs: output must be one new directory" >&2
  exit 2
fi
OUTPUT_PARENT="$(dirname "$OUTPUT")"
OUTPUT_NAME="$(basename "$OUTPUT")"
if [ ! -d "$OUTPUT_PARENT" ] || [ -L "$OUTPUT_PARENT" ]; then
  echo "prepare-homebrew-main-shell-inputs: output parent must be a real directory" >&2
  exit 2
fi

for tool in jq node python3 ruby; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "prepare-homebrew-main-shell-inputs: missing $tool; run through scripts/dev-shell.sh" >&2
    exit 2
  }
done
if [ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]; then
  echo "prepare-homebrew-main-shell-inputs: npm dependencies are not installed" >&2
  exit 2
fi

state="$(python3 "$REPO_ROOT/scripts/homebrew-main-shell-product-state.py")"
case "$state" in
  candidate|publishable) ;;
  awaiting-selection)
    echo "prepare-homebrew-main-shell-inputs: the shell selection is not sealed yet" >&2
    exit 1
    ;;
  *)
    echo "prepare-homebrew-main-shell-inputs: unsupported product state: $state" >&2
    exit 1
    ;;
esac

# Public release bytes are package inputs, never credentialed ambient state.
unset GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN

SELECTION_LOCK="$REPO_ROOT/homebrew/main-shell-selection-lock.json"
MIGRATION_LOCK="$REPO_ROOT/homebrew/main-shell-migration-lock.json"
SELECTION_REPOSITORY="$(jq -er '.release.repository' "$SELECTION_LOCK")"
SELECTION_TAG="$(jq -er '.release.tag' "$SELECTION_LOCK")"
EXPECTED_TAP_SHA="$(jq -er '.catalog.tap_commit' "$MIGRATION_LOCK")"
[[ "$EXPECTED_TAP_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "prepare-homebrew-main-shell-inputs: migration lock has no exact tap SHA" >&2
  exit 1
}

TEMPORARY="$(mktemp -d "$OUTPUT_PARENT/.${OUTPUT_NAME}.XXXXXX")"
cleanup() {
  rm -rf -- "$TEMPORARY"
}
trap cleanup EXIT

SELECTION="$TEMPORARY/selection"
RECEIPT="$TEMPORARY/selection-receipt.json"
AUTHORIZATION="$TEMPORARY/selection-authorization.json"
PRODUCT_REPORT="$TEMPORARY/product-selection-verification.json"
BOOTSTRAP="$TEMPORARY/bootstrap"

PYTHONDONTWRITEBYTECODE=1 python3 \
  "$REPO_ROOT/scripts/homebrew-prefix-campaign-executor.py" \
  fetch-selection-release \
  --repository "$SELECTION_REPOSITORY" \
  --tag "$SELECTION_TAG" \
  --out "$SELECTION" \
  --receipt-out "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 python3 \
  "$REPO_ROOT/scripts/homebrew-prefix-campaign-executor.py" \
  verify-selection-readback \
  --selection "$SELECTION" \
  --receipt "$RECEIPT" \
  --report-out "$AUTHORIZATION"
PYTHONDONTWRITEBYTECODE=1 python3 \
  "$REPO_ROOT/scripts/homebrew-main-shell-selection-lock.py" verify \
  --lock "$SELECTION_LOCK" \
  --selection "$SELECTION" \
  --receipt "$RECEIPT" \
  --report-out "$PRODUCT_REPORT"

[ "$(jq -er '.source_tap_commit' "$PRODUCT_REPORT")" = \
  "$EXPECTED_TAP_SHA" ] || {
  echo "prepare-homebrew-main-shell-inputs: selection differs from the catalog lock" >&2
  exit 1
}
TAP_ABI="$(jq -er '.kandelo_abi' "$SELECTION/tap/Kandelo/metadata.json")"
SOURCE_ABI="$(sed -nE \
  's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs")"
[ "$TAP_ABI" = "$SOURCE_ABI" ] || {
  echo "prepare-homebrew-main-shell-inputs: selected bottles use ABI $TAP_ABI, source uses ABI $SOURCE_ABI" >&2
  exit 1
}
BOOTSTRAP_PACKAGE="$(jq -er '.package.name' \
  "$REPO_ROOT/homebrew/main-shell-brew-package-tree.json")"
[ "$BOOTSTRAP_PACKAGE" = "$(jq -er '.activation.bootstrap_package.name' \
  "$REPO_ROOT/homebrew/main-shell-homebrew-runtime-support.json")" ] || {
  echo "prepare-homebrew-main-shell-inputs: bootstrap package contracts disagree" >&2
  exit 1
}

# WHY: Homebrew's source tree is Formula-owned software. Extract its declared
# support outputs from the exact selected bottle so neither CI nor the package
# build can silently fall back to the transitional Kandelo package registry.
"$REPO_ROOT/node_modules/.bin/tsx" \
  "$REPO_ROOT/scripts/extract-homebrew-support-data-bottle.ts" \
  --tap-root "$SELECTION/tap" \
  --expected-tap-sha "$EXPECTED_TAP_SHA" \
  --tap-repository kandelo-dev/homebrew-tap-core \
  --tap-name kandelo-dev/tap-core \
  --package "$BOOTSTRAP_PACKAGE" \
  --arch wasm32 \
  --expected-abi "$SOURCE_ABI" \
  --selection-verification-report "$AUTHORIZATION" \
  --output-directory "$BOOTSTRAP"

for required in \
  "$BOOTSTRAP/homebrew-bootstrap.zip" \
  "$BOOTSTRAP/homebrew-brew.env" \
  "$BOOTSTRAP/homebrew-portable-ruby.zip" \
  "$BOOTSTRAP/report.json"; do
  [ -f "$required" ] && [ ! -L "$required" ] || {
    echo "prepare-homebrew-main-shell-inputs: extractor omitted $required" >&2
    exit 1
  }
done

mv -- "$TEMPORARY" "$OUTPUT"
trap - EXIT
