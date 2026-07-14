#!/usr/bin/env bash
set -euo pipefail

CANDIDATE_TAG=""
EXPECTED_BASE_SHA=""
EXPECTED_HEAD_SHA=""
EXPECTED_SYNTHETIC_TREE_SHA=""
EXPECTED_RUN_ID=""
EXPECTED_RUN_ATTEMPT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate-tag) CANDIDATE_TAG="$2"; shift 2 ;;
    --base-sha) EXPECTED_BASE_SHA="$2"; shift 2 ;;
    --head-sha) EXPECTED_HEAD_SHA="$2"; shift 2 ;;
    --synthetic-tree-sha) EXPECTED_SYNTHETIC_TREE_SHA="$2"; shift 2 ;;
    --run-id) EXPECTED_RUN_ID="$2"; shift 2 ;;
    --run-attempt) EXPECTED_RUN_ATTEMPT="$2"; shift 2 ;;
    *) echo "mark-merge-candidate-ready: unknown flag $1" >&2; exit 2 ;;
  esac
done

for value in CANDIDATE_TAG EXPECTED_BASE_SHA EXPECTED_HEAD_SHA \
  EXPECTED_SYNTHETIC_TREE_SHA EXPECTED_RUN_ID EXPECTED_RUN_ATTEMPT
do
  if [ -z "${!value}" ]; then
    echo "mark-merge-candidate-ready: missing ${value,,}" >&2
    exit 2
  fi
done

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-.github/scripts/state-lock.sh}"
AUTHORITY_LOCK_STATE="$(mktemp)"
CANDIDATE_LOCK_STATE="$(mktemp)"
TMP_ROOT="$(mktemp -d)"
AUTHORITY_LOCKED=0
CANDIDATE_LOCKED=0

if ! [[ "$CANDIDATE_TAG" =~ -pr-([0-9]+)-run- ]]; then
  echo "mark-merge-candidate-ready: candidate tag does not identify a PR" >&2
  exit 2
fi
PR_NUMBER="${BASH_REMATCH[1]}"

release_lock() {
  if [ "$CANDIDATE_LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$CANDIDATE_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
  fi
  if [ "$AUTHORITY_LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$AUTHORITY_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
  fi
  rm -rf "$TMP_ROOT" "$AUTHORITY_LOCK_STATE" "$CANDIDATE_LOCK_STATE"
}
trap release_lock EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

export STATE_LOCK_OWNER_DETAIL="candidate ready marker"
STATE_LOCK_STATE_FILE="$AUTHORITY_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "merge-authority-pr-${PR_NUMBER}"
AUTHORITY_LOCKED=1
STATE_LOCK_STATE_FILE="$CANDIDATE_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$CANDIDATE_TAG"
CANDIDATE_LOCKED=1

mkdir -p "$TMP_ROOT/release"
gh release download "$CANDIDATE_TAG" \
  --repo "$REPOSITORY" \
  --pattern candidate.json \
  --pattern base-index.toml \
  --pattern index.toml \
  --dir "$TMP_ROOT/release"

candidate_json="$TMP_ROOT/release/candidate.json"
candidate_index="$TMP_ROOT/release/index.toml"
base_index="$TMP_ROOT/release/base-index.toml"

jq -e \
  --arg repository "$REPOSITORY" \
  --arg candidate_tag "$CANDIDATE_TAG" \
  --arg base_sha "$EXPECTED_BASE_SHA" \
  --arg head_sha "$EXPECTED_HEAD_SHA" \
  --arg synthetic_tree_sha "$EXPECTED_SYNTHETIC_TREE_SHA" \
  --arg run_id "$EXPECTED_RUN_ID" \
  --arg run_attempt "$EXPECTED_RUN_ATTEMPT" \
  --argjson pr_number "$PR_NUMBER" \
  '.repository == $repository and
   .pr_number == $pr_number and
   .candidate_tag == $candidate_tag and
   .base_sha == $base_sha and
   .head_sha == $head_sha and
   .synthetic_tree_sha == $synthetic_tree_sha and
   .run_id == $run_id and
   .run_attempt == $run_attempt' \
  "$candidate_json" >/dev/null

base_index_sha=$(sha256_file "$base_index")
if [ "$base_index_sha" != "$(jq -r .base_index_sha256 "$candidate_json")" ]; then
  echo "mark-merge-candidate-ready: immutable base index digest mismatch" >&2
  exit 1
fi

candidate_index_sha=$(sha256_file "$candidate_index")
ready_json="$TMP_ROOT/ready.json"
jq \
  --arg candidate_index_sha256 "$candidate_index_sha" \
  --arg ready_at "$(date -u +%FT%TZ)" \
  '. + {
    candidate_index_sha256: $candidate_index_sha256,
    ready_at: $ready_at
  }' "$candidate_json" > "$ready_json"

if gh release view "$CANDIDATE_TAG" --repo "$REPOSITORY" --json assets \
    --jq '.assets[].name' | grep -Fxq ready.json
then
  mkdir -p "$TMP_ROOT/existing"
  gh release download "$CANDIDATE_TAG" \
    --repo "$REPOSITORY" \
    --pattern ready.json \
    --dir "$TMP_ROOT/existing"
  existing_identity=$(jq -S -c 'del(.ready_at)' "$TMP_ROOT/existing/ready.json")
  requested_identity=$(jq -S -c 'del(.ready_at)' "$ready_json")
  if [ "$existing_identity" != "$requested_identity" ]; then
    echo "mark-merge-candidate-ready: candidate already has a different ready marker" >&2
    exit 1
  fi
  echo "mark-merge-candidate-ready: exact ready marker already exists for $CANDIDATE_TAG"
else
  gh release upload "$CANDIDATE_TAG" \
    --repo "$REPOSITORY" \
    "$ready_json"
  echo "mark-merge-candidate-ready: sealed tested candidate $CANDIDATE_TAG ($candidate_index_sha)"
fi

# Candidate selection and its ready marker are one authority transaction. A
# duplicate Prepare run cannot supersede this status between sealing and post.
gh api \
  --method POST \
  -H 'Accept: application/vnd.github+json' \
  "/repos/${REPOSITORY}/statuses/${EXPECTED_HEAD_SHA}" \
  -f state=success \
  -f context=merge-gate \
  -f description='Sealed merge candidate passed; canonical activation waits for the exact merge.' \
  -f target_url="${SERVER_URL%/}/${REPOSITORY}/releases/tag/${CANDIDATE_TAG}"
echo "mark-merge-candidate-ready: published merge-gate authority for $CANDIDATE_TAG"
