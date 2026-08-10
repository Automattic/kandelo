#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: update-abi-staging-check.sh \
  --repository OWNER/REPOSITORY \
  --pull-request NUMBER \
  --projection CANONICAL_PROJECTION_JSON \
  --details-url PROTECTED_ACTIONS_RUN_URL
USAGE
  exit 2
}

REPOSITORY=
PULL_REQUEST=
PROJECTION=
DETAILS_URL=
while (($#)); do
  case "$1" in
    --repository) REPOSITORY=${2:-}; shift 2 ;;
    --pull-request) PULL_REQUEST=${2:-}; shift 2 ;;
    --projection) PROJECTION=${2:-}; shift 2 ;;
    --details-url) DETAILS_URL=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done

[[ $REPOSITORY =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || usage
[[ $PULL_REQUEST =~ ^[1-9][0-9]*$ ]] || usage
[[ -n $PROJECTION && -f $PROJECTION && ! -L $PROJECTION ]] || usage
DETAILS_PREFIX="https://github.com/${REPOSITORY}/actions/runs/"
[[ $DETAILS_URL == "$DETAILS_PREFIX"* ]] || usage
DETAILS_RUN_ID=${DETAILS_URL#"$DETAILS_PREFIX"}
[[ $DETAILS_RUN_ID =~ ^[1-9][0-9]*$ && $DETAILS_URL == "$DETAILS_PREFIX$DETAILS_RUN_ID" ]] || usage
[[ -n ${GH_TOKEN:-} ]] || {
  echo "update-abi-staging-check: GH_TOKEN is required" >&2
  exit 2
}
command -v gh >/dev/null || {
  echo "update-abi-staging-check: gh is required" >&2
  exit 2
}
command -v jq >/dev/null || {
  echo "update-abi-staging-check: jq is required" >&2
  exit 2
}

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

jq -e -cS . "$PROJECTION" >"$TMP_ROOT/projection.canonical" || {
  echo "update-abi-staging-check: projection is invalid JSON" >&2
  exit 1
}
cmp -s "$PROJECTION" "$TMP_ROOT/projection.canonical" || {
  echo "update-abi-staging-check: projection is not canonical JSON" >&2
  exit 1
}
jq -e '
  (keys - ["request", "tap_plan"]) == [
    "background", "blockers", "computed_conclusion", "details_markdown",
    "discovery_delayed", "external_id", "head_sha", "name",
    "published_conclusion", "required_formulae", "required_products",
    "summary_markdown"
  ] and
  .name == "Kandelo PR Check" and
  (.head_sha | type == "string" and test("^[0-9a-f]{40}$")) and
  (.external_id | type == "string" and length <= 512) and
  (.computed_conclusion | IN("not_applicable", "pending", "failure", "success")) and
  (.published_conclusion | IN("in_progress", "neutral", "failure", "success")) and
  (.discovery_delayed | type == "boolean") and
  (.summary_markdown | type == "string") and
  (.details_markdown | type == "string") and
  (.background | type == "array" and length <= 8192) and
  (.blockers | type == "array" and length <= 8192) and
  (.required_formulae | type == "array" and length <= 8192) and
  (.required_products | type == "array" and length <= 8192) and
  ((has("request") | not) or (.request | type == "object")) and
  ((has("tap_plan") | not) or (.tap_plan | type == "object")) and
  (
    .published_conclusion == "neutral" or
    (.published_conclusion == "in_progress" and .computed_conclusion == "pending") or
    (.published_conclusion == "failure" and .computed_conclusion == "failure") or
    (.published_conclusion == "success" and
      (.computed_conclusion | IN("not_applicable", "success")))
  )
' "$PROJECTION" >/dev/null || {
  echo "update-abi-staging-check: projection has an invalid closed shape" >&2
  exit 1
}

HEAD_SHA=$(jq -r '.head_sha' "$PROJECTION")
EXTERNAL_ID=$(jq -r '.external_id' "$PROJECTION")
PUBLISHED=$(jq -r '.published_conclusion' "$PROJECTION")
EXPECTED_PREFIX="abi-staging:${PULL_REQUEST}:${HEAD_SHA}:"
REQUEST_DIGEST=${EXTERNAL_ID#"$EXPECTED_PREFIX"}
[[ $EXTERNAL_ID == "$EXPECTED_PREFIX$REQUEST_DIGEST" && $REQUEST_DIGEST =~ ^[0-9a-f]{64}$ ]] || {
  echo "update-abi-staging-check: external ID differs from the exact PR and head" >&2
  exit 1
}

jq -j '.summary_markdown' "$PROJECTION" >"$TMP_ROOT/summary.md"
jq -j '.details_markdown' "$PROJECTION" >"$TMP_ROOT/details.md"
SUMMARY_BYTES=$(wc -c <"$TMP_ROOT/summary.md" | tr -d ' ')
DETAILS_BYTES=$(wc -c <"$TMP_ROOT/details.md" | tr -d ' ')
((SUMMARY_BYTES <= 8192 && DETAILS_BYTES <= 49152)) || {
  echo "update-abi-staging-check: projection Markdown exceeds its byte bound" >&2
  exit 1
}
SUMMARY=$(<"$TMP_ROOT/summary.md")
DETAILS=$(<"$TMP_ROOT/details.md")

CHECK_PAGES="$TMP_ROOT/check-runs.json"
gh api --paginate --slurp \
  -H 'Accept: application/vnd.github+json' \
  "/repos/${REPOSITORY}/commits/${HEAD_SHA}/check-runs?check_name=Kandelo%20PR%20Check&per_page=100&filter=all" \
  >"$CHECK_PAGES"
jq -e '
  type == "array" and length <= 64 and all(.[];
    type == "object" and
    (.total_count | type == "number" and . >= 0 and floor == .) and
    (.check_runs | type == "array")
  ) and
  ([.[].check_runs[]] | length <= 4096) and
  all(.[].check_runs[];
    (.id | type == "number" and . >= 1 and floor == .) and
    (.name | type == "string") and
    (.head_sha | type == "string") and
    ((.external_id == null) or (.external_id | type == "string"))
  )
' "$CHECK_PAGES" >/dev/null || {
  echo "update-abi-staging-check: exact-head Check inventory is invalid or too large" >&2
  exit 1
}
MATCHES="$TMP_ROOT/matches.json"
jq -c \
  --arg name 'Kandelo PR Check' \
  --arg head "$HEAD_SHA" \
  --arg external "$EXTERNAL_ID" \
  '[.[].check_runs[] | select(.name == $name and .head_sha == $head and .external_id == $external)]' \
  "$CHECK_PAGES" >"$MATCHES"
MATCH_COUNT=$(jq 'length' "$MATCHES")
((MATCH_COUNT <= 1)) || {
  echo "update-abi-staging-check: duplicate exact external-ID Checks" >&2
  exit 1
}
if ((MATCH_COUNT == 0)) && [[ $REQUEST_DIGEST != $(printf '0%.0s' {1..64}) ]]; then
  MISSING_EXTERNAL="abi-staging:${PULL_REQUEST}:${HEAD_SHA}:$(printf '0%.0s' {1..64})"
  jq -c \
    --arg name 'Kandelo PR Check' \
    --arg head "$HEAD_SHA" \
    --arg external "$MISSING_EXTERNAL" \
    '[.[].check_runs[] | select(.name == $name and .head_sha == $head and .external_id == $external)]' \
    "$CHECK_PAGES" >"$MATCHES"
  MATCH_COUNT=$(jq 'length' "$MATCHES")
  ((MATCH_COUNT <= 1)) || {
    echo "update-abi-staging-check: duplicate request-missing sentinel Checks" >&2
    exit 1
  }
fi

STATUS=completed
CONCLUSION=$PUBLISHED
if [[ $PUBLISHED == in_progress ]]; then
  STATUS=in_progress
  CONCLUSION=
fi

# This exact-head query is deliberately the final read before the write.
PR_JSON="$TMP_ROOT/pull-request.json"
gh api -H 'Accept: application/vnd.github+json' \
  "/repos/${REPOSITORY}/pulls/${PULL_REQUEST}" >"$PR_JSON"
jq -e \
  --arg repository "$REPOSITORY" \
  --arg head "$HEAD_SHA" '
    .state == "open" and
    .head.sha == $head and
    .head.repo.full_name == $repository
  ' "$PR_JSON" >/dev/null || {
  echo "update-abi-staging-check: pull-request head changed before Check write" >&2
  exit 1
}

WRITE_ARGS=(
  -f "details_url=$DETAILS_URL"
  -f "external_id=$EXTERNAL_ID"
  -f "status=$STATUS"
  -f 'output[title]=Kandelo PR Check'
  -f "output[summary]=$SUMMARY"
  -f "output[text]=$DETAILS"
)
if [[ -n $CONCLUSION ]]; then
  WRITE_ARGS+=(-f "conclusion=$CONCLUSION")
fi
if ((MATCH_COUNT == 0)); then
  RESPONSE=$(gh api --method POST "/repos/${REPOSITORY}/check-runs" \
    -f 'name=Kandelo PR Check' \
    -f "head_sha=$HEAD_SHA" \
    "${WRITE_ARGS[@]}")
else
  CHECK_ID=$(jq -r '.[0].id' "$MATCHES")
  RESPONSE=$(gh api --method PATCH "/repos/${REPOSITORY}/check-runs/${CHECK_ID}" \
    -f 'name=Kandelo PR Check' \
    "${WRITE_ARGS[@]}")
fi
jq -e '.id | type == "number" and . >= 1 and floor == .' <<<"$RESPONSE" >/dev/null || {
  echo "update-abi-staging-check: GitHub returned an invalid Check response" >&2
  exit 1
}
