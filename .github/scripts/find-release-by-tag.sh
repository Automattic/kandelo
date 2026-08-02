#!/usr/bin/env bash
# Find one GitHub release by exact tag, including draft releases.
set -euo pipefail

TAG=""
OUTPUT_FILE=""
MAX_PAGES="${FIND_RELEASE_MAX_PAGES:-50}"
PER_PAGE="${FIND_RELEASE_PER_PAGE:-100}"
RETRY_DELAY_SECONDS="${FIND_RELEASE_RETRY_DELAY_SECONDS:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --output-file) OUTPUT_FILE="$2"; shift 2 ;;
    *) echo "find-release-by-tag: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$ ]]; then
  echo "find-release-by-tag: --tag must name one safe release tag" >&2
  exit 2
fi
if [ -z "$OUTPUT_FILE" ] || [ "$OUTPUT_FILE" = / ] ||
   [ -L "$OUTPUT_FILE" ] ||
   { [ -e "$OUTPUT_FILE" ] && [ ! -f "$OUTPUT_FILE" ]; } ||
   [ ! -d "$(dirname "$OUTPUT_FILE")" ]; then
  echo "find-release-by-tag: --output-file must be a regular file path" >&2
  exit 2
fi
if ! [[ "$MAX_PAGES" =~ ^[1-9][0-9]*$ ]]; then
  echo "find-release-by-tag: page bound must be positive" >&2
  exit 2
fi
if ! [[ "$PER_PAGE" =~ ^[1-9][0-9]*$ ]] || [ "$PER_PAGE" -gt 100 ]; then
  echo "find-release-by-tag: page size must be between 1 and 100" >&2
  exit 2
fi
if ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "find-release-by-tag: retry delay must be non-negative" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
RELEASES_JSONL="$TMP_ROOT/releases.jsonl"
: >"$RELEASES_JSONL"
rm -f "$OUTPUT_FILE"

gh_retry() {
  local attempt=1 delay="$RETRY_DELAY_SECONDS"
  while true; do
    if "$@"; then return 0; fi
    if [ "$attempt" -ge 4 ]; then return 1; fi
    echo "find-release-by-tag: GitHub command failed; retrying in ${delay}s: $*" >&2
    if [ "$delay" -gt 0 ]; then sleep "$delay"; fi
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

reached_end=false
for ((page = 1; page <= MAX_PAGES; page++)); do
  page_json="$(gh_retry gh api \
    "/repos/${REPOSITORY}/releases?per_page=${PER_PAGE}&page=${page}")"
  if ! jq -e '
      type == "array" and
      all(.[];
        type == "object" and
        (.id | (type == "number" and . > 0 and floor == .)) and
        (.tag_name | (type == "string" and length > 0 and
          (test("[[:cntrl:]]") | not))) and
        (.draft | type == "boolean") and
        (.prerelease | type == "boolean") and
        (.immutable | type == "boolean") and
        ((.draft and .immutable) | not))
    ' <<<"$page_json" >/dev/null
  then
    echo "find-release-by-tag: release page $page is malformed" >&2
    exit 1
  fi
  jq -c '.[] | .' <<<"$page_json" >>"$RELEASES_JSONL"
  count="$(jq 'length' <<<"$page_json")"
  if [ "$count" -lt "$PER_PAGE" ]; then
    reached_end=true
    break
  fi
done
if [ "$reached_end" != true ]; then
  echo "find-release-by-tag: release discovery reached its safety bound" >&2
  exit 1
fi

if [ -s "$RELEASES_JSONL" ]; then
  releases="$TMP_ROOT/releases.json"
  jq -s . "$RELEASES_JSONL" >"$releases"
else
  releases="$TMP_ROOT/releases.json"
  printf '[]\n' >"$releases"
fi

# WHY: the release list is mutable while it is paginated. Repeated IDs mean
# the pages did not form one coherent inventory, so accepting even an exact
# tag could bind the caller to a release selected from an incomplete view.
if ! jq -e '([.[].id] | length) == ([.[].id] | unique | length)' \
    "$releases" >/dev/null
then
  echo "find-release-by-tag: release discovery contains duplicate IDs" >&2
  exit 1
fi

matches="$TMP_ROOT/matches.json"
jq --arg tag "$TAG" '[.[] | select(.tag_name == $tag)]' \
  "$releases" >"$matches"
case "$(jq 'length' "$matches")" in
  0) exit 44 ;;
  1) ;;
  *)
    echo "find-release-by-tag: multiple releases claim tag $TAG" >&2
    exit 1
    ;;
esac

temporary="$(mktemp "$(dirname "$OUTPUT_FILE")/.release-by-tag.XXXXXX")"
jq '.[0]' "$matches" >"$temporary"
mv -f "$temporary" "$OUTPUT_FILE"
