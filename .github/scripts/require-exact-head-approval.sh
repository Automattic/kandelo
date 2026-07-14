#!/usr/bin/env bash
set -euo pipefail

PR_NUMBER=""
EXPECTED_HEAD_SHA=""
LABEL_ACTOR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr-number) PR_NUMBER="$2"; shift 2 ;;
    --head-sha) EXPECTED_HEAD_SHA="$2"; shift 2 ;;
    --label-actor) LABEL_ACTOR="$2"; shift 2 ;;
    *) echo "require-exact-head-approval: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || [ "$PR_NUMBER" = "0" ]; then
  echo "require-exact-head-approval: --pr-number must be a positive integer" >&2
  exit 2
fi
if ! [[ "$EXPECTED_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "require-exact-head-approval: --head-sha must be a 40-character lowercase SHA" >&2
  exit 2
fi
if [ -n "$LABEL_ACTOR" ] && ! [[ "$LABEL_ACTOR" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "require-exact-head-approval: --label-actor must be a GitHub login" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
RETRY_DELAY_SECONDS="${APPROVAL_RETRY_DELAY_SECONDS:-2}"
if ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "require-exact-head-approval: APPROVAL_RETRY_DELAY_SECONDS must be non-negative" >&2
  exit 2
fi

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
    echo "require-exact-head-approval: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

require_current_head() {
  local phase="$1"
  local current_pr current_head

  current_pr=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${PR_NUMBER}")
  if ! current_head=$(jq -er '.head.sha | select(type == "string" and test("^[0-9a-f]{40}$"))' \
      <<<"$current_pr")
  then
    echo "require-exact-head-approval: PR #$PR_NUMBER response is malformed during $phase" >&2
    exit 1
  fi
  if [ "$current_head" != "$EXPECTED_HEAD_SHA" ]; then
    echo "require-exact-head-approval: PR #$PR_NUMBER advanced from tested head $EXPECTED_HEAD_SHA to $current_head during $phase" >&2
    exit 1
  fi
}

pr_json=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${PR_NUMBER}")
if ! jq -e '
    (.head.sha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.user.login | type == "string" and test("^[A-Za-z0-9-]+$"))
  ' <<<"$pr_json" >/dev/null
then
  echo "require-exact-head-approval: PR #$PR_NUMBER response is malformed" >&2
  exit 1
fi
current_head=$(jq -r .head.sha <<<"$pr_json")
author_login=$(jq -r .user.login <<<"$pr_json")
if [ "$current_head" != "$EXPECTED_HEAD_SHA" ]; then
  echo "require-exact-head-approval: PR #$PR_NUMBER advanced from tested head $EXPECTED_HEAD_SHA to $current_head" >&2
  exit 1
fi

# Keep GitHub's aggregate decision as the source of truth for outstanding
# CHANGES_REQUESTED reviews and the repository's required-review policy.
review_decision=$(gh_retry gh pr view "$PR_NUMBER" \
  --repo "$REPOSITORY" \
  --json reviewDecision \
  --jq .reviewDecision)
if [ "$review_decision" = "CHANGES_REQUESTED" ]; then
  echo "require-exact-head-approval: PR #$PR_NUMBER has outstanding CHANGES_REQUESTED reviews" >&2
  exit 1
fi

# Applying ready-to-ship is an approval-equivalent, exact-head attestation when
# the event sender currently has repository maintain or admin permission. The
# workflow passes the sender from GitHub's pull_request:labeled payload, whose
# head SHA is EXPECTED_HEAD_SHA; a persistent label is never used as authority.
if [ -n "$LABEL_ACTOR" ]; then
  actor_permission_json=$(gh_retry gh api \
    "/repos/${REPOSITORY}/collaborators/${LABEL_ACTOR}/permission")
  if ! actor_permission=$(jq -er '.permission | select(type == "string")' \
      <<<"$actor_permission_json")
  then
    echo "require-exact-head-approval: label actor $LABEL_ACTOR permission response is malformed" >&2
    exit 1
  fi
  case "$actor_permission" in
    maintain|admin)
      require_current_head "maintainer attestation"
      echo "require-exact-head-approval: qualified maintainer $LABEL_ACTOR attested exact head $EXPECTED_HEAD_SHA"
      exit 0
      ;;
  esac
fi

if [ "$review_decision" != "APPROVED" ]; then
  echo "require-exact-head-approval: PR #$PR_NUMBER review decision is ${review_decision:-unset}, not APPROVED, and the label actor is not a maintainer" >&2
  exit 1
fi

# Branch protection in this repository does not dismiss stale reviews, so the
# aggregate decision alone cannot prove that the exact tested head was seen.
# --paginate --slurp preserves every page as one JSON array for validation.
review_pages=$(gh_retry gh api --paginate --slurp \
  "/repos/${REPOSITORY}/pulls/${PR_NUMBER}/reviews?per_page=100")
if ! jq -e '
    type == "array" and all(.[]; type == "array") and
    all(.[][];
      (.state | type == "string") and
      (.commit_id | type == "string") and
      (.user.login | type == "string"))
  ' <<<"$review_pages" >/dev/null
then
  echo "require-exact-head-approval: PR #$PR_NUMBER reviews response is malformed" >&2
  exit 1
fi

mapfile -t exact_reviewers < <(jq -r --arg head "$EXPECTED_HEAD_SHA" '
  add |
  .[] |
  select(.state == "APPROVED" and .commit_id == $head) |
  .user.login |
  select(test("^[A-Za-z0-9-]+$"))
' <<<"$review_pages" | LC_ALL=C sort -u)

for reviewer in "${exact_reviewers[@]}"; do
  # A PR author cannot satisfy a required approving review.
  [ "$reviewer" != "$author_login" ] || continue
  permission_json=$(gh_retry gh api \
    "/repos/${REPOSITORY}/collaborators/${reviewer}/permission")
  if ! permission=$(jq -er '.permission | select(type == "string")' \
      <<<"$permission_json")
  then
    echo "require-exact-head-approval: reviewer $reviewer permission response is malformed" >&2
    exit 1
  fi
  case "$permission" in
    push|write|maintain|admin)
      require_current_head "review authorization"
      echo "require-exact-head-approval: qualified reviewer $reviewer approved exact head $EXPECTED_HEAD_SHA"
      exit 0
      ;;
  esac
done

echo "require-exact-head-approval: no qualified non-dismissed approval exists for exact head $EXPECTED_HEAD_SHA" >&2
exit 1
