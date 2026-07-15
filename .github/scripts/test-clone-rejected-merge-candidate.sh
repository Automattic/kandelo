#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLONE="$SCRIPT_DIR/clone-rejected-merge-candidate.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

REMOTE="$TMP_ROOT/remote.git"
SOURCE="$TMP_ROOT/source"
CHECKOUT="$TMP_ROOT/checkout"
git init --quiet --bare "$REMOTE"
git init --quiet --initial-branch=main "$SOURCE"
git -C "$SOURCE" config user.name fixture
git -C "$SOURCE" config user.email fixture@example.invalid

printf 'common\n' > "$SOURCE/common.txt"
git -C "$SOURCE" add common.txt
git -C "$SOURCE" commit --quiet -m common
COMMON_SHA=$(git -C "$SOURCE" rev-parse HEAD)

git -C "$SOURCE" switch --quiet -c feature
printf 'feature one\n' > "$SOURCE/one.txt"
git -C "$SOURCE" add one.txt
git -C "$SOURCE" commit --quiet -m feature-one
FEATURE_ONE=$(git -C "$SOURCE" rev-parse HEAD)
printf 'feature two\n' > "$SOURCE/two.txt"
git -C "$SOURCE" add two.txt
git -C "$SOURCE" commit --quiet -m feature-two
HEAD_SHA=$(git -C "$SOURCE" rev-parse HEAD)

git -C "$SOURCE" switch --quiet main
git -C "$SOURCE" reset --quiet --hard "$COMMON_SHA"
printf 'base advanced\n' > "$SOURCE/base.txt"
git -C "$SOURCE" add base.txt
git -C "$SOURCE" commit --quiet -m base-advanced
BASE_SHA=$(git -C "$SOURCE" rev-parse HEAD)

git -C "$SOURCE" checkout --quiet --detach "$BASE_SHA"
git -C "$SOURCE" merge --quiet --no-ff --no-commit "$HEAD_SHA"
SYNTHETIC_TREE_SHA=$(git -C "$SOURCE" write-tree)
SYNTHETIC_SHA=$(printf 'synthetic\n' |
  git -C "$SOURCE" commit-tree "$SYNTHETIC_TREE_SHA" -p "$BASE_SHA" -p "$HEAD_SHA")
git -C "$SOURCE" update-ref refs/heads/synthesized-merge "$SYNTHETIC_SHA"
git -C "$SOURCE" merge --abort

git -C "$SOURCE" checkout --quiet --detach "$BASE_SHA"
git -C "$SOURCE" cherry-pick --quiet "$FEATURE_ONE"
git -C "$SOURCE" cherry-pick --quiet "$HEAD_SHA"
MERGE_SHA=$(git -C "$SOURCE" rev-parse HEAD)
[ "$(git -C "$SOURCE" rev-parse "$MERGE_SHA^{tree}")" = "$SYNTHETIC_TREE_SHA" ]
git -C "$SOURCE" update-ref refs/heads/main "$MERGE_SHA"
git -C "$SOURCE" push --quiet "$REMOTE" refs/heads/main
git -C "$SOURCE" push --quiet "$REMOTE" "$HEAD_SHA:refs/pull/1/head"

BUNDLE="$TMP_ROOT/synthesized-merge.bundle"
git -C "$SOURCE" bundle create "$BUNDLE" refs/heads/synthesized-merge
git clone --quiet --branch main "$REMOTE" "$CHECKOUT"
mkdir -p "$CHECKOUT/.github/scripts" "$CHECKOUT/crates/shared/src" \
  "$CHECKOUT/packages/registry"
cp "$SCRIPT_DIR/clone-rejected-merge-candidate.sh" \
  "$SCRIPT_DIR/verify-merge-candidate.sh" \
  "$SCRIPT_DIR/mark-merge-candidate-ready.sh" \
  "$SCRIPT_DIR/download-verified-release-asset.sh" \
  "$CHECKOUT/.github/scripts/"
printf 'pub const ABI_VERSION: u32 = 39;\n' \
  > "$CHECKOUT/crates/shared/src/lib.rs"
CLONE="$CHECKOUT/.github/scripts/clone-rejected-merge-candidate.sh"

SOURCE_TAG=merge-candidate-abi-v39-pr-1-run-2-attempt-1
DESTINATION_TAG=merge-candidate-abi-v39-pr-1-run-9-attempt-1
RELEASES="$TMP_ROOT/releases"
mkdir -p "$RELEASES/$SOURCE_TAG"
printf 'base ledger\n' > "$RELEASES/$SOURCE_TAG/base-index.toml"
printf 'exact tested candidate ledger\n' > "$RELEASES/$SOURCE_TAG/index.toml"
printf 'archive a\n' > "$RELEASES/$SOURCE_TAG/a.tar.zst"
printf 'archive b\n' > "$RELEASES/$SOURCE_TAG/b.tar.zst"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

BASE_INDEX_SHA=$(sha256_file "$RELEASES/$SOURCE_TAG/base-index.toml")
INDEX_SHA=$(sha256_file "$RELEASES/$SOURCE_TAG/index.toml")
A_SHA=$(sha256_file "$RELEASES/$SOURCE_TAG/a.tar.zst")
B_SHA=$(sha256_file "$RELEASES/$SOURCE_TAG/b.tar.zst")
jq -n \
  --arg base_sha "$BASE_SHA" \
  --arg head_sha "$HEAD_SHA" \
  --arg synthetic_sha "$SYNTHETIC_SHA" \
  --arg tree_sha "$SYNTHETIC_TREE_SHA" \
  --arg base_index_sha "$BASE_INDEX_SHA" \
  --arg candidate_tag "$SOURCE_TAG" '
  {
    schema_version: 1,
    repository: "example/repo",
    pr_number: 1,
    base_ref: "main",
    base_sha: $base_sha,
    head_sha: $head_sha,
    synthetic_merge_sha: $synthetic_sha,
    synthetic_tree_sha: $tree_sha,
    merge_method: "rebase",
    pr_commit_count: 1,
    abi_version: 39,
    candidate_tag: $candidate_tag,
    canonical_tag: "binaries-abi-v39",
    canonical_base_state: "present",
    base_index_sha256: $base_index_sha,
    run_id: "2",
    run_attempt: "1"
  }
' > "$RELEASES/$SOURCE_TAG/candidate.json"
jq --arg index_sha "$INDEX_SHA" \
  '. + {candidate_index_sha256: $index_sha, ready_at: "2026-07-15T00:00:00Z"}' \
  "$RELEASES/$SOURCE_TAG/candidate.json" > "$RELEASES/$SOURCE_TAG/ready.json"
jq -n \
  --arg candidate_tag "$SOURCE_TAG" \
  --arg merge_sha "$MERGE_SHA" '
  {
    disposition_schema_version: 1,
    disposition: "rejected",
    repository: "example/repo",
    pr_number: 1,
    candidate_tag: $candidate_tag,
    rejection_reason: "prepared-commit-count-mismatch",
    merge_commit_sha: $merge_sha,
    rejected_at: "2026-07-15T00:10:00Z",
    activation_run: "https://github.com/example/repo/actions/runs/3"
  }
' > "$RELEASES/$SOURCE_TAG/rejected.json"
cp "$RELEASES/$SOURCE_TAG/rejected.json" "$TMP_ROOT/rejected.good"
cp "$RELEASES/$SOURCE_TAG/candidate.json" "$TMP_ROOT/candidate.good"
cp "$RELEASES/$SOURCE_TAG/ready.json" "$TMP_ROOT/ready.good"
cp "$RELEASES/$SOURCE_TAG/a.tar.zst" "$TMP_ROOT/a.good"
SOURCE_REJECTION_SHA=$(sha256_file "$RELEASES/$SOURCE_TAG/rejected.json")

PR_JSON="$TMP_ROOT/pr.json"
jq -n --arg head "$HEAD_SHA" --arg merge "$MERGE_SHA" '
  {
    state: "MERGED",
    headRefOid: $head,
    baseRefName: "main",
    mergeCommit: {oid: $merge},
    mergedAt: "2026-07-15T00:05:00Z"
  }
' > "$PR_JSON"

RUN_JSON="$TMP_ROOT/run.json"
jq -n --arg head "$HEAD_SHA" '
  {
    id: 2,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    head_sha: $head,
    path: ".github/workflows/prepare-merge.yml",
    repository: {full_name: "example/repo"}
  }
' > "$RUN_JSON"

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

release_id() {
  case "$1" in
    "$GH_STUB_SOURCE_TAG") printf '101\n' ;;
    "$GH_STUB_DESTINATION_TAG") printf '102\n' ;;
    *) return 1 ;;
  esac
}

tag_for_release_id() {
  case "$1" in
    101) printf '%s\n' "$GH_STUB_SOURCE_TAG" ;;
    102) printf '%s\n' "$GH_STUB_DESTINATION_TAG" ;;
    *) return 1 ;;
  esac
}

emit_assets() {
  local tag="$1" dir="$GH_STUB_RELEASES/$tag" i=0 separator=""
  printf '['
  if [ -d "$dir" ]; then
    while IFS= read -r path; do
      i=$((i + 1))
      name=$(basename "$path")
      size=$(wc -c < "$path" | tr -d '[:space:]')
      sha=$(sha256_file "$path")
      printf '%s' "$separator"
      jq -cn \
        --argjson id "$((100000 + i))" \
        --arg name "$name" \
        --argjson size "$size" \
        --arg digest "sha256:$sha" \
        '{id: $id, name: $name, state: "uploaded", size: $size, digest: $digest}'
      separator=,
    done < <(find "$dir" -maxdepth 1 -type f -print | sort)
  fi
  printf ']\n'
}

command_name="${1:-}"
shift || true
case "$command_name" in
  api)
    method=GET
    endpoint=""
    target_url=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --method|-X) method="$2"; shift 2 ;;
        -f)
          [[ "$2" == target_url=* ]] && target_url="${2#target_url=}"
          shift 2
          ;;
        -H|--jq) shift 2 ;;
        /repos/*) endpoint="$1"; shift ;;
        *) shift ;;
      esac
    done
    if [[ "$endpoint" == *"/statuses/"* ]] && [ "$method" = POST ]; then
      printf '%s\n' "$target_url" > "$GH_STUB_AUTHORITY"
      printf '{}\n'
      exit 0
    fi
    if [[ "$endpoint" == *"/actions/runs/2" ]]; then
      jq --arg conclusion "${GH_STUB_RUN_CONCLUSION:-success}" \
        '.conclusion = $conclusion' "$GH_STUB_RUN_JSON"
      exit 0
    fi
    if [[ "$endpoint" =~ /releases/tags/([^?]+)$ ]]; then
      tag="${BASH_REMATCH[1]}"
      [ -d "$GH_STUB_RELEASES/$tag" ] || exit 1
      id=$(release_id "$tag")
      jq -cn --arg tag "$tag" --argjson id "$id" '{id: $id, tag_name: $tag}'
      exit 0
    fi
    if [[ "$endpoint" =~ /releases/([0-9]+)/assets\? ]]; then
      tag=$(tag_for_release_id "${BASH_REMATCH[1]}")
      emit_assets "$tag"
      exit 0
    fi
    exit 99
    ;;
  pr)
    [ "${1:-}" = view ] || exit 99
    cat "$GH_STUB_PR_JSON"
    ;;
  run)
    [ "${1:-}" = download ] || exit 99
    shift
    dir=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --dir) dir="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    mkdir -p "$dir"
    cp "$GH_STUB_BUNDLE" "$dir/synthesized-merge.bundle"
    ;;
  release)
    sub="${1:-}"
    shift || true
    case "$sub" in
      create)
        tag="${1:?tag required}"
        mkdir -p "$GH_STUB_RELEASES/$tag"
        ;;
      upload)
        tag="${1:?tag required}"
        shift
        mkdir -p "$GH_STUB_RELEASES/$tag"
        for arg in "$@"; do
          if [ -f "$arg" ]; then
            cp "$arg" "$GH_STUB_RELEASES/$tag/$(basename "$arg")"
          fi
        done
        ;;
      download)
        tag="${1:?tag required}"
        shift
        patterns=()
        dir=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --pattern) patterns+=("$2"); shift 2 ;;
            --dir) dir="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        mkdir -p "$dir"
        for pattern in "${patterns[@]}"; do
          cp "$GH_STUB_RELEASES/$tag/$pattern" "$dir/$pattern"
        done
        ;;
      view)
        tag="${1:?tag required}"
        [ -d "$GH_STUB_RELEASES/$tag" ] || exit 1
        for path in "$GH_STUB_RELEASES/$tag"/*; do
          [ -f "$path" ] || continue
          basename "$path"
        done
        ;;
      *) exit 99 ;;
    esac
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$STUB_BIN/gh"

XTASK_STUB="$TMP_ROOT/xtask"
cat > "$XTASK_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
jq -n '{
  abi_version: 39,
  entries: [
    {package: "a", kind: "program", arch: "wasm32", version: "1", revision: 1, cache_key_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    {package: "b", kind: "program", arch: "wasm32", version: "1", revision: 1, cache_key_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
  ]
}' > "$output"
EOF
chmod +x "$XTASK_STUB"

VALIDATE_STUB="$TMP_ROOT/validate-release.sh"
cat > "$VALIDATE_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
tag=""
mode=""
output=""
materialize=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --mode) mode="$2"; shift 2 ;;
    --output-dir) output="$2"; shift 2 ;;
    --materialize) materialize=1; shift ;;
    *) shift ;;
  esac
done
[ "$tag" = "$GH_STUB_SOURCE_TAG" ]
[ "$mode" = current ]
[ "$materialize" = 1 ]
[ "$(sha256sum "$GH_STUB_RELEASES/$tag/a.tar.zst" | awk '{print $1}')" = "$GH_STUB_EXPECTED_A_SHA" ]
[ "$(sha256sum "$GH_STUB_RELEASES/$tag/b.tar.zst" | awk '{print $1}')" = "$GH_STUB_EXPECTED_B_SHA" ]
if [ "${GH_STUB_ADVANCE_DURING_VALIDATE:-0}" = 1 ]; then
  git -C "$GH_STUB_SOURCE_REPO" push --quiet --force "$GH_STUB_REMOTE" \
    "$GH_STUB_ADVANCED_SHA:refs/heads/main"
fi
mkdir -p "$output/archives"
cp "$GH_STUB_RELEASES/$tag/index.toml" "$output/source-index.toml"
cp "$GH_STUB_RELEASES/$tag/index.toml" "$output/archives/index.toml"
cp "$GH_STUB_RELEASES/$tag/a.tar.zst" "$output/archives/a.tar.zst"
cp "$GH_STUB_RELEASES/$tag/b.tar.zst" "$output/archives/b.tar.zst"
a_size=$(wc -c < "$output/archives/a.tar.zst" | tr -d '[:space:]')
b_size=$(wc -c < "$output/archives/b.tar.zst" | tr -d '[:space:]')
jq -n \
  --arg a_sha "$GH_STUB_EXPECTED_A_SHA" \
  --arg b_sha "$GH_STUB_EXPECTED_B_SHA" \
  --argjson a_size "$a_size" \
  --argjson b_size "$b_size" '{
    entries: [
      {asset: "a.tar.zst", archive_sha256: $a_sha, size: $a_size},
      {asset: "b.tar.zst", archive_sha256: $b_sha, size: $b_size}
    ]
  }' > "$output/snapshot.json"
EOF
chmod +x "$VALIDATE_STUB"

STATUS_STUB="$TMP_ROOT/status.sh"
cat > "$STATUS_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat "$GH_STUB_AUTHORITY"
EOF
chmod +x "$STATUS_STUB"

STATE_LOCK_STUB="$TMP_ROOT/state-lock.sh"
cat > "$STATE_LOCK_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "${1:-}" "${2:-}" >> "$STATE_LOCK_STUB_LOG"
EOF
chmod +x "$STATE_LOCK_STUB"

AUTHORITY_FILE="$TMP_ROOT/authority"
SOURCE_AUTHORITY="https://github.com/example/repo/releases/tag/$SOURCE_TAG"
DESTINATION_AUTHORITY="https://github.com/example/repo/releases/tag/$DESTINATION_TAG"
printf '%s\n' "$SOURCE_AUTHORITY" > "$AUTHORITY_FILE"
LOCK_LOG="$TMP_ROOT/locks.log"
touch "$LOCK_LOG"

run_clone() {
  local output="$1"
  local run_attempt="${2:-1}"
  local source_tag="${3:-$SOURCE_TAG}"
  (
    cd "$CHECKOUT"
    GH_STUB_RELEASES="$RELEASES" \
    GH_STUB_SOURCE_TAG="$SOURCE_TAG" \
    GH_STUB_DESTINATION_TAG="$DESTINATION_TAG" \
    GH_STUB_PR_JSON="$PR_JSON" \
    GH_STUB_RUN_JSON="$RUN_JSON" \
    GH_STUB_RUN_CONCLUSION="${GH_STUB_RUN_CONCLUSION:-success}" \
    GH_STUB_BUNDLE="$BUNDLE" \
    GH_STUB_AUTHORITY="$AUTHORITY_FILE" \
    GH_STUB_EXPECTED_A_SHA="$A_SHA" \
    GH_STUB_EXPECTED_B_SHA="$B_SHA" \
    GH_STUB_ADVANCE_DURING_VALIDATE="${GH_STUB_ADVANCE_DURING_VALIDATE:-0}" \
    GH_STUB_SOURCE_REPO="$SOURCE" \
    GH_STUB_REMOTE="$REMOTE" \
    GH_STUB_ADVANCED_SHA="${ADVANCED_DEFAULT_SHA:-$MERGE_SHA}" \
    STATE_LOCK_STUB_LOG="$LOCK_LOG" \
    GITHUB_REPOSITORY=example/repo \
    GITHUB_SERVER_URL=https://github.com \
    GITHUB_DEFAULT_BRANCH=main \
    GITHUB_RUN_ID=9 \
    GITHUB_RUN_ATTEMPT="$run_attempt" \
    STATE_LOCK_SCRIPT="$STATE_LOCK_STUB" \
    STATUS_SCRIPT="$STATUS_STUB" \
    VALIDATE_RELEASE_SCRIPT="$VALIDATE_STUB" \
    XTASK="$XTASK_STUB" \
    PATH="$STUB_BIN:$PATH" \
    "$CLONE" --source-candidate-tag "$source_tag" --output-file "$output"
  )
}

assert_failed_before_clone() {
  local label="$1"
  if run_clone "$TMP_ROOT/$label.outputs" >"$TMP_ROOT/$label.out" 2>"$TMP_ROOT/$label.err"; then
    echo "$label unexpectedly recovered the candidate" >&2
    exit 1
  fi
  [ ! -d "$RELEASES/$DESTINATION_TAG" ]
  printf '%s\n' "$SOURCE_AUTHORITY" > "$AUTHORITY_FILE"
}

jq '.rejection_reason = "merged-tree-mismatch"' "$TMP_ROOT/rejected.good" \
  > "$RELEASES/$SOURCE_TAG/rejected.json"
assert_failed_before_clone wrong-rejection
grep -q 'exact prepared-commit-count-mismatch rejection' "$TMP_ROOT/wrong-rejection.err"
cp "$TMP_ROOT/rejected.good" "$RELEASES/$SOURCE_TAG/rejected.json"

if run_clone "$TMP_ROOT/obsolete-abi.outputs" 1 \
    merge-candidate-abi-v40-pr-1-run-2-attempt-1 \
    >"$TMP_ROOT/obsolete-abi.out" 2>"$TMP_ROOT/obsolete-abi.err"
then
  echo "recovery accepted a source from a different platform ABI" >&2
  exit 1
fi
grep -q 'source candidate ABI 40 is not current platform ABI 39' "$TMP_ROOT/obsolete-abi.err"

git -C "$SOURCE" checkout --quiet --detach "$MERGE_SHA"
printf 'default advanced\n' > "$SOURCE/advanced.txt"
git -C "$SOURCE" add advanced.txt
git -C "$SOURCE" commit --quiet -m default-advanced
ADVANCED_DEFAULT_SHA=$(git -C "$SOURCE" rev-parse HEAD)
git -C "$SOURCE" push --quiet --force "$REMOTE" \
  "$ADVANCED_DEFAULT_SHA:refs/heads/main"
assert_failed_before_clone default-advanced
grep -q 'checked-out platform revision is not the current default-branch tip' \
  "$TMP_ROOT/default-advanced.err"
git -C "$SOURCE" push --quiet --force "$REMOTE" "$MERGE_SHA:refs/heads/main"

GH_STUB_ADVANCE_DURING_VALIDATE=1 assert_failed_before_clone default-advanced-during-validation
grep -q 'default branch advanced during recovery validation' \
  "$TMP_ROOT/default-advanced-during-validation.err"
git -C "$SOURCE" push --quiet --force "$REMOTE" "$MERGE_SHA:refs/heads/main"

GH_STUB_RUN_CONCLUSION=failure assert_failed_before_clone failed-source-run
grep -q 'not exact successful evidence' "$TMP_ROOT/failed-source-run.err"

jq '.synthetic_tree_sha = "ffffffffffffffffffffffffffffffffffffffff"' \
  "$TMP_ROOT/candidate.good" > "$RELEASES/$SOURCE_TAG/candidate.json"
jq '.synthetic_tree_sha = "ffffffffffffffffffffffffffffffffffffffff"' \
  "$TMP_ROOT/ready.good" > "$RELEASES/$SOURCE_TAG/ready.json"
assert_failed_before_clone wrong-tree
grep -q 'tested and merged trees are not identical' "$TMP_ROOT/wrong-tree.err"
cp "$TMP_ROOT/candidate.good" "$RELEASES/$SOURCE_TAG/candidate.json"
cp "$TMP_ROOT/ready.good" "$RELEASES/$SOURCE_TAG/ready.json"

printf 'tampered archive a\n' > "$RELEASES/$SOURCE_TAG/a.tar.zst"
assert_failed_before_clone archive-drift
cp "$TMP_ROOT/a.good" "$RELEASES/$SOURCE_TAG/a.tar.zst"

printf '%s\n' "https://github.com/example/repo/releases/tag/merge-candidate-abi-v39-pr-2-run-8-attempt-1" \
  > "$AUTHORITY_FILE"
assert_failed_before_clone stale-authority
grep -q 'not this source or its recovery clone' "$TMP_ROOT/stale-authority.err"

: > "$LOCK_LOG"
OUTPUTS="$TMP_ROOT/recovery.outputs"
run_clone "$OUTPUTS" >/dev/null

[ "$(sed -n 's/^candidate_tag=//p' "$OUTPUTS")" = "$DESTINATION_TAG" ]
[ "$(sed -n 's/^pr_number=//p' "$OUTPUTS")" = 1 ]
[ "$(sed -n 's/^ledger_asset_count=//p' "$OUTPUTS")" = 2 ]
[ "$(sed -n 's/^candidate_index_sha256=//p' "$OUTPUTS")" = "$INDEX_SHA" ]
[ "$(sed -n 's/^validated_default_ref=//p' "$OUTPUTS")" = main ]
[ "$(sed -n 's/^validated_default_sha=//p' "$OUTPUTS")" = "$MERGE_SHA" ]
[ "$(jq -r .pr_commit_count "$RELEASES/$DESTINATION_TAG/candidate.json")" = 2 ]
[ "$(jq -r .recovery.source_candidate_tag "$RELEASES/$DESTINATION_TAG/candidate.json")" = "$SOURCE_TAG" ]
[ "$(jq -r .candidate_tag "$RELEASES/$DESTINATION_TAG/candidate.json")" = "$DESTINATION_TAG" ]
[ "$(jq -r .candidate_index_sha256 "$RELEASES/$DESTINATION_TAG/ready.json")" = "$INDEX_SHA" ]
cmp "$RELEASES/$SOURCE_TAG/base-index.toml" "$RELEASES/$DESTINATION_TAG/base-index.toml"
cmp "$RELEASES/$SOURCE_TAG/index.toml" "$RELEASES/$DESTINATION_TAG/index.toml"
cmp "$RELEASES/$SOURCE_TAG/a.tar.zst" "$RELEASES/$DESTINATION_TAG/a.tar.zst"
cmp "$RELEASES/$SOURCE_TAG/b.tar.zst" "$RELEASES/$DESTINATION_TAG/b.tar.zst"
[ ! -f "$RELEASES/$DESTINATION_TAG/rejected.json" ]
[ "$(sha256_file "$RELEASES/$SOURCE_TAG/rejected.json")" = "$SOURCE_REJECTION_SHA" ]
[ "$(cat "$AUTHORITY_FILE")" = "$DESTINATION_AUTHORITY" ]

# A retry after mark-ready but before activation must reuse and fully validate
# the authoritative clone from the prior attempt.
RETRY_OUTPUTS="$TMP_ROOT/recovery-retry.outputs"
run_clone "$RETRY_OUTPUTS" 2 >/dev/null
[ "$(sed -n 's/^candidate_tag=//p' "$RETRY_OUTPUTS")" = "$DESTINATION_TAG" ]
[ ! -d "$RELEASES/merge-candidate-abi-v39-pr-1-run-9-attempt-2" ]

# Even an already-activated recovery clone converges through the same output;
# the workflow can safely invoke the ordinary activation path again.
jq \
  --arg merge_commit_sha "$MERGE_SHA" \
  '. + {
    merge_commit_sha: $merge_commit_sha,
    canonical_index_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    activated_at: "2026-07-15T00:20:00Z",
    activation_run: "https://github.com/example/repo/actions/runs/9"
  }' "$RELEASES/$DESTINATION_TAG/ready.json" \
  > "$RELEASES/$DESTINATION_TAG/activated.json"
ACTIVATED_RETRY_OUTPUTS="$TMP_ROOT/activated-retry.outputs"
run_clone "$ACTIVATED_RETRY_OUTPUTS" 3 >/dev/null
[ "$(sed -n 's/^candidate_tag=//p' "$ACTIVATED_RETRY_OUTPUTS")" = "$DESTINATION_TAG" ]
[ ! -d "$RELEASES/merge-candidate-abi-v39-pr-1-run-9-attempt-3" ]

# Reuse is validation-only. Once authoritative, altered clone bytes cannot be
# filled in, overwritten, or replaced by another recovery release.
cp "$RELEASES/$DESTINATION_TAG/a.tar.zst" "$TMP_ROOT/destination-a.good"
printf 'altered recovered archive\n' > "$RELEASES/$DESTINATION_TAG/a.tar.zst"
if run_clone "$TMP_ROOT/altered-retry.outputs" 4 \
    >"$TMP_ROOT/altered-retry.out" 2>"$TMP_ROOT/altered-retry.err"
then
  echo "recovery reused an altered authoritative clone" >&2
  exit 1
fi
grep -q 'destination immutable asset a.tar.zst has different metadata' \
  "$TMP_ROOT/altered-retry.err"
[ ! -d "$RELEASES/merge-candidate-abi-v39-pr-1-run-9-attempt-4" ]
mv "$TMP_ROOT/destination-a.good" "$RELEASES/$DESTINATION_TAG/a.tar.zst"

mapfile -t first_acquires < <(grep '^acquire ' "$LOCK_LOG" | head -3)
[ "${first_acquires[0]}" = "acquire merge-authority-pr-1" ]
[ "${first_acquires[1]}" = "acquire $SOURCE_TAG" ]
[ "${first_acquires[2]}" = "acquire $DESTINATION_TAG" ]

rm "$RELEASES/$DESTINATION_TAG/ready.json"
rm "$RELEASES/$DESTINATION_TAG/activated.json"
printf '%s\n' "$SOURCE_AUTHORITY" > "$AUTHORITY_FILE"
printf 'contaminated\n' > "$RELEASES/$DESTINATION_TAG/unexpected.txt"
if run_clone "$TMP_ROOT/contaminated.outputs" >"$TMP_ROOT/contaminated.out" 2>"$TMP_ROOT/contaminated.err"; then
  echo "recovery accepted a contaminated destination" >&2
  exit 1
fi
grep -q 'destination contains unexpected asset unexpected.txt' "$TMP_ROOT/contaminated.err"

echo "rejected merge candidate clone tests passed"
