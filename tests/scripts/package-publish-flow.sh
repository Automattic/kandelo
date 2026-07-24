#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

bash "$REPO_ROOT/.github/actions/detect-change-scope/test-ci-scope-paths.sh"
HOST_TARGET=$(rustc -vV | awk '/^host:/ {print $2}')
cargo test -p xtask --target "$HOST_TARGET" staging_reuse --no-fail-fast
bash "$REPO_ROOT/tests/scripts/index-update.sh"
bash "$REPO_ROOT/tests/scripts/release-index-state.sh"
bash "$REPO_ROOT/.github/scripts/test-state-lock.sh"
bash "$REPO_ROOT/.github/scripts/test-compose-staging-finalization.sh"
bash "$REPO_ROOT/.github/scripts/test-publish-staging-finalization.sh"
bash "$REPO_ROOT/.github/scripts/test-staging-finalization-outcome.sh"
bash "$REPO_ROOT/.github/scripts/test-staging-finalizer-workflow.sh"
bash "$REPO_ROOT/.github/scripts/test-merge-candidate-workflows.sh"
bash "$REPO_ROOT/.github/scripts/test-require-exact-head-approval.sh"
bash "$REPO_ROOT/.github/scripts/test-latest-merge-gate-status.sh"
bash "$REPO_ROOT/.github/scripts/test-fetch-canonical-index.sh"
bash "$REPO_ROOT/.github/scripts/test-select-package-archive-source.sh"
bash "$REPO_ROOT/.github/scripts/test-download-verified-release-asset.sh"
bash "$REPO_ROOT/.github/scripts/test-validate-staging-release.sh"
bash "$REPO_ROOT/.github/scripts/test-recover-canonical-indexes.sh"
bash "$REPO_ROOT/.github/scripts/test-init-merge-candidate.sh"
bash "$REPO_ROOT/.github/scripts/test-clone-rejected-merge-candidate.sh"
bash "$REPO_ROOT/.github/scripts/test-reconcile-merge-candidates.sh"
bash "$REPO_ROOT/.github/scripts/test-cleanup-merge-candidates.sh"
bash "$REPO_ROOT/.github/scripts/test-verify-merge-candidate.sh"
bash "$REPO_ROOT/.github/scripts/test-activate-merge-candidate.sh"

echo "package publish flow tests passed"
