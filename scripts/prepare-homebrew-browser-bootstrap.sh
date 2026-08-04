#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SELECTION_LOCK="$REPO_ROOT/homebrew/main-shell-selection-lock.json"
MIGRATION_LOCK="$REPO_ROOT/homebrew/main-shell-migration-lock.json"
RUNTIME_SUPPORT="$REPO_ROOT/homebrew/main-shell-homebrew-runtime-support.json"
BOOTSTRAP_SPEC="$REPO_ROOT/homebrew/main-shell-brew-package-tree.json"

OUTPUT_DIRECTORY=""
BROWSER_ASSET=""
BROWSER_PORTABLE_RUBY_ASSET=""
REQUIRE_SEALED=0
PENDING_SELECTION_ROOT="${WASM_POSIX_HOMEBREW_PENDING_SELECTION_ROOT:-}"

fail() {
  echo "prepare-homebrew-browser-bootstrap: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: prepare-homebrew-browser-bootstrap.sh \
  [--output-directory <new-directory>] \
  [--browser-asset <zip-path> \
   --browser-portable-ruby-asset <zip-path>] [--require-sealed] \
  [--pending-selection-root <prepared-selection>]
EOF
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-directory)
      [ "$#" -ge 2 ] || usage
      OUTPUT_DIRECTORY="$2"
      shift 2
      ;;
    --browser-asset)
      [ "$#" -ge 2 ] || usage
      BROWSER_ASSET="$2"
      shift 2
      ;;
    --browser-portable-ruby-asset)
      [ "$#" -ge 2 ] || usage
      BROWSER_PORTABLE_RUBY_ASSET="$2"
      shift 2
      ;;
    --require-sealed)
      REQUIRE_SEALED=1
      shift
      ;;
    --pending-selection-root)
      [ "$#" -ge 2 ] || usage
      PENDING_SELECTION_ROOT="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$OUTPUT_DIRECTORY" ] || [ -n "$BROWSER_ASSET" ] || usage
if [ -n "$BROWSER_ASSET" ] || [ -n "$BROWSER_PORTABLE_RUBY_ASSET" ]; then
  [ -n "$BROWSER_ASSET" ] && [ -n "$BROWSER_PORTABLE_RUBY_ASSET" ] || usage
fi
[ "$REQUIRE_SEALED" -eq 0 ] || [ -z "$PENDING_SELECTION_ROOT" ] ||
  fail "a pending selection cannot replace a sealed selection"

tap_repository="$(jq -er '.tap_repository' "$MIGRATION_LOCK")"
tap_name="$(jq -er '.tap_name' "$MIGRATION_LOCK")"
locked_tap_sha="$(jq -er '.catalog.tap_commit' "$MIGRATION_LOCK")"
runtime_tap_sha="$(jq -er '.catalog.tap_commit' "$RUNTIME_SUPPORT")"
bootstrap_package="$(jq -er '.package.name' "$BOOTSTRAP_SPEC")"
runtime_bootstrap_package="$(jq -er \
  '.activation.bootstrap_package.name' "$RUNTIME_SUPPORT")"
source_abi="$(sed -nE \
  's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs")"

[[ "$tap_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "migration lock has an invalid tap repository"
[[ "$locked_tap_sha" =~ ^[0-9a-f]{40}$ ]] ||
  fail "migration lock has an invalid tap commit"
[ "$runtime_tap_sha" = "$locked_tap_sha" ] ||
  fail "runtime support and migration lock select different tap commits"
[ "$runtime_bootstrap_package" = "$bootstrap_package" ] ||
  fail "runtime support and browser tree select different bootstrap Formulae"
[[ "$source_abi" =~ ^[1-9][0-9]*$ ]] ||
  fail "cannot read Kandelo's source ABI"

temporary_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
[ -d "$temporary_parent" ] && [ ! -L "$temporary_parent" ] ||
  fail "temporary parent must be a real directory"
work_root="$(mktemp -d \
  "$temporary_parent/kandelo-homebrew-browser-bootstrap.XXXXXX")"
staged_browser_asset=""
staged_portable_ruby_asset=""
cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT INT TERM
  if [ -n "$staged_browser_asset" ] && [ -f "$staged_browser_asset" ] &&
    [ ! -L "$staged_browser_asset" ]; then
    rm -f -- "$staged_browser_asset" || cleanup_failed=1
  fi
  if [ -n "$staged_portable_ruby_asset" ] &&
    [ -f "$staged_portable_ruby_asset" ] &&
    [ ! -L "$staged_portable_ruby_asset" ]; then
    rm -f -- "$staged_portable_ruby_asset" || cleanup_failed=1
  fi
  rm -rf -- "$work_root" || cleanup_failed=1
  if [ "$status" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then
    echo "prepare-homebrew-browser-bootstrap: cleanup failed" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

selection_state="$(jq -er '.state' "$SELECTION_LOCK")"
selection_report="$work_root/selection-verification.json"
product_selection_report="$work_root/main-shell-selection-verification.json"
case "$selection_state" in
  sealed)
    [ -z "$PENDING_SELECTION_ROOT" ] ||
      fail "a local pending selection cannot override the sealed release"
    selection_root="$work_root/selection"
    selection_receipt="$work_root/selection-receipt.json"
    selection_repository="$(jq -er '.release.repository' "$SELECTION_LOCK")"
    selection_tag="$(jq -er '.release.tag' "$SELECTION_LOCK")"
    # WHY: a deployment consumes the anonymous immutable readback, not a
    # mutable tap branch or a credentialed view of the same release.
    env -u GH_TOKEN -u GITHUB_TOKEN \
      -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
      -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      PYTHONDONTWRITEBYTECODE=1 \
      python3 "$REPO_ROOT/scripts/homebrew-prefix-campaign-executor.py" \
        fetch-selection-release \
        --repository "$selection_repository" \
        --tag "$selection_tag" \
        --out "$selection_root" \
        --receipt-out "$selection_receipt"
    python3 "$REPO_ROOT/scripts/homebrew-main-shell-selection-lock.py" \
      verify \
      --lock "$SELECTION_LOCK" \
      --selection "$selection_root" \
      --receipt "$selection_receipt" \
      --report-out "$product_selection_report"
    python3 "$REPO_ROOT/scripts/homebrew-prefix-campaign-executor.py" \
      verify-selection-readback \
      --selection "$selection_root" \
      --receipt "$selection_receipt" \
      --report-out "$selection_report"
    ;;
  pending)
    [ "$REQUIRE_SEALED" -eq 0 ] ||
      fail "a publishable browser product requires a sealed selection"
    [ -n "$PENDING_SELECTION_ROOT" ] ||
      fail "pending review requires --pending-selection-root;" \
        "the raw tap does not contain the generated bootstrap Formula"
    selection_root="$PENDING_SELECTION_ROOT"
    # WHY: generated support Formulae live in the prepared selection, not in
    # the raw source tap. The product-lock verifier admits that local tree for
    # review without misrepresenting it as a published immutable selection.
    python3 "$REPO_ROOT/scripts/homebrew-main-shell-selection-lock.py" \
      verify \
      --lock "$SELECTION_LOCK" \
      --selection "$selection_root" \
      --allow-pending \
      --report-out "$selection_report"
    ;;
  *)
    fail "selection lock has an unsupported state: $selection_state"
    ;;
esac
tap_root="$selection_root/tap"

tap_abi="$(jq -er '.kandelo_abi' "$tap_root/Kandelo/metadata.json")"
[ "$tap_abi" = "$source_abi" ] ||
  fail "tap ABI $tap_abi differs from Kandelo source ABI $source_abi"
[ -x "$REPO_ROOT/node_modules/.bin/tsx" ] ||
  fail "root dependencies are missing; run npm ci --no-audit --no-fund"

if [ -n "$OUTPUT_DIRECTORY" ]; then
  extraction_root="$OUTPUT_DIRECTORY"
else
  extraction_root="$work_root/extracted"
fi
[ ! -e "$extraction_root" ] && [ ! -L "$extraction_root" ] ||
  fail "output directory already exists: $extraction_root"

extract_args=(
  --tap-root "$tap_root"
  --expected-tap-sha "$locked_tap_sha"
  --tap-repository "$tap_repository"
  --tap-name "$tap_name"
  --package "$bootstrap_package"
  --arch wasm32
  --expected-abi "$source_abi"
  --output-directory "$extraction_root"
)
if [ -n "$selection_report" ]; then
  extract_args+=(--selection-verification-report "$selection_report")
fi
# WHY: this typed extractor authenticates the Formula, bottle, receipt, and
# declared members before any of those bytes are placed at a browser URL.
env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  "$REPO_ROOT/node_modules/.bin/tsx" \
    "$REPO_ROOT/scripts/extract-homebrew-support-data-bottle.ts" \
    "${extract_args[@]}"

for name in \
  homebrew-bootstrap.zip \
  homebrew-portable-ruby.zip \
  homebrew-brew.env \
  report.json
do
  [ -f "$extraction_root/$name" ] && [ ! -L "$extraction_root/$name" ] ||
    fail "verified extraction omitted $name"
done

if [ -n "$BROWSER_ASSET" ]; then
  browser_parent="$(dirname "$BROWSER_ASSET")"
  [ -d "$browser_parent" ] && [ ! -L "$browser_parent" ] ||
    fail "browser asset parent must be a real directory"
  if [ -e "$BROWSER_ASSET" ] || [ -L "$BROWSER_ASSET" ]; then
    [ -f "$BROWSER_ASSET" ] && [ ! -L "$BROWSER_ASSET" ] ||
      fail "browser asset must be absent or a regular non-symlink file"
  fi
  staged_browser_asset="$(mktemp \
    "$browser_parent/.homebrew-bootstrap.zip.XXXXXX")"
  cp -- "$extraction_root/homebrew-bootstrap.zip" "$staged_browser_asset"
  chmod 0644 "$staged_browser_asset"
  # WHY: Vite serves this stable same-origin name. Rename only after the new
  # verified bottle member is complete so a concurrent reader sees old or new
  # bytes, never a partially copied archive.
  mv -f -- "$staged_browser_asset" "$BROWSER_ASSET"
  staged_browser_asset=""
  cmp "$extraction_root/homebrew-bootstrap.zip" "$BROWSER_ASSET"

  portable_parent="$(dirname "$BROWSER_PORTABLE_RUBY_ASSET")"
  [ -d "$portable_parent" ] && [ ! -L "$portable_parent" ] ||
    fail "portable Ruby browser asset parent must be a real directory"
  if [ -e "$BROWSER_PORTABLE_RUBY_ASSET" ] ||
    [ -L "$BROWSER_PORTABLE_RUBY_ASSET" ]; then
    [ -f "$BROWSER_PORTABLE_RUBY_ASSET" ] &&
      [ ! -L "$BROWSER_PORTABLE_RUBY_ASSET" ] ||
      fail "portable Ruby browser asset must be absent or a regular file"
  fi
  staged_portable_ruby_asset="$(mktemp \
    "$portable_parent/.homebrew-portable-ruby.zip.XXXXXX")"
  cp -- "$extraction_root/homebrew-portable-ruby.zip" \
    "$staged_portable_ruby_asset"
  chmod 0644 "$staged_portable_ruby_asset"
  mv -f -- "$staged_portable_ruby_asset" "$BROWSER_PORTABLE_RUBY_ASSET"
  staged_portable_ruby_asset=""
  cmp "$extraction_root/homebrew-portable-ruby.zip" \
    "$BROWSER_PORTABLE_RUBY_ASSET"
fi

echo "Homebrew browser bootstrap prepared from tap $locked_tap_sha"
