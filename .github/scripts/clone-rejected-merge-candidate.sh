#!/usr/bin/env bash
set -euo pipefail

SOURCE_CANDIDATE_TAG=""
OUTPUT_FILE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-candidate-tag) SOURCE_CANDIDATE_TAG="$2"; shift 2 ;;
    --output-file) OUTPUT_FILE="$2"; shift 2 ;;
    *) echo "clone-rejected-merge-candidate: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$SOURCE_CANDIDATE_TAG" =~ ^merge-candidate-abi-v([0-9]+)-pr-([0-9]+)-run-([0-9]+)-attempt-([0-9]+)$ ]]; then
  echo "clone-rejected-merge-candidate: --source-candidate-tag must be an exact merge-candidate tag" >&2
  exit 2
fi
ABI="${BASH_REMATCH[1]}"
PR_NUMBER="${BASH_REMATCH[2]}"
SOURCE_RUN_ID="${BASH_REMATCH[3]}"
SOURCE_RUN_ATTEMPT="${BASH_REMATCH[4]}"
RECOVERY_RUN_ID="${GITHUB_RUN_ID:?GITHUB_RUN_ID required}"
RECOVERY_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT required}"
if ! [[ "$RECOVERY_RUN_ID" =~ ^[1-9][0-9]*$ && "$RECOVERY_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
  echo "clone-rejected-merge-candidate: recovery run identity must be positive integers" >&2
  exit 2
fi
REQUESTED_DESTINATION_CANDIDATE_TAG="merge-candidate-abi-v${ABI}-pr-${PR_NUMBER}-run-${RECOVERY_RUN_ID}-attempt-${RECOVERY_RUN_ATTEMPT}"
if [ "$REQUESTED_DESTINATION_CANDIDATE_TAG" = "$SOURCE_CANDIDATE_TAG" ]; then
  echo "clone-rejected-merge-candidate: recovery must use a new run-bound candidate tag" >&2
  exit 2
fi
if [ -n "$OUTPUT_FILE" ] && [ "$OUTPUT_FILE" = / ]; then
  echo "clone-rejected-merge-candidate: invalid --output-file" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
DEFAULT_BRANCH="${GITHUB_DEFAULT_BRANCH:?GITHUB_DEFAULT_BRANCH required}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT=$(cd "$REPO_ROOT" && pwd -P)
WORKTREE_ROOT=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
if [ "$WORKTREE_ROOT" != "$REPO_ROOT" ]; then
  echo "clone-rejected-merge-candidate: helper must run from its checked-out platform worktree" >&2
  exit 1
fi
CHECKED_OUT_SHA=$(git rev-parse HEAD)
platform_abi=$(sed -nE \
  's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs")
if ! [[ "$platform_abi" =~ ^[1-9][0-9]*$ ]]; then
  echo "clone-rejected-merge-candidate: checked-out platform ABI_VERSION is missing or ambiguous" >&2
  exit 1
fi
if [ "$platform_abi" != "$ABI" ]; then
  echo "clone-rejected-merge-candidate: source candidate ABI $ABI is not current platform ABI $platform_abi" >&2
  exit 1
fi
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-$SCRIPT_DIR/state-lock.sh}"
STATUS_SCRIPT="${STATUS_SCRIPT:-$SCRIPT_DIR/latest-merge-gate-status.sh}"
VERIFY_SCRIPT="${VERIFY_SCRIPT:-$SCRIPT_DIR/verify-merge-candidate.sh}"
MARK_READY_SCRIPT="${MARK_READY_SCRIPT:-$SCRIPT_DIR/mark-merge-candidate-ready.sh}"
VALIDATE_RELEASE_SCRIPT="${VALIDATE_RELEASE_SCRIPT:-$SCRIPT_DIR/validate-staging-release.sh}"
DOWNLOAD_ASSET_SCRIPT="${DOWNLOAD_ASSET_SCRIPT:-$SCRIPT_DIR/download-verified-release-asset.sh}"
TMP_ROOT="$(mktemp -d)"
AUTHORITY_LOCK_STATE="$TMP_ROOT/authority-lock.env"
SOURCE_LOCK_STATE="$TMP_ROOT/source-lock.env"
DESTINATION_LOCK_STATE="$TMP_ROOT/destination-lock.env"
AUTHORITY_LOCKED=0
SOURCE_LOCKED=0
DESTINATION_LOCKED=0
DESTINATION_CANDIDATE_TAG=""
DESTINATION_RUN_ID=""
DESTINATION_RUN_ATTEMPT=""
RESUME_EXISTING_CLONE=0
SYNTHETIC_REF="refs/kandelo-recovery/${RECOVERY_RUN_ID}-${RECOVERY_RUN_ATTEMPT}"

release_clone_locks() {
  if [ "$DESTINATION_LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$DESTINATION_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
    DESTINATION_LOCKED=0
  fi
  if [ "$SOURCE_LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$SOURCE_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
    SOURCE_LOCKED=0
  fi
  if [ "$AUTHORITY_LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$AUTHORITY_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
    AUTHORITY_LOCKED=0
  fi
}

cleanup() {
  release_clone_locks
  git update-ref -d "$SYNTHETIC_REF" >/dev/null 2>&1 || true
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
  local attempt=1 delay=2
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "clone-rejected-merge-candidate: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

snapshot_release() {
  local tag="$1" output="$2" release_json
  local release_id page page_json count reached_end=false
  release_json="$TMP_ROOT/release-${tag}.json"
  gh_retry gh api "/repos/${REPOSITORY}/releases/tags/${tag}" > "$release_json"
  if ! jq -e --arg tag "$tag" '
      .tag_name == $tag and (.id | type == "number" and . > 0)
    ' "$release_json" >/dev/null
  then
    echo "clone-rejected-merge-candidate: malformed release response for $tag" >&2
    return 1
  fi
  release_id=$(jq -r .id "$release_json")
  : > "$output.pages"
  for ((page = 1; page <= 50; page++)); do
    page_json="$TMP_ROOT/release-${release_id}-assets-${page}.json"
    gh_retry gh api "/repos/${REPOSITORY}/releases/${release_id}/assets?per_page=100&page=${page}" > "$page_json"
    if ! jq -e '
        type == "array" and all(.[];
          (.id | type == "number" and . > 0) and
          (.name | type == "string" and length > 0) and
          .state == "uploaded" and
          (.size | type == "number" and . > 0 and floor == .) and
          (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")))
      ' "$page_json" >/dev/null
    then
      echo "clone-rejected-merge-candidate: malformed asset page $page for $tag" >&2
      return 1
    fi
    jq -c '.[]' "$page_json" >> "$output.pages"
    count=$(jq 'length' "$page_json")
    if [ "$count" -lt 100 ]; then
      reached_end=true
      break
    fi
  done
  if [ "$reached_end" != true ]; then
    echo "clone-rejected-merge-candidate: asset scan for $tag reached its safety bound" >&2
    return 1
  fi
  if [ -s "$output.pages" ]; then
    jq -s 'sort_by(.name) | map({id, name, state, size, digest})' "$output.pages" > "$output"
  else
    printf '[]\n' > "$output"
  fi
  rm -f "$output.pages"
  if [ "$(jq '[group_by(.id)[] | select(length > 1)] | length' "$output")" != 0 ] ||
     [ "$(jq '[group_by(.name)[] | select(length > 1)] | length' "$output")" != 0 ]; then
    echo "clone-rejected-merge-candidate: duplicate asset identity for $tag" >&2
    return 1
  fi
}

download_snapshotted_asset() {
  local tag="$1" inventory="$2" name="$3" output="$4" info sha size
  info=$(jq -c --arg name "$name" '[.[] | select(.name == $name)]' "$inventory")
  if [ "$(jq 'length' <<<"$info")" != 1 ]; then
    echo "clone-rejected-merge-candidate: $tag must contain exactly one $name" >&2
    return 1
  fi
  sha=$(jq -r '.[0].digest | sub("^sha256:"; "")' <<<"$info")
  size=$(jq -r '.[0].size' <<<"$info")
  bash "$DOWNLOAD_ASSET_SCRIPT" \
    --tag "$tag" \
    --asset "$name" \
    --sha256 "$sha" \
    --size "$size" \
    --output "$output" >/dev/null
}

source_authority_url="${SERVER_URL%/}/${REPOSITORY}/releases/tag/${SOURCE_CANDIDATE_TAG}"

export STATE_LOCK_OWNER_DETAIL="candidate recovery authority, PR ${PR_NUMBER}"
STATE_LOCK_STATE_FILE="$AUTHORITY_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "merge-authority-pr-${PR_NUMBER}"
AUTHORITY_LOCKED=1
export STATE_LOCK_OWNER_DETAIL="candidate recovery source, PR ${PR_NUMBER}"
STATE_LOCK_STATE_FILE="$SOURCE_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$SOURCE_CANDIDATE_TAG"
SOURCE_LOCKED=1

source_inventory="$TMP_ROOT/source-assets.json"
snapshot_release "$SOURCE_CANDIDATE_TAG" "$source_inventory"
for required in candidate.json ready.json rejected.json base-index.toml index.toml; do
  if [ "$(jq --arg name "$required" '[.[] | select(.name == $name)] | length' "$source_inventory")" != 1 ]; then
    echo "clone-rejected-merge-candidate: source candidate lacks unique $required" >&2
    exit 1
  fi
done
if jq -e '.[] | select(.name == "activated.json")' "$source_inventory" >/dev/null; then
  echo "clone-rejected-merge-candidate: an activated candidate cannot be recovered" >&2
  exit 1
fi

source_dir="$TMP_ROOT/source"
mkdir -p "$source_dir"
for control in candidate.json ready.json rejected.json base-index.toml index.toml; do
  download_snapshotted_asset "$SOURCE_CANDIDATE_TAG" "$source_inventory" "$control" "$source_dir/$control"
done
source_candidate_json="$source_dir/candidate.json"
source_ready_json="$source_dir/ready.json"
source_rejected_json="$source_dir/rejected.json"
source_base_index="$source_dir/base-index.toml"
source_index="$source_dir/index.toml"

terminal_reason="$TMP_ROOT/source-terminal-reason"
bash "$VERIFY_SCRIPT" \
  --candidate-json "$source_candidate_json" \
  --ready-json "$source_ready_json" \
  --candidate-index "$source_index" \
  --base-index "$source_base_index" \
  --repository "$REPOSITORY" \
  --candidate-tag "$SOURCE_CANDIDATE_TAG" \
  --terminal-reason-file "$terminal_reason" \
  --metadata-only >/dev/null

if ! jq -e \
    --arg repository "$REPOSITORY" \
    --arg candidate_tag "$SOURCE_CANDIDATE_TAG" \
    --argjson pr_number "$PR_NUMBER" '
      .disposition_schema_version == 1 and
      .disposition == "rejected" and
      .repository == $repository and
      .pr_number == $pr_number and
      .candidate_tag == $candidate_tag and
      .rejection_reason == "prepared-commit-count-mismatch" and
      (.merge_commit_sha | test("^[0-9a-f]{40}$"))
    ' "$source_rejected_json" >/dev/null
then
  echo "clone-rejected-merge-candidate: source must have the exact prepared-commit-count-mismatch rejection" >&2
  exit 1
fi

source_run_json="$TMP_ROOT/source-run.json"
gh_retry gh api "/repos/${REPOSITORY}/actions/runs/${SOURCE_RUN_ID}" > "$source_run_json"
if ! jq -e \
    --arg repository "$REPOSITORY" \
    --arg head_sha "$(jq -r .head_sha "$source_candidate_json")" \
    --argjson run_id "$SOURCE_RUN_ID" \
    --argjson run_attempt "$SOURCE_RUN_ATTEMPT" '
      .id == $run_id and
      .run_attempt == $run_attempt and
      .status == "completed" and
      .conclusion == "success" and
      .event == "pull_request" and
      .head_sha == $head_sha and
      .path == ".github/workflows/prepare-merge.yml" and
      .repository.full_name == $repository
    ' "$source_run_json" >/dev/null
then
  echo "clone-rejected-merge-candidate: source Prepare merge run is not exact successful evidence" >&2
  exit 1
fi

pr_json="$TMP_ROOT/pr.json"
gh_retry gh pr view "$PR_NUMBER" \
  --repo "$REPOSITORY" \
  --json state,headRefOid,baseRefName,mergeCommit,mergedAt > "$pr_json"
if ! jq -e '
    .state == "MERGED" and
    (.headRefOid | test("^[0-9a-f]{40}$")) and
    (.baseRefName | type == "string" and length > 0) and
    (.mergeCommit.oid | test("^[0-9a-f]{40}$"))
  ' "$pr_json" >/dev/null
then
  echo "clone-rejected-merge-candidate: GitHub has not confirmed an exact merged PR" >&2
  exit 1
fi

base_ref=$(jq -r .base_ref "$source_candidate_json")
base_sha=$(jq -r .base_sha "$source_candidate_json")
head_sha=$(jq -r .head_sha "$source_candidate_json")
synthetic_merge_sha=$(jq -r .synthetic_merge_sha "$source_candidate_json")
synthetic_tree_sha=$(jq -r .synthetic_tree_sha "$source_candidate_json")
merge_method=$(jq -r .merge_method "$source_candidate_json")
recorded_commit_count=$(jq -r .pr_commit_count "$source_candidate_json")
merge_commit_sha=$(jq -r .mergeCommit.oid "$pr_json")
if [ "$base_ref" != "$DEFAULT_BRANCH" ] || [ "$(jq -r .baseRefName "$pr_json")" != "$base_ref" ]; then
  echo "clone-rejected-merge-candidate: source PR does not target the current default branch" >&2
  exit 1
fi
if [ "$(jq -r .headRefOid "$pr_json")" != "$head_sha" ]; then
  echo "clone-rejected-merge-candidate: merged PR head differs from the source candidate" >&2
  exit 1
fi
if [ "$(jq -r .merge_commit_sha "$source_rejected_json")" != "$merge_commit_sha" ]; then
  echo "clone-rejected-merge-candidate: rejection receipt names a different merge commit" >&2
  exit 1
fi
if [ "$merge_method" != rebase ]; then
  echo "clone-rejected-merge-candidate: commit-count recovery is restricted to rebase candidates" >&2
  exit 1
fi

git fetch --no-tags origin \
  "+refs/heads/${base_ref}:refs/remotes/origin/${base_ref}" \
  "+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/pr-${PR_NUMBER}-head"
for object in "$base_sha^{commit}" "$head_sha^{commit}" "$merge_commit_sha^{commit}"; do
  if ! git cat-file -e "$object" 2>/dev/null; then
    echo "clone-rejected-merge-candidate: required git object is unavailable: $object" >&2
    exit 1
  fi
done
if [ "$(git rev-parse "refs/remotes/origin/pr-${PR_NUMBER}-head")" != "$head_sha" ]; then
  echo "clone-rejected-merge-candidate: fetched PR head differs from candidate metadata" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$merge_commit_sha" "refs/remotes/origin/${base_ref}"; then
  echo "clone-rejected-merge-candidate: merged commit is not on the current default branch" >&2
  exit 1
fi
if [ "$(git rev-parse "refs/remotes/origin/${base_ref}")" != "$CHECKED_OUT_SHA" ]; then
  echo "clone-rejected-merge-candidate: checked-out platform revision is not the current default-branch tip" >&2
  exit 1
fi

bundle_dir="$TMP_ROOT/source-bundle"
mkdir -p "$bundle_dir"
gh_retry gh run download "$SOURCE_RUN_ID" \
  --repo "$REPOSITORY" \
  --name synthetic-pr-merge \
  --dir "$bundle_dir"
bundle_list="$TMP_ROOT/source-bundles.list"
if ! find "$bundle_dir" -type f -name synthesized-merge.bundle -print > "$bundle_list"; then
  echo "clone-rejected-merge-candidate: source bundle discovery failed" >&2
  exit 1
fi
mapfile -t bundles < "$bundle_list"
if [ "${#bundles[@]}" -ne 1 ]; then
  echo "clone-rejected-merge-candidate: source run must expose one synthetic merge bundle" >&2
  exit 1
fi
git bundle verify "${bundles[0]}" >/dev/null
git fetch --quiet "${bundles[0]}" "refs/heads/synthesized-merge:${SYNTHETIC_REF}"
if [ "$(git rev-parse "$SYNTHETIC_REF")" != "$synthetic_merge_sha" ]; then
  echo "clone-rejected-merge-candidate: source bundle synthetic commit differs from candidate metadata" >&2
  exit 1
fi
if [ "$(git show -s --format=%P "$SYNTHETIC_REF")" != "$base_sha $head_sha" ]; then
  echo "clone-rejected-merge-candidate: source synthetic merge has different parents" >&2
  exit 1
fi
if [ "$(git rev-parse "$SYNTHETIC_REF^{tree}")" != "$synthetic_tree_sha" ] ||
   [ "$(git rev-parse "$merge_commit_sha^{tree}")" != "$synthetic_tree_sha" ]; then
  echo "clone-rejected-merge-candidate: tested and merged trees are not identical" >&2
  exit 1
fi

corrected_commit_count=$(git rev-list --count "$base_sha..$head_sha")
if ! [[ "$corrected_commit_count" =~ ^[1-9][0-9]*$ ]] || [ "$corrected_commit_count" = "$recorded_commit_count" ]; then
  echo "clone-rejected-merge-candidate: source metadata does not contain the isolated shallow-count defect" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$base_sha" "$merge_commit_sha"; then
  echo "clone-rejected-merge-candidate: prepared base is not an ancestor of the rebase result" >&2
  exit 1
fi
if [ -n "$(git rev-list --min-parents=2 "$base_sha..$merge_commit_sha")" ]; then
  echo "clone-rejected-merge-candidate: rebase result contains a merge commit" >&2
  exit 1
fi
merged_commit_count=$(git rev-list --count --first-parent "$base_sha..$merge_commit_sha")
if [ "$merged_commit_count" != "$corrected_commit_count" ]; then
  echo "clone-rejected-merge-candidate: merged rebase count $merged_commit_count differs from corrected source count $corrected_commit_count" >&2
  exit 1
fi

if [ -z "${XTASK:-}" ]; then
  host_target=$(rustc -vV | awk '/^host/ {print $2}')
  cargo build --release -p xtask --target "$host_target"
  XTASK="$REPO_ROOT/target/$host_target/release/xtask"
fi
if [ ! -x "$XTASK" ]; then
  echo "clone-rejected-merge-candidate: XTASK is not executable: $XTASK" >&2
  exit 2
fi
expected_ledger="$TMP_ROOT/expected-ledger.json"
"$XTASK" staging-reuse expected \
  --registry "$REPO_ROOT/packages/registry" \
  --expected-abi "$ABI" \
  --exclude cpython,erlang,erlang-vfs,perl,perl-vfs,python-vfs,redis,texlive \
  --output "$expected_ledger"
validated_source="$TMP_ROOT/validated-source"
bash "$VALIDATE_RELEASE_SCRIPT" \
  --tag "$SOURCE_CANDIDATE_TAG" \
  --expected-ledger "$expected_ledger" \
  --mode current \
  --materialize \
  --output-dir "$validated_source" \
  --xtask "$XTASK" >/dev/null
cmp "$source_index" "$validated_source/source-index.toml"

expected_asset_count=$(jq '.entries | length' "$expected_ledger")
validated_asset_count=$(jq '.entries | length' "$validated_source/snapshot.json")
if ! [[ "$expected_asset_count" =~ ^[1-9][0-9]*$ ]] || [ "$validated_asset_count" != "$expected_asset_count" ]; then
  echo "clone-rejected-merge-candidate: validated ledger asset count is incomplete" >&2
  exit 1
fi
jq -r '.entries[].asset' "$validated_source/snapshot.json" | sort -u > "$TMP_ROOT/ledger-assets"
if [ "$(wc -l < "$TMP_ROOT/ledger-assets" | tr -d '[:space:]')" != "$expected_asset_count" ]; then
  echo "clone-rejected-merge-candidate: ledger contains duplicate archive asset names" >&2
  exit 1
fi
jq -r '.[] | select(.name | endswith(".tar.zst")) | .name' "$source_inventory" | sort > "$TMP_ROOT/source-archives"
if ! cmp "$TMP_ROOT/ledger-assets" "$TMP_ROOT/source-archives"; then
  echo "clone-rejected-merge-candidate: source release archives are not the exact complete ledger" >&2
  exit 1
fi

source_inventory_after="$TMP_ROOT/source-assets-after.json"
snapshot_release "$SOURCE_CANDIDATE_TAG" "$source_inventory_after"
if ! cmp "$source_inventory" "$source_inventory_after"; then
  echo "clone-rejected-merge-candidate: source asset inventory changed during validation" >&2
  exit 1
fi

# The current-key proof above is derived from this checkout. Refetch immediately
# before authority selection so a newer default-branch package transaction
# cannot be bypassed by a stale recovery run.
git fetch --no-tags origin \
  "+refs/heads/${base_ref}:refs/remotes/origin/${base_ref}"
if [ "$(git rev-parse "refs/remotes/origin/${base_ref}")" != "$CHECKED_OUT_SHA" ]; then
  echo "clone-rejected-merge-candidate: default branch advanced during recovery validation" >&2
  exit 1
fi

# Select the destination only after the source and current ledger have been
# revalidated. A workflow retry may find the prior recovery clone authoritative
# after mark-ready succeeded but before activation ran.
current_authority_url=$(MERGE_GATE_STATUS_RETRY_DELAY_SECONDS=2 \
  bash "$STATUS_SCRIPT" --head-sha "$head_sha" --max-pages 50 --per-page 100)
if [ "$current_authority_url" = "$source_authority_url" ]; then
  DESTINATION_CANDIDATE_TAG="$REQUESTED_DESTINATION_CANDIDATE_TAG"
elif [[ "$current_authority_url" == "${SERVER_URL%/}/${REPOSITORY}/releases/tag/"* ]]; then
  DESTINATION_CANDIDATE_TAG="${current_authority_url#"${SERVER_URL%/}/${REPOSITORY}/releases/tag/"}"
  if ! [[ "$DESTINATION_CANDIDATE_TAG" =~ ^merge-candidate-abi-v${ABI}-pr-${PR_NUMBER}-run-([1-9][0-9]*)-attempt-([1-9][0-9]*)$ ]] ||
     [ "$DESTINATION_CANDIDATE_TAG" = "$SOURCE_CANDIDATE_TAG" ]; then
    echo "clone-rejected-merge-candidate: current merge-gate authority is not this source or its recovery clone" >&2
    exit 1
  fi
  RESUME_EXISTING_CLONE=1
else
  echo "clone-rejected-merge-candidate: current merge-gate authority is not this source or its recovery clone" >&2
  exit 1
fi

if ! [[ "$DESTINATION_CANDIDATE_TAG" =~ ^merge-candidate-abi-v${ABI}-pr-${PR_NUMBER}-run-([1-9][0-9]*)-attempt-([1-9][0-9]*)$ ]]; then
  echo "clone-rejected-merge-candidate: selected recovery candidate tag is malformed" >&2
  exit 1
fi
DESTINATION_RUN_ID="${BASH_REMATCH[1]}"
DESTINATION_RUN_ATTEMPT="${BASH_REMATCH[2]}"
export STATE_LOCK_OWNER_DETAIL="candidate recovery destination, PR ${PR_NUMBER}"
STATE_LOCK_STATE_FILE="$DESTINATION_LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$DESTINATION_CANDIDATE_TAG"
DESTINATION_LOCKED=1

destination_release="$TMP_ROOT/destination-release.json"
if [ "$RESUME_EXISTING_CLONE" = 0 ] &&
   ! gh api "/repos/${REPOSITORY}/releases/tags/${DESTINATION_CANDIDATE_TAG}" > "$destination_release" 2>/dev/null; then
  if ! gh_retry gh release create "$DESTINATION_CANDIDATE_TAG" \
      --repo "$REPOSITORY" \
      --target "$head_sha" \
      --title "$DESTINATION_CANDIDATE_TAG" \
      --prerelease \
      --notes "Immutable recovery clone of ${SOURCE_CANDIDATE_TAG}; source rejection retained."
  then
    : # A lost response is reconciled below.
  fi
fi
destination_inventory="$TMP_ROOT/destination-assets.json"
snapshot_release "$DESTINATION_CANDIDATE_TAG" "$destination_inventory"
if [ "$RESUME_EXISTING_CLONE" = 1 ]; then
  cp "$destination_inventory" "$TMP_ROOT/destination-resume-inventory.json"
fi

destination_candidate_json="$TMP_ROOT/candidate.json"
jq \
  --arg destination_tag "$DESTINATION_CANDIDATE_TAG" \
  --arg run_id "$DESTINATION_RUN_ID" \
  --arg run_attempt "$DESTINATION_RUN_ATTEMPT" \
  --arg source_tag "$SOURCE_CANDIDATE_TAG" \
  --arg source_index_sha256 "$(sha256_file "$source_index")" \
  --argjson corrected_commit_count "$corrected_commit_count" '
    .candidate_tag = $destination_tag |
    .run_id = $run_id |
    .run_attempt = $run_attempt |
    .pr_commit_count = $corrected_commit_count |
    .recovery = {
      kind: "immutable-clone-v1",
      source_candidate_tag: $source_tag,
      source_candidate_index_sha256: $source_index_sha256
    }
  ' "$source_candidate_json" > "$destination_candidate_json"

expected_names="$TMP_ROOT/expected-destination-assets"
{
  printf '%s\n' candidate.json base-index.toml index.toml
  cat "$TMP_ROOT/ledger-assets"
  printf '%s\n' ready.json
} | sort -u > "$expected_names"
{
  cat "$expected_names"
  printf '%s\n' activated.json
} | sort -u > "$TMP_ROOT/allowed-destination-assets"
jq -r '.[].name' "$destination_inventory" | sort > "$TMP_ROOT/destination-existing-names"
while IFS= read -r name; do
  if ! grep -Fxq "$name" "$TMP_ROOT/allowed-destination-assets"; then
    echo "clone-rejected-merge-candidate: destination contains unexpected asset $name" >&2
    exit 1
  fi
done < "$TMP_ROOT/destination-existing-names"

ensure_destination_asset() {
  local name="$1" path="$2" inventory="$TMP_ROOT/destination-refresh.json"
  local expected_sha expected_size existing actual_sha actual_size upload_dir
  expected_sha=$(sha256_file "$path")
  expected_size=$(file_size "$path")
  snapshot_release "$DESTINATION_CANDIDATE_TAG" "$inventory"
  existing=$(jq -c --arg name "$name" '[.[] | select(.name == $name)]' "$inventory")
  if [ "$(jq 'length' <<<"$existing")" = 1 ]; then
    if [ "$(jq -r '.[0].size' <<<"$existing")" != "$expected_size" ] ||
       [ "$(jq -r '.[0].digest | sub("^sha256:"; "")' <<<"$existing")" != "$expected_sha" ]; then
      echo "clone-rejected-merge-candidate: destination immutable asset $name has different metadata" >&2
      return 1
    fi
  elif [ "$(jq 'length' <<<"$existing")" = 0 ] && [ "$RESUME_EXISTING_CLONE" = 1 ]; then
    echo "clone-rejected-merge-candidate: authoritative recovery clone is missing immutable asset $name" >&2
    return 1
  elif [ "$(jq 'length' <<<"$existing")" = 0 ]; then
    upload_dir="$TMP_ROOT/upload-$name"
    mkdir -p "$upload_dir"
    cp "$path" "$upload_dir/$name"
    if ! gh release upload "$DESTINATION_CANDIDATE_TAG" --repo "$REPOSITORY" "$upload_dir/$name"; then
      echo "clone-rejected-merge-candidate: upload response for $name was ambiguous; reconciling" >&2
    fi
  else
    echo "clone-rejected-merge-candidate: destination contains duplicate $name" >&2
    return 1
  fi
  snapshot_release "$DESTINATION_CANDIDATE_TAG" "$inventory"
  existing=$(jq -c --arg name "$name" '[.[] | select(.name == $name)]' "$inventory")
  if [ "$(jq 'length' <<<"$existing")" != 1 ]; then
    echo "clone-rejected-merge-candidate: destination asset $name is not uniquely visible" >&2
    return 1
  fi
  actual_size=$(jq -r '.[0].size' <<<"$existing")
  actual_sha=$(jq -r '.[0].digest | sub("^sha256:"; "")' <<<"$existing")
  if [ "$actual_size" != "$expected_size" ] || [ "$actual_sha" != "$expected_sha" ]; then
    echo "clone-rejected-merge-candidate: destination asset $name failed metadata verification" >&2
    return 1
  fi
  download_snapshotted_asset "$DESTINATION_CANDIDATE_TAG" "$inventory" "$name" "$TMP_ROOT/verify-$name"
  cmp "$path" "$TMP_ROOT/verify-$name"
}

ensure_destination_asset candidate.json "$destination_candidate_json"
ensure_destination_asset base-index.toml "$source_base_index"
ensure_destination_asset index.toml "$source_index"
while IFS= read -r name; do
  ensure_destination_asset "$name" "$validated_source/archives/$name"
done < "$TMP_ROOT/ledger-assets"

snapshot_release "$DESTINATION_CANDIDATE_TAG" "$destination_inventory"
jq -r '.[].name' "$destination_inventory" | sort > "$TMP_ROOT/destination-final-names"
grep -Fxv ready.json "$expected_names" > "$TMP_ROOT/expected-before-ready"
if [ "$RESUME_EXISTING_CLONE" = 1 ]; then
  if ! cmp "$expected_names" "$TMP_ROOT/destination-final-names" &&
     ! cmp "$TMP_ROOT/allowed-destination-assets" "$TMP_ROOT/destination-final-names"; then
    echo "clone-rejected-merge-candidate: authoritative recovery clone is not complete and exact" >&2
    exit 1
  fi
elif ! cmp "$TMP_ROOT/expected-before-ready" "$TMP_ROOT/destination-final-names" &&
     ! cmp "$expected_names" "$TMP_ROOT/destination-final-names"; then
  echo "clone-rejected-merge-candidate: destination is not an exact immutable clone" >&2
  exit 1
fi

write_outputs() {
  local candidate_index_sha="$1"
  if [ -n "$OUTPUT_FILE" ]; then
    mkdir -p "$(dirname "$OUTPUT_FILE")"
    {
      printf 'candidate_tag=%s\n' "$DESTINATION_CANDIDATE_TAG"
      printf 'pr_number=%s\n' "$PR_NUMBER"
      printf 'ledger_asset_count=%s\n' "$expected_asset_count"
      printf 'candidate_index_sha256=%s\n' "$candidate_index_sha"
      printf 'validated_default_ref=%s\n' "$DEFAULT_BRANCH"
      printf 'validated_default_sha=%s\n' "$CHECKED_OUT_SHA"
    } >> "$OUTPUT_FILE"
  fi
}

candidate_index_sha=$(sha256_file "$source_index")
if [ "$RESUME_EXISTING_CLONE" = 1 ]; then
  destination_ready_json="$TMP_ROOT/destination-ready.json"
  download_snapshotted_asset \
    "$DESTINATION_CANDIDATE_TAG" "$destination_inventory" ready.json "$destination_ready_json"
  if ! cmp "$destination_candidate_json" "$TMP_ROOT/verify-candidate.json"; then
    echo "clone-rejected-merge-candidate: authoritative recovery metadata is not the exact source-derived clone" >&2
    exit 1
  fi
  bash "$VERIFY_SCRIPT" \
    --candidate-json "$TMP_ROOT/verify-candidate.json" \
    --ready-json "$destination_ready_json" \
    --candidate-index "$TMP_ROOT/verify-index.toml" \
    --base-index "$TMP_ROOT/verify-base-index.toml" \
    --pr-json "$pr_json" \
    --repository "$REPOSITORY" \
    --candidate-tag "$DESTINATION_CANDIDATE_TAG" \
    --terminal-reason-file "$TMP_ROOT/destination-terminal-reason" >/dev/null
  jq -S 'del(.candidate_index_sha256, .ready_at)' "$destination_ready_json" \
    > "$TMP_ROOT/ready-identity.json"
  jq -S . "$destination_candidate_json" > "$TMP_ROOT/candidate-identity.json"
  if ! cmp "$TMP_ROOT/candidate-identity.json" "$TMP_ROOT/ready-identity.json"; then
    echo "clone-rejected-merge-candidate: authoritative recovery ready marker is not source-derived" >&2
    exit 1
  fi

  if grep -Fxq activated.json "$TMP_ROOT/destination-final-names"; then
    destination_activated_json="$TMP_ROOT/destination-activated.json"
    download_snapshotted_asset \
      "$DESTINATION_CANDIDATE_TAG" "$destination_inventory" activated.json "$destination_activated_json"
    if ! jq -e \
        --arg merge_commit_sha "$merge_commit_sha" '
          .merge_commit_sha == $merge_commit_sha and
          (.canonical_index_sha256 | test("^[0-9a-f]{64}$")) and
          (.activated_at | type == "string" and length > 0) and
          (.activation_run | type == "string" and length > 0)
        ' "$destination_activated_json" >/dev/null
    then
      echo "clone-rejected-merge-candidate: authoritative recovery activation receipt is malformed" >&2
      exit 1
    fi
    jq -S 'del(.merge_commit_sha, .canonical_index_sha256, .activated_at, .activation_run)' \
      "$destination_activated_json" > "$TMP_ROOT/activated-identity.json"
    jq -S . "$destination_ready_json" > "$TMP_ROOT/ready-full-identity.json"
    if ! cmp "$TMP_ROOT/ready-full-identity.json" "$TMP_ROOT/activated-identity.json"; then
      echo "clone-rejected-merge-candidate: authoritative recovery activation receipt has a different identity" >&2
      exit 1
    fi
  fi

  snapshot_release "$DESTINATION_CANDIDATE_TAG" "$TMP_ROOT/destination-resume-after.json"
  if ! cmp "$TMP_ROOT/destination-resume-inventory.json" "$TMP_ROOT/destination-resume-after.json"; then
    echo "clone-rejected-merge-candidate: authoritative recovery clone changed during validation" >&2
    exit 1
  fi
  release_clone_locks
  write_outputs "$candidate_index_sha"
  echo "clone-rejected-merge-candidate: reused exact authoritative recovery clone $DESTINATION_CANDIDATE_TAG"
  exit 0
fi

# Avoid nested lock acquisition. mark-ready reacquires authority then the
# destination lock and performs the source-to-clone authority CAS itself.
release_clone_locks
bash "$MARK_READY_SCRIPT" \
  --candidate-tag "$DESTINATION_CANDIDATE_TAG" \
  --base-sha "$base_sha" \
  --head-sha "$head_sha" \
  --synthetic-tree-sha "$synthetic_tree_sha" \
  --run-id "$RECOVERY_RUN_ID" \
  --run-attempt "$RECOVERY_RUN_ATTEMPT" \
  --candidate-index-sha256 "$candidate_index_sha" \
  --expected-current-authority-url "$source_authority_url" \
  --expected-default-ref "$DEFAULT_BRANCH" \
  --expected-default-sha "$CHECKED_OUT_SHA"

write_outputs "$candidate_index_sha"
echo "clone-rejected-merge-candidate: cloned $expected_asset_count verified ledger assets into $DESTINATION_CANDIDATE_TAG"
