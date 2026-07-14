#!/usr/bin/env bash
set -euo pipefail

TARGET_TAG=""
ABI=""
OUTPUT=""
STATE_FILE=""
ASSET_NAMES_FILE=""
ASSET_METADATA_FILE=""
MAX_ASSET_PAGES=20
ASSET_PER_PAGE=100

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-tag) TARGET_TAG="$2"; shift 2 ;;
    --abi) ABI="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --state-file) STATE_FILE="$2"; shift 2 ;;
    --asset-names-file) ASSET_NAMES_FILE="$2"; shift 2 ;;
    --asset-metadata-file) ASSET_METADATA_FILE="$2"; shift 2 ;;
    --max-asset-pages) MAX_ASSET_PAGES="$2"; shift 2 ;;
    --asset-per-page) ASSET_PER_PAGE="$2"; shift 2 ;;
    *) echo "fetch-canonical-index: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TARGET_TAG" ] || ! [[ "$ABI" =~ ^[0-9]+$ ]] ||
   [ -z "$OUTPUT" ] || [ -z "$STATE_FILE" ] || [ -z "$ASSET_NAMES_FILE" ] ||
   [ -z "$ASSET_METADATA_FILE" ]; then
  echo "fetch-canonical-index: tag, ABI, output, state, asset names, and asset metadata are required" >&2
  exit 2
fi
if ! [[ "$MAX_ASSET_PAGES" =~ ^[0-9]+$ ]] || [ "$MAX_ASSET_PAGES" = 0 ] ||
   ! [[ "$ASSET_PER_PAGE" =~ ^[0-9]+$ ]] || [ "$ASSET_PER_PAGE" = 0 ] ||
   [ "$ASSET_PER_PAGE" -gt 100 ]; then
  echo "fetch-canonical-index: invalid asset pagination bounds" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=.github/scripts/github-api-get.sh
source "$SCRIPT_DIR/github-api-get.sh"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-$SCRIPT_DIR/state-lock.sh}"
RELEASE_INDEX_STATE_SCRIPT="${RELEASE_INDEX_STATE_SCRIPT:-$REPO_ROOT/scripts/release-index-state.sh}"
REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
TMP_ROOT="$(mktemp -d)"
LOCK_STATE="$TMP_ROOT/lock.env"
LOCKED=0

cleanup() {
  if [ "$LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

gh_retry() {
  local attempt=1 delay="${CANONICAL_FETCH_RETRY_DELAY_SECONDS:-2}"
  while true; do
    if "$@"; then return 0; fi
    if [ "$attempt" -ge 4 ]; then return 1; fi
    echo "fetch-canonical-index: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

export STATE_LOCK_OWNER_DETAIL="canonical snapshot for candidate preparation"
STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$TARGET_TAG"
LOCKED=1

release_json="$TMP_ROOT/release.json"
rc=0
GITHUB_API_CONTEXT=fetch-canonical-index \
  github_api_get_json "/repos/${REPOSITORY}/releases/tags/${TARGET_TAG}" "$release_json" || rc=$?
mkdir -p \
  "$(dirname "$OUTPUT")" \
  "$(dirname "$STATE_FILE")" \
  "$(dirname "$ASSET_NAMES_FILE")" \
  "$(dirname "$ASSET_METADATA_FILE")"
if [ "$rc" -eq 44 ]; then
  cat > "$OUTPUT" <<EOF
abi_version = $ABI
generated_at = "1970-01-01T00:00:00Z"
generator = "prepare-merge confirmed-absent canonical snapshot"
EOF
  printf 'absent\n' > "$STATE_FILE"
  printf '[]\n' > "$ASSET_NAMES_FILE"
  printf '[]\n' > "$ASSET_METADATA_FILE"
  echo "fetch-canonical-index: $TARGET_TAG is confirmed absent"
  exit 0
fi
if [ "$rc" -ne 0 ]; then
  echo "fetch-canonical-index: canonical release lookup is uncertain" >&2
  exit 1
fi

head_file="$TMP_ROOT/head"
bash "$RELEASE_INDEX_STATE_SCRIPT" snapshot \
  --target-tag "$TARGET_TAG" \
  --expected-abi "$ABI" \
  --output "$OUTPUT" \
  --head-file "$head_file"
if [ "$(cat "$head_file")" = empty ]; then
  echo "fetch-canonical-index: managed canonical release has not committed an index" >&2
  exit 1
fi

# Re-read the unchanged release snapshot, then enumerate every asset.
GITHUB_API_CONTEXT=fetch-canonical-index \
  github_api_get_json "/repos/${REPOSITORY}/releases/tags/${TARGET_TAG}" "$release_json"
release_id=$(jq -er '.id | select(type == "number" and . > 0)' "$release_json")
assets_jsonl="$TMP_ROOT/assets.jsonl"
: > "$assets_jsonl"
reached_end=false
for ((page = 1; page <= MAX_ASSET_PAGES; page++)); do
  page_json=$(gh_retry gh api "/repos/${REPOSITORY}/releases/${release_id}/assets?per_page=${ASSET_PER_PAGE}&page=${page}")
  if ! jq -e 'type == "array" and all(.[]; .name | type == "string")' <<<"$page_json" >/dev/null; then
    echo "fetch-canonical-index: malformed asset page $page" >&2
    exit 1
  fi
  count=$(jq 'length' <<<"$page_json")
  jq -c '.[]' <<<"$page_json" >> "$assets_jsonl"
  if [ "$count" -lt "$ASSET_PER_PAGE" ]; then reached_end=true; break; fi
done
if [ "$reached_end" != true ]; then
  echo "fetch-canonical-index: asset scan reached its safety bound" >&2
  exit 1
fi
jq -s '
  sort_by(.name)
  | if group_by(.name) | all(.[]; length == 1) then .
    else error("canonical release contains duplicate asset names")
    end
  | map({
      name,
      size,
      digest: (.digest // ""),
      state: (.state // "")
    })
' "$assets_jsonl" > "$ASSET_METADATA_FILE"
jq '[.[].name]' "$ASSET_METADATA_FILE" > "$ASSET_NAMES_FILE"
printf 'present\n' > "$STATE_FILE"
echo "fetch-canonical-index: read immutable snapshot $TARGET_TAG/index.toml"
