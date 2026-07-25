#!/usr/bin/env bash
# Structural regression coverage for the exact-main package publication path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FORCE_REBUILD="$REPO_ROOT/.github/workflows/force-rebuild.yml"
INDEX_UPDATE="$REPO_ROOT/scripts/index-update.sh"
ARCHIVE_ACTION="$REPO_ROOT/.github/actions/package-archive-build/action.yml"
STAGING="$REPO_ROOT/.github/workflows/staging-build.yml"
PREPARE="$REPO_ROOT/.github/workflows/prepare-merge.yml"

fail() {
  echo "exact-main package publication contract: $*" >&2
  exit 1
}

gate_block="$(
  awk '
    /^  gate:/ { inside = 1 }
    inside && /^  [a-zA-Z0-9_-]+:/ && !/^  gate:/ { exit }
    inside { print }
  ' "$FORCE_REBUILD"
)"

for exact_gate in \
  '[ "${{ github.repository }}" = "Automattic/kandelo" ]' \
  '[ "${{ github.ref }}" = "refs/heads/main" ]' \
  '[ "${{ github.workflow_ref }}" = "Automattic/kandelo/.github/workflows/force-rebuild.yml@refs/heads/main" ]' \
  'SOURCE_SHA="${INPUT_REF:-${{ github.sha }}}"' \
  '[ "$SOURCE_SHA" = "${{ github.sha }}" ]' \
  'gh api /repos/Automattic/kandelo/git/ref/heads/main --jq .object.sha' \
  '[ "$SOURCE_SHA" = "$main_sha" ]'
do
  grep -Fq "$exact_gate" <<<"$gate_block" ||
    fail "force-rebuild gate lacks exact identity check: $exact_gate"
done

# WHY: graph or tree equivalence would reintroduce the history-only shortcut
# this contract replaces. Only commit identity against the live main ref is
# publication authority.
if grep -Eq 'merge-base|rev-list|cat-file|\\^\\{tree\\}|github\\.ref_name' <<<"$gate_block"; then
  fail "force-rebuild gate must not substitute ancestry, tree identity, or a named ref for exact main"
fi
if grep -Fq 'build_ref' "$FORCE_REBUILD"; then
  fail "force-rebuild still accepts a generic build ref"
fi

checkout_count="$(grep -c 'uses: actions/checkout@' "$FORCE_REBUILD")"
exact_checkout_count="$(
  grep -Fc 'ref: ${{ needs.gate.outputs.source_sha }}' "$FORCE_REBUILD"
)"
[ "$checkout_count" -eq "$exact_checkout_count" ] ||
  fail "all force-rebuild checkouts must use the admitted exact-main SHA"

archive_count="$(grep -c '^[[:space:]]*archive-stage \\' "$FORCE_REBUILD")"
[ "$archive_count" -gt 0 ] ||
  fail "force-rebuild has no archive producers"
for required_arg in \
  '--source-repository "https://github.com/${{ github.repository }}"' \
  '--source-commit "${{ needs.gate.outputs.source_sha }}"' \
  '--force-source-build'
do
  count="$(grep -Fc -- "$required_arg" "$FORCE_REBUILD")"
  [ "$count" -eq "$archive_count" ] ||
    fail "every force-rebuild archive producer must pass $required_arg"
done

index_writer_count="$(grep -c 'bash scripts/index-update.sh' "$FORCE_REBUILD")"
guarded_writer_count="$(
  grep -Fc -- '--canonical-source-sha "${{ needs.gate.outputs.source_sha }}"' \
    "$FORCE_REBUILD"
)"
[ "$index_writer_count" -eq "$guarded_writer_count" ] ||
  fail "every force-rebuild canonical index writer must carry exact-main authority"

grep -Fq -- '--canonical-source-sha) CANONICAL_SOURCE_SHA="$2"; shift 2' \
  "$INDEX_UPDATE" ||
  fail "index-update does not parse exact-main authority"
grep -Fq 'bash .github/scripts/require-exact-kandelo-main.sh' "$INDEX_UPDATE" ||
  fail "index-update does not delegate live-main validation to the tested helper"
grep -Fq '[ "${GITHUB_REPOSITORY:-}" != "Automattic/kandelo" ]' "$INDEX_UPDATE" ||
  fail "exact-main index mutation is not bound to Automattic/kandelo"
grep -Fq '[ "$IS_CANONICAL" != 1 ]' "$INDEX_UPDATE" ||
  fail "exact-main authority can be misapplied to a noncanonical release"

ensure_line="$(grep -n '^ensure_release_exists$' "$INDEX_UPDATE" | tail -1 | cut -d: -f1)"
ensure_guard_line="$(
  grep -n '^require_canonical_source_authority$' "$INDEX_UPDATE" |
    awk -F: -v mutation="$ensure_line" '$1 < mutation { line = $1 } END { print line }'
)"
[ -n "$ensure_guard_line" ] && [ "$ensure_guard_line" -lt "$ensure_line" ] ||
  fail "release creation is not preceded by a live-main recheck"

upload_line="$(grep -n '^[[:space:]]*if gh release upload ' "$INDEX_UPDATE" | cut -d: -f1)"
upload_guard_line="$(
  grep -n '^[[:space:]]*require_canonical_source_authority$' "$INDEX_UPDATE" |
    awk -F: -v mutation="$upload_line" '$1 < mutation { line = $1 } END { print line }'
)"
[ -n "$upload_guard_line" ] && [ "$upload_guard_line" -lt "$upload_line" ] ||
  fail "archive upload is not preceded by a live-main recheck"

publish_line="$(
  grep -n 'bash "$RELEASE_INDEX_STATE_SCRIPT" publish' "$INDEX_UPDATE" |
    cut -d: -f1
)"
publish_guard_line="$(
  grep -n '^[[:space:]]*require_canonical_source_authority$' "$INDEX_UPDATE" |
    awk -F: -v mutation="$publish_line" '$1 < mutation { line = $1 } END { print line }'
)"
[ -n "$publish_guard_line" ] && [ "$publish_guard_line" -lt "$publish_line" ] ||
  fail "canonical index publication is not preceded by a live-main recheck"

for input in source-repository source-commit; do
  grep -A3 "^  $input:" "$ARCHIVE_ACTION" | grep -Fq 'required: true' ||
    fail "archive action input $input must be required"
  grep -Fq -- "--$input \"\${{ inputs.$input }}\"" "$ARCHIVE_ACTION" ||
    fail "archive action does not pass required input $input to archive-stage"
done

for workflow in "$STAGING" "$PREPARE"; do
  action_count="$(
    grep -Fc 'uses: ./.github/actions/package-archive-build' "$workflow"
  )"
  repository_count="$(
    grep -Fc 'source-repository: https://github.com/${{ github.repository }}' \
      "$workflow"
  )"
  [ "$action_count" -eq "$repository_count" ] ||
    fail "$(basename "$workflow") does not identify every archive source repository"
done
[ "$(grep -Fc 'source-commit: ${{ github.event.pull_request.head.sha }}' "$STAGING")" -eq \
  "$(grep -Fc 'uses: ./.github/actions/package-archive-build' "$STAGING")" ] ||
  fail "staging archives must record the exact tested pull-request head"
[ "$(grep -Fc 'source-commit: ${{ needs.synthesize-merge.outputs.merge_sha }}' "$PREPARE")" -eq \
  "$(grep -Fc 'uses: ./.github/actions/package-archive-build' "$PREPARE")" ] ||
  fail "merge-candidate archives must record the exact tested synthetic merge"

echo "test-exact-main-package-publication.sh: ok"
