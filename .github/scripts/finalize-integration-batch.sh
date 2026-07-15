#!/usr/bin/env bash
set -euo pipefail

MANIFEST=""
BATCH_PR=""
MODE="proposed"
APPLY=false
MAX_COMMIT_PAGES=3
PER_PAGE=100
RETRY_DELAY_SECONDS="${INTEGRATION_BATCH_RETRY_DELAY_SECONDS:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --batch-pr) BATCH_PR="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    *) echo "finalize-integration-batch: unknown flag $1" >&2; exit 2 ;;
  esac
done

die() {
  echo "finalize-integration-batch: $*" >&2
  exit 1
}

usage_error() {
  echo "finalize-integration-batch: $*" >&2
  exit 2
}

is_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

if ! [[ "$BATCH_PR" =~ ^[1-9][0-9]*$ ]]; then
  usage_error "--batch-pr must be a positive integer"
fi
case "$MODE" in
  proposed|finalize) ;;
  *) usage_error "--mode must be proposed or finalize" ;;
esac
if [ "$APPLY" = true ] && [ "$MODE" != finalize ]; then
  usage_error "--apply is valid only with --mode finalize"
fi
if ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  usage_error "INTEGRATION_BATCH_RETRY_DELAY_SECONDS must be non-negative"
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
DEFAULT_BRANCH="${GITHUB_DEFAULT_BRANCH:?GITHUB_DEFAULT_BRANCH required}"
EXPECTED_MANIFEST=".github/integration-batches/batch-${BATCH_PR}.json"
if [ "$MANIFEST" != "$EXPECTED_MANIFEST" ]; then
  usage_error "manifest for batch PR #$BATCH_PR must be $EXPECTED_MANIFEST"
fi
if ! git check-ref-format "refs/heads/$DEFAULT_BRANCH" >/dev/null 2>&1; then
  usage_error "GITHUB_DEFAULT_BRANCH is not a valid branch name"
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die "manifest is missing or is a symlink: $MANIFEST"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=.github/scripts/github-api-get.sh
source "$SCRIPT_DIR/github-api-get.sh"
export GITHUB_API_CONTEXT=finalize-integration-batch
export GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS"

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

gh_retry() {
  local attempt=1 delay="$RETRY_DELAY_SECONDS"
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "finalize-integration-batch: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

fetch_retry() {
  local attempt=1 delay="$RETRY_DELAY_SECONDS"
  while true; do
    if git fetch --quiet --no-tags origin "$@"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "finalize-integration-batch: git fetch failed; retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

patch_id() {
  local commit="$1" output
  [ "$(git rev-list --parents -n 1 "$commit" | wc -w | tr -d ' ')" = 2 ] ||
    die "commit $commit is not a non-merge commit"
  output=$(git show --format= --full-index --binary --unified=0 "$commit" | git patch-id --stable) ||
    die "could not compute patch ID for $commit"
  [ "$(printf '%s\n' "$output" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] ||
    die "commit $commit has an empty or ambiguous stable patch ID"
  awk '{print $1}' <<<"$output"
}

require_source_replay_tree() {
  local source_commit="$1" batch_commit="$2"
  local source_parent batch_parent replay_output replay_tree batch_tree

  source_parent=$(git rev-parse "${source_commit}^") ||
    die "cannot read parent of source commit $source_commit"
  batch_parent=$(git rev-parse "${batch_commit}^") ||
    die "cannot read parent of batch commit $batch_commit"
  replay_output=$(git merge-tree --write-tree --no-messages \
    --merge-base "$source_parent" "$batch_parent" "$source_commit") ||
    die "source commit $source_commit does not replay cleanly onto parent of batch commit $batch_commit"
  [ "$(printf '%s\n' "$replay_output" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] ||
    die "source replay for $source_commit produced an ambiguous tree"
  replay_tree=$(printf '%s\n' "$replay_output" | sed '/^$/d')
  is_sha "$replay_tree" || die "source replay for $source_commit produced an invalid tree"
  git cat-file -e "${replay_tree}^{tree}" 2>/dev/null ||
    die "source replay for $source_commit did not produce a tree"
  batch_tree=$(git rev-parse "${batch_commit}^{tree}") ||
    die "cannot read tree of batch commit $batch_commit"
  [ "$replay_tree" = "$batch_tree" ] ||
    die "batch commit $batch_commit is not an exact replay of source commit $source_commit"
}

abi_version_at() {
  local commit="$1" versions
  versions=$(git show "${commit}:crates/shared/src/lib.rs" 2>/dev/null |
    sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p') ||
    die "cannot read ABI_VERSION at $commit"
  [ "$(printf '%s\n' "$versions" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] ||
    die "ABI_VERSION at $commit is missing or ambiguous"
  printf '%s\n' "$versions"
}

list_pr_commits() {
  local pr="$1" output="$2" page response count reached_end=false
  : > "$output"
  for ((page = 1; page <= MAX_COMMIT_PAGES; page++)); do
    response=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${pr}/commits?per_page=${PER_PAGE}&page=${page}") ||
      die "cannot list commits for PR #$pr"
    jq -e 'type == "array" and all(.[]; (keys | index("sha")) != null and
      (.sha | type == "string" and test("^[0-9a-f]{40}$")))' <<<"$response" >/dev/null ||
      die "commit response for PR #$pr is malformed"
    jq -r '.[].sha' <<<"$response" >> "$output"
    count=$(jq 'length' <<<"$response")
    if [ "$count" -lt "$PER_PAGE" ]; then
      reached_end=true
      break
    fi
  done
  [ "$reached_end" = true ] || die "commit scan for PR #$pr reached the 300-commit safety bound"
  [ -s "$output" ] || die "PR #$pr has no commits"
}

require_latest_merge_gate_success() {
  local head_sha="$1" page response count reached_end=false
  local statuses_file="$TMP_ROOT/merge-gate-statuses.jsonl"
  : > "$statuses_file"
  for ((page = 1; page <= 50; page++)); do
    response=$(gh_retry gh api "/repos/${REPOSITORY}/commits/${head_sha}/statuses?per_page=100&page=${page}") ||
      die "cannot read validation statuses for batch head"
    jq -e '
      type == "array" and all(.[];
        (.id | type == "number" and . > 0) and
        (.context | type == "string") and
        (.state | type == "string") and
        (.created_at | type == "string" and
          test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
      ' <<<"$response" >/dev/null || die "validation status page $page is malformed"
    count=$(jq 'length' <<<"$response")
    jq -c '.[]' <<<"$response" >> "$statuses_file"
    if [ "$count" -lt 100 ]; then
      reached_end=true
      break
    fi
  done
  [ "$reached_end" = true ] || die "validation status scan reached its safety bound"
  if [ -s "$statuses_file" ] &&
     [ -n "$(jq -sr 'group_by(.id)[] | select(length > 1) | .[0].id' "$statuses_file")" ]; then
    die "duplicate validation status IDs make pagination uncertain"
  fi
  jq -es '
    map(select(.context == "merge-gate")) |
    sort_by(.created_at, .id) |
    (last // null) as $latest |
    $latest != null and $latest.state == "success"
  ' "$statuses_file" >/dev/null || die "batch head does not have a latest successful merge-gate status"
}

require_manifest_schema() {
  jq -e --argjson batch_pr "$BATCH_PR" --arg default_branch "$DEFAULT_BRANCH" '
    def exact_keys($wanted): (keys | sort) == ($wanted | sort);
    def sha: type == "string" and test("^[0-9a-f]{40}$");
    def slug: type == "string" and test("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    def effect: . == "none" or . == "compatible" or . == "breaking";
    def validation_id:
      . == "abi-snapshot" or . == "kernel-unit" or . == "fork-instrument" or
      . == "host-integration" or . == "browser" or . == "browser-assets" or
      . == "libc" or . == "posix" or . == "sortix" or
      . == "package-publish" or . == "package-universe" or
      . == "homebrew-pilot" or . == "vfs-node" or . == "vfs-browser" or . == "docs";
    def sorted_unique: . == (sort | unique);
    def effect_rank: if . == "none" then 0 elif . == "compatible" then 1 else 2 end;

    exact_keys(["schema_version", "batch", "sources"]) and
    .schema_version == 1 and
    (.batch | exact_keys(["pull_request", "base_ref", "base_sha", "merge_method", "abi", "validation"])) and
    .batch.pull_request == $batch_pr and
    .batch.base_ref == $default_branch and
    (.batch.base_sha | sha) and
    .batch.merge_method == "rebase" and
    (.batch.abi | exact_keys(["effect", "from_version", "to_version"])) and
    (.batch.abi.effect | effect) and
    (.batch.abi.from_version | type == "number" and floor == . and . >= 0) and
    (.batch.abi.to_version | type == "number" and floor == . and . >= 0) and
    (if .batch.abi.effect == "breaking"
     then .batch.abi.to_version > .batch.abi.from_version
     else .batch.abi.to_version == .batch.abi.from_version end) and
    (.batch.validation | exact_keys(["treatment", "required"])) and
    (.batch.validation.treatment | slug) and
    (.batch.validation.required | type == "array" and length > 0 and sorted_unique and all(.[]; validation_id)) and
    (.sources | type == "array" and length > 0) and
    (.sources | map(.pull_request) | sorted_unique) and
    ([.sources[].head_ref] | length == (unique | length)) and
    (.sources | all(.[];
      exact_keys(["pull_request", "head_sha", "head_ref", "abi_effect", "required_validation", "commits"]) and
      (.pull_request | type == "number" and floor == . and . > 0 and . != $batch_pr) and
      (.head_sha | sha) and (.head_ref | type == "string" and length > 0) and (.head_ref != $default_branch) and
      (.abi_effect | effect) and
      (.required_validation | type == "array" and length > 0 and sorted_unique and all(.[]; validation_id)) and
      (.commits | type == "array" and length > 0) and
      (.commits | all(.[]; exact_keys(["source_sha", "batch_sha", "patch_id"]) and
        (.source_sha | sha) and (.batch_sha | sha) and (.patch_id | sha))) and
      .head_sha == .commits[-1].source_sha
    )) and
    ([.sources[].commits[].source_sha] | length == (unique | length)) and
    ([.sources[].commits[].batch_sha] | length == (unique | length)) and
    ([.sources[].commits[].patch_id] | length == (unique | length)) and
    (.batch.validation.required == ([.sources[].required_validation[]] | sort | unique)) and
    ((.batch.abi.effect | effect_rank) == ([.sources[].abi_effect | effect_rank] | max))
  ' "$MANIFEST" >/dev/null || die "manifest does not satisfy schema version 1"
}

require_pr_shape() {
  local json="$1" pr="$2"
  jq -e --argjson pr "$pr" '
    .number == $pr and
    (.state == "open" or .state == "closed") and
    (.merged | type == "boolean") and
    (.merged_at == null or (.merged_at | type == "string")) and
    (.merge_commit_sha == null or (.merge_commit_sha | type == "string" and test("^[0-9a-f]{40}$"))) and
    (.commits | type == "number" and floor == . and . > 0) and
    (.head.sha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.head.ref | type == "string" and length > 0) and
    (.head.repo.full_name | type == "string" and length > 0) and
    (.base.ref | type == "string" and length > 0)
  ' <<<"$json" >/dev/null || die "PR #$pr response is malformed"
}

require_source_pr() {
  local source_json="$1" pr="$2" head_sha="$3" head_ref="$4"
  require_pr_shape "$source_json" "$pr"
  jq -e --arg repo "$REPOSITORY" --arg base "$DEFAULT_BRANCH" \
    --arg sha "$head_sha" --arg ref "$head_ref" '
      .merged == false and .merged_at == null and
      .head.repo.full_name == $repo and .base.ref == $base and
      .head.sha == $sha and .head.ref == $ref
    ' <<<"$source_json" >/dev/null ||
    die "source PR #$pr is merged, cross-repository, retargeted, or no longer at its recorded head"
}

inspect_branch() {
  local pr="$1" ref="$2" sha="$3" state="$4" output="$5" encoded status
  encoded=$(jq -rn --arg value "$ref" '$value | @uri')
  set +e
  github_api_get_json "/repos/${REPOSITORY}/branches/${encoded}" "$output"
  status=$?
  set -e
  case "$status" in
    0)
      jq -e --arg ref "$ref" --arg sha "$sha" '
        .name == $ref and .commit.sha == $sha and .protected == false
      ' "$output" >/dev/null ||
        die "source PR #$pr branch is protected, malformed, or no longer at $sha"
      printf 'present\n'
      ;;
    44)
      if [ "$MODE" = proposed ]; then
        die "source PR #$pr branch $ref is unexpectedly absent"
      fi
      printf 'absent\n'
      ;;
    *) die "could not determine branch state for source PR #$pr" ;;
  esac
}

require_exclusive_source_branch() {
  local pr="$1" ref="$2" state="$3" owner query response expected
  owner="${REPOSITORY%%/*}"
  query=$(jq -rn --arg value "${owner}:${ref}" '$value | @uri')
  response=$(gh_retry gh api "/repos/${REPOSITORY}/pulls?state=open&head=${query}&per_page=100") ||
    die "cannot determine whether source PR #$pr branch is shared"
  jq -e --arg repo "$REPOSITORY" --arg ref "$ref" '
    type == "array" and length < 100 and all(.[];
      (.number | type == "number" and floor == . and . > 0) and
      .head.repo.full_name == $repo and .head.ref == $ref)
  ' <<<"$response" >/dev/null || die "open-PR response for source branch $ref is malformed or truncated"
  if [ "$state" = open ]; then
    expected="[$pr]"
  else
    expected='[]'
  fi
  [ "$(jq -c '[.[].number] | sort' <<<"$response")" = "$expected" ] ||
    die "source PR #$pr branch $ref is shared by another open PR"
}

require_manifest_schema

repo_json=$(gh_retry gh api "/repos/${REPOSITORY}") || die "cannot read repository metadata"
actual_default=$(jq -er '.default_branch | select(type == "string" and length > 0)' <<<"$repo_json") ||
  die "repository metadata is malformed"
[ "$actual_default" = "$DEFAULT_BRANCH" ] || die "repository default branch changed to $actual_default"

BATCH_JSON=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${BATCH_PR}") || die "cannot read batch PR #$BATCH_PR"
require_pr_shape "$BATCH_JSON" "$BATCH_PR"
BATCH_HEAD=$(jq -r .head.sha <<<"$BATCH_JSON")
BATCH_HEAD_REF=$(jq -r .head.ref <<<"$BATCH_JSON")
BATCH_BASE=$(jq -r .base.ref <<<"$BATCH_JSON")
BATCH_COMMIT_COUNT=$(jq -r .commits <<<"$BATCH_JSON")
RECORDED_BASE_SHA=$(jq -r .batch.base_sha "$MANIFEST")
jq -e --arg repo "$REPOSITORY" --arg base "$DEFAULT_BRANCH" '
  .head.repo.full_name == $repo and .base.ref == $base
' <<<"$BATCH_JSON" >/dev/null || die "batch PR must be a same-repository PR to the default branch"
[ "$BATCH_BASE" = "$DEFAULT_BRANCH" ] || die "batch PR target changed"

if [ "$MODE" = proposed ]; then
  jq -e '.state == "open" and .merged == false and .merged_at == null' <<<"$BATCH_JSON" >/dev/null ||
    die "proposed validation requires an open, unmerged batch PR"
  [ "$(git rev-parse HEAD)" = "$BATCH_HEAD" ] || die "checkout is not the exact batch PR head"
  fetch_retry "+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}" ||
    die "cannot fetch current default branch"
  [ "$(git rev-parse "refs/remotes/origin/${DEFAULT_BRANCH}")" = "$RECORDED_BASE_SHA" ] ||
    die "batch is not based on the current default-branch tip"
else
  jq -e '.state == "closed" and .merged == true and .merged_at != null and .merge_commit_sha != null' \
    <<<"$BATCH_JSON" >/dev/null || die "finalization requires a merged batch PR"
  CHECKED_OUT_SHA=$(git rev-parse HEAD)
  fetch_retry "+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}" ||
    die "cannot fetch current default branch"
  LIVE_DEFAULT_SHA=$(git rev-parse "refs/remotes/origin/${DEFAULT_BRANCH}")
  [ "$CHECKED_OUT_SHA" = "$LIVE_DEFAULT_SHA" ] ||
    die "finalization must run from the current default-branch tip"
fi

BATCH_REF="refs/remotes/integration-batch/batch-${BATCH_PR}"
fetch_retry "+refs/pull/${BATCH_PR}/head:${BATCH_REF}" || die "cannot fetch batch PR head"
[ "$(git rev-parse "$BATCH_REF")" = "$BATCH_HEAD" ] || die "batch PR ref disagrees with GitHub API head"

ORIGINAL_MANIFEST="$TMP_ROOT/original-manifest.json"
git show "${BATCH_HEAD}:${MANIFEST}" > "$ORIGINAL_MANIFEST" 2>/dev/null ||
  die "batch PR head does not contain $MANIFEST"
cmp -s "$MANIFEST" "$ORIGINAL_MANIFEST" || die "checked-out manifest differs from the batch PR head"

BATCH_COMMITS="$TMP_ROOT/batch-commits"
list_pr_commits "$BATCH_PR" "$BATCH_COMMITS"
[ "$(wc -l < "$BATCH_COMMITS" | tr -d ' ')" = "$BATCH_COMMIT_COUNT" ] ||
  die "batch PR commit count disagrees with its commit listing"
[ "$(tail -n 1 "$BATCH_COMMITS")" = "$BATCH_HEAD" ] || die "batch PR commit list does not end at its head"

declare -A BATCH_PATCH_TO_SHA=()
declare -A BATCH_SHA_SET=()
previous_batch_commit="$RECORDED_BASE_SHA"
git cat-file -e "${RECORDED_BASE_SHA}^{commit}" 2>/dev/null || die "recorded batch base $RECORDED_BASE_SHA is missing"
git merge-base --is-ancestor "$RECORDED_BASE_SHA" "$BATCH_HEAD" ||
  die "recorded batch base is not an ancestor of the batch head"
[ "$(git merge-base "$RECORDED_BASE_SHA" "$BATCH_HEAD")" = "$RECORDED_BASE_SHA" ] ||
  die "recorded batch base is not the batch merge-base"

RECEIPT_CHANGES="$TMP_ROOT/receipt-changes"
EXPECTED_RECEIPT_CHANGE="$TMP_ROOT/expected-receipt-change"
git diff --name-status "$RECORDED_BASE_SHA" "$BATCH_HEAD" -- .github/integration-batches > "$RECEIPT_CHANGES"
printf 'A\t%s\n' "$MANIFEST" > "$EXPECTED_RECEIPT_CHANGE"
cmp -s "$EXPECTED_RECEIPT_CHANGE" "$RECEIPT_CHANGES" ||
  die "batch must add only its own immutable integration-batch receipt"

AUTHORITY_CHANGES="$TMP_ROOT/authority-changes"
git diff --name-only "$RECORDED_BASE_SHA" "$BATCH_HEAD" -- \
  .github/actions/detect-change-scope \
  .github/scripts/finalize-integration-batch.sh \
  .github/scripts/github-api-get.sh \
  .github/scripts/test-finalize-integration-batch.sh \
  .github/workflows/finalize-integration-batch.yml \
  .github/workflows/prepare-merge.yml \
  .github/workflows/verify-integration-batch.yml \
  scripts/dev-shell.sh \
  tests/scripts/package-publish-flow.sh \
  > "$AUTHORITY_CHANGES"
if [ -s "$AUTHORITY_CHANGES" ]; then
  echo "finalize-integration-batch: manifest-bearing batches cannot change their validation authority:" >&2
  sed 's/^/  /' "$AUTHORITY_CHANGES" >&2
  exit 1
fi

while IFS= read -r sha; do
  git cat-file -e "${sha}^{commit}" 2>/dev/null || die "batch commit $sha is missing"
  [ "$(git rev-parse "${sha}^")" = "$previous_batch_commit" ] ||
    die "batch commit sequence is not linear from recorded base $RECORDED_BASE_SHA"
  id=$(patch_id "$sha")
  [ -z "${BATCH_PATCH_TO_SHA[$id]+x}" ] ||
    die "batch PR has ambiguous stable patch ID $id at ${BATCH_PATCH_TO_SHA[$id]} and $sha"
  BATCH_PATCH_TO_SHA[$id]="$sha"
  BATCH_SHA_SET[$sha]=1
  previous_batch_commit="$sha"
done < "$BATCH_COMMITS"

RECORDED_ABI_FROM=$(jq -r .batch.abi.from_version "$MANIFEST")
RECORDED_ABI_TO=$(jq -r .batch.abi.to_version "$MANIFEST")
ACTUAL_ABI_FROM=$(abi_version_at "$RECORDED_BASE_SHA")
ACTUAL_ABI_TO=$(abi_version_at "$BATCH_HEAD")
[ "$RECORDED_ABI_FROM" = "$ACTUAL_ABI_FROM" ] ||
  die "manifest ABI from_version $RECORDED_ABI_FROM does not match base ABI $ACTUAL_ABI_FROM"
[ "$RECORDED_ABI_TO" = "$ACTUAL_ABI_TO" ] ||
  die "manifest ABI to_version $RECORDED_ABI_TO does not match batch ABI $ACTUAL_ABI_TO"

SOURCE_STATE_FILE="$TMP_ROOT/source-state.tsv"
: > "$SOURCE_STATE_FILE"
source_count=$(jq '.sources | length' "$MANIFEST")
for ((source_index = 0; source_index < source_count; source_index++)); do
  pr=$(jq -r ".sources[$source_index].pull_request" "$MANIFEST")
  head_sha=$(jq -r ".sources[$source_index].head_sha" "$MANIFEST")
  head_ref=$(jq -r ".sources[$source_index].head_ref" "$MANIFEST")
  [ "$head_ref" != "$BATCH_HEAD_REF" ] || die "source PR #$pr reuses the batch branch"
  git check-ref-format "refs/heads/$head_ref" >/dev/null 2>&1 || die "source PR #$pr has an invalid head ref"

  source_json=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${pr}") || die "cannot read source PR #$pr"
  require_source_pr "$source_json" "$pr" "$head_sha" "$head_ref"
  state=$(jq -r .state <<<"$source_json")
  if [ "$MODE" = proposed ] && [ "$state" != open ]; then
    die "proposed batch source PR #$pr is not open"
  fi
  require_exclusive_source_branch "$pr" "$head_ref" "$state"

  source_ref="refs/remotes/integration-batch/source-${pr}"
  fetch_retry "+refs/pull/${pr}/head:${source_ref}" || die "cannot fetch source PR #$pr head"
  [ "$(git rev-parse "$source_ref")" = "$head_sha" ] || die "source PR #$pr ref disagrees with its recorded head"

  listed="$TMP_ROOT/source-${pr}-commits"
  expected="$TMP_ROOT/source-${pr}-expected"
  list_pr_commits "$pr" "$listed"
  jq -r ".sources[$source_index].commits[].source_sha" "$MANIFEST" > "$expected"
  cmp -s "$listed" "$expected" || die "manifest does not account for every commit in source PR #$pr"

  mapping_count=$(jq ".sources[$source_index].commits | length" "$MANIFEST")
  for ((mapping_index = 0; mapping_index < mapping_count; mapping_index++)); do
    source_sha=$(jq -r ".sources[$source_index].commits[$mapping_index].source_sha" "$MANIFEST")
    batch_sha=$(jq -r ".sources[$source_index].commits[$mapping_index].batch_sha" "$MANIFEST")
    recorded_patch=$(jq -r ".sources[$source_index].commits[$mapping_index].patch_id" "$MANIFEST")
    [ -n "${BATCH_SHA_SET[$batch_sha]+x}" ] || die "mapped batch commit $batch_sha is not in batch PR #$BATCH_PR"
    source_patch=$(patch_id "$source_sha")
    batch_patch=$(patch_id "$batch_sha")
    [ "$source_patch" = "$recorded_patch" ] || die "source commit $source_sha patch ID changed"
    [ "$batch_patch" = "$recorded_patch" ] || die "batch commit $batch_sha is not patch-identical to source commit $source_sha"
    require_source_replay_tree "$source_sha" "$batch_sha"
  done

  branch_state=$(inspect_branch "$pr" "$head_ref" "$head_sha" "$state" "$TMP_ROOT/branch-${pr}.json")
  printf '%s\t%s\t%s\t%s\n' "$pr" "$head_ref" "$head_sha" "$branch_state" >> "$SOURCE_STATE_FILE"
done

if [ "$MODE" = finalize ]; then
  MERGE_SHA=$(jq -r .merge_commit_sha <<<"$BATCH_JSON")
  is_sha "$MERGE_SHA" || die "merged batch has no valid merge commit SHA"
  git cat-file -e "${MERGE_SHA}^{commit}" 2>/dev/null || die "merged batch commit $MERGE_SHA is missing from default history"
  git merge-base --is-ancestor "$MERGE_SHA" "refs/remotes/origin/${DEFAULT_BRANCH}" ||
    die "batch merge commit is not on current default-branch history"
  git rev-list --first-parent "refs/remotes/origin/${DEFAULT_BRANCH}" | grep -Fx "$MERGE_SHA" >/dev/null ||
    die "batch merge commit is not on the default branch's first-parent history"
  [ "$(git rev-list --parents -n 1 "$MERGE_SHA" | wc -w | tr -d ' ')" = 2 ] ||
    die "batch PR was not landed as a linear rebase sequence"

  SPAN_PARENT=$(git rev-parse "${MERGE_SHA}~${BATCH_COMMIT_COUNT}") ||
    die "cannot locate the landed batch span"
  [ "$SPAN_PARENT" = "$RECORDED_BASE_SHA" ] ||
    die "landed batch was rebased onto $SPAN_PARENT, not recorded base $RECORDED_BASE_SHA"
  LANDED_COMMITS="$TMP_ROOT/landed-commits"
  git rev-list --first-parent --reverse "${SPAN_PARENT}..${MERGE_SHA}" > "$LANDED_COMMITS"
  [ "$(wc -l < "$LANDED_COMMITS" | tr -d ' ')" = "$BATCH_COMMIT_COUNT" ] ||
    die "landed batch span has the wrong length"
  [ "$(git rev-parse "${BATCH_HEAD}^{tree}")" = "$(git rev-parse "${MERGE_SHA}^{tree}")" ] ||
    die "landed batch tree differs from the reviewed batch head"
  paste "$BATCH_COMMITS" "$LANDED_COMMITS" | while IFS=$'\t' read -r original landed; do
    original_patch=$(patch_id "$original")
    landed_patch=$(patch_id "$landed")
    [ "$original_patch" = "$landed_patch" ] ||
      die "landed commit $landed is not patch-identical to batch commit $original"
    [ "$(git rev-parse "${original}^{tree}")" = "$(git rev-parse "${landed}^{tree}")" ] ||
      die "landed commit $landed has a different tree from batch commit $original"
  done

  LANDED_MANIFEST="$TMP_ROOT/landed-manifest.json"
  git show "${MERGE_SHA}:${MANIFEST}" > "$LANDED_MANIFEST" 2>/dev/null || die "landed batch does not contain its manifest"
  cmp -s "$MANIFEST" "$LANDED_MANIFEST" || die "default-branch manifest differs from the exact landed batch"

  require_latest_merge_gate_success "$BATCH_HEAD"

  fetch_retry "+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}" ||
    die "cannot recheck current default branch"
  [ "$(git rev-parse "refs/remotes/origin/${DEFAULT_BRANCH}")" = "$LIVE_DEFAULT_SHA" ] ||
    die "default branch advanced during finalization validation"
fi

echo "Verified batch PR #$BATCH_PR: $source_count source PR(s), $BATCH_COMMIT_COUNT batch commit(s), treatment $(jq -r .batch.validation.treatment "$MANIFEST")."
while IFS=$'\t' read -r pr ref sha branch_state; do
  echo "PLAN source PR #$pr: close if open; branch $ref at $sha is $branch_state."
done < "$SOURCE_STATE_FILE"

if [ "$MODE" != finalize ] || [ "$APPLY" = false ]; then
  if [ "$MODE" = finalize ]; then
    echo "Dry run only; pass --apply to close source PRs and delete their exact recorded branches."
  fi
  exit 0
fi

while IFS=$'\t' read -r pr ref sha _branch_state; do
  current_json=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${pr}") || die "cannot recheck source PR #$pr"
  require_source_pr "$current_json" "$pr" "$sha" "$ref"
  state=$(jq -r .state <<<"$current_json")
  require_exclusive_source_branch "$pr" "$ref" "$state"
  branch_state=$(inspect_branch "$pr" "$ref" "$sha" "$state" "$TMP_ROOT/apply-branch-${pr}.json")

  if [ "$branch_state" = present ]; then
    git push --quiet --force-with-lease="refs/heads/${ref}:${sha}" origin ":refs/heads/${ref}" ||
      die "conditional deletion of source PR #$pr branch $ref failed"
    if git ls-remote --exit-code origin "refs/heads/${ref}" > "$TMP_ROOT/remaining-${pr}" 2>/dev/null; then
      die "source PR #$pr branch $ref still exists after deletion"
    else
      ls_status=$?
      [ "$ls_status" = 2 ] || die "could not verify deletion of source PR #$pr branch $ref"
    fi
    echo "Deleted source PR #$pr branch $ref at its recorded head."
  fi

  current_json=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${pr}") || die "cannot recheck source PR #$pr after branch deletion"
  require_source_pr "$current_json" "$pr" "$sha" "$ref"
  if [ "$(jq -r .state <<<"$current_json")" = open ]; then
    closed_json=$(gh_retry gh api --method PATCH "/repos/${REPOSITORY}/pulls/${pr}" -f state=closed) ||
      die "could not close absorbed source PR #$pr"
    require_source_pr "$closed_json" "$pr" "$sha" "$ref"
    [ "$(jq -r .state <<<"$closed_json")" = closed ] || die "GitHub did not close source PR #$pr"
    echo "Closed absorbed source PR #$pr."
  else
    echo "Source PR #$pr was already closed."
  fi
  final_branch_state=$(inspect_branch "$pr" "$ref" "$sha" closed "$TMP_ROOT/final-branch-${pr}.json")
  [ "$final_branch_state" = absent ] ||
    die "source PR #$pr branch $ref reappeared during finalization"
done < "$SOURCE_STATE_FILE"

echo "Integration batch #$BATCH_PR finalization complete."
