#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/staging-build.yml"

grep -Fq 'stacked_baseline_archives: ${{ steps.compute.outputs.stacked_baseline_archives }}' "$WORKFLOW"
grep -Fq 'bash .github/scripts/resolve-stacked-pr-baseline.sh' "$WORKFLOW"
grep -Fq 'unresolved=$(subtract_matches "$unresolved" "$stacked_matches")' "$WORKFLOW"
grep -Fq 'name: stacked-baseline-archives' "$WORKFLOW"
grep -Fq 'PACKAGE_STAGE_OVERLAYS_REQUIRED: ${{ needs.preflight.outputs.library_matrix' "$WORKFLOW"

downloads="$(grep -Fc 'name: Download inherited stacked baseline archives' "$WORKFLOW")"
[ "$downloads" -eq 3 ] || {
  echo "expected inherited baseline download in library, program, and test jobs; found $downloads" >&2
  exit 1
}
materializations="$(grep -Fc 'materialize-pr-overlays.sh "$RUNNER_TEMP/stacked-baseline-archives"' "$WORKFLOW")"
[ "$materializations" -eq 3 ] || {
  echo "expected inherited baseline materialization in library, program, and test jobs; found $materializations" >&2
  exit 1
}

echo 'stacked baseline workflow wiring test passed'
