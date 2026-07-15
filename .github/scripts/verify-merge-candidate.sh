#!/usr/bin/env bash
set -euo pipefail

CANDIDATE_JSON=""
READY_JSON=""
CANDIDATE_INDEX=""
BASE_INDEX=""
PR_JSON=""
EXPECTED_REPOSITORY=""
EXPECTED_CANDIDATE_TAG=""
TERMINAL_REASON_FILE=""
METADATA_ONLY=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate-json) CANDIDATE_JSON="$2"; shift 2 ;;
    --ready-json) READY_JSON="$2"; shift 2 ;;
    --candidate-index) CANDIDATE_INDEX="$2"; shift 2 ;;
    --base-index) BASE_INDEX="$2"; shift 2 ;;
    --pr-json) PR_JSON="$2"; shift 2 ;;
    --repository) EXPECTED_REPOSITORY="$2"; shift 2 ;;
    --candidate-tag) EXPECTED_CANDIDATE_TAG="$2"; shift 2 ;;
    --terminal-reason-file) TERMINAL_REASON_FILE="$2"; shift 2 ;;
    --metadata-only) METADATA_ONLY=true; shift ;;
    *) echo "verify-merge-candidate: unknown flag $1" >&2; exit 2 ;;
  esac
done

require_value() {
  local flag="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "verify-merge-candidate: $flag is required" >&2
    exit 2
  fi
}

require_file() {
  local flag="$1"
  local path="$2"
  require_value "$flag" "$path"
  if [ ! -f "$path" ]; then
    echo "verify-merge-candidate: $flag is not a file: $path" >&2
    exit 2
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

terminal_fail() {
  local reason="$1"
  shift
  echo "verify-merge-candidate: $*" >&2
  if [ -n "$TERMINAL_REASON_FILE" ]; then
    printf '%s\n' "$reason" > "$TERMINAL_REASON_FILE"
  fi
  exit 1
}

require_file --candidate-json "$CANDIDATE_JSON"
require_file --ready-json "$READY_JSON"
require_file --candidate-index "$CANDIDATE_INDEX"
require_file --base-index "$BASE_INDEX"
if [ "$METADATA_ONLY" != true ]; then
  require_file --pr-json "$PR_JSON"
fi
require_value --repository "$EXPECTED_REPOSITORY"
require_value --candidate-tag "$EXPECTED_CANDIDATE_TAG"
if [ -n "$TERMINAL_REASON_FILE" ]; then
  rm -f "$TERMINAL_REASON_FILE"
fi

if ! jq -e '
    .schema_version == 1 and
    (.repository | type == "string" and length > 0) and
    (.pr_number | type == "number" and . > 0 and floor == .) and
    (.base_ref | type == "string" and length > 0) and
    (.base_sha | test("^[0-9a-f]{40}$")) and
    (.head_sha | test("^[0-9a-f]{40}$")) and
    (.synthetic_merge_sha | test("^[0-9a-f]{40}$")) and
    (.synthetic_tree_sha | test("^[0-9a-f]{40}$")) and
    (.merge_method == "squash" or .merge_method == "rebase") and
    (.pr_commit_count | type == "number" and . > 0 and floor == .) and
    (.abi_version | type == "number" and . > 0 and floor == .) and
    (.candidate_tag | type == "string" and length > 0) and
    (.canonical_tag | test("^binaries-abi-v[0-9]+$")) and
    (.canonical_base_state == "present" or .canonical_base_state == "absent") and
    (.base_index_sha256 | test("^[0-9a-f]{64}$")) and
    (.run_id | type == "string" and test("^[0-9]+$")) and
    (.run_attempt | type == "string" and test("^[0-9]+$")) and
    (.recovery == null or (
      (.recovery | type == "object") and
      .recovery.kind == "immutable-clone-v1" and
      (.recovery.source_candidate_tag | type == "string" and
        test("^merge-candidate-abi-v[0-9]+-pr-[0-9]+-run-[0-9]+-attempt-[0-9]+$")) and
      (.recovery.source_candidate_index_sha256 | test("^[0-9a-f]{64}$"))
    ))
  ' "$CANDIDATE_JSON" >/dev/null
then
  terminal_fail candidate-metadata-invalid \
    "candidate.json does not satisfy schema version 1"
fi

if ! jq -e '
    .schema_version == 1 and
    (.candidate_index_sha256 | test("^[0-9a-f]{64}$")) and
    (.ready_at | type == "string" and length > 0)
  ' "$READY_JSON" >/dev/null
then
  terminal_fail ready-metadata-invalid \
    "ready.json does not satisfy schema version 1"
fi

candidate_identity=$(jq -S -c . "$CANDIDATE_JSON")
ready_identity=$(jq -S -c 'del(.candidate_index_sha256, .ready_at)' "$READY_JSON")
if [ "$candidate_identity" != "$ready_identity" ]; then
  terminal_fail ready-identity-mismatch \
    "ready.json identity does not match candidate.json"
fi

repository=$(jq -r .repository "$CANDIDATE_JSON")
candidate_tag=$(jq -r .candidate_tag "$CANDIDATE_JSON")
pr_number=$(jq -r .pr_number "$CANDIDATE_JSON")
base_ref=$(jq -r .base_ref "$CANDIDATE_JSON")
abi_version=$(jq -r .abi_version "$CANDIDATE_JSON")
run_id=$(jq -r .run_id "$CANDIDATE_JSON")
run_attempt=$(jq -r .run_attempt "$CANDIDATE_JSON")
canonical_tag=$(jq -r .canonical_tag "$CANDIDATE_JSON")
bound_candidate_tag="merge-candidate-abi-v${abi_version}-pr-${pr_number}-run-${run_id}-attempt-${run_attempt}"
if [ "$repository" != "$EXPECTED_REPOSITORY" ]; then
  terminal_fail repository-mismatch \
    "repository mismatch: $repository != $EXPECTED_REPOSITORY"
fi
if [ "$candidate_tag" != "$EXPECTED_CANDIDATE_TAG" ]; then
  terminal_fail candidate-tag-mismatch \
    "candidate tag mismatch: $candidate_tag != $EXPECTED_CANDIDATE_TAG"
fi
if [ "$candidate_tag" != "$bound_candidate_tag" ]; then
  terminal_fail candidate-tag-identity-mismatch \
    "candidate tag is not bound to its ABI/PR/run identity: $candidate_tag"
fi
recovery_source_tag=$(jq -r '.recovery.source_candidate_tag // ""' "$CANDIDATE_JSON")
if [ -n "$recovery_source_tag" ]; then
  if ! [[ "$recovery_source_tag" =~ ^merge-candidate-abi-v${abi_version}-pr-${pr_number}-run-[1-9][0-9]*-attempt-[1-9][0-9]*$ ]] ||
     [ "$recovery_source_tag" = "$candidate_tag" ]; then
    terminal_fail candidate-recovery-invalid \
      "candidate recovery source is not a distinct candidate for the same ABI and PR"
  fi
fi
if [ "$canonical_tag" != "binaries-abi-v${abi_version}" ]; then
  terminal_fail canonical-tag-mismatch \
    "canonical tag $canonical_tag does not match ABI $abi_version"
fi
if ! git check-ref-format --branch "$base_ref" >/dev/null 2>&1; then
  terminal_fail candidate-base-ref-invalid \
    "candidate base ref is invalid: $base_ref"
fi

expected_index_sha=$(jq -r .candidate_index_sha256 "$READY_JSON")
actual_index_sha=$(sha256_file "$CANDIDATE_INDEX")
if [ "$actual_index_sha" != "$expected_index_sha" ]; then
  terminal_fail candidate-index-drift \
    "candidate index changed after test approval: $actual_index_sha != $expected_index_sha"
fi

expected_base_index_sha=$(jq -r .base_index_sha256 "$CANDIDATE_JSON")
actual_base_index_sha=$(sha256_file "$BASE_INDEX")
if [ "$actual_base_index_sha" != "$expected_base_index_sha" ]; then
  terminal_fail base-index-drift \
    "immutable candidate base index changed: $actual_base_index_sha != $expected_base_index_sha"
fi

if [ "$METADATA_ONLY" = true ]; then
  echo "verified immutable merge candidate metadata $candidate_tag"
  exit 0
fi

if ! jq -e '
    .state == "MERGED" and
    (.headRefOid | test("^[0-9a-f]{40}$")) and
    (.baseRefName | type == "string" and length > 0) and
    (.mergeCommit.oid | test("^[0-9a-f]{40}$"))
  ' "$PR_JSON" >/dev/null
then
  echo "verify-merge-candidate: GitHub has not confirmed a merged PR with a merge commit" >&2
  exit 1
fi

base_sha=$(jq -r .base_sha "$CANDIDATE_JSON")
head_sha=$(jq -r .head_sha "$CANDIDATE_JSON")
synthetic_tree_sha=$(jq -r .synthetic_tree_sha "$CANDIDATE_JSON")
merge_method=$(jq -r .merge_method "$CANDIDATE_JSON")
pr_commit_count=$(jq -r .pr_commit_count "$CANDIDATE_JSON")
pr_head_sha=$(jq -r .headRefOid "$PR_JSON")
pr_base_ref=$(jq -r .baseRefName "$PR_JSON")
merge_commit_sha=$(jq -r .mergeCommit.oid "$PR_JSON")

if [ "$pr_head_sha" != "$head_sha" ]; then
  terminal_fail merged-head-mismatch \
    "merged PR head $pr_head_sha does not match prepared head $head_sha"
fi
if [ "$pr_base_ref" != "$base_ref" ]; then
  terminal_fail merged-target-mismatch \
    "merged PR target $pr_base_ref does not match prepared target $base_ref"
fi

for object in "$base_sha^{commit}" "$head_sha^{commit}" "$merge_commit_sha^{commit}"; do
  if ! git cat-file -e "$object" 2>/dev/null; then
    echo "verify-merge-candidate: required git object is unavailable: $object" >&2
    exit 1
  fi
done

target_ref="refs/remotes/origin/$base_ref"
if ! git show-ref --verify --quiet "$target_ref"; then
  echo "verify-merge-candidate: target branch ref is unavailable: $target_ref" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$merge_commit_sha" "$target_ref"; then
  echo "verify-merge-candidate: GitHub merge commit $merge_commit_sha is not on $target_ref" >&2
  exit 1
fi

merged_tree_sha=$(git rev-parse "$merge_commit_sha^{tree}")
if [ "$merged_tree_sha" != "$synthetic_tree_sha" ]; then
  terminal_fail merged-tree-mismatch \
    "merged tree $merged_tree_sha does not match tested synthetic tree $synthetic_tree_sha"
fi

prepared_commit_count=$(git rev-list --count "$base_sha..$head_sha")
if [ "$prepared_commit_count" != "$pr_commit_count" ]; then
  terminal_fail prepared-commit-count-mismatch \
    "prepared commit count $prepared_commit_count does not match candidate metadata $pr_commit_count"
fi

case "$merge_method" in
  squash)
    merged_parents=$(git show -s --format=%P "$merge_commit_sha")
    if [ "$merged_parents" != "$base_sha" ]; then
      terminal_fail squash-parent-mismatch \
        "squash merge parent $merged_parents does not match prepared base $base_sha"
    fi
    ;;
  rebase)
    if ! git merge-base --is-ancestor "$base_sha" "$merge_commit_sha"; then
      terminal_fail rebase-base-mismatch \
        "prepared base $base_sha is not an ancestor of rebased merge $merge_commit_sha"
    fi
    non_linear_commits=$(git rev-list --min-parents=2 "$base_sha..$merge_commit_sha")
    if [ -n "$non_linear_commits" ]; then
      terminal_fail rebase-nonlinear-history \
        "rebase result contains merge commits after prepared base $base_sha"
    fi
    merged_commit_count=$(git rev-list --count --first-parent "$base_sha..$merge_commit_sha")
    if [ "$merged_commit_count" != "$pr_commit_count" ]; then
      terminal_fail rebase-commit-count-mismatch \
        "rebased merge contains $merged_commit_count commits after the prepared base, expected $pr_commit_count"
    fi
    ;;
esac

echo "verified merge candidate $candidate_tag at merge commit $merge_commit_sha"
