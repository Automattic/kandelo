#!/usr/bin/env bash
set -euo pipefail

MAX_PAGES=50
PER_PAGE=100
MAX_ASSET_PAGES=50
ASSET_PER_PAGE=100
REJECTED_RETENTION_DAYS=14
RETRY_DELAY_SECONDS="${CANDIDATE_CLEANUP_RETRY_DELAY_SECONDS:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --max-pages) MAX_PAGES="$2"; shift 2 ;;
    --per-page) PER_PAGE="$2"; shift 2 ;;
    --max-asset-pages) MAX_ASSET_PAGES="$2"; shift 2 ;;
    --asset-per-page) ASSET_PER_PAGE="$2"; shift 2 ;;
    --rejected-retention-days) REJECTED_RETENTION_DAYS="$2"; shift 2 ;;
    *) echo "cleanup-merge-candidates: unknown flag $1" >&2; exit 2 ;;
  esac
done

for value in MAX_PAGES MAX_ASSET_PAGES REJECTED_RETENTION_DAYS RETRY_DELAY_SECONDS; do
  if ! [[ "${!value}" =~ ^[0-9]+$ ]]; then
    echo "cleanup-merge-candidates: $value must be a non-negative integer" >&2
    exit 2
  fi
done
if [ "$MAX_PAGES" = "0" ] || [ "$MAX_ASSET_PAGES" = "0" ]; then
  echo "cleanup-merge-candidates: page bounds must be positive" >&2
  exit 2
fi
for value in PER_PAGE ASSET_PER_PAGE; do
  if ! [[ "${!value}" =~ ^[0-9]+$ ]] || [ "${!value}" = "0" ] || [ "${!value}" -gt 100 ]; then
    echo "cleanup-merge-candidates: $value must be between 1 and 100" >&2
    exit 2
  fi
done

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
SERVER_URL="${SERVER_URL%/}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS_SCRIPT="${STATUS_SCRIPT:-$SCRIPT_DIR/latest-merge-gate-status.sh}"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-$SCRIPT_DIR/state-lock.sh}"
# shellcheck source=.github/scripts/github-api-get.sh
source "$SCRIPT_DIR/github-api-get.sh"
NOW_EPOCH="${CANDIDATE_CLEANUP_NOW_EPOCH:-$(date +%s)}"
if ! [[ "$NOW_EPOCH" =~ ^[0-9]+$ ]]; then
  echo "cleanup-merge-candidates: current epoch must be non-negative" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
AUTHORITY_LOCK_STATE="$TMP_ROOT/authority-lock.env"
CANDIDATE_LOCK_STATE="$TMP_ROOT/candidate-lock.env"
AUTHORITY_LOCKED=0
CANDIDATE_LOCKED=0

release_candidate_locks() {
  if [ "$CANDIDATE_LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$CANDIDATE_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
    CANDIDATE_LOCKED=0
  fi
  if [ "$AUTHORITY_LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$AUTHORITY_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
    AUTHORITY_LOCKED=0
  fi
  rm -f "$AUTHORITY_LOCK_STATE" "$CANDIDATE_LOCK_STATE"
}

# shellcheck disable=SC2329 # Invoked by EXIT trap.
cleanup() {
  release_candidate_locks
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

gh_retry() {
  local attempt=1
  local delay="$RETRY_DELAY_SECONDS"
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "cleanup-merge-candidates: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

candidate_pr() {
  local tag="$1"
  if ! [[ "$tag" =~ ^merge-candidate-abi-v[0-9]+-pr-([0-9]+)-run-[0-9]+-attempt-[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "${BASH_REMATCH[1]}"
}

list_assets() {
  local release_id="$1"
  local output="$2"
  local page assets count reached_end=false

  : > "$output"
  for ((page = 1; page <= MAX_ASSET_PAGES; page++)); do
    if ! assets=$(gh_retry gh api "/repos/${REPOSITORY}/releases/${release_id}/assets?per_page=${ASSET_PER_PAGE}&page=${page}"); then
      return 1
    fi
    if ! jq -e '
        type == "array" and
        all(.[];
          ((.name | type == "string") and
           (.name | length > 0) and
           (.name | test("[\u0000-\u001f\u007f]") | not) and
           (.created_at | type == "string") and
           (.created_at |
            test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))))
      ' <<<"$assets" >/dev/null
    then
      echo "cleanup-merge-candidates: release $release_id asset page $page is malformed" >&2
      return 1
    fi
    count=$(jq 'length' <<<"$assets")
    jq -r '.[] | [.name, .created_at] | @tsv' <<<"$assets" >> "$output"
    if [ "$count" -lt "$ASSET_PER_PAGE" ]; then
      reached_end=true
      break
    fi
  done
  if [ "$reached_end" != true ]; then
    echo "cleanup-merge-candidates: release $release_id asset scan reached its safety bound" >&2
    return 1
  fi
  if [ -n "$(cut -f1 "$output" | LC_ALL=C sort | uniq -d)" ]; then
    echo "cleanup-merge-candidates: release $release_id contains duplicate asset names" >&2
    return 1
  fi
}

latest_gate_target() {
  MERGE_GATE_STATUS_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
    bash "$STATUS_SCRIPT" --head-sha "$1" --max-pages 50 --per-page 100
}

delete_candidate() {
  local tag="$1"
  local reason="$2"
  local release_json="$TMP_ROOT/delete-release.json" rc=0
  echo "cleanup-merge-candidates: deleting $tag ($reason)"
  if gh_retry gh release delete "$tag" --repo "$REPOSITORY" --yes --cleanup-tag; then
    return 0
  fi
  GITHUB_API_CONTEXT=cleanup-merge-candidates \
    GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
    github_api_get_json "/repos/${REPOSITORY}/releases/tags/${tag}" "$release_json" || rc=$?
  if [ "$rc" -eq 44 ]; then
    echo "cleanup-merge-candidates: $tag was already deleted"
    return 0
  fi
  echo "cleanup-merge-candidates: deletion of $tag is uncertain" >&2
  return 1
}

classify_candidate_locked() {
  local tag="$1" pr="$2"
  local release_json="$TMP_ROOT/current-release-$pr.json"
  local release_id pr_json state merged_at assets rejected_at rejected_epoch
  local rejected_age retention_seconds head_sha target_url expected_url rc=0

  GITHUB_API_CONTEXT=cleanup-merge-candidates \
    GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
    github_api_get_json "/repos/${REPOSITORY}/releases/tags/${tag}" "$release_json" || rc=$?
  if [ "$rc" -eq 44 ]; then
    echo "cleanup-merge-candidates: $tag was deleted before lock acquisition"
    return 0
  fi
  [ "$rc" -eq 0 ] || return 1
  if ! jq -e --arg tag "$tag" '
      .tag_name == $tag and .prerelease == true and
      (.id | type == "number" and . > 0)
    ' "$release_json" >/dev/null
  then
    echo "cleanup-merge-candidates: retaining $tag; release state is malformed" >&2
    return 1
  fi
  release_id=$(jq -r .id "$release_json")

  if ! pr_json=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${pr}"); then
    echo "cleanup-merge-candidates: retaining $tag; PR #$pr state is unavailable" >&2
    return 1
  fi
  if ! jq -e '
      (.state == "open" or .state == "closed") and
      (.merged_at == null or
       (.merged_at | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))) and
      (.head.sha | type == "string" and test("^[0-9a-f]{40}$"))
    ' <<<"$pr_json" >/dev/null
  then
    echo "cleanup-merge-candidates: retaining $tag; PR #$pr response is malformed" >&2
    return 1
  fi
  state=$(jq -r .state <<<"$pr_json")
  merged_at=$(jq -r '.merged_at // ""' <<<"$pr_json")
  if [ "$state" = open ]; then
    echo "cleanup-merge-candidates: retaining $tag; PR #$pr is open"
    return 0
  fi
  if [ -z "$merged_at" ]; then
    delete_candidate "$tag" "PR #$pr closed without merging"
    return
  fi

  assets="$TMP_ROOT/assets-$release_id.tsv"
  if ! list_assets "$release_id" "$assets"; then
    echo "cleanup-merge-candidates: retaining $tag; asset state is uncertain" >&2
    return 1
  fi
  if grep -q $'^activated.json\t' "$assets"; then
    delete_candidate "$tag" "canonical activation receipt exists"
    return
  fi
  if grep -q $'^rejected.json\t' "$assets"; then
    rejected_at=$(awk -F '\t' '$1 == "rejected.json" { print $2 }' "$assets")
    if ! rejected_epoch=$(jq -nr --arg timestamp "$rejected_at" '$timestamp | fromdateiso8601'); then
      echo "cleanup-merge-candidates: retaining $tag; rejection timestamp is invalid" >&2
      return 1
    fi
    rejected_age=$((NOW_EPOCH - rejected_epoch))
    retention_seconds=$((REJECTED_RETENTION_DAYS * 86400))
    if [ "$rejected_age" -lt 0 ] || [ "$rejected_age" -lt "$retention_seconds" ]; then
      echo "cleanup-merge-candidates: retaining rejected evidence $tag"
      return 0
    fi
    delete_candidate "$tag" "terminal rejection evidence exceeded retention"
    return
  fi
  if ! grep -q $'^ready.json\t' "$assets"; then
    delete_candidate "$tag" "merged candidate was never sealed ready"
    return
  fi

  head_sha=$(jq -r .head.sha <<<"$pr_json")
  if ! target_url=$(latest_gate_target "$head_sha"); then
    echo "cleanup-merge-candidates: retaining $tag; merge-gate state is uncertain" >&2
    return 1
  fi
  expected_url="${SERVER_URL}/${REPOSITORY}/releases/tag/${tag}"
  if [ "$target_url" = "$expected_url" ]; then
    echo "cleanup-merge-candidates: retaining authoritative recoverable candidate $tag"
    return 0
  fi
  delete_candidate "$tag" "superseded or non-authoritative merged candidate"
}

process_candidate() {
  local tag="$1" pr="$2" status=0
  export STATE_LOCK_OWNER_DETAIL="candidate cleanup authority, PR ${pr}"
  if ! STATE_LOCK_STATE_FILE="$AUTHORITY_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "merge-authority-pr-${pr}"; then
    echo "cleanup-merge-candidates: retaining $tag; authority lock is unavailable" >&2
    return 1
  fi
  AUTHORITY_LOCKED=1
  export STATE_LOCK_OWNER_DETAIL="candidate cleanup, $tag"
  if ! STATE_LOCK_STATE_FILE="$CANDIDATE_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$tag"; then
    echo "cleanup-merge-candidates: retaining $tag; candidate lock is unavailable" >&2
    release_candidate_locks
    return 1
  fi
  CANDIDATE_LOCKED=1
  classify_candidate_locked "$tag" "$pr" || status=$?
  release_candidate_locks
  return "$status"
}

releases_file="$TMP_ROOT/releases.tsv"
: > "$releases_file"
reached_end=false
for ((page = 1; page <= MAX_PAGES; page++)); do
  releases=$(gh_retry gh api "/repos/${REPOSITORY}/releases?per_page=${PER_PAGE}&page=${page}")
  if ! jq -e '
      type == "array" and
      all(.[];
        (.id | type == "number" and . > 0) and
        (.tag_name | type == "string") and
        (.prerelease | type == "boolean"))
    ' <<<"$releases" >/dev/null
  then
    echo "cleanup-merge-candidates: release page $page is malformed" >&2
    exit 1
  fi
  count=$(jq 'length' <<<"$releases")
  jq -r '
    .[] |
    select(.prerelease == true) |
    select(.tag_name | startswith("merge-candidate-abi-v")) |
    [.id, .tag_name] | @tsv
  ' <<<"$releases" >> "$releases_file"
  if [ "$count" -lt "$PER_PAGE" ]; then
    reached_end=true
    break
  fi
done
if [ "$reached_end" != true ]; then
  echo "cleanup-merge-candidates: release scan reached its safety bound; deleting nothing" >&2
  exit 1
fi

uncertain=0
while IFS=$'\t' read -r release_id tag; do
  [ -n "$tag" ] || continue
  if ! pr=$(candidate_pr "$tag"); then
    echo "cleanup-merge-candidates: retaining malformed candidate-like tag $tag" >&2
    uncertain=1
    continue
  fi

  if ! process_candidate "$tag" "$pr"; then uncertain=1; fi
done < "$releases_file"

exit "$uncertain"
