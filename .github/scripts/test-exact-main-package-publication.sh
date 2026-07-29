#!/usr/bin/env bash
# Structural regression coverage for the exact-main package publication path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FORCE_REBUILD="$REPO_ROOT/.github/workflows/force-rebuild.yml"
EXACT_REBUILD_ACTION="$REPO_ROOT/.github/actions/exact-main-package-rebuild/action.yml"
DEV_SHELL="$REPO_ROOT/scripts/dev-shell.sh"
INDEX_UPDATE="$REPO_ROOT/scripts/index-update.sh"
INDEX_STATE="$REPO_ROOT/scripts/release-index-state.sh"
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

grep -Fq '"$XTASK" staging-reuse expected \' "$FORCE_REBUILD" ||
  fail "force-rebuild matrix does not come from the shared publication-policy ledger"
grep -Fq -- '--require-root "$INPUT_PACKAGES"' "$FORCE_REBUILD" ||
  fail "force-rebuild does not loudly validate explicitly requested roots"
if grep -Fq 'for pkg_dir in packages/registry/*/' "$FORCE_REBUILD" ||
  grep -Fq 'compute-cache-key-sha --package "$pkg_dir"' "$FORCE_REBUILD"; then
  fail "force-rebuild still reconstructs a policy-bypassing matrix from raw manifests"
fi

preflight_block="$(
  awk '
    /^  preflight:/ { inside = 1 }
    inside && /^  [a-zA-Z0-9_-]+:/ && !/^  preflight:/ { exit }
    inside { print }
  ' "$FORCE_REBUILD"
)"
test_prepare_block="$(
  awk '
    /^  test-gate-prepare:/ { inside = 1 }
    inside && /^  [a-zA-Z0-9_-]+:/ && !/^  test-gate-prepare:/ { exit }
    inside { print }
  ' "$FORCE_REBUILD"
)"
for expected_handoff in \
  'expected_ledger_artifact: ${{ steps.compute.outputs.expected_ledger_artifact }}' \
  'force-rebuild-expected-ledger-${{ github.run_id }}-attempt-${{ github.run_attempt }}' \
  'expected_ledger="$RUNNER_TEMP/force-rebuild-expected-ledger.json"' \
  'blocked_report="$RUNNER_TEMP/force-rebuild-publication-blockers.json"' \
  'INPUT_SKIP_TESTS: ${{ inputs.skip_tests }}' \
  'PACKAGE_STAGING_EXCLUSIONS="$PACKAGE_STAGING_EXCLUSIONS" \' \
  'SKIP_TESTS="$INPUT_SKIP_TESTS" \' \
  '--exclude "$PACKAGE_STAGING_EXCLUSIONS"' \
  '--blocked-output "$blocked_report"' \
  'name: ${{ steps.compute.outputs.expected_ledger_artifact }}' \
  '${{ runner.temp }}/force-rebuild-expected-ledger.json' \
  '${{ runner.temp }}/force-rebuild-publication-blockers.json'
do
  grep -Fq -- "$expected_handoff" <<<"$preflight_block" ||
    fail "preflight does not preserve its expected ledger artifact: $expected_handoff"
done
grep -Fq 'required_root_args+=(--require-root rootfs)' <<<"$preflight_block" ||
  fail "test-gated force rebuilds do not require the rootfs package closure"
grep -Fq 'if [ "$SKIP_TESTS" != "true" ]' <<<"$preflight_block" ||
  fail "rootfs test admission is not scoped to runs that execute tests"
if grep -Fq 'rm -f "$expected_ledger"' <<<"$preflight_block"; then
  fail "preflight deletes the expected ledger before its test consumer can use it"
fi

for expected_consumer in \
  'name: ${{ needs.preflight.outputs.expected_ledger_artifact }}' \
  'EXPECTED="$RUNNER_TEMP/force-rebuild-expected/force-rebuild-expected-ledger.json"' \
  '--fetch-only' \
  '--expected-ledger "$EXPECTED"'
do
  grep -Fq -- "$expected_consumer" <<<"$test_prepare_block" ||
    fail "test preparation does not consume the preflight ledger strictly: $expected_consumer"
done
policy_exclusions=""
fetch_exclusions=""
for workflow in "$STAGING" "$PREPARE" "$FORCE_REBUILD"; do
  workflow_policy="$(
    sed -n 's/^[[:space:]]*PACKAGE_STAGING_EXCLUSIONS:[[:space:]]*//p' \
      "$workflow" | head -1
  )"
  workflow_fetch="$(
    sed -n 's/^[[:space:]]*WASM_POSIX_FETCH_SKIP_PKGS:[[:space:]]*//p' \
      "$workflow" | head -1
  )"
  [ -n "$workflow_policy" ] ||
    fail "$(basename "$workflow") has no package materialization exclusion policy"
  [ -n "$workflow_fetch" ] ||
    fail "$(basename "$workflow") has no package fetch exclusion policy"
  if [ -z "$policy_exclusions" ]; then
    policy_exclusions="$workflow_policy"
    fetch_exclusions="$workflow_fetch"
  else
    [ "$workflow_policy" = "$policy_exclusions" ] ||
      fail "$(basename "$workflow") publication exclusions drifted from the shared suite policy"
    [ "$workflow_fetch" = "$fetch_exclusions" ] ||
      fail "$(basename "$workflow") fetch exclusions drifted from the shared suite policy"
  fi
done
grep -Fq -- '--keep WASM_POSIX_FETCH_SKIP_PKGS' "$DEV_SHELL" ||
  fail "dev shell drops the test-gate package fetch exclusions"
if grep -Fq -- '--allow-stale' <<<"$test_prepare_block"; then
  fail "force-rebuild test materialization can still source-build stale or unrelated packages"
fi
[ "$(grep -Fc 'staging-reuse expected \' <<<"$preflight_block")" -eq 1 ] ||
  fail "force-rebuild preflight must derive its expected ledger exactly once"

archive_count="$(grep -c '^[[:space:]]*archive-stage \\' "$EXACT_REBUILD_ACTION")"
[ "$archive_count" -gt 0 ] ||
  fail "force-rebuild has no archive producers"
for required_arg in \
  '--source-repository "https://github.com/${{ github.repository }}"' \
  '--source-commit "${{ inputs.source-sha }}"' \
  '--cache-root "$exact_main_package_cache_root"' \
  '--force-source-build'
do
  count="$(grep -Fc -- "$required_arg" "$EXACT_REBUILD_ACTION")"
  [ "$count" -eq "$archive_count" ] ||
    fail "every force-rebuild archive producer must pass $required_arg"
done
grep -Fq 'EXACT_MAIN_PACKAGE_CACHE_PARENT="$RUNNER_TEMP/kandelo"' \
  "$EXACT_REBUILD_ACTION" ||
  fail "exact-main package cache is outside the SDK target-cache namespace"
grep -Fq 'mkdir -m 700 "$EXACT_MAIN_PACKAGE_CACHE_PARENT"' \
  "$EXACT_REBUILD_ACTION" ||
  fail "exact-main package cache namespace is not privately resolver-owned"
grep -Fq 'mktemp -d "$EXACT_MAIN_PACKAGE_CACHE_PARENT/exact-main-package-cache.XXXXXX"' \
  "$EXACT_REBUILD_ACTION" ||
  fail "exact-main archive builds may reuse an older cache-equivalent dependency"

build_block="$(
  awk '
    /- name: Build exact-main package archive/ { inside = 1 }
    inside && /- name: Upload same-run package artifact/ { exit }
    inside { print }
  ' "$EXACT_REBUILD_ACTION"
)"
for cache_root_handoff in \
  'exact_main_package_cache_root="$1"' \
  '[[ "$exact_main_package_cache_root" = /* ]]' \
  "' exact-main-package-rebuild \"\$EXACT_MAIN_PACKAGE_CACHE_ROOT\""
do
  grep -Fq "$cache_root_handoff" <<<"$build_block" ||
    fail "exact-main cache root does not cross the dev-shell boundary as one absolute argument: $cache_root_handoff"
done
if grep -Eq '^[[:space:]]*export[[:space:]]+EXACT_MAIN_PACKAGE_CACHE_ROOT' \
    <<<"$build_block"; then
  fail "exact-main cache root still relies on ambient exported state"
fi
if grep -Eq -- '--keep[[:space:]]+EXACT_MAIN_PACKAGE_CACHE_ROOT([[:space:]\\]|$)' \
    "$DEV_SHELL"; then
  fail "exact-main cache root must not become ambient dev-shell state"
fi

publication_recheck_block="$(
  awk '
    /- name: Recheck package publication admission/ { inside = 1 }
    inside && /- name: Download exact-main toolchain/ { exit }
    inside { print }
  ' "$EXACT_REBUILD_ACTION"
)"
for publication_guard in \
  'staging-reuse expected' \
  '--require-root "$PACKAGE"' \
  '.package == \$package' \
  '.arch == \$arch' \
  '.cache_key_sha == \$cache_key_sha' \
  '.version == \$version' \
  '.revision == \$revision' \
  'echo "admitted=true" >> "$GITHUB_OUTPUT"'
do
  grep -Fq -- "$publication_guard" <<<"$publication_recheck_block" ||
    fail "exact-main rebuild lacks publication recheck: $publication_guard"
done

# WHY: recipe identity is run-scoped publication authority, not ambient
# developer state. Keep the dev shell clean and require this one action to
# make the complete handoff visible at its command boundary.
grep -Fq 'bash scripts/dev-shell.sh env \' <<<"$publication_recheck_block" ||
  fail "publication admission does not cross the clean dev-shell boundary explicitly"
for admission_variable in ABI PACKAGE ARCH CACHE_KEY_SHA VERSION REVISION; do
  grep -Fq "$admission_variable=\"\$$admission_variable\" \\" \
    <<<"$publication_recheck_block" ||
    fail "publication admission does not explicitly forward $admission_variable"
  if grep -Eq -- "--keep[[:space:]]+$admission_variable([[:space:]\\\\]|$)" \
      "$DEV_SHELL"; then
    fail "$admission_variable must not become ambient dev-shell state"
  fi
done
if grep -Eq '^[[:space:]]*export[[:space:]].*(ABI|PACKAGE|ARCH|CACHE_KEY_SHA|VERSION|REVISION)' \
    <<<"$publication_recheck_block"; then
  fail "publication admission still relies on exported ambient recipe identity"
fi

nix_bin="$(command -v nix || true)"
if [ -z "$nix_bin" ]; then
  for candidate in /nix/var/nix/profiles/default/bin/nix "$HOME/.nix-profile/bin/nix"; do
    if [ -x "$candidate" ]; then
      nix_bin="$candidate"
      break
    fi
  done
fi
[ -n "$nix_bin" ] ||
  fail "cannot exercise the exact-main dev-shell boundary without Nix"

ABI=ambient-abi \
PACKAGE=ambient-package \
ARCH=ambient-arch \
CACHE_KEY_SHA=ambient-cache-key \
VERSION=ambient-version \
REVISION=999 \
EXACT_MAIN_PACKAGE_CACHE_ROOT=ambient-cache-root \
PATH="$(dirname "$nix_bin"):$PATH" \
  bash "$DEV_SHELL" bash -c '
    set -euo pipefail
    for name in \
      ABI PACKAGE ARCH CACHE_KEY_SHA VERSION REVISION \
      EXACT_MAIN_PACKAGE_CACHE_ROOT
    do
      [ -z "${!name+x}" ] || {
        echo "$name crossed the dev-shell boundary as ambient state" >&2
        exit 1
      }
    done
  ' ||
  fail "dev shell did not discard ambient publication admission state"

PATH="$(dirname "$nix_bin"):$PATH" bash "$DEV_SHELL" env \
  ABI=42 \
  PACKAGE=fixture-package \
  ARCH=wasm32 \
  CACHE_KEY_SHA=fixture-cache-key \
  VERSION=1.2.3 \
  REVISION=7 \
  bash -c '
    set -euo pipefail
    [ "$ABI" = 42 ]
    [ "$PACKAGE" = fixture-package ]
    [ "$ARCH" = wasm32 ]
    [ "$CACHE_KEY_SHA" = fixture-cache-key ]
    [ "$VERSION" = 1.2.3 ]
    [ "$REVISION" = 7 ]
  ' ||
  fail "explicit publication admission state did not cross the dev-shell boundary intact"

PATH="$(dirname "$nix_bin"):$PATH" bash "$DEV_SHELL" bash -c '
  set -euo pipefail
  [ "$1" = /tmp/kandelo-exact-main-package-cache-fixture ]
  [[ "$1" = /* ]]
  [ -z "${EXACT_MAIN_PACKAGE_CACHE_ROOT+x}" ]
' exact-main-package-rebuild /tmp/kandelo-exact-main-package-cache-fixture ||
  fail "exact-main cache root did not cross the dev-shell boundary only as an absolute argument"

grep -Fq "if: failure() && steps.provenance.outcome == 'success' && steps.publication.outputs.admitted == 'true' && steps.build.outcome == 'failure'" \
  "$EXACT_REBUILD_ACTION" ||
  fail "non-build or unadmitted failure can still become a failed canonical index entry"

index_writer_count="$(grep -c 'bash scripts/index-update.sh' "$EXACT_REBUILD_ACTION")"
guarded_writer_count="$(
  grep -Fc -- '--canonical-source-sha "${{ inputs.source-sha }}"' \
    "$EXACT_REBUILD_ACTION"
)"
[ "$index_writer_count" -eq "$guarded_writer_count" ] ||
  fail "every force-rebuild canonical index writer must carry exact-main authority"

grep -Fq 'partition-package-matrix \' "$FORCE_REBUILD" ||
  fail "force-rebuild does not partition the selected package closure"
grep -Fq 'selected package closure requires $level_count dependency levels; workflow supports 8' \
  "$FORCE_REBUILD" ||
  fail "force-rebuild does not fail closed when its explicit level bound is exceeded"
if grep -Eq 'lib-matrix-build|library_matrix|program_matrix' "$FORCE_REBUILD"; then
  fail "force-rebuild still splits dependency scheduling by package kind"
fi
for level in $(seq 0 7); do
  grep -Fq "matrix-build-level-$level:" "$FORCE_REBUILD" ||
    fail "force-rebuild lacks explicit dependency level $level"
  grep -Fq "include: \${{ fromJSON(needs.preflight.outputs.level_${level}_matrix) }}" \
    "$FORCE_REBUILD" ||
    fail "dependency level $level does not consume its exact partition"
done
for level in $(seq 1 7); do
  previous=$((level - 1))
  grep -Fq "needs: [gate, preflight, toolchain-cache, matrix-build-level-$previous]" \
    "$FORCE_REBUILD" ||
    fail "dependency level $level does not wait for level $previous"
done
[ "$(grep -Fc 'uses: ./.github/actions/exact-main-package-rebuild' "$FORCE_REBUILD")" -eq 8 ] ||
  fail "every dependency level must use the shared exact-main rebuild action"
[ "$(grep -Fc 'max-parallel: 10' "$FORCE_REBUILD")" -eq 8 ] ||
  fail "each dependency level must retain bounded within-level concurrency"

grep -Fq 'package-dependency-artifacts \' "$EXACT_REBUILD_ACTION" ||
  fail "exact-main package rebuild does not derive direct dependency artifacts"
grep -Fq -- '--no-allow-missing-completed' "$EXACT_REBUILD_ACTION" ||
  fail "exact-main dependency download can fall back after a same-run producer failure"
grep -Fq 'DEPENDENCY_ARTIFACT_ATTEMPTS=1 \' "$EXACT_REBUILD_ACTION" ||
  fail "exact-main dependency download may poll after its producer level completed"
grep -Fq 'DEPENDENCY_ARTIFACT_POLL_SECONDS=0 \' "$EXACT_REBUILD_ACTION" ||
  fail "exact-main dependency download retains an unnecessary retry delay"
grep -Fq -- '--list "$RUNNER_TEMP/package-dependency-artifacts.txt"' \
  "$EXACT_REBUILD_ACTION" ||
  fail "exact-main dependencies are not selected by the graph-owned exact list"

grep -Fq 'exact-main-sysroot-v1-${{ runner.os }}-${{ needs.gate.outputs.source_sha }}-' \
  "$FORCE_REBUILD" ||
  fail "exact-main toolchain cache is not commit-bound"
grep -Fq 'build-deps resolve libcxx --arch "$arch" --force-source-build' \
  "$FORCE_REBUILD" ||
  fail "exact-main toolchain may reuse an older libcxx archive"
if grep -Eq 'ln -s.*libc\\+\\+|ln -s.*include/c\\+\\+/v1' "$FORCE_REBUILD"; then
  fail "exact-main toolchain artifact still contains external libcxx cache symlinks"
fi

grep -Fq -- '--canonical-source-sha) CANONICAL_SOURCE_SHA="$2"; shift 2' \
  "$INDEX_UPDATE" ||
  fail "index-update does not parse exact-main authority"
grep -Fq 'bash .github/scripts/require-exact-kandelo-main.sh' "$INDEX_UPDATE" ||
  fail "index-update does not delegate live-main validation to the tested helper"
grep -Fq '[ "$NORMALIZED_REPOSITORY" != "automattic/kandelo" ]' "$INDEX_UPDATE" ||
  fail "exact-main index mutation is not bound to Automattic/kandelo"
grep -Fq '[ "$IS_CANONICAL" != 1 ]' "$INDEX_UPDATE" ||
  fail "exact-main authority can be misapplied to a noncanonical release"
grep -Fq 'canonical publication requires --canonical-source-sha' "$INDEX_UPDATE" ||
  fail "canonical Automattic/kandelo publication does not fail closed without authority"

ensure_line="$(grep -n '^ensure_release_exists$' "$INDEX_UPDATE" | tail -1 | cut -d: -f1)"
ensure_guard_line="$(
  grep -n '^require_canonical_source_authority$' "$INDEX_UPDATE" |
    awk -F: -v mutation="$ensure_line" '$1 < mutation { line = $1 } END { print line }'
)"
[ -n "$ensure_guard_line" ] && [ "$ensure_guard_line" -lt "$ensure_line" ] ||
  fail "release creation is not preceded by a live-main recheck"

upload_line="$(grep -n '^[[:space:]]*if gh release upload ' "$INDEX_UPDATE" | cut -d: -f1)"
upload_guard_line="$(
  grep -n '^[[:space:]]*require_canonical_source_authority || return 1$' "$INDEX_UPDATE" |
    awk -F: -v mutation="$upload_line" '$1 < mutation { line = $1 } END { print line }'
)"
[ -n "$upload_guard_line" ] && [ "$upload_guard_line" -lt "$upload_line" ] ||
  fail "archive upload is not preceded by a live-main recheck"

canonical_retry_count="$(
  grep -Fc 'gh_retry --canonical-mutation' "$INDEX_UPDATE"
)"
[ "$canonical_retry_count" -eq 3 ] ||
  fail "release creation and archive deletes must recheck main on every retry"
retry_guard_line="$(
  grep -n '! require_canonical_source_authority' "$INDEX_UPDATE" |
    head -1 | cut -d: -f1
)"
retry_command_line="$(
  grep -n '^[[:space:]]*if "\$@"' "$INDEX_UPDATE" |
    head -1 | cut -d: -f1
)"
[ -n "$retry_guard_line" ] && [ -n "$retry_command_line" ] &&
  [ "$retry_guard_line" -lt "$retry_command_line" ] ||
  fail "canonical mutation retry does not recheck main before its command"

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

grep -Fq -- '--canonical-source-sha) CANONICAL_SOURCE_SHA="$2"; shift 2' \
  "$INDEX_STATE" ||
  fail "release-index transaction does not parse exact-main authority"
index_state_thread_count="$(
  grep -Fc -- '"${index_state_authority_args[@]}"' "$INDEX_UPDATE"
)"
[ "$index_state_thread_count" -eq 2 ] ||
  fail "canonical index read and publish must both carry exact-main authority"
for mutation in \
  'gh release upload "$TARGET_TAG"' \
  'gh api --method PATCH' \
  'gh api --method DELETE'
do
  mutation_line="$(grep -nF "$mutation" "$INDEX_STATE" | head -1 | cut -d: -f1)"
  guard_line="$(
    grep -n '^[[:space:]]*require_canonical_source_authority || return 1$' "$INDEX_STATE" |
      awk -F: -v mutation="$mutation_line" '$1 < mutation { line = $1 } END { print line }'
  )"
  [ -n "$guard_line" ] && [ "$guard_line" -lt "$mutation_line" ] ||
    fail "release-index mutation is not preceded by a live-main recheck: $mutation"
done

for input in source-repository source-commit; do
  grep -A3 "^  $input:" "$ARCHIVE_ACTION" | grep -Fq 'required: true' ||
    fail "archive action input $input must be required"
  grep -Fq -- "--$input \"\${{ inputs.$input }}\"" "$ARCHIVE_ACTION" ||
    fail "archive action does not pass required input $input to archive-stage"
done

archive_provenance_block="$(
  awk '
    /- name: Compute commit-bound build provenance/ { inside = 1 }
    inside && /- name: Fetch musl submodule/ { exit }
    inside { print }
  ' "$ARCHIVE_ACTION"
)"
for checkout_binding in \
  'EXPECTED_SOURCE_REPOSITORY: ${{ github.server_url }}/${{ github.repository }}' \
  'SOURCE_COMMIT: ${{ inputs.source-commit }}' \
  'SOURCE_REPOSITORY: ${{ inputs.source-repository }}' \
  'WORKSPACE_ROOT: ${{ github.workspace }}' \
  'git rev-parse --show-toplevel' \
  "git rev-parse --verify 'HEAD^{commit}'" \
  '[ "$checkout_root" != "$workspace_root" ]' \
  '[ "$SOURCE_REPOSITORY" != "$EXPECTED_SOURCE_REPOSITORY" ]' \
  '[ "$checkout_commit" != "$SOURCE_COMMIT" ]' \
  'git status --porcelain=v1 --untracked-files=all'
do
  grep -Fq "$checkout_binding" <<<"$archive_provenance_block" ||
    fail "archive action does not bind its source stamp to the checkout: $checkout_binding"
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
