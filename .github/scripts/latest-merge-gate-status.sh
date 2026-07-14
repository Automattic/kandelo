#!/usr/bin/env bash
set -euo pipefail

HEAD_SHA=""
MAX_PAGES=50
PER_PAGE=100
RETRY_DELAY_SECONDS="${MERGE_GATE_STATUS_RETRY_DELAY_SECONDS:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --head-sha) HEAD_SHA="$2"; shift 2 ;;
    --max-pages) MAX_PAGES="$2"; shift 2 ;;
    --per-page) PER_PAGE="$2"; shift 2 ;;
    *) echo "latest-merge-gate-status: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "latest-merge-gate-status: --head-sha must be a 40-character lowercase SHA" >&2
  exit 2
fi
if ! [[ "$MAX_PAGES" =~ ^[0-9]+$ ]] || [ "$MAX_PAGES" = 0 ]; then
  echo "latest-merge-gate-status: --max-pages must be positive" >&2
  exit 2
fi
if ! [[ "$PER_PAGE" =~ ^[0-9]+$ ]] || [ "$PER_PAGE" = 0 ] || [ "$PER_PAGE" -gt 100 ]; then
  echo "latest-merge-gate-status: --per-page must be between 1 and 100" >&2
  exit 2
fi
if ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "latest-merge-gate-status: retry delay must be non-negative" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
ALL_STATUSES="$TMP_ROOT/statuses.jsonl"
: > "$ALL_STATUSES"

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
    echo "latest-merge-gate-status: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

reached_end=false
for ((page = 1; page <= MAX_PAGES; page++)); do
  statuses=$(gh_retry gh api \
    "/repos/${REPOSITORY}/commits/${HEAD_SHA}/statuses?per_page=${PER_PAGE}&page=${page}")
  if ! jq -e '
      type == "array" and
      all(.[];
        (.id | type == "number" and . > 0) and
        (.context | type == "string") and
        (.state | type == "string") and
        (.target_url == null or (.target_url | type == "string")) and
        (.created_at | type == "string" and
          test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
    ' <<<"$statuses" >/dev/null
  then
    echo "latest-merge-gate-status: status page $page is malformed" >&2
    exit 1
  fi
  count=$(jq 'length' <<<"$statuses")
  jq -c '.[]' <<<"$statuses" >> "$ALL_STATUSES"
  if [ "$count" -lt "$PER_PAGE" ]; then
    reached_end=true
    break
  fi
done

if [ "$reached_end" != true ]; then
  echo "latest-merge-gate-status: status scan reached its ${MAX_PAGES}-page safety bound" >&2
  exit 1
fi
if [ -s "$ALL_STATUSES" ] && \
   [ -n "$(jq -sr 'group_by(.id)[] | select(length > 1) | .[0].id' "$ALL_STATUSES")" ]; then
  echo "latest-merge-gate-status: duplicate status IDs make pagination uncertain" >&2
  exit 1
fi

jq -sr -r '
  map(select(.context == "merge-gate")) |
  sort_by(.created_at, .id) |
  last // null |
  if . == null or .state != "success" then "" else (.target_url // "") end
' "$ALL_STATUSES"
