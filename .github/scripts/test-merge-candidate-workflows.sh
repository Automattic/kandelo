#!/usr/bin/env bash
# shellcheck disable=SC2016 # This test searches workflow/script source literals.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
PREPARE="$REPO_ROOT/.github/workflows/prepare-merge.yml"
ABI_STAGING_MERGE_GATE="$REPO_ROOT/.github/workflows/abi-staging-merge-gate.yml"
ACTIVATE_WORKFLOW="$REPO_ROOT/.github/workflows/activate-merge-candidate.yml"
PAGES_WORKFLOW="$REPO_ROOT/.github/workflows/browser-demos-pages.yml"
REJECTED_RECOVERY_WORKFLOW="$REPO_ROOT/.github/workflows/recover-rejected-merge-candidate.yml"
ACTIVATE_SCRIPT="$SCRIPT_DIR/activate-merge-candidate.sh"
REJECTED_RECOVERY_SCRIPT="$SCRIPT_DIR/clone-rejected-merge-candidate.sh"
RECONCILE_SCRIPT="$SCRIPT_DIR/reconcile-merge-candidates.sh"
CLEANUP_SCRIPT="$SCRIPT_DIR/cleanup-merge-candidates.sh"
DELETE_RELEASE_SCRIPT="$SCRIPT_DIR/delete-writable-release.sh"
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
  needs=$(awk '
    /^    needs:/ {
      inside = 1
      print
      next
    }
    inside && /^    [a-zA-Z0-9_-]+:/ { exit }
    inside { print }
  ' <<<"$block")
  grep -Eq "(^|[^[:alnum:]_-])${dependency}([^[:alnum:]_-]|$)" <<<"$needs" ||
    fail "$job must depend on $dependency; got $(tr '\n' ' ' <<<"$needs")"
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

! grep -Fq 'verify-public-homebrew-bottle-mirror.mjs' \
  "$ACTIVATE_WORKFLOW" ||
  fail "scheduled workflow must not duplicate the 48 MiB candidate mirror gate"
grep -Fq '.github/scripts/activate-merge-candidate.sh' \
  "$ACTIVATE_WORKFLOW" ||
  fail "workflow must route new canonical transactions through activation"
script_mirror_gate_line="$(grep -nF \
  'verify-public-homebrew-bottle-mirror.mjs' "$ACTIVATE_SCRIPT" | \
  tail -1 | cut -d: -f1)"
script_canonical_mutation_line="$(grep -nF \
  'ensure_release "$CANONICAL_TAG"' "$ACTIVATE_SCRIPT" | \
  tail -1 | cut -d: -f1)"
[ "$script_mirror_gate_line" -lt "$script_canonical_mutation_line" ] ||
  fail "direct activation must verify the public mirror before canonical mutation"
grep -Fq "contains(github.event.pull_request.labels.*.name, 'preserve-head-commit') && 'merge'" \
  "$PREPARE" || fail "Prepare merge does not select merge-commit verification for preserve-head-commit"
grep -Fq 'batched-changes and preserve-head-commit are mutually exclusive' "$PREPARE" || \
  fail "Prepare merge does not reject conflicting history-method labels"
grep -Fq 'expected_parents="$base_sha $head_sha"' "$VERIFY_SCRIPT" || \
  fail "merge-commit activation does not bind the exact prepared base and head parents"

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

[[ -f $ABI_STAGING_MERGE_GATE ]] ||
  fail "protected exact-head ABI staging merge-evidence workflow is absent"
grep -Fq 'pull_request_target:' "$ABI_STAGING_MERGE_GATE" ||
  fail "ABI staging merge evidence is not loaded from the protected branch"
if grep -Eq '^  pull_request:' "$ABI_STAGING_MERGE_GATE"; then
  fail "ABI staging merge evidence must not use a PR-controlled workflow definition"
fi
protected_structure_job=$(job_block \
  "$ABI_STAGING_MERGE_GATE" abi-staging-exact-head-structure)
protected_structure_step=$(step_run_block \
  "$ABI_STAGING_MERGE_GATE" "Run uncredentialed exact-head structural ABI check")
protected_provenance_step=$(step_run_block \
  "$ABI_STAGING_MERGE_GATE" \
  "Validate current request and locate protected Check provenance")
protected_final_step=$(step_run_block \
  "$ABI_STAGING_MERGE_GATE" \
  "Reproject and validate protected Check provenance")
assert_job_needs "$ABI_STAGING_MERGE_GATE" \
  abi-staging-exact-head-structure capture-current-subject
assert_job_needs "$ABI_STAGING_MERGE_GATE" \
  validate-current-evidence abi-staging-exact-head-structure
grep -Fq 'contents: read' <<<"$protected_structure_job" ||
  fail "candidate structural ABI job must remain read-only"
grep -Fq 'env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_RUNTIME_TOKEN' \
  <<<"$protected_structure_step" ||
  fail "candidate structural ABI code must not receive workflow credentials"
grep -Fq 'kandelo-structural-abi-report' <<<"$protected_structure_step" ||
  fail "candidate structural ABI job must emit the canonical bounded report"
for exact_gate_contract in \
  '--previous-abi' \
  'structural-report validate' \
  'request derive' \
  'filter=all' \
  '.details_url' \
  '.app.slug == "github-actions"' \
  '.path == ".github/workflows/abi-staging-pr-check.yml@main"' \
  '/actions/runs/$run_id/artifacts' \
  '.workflow_run.id == $run_id' \
  '.workflow_run.head_sha == $protected' \
  '[.[].artifacts[]][0]' \
  'abi-staging-pr-check-$run_id-$PR_NUMBER-$PR_HEAD_SHA'
do
  grep -Fq -- "$exact_gate_contract" <<<"$protected_provenance_step" ||
    fail "protected ABI gate lacks exact provenance contract: $exact_gate_contract"
done
for exact_projection_contract in \
  'check-projection project' \
  'cmp -s' \
  'published_conclusion == "success"' \
  'computed_conclusion == "success"'
do
  grep -Fq "$exact_projection_contract" <<<"$protected_final_step" ||
    fail "protected ABI gate lacks projection contract: $exact_projection_contract"
done
if grep -Fq 'SYNTHETIC_MERGE_SHA' "$ABI_STAGING_MERGE_GATE" ||
   grep -Fq 'needs.synthesize-merge.outputs.merge_sha' "$ABI_STAGING_MERGE_GATE"
then
  fail "synthetic merge identity must not satisfy protected ABI staging evidence"
fi
if grep -Eq '(bash|source|\.)[[:space:]]+[^[:space:]]*abi-staging-exact-head' \
    <<<"$protected_provenance_step$protected_final_step"
then
  fail "protected gate must treat the exact head as inert input"
fi

# A published fixed PR tag cannot be repaired after repository release
# immutability is enabled. Every full rerun therefore owns a new tag, while a
# failed-job retry keeps using the draft selected by its successful preflight.
grep -Fq \
  'pr-${{ github.event.pull_request.number }}-staging-run-${GITHUB_RUN_ID}-attempt-${GITHUB_RUN_ATTEMPT}' \
  "$STAGING_WORKFLOW" || \
  fail "staging workflow must isolate every full rerun in a new release"
staging_writer_count="$(
  grep -Ec 'bash (scripts/dev-shell.sh bash )?scripts/index-update.sh' \
    "$STAGING_WORKFLOW"
)"
staging_target_count="$(
  grep -Fc -- \
    '--release-target-commit "${{ github.event.pull_request.head.sha }}"' \
    "$STAGING_WORKFLOW"
)"
[ "$staging_writer_count" -eq "$staging_target_count" ] ||
  fail "every staging index writer must bind its release to the PR head"
for selection_contract in \
  'select(.target_commitish == \$head)' \
  'select(.draft == false and .immutable == true' \
  'kandelo-package-release-seal-v1.json' \
  'sort_by(.created_at) | last | .tag_name // \"\"' \
  'STAGING_TAG="pr-${{ github.event.pull_request.number }}-staging"'
do
  grep -Fq "$selection_contract" "$PREPARE" || \
    fail "Prepare merge lacks exact-head staging selection: $selection_contract"
done

synthesize_job=$(job_block "$PREPARE" synthesize-merge)
synthesize_step=$(step_run_block "$PREPARE" "Capture base and synthesize PR merge")
preflight_job=$(job_block "$PREPARE" preflight)
preflight_step=$(step_run_block "$PREPARE" "Compute matrix")
for workflow_step in "$preflight_step" \
  "$(step_run_block "$STAGING_WORKFLOW" "Compute matrix")"
do
  grep -Fq 'staging-reuse expected' <<<"$workflow_step" ||
    fail "package matrices must derive from the Rust expected ledger"
  grep -Fq 'done < <(jq -c ".entries[]" "$expected_ledger")' <<<"$workflow_step" ||
    fail "package matrices must iterate only expected-ledger entries"
  if grep -Fq 'compute-cache-key-sha --package "$pkg_dir"' <<<"$workflow_step"; then
    fail "package matrices must not bypass publication policy with a raw registry scan"
  fi
done

staging_preflight_job="$(job_block "$STAGING_WORKFLOW" preflight)"
staging_compute_step="$(step_run_block "$STAGING_WORKFLOW" "Compute matrix")"
grep -Fq 'stages_node_vfs: ${{ steps.compute.outputs.stages_node_vfs }}' \
  <<<"$staging_preflight_job" ||
  fail "staging preflight must expose exact wasm32 node-vfs membership"
grep -Fq 'any(.[]; .package == \"node-vfs\" and .arch == \"wasm32\")' \
  <<<"$staging_compute_step" ||
  fail "staging preflight must derive Node acceptance from the sealed matrix"
if grep -q '^  homebrew-main-shell-proof:' "$STAGING_WORKFLOW"; then
  fail "ordinary PR staging must not invoke the retired lazy-shell proof lane"
fi
staging_shell_gate="$(job_block "$STAGING_WORKFLOW" homebrew-main-shell-gate)"
grep -Fq 'name: exact current lazy shell (Node + Chromium)' \
  <<<"$staging_shell_gate" ||
  fail "staging must retain the historical required-check display name"
grep -Fq 'homebrew-main-shell-prerequisites' <<<"$staging_shell_gate" &&
  grep -Fq 'TEST_GATE_RESULT' <<<"$staging_shell_gate" ||
  fail "the historical shell aggregate must consume the generic package test gate"
staged_node_acceptance="$(
  step_run_block "$STAGING_WORKFLOW" \
    "Run exact staged Node npm acceptance"
)"
grep -Fq "npx playwright test test/kandelo-node.spec.ts" \
  <<<"$staged_node_acceptance" &&
  grep -Fq 'activate-ci-test-workspace.sh' \
    <<<"$staged_node_acceptance" &&
  grep -Fq 'recover-homebrew-bottle-mirror.ts' \
    <<<"$staged_node_acceptance" &&
  grep -Fq 'programs/homebrew-bootstrap/homebrew-bootstrap.zip' \
    <<<"$staged_node_acceptance" &&
  grep -Fq 'KANDELO_NODE_LOCAL_BOOT_ASSET_ROOT' \
    <<<"$staged_node_acceptance" &&
  grep -Fq 'KANDELO_NODE_LOCAL_PROXY_PORT' \
    <<<"$staged_node_acceptance" &&
  grep -Fq -- "--grep '@node-npm-acceptance'" \
    <<<"$staged_node_acceptance" &&
  grep -Fq -- '--project=chromium' <<<"$staged_node_acceptance" ||
  fail "staged node-vfs must run the exact slow npm/cowsay acceptance"
grep -Fq 'stages_node_vfs: ${{ steps.compute.outputs.stages_node_vfs }}' \
  <<<"$preflight_job" ||
  fail "prepare preflight must expose exact wasm32 node-vfs membership"
grep -Fq 'any(.[]; .package == \"node-vfs\" and .arch == \"wasm32\")' \
  <<<"$preflight_step" ||
  fail "prepare preflight must derive Node acceptance from its exact matrices"
grep -Fq 'echo "stages_node_vfs=false" >> "$GITHUB_OUTPUT"' \
  <<<"$preflight_step" ||
  fail "non-staging prepare runs must close the Node acceptance output"
prepare_test_suite=$(job_block "$PREPARE" test-suite)
grep -Fq 'needs: [synthesize-merge, change-scope, preflight, test-gate-prepare]' \
  <<<"$prepare_test_suite" ||
  fail "prepare test suites must consume the exact package matrix"
grep -Fq 'STAGES_NODE_VFS: ${{ needs.preflight.outputs.stages_node_vfs }}' \
  <<<"$prepare_test_suite" ||
  fail "prepare browser acceptance must receive exact node-vfs membership"
candidate_node_acceptance="$(
  step_run_block "$PREPARE" \
    "Build and run exact candidate Node npm acceptance"
)"
for evidence in \
  'activate-ci-test-workspace.sh' \
  'recover-homebrew-bottle-mirror.ts' \
  'programs/homebrew-bootstrap/homebrew-bootstrap.zip' \
  'npm run build' \
  'verify-browser-shell-vfs-asset.sh' \
  'KANDELO_NODE_VFS_STRICT' \
  'KANDELO_NODE_VFS_SHA256' \
  'KANDELO_NODE_LOCAL_BOOT_ASSET_ROOT' \
  'KANDELO_NODE_LOCAL_PROXY_PORT' \
  'KANDELO_PLAYWRIGHT_SERVE_DIST' \
  'KANDELO_TEST_BASE_URL' \
  'npx playwright test test/kandelo-node.spec.ts'
do
  grep -Fq "$evidence" <<<"$candidate_node_acceptance" ||
    fail "candidate Node production acceptance lacks: $evidence"
done
grep -Fq -- "--grep '@node-npm-acceptance'" \
  <<<"$candidate_node_acceptance" ||
  fail "candidate Node production acceptance lacks the stable selector"
pages_node_acceptance="$(
  step_run_block "$PAGES_WORKFLOW" "Run exact Pages Node npm acceptance"
)"
grep -Fq 'KANDELO_NODE_VFS_SHA256' <<<"$pages_node_acceptance" ||
  fail "Pages Node acceptance must verify the resolved Node image digest"
grep -Fq -- "--grep '@node-npm-acceptance'" <<<"$pages_node_acceptance" ||
  fail "Pages Node acceptance must use the stable selector"
NODE_ACCEPTANCE_SPEC="$REPO_ROOT/apps/browser-demos/test/kandelo-node.spec.ts"
grep -Fq 'KANDELO_NODE_VFS_SHA256' "$NODE_ACCEPTANCE_SPEC" ||
  fail "Node acceptance must bind the fetched VFS bytes"
grep -Fq 'KANDELO_TEST_BASE_URL' "$NODE_ACCEPTANCE_SPEC" ||
  fail "Node acceptance must navigate through the deployed base path"
grep -Fq '@node-npm-acceptance' "$NODE_ACCEPTANCE_SPEC" ||
  fail "Node acceptance must expose its stable workflow selector"
grep -Fq 'if (localBootAssetRoot) {' "$NODE_ACCEPTANCE_SPEC" ||
  fail "Node acceptance must scope controlled-proxy assertions to its fixture"
if grep -Fq 'test.skip(true, "Required binary not built' "$NODE_ACCEPTANCE_SPEC"; then
  fail "Node acceptance must fail closed when production assets are missing"
fi
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

# GitHub increments github.run_attempt for both full workflow reruns and
# "rerun failed jobs." In the latter case a successful preflight job is not
# rerun: its candidate tag, candidate.json, and outputs still belong to the
# original attempt. Keep that preflight-owned identity all the way through
# sealing instead of consulting the later job's global attempt number.
grep -Fq 'candidate_run_attempt: ${{ steps.compute.outputs.candidate_run_attempt }}' \
  <<<"$preflight_job" || \
  fail "preflight must export the attempt that owns the candidate"
grep -Fq 'candidate_release_id: ${{ steps.compute.outputs.candidate_release_id }}' \
  <<<"$preflight_job" || \
  fail "preflight must export the exact draft release ID"
grep -Fq -- '--release-id-file "$candidate_release_id_file"' \
  <<<"$preflight_step" || \
  fail "candidate initialization must return its exact draft release ID"
grep -Fq 'echo "candidate_release_id=$candidate_release_id"' \
  <<<"$preflight_step" || \
  fail "preflight must publish the exact candidate release ID"
grep -Fq 'CANDIDATE_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT"' <<<"$preflight_step" || \
  fail "candidate creation must capture the current attempt in preflight"
grep -Fq 'echo "candidate_run_attempt=$CANDIDATE_RUN_ATTEMPT"' <<<"$preflight_step" || \
  fail "preflight must publish the captured candidate attempt"
grep -Fq 'attempt-${CANDIDATE_RUN_ATTEMPT}"' <<<"$preflight_step" || \
  fail "candidate tag must use the captured preflight attempt"
grep -Fq -- '--run-attempt "$CANDIDATE_RUN_ATTEMPT"' <<<"$preflight_step" || \
  fail "candidate metadata must use the captured preflight attempt"

candidate_attempt_capture=$(printf '%s\n' "$preflight_step" | grep -E \
  '^[[:space:]]*(CANDIDATE_RUN_ATTEMPT="\$GITHUB_RUN_ATTEMPT"|echo "candidate_run_attempt=\$CANDIDATE_RUN_ATTEMPT" >> "\$GITHUB_OUTPUT")$')
capture_candidate_attempt() {
  local current_attempt="$1"
  local output
  output=$(mktemp)
  GITHUB_RUN_ATTEMPT="$current_attempt" GITHUB_OUTPUT="$output" \
    bash -c "$candidate_attempt_capture"
  sed -n 's/^candidate_run_attempt=//p' "$output"
  rm -f "$output"
}

initial_attempt=$(capture_candidate_attempt 1)
full_rerun_attempt=$(capture_candidate_attempt 2)
[ "$initial_attempt" = 1 ] || \
  fail "initial preflight must own candidate attempt 1"
[ "$full_rerun_attempt" = 2 ] || \
  fail "a full rerun must create a candidate owned by attempt 2"

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
force-rebuild.yml:matrix-build-level-0
force-rebuild.yml:matrix-build-level-1
force-rebuild.yml:matrix-build-level-2
force-rebuild.yml:matrix-build-level-3
force-rebuild.yml:matrix-build-level-4
force-rebuild.yml:matrix-build-level-5
force-rebuild.yml:matrix-build-level-6
force-rebuild.yml:matrix-build-level-7
prepare-merge.yml:lib-matrix-build
prepare-merge.yml:matrix-build
prepare-merge.yml:merge-gate-post
prepare-merge.yml:preflight
prepare-merge.yml:promote-staging
recover-rejected-merge-candidate.yml:recover
reusable-homebrew-bottle-maintenance.yml:rebuild
reusable-homebrew-bottle-maintenance.yml:rollback
reusable-homebrew-bottle-publish.yml:finalize-tap
reusable-homebrew-bottle-publish.yml:plan
reusable-package-source-publish.yml:publish
staging-build.yml:lib-matrix-build
staging-build.yml:matrix-build
staging-build.yml:repair-staging-index
staging-build.yml:test-gate
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
          line ~ /exact-main-package-rebuild/ ||
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
  if [ "$workflow:$job" = "activate-merge-candidate.yml:activate" ]; then
    # Canonical activation is the only state-lock caller that must dispatch a
    # downstream workflow after moving an index.
    assert_effective_job_permission \
      "$WORKFLOWS_DIR/$workflow" "$job" actions write
  else
    assert_effective_job_permission \
      "$WORKFLOWS_DIR/$workflow" "$job" actions read
  fi
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
grep -Fq 'CANDIDATE_RUN_ATTEMPT: ${{ needs.preflight.outputs.candidate_run_attempt }}' \
  <<<"$merge_gate" || \
  fail "merge-gate must consume the attempt exported by candidate preflight"
grep -Fq -- '--run-attempt "$CANDIDATE_RUN_ATTEMPT"' <<<"$merge_gate" || \
  fail "merge-gate must seal the preflight-owned candidate attempt"
if grep -Fq -- '--run-attempt "${{ github.run_attempt }}"' <<<"$merge_gate"; then
  fail "merge-gate must not substitute the failed-job rerun attempt while sealing"
fi

# A failed-job rerun increments the global attempt to 2 but reuses the output
# from the already-successful attempt-1 preflight. The workflow wiring above
# makes that stored output authoritative. A full rerun executes preflight and
# therefore supplies the newly captured attempt-2 output instead.
failed_job_rerun_global_attempt=2
failed_job_rerun_seal_attempt="$initial_attempt"
full_rerun_seal_attempt="$full_rerun_attempt"
[ "$failed_job_rerun_global_attempt" = 2 ] && \
  [ "$failed_job_rerun_seal_attempt" = 1 ] || \
  fail "failed-job rerun must preserve its original candidate attempt"
[ "$full_rerun_seal_attempt" = 2 ] || \
  fail "full rerun must seal the candidate created by its new preflight"
grep -Fq 'ref: ${{ needs.synthesize-merge.outputs.base_sha }}' <<<"$merge_gate" || \
  fail "write-authorized merge-gate helpers must come from the exact prepared base"
if grep -Fq 'ref: ${{ needs.synthesize-merge.outputs.head_sha }}' <<<"$merge_gate"; then
  fail "write-authorized merge-gate helpers must not come from the pull request head"
fi
grep -Fq 'candidate_index_sha256: ${{ steps.candidate_index.outputs.sha256 }}' "$PREPARE" || \
  fail "test preparation must export the exact candidate index digest"
grep -Fq 'candidate_index_sha256: ${{ steps.gate.outputs.candidate_index_sha256 }}' "$PREPARE" || \
  fail "test gate must carry the exact candidate index digest to sealing"
grep -Fq -- '--candidate-index-sha256 "${{ needs.test-gate.outputs.candidate_index_sha256 }}"' <<<"$merge_gate" || \
  fail "merge-gate must seal only the index digest captured before tests"
grep -Fq 'candidate index differs from the tested sha256' "$MARK_READY_SCRIPT" || \
  fail "candidate helper must reject a ledger other than the tested digest"
materialize_candidate_step=$(step_run_block "$PREPARE" "Materialize binaries")
candidate_snapshot_step=$(step_run_block "$PREPARE" "Snapshot exact candidate draft")
test_gate_prepare_job=$(job_block "$PREPARE" test-gate-prepare)
candidate_snapshot_job=$(job_block "$PREPARE" candidate-snapshot)
assert_effective_job_permission "$PREPARE" candidate-snapshot contents write
assert_effective_job_permission "$PREPARE" test-gate-prepare contents read
if grep -Fq 'actions/checkout@' <<<"$candidate_snapshot_job"; then
  fail "write-authorized candidate snapshot must not check out PR code"
fi
grep -Fq 'persist-credentials: false' <<<"$test_gate_prepare_job" || \
  fail "candidate test job must not persist its checkout credential"
if grep -Fq 'GH_TOKEN: ${{ github.token }}' \
    <<<"$materialize_candidate_step"; then
  fail "synthetic candidate materialization must not receive the draft token"
fi
if ! bash -n <<<"$candidate_snapshot_step"; then
  fail "exact candidate snapshot step is not valid shell syntax"
fi
grep -Fq 'name: merge-candidate-${{ needs.preflight.outputs.candidate_release_id }}' \
  <<<"$candidate_snapshot_job" || \
  fail "write-authorized candidate snapshot must publish an exact-ID artifact"
grep -Fq 'name: merge-candidate-${{ needs.preflight.outputs.candidate_release_id }}' \
  <<<"$test_gate_prepare_job" || \
  fail "read-only candidate tests must consume the exact-ID artifact"
grep -Fq '/releases/${CANDIDATE_RELEASE_ID}' \
  <<<"$candidate_snapshot_step" || \
  fail "test preparation must read the draft through its exact release ID"
grep -Fq '/releases/assets/${asset_id}' <<<"$candidate_snapshot_step" || \
  fail "test preparation must download draft assets through exact asset IDs"
grep -Fq 'candidate release changed while it was snapshotted' \
  <<<"$candidate_snapshot_step" || \
  fail "test preparation must reject a candidate that changes during capture"
grep -Fq '.base_index_sha256' <<<"$candidate_snapshot_step" || \
  fail "candidate snapshot must bind its canonical base index"
grep -Fq 'metadata_base_sha=' <<<"$candidate_snapshot_step" || \
  fail "candidate snapshot must bind its base index to release metadata"
if grep -Fq 'gh release download "$PACKAGE_TARGET_TAG"' \
    <<<"$materialize_candidate_step"; then
  fail "test preparation must not resolve a draft through its hidden tag"
fi
grep -Fq 'mv "$index_dir/index.toml" "$index_dir/source-index.toml"' \
  <<<"$materialize_candidate_step" || \
  fail "test preparation must freeze candidate index bytes before resolution"
grep -Fq 'sha256sum "$index_dir/source-index.toml"' <<<"$materialize_candidate_step" || \
  fail "test preparation must hash the immutable source candidate index"
grep -Fq 'cp -R "$RUNNER_TEMP/candidate-release/." "$index_dir/"' \
  <<<"$materialize_candidate_step" || \
  fail "test preparation must keep draft archives beside the frozen index"
bind_canonical_step=$(step_run_block "$PREPARE" "Bind candidate canonical base index")
grep -Fq '.base_index_sha256' <<<"$bind_canonical_step" || \
  fail "candidate base index must remain bound to candidate identity"
grep -Fq 'sha256sum "$base_index"' <<<"$bind_canonical_step" || \
  fail "candidate base index must be verified before synthetic checkout"
grep -Fq 'echo "sha256=$actual_sha"' <<<"$bind_canonical_step" || \
  fail "candidate base index must export its closed handoff digest"
snapshot_canonical_block=$(step_block "$PREPARE" "Snapshot canonical index with trusted base")
snapshot_canonical_step=$(step_run_block "$PREPARE" "Snapshot canonical index with trusted base")
grep -Fq 'GH_TOKEN: ${{ github.token }}' <<<"$snapshot_canonical_block" || \
  fail "trusted canonical snapshot must receive the read token explicitly"
grep -Fq 'scripts/release-index-state.sh snapshot' <<<"$snapshot_canonical_step" || \
  fail "non-package tests must snapshot canonical state before synthetic checkout"
grep -Fq 'echo "sha256=$canonical_sha"' <<<"$snapshot_canonical_step" || \
  fail "public canonical snapshot must export its closed handoff digest"
grep -Fq -- '--authenticated-snapshot' <<<"$materialize_candidate_step" || \
  fail "synthetic tests must consume the credential-free canonical snapshot"
grep -Fq 'verify_canonical_source' <<<"$materialize_candidate_step" || \
  fail "synthetic tests must recheck canonical bytes after candidate code runs"
grep -Fq 'AUTHENTICATED_CANONICAL_INDEX_SHA256:' \
  <<<"$(step_block "$PREPARE" "Materialize binaries")" || \
  fail "synthetic tests must receive the trusted step-output digest"
if grep -Fq 'GH_TOKEN:' <<<"$(step_block "$PREPARE" "Materialize binaries")"; then
  fail "synthetic materialization must not receive a GitHub token"
fi
test_gate_checkout_line=$(grep -nF -- '- name: Checkout synthesized PR merge' \
  <<<"$test_gate_prepare_job" | cut -d: -f1)
bind_canonical_line=$(grep -nF -- '- name: Bind candidate canonical base index' \
  <<<"$test_gate_prepare_job" | cut -d: -f1)
snapshot_canonical_line=$(grep -nF -- '- name: Snapshot canonical index with trusted base' \
  <<<"$test_gate_prepare_job" | cut -d: -f1)
if [ "$bind_canonical_line" -ge "$test_gate_checkout_line" ] ||
   [ "$snapshot_canonical_line" -ge "$test_gate_checkout_line" ]; then
  fail "canonical bytes must be captured before synthetic code is checked out"
fi
grep -Fq 'WASM_POSIX_BINARY_INDEX_URL="file://$CANONICAL_INDEX"' \
  <<<"$materialize_candidate_step" || \
  fail "non-package resolution must reuse the trusted canonical snapshot"
grep -Fq 'WASM_POSIX_BINARY_INDEX_URL="file://$index_dir/source-index.toml"' \
  <<<"$materialize_candidate_step" || \
  fail "test preparation must resolve every package from the frozen local index"
snapshot_line=$(grep -n 'mv "$index_dir/index.toml" "$index_dir/source-index.toml"' \
  <<<"$materialize_candidate_step" | cut -d: -f1)
resolver_line=$(grep -n -- '--expected-ledger "$EXPECTED"' \
  <<<"$materialize_candidate_step" | cut -d: -f1)
if [ "$snapshot_line" -ge "$resolver_line" ]; then
  fail "candidate index capture must precede binary materialization"
fi
if grep -Fq -- '- name: Capture tested candidate index' "$PREPARE"; then
  fail "candidate index must not be recaptured from mutable release state after materialization"
fi
homebrew_guest_block=$(step_block "$PREPARE" "Prove Homebrew starts from candidate artifacts")
homebrew_guest_step=$(step_run_block "$PREPARE" "Prove Homebrew starts from candidate artifacts")
grep -Fq "if: env.PACKAGE_STAGING_REQUIRED == 'true'" <<<"$homebrew_guest_block" || \
  fail "candidate-backed Homebrew execution must run for package and ABI staging"
grep -Fq 'build-homebrew-bootstrap.sh --skip-package-resolve' <<<"$homebrew_guest_step" || \
  fail "candidate-backed Homebrew execution must use only materialized candidate packages"
grep -Fq -- '--brew-script /opt/kandelo/homebrew/bin/brew' <<<"$homebrew_guest_step" || \
  fail "candidate-backed Homebrew execution must test the canonical brew entry point"
grep -Fq -- '--brew-script /usr/bin/brew' <<<"$homebrew_guest_step" || \
  fail "candidate-backed Homebrew execution must test the /usr/bin/brew alias"
host_dist_clear_count=$(grep -Fc 'rm -rf host/dist' <<<"$homebrew_guest_step")
if [ "$host_dist_clear_count" -ne 2 ]; then
  fail "candidate-backed Homebrew execution must clear host/dist before both probes"
fi
first_host_dist_clear_line=$(grep -nF 'rm -rf host/dist' <<<"$homebrew_guest_step" | sed -n '1s/:.*//p')
second_host_dist_clear_line=$(grep -nF 'rm -rf host/dist' <<<"$homebrew_guest_step" | sed -n '2s/:.*//p')
canonical_brew_line=$(grep -nF -- '--brew-script /opt/kandelo/homebrew/bin/brew' <<<"$homebrew_guest_step" | cut -d: -f1)
alias_brew_line=$(grep -nF -- '--brew-script /usr/bin/brew' <<<"$homebrew_guest_step" | cut -d: -f1)
if [ "$first_host_dist_clear_line" -ge "$canonical_brew_line" ] || \
   [ "$canonical_brew_line" -ge "$second_host_dist_clear_line" ] || \
   [ "$second_host_dist_clear_line" -ge "$alias_brew_line" ]; then
  fail "candidate-backed Homebrew execution must clear host/dist before each ordered entry-point probe"
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
reconcile_run="$(
  step_run_block "$ACTIVATE_WORKFLOW" "Discover merged ready candidates"
)"
grep -Fq -- '--activated-receipts-file "$activated_receipts"' \
  <<<"$reconcile_run" &&
  grep -Fq 'echo "activated_receipts=$activated_receipts" >> "$GITHUB_OUTPUT"' \
    <<<"$reconcile_run" ||
  fail "reconciliation must persist authenticated activation receipts for deployment recovery"
grep -Fq 'activate-merge-candidate.sh' "$ACTIVATE_WORKFLOW" || \
  fail "activation workflow does not invoke the activation transaction"
grep -Fq 'failed=1' "$ACTIVATE_WORKFLOW" || \
  fail "reconciliation must continue after one candidate activation fails"
assert_effective_job_permission \
  "$ACTIVATE_WORKFLOW" activate actions write
activation_step="$(
  step_block "$ACTIVATE_WORKFLOW" "Activate exact merged candidates"
)"
activation_run="$(
  step_run_block "$ACTIVATE_WORKFLOW" "Activate exact merged candidates"
)"
grep -Fq 'id: activate' <<<"$activation_step" || \
  fail "candidate activation must expose whether canonical state moved"
grep -Fq 'activated_any=false' <<<"$activation_run" &&
  grep -Fq 'activated_any=true' <<<"$activation_run" &&
  grep -Fq 'gh release download "$candidate_tag"' <<<"$activation_run" &&
  grep -Fq '>> "$ACTIVATED_RECEIPTS"' <<<"$activation_run" &&
  grep -Fq 'echo "activated_any=$activated_any" >>"$GITHUB_OUTPUT"' \
    <<<"$activation_run" ||
  fail "candidate activation must publish its exact success state"
activation_output_line="$(
  grep -nF 'echo "activated_any=$activated_any" >>"$GITHUB_OUTPUT"' \
    <<<"$activation_run" | cut -d: -f1
)"
activation_exit_line="$(
  grep -nF 'exit "$failed"' <<<"$activation_run" | cut -d: -f1
)"
[ -n "$activation_output_line" ] && [ -n "$activation_exit_line" ] &&
  [ "$activation_output_line" -lt "$activation_exit_line" ] ||
  fail "candidate activation must publish success before returning failures"
pages_generation_step="$(
  step_run_block "$ACTIVATE_WORKFLOW" "Resolve the exact Pages generation"
)"
for evidence in \
  'release-index-state.sh snapshot' \
  'canonical_index_sha256' \
  'activated_at' \
  'candidate_tag' \
  'git rev-parse HEAD' \
  'kandelo-deployment.json' \
  'echo "dispatch=false"' \
  'echo "dispatch=true"'
do
  grep -Fq "$evidence" <<<"$pages_generation_step" ||
    fail "durable Pages generation resolution lacks: $evidence"
done
pages_dispatch_step="$(
  step_block "$ACTIVATE_WORKFLOW" "Dispatch the exact Pages generation"
)"
grep -Fq "if: steps.pages_generation.outputs.dispatch == 'true'" \
  <<<"$pages_dispatch_step" &&
  grep -Fq -- '-f source_sha="${{ steps.pages_generation.outputs.source_sha }}"' \
    <<<"$pages_dispatch_step" &&
  grep -Fq -- '-f candidate_tag="${{ steps.pages_generation.outputs.candidate_tag }}"' \
    <<<"$pages_dispatch_step" &&
  grep -Fq -- '-f canonical_index_sha256="${{ steps.pages_generation.outputs.canonical_index_sha256 }}"' \
    <<<"$pages_dispatch_step" ||
  fail "activation must dispatch an exact durable Pages generation"
for input in source_sha candidate_tag canonical_index_sha256; do
  grep -Fq "      $input:" "$PAGES_WORKFLOW" ||
    fail "Pages workflow lacks exact dispatch input: $input"
done
grep -Fq 'ref: ${{ inputs.source_sha }}' "$PAGES_WORKFLOW" ||
  fail "Pages checkout must bind the requested source SHA"
! grep -Fq 'inputs.source_sha || github.sha' "$PAGES_WORKFLOW" ||
  fail "dispatch-only Pages checkout must not fall back to the event SHA"
pages_generation_verifier="$(
  step_run_block "$PAGES_WORKFLOW" "Verify the requested package generation"
)"
for evidence in \
  'release-index-state.sh snapshot' \
  'ready.json' \
  'activated.json' \
  'canonical_index_sha256' \
  'candidate_tag'
do
  grep -Fq "$evidence" <<<"$pages_generation_verifier" ||
    fail "Pages generation verification lacks: $evidence"
done
pages_manifest_step="$(
  step_run_block "$PAGES_WORKFLOW" "Record the deployed generation"
)"
grep -Fq 'kandelo-deployment.json' <<<"$pages_manifest_step" &&
  grep -Fq 'source_sha' <<<"$pages_manifest_step" &&
  grep -Fq 'canonical_index_sha256' <<<"$pages_manifest_step" ||
  fail "Pages must publish durable generation evidence"
if grep -Fq -- '--wait-seconds' "$ACTIVATE_WORKFLOW" || \
   grep -Fq -- '--wait-seconds' "$ACTIVATE_SCRIPT"
then
  fail "post-merge activation must not wait on an unmerged PR"
fi

grep -Fq '/releases?per_page=${PER_PAGE}&page=${page}' "$RECONCILE_SCRIPT" || \
  fail "scheduled reconciliation must use explicit bounded release pagination"
grep -Fq 'release scan reached the ${MAX_PAGES}-page safety bound' "$RECONCILE_SCRIPT" || \
  fail "reconciliation must fail rather than silently truncate its scan"
# Exercise the real reconciler because marker names in source do not prove that
# terminal bytes are downloaded, identity-bound, bounded, and validated before
# the historical lifecycle exception is accepted.
bash "$SCRIPT_DIR/test-reconcile-merge-candidates.sh" >/dev/null || \
  fail "reconciliation terminal receipt behavior failed"
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
[ "$(grep -Fc -- '--exclude "$PACKAGE_STAGING_EXCLUSIONS"' "$STAGING_WORKFLOW")" -eq 2 ] || \
  fail "staging preflight and test-gate must share one publication exclusion contract"
grep -Fq 'PACKAGE_STAGING_EXCLUSIONS="$PACKAGE_STAGING_EXCLUSIONS"' \
  "$STAGING_WORKFLOW" || \
  fail "test-gate must carry the shared publication exclusion contract into the dev shell"
grep -Fq -- '--mode structural' "$STAGING_WORKFLOW" || \
  fail "staging preflight must validate complete target-release structure"
grep -Fq 'validated target/canonical union did not cover the computed matrix' "$STAGING_WORKFLOW" || \
  fail "staging preflight must prove full current coverage before emptying the matrix"
grep -Fq 'PACKAGE_REUSE_STAGING: ${{ needs.preflight.outputs.reuse_staging }}' "$STAGING_WORKFLOW" || \
  fail "test-gate must consume the preflight reuse decision"
materialize_step=$(step_block "$STAGING_WORKFLOW" "Materialize binaries")
grep -Fq 'GH_TOKEN: ${{ github.token }}' <<<"$materialize_step" || \
  fail "staging materialization must authenticate release snapshot reads"
for workflow in "$STAGING_WORKFLOW" "$PREPARE"; do
  materialize_step=$(step_run_block "$workflow" "Materialize binaries")
  grep -Fq 'staging-reuse expected \' <<<"$materialize_step" ||
    fail "$(basename "$workflow") test-gate does not rederive the publication ledger"
  grep -Fq -- '--exclude "$PACKAGE_STAGING_EXCLUSIONS"' <<<"$materialize_step" ||
    fail "$(basename "$workflow") test-gate does not share preflight exclusions"
  grep -Fq -- '--expected-ledger "$EXPECTED"' <<<"$materialize_step" ||
    fail "$(basename "$workflow") test-gate can still raw-walk packages outside its publication ledger"
  bootstrap_fetch_line=$(grep -nF -- '--package homebrew-bootstrap' \
    <<<"$materialize_step" | cut -d: -f1)
  mirror_state_line=$(grep -nF \
    'scripts/ci-homebrew-browser-mirror-state.sh' \
    <<<"$materialize_step" | cut -d: -f1)
  if ! [[ "$bootstrap_fetch_line" =~ ^[1-9][0-9]*$ ]] ||
     ! [[ "$mirror_state_line" =~ ^[1-9][0-9]*$ ]] ||
     [ "$bootstrap_fetch_line" -ge "$mirror_state_line" ]; then
    fail "$(basename "$workflow") does not fetch the canonical Homebrew bootstrap before lazy-shell inspection"
  fi
done
[ "$(grep -Fc -- '--exclude "$PACKAGE_STAGING_EXCLUSIONS"' "$PREPARE")" -eq 2 ] || \
  fail "prepare preflight and test-gate must share one publication exclusion contract"
for workflow in "$STAGING_WORKFLOW" "$PREPARE"; do
  grep -Fq 'WASM_POSIX_FETCH_SKIP_PKGS: cpython erlang ' "$workflow" ||
    fail "$(basename "$workflow") lost its heavy-runtime materialization optimization"
  grep -Fq 'WASM_POSIX_FETCH_SKIP_PKGS: cpython erlang erlang-vfs homebrew-bootstrap ' \
    "$workflow" ||
    fail "$(basename "$workflow") tries to fetch tap-owned Homebrew bootstrap from the legacy registry"
done
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
if ! step_run_block "$PREPARE" "Compute matrix" | bash -n; then
  fail "prepare-merge workflow step Compute matrix is not valid nested shell syntax"
fi

for workflow in "$STAGING_WORKFLOW" "$PREPARE"; do
  validation_job="$(job_block "$workflow" test-gate-validation)"
  root_install_line="$(
    grep -nF -- '- name: Install root npm deps' <<<"$validation_job" |
      head -n 1 |
      cut -d: -f1
  )"
  materialization_line="$(
    grep -nF -- '- name: Test binary materialization flow' <<<"$validation_job" |
      head -n 1 |
      cut -d: -f1
  )"
  [ -n "$root_install_line" ] &&
    [ -n "$materialization_line" ] &&
    [ "$root_install_line" -lt "$materialization_line" ] ||
    fail "$(basename "$workflow") must install root npm dependencies before materialization tests"
  root_install_step="$(step_block "$workflow" "Install root npm deps")"
  grep -Fq 'run: bash scripts/dev-shell.sh npm ci --no-audit --no-fund' \
    <<<"$root_install_step" ||
    fail "$(basename "$workflow") materialization validation must install the root esbuild dependency"
done

grep -Fq 'cleanup-merge-candidates.sh' "$CLEANUP_WORKFLOW" || \
  fail "staging cleanup must delegate candidate lifecycle to the tested helper"
cleanup_sweep=$(job_block "$CLEANUP_WORKFLOW" sweep)
for helper in classify-pr-staging.sh cleanup-merge-candidates.sh \
  delete-writable-release.sh github-api-get.sh latest-merge-gate-status.sh \
  state-lock.sh; do
  grep -Fq ".github/scripts/$helper" <<<"$cleanup_sweep" || \
    fail "staging cleanup sparse checkout lacks $helper"
done
cleanup_on_close=$(job_block "$CLEANUP_WORKFLOW" cleanup-on-close)
grep -Fq 'actions: read' <<<"$cleanup_on_close" || \
  fail "PR-close cleanup lock recovery cannot inspect workflow state"
grep -Fq '.github/scripts/state-lock.sh' <<<"$cleanup_on_close" || \
  fail "PR-close cleanup sparse checkout lacks the publisher state lock"
grep -Fq '.github/scripts/delete-writable-release.sh' \
  <<<"$cleanup_on_close" || \
  fail "PR-close cleanup must use idempotent release/tag deletion"
grep -Fq -- '--release-id "$RELEASE_ID"' <<<"$cleanup_on_close" || \
  fail "PR-close cleanup must preserve the discovered release ID"
grep -Fq -- '--tag "$TAG"' <<<"$cleanup_on_close" || \
  fail "PR-close cleanup must preserve the discovered release tag"
if grep -Fq 'gh release delete' <<<"$cleanup_on_close"; then
  fail "PR-close cleanup must not couple release and tag deletion"
fi
if grep -Fq 'gh release delete' "$CLEANUP_WORKFLOW"; then
  fail "staging cleanup must not couple release and tag deletion"
fi
close_release_cleanup=$(
  step_run_block "$CLEANUP_WORKFLOW" \
    "Delete writable PR staging releases"
)
grep -Fq 'set -euo pipefail' <<<"$close_release_cleanup" || \
  fail "PR-close release discovery can hide a failed API pipeline"
orphan_release_cleanup=$(
  step_run_block "$CLEANUP_WORKFLOW" \
    "Sweep orphan writable PR staging tags"
)
grep -Fq 'set -euo pipefail' <<<"$orphan_release_cleanup" || \
  fail "scheduled release discovery can hide a failed API pipeline"
grep -Fq "contains(github.event.pull_request.labels.*.name, 'retain-package-staging')" \
  <<<"$cleanup_on_close" || \
  fail "PR-close cleanup does not recognize explicit package-staging retention"
branch_cleanup=$(step_block "$CLEANUP_WORKFLOW" "Delete merged ready-to-ship PR branch")
grep -Fq "!contains(github.event.pull_request.labels.*.name, 'retain-package-staging')" \
  <<<"$branch_cleanup" || \
  fail "PR-close cleanup can delete a retained package producer branch"
grep -Fq "github.event.pull_request.merged != true" <<<"$cleanup_on_close" || \
  fail "abandoned PR staging must remain eligible for immediate cleanup"
grep -Fq -- '--json state,mergedAt,labels' <<<"$cleanup_sweep" || \
  fail "scheduled staging cleanup does not inspect merged retention state"
grep -Fq 'if ! decision=$(bash .github/scripts/classify-pr-staging.sh "$pr_json")' \
  <<<"$cleanup_sweep" || \
  fail "scheduled staging cleanup does not fail closed through its tested classifier"
grep -Fq 'Keeping $TAG because PR state is unavailable' <<<"$cleanup_sweep" || \
  fail "scheduled staging cleanup must retain evidence when GitHub state is unavailable"
grep -Fq -- '--json number,headRefName,headRefOid,isCrossRepository,labels' \
  <<<"$cleanup_sweep" || \
  fail "scheduled branch cleanup does not inspect package-retention labels"
grep -Fq '([.labels[].name] | index("retain-package-staging") | not)' \
  <<<"$cleanup_sweep" || \
  fail "scheduled branch cleanup can delete a retained package producer branch"
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
grep -Fq 'bash "$DELETE_RELEASE_SCRIPT"' "$CLEANUP_SCRIPT" || \
  fail "candidate cleanup must use idempotent release/tag deletion"
grep -Fq -- '--release-id "$release_id"' "$CLEANUP_SCRIPT" || \
  fail "candidate cleanup must preserve the discovered release ID"
grep -Fq -- '--lock-held' "$CLEANUP_SCRIPT" || \
  fail "candidate cleanup must reuse its held per-tag state lock"
grep -Fq 'before deciding whether the operation needs another attempt.' \
  "$DELETE_RELEASE_SCRIPT" || \
  fail "release cleanup lacks the idempotence rationale"

echo "merge candidate workflow contract tests passed"
