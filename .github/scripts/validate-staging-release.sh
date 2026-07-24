#!/usr/bin/env bash
# Freeze and validate one PR-staging package release. The output directory is
# published only after index.toml and release-asset metadata agree. In current
# mode, metadata-only preflight downloads the current entries that declare
# immutable Git inputs and compares their embedded manifests with the exact
# ledger. --materialize downloads and validates every archive, retains those
# verified bytes, and exposes a local file:// index. Structural snapshots may
# be materialized as an input to a separately validated union.
set -euo pipefail

TAG=""
EXPECTED_LEDGER=""
MODE=""
OUTPUT_DIR=""
XTASK=""
MATERIALIZE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --expected-ledger) EXPECTED_LEDGER="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --xtask) XTASK="$2"; shift 2 ;;
    --materialize) MATERIALIZE=1; shift ;;
    *) echo "validate-staging-release: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$TAG" =~ ^[A-Za-z0-9._-]+$ ]] ||
   [ ! -f "$EXPECTED_LEDGER" ] ||
   [[ "$MODE" != structural && "$MODE" != current ]] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ] ||
   [ ! -x "$XTASK" ]; then
  echo "validate-staging-release: valid tag, expected ledger, mode, output dir, and xtask are required" >&2
  exit 2
fi
if [ -e "$OUTPUT_DIR" ]; then
  echo "validate-staging-release: output already exists: $OUTPUT_DIR" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$PARENT"
TMP_ROOT="$(mktemp -d "$PARENT/.staging-release.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

release_id="$(gh api "/repos/$REPOSITORY/releases/tags/$TAG" --jq .id)"
if ! [[ "$release_id" =~ ^[0-9]+$ ]]; then
  echo "validate-staging-release: invalid release id for $TAG: $release_id" >&2
  exit 1
fi

# Use the paginated REST asset collection. `gh release view` can truncate large
# releases, and a truncated list could make a duplicate or missing asset look
# trustworthy.
gh api --paginate --slurp "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" \
  | jq -e 'add | map({name, state, size, digest})' > "$TMP_ROOT/assets.json"

index_count="$(jq '[.[] | select(.name == "index.toml")] | length' "$TMP_ROOT/assets.json")"
if [ "$index_count" != 1 ]; then
  echo "validate-staging-release: $TAG must contain exactly one index.toml asset; found $index_count" >&2
  exit 1
fi
index_state="$(jq -r '.[] | select(.name == "index.toml") | .state' "$TMP_ROOT/assets.json")"
index_size="$(jq -r '.[] | select(.name == "index.toml") | .size' "$TMP_ROOT/assets.json")"
index_digest="$(jq -r '.[] | select(.name == "index.toml") | .digest // ""' "$TMP_ROOT/assets.json")"
if [ "$index_state" != uploaded ] || ! [[ "$index_size" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$index_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "validate-staging-release: $TAG/index.toml lacks uploaded, nonempty sha256 metadata" >&2
  exit 1
fi

gh release download "$TAG" --repo "$REPOSITORY" --pattern index.toml \
  --dir "$TMP_ROOT" --clobber >/dev/null
mv "$TMP_ROOT/index.toml" "$TMP_ROOT/source-index.toml"
actual_size="$(wc -c < "$TMP_ROOT/source-index.toml" | tr -d '[:space:]')"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$TMP_ROOT/source-index.toml" | awk '{print $1}')"
else
  actual_sha="$(shasum -a 256 "$TMP_ROOT/source-index.toml" | awk '{print $1}')"
fi
if [ "$actual_size" != "$index_size" ] || [ "sha256:$actual_sha" != "$index_digest" ]; then
  echo "validate-staging-release: $TAG/index.toml bytes changed after metadata snapshot" >&2
  exit 1
fi

run_xtask_without_credentials() {
  # WHY: release credentials authorize writes to the package distribution
  # channel. Package/index parsing is untrusted input processing and has no
  # reason to observe those credentials.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    "$XTASK" "$@"
}

run_xtask_without_credentials staging-reuse validate \
  --expected-ledger "$EXPECTED_LEDGER" \
  --index "$TMP_ROOT/source-index.toml" \
  --assets "$TMP_ROOT/assets.json" \
  --release-tag "$TAG" \
  --release-base-url "$SERVER_URL/$REPOSITORY/releases/download/$TAG/" \
  --mode "$MODE" \
  --output "$TMP_ROOT/snapshot.json" \
  --localized-index "$TMP_ROOT/index.toml"

mkdir "$TMP_ROOT/archives"
if [ "$MATERIALIZE" = 1 ]; then
  archive_scope=all
  jq -r '.entries[] | [.asset, .archive_sha256, (.size | tostring)] | @tsv' \
    "$TMP_ROOT/snapshot.json" > "$TMP_ROOT/archive-selection.tsv"
else
  archive_scope=current-declared-git-inputs
  jq -r --slurpfile expected "$EXPECTED_LEDGER" '
    .entries[] as $snapshot |
    select($snapshot.current == true) |
    select(any($expected[0].entries[];
      .package == $snapshot.package and
      .arch == $snapshot.arch and
      ((.git_inputs // []) | length) > 0)) |
    [$snapshot.asset, $snapshot.archive_sha256, ($snapshot.size | tostring)] | @tsv
  ' "$TMP_ROOT/snapshot.json" > "$TMP_ROOT/archive-selection.tsv"
fi
while IFS=$'\t' read -r asset sha size; do
  [ -n "$asset" ] || continue
  bash "$SCRIPT_DIR/download-verified-release-asset.sh" \
    --tag "$TAG" \
    --asset "$asset" \
    --sha256 "$sha" \
    --size "$size" \
    --output "$TMP_ROOT/archives/$asset"
done < "$TMP_ROOT/archive-selection.tsv"

run_xtask_without_credentials staging-reuse validate-archives \
  --expected-ledger "$EXPECTED_LEDGER" \
  --snapshot "$TMP_ROOT/snapshot.json" \
  --archives-dir "$TMP_ROOT/archives" \
  --scope "$archive_scope"

if [ "$MATERIALIZE" = 1 ]; then
  cp "$TMP_ROOT/index.toml" "$TMP_ROOT/archives/index.toml"
  printf 'file://%s/index.toml\n' "$OUTPUT_DIR/archives" > "$TMP_ROOT/index-url.txt"
else
  rm -rf "$TMP_ROOT/archives"
fi

mv "$TMP_ROOT" "$OUTPUT_DIR"
trap - EXIT
echo "validate-staging-release: froze $MODE snapshot for $TAG at $OUTPUT_DIR"
