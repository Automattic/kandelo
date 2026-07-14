#!/usr/bin/env bash
set -euo pipefail

PR_NUMBER=""
EXPECTED_HEAD_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr-number) PR_NUMBER="$2"; shift 2 ;;
    --head-sha) EXPECTED_HEAD_SHA="$2"; shift 2 ;;
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
if [ "$review_decision" != "APPROVED" ]; then
  echo "require-exact-head-approval: PR #$PR_NUMBER review decision is ${review_decision:-unset}, not APPROVED" >&2
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
      echo "require-exact-head-approval: qualified reviewer $reviewer approved exact head $EXPECTED_HEAD_SHA"
      exit 0
      ;;
  esac
done

echo "require-exact-head-approval: no qualified non-dismissed approval exists for exact head $EXPECTED_HEAD_SHA" >&2
exit 1
