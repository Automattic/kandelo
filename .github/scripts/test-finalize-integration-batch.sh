#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
FINALIZER="$SCRIPT_DIR/finalize-integration-batch.sh"
WORKFLOW_VERIFY="$SCRIPT_DIR/../workflows/verify-integration-batch.yml"
WORKFLOW_FINALIZE="$SCRIPT_DIR/../workflows/finalize-integration-batch.yml"
TMP_ROOT=$(mktemp -d)
if [ "${KEEP_INTEGRATION_BATCH_FIXTURES:-false}" = true ]; then
  trap 'echo "kept integration batch fixtures at $TMP_ROOT" >&2' EXIT
else
  trap 'rm -rf "$TMP_ROOT"' EXIT
fi

FIXTURE_NUMBER=0

fixture_patch_id() {
  local repo="$1" commit="$2"
  git -C "$repo" show --format= --full-index --binary --unified=0 "$commit" |
    git patch-id --stable | awk '{print $1}'
}

make_fixture() {
  local variant="${1:-valid}"
  FIXTURE_NUMBER=$((FIXTURE_NUMBER + 1))
  FIXTURE="$TMP_ROOT/fixture-$FIXTURE_NUMBER"
  REMOTE="$FIXTURE/remote.git"
  REPO="$FIXTURE/repo"
  DATA="$FIXTURE/data"
  BIN="$FIXTURE/bin"
  LOG="$FIXTURE/gh.log"
  MUTATIONS="$FIXTURE/mutations.log"
  mkdir -p "$DATA" "$BIN"
  : > "$LOG"
  : > "$MUTATIONS"

  git init --quiet --bare "$REMOTE"
  git init --quiet -b main "$REPO"
  git -C "$REPO" config user.name "Batch Test"
  git -C "$REPO" config user.email batch@example.invalid
  git -C "$REPO" remote add origin "$REMOTE"

  printf 'base\n' > "$REPO/base.txt"
  printf 'first context\nold value\ncontext a\ncontext b\nlast context\nold value\n' \
    > "$REPO/source-one.txt"
  mkdir -p "$REPO/crates/shared/src"
  mkdir -p "$REPO/.github/integration-batches" "$REPO/.github/workflows"
  printf 'pub const ABI_VERSION: u32 = 39;\n' > "$REPO/crates/shared/src/lib.rs"
  printf '{"historical":"receipt"}\n' > "$REPO/.github/integration-batches/batch-5.json"
  printf 'name: trusted prepare merge\n' > "$REPO/.github/workflows/prepare-merge.yml"
  git -C "$REPO" add base.txt source-one.txt crates/shared/src/lib.rs .github
  git -C "$REPO" commit --quiet -m base
  BASE_SHA=$(git -C "$REPO" rev-parse HEAD)

  git -C "$REPO" checkout --quiet -b fix/source-one
  printf 'first context\nnew value\ncontext a\ncontext b\nlast context\nold value\n' \
    > "$REPO/source-one.txt"
  git -C "$REPO" add source-one.txt
  git -C "$REPO" commit --quiet -m 'kernel: source one'
  SOURCE_ONE=$(git -C "$REPO" rev-parse HEAD)

  git -C "$REPO" checkout --quiet -b fix/source-two main
  printf 'source two a\n' > "$REPO/source-two-a.txt"
  git -C "$REPO" add source-two-a.txt
  git -C "$REPO" commit --quiet -m 'host: source two part one'
  SOURCE_TWO_A=$(git -C "$REPO" rev-parse HEAD)
  printf 'source two b\n' > "$REPO/source-two-b.txt"
  git -C "$REPO" add source-two-b.txt
  git -C "$REPO" commit --quiet -m 'host: source two part two'
  SOURCE_TWO_B=$(git -C "$REPO" rev-parse HEAD)

  git -C "$REPO" checkout --quiet -b integration/batch-10 main
  case "$variant" in
    context-rebase)
      printf 'first context\nold value\ncontext a\ncontext b\nrebased context\nold value\n' \
        > "$REPO/source-one.txt"
      git -C "$REPO" commit --quiet -am 'ci: adjust nearby batch context'
      git -C "$REPO" cherry-pick --quiet "$SOURCE_ONE" >/dev/null
      ;;
    moved-delta)
      printf 'first context\nold value\ncontext a\ncontext b\nlast context\nnew value\n' \
        > "$REPO/source-one.txt"
      git -C "$REPO" commit --quiet -am 'kernel: source one'
      ;;
    changed-delta)
      printf 'first context\na genuinely different value\ncontext a\ncontext b\nlast context\nold value\n' \
        > "$REPO/source-one.txt"
      git -C "$REPO" commit --quiet -am 'kernel: source one'
      ;;
    *)
      git -C "$REPO" cherry-pick --quiet "$SOURCE_ONE" >/dev/null
      ;;
  esac
  BATCH_ONE=$(git -C "$REPO" rev-parse HEAD)
  git -C "$REPO" cherry-pick --quiet "$SOURCE_TWO_A" >/dev/null
  BATCH_TWO_A=$(git -C "$REPO" rev-parse HEAD)
  git -C "$REPO" cherry-pick --quiet "$SOURCE_TWO_B" >/dev/null
  BATCH_TWO_B=$(git -C "$REPO" rev-parse HEAD)
  printf 'batch validation notes\n' > "$REPO/batch-notes.txt"
  if [ "$variant" = actual-abi-drift ]; then
    printf 'pub const ABI_VERSION: u32 = 40;\n' > "$REPO/crates/shared/src/lib.rs"
  fi
  if [ "$variant" = prior-receipt-mutation ]; then
    printf '{"historical":"rewritten"}\n' > "$REPO/.github/integration-batches/batch-5.json"
  fi
  if [ "$variant" = authority-change ]; then
    printf 'name: batch-controlled prepare merge\n' > "$REPO/.github/workflows/prepare-merge.yml"
  fi
  git -C "$REPO" add batch-notes.txt crates/shared/src/lib.rs .github
  git -C "$REPO" commit --quiet -m 'ci: record batch validation notes'

  patch_one=$(fixture_patch_id "$REPO" "$SOURCE_ONE")
  patch_two_a=$(fixture_patch_id "$REPO" "$SOURCE_TWO_A")
  patch_two_b=$(fixture_patch_id "$REPO" "$SOURCE_TWO_B")
  if [ "$variant" = context-rebase ]; then
    contextual_source=$(git -C "$REPO" show --format= --full-index --binary --unified=3 "$SOURCE_ONE" |
      git patch-id --stable | awk '{print $1}')
    contextual_batch=$(git -C "$REPO" show --format= --full-index --binary --unified=3 "$BATCH_ONE" |
      git patch-id --stable | awk '{print $1}')
    [ "$contextual_source" != "$contextual_batch" ] || {
      echo "context-rebase fixture does not change ordinary diff context" >&2
      exit 1
    }
  fi
  batch_effect=compatible
  recorded_base_sha="$BASE_SHA"
  from_version=39
  to_version=39
  batch_required='["docs","host-integration","kernel-unit","posix"]'
  source_two_commits=$(jq -n \
    --arg source_a "$SOURCE_TWO_A" --arg batch_a "$BATCH_TWO_A" --arg patch_a "$patch_two_a" \
    --arg source_b "$SOURCE_TWO_B" --arg batch_b "$BATCH_TWO_B" --arg patch_b "$patch_two_b" \
    '[{source_sha:$source_a,batch_sha:$batch_a,patch_id:$patch_a},
      {source_sha:$source_b,batch_sha:$batch_b,patch_id:$patch_b}]')

  case "$variant" in
    ambiguous)
      source_two_commits=$(jq --arg duplicate "$patch_one" '.[0].patch_id = $duplicate' <<<"$source_two_commits")
      ;;
    wrong-patch)
      source_two_commits=$(jq '.[0].patch_id = "0000000000000000000000000000000000000000"' <<<"$source_two_commits")
      ;;
    validation-gap)
      batch_required='["docs","host-integration","kernel-unit"]'
      ;;
    bad-abi)
      batch_effect=none
      ;;
    wrong-abi-version)
      from_version=38
      to_version=38
      ;;
    wrong-base)
      recorded_base_sha="$BATCH_ONE"
      ;;
    valid|squash|base-drift|actual-abi-drift|prior-receipt-mutation|authority-change|whitespace-landed|context-rebase|moved-delta|changed-delta) ;;
    *) echo "unknown fixture variant $variant" >&2; exit 2 ;;
  esac

  mkdir -p "$REPO/.github/integration-batches"
  jq -n \
    --arg effect "$batch_effect" \
    --argjson required "$batch_required" \
    --arg base_sha "$recorded_base_sha" \
    --argjson from_version "$from_version" --argjson to_version "$to_version" \
    --arg source_one "$SOURCE_ONE" --arg batch_one "$BATCH_ONE" --arg patch_one "$patch_one" \
    --arg source_two_head "$SOURCE_TWO_B" --argjson source_two_commits "$source_two_commits" '
    {
      schema_version: 1,
      batch: {
        pull_request: 10,
        base_ref: "main",
        base_sha: $base_sha,
        merge_method: "rebase",
        abi: {effect: $effect, from_version: $from_version, to_version: $to_version},
        validation: {treatment: "broad-runtime", required: $required}
      },
      sources: [
        {
          pull_request: 1,
          head_sha: $source_one,
          head_ref: "fix/source-one",
          abi_effect: "compatible",
          required_validation: ["kernel-unit", "posix"],
          commits: [{source_sha:$source_one,batch_sha:$batch_one,patch_id:$patch_one}]
        },
        {
          pull_request: 2,
          head_sha: $source_two_head,
          head_ref: "fix/source-two",
          abi_effect: "none",
          required_validation: ["docs", "host-integration"],
          commits: $source_two_commits
        }
      ]
    }
  ' > "$REPO/.github/integration-batches/batch-10.json"
  git -C "$REPO" add .github/integration-batches/batch-10.json
  git -C "$REPO" commit --quiet -m 'ci: bind source fixes to integration batch'
  BATCH_HEAD=$(git -C "$REPO" rev-parse HEAD)

  mapfile -t BATCH_COMMITS < <(git -C "$REPO" rev-list --reverse "${BASE_SHA}..${BATCH_HEAD}")

  git -C "$REPO" push --quiet origin \
    "$SOURCE_ONE:refs/heads/fix/source-one" \
    "$SOURCE_TWO_B:refs/heads/fix/source-two" \
    "$BATCH_HEAD:refs/heads/integration/batch-10" \
    "$SOURCE_ONE:refs/pull/1/head" \
    "$SOURCE_TWO_B:refs/pull/2/head" \
    "$BATCH_HEAD:refs/pull/10/head" \
    "$BASE_SHA:refs/heads/main"

  git -C "$REPO" checkout --quiet main
  if [ "$variant" = squash ]; then
    git -C "$REPO" merge --quiet --squash integration/batch-10 >/dev/null
    git -C "$REPO" commit --quiet -m 'squashed batch'
  elif [ "$variant" = whitespace-landed ]; then
    git -C "$REPO" cherry-pick --quiet --no-commit "${BATCH_COMMITS[0]}" >/dev/null
    printf 'source  one\n' > "$REPO/source-one.txt"
    git -C "$REPO" add source-one.txt
    git -C "$REPO" commit --quiet -C "${BATCH_COMMITS[0]}"
    git -C "$REPO" cherry-pick --quiet "${BATCH_COMMITS[@]:1}" >/dev/null
  else
    if [ "$variant" = base-drift ]; then
      printf 'intervening default commit\n' > "$REPO/intervening.txt"
      git -C "$REPO" add intervening.txt
      git -C "$REPO" commit --quiet -m 'intervening default commit'
    fi
    git -C "$REPO" cherry-pick --quiet "${BATCH_COMMITS[@]}" >/dev/null
  fi
  MERGE_SHA=$(git -C "$REPO" rev-parse HEAD)
  git -C "$REPO" push --quiet --force origin "$MERGE_SHA:refs/heads/main"

  printf 'advance\n' > "$REPO/advance.txt"
  git -C "$REPO" add advance.txt
  git -C "$REPO" commit --quiet -m 'later default commit'
  ADVANCED_SHA=$(git -C "$REPO" rev-parse HEAD)
  git -C "$REPO" push --quiet origin "$ADVANCED_SHA:refs/heads/advanced-fixture"
  git -C "$REPO" reset --quiet --hard "$MERGE_SHA"

  jq -n --arg sha "$SOURCE_ONE" '
    {number:1,state:"open",merged:false,merged_at:null,merge_commit_sha:null,commits:1,
     head:{sha:$sha,ref:"fix/source-one",repo:{full_name:"example/repo"}},base:{ref:"main"}}
  ' > "$DATA/pr-1.json"
  jq -n --arg sha "$SOURCE_TWO_B" '
    {number:2,state:"open",merged:false,merged_at:null,merge_commit_sha:null,commits:2,
     head:{sha:$sha,ref:"fix/source-two",repo:{full_name:"example/repo"}},base:{ref:"main"}}
  ' > "$DATA/pr-2.json"
  jq -n --arg head "$BATCH_HEAD" --arg merge "$MERGE_SHA" --argjson count "${#BATCH_COMMITS[@]}" '
    {number:10,state:"closed",merged:true,merged_at:"2026-07-15T12:00:00Z",merge_commit_sha:$merge,commits:$count,
     head:{sha:$head,ref:"integration/batch-10",repo:{full_name:"example/repo"}},base:{ref:"main"}}
  ' > "$DATA/pr-10.json"
  jq -n --arg sha "$SOURCE_ONE" '[{sha:$sha}]' > "$DATA/commits-1.json"
  jq -n --arg a "$SOURCE_TWO_A" --arg b "$SOURCE_TWO_B" '[{sha:$a},{sha:$b}]' > "$DATA/commits-2.json"
  printf '%s\n' "${BATCH_COMMITS[@]}" | jq -R '{sha:.}' | jq -s . > "$DATA/commits-10.json"
  jq -n '[
    {id:1,context:"merge-gate",state:"success",created_at:"2026-07-15T11:00:00Z"},
    {id:2,context:"merge-gate",state:"failure",created_at:"2026-07-15T10:00:00Z"}
  ]' > "$DATA/status.json"

  cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_STUB_LOG"
[ "${1:-}" = api ] || exit 99
shift
include=false
method=GET
endpoint=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --include) include=true; shift ;;
    --method) method="$2"; shift 2 ;;
    -f|-F|-H) shift 2 ;;
    /repos/*) endpoint="$1"; shift ;;
    *) shift ;;
  esac
done
[ -n "$endpoint" ] || exit 98

emit() {
  if [ "$include" = true ]; then
    printf 'HTTP/2.0 200 OK\n\n'
  fi
  cat "$1"
}

case "$endpoint" in
  /repos/example/repo)
    if [ "$include" = true ]; then printf 'HTTP/2.0 200 OK\n\n'; fi
    printf '{"default_branch":"main"}\n'
    ;;
  /repos/example/repo/pulls\?state=open\&head=*\&per_page=100)
    query="${endpoint#*head=}"
    query="${query%&per_page=100}"
    head=$(jq -rn --arg value "$query" '$value | @urid')
    ref="${head#*:}"
    if [ "$ref" = fix/source-one ]; then pr=1; else pr=2; fi
    if [ "$(jq -r .state "$GH_STUB_DATA/pr-$pr.json")" = open ]; then
      jq -n --argjson pr "$pr" --arg ref "$ref" \
        '[{number:$pr,head:{ref:$ref,repo:{full_name:"example/repo"}}}]'
    else
      printf '[]\n'
    fi > "$GH_STUB_DATA/open-prs.tmp"
    if [ "${GH_STUB_SHARED_BRANCH_PR:-false}" = true ]; then
      jq --arg ref "$ref" '. + [{number:99,head:{ref:$ref,repo:{full_name:"example/repo"}}}]' \
        "$GH_STUB_DATA/open-prs.tmp"
    else
      cat "$GH_STUB_DATA/open-prs.tmp"
    fi
    ;;
  /repos/example/repo/pulls/[0-9]*)
    tail="${endpoint#/repos/example/repo/pulls/}"
    if [[ "$tail" == */commits\?* ]]; then
      pr="${tail%%/*}"
      page="${tail##*page=}"
      if [ "$page" = 1 ]; then cat "$GH_STUB_DATA/commits-$pr.json"; else printf '[]\n'; fi
      exit 0
    fi
    pr="${tail%%\?*}"
    file="$GH_STUB_DATA/pr-$pr.json"
    [ -f "$file" ] || exit 97
    if [ "$method" = PATCH ]; then
      jq '.state = "closed"' "$file" > "$file.tmp"
      mv "$file.tmp" "$file"
      printf 'close %s\n' "$pr" >> "$GH_STUB_MUTATIONS"
      if [ "$pr" = 1 ] && [ "${GH_STUB_RECREATE_BRANCH_AFTER_CLOSE:-false}" = true ]; then
        recreate_ref=$(jq -r .head.ref "$file")
        recreate_sha=$(jq -r .head.sha "$file")
        git --git-dir="$GH_STUB_REMOTE" update-ref "refs/heads/$recreate_ref" "$recreate_sha"
      fi
    fi
    if [ "$pr" = 10 ] && [ "${GH_STUB_BATCH_PROPOSED:-false}" = true ]; then
      jq '.state = "open" | .merged = false | .merged_at = null | .merge_commit_sha = null' "$file"
    elif [ "${GH_STUB_FORK_PR:-}" = "$pr" ]; then
      jq '.head.repo.full_name = "someone/fork"' "$file"
    elif [ "${GH_STUB_DRIFT_PR:-}" = "$pr" ]; then
      jq '.head.sha = "ffffffffffffffffffffffffffffffffffffffff"' "$file"
    else
      cat "$file"
    fi
    ;;
  /repos/example/repo/commits/*/statuses\?per_page=100\&page=*)
    page="${endpoint##*page=}"
    if [ "${GH_STUB_MERGE_GATE_FAIL:-false}" = true ]; then
      if [ "$page" = 1 ]; then jq '.[0].state = "failure"' "$GH_STUB_DATA/status.json"; else printf '[]\n'; fi
    else
      if [ "$page" = 1 ]; then cat "$GH_STUB_DATA/status.json"; else printf '[]\n'; fi
    fi
    if [ "${GH_STUB_ADVANCE_DEFAULT:-false}" = true ]; then
      git --git-dir="$GH_STUB_REMOTE" update-ref refs/heads/main "$GH_STUB_ADVANCED_SHA"
    fi
    ;;
  /repos/example/repo/branches/*)
    if [ "${GH_STUB_BRANCH_API_FAIL:-false}" = true ]; then
      [ "$include" = false ] || printf 'HTTP/2.0 500 Internal Server Error\n\n{}\n'
      exit 1
    fi
    encoded="${endpoint#/repos/example/repo/branches/}"
    ref=$(jq -rn --arg value "$encoded" '$value | @urid')
    if ! sha=$(git --git-dir="$GH_STUB_REMOTE" rev-parse --verify "refs/heads/$ref" 2>/dev/null); then
      [ "$include" = false ] || printf 'HTTP/2.0 404 Not Found\n\n{}\n'
      exit 1
    fi
    protected=false
    [ "${GH_STUB_PROTECTED_REF:-}" != "$ref" ] || protected=true
    if [ "$include" = true ]; then printf 'HTTP/2.0 200 OK\n\n'; fi
    jq -n --arg name "$ref" --arg sha "$sha" --argjson protected "$protected" \
      '{name:$name,commit:{sha:$sha},protected:$protected}'
    ;;
  *) exit 96 ;;
esac
EOF
  chmod +x "$BIN/gh"

  export PATH="$BIN:$ORIGINAL_PATH"
  export GITHUB_REPOSITORY=example/repo
  export GITHUB_DEFAULT_BRANCH=main
  export INTEGRATION_BATCH_RETRY_DELAY_SECONDS=0
  export GH_STUB_DATA="$DATA"
  export GH_STUB_LOG="$LOG"
  export GH_STUB_MUTATIONS="$MUTATIONS"
  export GH_STUB_REMOTE="$REMOTE"
  export GH_STUB_ADVANCED_SHA="$ADVANCED_SHA"
  unset GH_STUB_FORK_PR GH_STUB_DRIFT_PR GH_STUB_PROTECTED_REF GH_STUB_BRANCH_API_FAIL
  unset GH_STUB_MERGE_GATE_FAIL GH_STUB_ADVANCE_DEFAULT GH_STUB_SHARED_BRANCH_PR
  unset GH_STUB_RECREATE_BRANCH_AFTER_CLOSE
}

ORIGINAL_PATH="$PATH"

run_proposed() {
  if [ "${RUN_PROPOSED_PRESERVE_DEFAULT:-false}" != true ]; then
    git --git-dir="$REMOTE" update-ref refs/heads/main "$BASE_SHA"
  fi
  git -C "$REPO" checkout --quiet integration/batch-10
  (
    cd "$REPO"
    GH_STUB_BATCH_PROPOSED=true \
      bash "$FINALIZER" --manifest .github/integration-batches/batch-10.json --batch-pr 10 --mode proposed
  )
}

run_finalize() {
  git --git-dir="$REMOTE" update-ref refs/heads/main "$MERGE_SHA"
  git -C "$REPO" checkout --quiet main
  git -C "$REPO" reset --quiet --hard "$MERGE_SHA"
  (
    cd "$REPO"
    bash "$FINALIZER" --manifest .github/integration-batches/batch-10.json --batch-pr 10 --mode finalize "$@"
  )
}

expect_failure() {
  local pattern="$1"
  shift
  local output status
  set +e
  output=$("$@" 2>&1)
  status=$?
  set -e
  [ "$status" -ne 0 ] || {
    echo "expected failure matching '$pattern'" >&2
    exit 1
  }
  grep -Fq "$pattern" <<<"$output" || {
    echo "failure did not match '$pattern':" >&2
    echo "$output" >&2
    exit 1
  }
}

expect_success() {
  local pattern="$1"
  shift
  local output status
  set +e
  output=$("$@" 2>&1)
  status=$?
  set -e
  [ "$status" -eq 0 ] || {
    echo "expected success containing '$pattern':" >&2
    echo "$output" >&2
    exit 1
  }
  grep -Fq "$pattern" <<<"$output" || {
    echo "success output did not contain '$pattern':" >&2
    echo "$output" >&2
    exit 1
  }
}

make_fixture valid
expect_success 'Verified batch PR #10' run_proposed
expect_success 'Dry run only' run_finalize
[ ! -s "$MUTATIONS" ] || { echo "dry run mutated GitHub state" >&2; exit 1; }
git --git-dir="$REMOTE" rev-parse --verify refs/heads/fix/source-one >/dev/null

expect_success 'finalization complete' run_finalize --apply
[ "$(jq -r .state "$DATA/pr-1.json")" = closed ]
[ "$(jq -r .state "$DATA/pr-2.json")" = closed ]
! git --git-dir="$REMOTE" rev-parse --verify refs/heads/fix/source-one >/dev/null 2>&1
! git --git-dir="$REMOTE" rev-parse --verify refs/heads/fix/source-two >/dev/null 2>&1
expect_success 'finalization complete' run_finalize --apply

make_fixture context-rebase
expect_success 'Verified batch PR #10' run_proposed
expect_success 'Dry run only' run_finalize

make_fixture moved-delta
expect_failure 'is not an exact replay of source commit' run_proposed

make_fixture changed-delta
expect_failure 'is not patch-identical to source commit' run_proposed

make_fixture valid
export GH_STUB_RECREATE_BRANCH_AFTER_CLOSE=true
expect_failure 'reappeared during finalization' run_finalize --apply

make_fixture valid
export GH_STUB_DRIFT_PR=1
expect_failure 'no longer at its recorded head' run_proposed

make_fixture valid
git --git-dir="$REMOTE" update-ref refs/heads/main "$ADVANCED_SHA"
export RUN_PROPOSED_PRESERVE_DEFAULT=true
expect_failure 'not based on the current default-branch tip' run_proposed
unset RUN_PROPOSED_PRESERVE_DEFAULT

make_fixture valid
export GH_STUB_FORK_PR=2
expect_failure 'cross-repository' run_proposed

make_fixture valid
export GH_STUB_PROTECTED_REF=fix/source-one
expect_failure 'branch is protected' run_proposed

make_fixture valid
export GH_STUB_BRANCH_API_FAIL=true
expect_failure 'could not determine branch state' run_proposed

make_fixture valid
export GH_STUB_SHARED_BRANCH_PR=true
expect_failure 'shared by another open PR' run_proposed

make_fixture ambiguous
expect_failure 'manifest does not satisfy schema version 1' run_proposed

make_fixture wrong-patch
expect_failure 'patch ID changed' run_proposed

make_fixture validation-gap
expect_failure 'manifest does not satisfy schema version 1' run_proposed

make_fixture bad-abi
expect_failure 'manifest does not satisfy schema version 1' run_proposed

make_fixture wrong-abi-version
expect_failure 'does not match base ABI' run_proposed

make_fixture wrong-base
[ "$(jq -r .batch.base_sha "$REPO/.github/integration-batches/batch-10.json")" = "$BATCH_ONE" ]
git -C "$REPO" merge-base --is-ancestor "$BATCH_ONE" "$BATCH_HEAD"
expect_failure 'batch commit sequence is not linear from recorded base' run_finalize

make_fixture actual-abi-drift
expect_failure 'does not match batch ABI' run_proposed

make_fixture prior-receipt-mutation
expect_failure 'must add only its own immutable integration-batch receipt' run_proposed

make_fixture authority-change
expect_failure 'cannot change their validation authority' run_proposed

make_fixture squash
expect_failure 'cannot locate the landed batch span' run_finalize

make_fixture base-drift
expect_failure 'not recorded base' run_finalize

make_fixture whitespace-landed
expect_failure 'landed batch tree differs from the reviewed batch head' run_finalize

make_fixture valid
export GH_STUB_MERGE_GATE_FAIL=true
expect_failure 'does not have a latest successful merge-gate status' run_finalize

make_fixture valid
export GH_STUB_ADVANCE_DEFAULT=true
expect_failure 'default branch advanced during finalization validation' run_finalize

# Workflow contracts: proposed verification is read-only; finalization is
# maintainer-triggered, default-branch-only, and dry-run by default.
grep -Fq 'pull_request_target:' "$WORKFLOW_VERIFY"
! grep -Eq '^  pull_request:$' "$WORKFLOW_VERIFY"
grep -Fq 'HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}' "$WORKFLOW_VERIFY"
grep -Fq 'persist-credentials: false' "$WORKFLOW_VERIFY"
grep -Fq 'permissions:' "$WORKFLOW_VERIFY"
! grep -Fq 'contents: write' "$WORKFLOW_VERIFY"
grep -Fq 'Integration batch receipts are append-only' "$WORKFLOW_VERIFY"
grep -Fq 'git worktree add --quiet --detach "$trusted_worktree" "$trusted_base"' "$WORKFLOW_VERIFY"
grep -Fq '"$trusted_worktree/.github/scripts/finalize-integration-batch.sh"' "$WORKFLOW_VERIFY"
grep -Fq 'workflow_dispatch:' "$WORKFLOW_FINALIZE"
grep -Fq 'default: dry-run' "$WORKFLOW_FINALIZE"
grep -Fq "github.ref_name == github.event.repository.default_branch" "$WORKFLOW_FINALIZE"
grep -Fq -- '--mode finalize' "$WORKFLOW_FINALIZE"
grep -Fq 'args+=(--apply)' "$WORKFLOW_FINALIZE"

echo "integration batch finalizer tests passed"
