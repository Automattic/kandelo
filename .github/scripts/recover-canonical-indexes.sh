#!/usr/bin/env bash
# Recover interrupted canonical index transactions independently of candidates.
set -euo pipefail

TARGET_TAG=""
MAX_PAGES=50
PER_PAGE=100
MAX_ASSET_PAGES=50
ASSET_PER_PAGE=100
MAX_TARGETS=50
RETRY_DELAY_SECONDS="${CANONICAL_RECOVERY_RETRY_DELAY_SECONDS:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-tag|--max-pages|--per-page|--max-asset-pages|--asset-per-page|--max-targets)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "recover-canonical-indexes: $1 requires a value" >&2
        exit 2
      fi
      case "$1" in
        --target-tag) TARGET_TAG="$2" ;;
        --max-pages) MAX_PAGES="$2" ;;
        --per-page) PER_PAGE="$2" ;;
        --max-asset-pages) MAX_ASSET_PAGES="$2" ;;
        --asset-per-page) ASSET_PER_PAGE="$2" ;;
        --max-targets) MAX_TARGETS="$2" ;;
      esac
      shift 2
      ;;
    *) echo "recover-canonical-indexes: unknown flag $1" >&2; exit 2 ;;
  esac
done

for value in MAX_PAGES MAX_ASSET_PAGES; do
  if ! [[ "${!value}" =~ ^[1-9][0-9]{0,2}$ ]] || [ "${!value}" -gt 100 ]; then
    echo "recover-canonical-indexes: $value must be between 1 and 100" >&2
    exit 2
  fi
done
if ! [[ "$MAX_TARGETS" =~ ^[1-9][0-9]{0,2}$ ]] || [ "$MAX_TARGETS" -gt 500 ]; then
  echo "recover-canonical-indexes: MAX_TARGETS must be between 1 and 500" >&2
  exit 2
fi
for value in PER_PAGE ASSET_PER_PAGE; do
  if ! [[ "${!value}" =~ ^[1-9][0-9]{0,2}$ ]] || [ "${!value}" -gt 100 ]; then
    echo "recover-canonical-indexes: $value must be between 1 and 100" >&2
    exit 2
  fi
done
if ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]{1,2}$ ]] || [ "$RETRY_DELAY_SECONDS" -gt 60 ]; then
  echo "recover-canonical-indexes: retry delay must be between 0 and 60 seconds" >&2
  exit 2
fi

canonical_tag_abi() {
  local tag="$1" abi
  if ! [[ "$tag" =~ ^binaries-abi-v([1-9][0-9]{0,9})$ ]]; then return 1; fi
  abi="${BASH_REMATCH[1]}"
  [ "$abi" -le 4294967295 ] || return 1
  printf '%s\n' "$abi"
}

if [ -n "$TARGET_TAG" ] && ! canonical_tag_abi "$TARGET_TAG" >/dev/null; then
  echo "recover-canonical-indexes: invalid canonical target tag $TARGET_TAG" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=.github/scripts/github-api-get.sh
source "$SCRIPT_DIR/github-api-get.sh"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-$SCRIPT_DIR/state-lock.sh}"
RELEASE_INDEX_STATE_SCRIPT="${RELEASE_INDEX_STATE_SCRIPT:-$REPO_ROOT/scripts/release-index-state.sh}"
EMPTY_SENTINEL='<!-- kandelo-index-state-v1:empty -->'
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
RELEASES_JSONL="$TMP_ROOT/releases.jsonl"
RELEASES_SECOND_JSONL="$TMP_ROOT/releases-second.jsonl"
TARGETS_TSV="$TMP_ROOT/targets.tsv"
: > "$RELEASES_JSONL"
: > "$RELEASES_SECOND_JSONL"
: > "$TARGETS_TSV"

gh_retry() {
  local attempt=1 delay="$RETRY_DELAY_SECONDS"
  while true; do
    if "$@"; then return 0; fi
    if [ "$attempt" -ge 4 ]; then return 1; fi
    echo "recover-canonical-indexes: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

list_assets() {
  local release_id="$1" output="$2"
  local page page_json count reached_end=false
  : > "$output"
  for ((page = 1; page <= MAX_ASSET_PAGES; page++)); do
    page_json=$(gh_retry gh api "/repos/${REPOSITORY}/releases/${release_id}/assets?per_page=${ASSET_PER_PAGE}&page=${page}")
    if ! jq -e '
        type == "array" and all(.[];
          (.id | type == "number" and . > 0) and
          (.name | type == "string" and length > 0) and
          (.label == null or (.label | type == "string")) and
          (.state == "uploaded" or .state == "starter"))
      ' <<<"$page_json" >/dev/null
    then
      echo "recover-canonical-indexes: malformed asset page $page for release $release_id" >&2
      return 1
    fi
    count=$(jq 'length' <<<"$page_json")
    jq -c '.[]' <<<"$page_json" >> "$output"
    if [ "$count" -lt "$ASSET_PER_PAGE" ]; then reached_end=true; break; fi
  done
  if [ "$reached_end" != true ]; then
    echo "recover-canonical-indexes: asset scan for release $release_id reached its safety bound" >&2
    return 1
  fi
  if [ -s "$output" ] && [ -n "$(jq -sr '
      (group_by(.id)[] | select(length > 1) | .[0].id),
      (sort_by(.name) | group_by(.name)[] | select(length > 1) | .[0].name)
    ' "$output")" ]; then
    echo "recover-canonical-indexes: duplicate asset ID or name for release $release_id" >&2
    return 1
  fi
}

asset_identity() {
  local assets="$1"
  if [ -s "$assets" ]; then
    jq -sr -S -c 'sort_by(.id) | map({id, name, label, state})' "$assets"
  else
    printf '[]\n'
  fi
}

inventory_releases() {
  local output="$1" release_json rc page releases count release page_releases reached_end=false
  : > "$output"
  if [ -n "$TARGET_TAG" ]; then
    release_json="$(mktemp "$TMP_ROOT/exact-release.XXXXXX")"
    rc=0
    GITHUB_API_CONTEXT=recover-canonical-indexes \
      GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
      github_api_get_json "/repos/${REPOSITORY}/releases/tags/${TARGET_TAG}" "$release_json" || rc=$?
    if [ "$rc" -eq 44 ]; then
      echo "recover-canonical-indexes: exact target $TARGET_TAG does not exist" >&2
      return 1
    fi
    [ "$rc" -eq 0 ] || return 1
    if ! release=$(jq -e -c --arg target_tag "$TARGET_TAG" -s '
        select(length == 1 and
          (.[0] | type == "object") and
          .[0].tag_name == $target_tag) |
        .[0]
      ' "$release_json")
    then
      echo "recover-canonical-indexes: exact target $TARGET_TAG returned malformed or mismatched release identity" >&2
      return 1
    fi
    printf '%s\n' "$release" >> "$output"
  else
    for ((page = 1; page <= MAX_PAGES; page++)); do
      releases=$(gh_retry gh api "/repos/${REPOSITORY}/releases?per_page=${PER_PAGE}&page=${page}")
      if ! jq -e '
          type == "array" and all(.[];
            (.id | type == "number" and . > 0) and
            (.tag_name | type == "string" and length > 0) and
            (.body == null or (.body | type == "string")))
        ' <<<"$releases" >/dev/null
      then
        echo "recover-canonical-indexes: malformed release page $page" >&2
        return 1
      fi
      count=$(jq 'length' <<<"$releases")
      page_releases="$TMP_ROOT/canonical-releases-page-${page}.jsonl"
      if ! jq -c '.[] | select(.tag_name | test("^binaries-abi-v[1-9][0-9]{0,9}$"))' \
        <<<"$releases" > "$page_releases"
      then
        echo "recover-canonical-indexes: failed to filter release page $page" >&2
        return 1
      fi
      while IFS= read -r release; do
        printf '%s\n' "$release" >> "$output"
      done < "$page_releases"
      if [ "$count" -lt "$PER_PAGE" ]; then reached_end=true; break; fi
    done
    if [ "$reached_end" != true ]; then
      echo "recover-canonical-indexes: release scan reached its safety bound" >&2
      return 1
    fi
  fi

  if [ -s "$output" ] && [ -n "$(jq -sr '
      (group_by(.id)[] | select(length > 1) | .[0].id),
      (sort_by(.tag_name) | group_by(.tag_name)[] | select(length > 1) | .[0].tag_name)
    ' "$output")" ]; then
    echo "recover-canonical-indexes: duplicate release ID or canonical tag" >&2
    return 1
  fi
}

release_identity() {
  local releases="$1"
  if [ -s "$releases" ]; then
    jq -sr -S -c 'sort_by(.id) | map({id, tag_name, body})' "$releases"
  else
    printf '[]\n'
  fi
}

inventory_releases "$RELEASES_JSONL"
inventory_releases "$RELEASES_SECOND_JSONL"
if [ "$(release_identity "$RELEASES_JSONL")" != "$(release_identity "$RELEASES_SECOND_JSONL")" ]; then
  echo "recover-canonical-indexes: release inventory changed during bounded pagination" >&2
  exit 1
fi

# Inventory the complete bounded release and asset set twice before taking any
# mutation lock. API uncertainty or pagination drift therefore fails before a
# sweep is half-applied.
while IFS= read -r release; do
  [ -n "$release" ] || continue
  if ! jq -e '(.id | type == "number" and . > 0) and
      (.tag_name | type == "string") and
      (.body == null or (.body | type == "string"))' <<<"$release" >/dev/null
  then
    echo "recover-canonical-indexes: malformed canonical release" >&2
    exit 1
  fi
  release_id=$(jq -r .id <<<"$release")
  tag=$(jq -r .tag_name <<<"$release")
  if ! abi=$(canonical_tag_abi "$tag"); then
    echo "recover-canonical-indexes: malformed canonical release tag $tag" >&2
    exit 1
  fi
  body=$(jq -r '.body // ""' <<<"$release")
  assets="$TMP_ROOT/assets-$release_id.jsonl"
  assets_second="$TMP_ROOT/assets-second-$release_id.jsonl"
  list_assets "$release_id" "$assets"
  list_assets "$release_id" "$assets_second"
  if [ "$(asset_identity "$assets")" != "$(asset_identity "$assets_second")" ]; then
    echo "recover-canonical-indexes: asset inventory for $tag changed during bounded pagination" >&2
    exit 1
  fi

  names="$TMP_ROOT/names-$release_id"
  if [ -s "$assets" ]; then jq -r .name "$assets" > "$names"; else : > "$names"; fi
  managed=false
  if grep -Eq '^(kandelo-index-|index\.toml\.)' "$names" ||
     grep -Fq "$EMPTY_SENTINEL" <<<"$body"
  then
    managed=true
  fi
  if [ -n "$TARGET_TAG" ]; then managed=true; fi
  if [ "$managed" != true ]; then
    echo "recover-canonical-indexes: skipping unmanaged legacy release $tag"
    continue
  fi

  reason=""
  malformed_reserved=$(grep -E '^(kandelo-index-|index\.toml\.)' "$names" | grep -Ev \
    -e '^kandelo-index-state-v1\.json$' \
    -e '^kandelo-index-generation-v1-[0-9a-f]{64}\.toml$' \
    -e '^kandelo-index-pending-v1-[0-9a-f]{64}\.toml$' \
    -e '^kandelo-index-transaction-v1-[0-9a-f]{64}\.json$' \
    -e '^kandelo-index-retired-v1-[0-9a-f]{64}\.toml$' || true)
  starter_count=$(jq -s '[.[] | select(.state == "starter")] | length' "$assets")
  marker_count=$(grep -Fxc kandelo-index-state-v1.json "$names" || true)
  live_count=$(grep -Fxc index.toml "$names" || true)
  marker_label=$(jq -sr -r '
    [.[] | select(.name == "kandelo-index-state-v1.json") | (.label // "")] |
    if length == 1 then .[0] else "" end
  ' "$assets")

  if [ -n "$malformed_reserved" ]; then
    reason="malformed reserved state asset"
  elif [ "$starter_count" -gt 0 ]; then
    reason="incomplete starter asset"
  elif grep -Eq '^kandelo-index-transaction-v1-[0-9a-f]{64}\.json$' "$names"; then
    reason="transaction journal present"
  elif grep -Eq '^kandelo-index-(pending|retired)-v1-[0-9a-f]{64}\.toml$' "$names"; then
    reason="orphan transaction asset"
  elif [ "$marker_count" -eq 0 ]; then
    if grep -Fq "$EMPTY_SENTINEL" <<<"$body"; then
      if [ "$live_count" -eq 0 ]; then
        reason="empty-store marker bootstrap"
      else
        reason="sentinel store has live index without marker"
      fi
    elif grep -Eq '^kandelo-index-' "$names"; then
      reason="incomplete managed state without marker"
    fi
  elif [ "$marker_count" -ne 1 ]; then
    reason="malformed marker state"
  elif [[ "$marker_label" =~ ^index-head-v1:sha256:([0-9a-f]{64})$ ]]; then
    head_sha="${BASH_REMATCH[1]}"
    expected_generation="kandelo-index-generation-v1-${head_sha}.toml"
    generation_count=$(grep -Ec '^kandelo-index-generation-v1-[0-9a-f]{64}\.toml$' "$names" || true)
    if [ "$live_count" -eq 0 ]; then
      reason="committed stable index missing"
    elif ! grep -Fxq "$expected_generation" "$names"; then
      reason="committed generation missing"
    elif [ "$generation_count" -ne 1 ]; then
      reason="orphan immutable generation"
    fi
  elif [ "$marker_label" = index-head-v1:empty ]; then
    generation_count=$(grep -Ec '^kandelo-index-generation-v1-[0-9a-f]{64}\.toml$' "$names" || true)
    if [ "$live_count" -ne 0 ]; then
      reason="empty marker has a stable index"
    elif [ "$generation_count" -ne 0 ]; then
      reason="empty marker has orphan generation"
    fi
  else
    reason="malformed marker label"
  fi

  if [ -z "$reason" ] && [ -n "$TARGET_TAG" ]; then
    reason="exact manual verification"
  fi
  if [ -z "$reason" ]; then
    echo "recover-canonical-indexes: stable managed state for $tag; skipping"
    continue
  fi
  printf '%s\t%s\t%s\n' "$tag" "$abi" "$reason" >> "$TARGETS_TSV"
done < "$RELEASES_JSONL"

target_count=$(wc -l < "$TARGETS_TSV" | tr -d '[:space:]')
if [ "$target_count" -gt "$MAX_TARGETS" ]; then
  echo "recover-canonical-indexes: $target_count actionable releases exceed the $MAX_TARGETS-target safety bound" >&2
  exit 1
fi

recover_tag() (
  set -euo pipefail
  local tag="$1" abi="$2" reason="$3"
  local lock_state="$TMP_ROOT/lock-${tag}.env" locked=0
  # shellcheck disable=SC2329 # Invoked by EXIT trap.
  cleanup_lock() {
    if [ "$locked" = 1 ]; then
      STATE_LOCK_STATE_FILE="$lock_state" bash "$STATE_LOCK_SCRIPT" release || true
    fi
  }
  trap cleanup_lock EXIT

  echo "recover-canonical-indexes: recovering $tag ($reason)"
  export STATE_LOCK_OWNER_DETAIL="scheduled canonical recovery for $tag"
  STATE_LOCK_STATE_FILE="$lock_state" bash "$STATE_LOCK_SCRIPT" acquire "$tag"
  locked=1
  bash "$RELEASE_INDEX_STATE_SCRIPT" recover \
    --target-tag "$tag" \
    --expected-abi "$abi" \
    --max-asset-pages "$MAX_ASSET_PAGES" \
    --asset-per-page "$ASSET_PER_PAGE"
)

while IFS=$'\t' read -r tag abi reason; do
  [ -n "$tag" ] || continue
  recover_tag "$tag" "$abi" "$reason"
done < "$TARGETS_TSV"

echo "recover-canonical-indexes: recovered $target_count actionable canonical release(s)"
