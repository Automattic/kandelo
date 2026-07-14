#!/usr/bin/env bash
# shellcheck disable=SC2016 # This test searches workflow/script source literals.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
PREPARE="$REPO_ROOT/.github/workflows/prepare-merge.yml"
ACTIVATE_WORKFLOW="$REPO_ROOT/.github/workflows/activate-merge-candidate.yml"
REJECTED_RECOVERY_WORKFLOW="$REPO_ROOT/.github/workflows/recover-rejected-merge-candidate.yml"
ACTIVATE_SCRIPT="$SCRIPT_DIR/activate-merge-candidate.sh"
REJECTED_RECOVERY_SCRIPT="$SCRIPT_DIR/clone-rejected-merge-candidate.sh"
RECONCILE_SCRIPT="$SCRIPT_DIR/reconcile-merge-candidates.sh"
CLEANUP_SCRIPT="$SCRIPT_DIR/cleanup-merge-candidates.sh"
APPROVAL_SCRIPT="$SCRIPT_DIR/require-exact-head-approval.sh"
MARK_READY_SCRIPT="$SCRIPT_DIR/mark-merge-candidate-ready.sh"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-merge-candidate.sh"
STATUS_SCRIPT="$SCRIPT_DIR/latest-merge-gate-status.sh"
RECOVERY_SCRIPT="$SCRIPT_DIR/recover-canonical-indexes.sh"
CLEANUP_WORKFLOW="$REPO_ROOT/.github/workflows/staging-cleanup.yml"
STAGING_WORKFLOW="$REPO_ROOT/.github/workflows/staging-build.yml"
FORCE_REBUILD_WORKFLOW="$REPO_ROOT/.github/workflows/force-rebuild.yml"
INDEX_STATE_SCRIPT="$REPO_ROOT/scripts/release-index-state.sh"
INDEX_UPDATE_SCRIPT="$REPO_ROOT/scripts/index-update.sh"
ARCHIVE_SOURCE_SCRIPT="$SCRIPT_DIR/select-package-archive-source.sh"
ARCHIVE_DOWNLOAD_SCRIPT="$SCRIPT_DIR/download-verified-release-asset.sh"
STAGING_REUSE_SCRIPT="$SCRIPT_DIR/validate-staging-release.sh"
STAGING_COMPOSE_SCRIPT="$SCRIPT_DIR/compose-staging-release-snapshots.sh"

fail() {
  echo "merge-candidate workflow contract: $*" >&2
  exit 1
}

job_block() {
  local workflow="$1"
  local job="$2"
  awk -v job="$job" '
    $0 == "  " job ":" { inside = 1 }
    inside && /^  [a-zA-Z0-9_-]+:/ && $0 != "  " job ":" { exit }
    inside { print }
  ' "$workflow"
}

step_run_block() {
  local workflow="$1"
  local step="$2"
  awk -v step="$step" '
    $0 == "      - name: " step { in_step = 1; next }
    in_step && $0 == "        run: |" { in_run = 1; next }
    in_run && /^      - name:/ { exit }
    in_run {
      line = $0
      sub(/^          /, "", line)
      print line
    }
  ' "$workflow"
}

step_block() {
  local workflow="$1"
  local step="$2"
  awk -v step="$step" '
    $0 == "      - name: " step { in_step = 1 }
    in_step && $0 ~ /^      - name:/ && $0 != "      - name: " step { exit }
    in_step { print }
  ' "$workflow"
}

assert_job_needs() {
  local workflow="$1"
  local job="$2"
  local dependency="$3"
  local block
  local needs
  # Capture the complete block before matching. Piping job_block into an
  # early-exiting grep can SIGPIPE awk under pipefail on larger jobs.
  block=$(job_block "$workflow" "$job")
  needs=$(grep -m1 '^    needs:' <<<"$block")
  printf '%s\n' "$needs" | tr '[],' '   ' | grep -qw "$dependency" || \
    fail "$job must depend on $dependency; got $needs"
}

assert_effective_job_permission() {
  local workflow="$1"
  local job="$2"
  local permission="$3"
  local value="$4"
  local block

  block="$(job_block "$workflow" "$job")"
  if grep -q '^    permissions:' <<<"$block"; then
    grep -Eq "^      ${permission}: ${value}([[:space:]]|$)" <<<"$block" ||
      fail "$(basename "$workflow") job $job overrides permissions without $permission: $value"
    return
  fi

  awk -v permission="$permission" -v value="$value" '
    /^permissions:/ { inside = 1; next }
    /^jobs:/ { exit }
    inside && $0 ~ "^  " permission ": " value "([[:space:]]|$)" { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$workflow" ||
    fail "$(basename "$workflow") job $job must inherit $permission: $value"
}

if ! grep -Fq 'TARGET_TAG="merge-candidate-abi-v${ABI}-pr-' "$PREPARE"; then
  fail "Prepare merge does not target a unique merge-candidate release"
fi
if grep -Eq -- '--target-tag[[:space:]]+"?binaries-abi-v' "$PREPARE"; then
  fail "Prepare merge still has a pre-merge canonical index writer"
fi

index_writer_count=$(grep -c 'bash scripts/index-update.sh' "$PREPARE")
candidate_target_count=$(grep -c -- '--target-tag "${{ needs.preflight.outputs.target_tag }}"' "$PREPARE")
if [ "$index_writer_count" -ne "$candidate_target_count" ]; then
  fail "not every Prepare merge index writer targets the isolated candidate ($index_writer_count writers, $candidate_target_count candidate targets)"
fi

assert_job_needs "$PREPARE" preflight gate
assert_job_needs "$PREPARE" promote-staging preflight
assert_job_needs "$PREPARE" lib-matrix-build preflight
assert_job_needs "$PREPARE" matrix-build preflight
assert_job_needs "$PREPARE" merge-gate-post test-gate

synthesize_job=$(job_block "$PREPARE" synthesize-merge)
synthesize_step=$(step_run_block "$PREPARE" "Capture base and synthesize PR merge")
preflight_job=$(job_block "$PREPARE" preflight)
preflight_step=$(step_run_block "$PREPARE" "Compute matrix")
grep -Fq 'pr_commit_count: ${{ steps.synthesize.outputs.pr_commit_count }}' <<<"$synthesize_job" || \
  fail "synthesize-merge must export the full-history PR commit count"
grep -Fq 'PR_COMMIT_COUNT=$(git rev-list --count "$BASE_SHA..$PR_HEAD_SHA")' <<<"$synthesize_step" || \
  fail "synthesize-merge must count PR commits while both full histories are present"
grep -Fq 'echo "pr_commit_count=$PR_COMMIT_COUNT"' <<<"$synthesize_step" || \
  fail "synthesize-merge must publish the computed PR commit count"
grep -Fq 'SYNTH_PR_COMMIT_COUNT: ${{ needs.synthesize-merge.outputs.pr_commit_count }}' <<<"$preflight_job" || \
  fail "candidate initialization must consume the synthesized PR commit count"
grep -Fq 'PR_COMMIT_COUNT="$SYNTH_PR_COMMIT_COUNT"' <<<"$preflight_step" || \
  fail "candidate initialization must carry the count through the isolated dev shell"
if grep -Fq 'git rev-list --count "$MERGE_BASE_SHA..$MERGE_HEAD_SHA"' <<<"$preflight_step"; then
  fail "candidate initialization must not recount commits from the shallow preflight checkout"
fi

count_fixture=$(mktemp -d)
trap 'rm -rf "$count_fixture"' EXIT
git init --quiet --initial-branch=main "$count_fixture"
git -C "$count_fixture" config user.name fixture
git -C "$count_fixture" config user.email fixture@example.com
git -C "$count_fixture" commit --quiet --allow-empty -m base
git -C "$count_fixture" switch --quiet -c feature
for commit in one two three; do
  git -C "$count_fixture" commit --quiet --allow-empty -m "feature-$commit"
done
fixture_head=$(git -C "$count_fixture" rev-parse HEAD)
git -C "$count_fixture" switch --quiet main
for commit in one two; do
  git -C "$count_fixture" commit --quiet --allow-empty -m "main-$commit"
done
fixture_base=$(git -C "$count_fixture" rev-parse HEAD)
count_assignment=$(grep -F 'PR_COMMIT_COUNT=$(git rev-list --count "$BASE_SHA..$PR_HEAD_SHA")' <<<"$synthesize_step")
fixture_count=$(
  cd "$count_fixture"
  BASE_SHA="$fixture_base" PR_HEAD_SHA="$fixture_head" \
    bash -c "$count_assignment; printf '%s\\n' \"\$PR_COMMIT_COUNT\""
)
[ "$fixture_count" = 3 ] || \
  fail "full-history synthesis counted $fixture_count commits for a three-commit PR behind main"

grep -Fq 'select-package-archive-source.sh' "$PREPARE" || \
  fail "Prepare merge must prefer an existing canonical cache-key asset"
grep -Fq 'download-verified-release-asset.sh' "$PREPARE" || \
  fail "Prepare merge must verify snapshotted source asset bytes before promotion"
grep -Fq 'ARCHIVE_NAME: ${{ matrix.archive_name }}' "$PREPARE" || \
  fail "Prepare merge must pass the selected archive name through the environment"
grep -Fq 'SOURCE_TAG: ${{ matrix.source_tag }}' "$PREPARE" || \
  fail "Prepare merge must pass the selected source release through the environment"
grep -Fq -- '--tag "$SOURCE_TAG"' "$PREPARE" || \
  fail "Prepare merge promotion must download from the selected source release"
grep -Fq -- '--asset "$ARCHIVE_NAME"' "$PREPARE" || \
  fail "Prepare merge promotion must download the selected archive without shell interpolation"
grep -Fq 'if select_match "$CANONICAL_ASSETS" canonical' "$ARCHIVE_SOURCE_SCRIPT" || \
  fail "canonical cache-key bytes must take precedence over PR staging bytes"
grep -Fq 'actual_sha256' "$ARCHIVE_DOWNLOAD_SCRIPT" || \
  fail "source archive promotion must verify the snapshotted sha256"

# Every job whose call graph reaches state-lock acquire needs Actions read
# access. Without it, a later run cannot prove that an abandoned lock's
# owning workflow is terminal and recovery waits forever. Keep the discovered
# caller set explicit so adding a writer workflow cannot silently escape this
# permissions contract.
expected_lock_callers=$(cat <<'EOF'
activate-merge-candidate.yml:activate
force-rebuild.yml:lib-matrix-build
force-rebuild.yml:matrix-build
prepare-merge.yml:lib-matrix-build
prepare-merge.yml:matrix-build
prepare-merge.yml:merge-gate-post
prepare-merge.yml:preflight
prepare-merge.yml:promote-staging
recover-rejected-merge-candidate.yml:recover
reusable-homebrew-bottle-maintenance.yml:rebuild
reusable-homebrew-bottle-maintenance.yml:rollback
reusable-homebrew-bottle-publish.yml:finalize-tap
reusable-package-source-publish.yml:publish
staging-build.yml:lib-matrix-build
staging-build.yml:matrix-build
staging-build.yml:repair-staging-index
staging-cleanup.yml:sweep
EOF
)
actual_lock_callers=$(
  awk '
    FNR == 1 {
      workflow = FILENAME
      sub(/^.*\//, "", workflow)
      in_jobs = 0
      job = ""
    }
    /^jobs:/ { in_jobs = 1; next }
    in_jobs && /^  [a-zA-Z0-9_-]+:/ {
      job = $1
      sub(/:$/, "", job)
    }
    in_jobs && job != "" {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (line ~ /^#/) next
      if (line ~ /reusable-homebrew-bottle-publish\.yml/ ||
          (line ~ /bash[[:space:]]/ &&
           line ~ /(state-lock|index-update|compose-initial-index|publish-package-source|homebrew-publish-sidecars|fetch-canonical-index|init-merge-candidate|mark-merge-candidate-ready|recover-canonical-indexes|cleanup-merge-candidates|activate-merge-candidate|clone-rejected-merge-candidate)\.sh/)) {
        print workflow ":" job
      }
    }
  ' "$WORKFLOWS_DIR"/*.yml | sort -u
)
if [ "$actual_lock_callers" != "$expected_lock_callers" ]; then
  diff -u <(printf '%s\n' "$expected_lock_callers") \
    <(printf '%s\n' "$actual_lock_callers") >&2 || true
  fail "state-lock workflow caller audit is stale"
fi
while IFS=: read -r workflow job; do
  assert_effective_job_permission "$WORKFLOWS_DIR/$workflow" "$job" actions read
done <<<"$actual_lock_callers"

grep -Fq 'require-exact-head-approval.sh' "$PREPARE" || \
  fail "Prepare merge must require exact-head authorization"
grep -Fq 'ref: ${{ needs.synthesize-merge.outputs.base_sha }}' "$PREPARE" || \
  fail "authorization verification must execute trusted prepared-base code"
grep -Fq 'READY_TO_SHIP_ACTOR: ${{ github.event.sender.login }}' "$PREPARE" || \
  fail "maintainer attestation must use the labeled-event sender"
grep -Fq -- '--label-actor "$READY_TO_SHIP_ACTOR"' "$PREPARE" || \
  fail "Prepare merge must pass the labeled-event sender to the trusted verifier"
grep -Fq 'review_decision" != "APPROVED"' "$APPROVAL_SCRIPT" || \
  fail "approval verifier must preserve aggregate review semantics"
grep -Fq 'maintain|admin)' "$APPROVAL_SCRIPT" || \
  fail "maintainer attestation must require maintain or admin permission"
grep -Fq 'require_current_head "maintainer attestation"' "$APPROVAL_SCRIPT" || \
  fail "maintainer attestation must recheck the exact live head"
grep -Fq '/reviews?per_page=100' "$APPROVAL_SCRIPT" || \
  fail "approval verifier must fetch exact reviews with pagination"
grep -Fq '.commit_id == $head' "$APPROVAL_SCRIPT" || \
  fail "approval verifier must bind approval to the tested head"
grep -Eq 'push\|write\|maintain\|admin' "$APPROVAL_SCRIPT" || \
  fail "approval verifier must require a repository-qualified reviewer"
if grep -Fq 'gh pr merge' "$PREPARE" || \
   grep -Fq 'dispatch-candidate-activation:' "$PREPARE" || \
   grep -Fq 'gh workflow run activate-merge-candidate.yml' "$PREPARE"
then
  fail "Prepare merge must not merge PRs or dispatch activation before merge"
fi

merge_gate=$(job_block "$PREPARE" merge-gate-post)
grep -Fq 'mark-merge-candidate-ready.sh' <<<"$merge_gate" || \
  fail "merge-gate must seal and publish candidate authority"
grep -Fq 'candidate_index_sha256: ${{ steps.candidate_index.outputs.sha256 }}' "$PREPARE" || \
  fail "test preparation must export the exact candidate index digest"
grep -Fq 'candidate_index_sha256: ${{ steps.gate.outputs.candidate_index_sha256 }}' "$PREPARE" || \
  fail "test gate must carry the exact candidate index digest to sealing"
grep -Fq -- '--candidate-index-sha256 "${{ needs.test-gate.outputs.candidate_index_sha256 }}"' <<<"$merge_gate" || \
  fail "merge-gate must seal only the index digest captured before tests"
grep -Fq 'candidate index differs from the tested sha256' "$MARK_READY_SCRIPT" || \
  fail "candidate helper must reject a ledger other than the tested digest"
materialize_candidate_step=$(step_run_block "$PREPARE" "Materialize binaries")
grep -Fq 'mv "$index_dir/index.toml" "$index_dir/source-index.toml"' \
  <<<"$materialize_candidate_step" || \
  fail "test preparation must freeze candidate index bytes before resolution"
grep -Fq 'sha256sum "$index_dir/source-index.toml"' <<<"$materialize_candidate_step" || \
  fail "test preparation must hash the immutable source candidate index"
grep -Fq 'index-candidate seed' <<<"$materialize_candidate_step" || \
  fail "test preparation must derive a resolver view from the frozen source index"
grep -Fq 'WASM_POSIX_BINARY_INDEX_URL="file://$index_dir/index.toml"' \
  <<<"$materialize_candidate_step" || \
  fail "test preparation must resolve every package from the frozen local index"
snapshot_line=$(grep -n 'mv "$index_dir/index.toml" "$index_dir/source-index.toml"' \
  <<<"$materialize_candidate_step" | cut -d: -f1)
resolver_line=$(grep -n 'fetch-binaries.sh --fetch-only' \
  <<<"$materialize_candidate_step" | cut -d: -f1)
if [ "$snapshot_line" -ge "$resolver_line" ]; then
  fail "candidate index capture must precede binary materialization"
fi
if grep -Fq -- '- name: Capture tested candidate index' "$PREPARE"; then
  fail "candidate index must not be recaptured from mutable release state after materialization"
fi
grep -Fq 'current merge-gate authority changed' "$MARK_READY_SCRIPT" || \
  fail "candidate recovery authority replacement must be compare-and-swap"
grep -Fq 'default branch changed after recovery validation' "$MARK_READY_SCRIPT" || \
  fail "candidate recovery must recheck the validated default tip before authority mutation"
grep -Fq '/statuses/${EXPECTED_HEAD_SHA}' "$MARK_READY_SCRIPT" || \
  fail "candidate helper must publish status while its authority lock is held"
grep -Fq 'releases/tag/${CANDIDATE_TAG}' "$MARK_READY_SCRIPT" || \
  fail "merge-gate status must identify the exact candidate release"
ready_upload_line=$(grep -n 'gh release upload "$CANDIDATE_TAG"' "$MARK_READY_SCRIPT" | cut -d: -f1)
default_recheck_line=$(grep -n 'git fetch --no-tags origin' "$MARK_READY_SCRIPT" | cut -d: -f1)
authority_recheck_line=$(grep -n 'current_authority_url=' "$MARK_READY_SCRIPT" | cut -d: -f1)
status_post_line=$(grep -n '"/repos/${REPOSITORY}/statuses/${EXPECTED_HEAD_SHA}"' \
  "$MARK_READY_SCRIPT" | cut -d: -f1)
if [ "$ready_upload_line" -ge "$authority_recheck_line" ] ||
   [ "$authority_recheck_line" -ge "$default_recheck_line" ] ||
   [ "$default_recheck_line" -ge "$status_post_line" ]; then
  fail "recovery default and authority CAS checks must follow sealing and precede status mutation"
fi

grep -Fq 'workflow_dispatch:' "$REJECTED_RECOVERY_WORKFLOW" || \
  fail "rejected candidate recovery must be manual"
if grep -Eq '^  (pull_request|push|schedule):' "$REJECTED_RECOVERY_WORKFLOW"; then
  fail "rejected candidate recovery must not have an automatic trigger"
fi
grep -Fq "if: github.ref_type == 'branch' && github.ref_name == github.event.repository.default_branch" \
  "$REJECTED_RECOVERY_WORKFLOW" || \
  fail "rejected candidate recovery must run only from the exact default branch, not a same-named tag"
grep -Fq 'ref: ${{ github.event.repository.default_branch }}' "$REJECTED_RECOVERY_WORKFLOW" || \
  fail "rejected candidate recovery must execute current default-branch code"
grep -Fq 'fetch-depth: 0' "$REJECTED_RECOVERY_WORKFLOW" || \
  fail "rejected candidate recovery requires complete git history"
recovery_clone_step=$(step_run_block "$REJECTED_RECOVERY_WORKFLOW" "Clone exact rejected candidate bytes")
grep -Fq 'bash scripts/dev-shell.sh env' <<<"$recovery_clone_step" || \
  fail "rejected candidate recovery must cross the clean dev-shell boundary explicitly"
grep -Fq 'GITHUB_DEFAULT_BRANCH="$GITHUB_DEFAULT_BRANCH"' <<<"$recovery_clone_step" || \
  fail "rejected candidate recovery must preserve the checked default branch across dev-shell"
if ! bash -n <<<"$recovery_clone_step"; then
  fail "rejected candidate recovery clone step is not valid nested shell syntax"
fi
grep -Fq 'clone-rejected-merge-candidate.sh' "$REJECTED_RECOVERY_WORKFLOW" || \
  fail "rejected candidate recovery must use the tested immutable clone helper"
grep -Fq 'activate-merge-candidate.sh' "$REJECTED_RECOVERY_WORKFLOW" || \
  fail "recovered candidates must use the existing activation path"
grep -Fq -- '--expected-default-ref "${{ steps.clone.outputs.validated_default_ref }}"' \
  "$REJECTED_RECOVERY_WORKFLOW" || \
  fail "recovered activation must carry the validated default branch"
grep -Fq -- '--expected-default-sha "${{ steps.clone.outputs.validated_default_sha }}"' \
  "$REJECTED_RECOVERY_WORKFLOW" || \
  fail "recovered activation must carry the validated default revision"
grep -Fq 'default branch changed after recovery validation' "$ACTIVATE_SCRIPT" || \
  fail "recovered activation must recheck the validated default tip before canonical planning"
canonical_lock_line=$(grep -n 'acquire "$CANONICAL_TAG"' "$ACTIVATE_SCRIPT" | cut -d: -f1)
activation_authority_line=$(grep -n 'authority_url=$(MERGE_GATE_STATUS' "$ACTIVATE_SCRIPT" | cut -d: -f1)
activation_default_line=$(grep -n 'git fetch --no-tags origin' "$ACTIVATE_SCRIPT" | tail -1 | cut -d: -f1)
canonical_read_line=$(grep -n 'ensure_release "$CANONICAL_TAG"' "$ACTIVATE_SCRIPT" | cut -d: -f1)
if [ "$canonical_lock_line" -ge "$activation_authority_line" ] ||
   [ "$activation_authority_line" -ge "$activation_default_line" ] ||
   [ "$activation_default_line" -ge "$canonical_read_line" ]; then
  fail "recovered activation must check authority and default after locking and before canonical access"
fi
if grep -Eq '(ci-run-test-suite|build-programs|archive-stage|index-update\.sh|force-rebuild)' "$REJECTED_RECOVERY_WORKFLOW"; then
  fail "immutable recovery must not rerun runtime gates or package builds"
fi
for evidence in \
  'prepared-commit-count-mismatch' \
  '/actions/runs/${SOURCE_RUN_ID}' \
  'conclusion == "success"' \
  'gh run download "$SOURCE_RUN_ID"' \
  'git bundle verify' \
  'git rev-list --count "$base_sha..$head_sha"' \
  'git rev-parse "$merge_commit_sha^{tree}"' \
  'source candidate ABI $ABI is not current platform ABI $platform_abi' \
  'checked-out platform revision is not the current default-branch tip' \
  'default branch advanced during recovery validation' \
  '--mode current' \
  '--materialize' \
  'source asset inventory changed during validation' \
  'current merge-gate authority is not this source or its recovery clone' \
  'RESUME_EXISTING_CLONE=1' \
  'authoritative recovery clone changed during validation' \
  '--expected-current-authority-url "$source_authority_url"' \
  '--expected-default-ref "$DEFAULT_BRANCH"' \
  '--expected-default-sha "$CHECKED_OUT_SHA"'
do
  grep -Fq -- "$evidence" "$REJECTED_RECOVERY_SCRIPT" || \
    fail "rejected candidate recovery lacks required evidence check: $evidence"
done
if grep -Eq '(rm|gh release delete).*(rejected|SOURCE_CANDIDATE_TAG)' "$REJECTED_RECOVERY_SCRIPT"; then
  fail "rejected candidate recovery must preserve source rejection evidence"
fi
recovery_authority_lock=$(grep -n 'acquire "merge-authority-pr-${PR_NUMBER}"' "$REJECTED_RECOVERY_SCRIPT" | head -1 | cut -d: -f1)
recovery_source_lock=$(grep -n 'acquire "$SOURCE_CANDIDATE_TAG"' "$REJECTED_RECOVERY_SCRIPT" | head -1 | cut -d: -f1)
recovery_destination_lock=$(grep -n 'acquire "$DESTINATION_CANDIDATE_TAG"' "$REJECTED_RECOVERY_SCRIPT" | head -1 | cut -d: -f1)
if [ "$recovery_authority_lock" -ge "$recovery_source_lock" ] ||
   [ "$recovery_source_lock" -ge "$recovery_destination_lock" ]; then
  fail "recovery lock order must be authority, rejected source, immutable destination"
fi
grep -Fq 'find "$bundle_dir" -type f -name synthesized-merge.bundle -print > "$bundle_list"' \
  "$REJECTED_RECOVERY_SCRIPT" || \
  fail "recovery must check source bundle discovery before consuming its list"
if grep -Fq 'mapfile -t bundles < <(find ' "$REJECTED_RECOVERY_SCRIPT"; then
  fail "recovery must not mask source bundle discovery failures with process substitution"
fi
grep -Fq 'jq -c '\''.[]'\'' "$asset_plan" > "$asset_plan_jsonl"' "$ACTIVATE_SCRIPT" || \
  fail "activation must materialize the complete asset plan with checked jq status"
if grep -Fq 'done < <(jq -c '\''.[]'\'' "$asset_plan")' "$ACTIVATE_SCRIPT"; then
  fail "activation must not consume an unchecked partial asset-plan stream"
fi
grep -Fq "del(.merge_commit_sha, .canonical_index_sha256, .activated_at, .activation_run)" \
  "$ACTIVATE_SCRIPT" || \
  fail "activation idempotency must preserve every ready-marker identity field"
grep -Fq 'candidate_identity=$(jq -S -c . "$CANDIDATE_JSON")' "$VERIFY_SCRIPT" || \
  fail "candidate verification must preserve recovery and future identity fields"
grep -Fq "ready_identity=\$(jq -S -c 'del(.candidate_index_sha256, .ready_at)'" \
  "$VERIFY_SCRIPT" || \
  fail "ready verification must compare its full candidate identity"
grep -Fq '.recovery.kind == "immutable-clone-v1"' "$VERIFY_SCRIPT" || \
  fail "candidate verification must validate recovery provenance schema"

grep -Fq 'types: [closed]' "$ACTIVATE_WORKFLOW" || \
  fail "activation workflow lacks the post-merge closed-event fast path"
grep -Fq 'schedule:' "$ACTIVATE_WORKFLOW" || \
  fail "activation workflow lacks durable scheduled reconciliation"
grep -Fq 'workflow_dispatch:' "$ACTIVATE_WORKFLOW" || \
  fail "activation workflow lacks manual reconciliation"
grep -Fq 'ref: ${{ github.event.repository.default_branch }}' "$ACTIVATE_WORKFLOW" || \
  fail "activation workflow must run the current default-branch protocol"
grep -Fq 'github.ref_name == github.event.repository.default_branch' "$ACTIVATE_WORKFLOW" || \
  fail "manual reconciliation must be dispatched from the default branch"
grep -Fq 'canonical_tag:' "$ACTIVATE_WORKFLOW" || \
  fail "manual reconciliation lacks an exact canonical recovery target"
grep -Fq 'recover-canonical-indexes.sh' "$ACTIVATE_WORKFLOW" || \
  fail "scheduled/manual reconciliation lacks canonical transaction recovery"
recovery_step_line=$(grep -n 'name: Recover canonical index transactions' "$ACTIVATE_WORKFLOW" | cut -d: -f1)
discovery_step_line=$(grep -n 'name: Discover merged ready candidates' "$ACTIVATE_WORKFLOW" | cut -d: -f1)
if [ "$recovery_step_line" -ge "$discovery_step_line" ]; then
  fail "canonical recovery must run before candidate discovery"
fi
recovery_block=$(sed -n "${recovery_step_line},$((discovery_step_line - 1))p" "$ACTIVATE_WORKFLOW")
grep -Fq "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" <<<"$recovery_block" || \
  fail "canonical recovery must run on every schedule/manual invocation"
if grep -Fq 'has_candidates' <<<"$recovery_block"; then
  fail "canonical recovery must not depend on candidate discovery"
fi
grep -Fq 'reconcile-merge-candidates.sh' "$ACTIVATE_WORKFLOW" || \
  fail "activation workflow does not discover ready unactivated candidates"
grep -Fq 'activate-merge-candidate.sh' "$ACTIVATE_WORKFLOW" || \
  fail "activation workflow does not invoke the activation transaction"
grep -Fq 'failed=1' "$ACTIVATE_WORKFLOW" || \
  fail "reconciliation must continue after one candidate activation fails"
if grep -Fq -- '--wait-seconds' "$ACTIVATE_WORKFLOW" || \
   grep -Fq -- '--wait-seconds' "$ACTIVATE_SCRIPT"
then
  fail "post-merge activation must not wait on an unmerged PR"
fi

grep -Fq '/releases?per_page=${PER_PAGE}&page=${page}' "$RECONCILE_SCRIPT" || \
  fail "scheduled reconciliation must use explicit bounded release pagination"
grep -Fq 'release scan reached the ${MAX_PAGES}-page safety bound' "$RECONCILE_SCRIPT" || \
  fail "reconciliation must fail rather than silently truncate its scan"
grep -Fq 'grep -Fxq ready.json "$asset_names"' "$RECONCILE_SCRIPT" || \
  fail "reconciliation must require a sealed ready candidate"
grep -Fq 'grep -Fxq activated.json "$asset_names"' "$RECONCILE_SCRIPT" || \
  fail "reconciliation must skip candidates with activation receipts"
grep -Fq 'grep -Fxq rejected.json "$asset_names"' "$RECONCILE_SCRIPT" || \
  fail "reconciliation must skip candidates with terminal rejection receipts"
grep -Fq '/releases/${release_id}/assets?per_page=${ASSET_PER_PAGE}&page=${page}' "$RECONCILE_SCRIPT" || \
  fail "candidate readiness discovery must paginate release assets"
grep -Fq 'latest_gate_target "$head_sha"' "$RECONCILE_SCRIPT" || \
  fail "reconciliation must bind discovery to the latest merge-gate status"
grep -Fq 'git rev-list --first-parent' "$RECONCILE_SCRIPT" || \
  fail "reconciliation must order merges from default-branch first-parent history"
grep -Fq '/statuses?per_page=${PER_PAGE}&page=${page}' "$STATUS_SCRIPT" || \
  fail "merge-gate authority lookup must use bounded status pagination"
grep -Fq 'limiting this run to $MAX_CANDIDATES' "$RECONCILE_SCRIPT" || \
  fail "scheduled reconciliation must bound activation work per run"
grep -Fq '/releases?per_page=${PER_PAGE}&page=${page}' "$RECOVERY_SCRIPT" || \
  fail "canonical recovery must use bounded release pagination"
grep -Fq '/releases/${release_id}/assets?per_page=${ASSET_PER_PAGE}&page=${page}' "$RECOVERY_SCRIPT" || \
  fail "canonical recovery must use bounded asset pagination"
grep -Fq 'bash "$RELEASE_INDEX_STATE_SCRIPT" recover' "$RECOVERY_SCRIPT" || \
  fail "canonical recovery must delegate journal repair to release-index-state"
grep -Fq 'bash "$STATE_LOCK_SCRIPT" acquire "$tag"' "$RECOVERY_SCRIPT" || \
  fail "canonical recovery must hold the canonical tag lock"

authority_lock_line=$(grep -n 'acquire "merge-authority-pr-${PR_NUMBER}"' "$ACTIVATE_SCRIPT" | cut -d: -f1)
candidate_lock_line=$(grep -n 'acquire "$CANDIDATE_TAG"' "$ACTIVATE_SCRIPT" | cut -d: -f1)
canonical_lock_line=$(grep -n 'acquire "$CANONICAL_TAG"' "$ACTIVATE_SCRIPT" | cut -d: -f1)
verify_line=$(grep -n 'bash "$VERIFY_SCRIPT"' "$ACTIVATE_SCRIPT" | tail -1 | cut -d: -f1)
plan_line=$(grep -n 'index-candidate activate' "$ACTIVATE_SCRIPT" | cut -d: -f1)
copy_line=$(grep -n 'copy_candidate_asset "$name"' "$ACTIVATE_SCRIPT" | cut -d: -f1)
index_upload_line=$(grep -n 'bash "$RELEASE_INDEX_STATE_SCRIPT" publish' "$ACTIVATE_SCRIPT" | cut -d: -f1)

if [ "$authority_lock_line" -ge "$candidate_lock_line" ] || [ "$candidate_lock_line" -ge "$canonical_lock_line" ]; then
  fail "activation lock order must be authority, candidate, canonical"
fi
if [ "$verify_line" -ge "$plan_line" ]; then
  fail "exact merged identity must be verified before planning activation"
fi
if [ "$copy_line" -ge "$index_upload_line" ]; then
  fail "all inert candidate archives must be copied before the canonical index"
fi
canonical_verify_line=$(grep -n 'verify_canonical_asset "$name"' "$ACTIVATE_SCRIPT" | cut -d: -f1)
if [ "$canonical_verify_line" -ge "$index_upload_line" ]; then
  fail "retained canonical assets must be verified before the canonical index"
fi
if [ "$(grep -c 'index-candidate activate' "$ACTIVATE_SCRIPT")" -ne 1 ]; then
  fail "activation must compute one multi-key canonical transaction"
fi
if grep -Fq -- '--clobber' "$ACTIVATE_SCRIPT" ||
   awk '
     /gh release upload/ { upload = 1 }
     upload && /--clobber/ { found = 1 }
     upload && $0 !~ /\\$/ { upload = 0 }
     END { exit(found ? 0 : 1) }
   ' "$INDEX_STATE_SCRIPT"
then
  fail "canonical activation must not delete-before-upload index.toml"
fi
grep -Fq 'bash "$RELEASE_INDEX_STATE_SCRIPT" publish' "$INDEX_UPDATE_SCRIPT" || \
  fail "ordinary canonical writers must share the crash-recoverable publisher"
grep -Fq 'kandelo-index-transaction-v1-' "$INDEX_STATE_SCRIPT" || \
  fail "canonical publisher must persist a recovery journal before renaming"

# A retry can skip matrix builds only after one complete PR-staging release is
# validated. The post-matrix gate must then freeze fresh current bytes locally;
# first/partial runs retain the canonical + local-overlay path.
grep -Fq 'reuse_staging: ${{ steps.compute.outputs.reuse_staging }}' "$STAGING_WORKFLOW" || \
  fail "staging preflight must expose its release-reuse decision"
grep -Fq -- '--mode structural' "$STAGING_WORKFLOW" || \
  fail "staging preflight must validate complete target-release structure"
grep -Fq 'validated target/canonical union did not cover the computed matrix' "$STAGING_WORKFLOW" || \
  fail "staging preflight must prove full current coverage before emptying the matrix"
grep -Fq 'PACKAGE_REUSE_STAGING: ${{ needs.preflight.outputs.reuse_staging }}' "$STAGING_WORKFLOW" || \
  fail "test-gate must consume the preflight reuse decision"
materialize_step=$(step_block "$STAGING_WORKFLOW" "Materialize binaries")
grep -Fq 'GH_TOKEN: ${{ github.token }}' <<<"$materialize_step" || \
  fail "staging materialization must authenticate release snapshot reads"
grep -Fq "needs.preflight.outputs.reuse_staging == 'false'" "$STAGING_WORKFLOW" || \
  fail "reused staging runs must not download absent matrix artifacts"
grep -Fq -- '--mode current' "$STAGING_WORKFLOW" || \
  fail "test-gate must freshly prove the staging ledger is fully current"
grep -Fq -- '--materialize' "$STAGING_WORKFLOW" || \
  fail "test-gate must freeze verified staging archive bytes locally"
grep -Fq 'compose-staging-release-snapshots.sh' "$STAGING_WORKFLOW" || \
  fail "test-gate must delegate final local snapshot placement"
grep -Fq 'staging-reuse compose' "$STAGING_COMPOSE_SCRIPT" || \
  fail "test-gate must compose the validated target and canonical supplement structurally"
grep -Fq 'archive basename collision with different bytes' "$STAGING_COMPOSE_SCRIPT" || \
  fail "staging union must reject conflicting same-name bytes"
grep -Fq "printf 'file://%s/index.toml\\n' \"\$OUTPUT_DIR/archives\" > \"\$OUTPUT_DIR/index-url.txt\"" "$STAGING_COMPOSE_SCRIPT" || \
  fail "target-only reuse must rewrite its file URL after final placement"
grep -Fq 'elif [ "$PACKAGE_STAGE_OVERLAYS_REQUIRED" = "true" ]' "$STAGING_WORKFLOW" || \
  fail "non-reuse test-gate must retain canonical + local matrix overlays"
grep -Fq 'gh api --paginate --slurp' "$STAGING_REUSE_SCRIPT" || \
  fail "staging release validation must not truncate release assets"
grep -Fq '$TAG/index.toml bytes changed after metadata snapshot' "$STAGING_REUSE_SCRIPT" || \
  fail "staging release validation must bind index bytes to its metadata snapshot"
grep -Fq 'download-verified-release-asset.sh' "$STAGING_REUSE_SCRIPT" || \
  fail "staging materialization must verify every snapshotted archive"
grep -Fq 'cp "$TMP_ROOT/index.toml" "$TMP_ROOT/archives/index.toml"' "$STAGING_REUSE_SCRIPT" || \
  fail "staging materialization must publish the localized index beside verified archives"
for step in "Compute matrix" "Materialize binaries"; do
  if ! step_run_block "$STAGING_WORKFLOW" "$step" | bash -n; then
    fail "staging workflow step $step is not valid nested shell syntax"
  fi
done

grep -Fq 'cleanup-merge-candidates.sh' "$CLEANUP_WORKFLOW" || \
  fail "staging cleanup must delegate candidate lifecycle to the tested helper"
cleanup_sweep=$(job_block "$CLEANUP_WORKFLOW" sweep)
for helper in cleanup-merge-candidates.sh github-api-get.sh latest-merge-gate-status.sh state-lock.sh; do
  grep -Fq ".github/scripts/$helper" <<<"$cleanup_sweep" || \
    fail "staging cleanup sparse checkout lacks $helper"
done
grep -Fq 'PR #$pr state is unavailable' "$CLEANUP_SCRIPT" || \
  fail "cleanup must retain a candidate when PR state lookup fails"
grep -Fq 'if [ "$state" = open ]' "$CLEANUP_SCRIPT" || \
  fail "cleanup must retain every candidate while its PR is open"
grep -Fq 'superseded or non-authoritative merged candidate' "$CLEANUP_SCRIPT" || \
  fail "cleanup must remove stale attempts after merge"
grep -Fq 'retaining rejected evidence' "$CLEANUP_SCRIPT" || \
  fail "cleanup must retain recent terminal rejection evidence"
grep -Fq 'acquire "merge-authority-pr-${pr}"' "$CLEANUP_SCRIPT" || \
  fail "cleanup must hold PR authority while reclassifying candidates"
grep -Fq 'acquire "$tag"' "$CLEANUP_SCRIPT" || \
  fail "cleanup must hold the candidate lock before deletion"

echo "merge candidate workflow contract tests passed"
