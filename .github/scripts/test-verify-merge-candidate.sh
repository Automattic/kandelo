#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$SCRIPT_DIR/verify-merge-candidate.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

REPO="$TMP_ROOT/repo"
git init --quiet "$REPO"
git -C "$REPO" config user.name test
git -C "$REPO" config user.email test@example.invalid

printf 'base\n' > "$REPO/base.txt"
git -C "$REPO" add base.txt
git -C "$REPO" commit --quiet -m base
BASE_SHA=$(git -C "$REPO" rev-parse HEAD)

git -C "$REPO" switch --quiet -c feature
printf 'feature\n' > "$REPO/feature.txt"
git -C "$REPO" add feature.txt
git -C "$REPO" commit --quiet -m feature
FIRST_HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
printf 'second feature\n' > "$REPO/second.txt"
git -C "$REPO" add second.txt
git -C "$REPO" commit --quiet -m second-feature
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)

SYNTHETIC_TREE_SHA=$(git -C "$REPO" rev-parse "$HEAD_SHA^{tree}")
SYNTHETIC_MERGE_SHA=$(printf 'synthetic\n' | git -C "$REPO" commit-tree "$SYNTHETIC_TREE_SHA" -p "$BASE_SHA" -p "$HEAD_SHA")

MERGE_SHA=$(printf 'squash\n' | git -C "$REPO" commit-tree "$SYNTHETIC_TREE_SHA" -p "$BASE_SHA")
git -C "$REPO" update-ref refs/remotes/origin/main "$MERGE_SHA"

INDEX="$TMP_ROOT/index.toml"
printf 'candidate index\n' > "$INDEX"
BASE_INDEX="$TMP_ROOT/base-index.toml"
printf 'base index\n' > "$BASE_INDEX"
if command -v sha256sum >/dev/null 2>&1; then
  INDEX_SHA=$(sha256sum "$INDEX" | awk '{print $1}')
else
  INDEX_SHA=$(shasum -a 256 "$INDEX" | awk '{print $1}')
fi
if command -v sha256sum >/dev/null 2>&1; then
  BASE_INDEX_SHA=$(sha256sum "$BASE_INDEX" | awk '{print $1}')
else
  BASE_INDEX_SHA=$(shasum -a 256 "$BASE_INDEX" | awk '{print $1}')
fi

CANDIDATE_TAG="merge-candidate-abi-v39-pr-1-run-2-attempt-1"
CANDIDATE_JSON="$TMP_ROOT/candidate.json"
READY_JSON="$TMP_ROOT/ready.json"
PR_JSON="$TMP_ROOT/pr.json"

jq -n \
  --arg repository example/repo \
  --arg base_ref main \
  --arg base_sha "$BASE_SHA" \
  --arg head_sha "$HEAD_SHA" \
  --arg synthetic_merge_sha "$SYNTHETIC_MERGE_SHA" \
  --arg synthetic_tree_sha "$SYNTHETIC_TREE_SHA" \
  --arg merge_method squash \
  --arg candidate_tag "$CANDIDATE_TAG" \
  --arg base_index_sha "$BASE_INDEX_SHA" \
  '{
    schema_version: 1,
    repository: $repository,
    pr_number: 1,
    base_ref: $base_ref,
    base_sha: $base_sha,
    head_sha: $head_sha,
    synthetic_merge_sha: $synthetic_merge_sha,
    synthetic_tree_sha: $synthetic_tree_sha,
    merge_method: $merge_method,
    pr_commit_count: 2,
    abi_version: 39,
    candidate_tag: $candidate_tag,
    canonical_tag: "binaries-abi-v39",
    canonical_base_state: "present",
    base_index_sha256: $base_index_sha,
    run_id: "2",
    run_attempt: "1"
  }' > "$CANDIDATE_JSON"

jq --arg index_sha "$INDEX_SHA" \
  '. + {candidate_index_sha256: $index_sha, ready_at: "2026-07-14T00:00:00Z"}' \
  "$CANDIDATE_JSON" > "$READY_JSON"

jq -n \
  --arg head "$HEAD_SHA" \
  --arg merge "$MERGE_SHA" \
  '{state: "MERGED", headRefOid: $head, baseRefName: "main", mergeCommit: {oid: $merge}}' \
  > "$PR_JSON"

run_verify() {
  (cd "$REPO" && \
    "$VERIFY" \
      --candidate-json "$CANDIDATE_JSON" \
      --ready-json "$READY_JSON" \
      --candidate-index "$INDEX" \
      --base-index "$BASE_INDEX" \
      --pr-json "$PR_JSON" \
      --repository example/repo \
      --candidate-tag "$CANDIDATE_TAG" \
      --terminal-reason-file "$TMP_ROOT/terminal-reason")
}

run_verify >/dev/null

cp "$CANDIDATE_JSON" "$TMP_ROOT/candidate-without-recovery.json"
cp "$READY_JSON" "$TMP_ROOT/ready-without-recovery.json"
jq '.recovery = {
      kind: "immutable-clone-v1",
      source_candidate_tag: "merge-candidate-abi-v39-pr-1-run-1-attempt-1",
      source_candidate_index_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }' "$CANDIDATE_JSON" > "$TMP_ROOT/recovery-candidate.json"
mv "$TMP_ROOT/recovery-candidate.json" "$CANDIDATE_JSON"
jq '.recovery = {
      kind: "immutable-clone-v1",
      source_candidate_tag: "merge-candidate-abi-v39-pr-1-run-1-attempt-1",
      source_candidate_index_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }' "$READY_JSON" > "$TMP_ROOT/recovery-ready.json"
mv "$TMP_ROOT/recovery-ready.json" "$READY_JSON"
run_verify >/dev/null

jq '.recovery.source_candidate_tag = "merge-candidate-abi-v39-pr-1-run-9-attempt-1"' \
  "$READY_JSON" > "$TMP_ROOT/recovery-mismatch-ready.json"
mv "$TMP_ROOT/recovery-mismatch-ready.json" "$READY_JSON"
if run_verify >"$TMP_ROOT/recovery-mismatch.out" 2>"$TMP_ROOT/recovery-mismatch.err"; then
  echo "expected candidate/ready recovery mismatch to fail" >&2
  exit 1
fi
[ "$(cat "$TMP_ROOT/terminal-reason")" = ready-identity-mismatch ]
jq '.recovery.source_candidate_tag = "merge-candidate-abi-v39-pr-1-run-1-attempt-1"' \
  "$READY_JSON" > "$TMP_ROOT/recovery-matched-ready.json"
mv "$TMP_ROOT/recovery-matched-ready.json" "$READY_JSON"

jq '.recovery.kind = "untrusted-recovery"' "$CANDIDATE_JSON" \
  > "$TMP_ROOT/malformed-recovery-candidate.json"
mv "$TMP_ROOT/malformed-recovery-candidate.json" "$CANDIDATE_JSON"
jq '.recovery.kind = "untrusted-recovery"' "$READY_JSON" \
  > "$TMP_ROOT/malformed-recovery-ready.json"
mv "$TMP_ROOT/malformed-recovery-ready.json" "$READY_JSON"
if run_verify >"$TMP_ROOT/malformed-recovery.out" 2>"$TMP_ROOT/malformed-recovery.err"; then
  echo "expected malformed recovery provenance to fail" >&2
  exit 1
fi
[ "$(cat "$TMP_ROOT/terminal-reason")" = candidate-metadata-invalid ]

for mismatch in \
  merge-candidate-abi-v40-pr-1-run-1-attempt-1 \
  merge-candidate-abi-v39-pr-2-run-1-attempt-1
do
  jq --arg source "$mismatch" \
    '.recovery.kind = "immutable-clone-v1" | .recovery.source_candidate_tag = $source' \
    "$CANDIDATE_JSON" > "$TMP_ROOT/wrong-source-candidate.json"
  mv "$TMP_ROOT/wrong-source-candidate.json" "$CANDIDATE_JSON"
  jq --arg source "$mismatch" \
    '.recovery.kind = "immutable-clone-v1" | .recovery.source_candidate_tag = $source' \
    "$READY_JSON" > "$TMP_ROOT/wrong-source-ready.json"
  mv "$TMP_ROOT/wrong-source-ready.json" "$READY_JSON"
  if run_verify >"$TMP_ROOT/wrong-source.out" 2>"$TMP_ROOT/wrong-source.err"; then
    echo "expected recovery source $mismatch to fail" >&2
    exit 1
  fi
  [ "$(cat "$TMP_ROOT/terminal-reason")" = candidate-recovery-invalid ]
done

cp "$TMP_ROOT/candidate-without-recovery.json" "$CANDIDATE_JSON"
cp "$TMP_ROOT/ready-without-recovery.json" "$READY_JSON"

jq '.canonical_tag = "binaries-abi-v40"' "$CANDIDATE_JSON" > "$TMP_ROOT/bad-tag-candidate.json"
mv "$TMP_ROOT/bad-tag-candidate.json" "$CANDIDATE_JSON"
jq '.canonical_tag = "binaries-abi-v40"' "$READY_JSON" > "$TMP_ROOT/bad-tag-ready.json"
mv "$TMP_ROOT/bad-tag-ready.json" "$READY_JSON"
if run_verify >"$TMP_ROOT/tag.out" 2>"$TMP_ROOT/tag.err"; then
  echo "expected canonical ABI tag mismatch to fail" >&2
  exit 1
fi
grep -q 'does not match ABI' "$TMP_ROOT/tag.err"
jq '.canonical_tag = "binaries-abi-v39"' "$CANDIDATE_JSON" > "$TMP_ROOT/good-tag-candidate.json"
mv "$TMP_ROOT/good-tag-candidate.json" "$CANDIDATE_JSON"
jq '.canonical_tag = "binaries-abi-v39"' "$READY_JSON" > "$TMP_ROOT/good-tag-ready.json"
mv "$TMP_ROOT/good-tag-ready.json" "$READY_JSON"

jq '.headRefOid = "0000000000000000000000000000000000000000"' "$PR_JSON" > "$TMP_ROOT/bad-pr.json"
mv "$TMP_ROOT/bad-pr.json" "$PR_JSON"
if run_verify >"$TMP_ROOT/head.out" 2>"$TMP_ROOT/head.err"; then
  echo "expected merged head mismatch to fail" >&2
  exit 1
fi
grep -q 'does not match prepared head' "$TMP_ROOT/head.err"

jq --arg head "$HEAD_SHA" '.headRefOid = $head' "$PR_JSON" > "$TMP_ROOT/good-pr.json"
mv "$TMP_ROOT/good-pr.json" "$PR_JSON"
printf 'changed after tests\n' >> "$INDEX"
if run_verify >"$TMP_ROOT/index.out" 2>"$TMP_ROOT/index.err"; then
  echo "expected candidate index hash mismatch to fail" >&2
  exit 1
fi
grep -q 'changed after test approval' "$TMP_ROOT/index.err"

printf 'candidate index\n' > "$INDEX"
DRIFT_TREE=$(git -C "$REPO" mktree </dev/null)
DRIFT_MERGE=$(printf 'drift\n' | git -C "$REPO" commit-tree "$DRIFT_TREE" -p "$BASE_SHA")
git -C "$REPO" update-ref refs/remotes/origin/main "$DRIFT_MERGE"
jq --arg merge "$DRIFT_MERGE" '.mergeCommit.oid = $merge' "$PR_JSON" > "$TMP_ROOT/drift-pr.json"
mv "$TMP_ROOT/drift-pr.json" "$PR_JSON"
if run_verify >"$TMP_ROOT/tree.out" 2>"$TMP_ROOT/tree.err"; then
  echo "expected merged tree drift to fail" >&2
  exit 1
fi
grep -q 'does not match tested synthetic tree' "$TMP_ROOT/tree.err"
[ "$(cat "$TMP_ROOT/terminal-reason")" = merged-tree-mismatch ]

# GitHub's rebase merge rewrites the PR commits onto the prepared base. The
# verifier accepts that shape only when the final tree and exact commit count
# match the tested candidate.
REBASE_ONE_TREE=$(git -C "$REPO" rev-parse "$FIRST_HEAD_SHA^{tree}")
REBASE_ONE=$(printf 'rebased feature\n' | git -C "$REPO" commit-tree "$REBASE_ONE_TREE" -p "$BASE_SHA")
REBASE_TWO=$(printf 'rebased second feature\n' | \
  git -C "$REPO" commit-tree "$SYNTHETIC_TREE_SHA" -p "$REBASE_ONE")
git -C "$REPO" update-ref refs/remotes/origin/main "$REBASE_TWO"
jq '.merge_method = "rebase"' "$CANDIDATE_JSON" > "$TMP_ROOT/rebase-candidate.json"
mv "$TMP_ROOT/rebase-candidate.json" "$CANDIDATE_JSON"
jq '.merge_method = "rebase"' "$READY_JSON" > "$TMP_ROOT/rebase-ready.json"
mv "$TMP_ROOT/rebase-ready.json" "$READY_JSON"
jq -n \
  --arg head "$HEAD_SHA" \
  --arg merge "$REBASE_TWO" \
  '{state: "MERGED", headRefOid: $head, baseRefName: "main", mergeCommit: {oid: $merge}}' \
  > "$PR_JSON"
run_verify >/dev/null

MERGE_METHOD_DRIFT=$(printf 'merge method drift\n' | \
  git -C "$REPO" commit-tree "$SYNTHETIC_TREE_SHA" -p "$BASE_SHA" -p "$HEAD_SHA")
git -C "$REPO" update-ref refs/remotes/origin/main "$MERGE_METHOD_DRIFT"
jq --arg merge "$MERGE_METHOD_DRIFT" '.mergeCommit.oid = $merge' "$PR_JSON" \
  > "$TMP_ROOT/merge-method-pr.json"
mv "$TMP_ROOT/merge-method-pr.json" "$PR_JSON"
if run_verify >"$TMP_ROOT/method.out" 2>"$TMP_ROOT/method.err"; then
  echo "expected a merge commit to fail rebase verification" >&2
  exit 1
fi
grep -q 'rebase result contains merge commits' "$TMP_ROOT/method.err"

echo "merge candidate verification tests passed"
