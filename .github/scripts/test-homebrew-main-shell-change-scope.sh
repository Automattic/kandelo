#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLASSIFIER="$REPO_ROOT/.github/scripts/homebrew-main-shell-change-scope.sh"
WORKFLOW_DIR="$REPO_ROOT/.github/workflows"
WORKFLOW="$WORKFLOW_DIR/homebrew-main-shell-ci.yml"
NATIVE_WORKFLOW="$WORKFLOW_DIR/homebrew-native-publisher-compatibility.yml"
STAGING_WORKFLOW="$WORKFLOW_DIR/staging-build.yml"
SCOPE_ACTION="$REPO_ROOT/.github/actions/detect-change-scope/action.yml"
PUBLISHER_TEST="$REPO_ROOT/scripts/test-homebrew-publish-workflow.sh"
PATCHED_LAUNCHER_TEST="$REPO_ROOT/scripts/test-homebrew-patched-launcher.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-homebrew-main-shell-change-scope: $*" >&2
  exit 1
}

FIXTURE="$TMP_ROOT/repo"
git init -q "$FIXTURE"
git -C "$FIXTURE" config user.email test@example.invalid
git -C "$FIXTURE" config user.name "Homebrew shell scope test"

fixture_paths=(
  .github/scripts/homebrew-main-shell-change-scope.sh
  .github/workflows/homebrew-main-shell-ci.yml
  .github/workflows/homebrew-native-publisher-compatibility.yml
  .github/workflows/reusable-homebrew-main-shell-mirror-publish.yml
  homebrew/kandelo-guest-layout.json
  homebrew/homebrew-native-compatibility-lock.json
  homebrew/main-shell-migration-lock.json
  homebrew/patches/0001-add-kandelo-wasm-bottle-tags-prefix-campaign.patch
  packages/registry/bash/build.toml
  scripts/check-homebrew-publish-workflow-trust.rb
  scripts/homebrew-compose-formula-bottle.rb
  scripts/homebrew-create-build-handoff.sh
  scripts/homebrew-generate-sidecars-from-env.sh
  scripts/homebrew-guest-layout.sh
  scripts/homebrew-native-api-preflight.sh
  scripts/homebrew-merge-bottle-json.sh
  scripts/homebrew-oci-layout.py
  scripts/homebrew-patched-launcher.sh
  scripts/homebrew-tap-recipe-runner.py
  scripts/homebrew-validate-publish-handoff.sh
  scripts/homebrew-validate-upload-receipt.sh
  scripts/test-homebrew-native-api-contract.sh
  scripts/homebrew-inspect-bottle.py
  scripts/homebrew-validate-build-handoff.sh
  scripts/test-homebrew-inspect-bottle.sh
  scripts/test-homebrew-patched-launcher.sh
  scripts/test-homebrew-prefix-campaign-layout.sh
  scripts/test-homebrew-publish-workflow.sh
  scripts/test-homebrew-tap-recipe-runner.py
  tools/xtask/src/homebrew_guest_layout.rs
  tools/xtask/src/homebrew_sidecars.rs
  tools/xtask/src/homebrew_validate.rs
  tools/xtask/src/main.rs
)
for path in "${fixture_paths[@]}"; do
  mkdir -p "$FIXTURE/$(dirname "$path")"
  printf 'base %s\n' "$path" >"$FIXTURE/$path"
done
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm base
BASE="$(git -C "$FIXTURE" rev-parse HEAD)"

reset_fixture() {
  git -C "$FIXTURE" reset -q --hard "$BASE"
  git -C "$FIXTURE" clean -qfd
}

commit_change() {
  local path="$1"
  mkdir -p "$FIXTURE/$(dirname "$path")"
  printf 'changed %s\n' "$path" >>"$FIXTURE/$path"
}

finish_change() {
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -qm fixture
  git -C "$FIXTURE" rev-parse HEAD
}

assert_scope() {
  local expected="$1"
  local event="$2"
  local base="${3:-}"
  local head="${4:-}"
  local reason_fragment="${5:-}"
  local output="$TMP_ROOT/output-$RANDOM"
  local args=(--event "$event" --output "$output")
  [ -z "$base" ] || args+=(--base "$base")
  [ -z "$head" ] || args+=(--head "$head")
  (
    cd "$FIXTURE"
    bash "$CLASSIFIER" "${args[@]}"
  ) >/dev/null
  grep -Fxq "required=$expected" "$output" ||
    fail "$event scope was not $expected: $(cat "$output")"
  if [ -n "$reason_fragment" ]; then
    grep -Fq "$reason_fragment" "$output" ||
      fail "$event reason did not contain $reason_fragment: $(cat "$output")"
  fi
}

# PR #1145 changes only native publisher preparation and its direct contract
# test. It cannot change an already-published shell image or either host.
reset_fixture
commit_change scripts/homebrew-native-api-preflight.sh
commit_change scripts/test-homebrew-native-api-contract.sh
HEAD="$(finish_change)"
assert_scope false pull_request "$BASE" "$HEAD" \
  "diff is limited to audited publisher-only"

# The compatibility lock records signed-API input for native publication.
# It is not read while composing or booting already-published shell bytes.
reset_fixture
commit_change homebrew/homebrew-native-compatibility-lock.json
HEAD="$(finish_change)"
assert_scope false pull_request "$BASE" "$HEAD" \
  "diff is limited to audited publisher-only"

# A lock refresh must not hide a product change in the same diff.
reset_fixture
commit_change homebrew/homebrew-native-compatibility-lock.json
commit_change host/src/kernel-worker.ts
HEAD="$(finish_change)"
assert_scope true pull_request "$BASE" "$HEAD" \
  "host/src/kernel-worker.ts"

# These four files implement and test the privileged Formula boundary. They
# are not consumed while composing or booting an already-published image, but
# every path must remain fail-closed when one product path joins the diff.
publisher_boundary_paths=(
  scripts/homebrew-patched-launcher.sh
  scripts/homebrew-tap-recipe-runner.py
  scripts/test-homebrew-patched-launcher.sh
  scripts/test-homebrew-tap-recipe-runner.py
)
for path in "${publisher_boundary_paths[@]}"; do
  reset_fixture
  commit_change "$path"
  HEAD="$(finish_change)"
  assert_scope false pull_request "$BASE" "$HEAD" \
    "diff is limited to audited publisher-only"

  reset_fixture
  commit_change "$path"
  commit_change host/src/kernel-worker.ts
  HEAD="$(finish_change)"
  assert_scope true pull_request "$BASE" "$HEAD" \
    "host/src/kernel-worker.ts"
done

# Exercise the exact combined diagnostic and private-ancestor repair shape.
# Its tests and static trust checker remain part of the mandatory publisher
# preflight pinned below.
reset_fixture
for path in \
  scripts/check-homebrew-publish-workflow-trust.rb \
  scripts/homebrew-native-api-preflight.sh \
  scripts/homebrew-patched-launcher.sh \
  scripts/homebrew-tap-recipe-runner.py \
  scripts/test-homebrew-patched-launcher.sh \
  scripts/test-homebrew-tap-recipe-runner.py
do
  commit_change "$path"
done
HEAD="$(finish_change)"
assert_scope false pull_request "$BASE" "$HEAD" \
  "diff is limited to audited publisher-only"

# The publisher-only part of PR #1144 is also safe independently.
reset_fixture
commit_change scripts/homebrew-inspect-bottle.py
commit_change scripts/homebrew-validate-build-handoff.sh
commit_change scripts/test-homebrew-publish-workflow.sh
commit_change tools/xtask/src/homebrew_validate.rs
HEAD="$(finish_change)"
assert_scope false pull_request "$BASE" "$HEAD" \
  "diff is limited to audited publisher-only"

# The complete PR #1144 shape includes new target-layout authority and the
# shared xtask command dispatcher. Both remain outside the audited neutral
# set: the final activation will consume the former, while a path classifier
# cannot prove that an arbitrary dispatcher edit is inert.
reset_fixture
for path in \
  homebrew/kandelo-guest-layout.json \
  homebrew/patches/0001-add-kandelo-wasm-bottle-tags-prefix-campaign.patch \
  scripts/homebrew-compose-formula-bottle.rb \
  scripts/homebrew-create-build-handoff.sh \
  scripts/homebrew-generate-sidecars-from-env.sh \
  scripts/homebrew-guest-layout.sh \
  scripts/homebrew-inspect-bottle.py \
  scripts/homebrew-merge-bottle-json.sh \
  scripts/homebrew-oci-layout.py \
  scripts/homebrew-validate-build-handoff.sh \
  scripts/homebrew-validate-publish-handoff.sh \
  scripts/homebrew-validate-upload-receipt.sh \
  scripts/test-homebrew-inspect-bottle.sh \
  scripts/test-homebrew-prefix-campaign-layout.sh \
  scripts/test-homebrew-publish-workflow.sh \
  tools/xtask/src/homebrew_guest_layout.rs \
  tools/xtask/src/homebrew_sidecars.rs \
  tools/xtask/src/homebrew_validate.rs \
  tools/xtask/src/main.rs
do
  commit_change "$path"
done
HEAD="$(finish_change)"
assert_scope true pull_request "$BASE" "$HEAD" \
  "homebrew/kandelo-guest-layout.json"

# Even without the target-layout files, the shared command entrypoint forces
# the proof.
reset_fixture
commit_change tools/xtask/src/homebrew_validate.rs
commit_change tools/xtask/src/main.rs
HEAD="$(finish_change)"
assert_scope true pull_request "$BASE" "$HEAD" "tools/xtask/src/main.rs"

# One product path in an otherwise publisher-only diff must win.
reset_fixture
commit_change scripts/homebrew-native-api-preflight.sh
commit_change host/src/kernel-worker.ts
HEAD="$(finish_change)"
assert_scope true pull_request "$BASE" "$HEAD" "host/src/kernel-worker.ts"

# Renames inspect both identities. Moving within the audited set is neutral;
# moving into an unknown namespace is not.
reset_fixture
git -C "$FIXTURE" mv scripts/homebrew-native-api-preflight.sh \
  scripts/homebrew-publish-sidecars.sh
HEAD="$(finish_change)"
assert_scope false pull_request "$BASE" "$HEAD"

reset_fixture
git -C "$FIXTURE" mv scripts/homebrew-native-api-preflight.sh \
  scripts/homebrew-main-shell-new-input.sh
HEAD="$(finish_change)"
assert_scope true pull_request "$BASE" "$HEAD" \
  "scripts/homebrew-main-shell-new-input.sh"

# Deleting an audited publisher helper is neutral. Deleting a shell contract
# or package input still requires exact composition and boot.
reset_fixture
rm "$FIXTURE/scripts/homebrew-native-api-preflight.sh"
HEAD="$(finish_change)"
assert_scope false pull_request "$BASE" "$HEAD"

reset_fixture
rm "$FIXTURE/homebrew/main-shell-migration-lock.json"
HEAD="$(finish_change)"
assert_scope true pull_request "$BASE" "$HEAD" \
  "homebrew/main-shell-migration-lock.json"

assert_scope true pull_request "$BASE" "$BASE" \
  "empty pull-request diff fails closed"
assert_scope true pull_request deadbeef "$BASE" \
  "pull-request revision is not an exact commit identity"
assert_scope true pull_request \
  0000000000000000000000000000000000000000 "$BASE" \
  "pull-request revision cannot be resolved"
assert_scope true push "" "" "push always validates"
assert_scope true workflow_dispatch "" "" \
  "workflow_dispatch always validates"
assert_scope true schedule "" "" "unknown event schedule fails closed"

for forced_path in \
  .github/scripts/homebrew-main-shell-change-scope.sh \
  .github/workflows/homebrew-main-shell-ci.yml \
  .github/workflows/reusable-homebrew-main-shell-mirror-publish.yml \
  homebrew/main-shell-migration-lock.json \
  packages/registry/bash/build.toml \
  libc/musl-overlay/src/process/posix_spawn.c \
  tools/xtask/src/main.rs
do
  reset_fixture
  commit_change "$forced_path"
  HEAD="$(finish_change)"
  assert_scope true pull_request "$BASE" "$HEAD" "$forced_path"
done

# Keep the existing branch-protection check name on the always-running
# aggregation job. The expensive implementation job is conditional, while
# explicit main/campaign events remain mandatory through the classifier.
[ "$(grep -Fc 'name: exact current lazy shell (Node + Chromium)' \
  "$WORKFLOW")" -eq 1 ] ||
  fail "the stable exact-shell check name must appear exactly once"
grep -Fq 'if: needs.homebrew-main-shell-scope.outputs.required == '\''true'\''' \
  "$WORKFLOW" ||
  fail "the expensive exact-shell job is not scope-gated"
grep -Fq 'if: always()' "$WORKFLOW" ||
  fail "the stable exact-shell gate is not always present"
grep -Fq 'needs.exact-public-bottle-closure.result' "$WORKFLOW" ||
  fail "the stable exact-shell gate does not propagate implementation failure"

grep -Fq '      - homebrew/**' "$NATIVE_WORKFLOW" ||
  fail "native compatibility workflow does not own lock refreshes"
grep -Fq 'homebrew/homebrew-native-compatibility-lock.json' \
  "$NATIVE_WORKFLOW" ||
  fail "native compatibility workflow does not verify the reviewed lock"

grep -Fq 'homebrew_publisher_only_changed:' "$SCOPE_ACTION" ||
  fail "staging scope does not expose its publisher-only result"
grep -Fq \
  '.github/scripts/homebrew-main-shell-change-scope.sh' \
  "$SCOPE_ACTION" ||
  fail "staging scope does not reuse the exact-shell classifier"

staging_route="$(
  sed -n \
    '/- name: Route publisher-only validation/,/^  preflight:/p' \
    "$STAGING_WORKFLOW"
)"
# shellcheck disable=SC2016
grep -Fq 'if [ "$HOMEBREW_PUBLISHER_ONLY" = true ]; then' \
  <<<"$staging_route" ||
  fail "staging does not recognize a publisher-only diff"
grep -Fq 'echo "test_gate_required=false"' <<<"$staging_route" ||
  fail "staging does not suppress its generic test gate for publisher-only diffs"

staging_preflight_condition="$(
  sed -n '/^  preflight:/,/^    runs-on:/p' "$STAGING_WORKFLOW"
)"
grep -Fq \
  "needs.change-scope.outputs.homebrew_publisher_only_changed == 'true'" \
  <<<"$staging_preflight_condition" ||
  fail "publisher-only staging no longer runs the complete publisher preflight"
staging_preflight="$(
  sed -n '/^  preflight:/,/^  package-staging-not-required:/p' \
    "$STAGING_WORKFLOW"
)"
grep -Fq 'bash scripts/test-homebrew-publish-workflow.sh' \
  <<<"$staging_preflight" ||
  fail "publisher-only staging lost the complete publisher contract"
grep -Fq \
  'bash "$REPO_ROOT/scripts/test-homebrew-prefix-campaign-layout.sh"' \
  "$PUBLISHER_TEST" ||
  fail "publisher-only staging lost its guest-layout contract evidence"
grep -Fq \
  'bash "$REPO_ROOT/scripts/test-homebrew-patched-launcher.sh"' \
  "$PUBLISHER_TEST" ||
  fail "publisher-only staging lost its launcher isolation evidence"
grep -Fq \
  'ruby "$REPO_ROOT/scripts/check-homebrew-publish-workflow-trust.rb"' \
  "$PUBLISHER_TEST" ||
  fail "publisher-only staging lost its static trust evidence"
grep -Fq \
  'python3 "$REPO_ROOT/scripts/test-homebrew-tap-recipe-runner.py"' \
  "$PATCHED_LAUNCHER_TEST" ||
  fail "publisher-only staging lost its recipe supervisor evidence"

staging_noop_condition="$(
  sed -n \
    '/^  package-staging-not-required:/,/^    runs-on:/p' \
    "$STAGING_WORKFLOW"
)"
grep -Fq \
  "needs.change-scope.outputs.homebrew_publisher_only_changed != 'true'" \
  <<<"$staging_noop_condition" ||
  fail "publisher-only staging can race the generic no-op status writer"

echo "test-homebrew-main-shell-change-scope: ok"
