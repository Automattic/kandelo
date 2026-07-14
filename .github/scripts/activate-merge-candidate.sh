#!/usr/bin/env bash
set -euo pipefail

CANDIDATE_TAG=""
PR_NUMBER=""
merge_commit_sha=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate-tag) CANDIDATE_TAG="$2"; shift 2 ;;
    --pr-number) PR_NUMBER="$2"; shift 2 ;;
    *) echo "activate-merge-candidate: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ -z "$CANDIDATE_TAG" ] || [ -z "$PR_NUMBER" ]; then
  echo "activate-merge-candidate: --candidate-tag and --pr-number are required" >&2
  exit 2
fi
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || [ "$PR_NUMBER" = "0" ]; then
  echo "activate-merge-candidate: --pr-number must be a positive integer" >&2
  exit 2
fi
if ! [[ "$CANDIDATE_TAG" =~ ^merge-candidate-abi-v[0-9]+-pr-${PR_NUMBER}-run-[0-9]+-attempt-[0-9]+$ ]]; then
  echo "activate-merge-candidate: candidate tag does not match PR #$PR_NUMBER: $CANDIDATE_TAG" >&2
  exit 2
fi
REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-.github/scripts/state-lock.sh}"
VERIFY_SCRIPT="${VERIFY_SCRIPT:-.github/scripts/verify-merge-candidate.sh}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATUS_SCRIPT="${STATUS_SCRIPT:-$SCRIPT_DIR/latest-merge-gate-status.sh}"
RELEASE_INDEX_STATE_SCRIPT="${RELEASE_INDEX_STATE_SCRIPT:-$REPO_ROOT/scripts/release-index-state.sh}"
# shellcheck source=.github/scripts/github-api-get.sh
source "$SCRIPT_DIR/github-api-get.sh"
TMP_ROOT="$(mktemp -d)"
AUTHORITY_LOCK_STATE="$TMP_ROOT/authority-lock.env"
CANDIDATE_LOCK_STATE="$TMP_ROOT/candidate-lock.env"
CANONICAL_LOCK_STATE="$TMP_ROOT/canonical-lock.env"
AUTHORITY_LOCKED=0
CANDIDATE_LOCKED=0
CANONICAL_LOCKED=0

cleanup() {
  if [ "$CANONICAL_LOCKED" = "1" ]; then
    STATE_LOCK_STATE_FILE="$CANONICAL_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
  fi
  if [ "$CANDIDATE_LOCKED" = "1" ]; then
    STATE_LOCK_STATE_FILE="$CANDIDATE_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
  fi
  if [ "$AUTHORITY_LOCKED" = "1" ]; then
    STATE_LOCK_STATE_FILE="$AUTHORITY_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_size() {
  wc -c < "$1" | tr -d '[:space:]'
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
    echo "activate-merge-candidate: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

release_asset_info() {
  local tag="$1"
  local name="$2"
  gh_retry gh api "/repos/${REPOSITORY}/releases/tags/${tag}" \
    | jq -r --arg name "$name" \
        '.assets[] | select(.name == $name) | [.id, .size, (.digest // "")] | @tsv'
}

download_asset() {
  local tag="$1"
  local name="$2"
  local dir="$3"
  local info asset_id tmp attempt delay downloaded
  mkdir -p "$dir"
  info=$(release_asset_info "$tag" "$name")
  if [ -z "$info" ]; then
    echo "activate-merge-candidate: release $tag has no asset $name" >&2
    return 1
  fi
  read -r asset_id _ _ <<< "$info"
  if [ -z "$asset_id" ]; then
    echo "activate-merge-candidate: release $tag returned no asset ID for $name" >&2
    return 1
  fi
  tmp="$dir/.${name}.tmp.$$"
  attempt=1
  delay=2
  downloaded=0
  while [ "$attempt" -le 4 ]; do
    rm -f "$tmp"
    if gh api \
         -H "Accept: application/octet-stream" \
         "/repos/${REPOSITORY}/releases/assets/${asset_id}" \
         > "$tmp"
    then
      downloaded=1
      break
    fi
    if [ "$attempt" -ge 4 ]; then
      break
    fi
    echo "activate-merge-candidate: asset download failed; retrying in ${delay}s: $tag/$name" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
  if [ "$downloaded" != "1" ]; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$dir/$name"
  if [ ! -f "$dir/$name" ]; then
    echo "activate-merge-candidate: release $tag did not yield asset $name" >&2
    return 1
  fi
}

release_asset_matches() {
  local tag="$1"
  local name="$2"
  local expected_size="$3"
  local expected_sha="$4"
  local info asset_id asset_size asset_digest verify_dir

  info=$(release_asset_info "$tag" "$name")
  [ -n "$info" ] || return 1
  read -r asset_id asset_size asset_digest <<< "$info"
  [ -n "$asset_id" ] && [ "$asset_size" = "$expected_size" ] || return 1
  if [[ "${asset_digest:-}" == sha256:* ]]; then
    [ "${asset_digest#sha256:}" = "$expected_sha" ]
    return
  fi

  verify_dir=$(mktemp -d "$TMP_ROOT/verify.XXXXXX")
  download_asset "$tag" "$name" "$verify_dir" || return 1
  [ "$(sha256_file "$verify_dir/$name")" = "$expected_sha" ]
}

ensure_release() {
  local tag="$1"
  local target_sha="$2"
  local base_state="$3"
  local release_json="$TMP_ROOT/release-${tag}.json" rc=0 sentinel
  GITHUB_API_CONTEXT=activate-merge-candidate \
    github_api_get_json "/repos/${REPOSITORY}/releases/tags/${tag}" "$release_json" || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi
  if [ "$rc" -ne 44 ]; then return 1; fi
  if [ "$base_state" != absent ]; then
    echo "activate-merge-candidate: canonical release $tag disappeared after candidate snapshot" >&2
    return 1
  fi
  sentinel=$(bash "$RELEASE_INDEX_STATE_SCRIPT" sentinel)
  gh_retry gh release create "$tag" \
    --repo "$REPOSITORY" \
    --target "$target_sha" \
    --title "$tag" \
    --notes "${sentinel}

Binaries for ABI v${tag#binaries-abi-v}"
}

copy_candidate_asset() {
  local name="$1"
  local expected_sha="$2"
  local download_dir="$TMP_ROOT/candidate-assets"
  local path size actual_sha info

  download_asset "$CANDIDATE_TAG" "$name" "$download_dir"
  path="$download_dir/$name"
  actual_sha=$(sha256_file "$path")
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "activate-merge-candidate: candidate asset $name sha256 $actual_sha does not match index $expected_sha" >&2
    publish_rejection candidate-asset-invalid
    exit 1
  fi
  size=$(file_size "$path")
  info=$(release_asset_info "$CANONICAL_TAG" "$name")
  if [ -n "$info" ]; then
    if release_asset_matches "$CANONICAL_TAG" "$name" "$size" "$expected_sha"; then
      echo "activate-merge-candidate: canonical asset $name already matches; reusing"
      return 0
    fi
    echo "activate-merge-candidate: canonical content-addressed asset $name exists with different bytes" >&2
    exit 1
  fi

  gh_retry gh release upload "$CANONICAL_TAG" --repo "$REPOSITORY" "$path"
  if ! release_asset_matches "$CANONICAL_TAG" "$name" "$size" "$expected_sha"; then
    echo "activate-merge-candidate: canonical asset $name failed post-upload verification" >&2
    exit 1
  fi
}

verify_canonical_asset() {
  local name="$1"
  local expected_sha="$2"
  local info size

  info=$(release_asset_info "$CANONICAL_TAG" "$name")
  if [ -z "$info" ]; then
    echo "activate-merge-candidate: canonical asset $name is missing" >&2
    return 1
  fi
  read -r _ size _ <<< "$info"
  if ! release_asset_matches "$CANONICAL_TAG" "$name" "$size" "$expected_sha"; then
    echo "activate-merge-candidate: canonical asset $name does not match expected sha256 $expected_sha" >&2
    return 1
  fi
  echo "activate-merge-candidate: verified retained canonical asset $name"
}

publish_rejection() {
  local reason="$1"
  local rejected_json="$TMP_ROOT/rejected.json"
  local existing_dir existing_core requested_core

  if ! [[ "$reason" =~ ^[a-z0-9-]+$ ]]; then
    echo "activate-merge-candidate: refusing malformed rejection reason $reason" >&2
    return 1
  fi
  jq -n \
    --arg repository "$REPOSITORY" \
    --argjson pr_number "$PR_NUMBER" \
    --arg candidate_tag "$CANDIDATE_TAG" \
    --arg rejection_reason "$reason" \
    --arg merge_commit_sha "$merge_commit_sha" \
    --arg rejected_at "$(date -u +%FT%TZ)" \
    --arg activation_run "${SERVER_URL}/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-local}" \
    '{
      disposition_schema_version: 1,
      disposition: "rejected",
      repository: $repository,
      pr_number: $pr_number,
      candidate_tag: $candidate_tag,
      rejection_reason: $rejection_reason,
      merge_commit_sha: (if $merge_commit_sha == "" then null else $merge_commit_sha end),
      rejected_at: $rejected_at,
      activation_run: $activation_run
    }' > "$rejected_json"

  if [ -n "$(release_asset_info "$CANDIDATE_TAG" rejected.json)" ]; then
    existing_dir="$TMP_ROOT/existing-rejected"
    download_asset "$CANDIDATE_TAG" rejected.json "$existing_dir"
    rejection_identity='{
      repository, pr_number, candidate_tag, disposition,
      disposition_schema_version, rejection_reason, merge_commit_sha
    }'
    existing_core=$(jq -S -c "$rejection_identity" "$existing_dir/rejected.json")
    requested_core=$(jq -S -c "$rejection_identity" "$rejected_json")
    if [ "$existing_core" != "$requested_core" ]; then
      echo "activate-merge-candidate: existing rejection marker conflicts with deterministic result" >&2
      return 1
    fi
  else
    gh_retry gh release upload "$CANDIDATE_TAG" --repo "$REPOSITORY" "$rejected_json"
  fi
  echo "activate-merge-candidate: recorded terminal rejection $reason for $CANDIDATE_TAG" >&2
}

export STATE_LOCK_OWNER_DETAIL="candidate authority, PR ${PR_NUMBER}"
STATE_LOCK_STATE_FILE="$AUTHORITY_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "merge-authority-pr-${PR_NUMBER}"
AUTHORITY_LOCKED=1
export STATE_LOCK_OWNER_DETAIL="candidate activation, PR ${PR_NUMBER}"
STATE_LOCK_STATE_FILE="$CANDIDATE_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$CANDIDATE_TAG"
CANDIDATE_LOCKED=1

candidate_dir="$TMP_ROOT/candidate"
mkdir -p "$candidate_dir"
for asset in candidate.json ready.json base-index.toml index.toml; do
  download_asset "$CANDIDATE_TAG" "$asset" "$candidate_dir"
done

candidate_json="$candidate_dir/candidate.json"
ready_json="$candidate_dir/ready.json"
base_index="$candidate_dir/base-index.toml"
candidate_index="$candidate_dir/index.toml"

if [ -n "$(release_asset_info "$CANDIDATE_TAG" rejected.json)" ]; then
  echo "activate-merge-candidate: candidate already has a terminal rejection receipt" >&2
  exit 1
fi

terminal_reason_file="$TMP_ROOT/terminal-reason"
if bash "$VERIFY_SCRIPT" \
    --candidate-json "$candidate_json" \
    --ready-json "$ready_json" \
    --base-index "$base_index" \
    --candidate-index "$candidate_index" \
    --repository "$REPOSITORY" \
    --candidate-tag "$CANDIDATE_TAG" \
    --terminal-reason-file "$terminal_reason_file" \
    --metadata-only
then
  :
else
  metadata_status=$?
  if [ -s "$terminal_reason_file" ]; then
    publish_rejection "$(cat "$terminal_reason_file")"
  fi
  exit "$metadata_status"
fi

pr_json="$TMP_ROOT/pr.json"
gh_retry gh pr view "$PR_NUMBER" \
  --repo "$REPOSITORY" \
  --json state,headRefOid,baseRefName,mergeCommit,mergedAt \
  > "$pr_json"
state=$(jq -r .state "$pr_json")
if [ "$state" != "MERGED" ]; then
  echo "activate-merge-candidate: PR #$PR_NUMBER is not merged (state: $state)" >&2
  exit 1
fi

base_ref=$(jq -r .base_ref "$candidate_json")
merge_commit_sha=$(jq -r .mergeCommit.oid "$pr_json")
git fetch --no-tags origin \
  "+refs/heads/${base_ref}:refs/remotes/origin/${base_ref}" \
  "+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/pr-${PR_NUMBER}-head"

if bash "$VERIFY_SCRIPT" \
    --candidate-json "$candidate_json" \
    --ready-json "$ready_json" \
    --base-index "$base_index" \
    --candidate-index "$candidate_index" \
    --pr-json "$pr_json" \
    --repository "$REPOSITORY" \
    --candidate-tag "$CANDIDATE_TAG" \
    --terminal-reason-file "$terminal_reason_file"
then
  :
else
  verify_status=$?
  if [ -s "$terminal_reason_file" ]; then
    publish_rejection "$(cat "$terminal_reason_file")"
  fi
  exit "$verify_status"
fi

CANONICAL_TAG=$(jq -r .canonical_tag "$candidate_json")
ABI=$(jq -r .abi_version "$candidate_json")
CANONICAL_BASE_STATE=$(jq -r .canonical_base_state "$candidate_json")
export STATE_LOCK_OWNER_DETAIL="canonical activation from ${CANDIDATE_TAG}"
STATE_LOCK_STATE_FILE="$CANONICAL_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$CANONICAL_TAG"
CANONICAL_LOCKED=1

expected_authority_url="${SERVER_URL%/}/${REPOSITORY}/releases/tag/${CANDIDATE_TAG}"
if ! authority_url=$(MERGE_GATE_STATUS_RETRY_DELAY_SECONDS=2 \
    bash "$STATUS_SCRIPT" --head-sha "$(jq -r .head_sha "$candidate_json")" \
      --max-pages 50 --per-page 100)
then
  echo "activate-merge-candidate: cannot prove current merge-gate authority" >&2
  exit 1
fi
if [ "$authority_url" != "$expected_authority_url" ]; then
  echo "activate-merge-candidate: candidate is no longer the latest merge-gate authority" >&2
  exit 1
fi

ensure_release "$CANONICAL_TAG" "$merge_commit_sha" "$CANONICAL_BASE_STATE"
current_dir="$TMP_ROOT/current"
mkdir -p "$current_dir"
current_index="$current_dir/index.toml"
current_head_file="$current_dir/head"
bash "$RELEASE_INDEX_STATE_SCRIPT" read \
  --target-tag "$CANONICAL_TAG" \
  --expected-abi "$ABI" \
  --output "$current_index" \
  --head-file "$current_head_file"
current_index_sha=$(sha256_file "$current_index")

candidate_index_url="${SERVER_URL}/${REPOSITORY}/releases/download/${CANDIDATE_TAG}/index.toml"
canonical_index_url="${SERVER_URL}/${REPOSITORY}/releases/download/${CANONICAL_TAG}/index.toml"
next_dir="$TMP_ROOT/next"
mkdir -p "$next_dir"
next_index="$next_dir/index.toml"
asset_plan="$next_dir/assets.json"
host_target=$(rustc -vV | awk '/^host/ {print $2}')
if cargo run --release -p xtask --target "$host_target" --quiet -- \
    index-candidate activate \
      --base-index "$base_index" \
      --candidate-index "$candidate_index" \
      --current-index "$current_index" \
      --candidate-index-url "$candidate_index_url" \
      --canonical-index-url "$canonical_index_url" \
      --expected-abi "$ABI" \
      --output-index "$next_index" \
      --asset-plan "$asset_plan" \
      --rejection-reason-file "$terminal_reason_file" \
      --activated-at "$(date -u +%FT%TZ)" \
      --generator "post-merge activation ${CANDIDATE_TAG} at ${merge_commit_sha}"
then
  :
else
  activation_status=$?
  if [ -s "$terminal_reason_file" ]; then
    publish_rejection "$(cat "$terminal_reason_file")"
  fi
  exit "$activation_status"
fi

while IFS= read -r asset; do
  name=$(jq -r .name <<<"$asset")
  expected_sha=$(jq -r .sha256 <<<"$asset")
  source=$(jq -r .source <<<"$asset")
  case "$source" in
    candidate) copy_candidate_asset "$name" "$expected_sha" ;;
    canonical) verify_canonical_asset "$name" "$expected_sha" ;;
    *)
      echo "activate-merge-candidate: asset plan for $name has invalid source $source" >&2
      publish_rejection candidate-index-invalid
      exit 1
      ;;
  esac
done < <(jq -c '.[]' "$asset_plan")

next_index_sha=$(sha256_file "$next_index")
if [ "$next_index_sha" = "$current_index_sha" ]; then
  echo "activate-merge-candidate: candidate entries are already canonical; index is unchanged"
else
  bash "$RELEASE_INDEX_STATE_SCRIPT" publish \
    --target-tag "$CANONICAL_TAG" \
    --expected-abi "$ABI" \
    --index-path "$next_index" \
    --expected-head "$(cat "$current_head_file")"
fi

activated_json="$TMP_ROOT/activated.json"
jq \
  --arg merge_commit_sha "$merge_commit_sha" \
  --arg canonical_index_sha256 "$next_index_sha" \
  --arg activated_at "$(date -u +%FT%TZ)" \
  --arg activation_run "${SERVER_URL}/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-local}" \
  '. + {
    merge_commit_sha: $merge_commit_sha,
    canonical_index_sha256: $canonical_index_sha256,
    activated_at: $activated_at,
    activation_run: $activation_run
  }' "$ready_json" > "$activated_json"

if [ -n "$(release_asset_info "$CANDIDATE_TAG" activated.json)" ]; then
  existing_dir="$TMP_ROOT/existing-activated"
  download_asset "$CANDIDATE_TAG" activated.json "$existing_dir"
  receipt_identity='{
    schema_version, repository, pr_number, base_ref, base_sha, head_sha,
    synthetic_merge_sha, synthetic_tree_sha, merge_method, pr_commit_count,
    abi_version, candidate_tag, canonical_tag, canonical_base_state,
    base_index_sha256, run_id,
    run_attempt, candidate_index_sha256, ready_at, merge_commit_sha
  }'
  existing_core=$(jq -S -c "$receipt_identity" "$existing_dir/activated.json")
  requested_core=$(jq -S -c "$receipt_identity" "$activated_json")
  if [ "$existing_core" != "$requested_core" ]; then
    echo "activate-merge-candidate: existing activation marker conflicts with canonical result" >&2
    exit 1
  fi
else
  gh_retry gh release upload "$CANDIDATE_TAG" --repo "$REPOSITORY" "$activated_json"
fi

echo "activate-merge-candidate: activated $CANDIDATE_TAG into $CANONICAL_TAG at $merge_commit_sha"
