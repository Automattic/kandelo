#!/usr/bin/env bash
# shellcheck disable=SC2016 # Contract assertions intentionally match expressions literally.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/staging-build.yml"
COMPOSE="$SCRIPT_DIR/compose-staging-finalization.sh"
PUBLISH="$SCRIPT_DIR/publish-staging-finalization.sh"

fail() {
  echo "staging finalizer workflow contract: $*" >&2
  exit 1
}

job_block() {
  local job="$1"
  awk -v job="$job" '
    $0 == "  " job ":" { inside = 1 }
    inside && /^  [a-zA-Z0-9_-]+:/ && $0 != "  " job ":" { exit }
    inside { print }
  ' "$WORKFLOW"
}

step_run_block() {
  local step="$1"
  awk -v step="$step" '
    $0 == "      - name: " step { in_step = 1; next }
    in_step && $0 == "        run: |" { in_run = 1; next }
    in_run && /^      - name:/ { exit }
    in_run {
      line = $0
      sub(/^          /, "", line)
      print line
    }
  ' "$WORKFLOW"
}

libraries="$(job_block lib-matrix-build)"
programs="$(job_block matrix-build)"
finalizer="$(job_block finalize-staging-release)"
prepare="$(job_block test-gate-prepare)"
status="$(job_block f2-status)"

for matrix in "$libraries" "$programs"; do
  grep -Fq 'contents: read' <<<"$matrix" ||
    fail "matrix jobs must be read-only"
  if grep -Fq 'contents: write' <<<"$matrix" ||
     grep -Eq 'index-update\.sh|gh release (create|upload)|state-lock\.sh' <<<"$matrix"; then
    fail "matrix jobs still contain release/index writers"
  fi
  grep -Fq 'max-parallel: 10' <<<"$matrix" ||
    fail "read-only matrix did not raise its bounded parallelism to ten"
done

grep -Fq 'needs: [preflight, toolchain-cache, lib-matrix-build, matrix-build]' \
  <<<"$finalizer" ||
  fail "finalizer must wait for both dependency-ordered matrix waves"
grep -Fq 'actions: read' <<<"$finalizer" ||
  fail "finalizer must read immutable run artifacts and recover stale locks"
grep -Fq 'contents: write' <<<"$finalizer" ||
  fail "finalizer must be the credentialed release writer"
grep -Fq 'compose-staging-finalization.sh' <<<"$finalizer" ||
  fail "finalizer does not compose a complete local snapshot"
grep -Fq 'publish-staging-finalization.sh' <<<"$finalizer" ||
  fail "finalizer does not publish the single transaction"
grep -Fq 'finalize-staging-release.result' <<<"$prepare" ||
  fail "test preparation can race the staging finalizer"
grep -Fq 'PACKAGE_FINALIZED_STAGING' <<<"$prepare" ||
  fail "test preparation does not consume the finalized release"
grep -Fq 'staging-finalizer-status' <<<"$status" ||
  fail "partial-failure reporting is not bound to the finalizer result"
grep -Fq 'publication_status' <<<"$status" ||
  fail "matrix status can hide a failed final release publication"
grep -Fq 'package rows describe matrix builds, not the release write' <<<"$finalizer" ||
  fail "build/publication status distinction lacks its maintenance WHY"

writer_jobs="$(
  awk '
    /^  [a-zA-Z0-9_-]+:/ {
      job = $1
      sub(/:$/, "", job)
    }
    /^      contents: write/ { print job }
  ' "$WORKFLOW" | sort -u
)"
[ "$writer_jobs" = finalize-staging-release ] ||
  fail "staging contents:write authority escaped the finalizer: $writer_jobs"

grep -Fq 'staging-reuse finalize-validate' "$COMPOSE" ||
  fail "composer must validate exact cache/provenance and emit an asset plan"
grep -Fq -- '--replace-package-version true' "$COMPOSE" ||
  fail "composer must replace stale package version blocks"
grep -Fq 'STATE_LOCK_STATE_FILE="$LOCK_STATE"' "$PUBLISH" ||
  fail "publisher must own one recoverable per-tag state lock"
grep -Fq 'publish_index_once' "$PUBLISH" ||
  fail "publisher must replace the complete index exactly once"
grep -Fq 'Re-read every referenced archive after index publication' "$PUBLISH" ||
  fail "publisher must re-read every final referenced archive"
grep -Fq 'fail instead of using --clobber' "$PUBLISH" ||
  fail "immutable archive collision policy lacks its maintenance WHY"

for step in \
  "Build exact finalization inputs" \
  "Freeze the complete last-green baseline" \
  "Compose one complete target-relative index"
do
  if ! step_run_block "$step" | bash -n; then
    fail "workflow step $step is not valid nested shell syntax"
  fi
done

echo "staging finalizer workflow contract tests passed"
