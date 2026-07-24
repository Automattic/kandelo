#!/usr/bin/env bash
set -euo pipefail

CANONICAL_INDEX=""
CANDIDATE_TAG=""
CANONICAL_TAG=""
CANONICAL_STATE=""
ABI=""
PR_NUMBER=""
BASE_REF=""
BASE_SHA=""
HEAD_SHA=""
SYNTHETIC_MERGE_SHA=""
SYNTHETIC_TREE_SHA=""
MERGE_METHOD=""
PR_COMMIT_COUNT=""
RUN_ID=""
RUN_ATTEMPT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --canonical-index) CANONICAL_INDEX="$2"; shift 2 ;;
    --candidate-tag) CANDIDATE_TAG="$2"; shift 2 ;;
    --canonical-tag) CANONICAL_TAG="$2"; shift 2 ;;
    --canonical-state) CANONICAL_STATE="$2"; shift 2 ;;
    --abi) ABI="$2"; shift 2 ;;
    --pr-number) PR_NUMBER="$2"; shift 2 ;;
    --base-ref) BASE_REF="$2"; shift 2 ;;
    --base-sha) BASE_SHA="$2"; shift 2 ;;
    --head-sha) HEAD_SHA="$2"; shift 2 ;;
    --synthetic-merge-sha) SYNTHETIC_MERGE_SHA="$2"; shift 2 ;;
    --synthetic-tree-sha) SYNTHETIC_TREE_SHA="$2"; shift 2 ;;
    --merge-method) MERGE_METHOD="$2"; shift 2 ;;
    --pr-commit-count) PR_COMMIT_COUNT="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --run-attempt) RUN_ATTEMPT="$2"; shift 2 ;;
    *) echo "init-merge-candidate: unknown flag $1" >&2; exit 2 ;;
  esac
done

for value in \
  CANONICAL_INDEX CANDIDATE_TAG CANONICAL_TAG CANONICAL_STATE ABI PR_NUMBER BASE_REF BASE_SHA \
  HEAD_SHA SYNTHETIC_MERGE_SHA SYNTHETIC_TREE_SHA MERGE_METHOD PR_COMMIT_COUNT \
  RUN_ID RUN_ATTEMPT
do
  if [ -z "${!value}" ]; then
    echo "init-merge-candidate: missing ${value,,}" >&2
    exit 2
  fi
done

if [ ! -f "$CANONICAL_INDEX" ]; then
  echo "init-merge-candidate: canonical index is not a file: $CANONICAL_INDEX" >&2
  exit 2
fi
if ! [[ "$CANDIDATE_TAG" =~ ^merge-candidate-abi-v${ABI}-pr-${PR_NUMBER}-run-${RUN_ID}-attempt-${RUN_ATTEMPT}$ ]]; then
  echo "init-merge-candidate: candidate tag does not match its bound identity: $CANDIDATE_TAG" >&2
  exit 2
fi
if [ "$CANONICAL_TAG" != "binaries-abi-v${ABI}" ]; then
  echo "init-merge-candidate: canonical tag $CANONICAL_TAG does not match ABI $ABI" >&2
  exit 2
fi
if [ "$CANONICAL_STATE" != present ] && [ "$CANONICAL_STATE" != absent ]; then
  echo "init-merge-candidate: canonical state must be present or absent" >&2
  exit 2
fi
if ! [[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ && "$HEAD_SHA" =~ ^[0-9a-f]{40}$ && \
        "$SYNTHETIC_MERGE_SHA" =~ ^[0-9a-f]{40}$ && "$SYNTHETIC_TREE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "init-merge-candidate: candidate commit identities must be 40-char lowercase hex" >&2
  exit 2
fi
if [ "$MERGE_METHOD" != "squash" ] && [ "$MERGE_METHOD" != "rebase" ] &&
   [ "$MERGE_METHOD" != "merge" ]; then
  echo "init-merge-candidate: merge method must be squash, rebase, or merge" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=.github/scripts/github-api-get.sh
source "$SCRIPT_DIR/github-api-get.sh"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-.github/scripts/state-lock.sh}"
LOCK_STATE="$(mktemp)"
TMP_ROOT="$(mktemp -d)"

release_lock() {
  STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
  rm -rf "$TMP_ROOT" "$LOCK_STATE"
}
trap release_lock EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

gh_retry() {
  local attempt=1
  local delay=2
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "init-merge-candidate: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

export STATE_LOCK_OWNER_DETAIL="candidate init, PR ${PR_NUMBER}"
STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$CANDIDATE_TAG"

release_json="$TMP_ROOT/release.json"
release_rc=0
GITHUB_API_CONTEXT=init-merge-candidate \
  github_api_get_json "/repos/${REPOSITORY}/releases/tags/${CANDIDATE_TAG}" "$release_json" || release_rc=$?
if [ "$release_rc" -eq 44 ]; then
  if ! gh_retry gh release create "$CANDIDATE_TAG" \
    --repo "$REPOSITORY" \
    --target "$HEAD_SHA" \
    --title "$CANDIDATE_TAG" \
    --prerelease \
    --notes "Isolated package candidate for PR #${PR_NUMBER}; not resolver-visible until post-merge activation."
  then
    # A lost create response is success only if the exact release is visible.
    :
  fi
  release_rc=0
  GITHUB_API_CONTEXT=init-merge-candidate \
    github_api_get_json "/repos/${REPOSITORY}/releases/tags/${CANDIDATE_TAG}" "$release_json" || release_rc=$?
fi
if [ "$release_rc" -ne 0 ]; then
  echo "init-merge-candidate: candidate release state is uncertain" >&2
  exit 1
fi
if ! jq -e --arg tag "$CANDIDATE_TAG" '
    .tag_name == $tag and (.id | type == "number" and . > 0) and
    (.created_at | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.assets | type == "array")
  ' "$release_json" >/dev/null
then
  echo "init-merge-candidate: candidate release response is malformed" >&2
  exit 1
fi
candidate_created_at=$(jq -r .created_at "$release_json")

base_index_sha=$(sha256_file "$CANONICAL_INDEX")
expected_json="$TMP_ROOT/candidate.json"
jq -n \
  --arg repository "$REPOSITORY" \
  --argjson pr_number "$PR_NUMBER" \
  --arg base_ref "$BASE_REF" \
  --arg base_sha "$BASE_SHA" \
  --arg head_sha "$HEAD_SHA" \
  --arg synthetic_merge_sha "$SYNTHETIC_MERGE_SHA" \
  --arg synthetic_tree_sha "$SYNTHETIC_TREE_SHA" \
  --arg merge_method "$MERGE_METHOD" \
  --argjson pr_commit_count "$PR_COMMIT_COUNT" \
  --argjson abi_version "$ABI" \
  --arg candidate_tag "$CANDIDATE_TAG" \
  --arg canonical_tag "$CANONICAL_TAG" \
  --arg canonical_base_state "$CANONICAL_STATE" \
  --arg base_index_sha256 "$base_index_sha" \
  --arg run_id "$RUN_ID" \
  --arg run_attempt "$RUN_ATTEMPT" \
  '{
    schema_version: 1,
    repository: $repository,
    pr_number: $pr_number,
    base_ref: $base_ref,
    base_sha: $base_sha,
    head_sha: $head_sha,
    synthetic_merge_sha: $synthetic_merge_sha,
    synthetic_tree_sha: $synthetic_tree_sha,
    merge_method: $merge_method,
    pr_commit_count: $pr_commit_count,
    abi_version: $abi_version,
    candidate_tag: $candidate_tag,
    canonical_tag: $canonical_tag,
    canonical_base_state: $canonical_base_state,
    base_index_sha256: $base_index_sha256,
    run_id: $run_id,
    run_attempt: $run_attempt
  }' > "$expected_json"

cp "$CANONICAL_INDEX" "$TMP_ROOT/base-index.toml"
candidate_index="$TMP_ROOT/index.toml"
canonical_index_url="${SERVER_URL}/${REPOSITORY}/releases/download/${CANONICAL_TAG}/index.toml"
host_target=$(rustc -vV | awk '/^host/ {print $2}')
cargo run --release -p xtask --target "$host_target" --quiet -- \
  index-candidate seed \
    --canonical-index "$TMP_ROOT/base-index.toml" \
    --candidate-index "$candidate_index" \
    --canonical-index-url "$canonical_index_url" \
    --expected-abi "$ABI" \
    --generated-at "$candidate_created_at" \
    --generator "prepare-merge candidate ${CANDIDATE_TAG}"

refresh_release() {
  GITHUB_API_CONTEXT=init-merge-candidate \
    github_api_get_json "/repos/${REPOSITORY}/releases/tags/${CANDIDATE_TAG}" "$release_json"
}

ensure_immutable_asset() {
  local name="$1" path="$2" expected_sha asset id upload_dir
  local downloaded="$TMP_ROOT/download-$name"
  expected_sha=$(sha256_file "$path")
  refresh_release
  asset=$(jq -c --arg name "$name" '[.assets[] | select(.name == $name)]' "$release_json")
  if [ "$(jq 'length' <<<"$asset")" -gt 1 ]; then
    echo "init-merge-candidate: duplicate immutable asset $name" >&2
    return 1
  fi
  if [ "$(jq 'length' <<<"$asset")" -eq 1 ]; then
    id=$(jq -r '.[0].id' <<<"$asset")
    gh_retry gh api -H 'Accept: application/octet-stream' \
      "/repos/${REPOSITORY}/releases/assets/${id}" > "$downloaded"
    if [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
      echo "init-merge-candidate: existing immutable asset $name has different bytes" >&2
      return 1
    fi
    echo "init-merge-candidate: reusing exact immutable asset $name"
    return 0
  fi

  upload_dir="$TMP_ROOT/upload-$name"
  mkdir -p "$upload_dir"
  cp "$path" "$upload_dir/$name"
  if ! gh release upload "$CANDIDATE_TAG" --repo "$REPOSITORY" "$upload_dir/$name"; then
    echo "init-merge-candidate: upload response for $name was ambiguous; reconciling" >&2
  fi
  refresh_release
  asset=$(jq -c --arg name "$name" '[.assets[] | select(.name == $name)]' "$release_json")
  if [ "$(jq 'length' <<<"$asset")" -ne 1 ]; then
    echo "init-merge-candidate: immutable asset $name is not uniquely visible after upload" >&2
    return 1
  fi
  id=$(jq -r '.[0].id' <<<"$asset")
  gh_retry gh api -H 'Accept: application/octet-stream' \
    "/repos/${REPOSITORY}/releases/assets/${id}" > "$downloaded"
  if [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
    echo "init-merge-candidate: uploaded immutable asset $name failed verification" >&2
    return 1
  fi
  if [ "${CANDIDATE_INIT_FAIL_AFTER_ASSET:-}" = "$name" ]; then
    echo "init-merge-candidate: injected interruption after $name" >&2
    exit 86
  fi
}

ensure_immutable_asset candidate.json "$expected_json"
ensure_immutable_asset base-index.toml "$TMP_ROOT/base-index.toml"
ensure_immutable_asset index.toml "$candidate_index"

echo "init-merge-candidate: initialized isolated candidate $CANDIDATE_TAG"
