#!/usr/bin/env bash
set -euo pipefail

ACTION_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=.github/actions/detect-change-scope/ci-scope-paths.sh
. "$ACTION_DIR/ci-scope-paths.sh"

filter_with() {
  local fn="$1"
  shift
  printf '%s\n' "$@" | "$fn"
}

assert_matches() {
  local fn="$1" path="$2"
  shift 2
  local out
  out="$(filter_with "$fn" "$@")"
  if ! printf '%s\n' "$out" | grep -qx "$path"; then
    echo "expected $fn to match: $path" >&2
    echo "output:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

assert_not_matches() {
  local fn="$1" path="$2"
  shift 2
  local out
  out="$(filter_with "$fn" "$@")"
  if printf '%s\n' "$out" | grep -qx "$path"; then
    echo "expected $fn to ignore: $path" >&2
    echo "output:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

assert_matches package_archive_changed_files \
  "tools/xtask/src/build_deps.rs" \
  "tools/xtask/src/build_deps.rs"
assert_matches package_archive_changed_files \
  "tools/xtask/src/package_archive_name.rs" \
  "tools/xtask/src/package_archive_name.rs"
assert_not_matches package_archive_changed_files \
  "tools/xtask/src/remote_fetch.rs" \
  "tools/xtask/src/remote_fetch.rs"
assert_not_matches package_archive_changed_files \
  "scripts/fetch-binaries.sh" \
  "scripts/fetch-binaries.sh"
assert_not_matches package_archive_changed_files \
  "packages/registry/php/test/php.test.ts" \
  "packages/registry/php/test/php.test.ts"
# An index-only refresh changes consumer policy, not package build inputs. It
# must skip both conventional package matrices while still reaching the
# materialization-driven test gate below.
assert_not_matches package_archive_changed_files \
  "packages/registry/program-packages.json" \
  "packages/registry/program-packages.json"
assert_not_matches package_archive_changed_files \
  "tests/sortix/os-test/include/sys/socket.c" \
  "tests/sortix/os-test/include/sys/socket.c"
assert_matches package_archive_changed_files \
  ".github/actions/package-archive-build/action.yml" \
  ".github/actions/package-archive-build/action.yml"
assert_matches package_archive_changed_files \
  ".github/actions/package-toolchain/action.yml" \
  ".github/actions/package-toolchain/action.yml"
assert_matches package_archive_changed_files \
  ".github/actions/fetch-submodules/action.yml" \
  ".github/actions/fetch-submodules/action.yml"
assert_matches package_archive_changed_files \
  "host/src/vfs/memory-fs.ts" \
  "host/src/vfs/memory-fs.ts"
assert_matches package_archive_changed_files \
  "host/src/vfs/sharedfs-vendor.ts" \
  "host/src/vfs/sharedfs-vendor.ts"
# The shell package lists the exact host-side Homebrew/VFS source closure in
# build.toml. Every member must stage a replacement shell archive.
for shell_host_input in \
  host/src/constants.ts \
  host/src/generated/abi.ts \
  host/src/homebrew-vfs-fetch.ts \
  host/src/homebrew-vfs-planner.ts \
  host/src/pathconf.ts \
  host/src/statfs.ts \
  host/src/types.ts \
  host/src/vfs/image-helpers.ts \
  host/src/vfs/memory-fs.ts \
  host/src/vfs/sharedfs-vendor.ts \
  host/src/vfs/types.ts \
  host/src/vfs/zip.ts
do
  assert_matches package_archive_changed_files \
    "$shell_host_input" \
    "$shell_host_input"
done
assert_matches package_archive_changed_files \
  "images/rootfs/etc/profile" \
  "images/rootfs/etc/profile"
# The closed-selection inputs have moved from conventional package ownership
# to the exact Homebrew product gate. Prove both halves of that route: the
# build.toml matcher still sees each declared historical dependency, while the
# final archive classifier removes only these reviewed product-owned paths.
homebrew_declared_product_inputs=(
  homebrew/main-shell-homebrew-runtime-support.json
  homebrew/main-shell-lazy-artifact-lock.json
  homebrew/main-shell-selection-lock.json
  host/src/homebrew-runtime-support-materializer.ts
  host/src/homebrew-runtime-support.ts
  host/src/homebrew-vfs-builder.ts
  scripts/check-homebrew-main-shell-brewfile.mjs
  scripts/homebrew-prefix-campaign-executor.py
)
homebrew_product_inputs=(
  "${homebrew_declared_product_inputs[@]}"
  images/vfs/scripts/build-homebrew-flat-vfs-image.ts
)
for homebrew_product_input in "${homebrew_declared_product_inputs[@]}"; do
  assert_matches package_declared_build_input_changed_files \
    "$homebrew_product_input" \
    "$homebrew_product_input"
done
for homebrew_product_input in "${homebrew_product_inputs[@]}"; do
  assert_matches homebrew_product_owned_package_input_changed_files \
    "$homebrew_product_input" \
    "$homebrew_product_input"
  assert_not_matches package_archive_changed_files \
    "$homebrew_product_input" \
    "$homebrew_product_input"
done
assert_not_matches homebrew_product_owned_package_input_changed_files \
  "scripts/homebrew-main-shell-selection-lock.py" \
  "scripts/homebrew-main-shell-selection-lock.py"
# A real conventional recipe change in the same diff must still stage. The
# ownership route is not a Homebrew prefix wildcard or a whole-diff escape.
assert_matches package_archive_changed_files \
  "packages/registry/shell/build-shell.sh" \
  "${homebrew_product_inputs[@]}" \
  "packages/registry/shell/build-shell.sh"
for homebrew_product_input in "${homebrew_product_inputs[@]}"; do
  assert_not_matches package_archive_changed_files \
    "$homebrew_product_input" \
    "${homebrew_product_inputs[@]}" \
    "packages/registry/shell/build-shell.sh"
done
# This classifier is intentionally aggregated across the package registry.
# WordPress and LAMP boot the host runtime while building their derived VFS
# images, so their recursive host/src input makes these changes package inputs
# even though the shell package itself does not consume them.
assert_matches package_archive_changed_files \
  "host/src/process.ts" \
  "host/src/process.ts"
assert_matches package_archive_changed_files \
  "host/src/kernel-worker.ts" \
  "host/src/kernel-worker.ts"
assert_not_matches package_archive_changed_files \
  ".github/workflows/staging-build.yml" \
  ".github/workflows/staging-build.yml"
assert_not_matches package_archive_changed_files \
  ".github/workflows/prepare-merge.yml" \
  ".github/workflows/prepare-merge.yml"
for exact_abi_classifier in \
  .github/scripts/classify-exact-abi-staging.sh \
  .github/scripts/test-classify-exact-abi-staging.sh; do
  assert_matches ci_control_changed_files \
    "$exact_abi_classifier" \
    "$exact_abi_classifier"
  assert_not_matches package_archive_changed_files \
    "$exact_abi_classifier" \
    "$exact_abi_classifier"
done

assert_matches binary_materialization_changed_files \
  "tools/xtask/src/remote_fetch.rs" \
  "tools/xtask/src/remote_fetch.rs"
assert_matches binary_materialization_changed_files \
  "packages/registry/program-packages.json" \
  "packages/registry/program-packages.json"
# Keep the action-level routing coupled to the classifiers above: index-only
# changes skip package staging, but binary materialization makes the runtime
# test gate mandatory.
grep -Fq \
  '[ "$binary_materialization_changed" = '\''true'\'' ]' \
  "$ACTION_DIR/action.yml"
grep -Fq \
  'emit_bool package_staging_required "$package_archive_changed"' \
  "$ACTION_DIR/action.yml"
# Product-owned transition inputs must keep the non-package test gate and the
# exact Homebrew shell proof even though they skip conventional staging.
grep -Fq \
  '[ "$homebrew_product_changed" = '\''true'\'' ]' \
  "$ACTION_DIR/action.yml"
grep -Fq \
  'Homebrew product-owned input escaped the exact product gate' \
  "$ACTION_DIR/action.yml"
for package_index_contract in \
  tools/xtask/src/index_candidate.rs \
  tools/xtask/src/index_toml.rs \
  tools/xtask/src/package_archive_name.rs; do
  assert_matches binary_materialization_changed_files \
    "$package_index_contract" \
    "$package_index_contract"
done
assert_matches binary_materialization_changed_files \
  "scripts/fetch-binaries.sh" \
  "scripts/fetch-binaries.sh"
assert_matches binary_materialization_changed_files \
  "scripts/pack-ci-test-workspace.sh" \
  "scripts/pack-ci-test-workspace.sh"
for blocker_materialization_script in \
  scripts/activate-local-shell-build-override.sh \
  scripts/ci-homebrew-browser-mirror-state.sh \
  scripts/install-local-shell-artifact.sh \
  scripts/materialize-ci-canonical-package-index.sh \
  scripts/materialize-ci-publication-blockers.sh \
  scripts/validate-publication-blocker-report.sh; do
  assert_matches binary_materialization_changed_files \
    "$blocker_materialization_script" \
    "$blocker_materialization_script"
done
assert_matches binary_materialization_changed_files \
  "scripts/stage-portable-resolver-binaries.sh" \
  "scripts/stage-portable-resolver-binaries.sh"
assert_matches binary_materialization_changed_files \
  "scripts/materialize-resolver-binaries.sh" \
  "scripts/materialize-resolver-binaries.sh"
assert_matches binary_materialization_changed_files \
  "scripts/wasm-artifact-guards.sh" \
  "scripts/wasm-artifact-guards.sh"
assert_matches binary_materialization_changed_files \
  "scripts/test-wasm-artifact-guards.sh" \
  "scripts/test-wasm-artifact-guards.sh"
assert_matches binary_materialization_changed_files \
  "scripts/vfs-has-stale-abi.mjs" \
  "scripts/vfs-has-stale-abi.mjs"
for resolver_input in \
  host/src/binary-resolver.ts \
  scripts/resolve-binary.ts \
  scripts/resolve-binary.bundle.mjs \
  scripts/resolve-binary.bundle.LICENSES.txt \
  scripts/build-resolve-binary-bundle.sh \
  scripts/test-resolve-binary-bundle.sh; do
  assert_matches binary_materialization_changed_files \
    "$resolver_input" \
    "$resolver_input"
done
assert_matches binary_materialization_changed_files \
  "tests/package-system/fetch-binaries-allow-stale.test.ts" \
  "tests/package-system/fetch-binaries-allow-stale.test.ts"

assert_matches package_publish_flow_changed_files \
  "scripts/index-update.sh" \
  "scripts/index-update.sh"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/index_update.rs" \
  "tools/xtask/src/index_update.rs"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/index_candidate.rs" \
  "tools/xtask/src/index_candidate.rs"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/package_archive_name.rs" \
  "tools/xtask/src/package_archive_name.rs"
assert_matches package_publish_flow_changed_files \
  "tests/scripts/index-update.sh" \
  "tests/scripts/index-update.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/activate-merge-candidate.sh" \
  ".github/scripts/activate-merge-candidate.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-activate-merge-candidate.sh" \
  ".github/scripts/test-activate-merge-candidate.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/find-release-by-tag.sh" \
  ".github/scripts/find-release-by-tag.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-find-release-by-tag.sh" \
  ".github/scripts/test-find-release-by-tag.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/clone-rejected-merge-candidate.sh" \
  ".github/scripts/clone-rejected-merge-candidate.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-clone-rejected-merge-candidate.sh" \
  ".github/scripts/test-clone-rejected-merge-candidate.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/reconcile-merge-candidates.sh" \
  ".github/scripts/reconcile-merge-candidates.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-reconcile-merge-candidates.sh" \
  ".github/scripts/test-reconcile-merge-candidates.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/cleanup-merge-candidates.sh" \
  ".github/scripts/cleanup-merge-candidates.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/delete-writable-release.sh" \
  ".github/scripts/delete-writable-release.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-delete-writable-release.sh" \
  ".github/scripts/test-delete-writable-release.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/require-exact-head-approval.sh" \
  ".github/scripts/require-exact-head-approval.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/require-exact-kandelo-main.sh" \
  ".github/scripts/require-exact-kandelo-main.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-require-exact-kandelo-main.sh" \
  ".github/scripts/test-require-exact-kandelo-main.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-exact-main-package-publication.sh" \
  ".github/scripts/test-exact-main-package-publication.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/latest-merge-gate-status.sh" \
  ".github/scripts/latest-merge-gate-status.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/fetch-canonical-index.sh" \
  ".github/scripts/fetch-canonical-index.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/select-package-archive-source.sh" \
  ".github/scripts/select-package-archive-source.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/download-verified-release-asset.sh" \
  ".github/scripts/download-verified-release-asset.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-select-package-archive-source.sh" \
  ".github/scripts/test-select-package-archive-source.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-download-verified-release-asset.sh" \
  ".github/scripts/test-download-verified-release-asset.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/validate-staging-release.sh" \
  ".github/scripts/validate-staging-release.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/compose-staging-release-snapshots.sh" \
  ".github/scripts/compose-staging-release-snapshots.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/split-staging-package-ledger.sh" \
  ".github/scripts/split-staging-package-ledger.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-split-staging-package-ledger.sh" \
  ".github/scripts/test-split-staging-package-ledger.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-validate-staging-release.sh" \
  ".github/scripts/test-validate-staging-release.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/package-generation.py" \
  ".github/scripts/package-generation.py"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/prepare-durable-package-generation.sh" \
  ".github/scripts/prepare-durable-package-generation.sh"
for authority_validator_script in \
  .github/scripts/prepare-current-authority-validator.sh \
  .github/scripts/test-prepare-current-authority-validator.sh; do
  assert_not_matches package_archive_changed_files \
    "$authority_validator_script" \
    "$authority_validator_script"
  assert_matches package_publish_flow_changed_files \
    "$authority_validator_script" \
    "$authority_validator_script"
done
assert_matches package_publish_flow_changed_files \
  ".github/scripts/prepare-preserved-pr-package-generation.sh" \
  ".github/scripts/prepare-preserved-pr-package-generation.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/verify-preserved-package-source.sh" \
  ".github/scripts/verify-preserved-package-source.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/classify-pr-staging.sh" \
  ".github/scripts/classify-pr-staging.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-classify-pr-staging.sh" \
  ".github/scripts/test-classify-pr-staging.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/materialize-exact-package-generations.sh" \
  ".github/scripts/materialize-exact-package-generations.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-materialize-exact-package-generations.sh" \
  ".github/scripts/test-materialize-exact-package-generations.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/materialize-durable-package-generation.sh" \
  ".github/scripts/materialize-durable-package-generation.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/publish-durable-package-generation.sh" \
  ".github/scripts/publish-durable-package-generation.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-package-generation.sh" \
  ".github/scripts/test-package-generation.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-publish-durable-package-generation.sh" \
  ".github/scripts/test-publish-durable-package-generation.sh"
assert_matches package_publish_flow_changed_files \
  ".github/workflows/promote-package-generation.yml" \
  ".github/workflows/promote-package-generation.yml"
assert_matches package_publish_flow_changed_files \
  ".github/workflows/preserve-pr-package-generation.yml" \
  ".github/workflows/preserve-pr-package-generation.yml"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/staging_reuse.rs" \
  "tools/xtask/src/staging_reuse.rs"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/build_deps.rs" \
  "tools/xtask/src/build_deps.rs"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/pkg_manifest.rs" \
  "tools/xtask/src/pkg_manifest.rs"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/publication_policy.rs" \
  "tools/xtask/src/publication_policy.rs"
assert_matches package_archive_changed_files \
  "tools/xtask/src/publication_policy.rs" \
  "tools/xtask/src/publication_policy.rs"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/recover-canonical-indexes.sh" \
  ".github/scripts/recover-canonical-indexes.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-recover-canonical-indexes.sh" \
  ".github/scripts/test-recover-canonical-indexes.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/state-lock.sh" \
  ".github/scripts/state-lock.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-state-lock.sh" \
  ".github/scripts/test-state-lock.sh"
assert_matches package_publish_flow_changed_files \
  ".github/actions/detect-change-scope/ci-scope-paths.sh" \
  ".github/actions/detect-change-scope/ci-scope-paths.sh"
assert_matches package_publish_flow_changed_files \
  ".github/actions/detect-change-scope/test-ci-scope-paths.sh" \
  ".github/actions/detect-change-scope/test-ci-scope-paths.sh"
assert_matches package_publish_flow_changed_files \
  "scripts/release-index-state.sh" \
  "scripts/release-index-state.sh"
assert_not_matches package_archive_changed_files \
  "scripts/homebrew-rootfs-publication-selection.sh" \
  "scripts/homebrew-rootfs-publication-selection.sh"
assert_matches package_publish_flow_changed_files \
  "scripts/homebrew-rootfs-publication-selection.sh" \
  "scripts/homebrew-rootfs-publication-selection.sh"
assert_not_matches package_archive_changed_files \
  "scripts/test-homebrew-rootfs-publication-selection.sh" \
  "scripts/test-homebrew-rootfs-publication-selection.sh"
assert_matches package_publish_flow_changed_files \
  "scripts/test-homebrew-rootfs-publication-selection.sh" \
  "scripts/test-homebrew-rootfs-publication-selection.sh"
assert_matches package_publish_flow_changed_files \
  "tests/scripts/release-index-state.sh" \
  "tests/scripts/release-index-state.sh"
assert_matches package_publish_flow_changed_files \
  "tests/scripts/package-publish-flow.sh" \
  "tests/scripts/package-publish-flow.sh"
assert_matches package_publish_flow_changed_files \
  ".github/workflows/prepare-merge.yml" \
  ".github/workflows/prepare-merge.yml"
assert_matches package_publish_flow_changed_files \
  ".github/workflows/staging-cleanup.yml" \
  ".github/workflows/staging-cleanup.yml"
assert_matches package_publish_flow_changed_files \
  ".github/workflows/force-rebuild.yml" \
  ".github/workflows/force-rebuild.yml"
assert_matches package_publish_flow_changed_files \
  ".github/actions/exact-main-package-rebuild/action.yml" \
  ".github/actions/exact-main-package-rebuild/action.yml"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/package_matrix.rs" \
  "tools/xtask/src/package_matrix.rs"
assert_matches package_publish_flow_changed_files \
  ".github/workflows/reusable-package-source-publish.yml" \
  ".github/workflows/reusable-package-source-publish.yml"
assert_not_matches package_publish_flow_changed_files \
  "tools/xtask/src/remote_fetch.rs" \
  "tools/xtask/src/remote_fetch.rs"

# The protected request feed is publication and CI control machinery. Changes
# must exercise those focused gates without rebuilding unrelated package
# archives.
abi_staging_request_control_paths=(
  .github/workflows/abi-staging-request-feed.yml
  .github/scripts/publish-abi-staging-request.sh
  .github/scripts/test-publish-abi-staging-request.sh
  scripts/check-abi-staging-request-workflow.rb
  scripts/test-abi-staging-request-feed.sh
)
for abi_staging_request_control_path in "${abi_staging_request_control_paths[@]}"; do
  assert_matches package_publish_flow_changed_files \
    "$abi_staging_request_control_path" \
    "$abi_staging_request_control_path"
  assert_matches ci_control_changed_files \
    "$abi_staging_request_control_path" \
    "$abi_staging_request_control_path"
  assert_not_matches package_archive_changed_files \
    "$abi_staging_request_control_path" \
    "$abi_staging_request_control_path"
done

# Exact-head Check publication and merge enforcement are protected CI control
# surfaces. They must rerun publication/control validation without pretending
# that their source files are portable package archives.
abi_staging_check_control_paths=(
  .github/workflows/abi-staging-merge-gate.yml
  .github/workflows/abi-staging-pr-check.yml
  .github/scripts/update-abi-staging-check.sh
  .github/scripts/test-update-abi-staging-check.sh
  abi/staging/required-check-activation.toml
  scripts/check-abi-staging-pr-check-workflow.rb
)
for abi_staging_check_control_path in "${abi_staging_check_control_paths[@]}"; do
  assert_matches package_publish_flow_changed_files \
    "$abi_staging_check_control_path" \
    "$abi_staging_check_control_path"
  assert_matches ci_control_changed_files \
    "$abi_staging_check_control_path" \
    "$abi_staging_check_control_path"
  assert_not_matches package_archive_changed_files \
    "$abi_staging_check_control_path" \
    "$abi_staging_check_control_path"
done

assert_matches kernel_runtime_changed_files \
  "host/src/process.ts" \
  "host/src/process.ts"
assert_matches kernel_runtime_changed_files \
  "tests/sortix/os-test/include/sys/socket.c" \
  "tests/sortix/os-test/include/sys/socket.c"
assert_matches kernel_runtime_changed_files \
  "scripts/ci-run-test-suite.sh" \
  "scripts/ci-run-test-suite.sh"
assert_not_matches kernel_runtime_changed_files \
  "tools/xtask/src/remote_fetch.rs" \
  "tools/xtask/src/remote_fetch.rs"

# Canonical VFS authority is consumed by ABI, package, and browser validation.
# Product manifests can change image bytes, while consumer registries and the
# typed staging implementation require the non-package runtime gate. None of
# these paths opt into the existing credentialed Homebrew product exception.
abi_staging_foundation_paths=(
  images/vfs/products/browser-main-shell.toml
  apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml
  tests/vfs-products.toml
  abi/staging/guard-codes.toml
  tools/xtask/src/abi_staging/selection.rs
  scripts/test-abi-staging-product-authority.sh
)
for abi_staging_foundation_path in "${abi_staging_foundation_paths[@]}"; do
  assert_matches kernel_runtime_changed_files \
    "$abi_staging_foundation_path" \
    "$abi_staging_foundation_path"
  assert_not_matches homebrew_product_owned_package_input_changed_files \
    "$abi_staging_foundation_path" \
    "$abi_staging_foundation_path"
done
pages_production_paths=(
  apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json
  scripts/abi-staging-pages-producer-fixture.ts
  scripts/abi-staging-pages-producer.ts
  scripts/abi-staging-product-browser-evidence.ts
  scripts/abi-staging-product-node-evidence.ts
  scripts/abi-staging-product-input-sources.ts
)
for pages_production_path in "${pages_production_paths[@]}"; do
  assert_matches kernel_runtime_changed_files \
    "$pages_production_path" \
    "$pages_production_path"
  assert_not_matches homebrew_product_owned_package_input_changed_files \
    "$pages_production_path" \
    "$pages_production_path"
done
assert_matches package_archive_changed_files \
  "images/vfs/products/browser-main-shell.toml" \
  "images/vfs/products/browser-main-shell.toml"
for non_archive_authority_path in \
  apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
  tests/vfs-products.toml \
  abi/staging/guard-codes.toml \
  tools/xtask/src/abi_staging/selection.rs \
  scripts/test-abi-staging-product-authority.sh
do
  assert_not_matches package_archive_changed_files \
    "$non_archive_authority_path" \
    "$non_archive_authority_path"
done
assert_not_matches package_archive_changed_files \
  "docs/superpowers/plans/2026-08-08-abi-staging-product-authority-foundation.md" \
  "docs/superpowers/plans/2026-08-08-abi-staging-product-authority-foundation.md"

assert_matches ci_control_changed_files \
  ".github/actions/detect-change-scope/action.yml" \
  ".github/actions/detect-change-scope/action.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/staging-build.yml" \
  ".github/workflows/staging-build.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/prepare-merge.yml" \
  ".github/workflows/prepare-merge.yml"
for package_index_contract in \
  tools/xtask/src/index_candidate.rs \
  tools/xtask/src/index_toml.rs \
  tools/xtask/src/package_archive_name.rs; do
  assert_matches ci_control_changed_files \
    "$package_index_contract" \
    "$package_index_contract"
done
for blocker_materialization_script in \
  scripts/activate-local-shell-build-override.sh \
  scripts/ci-homebrew-browser-mirror-state.sh \
  scripts/install-local-shell-artifact.sh \
  scripts/materialize-ci-canonical-package-index.sh \
  scripts/materialize-ci-publication-blockers.sh \
  scripts/validate-publication-blocker-report.sh; do
  assert_matches ci_control_changed_files \
    "$blocker_materialization_script" \
    "$blocker_materialization_script"
done
assert_matches ci_control_changed_files \
  ".github/workflows/activate-merge-candidate.yml" \
  ".github/workflows/activate-merge-candidate.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/recover-rejected-merge-candidate.yml" \
  ".github/workflows/recover-rejected-merge-candidate.yml"
assert_matches ci_control_changed_files \
  ".github/scripts/activate-merge-candidate.sh" \
  ".github/scripts/activate-merge-candidate.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/find-release-by-tag.sh" \
  ".github/scripts/find-release-by-tag.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-find-release-by-tag.sh" \
  ".github/scripts/test-find-release-by-tag.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/clone-rejected-merge-candidate.sh" \
  ".github/scripts/clone-rejected-merge-candidate.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/reconcile-merge-candidates.sh" \
  ".github/scripts/reconcile-merge-candidates.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-reconcile-merge-candidates.sh" \
  ".github/scripts/test-reconcile-merge-candidates.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/cleanup-merge-candidates.sh" \
  ".github/scripts/cleanup-merge-candidates.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/delete-writable-release.sh" \
  ".github/scripts/delete-writable-release.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-delete-writable-release.sh" \
  ".github/scripts/test-delete-writable-release.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/require-exact-head-approval.sh" \
  ".github/scripts/require-exact-head-approval.sh"
assert_matches ci_control_changed_files \
  ".github/actions/exact-main-package-rebuild/action.yml" \
  ".github/actions/exact-main-package-rebuild/action.yml"
assert_matches ci_control_changed_files \
  "tools/xtask/src/package_matrix.rs" \
  "tools/xtask/src/package_matrix.rs"
assert_matches ci_control_changed_files \
  ".github/scripts/require-exact-kandelo-main.sh" \
  ".github/scripts/require-exact-kandelo-main.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-require-exact-kandelo-main.sh" \
  ".github/scripts/test-require-exact-kandelo-main.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-exact-main-package-publication.sh" \
  ".github/scripts/test-exact-main-package-publication.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/latest-merge-gate-status.sh" \
  ".github/scripts/latest-merge-gate-status.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/fetch-canonical-index.sh" \
  ".github/scripts/fetch-canonical-index.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/select-package-archive-source.sh" \
  ".github/scripts/select-package-archive-source.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/download-verified-release-asset.sh" \
  ".github/scripts/download-verified-release-asset.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/validate-staging-release.sh" \
  ".github/scripts/validate-staging-release.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/compose-staging-release-snapshots.sh" \
  ".github/scripts/compose-staging-release-snapshots.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/split-staging-package-ledger.sh" \
  ".github/scripts/split-staging-package-ledger.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-split-staging-package-ledger.sh" \
  ".github/scripts/test-split-staging-package-ledger.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-validate-staging-release.sh" \
  ".github/scripts/test-validate-staging-release.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/package-generation.py" \
  ".github/scripts/package-generation.py"
assert_matches ci_control_changed_files \
  ".github/scripts/prepare-durable-package-generation.sh" \
  ".github/scripts/prepare-durable-package-generation.sh"
for authority_validator_script in \
  .github/scripts/prepare-current-authority-validator.sh \
  .github/scripts/test-prepare-current-authority-validator.sh; do
  assert_matches ci_control_changed_files \
    "$authority_validator_script" \
    "$authority_validator_script"
done
assert_matches ci_control_changed_files \
  ".github/scripts/prepare-preserved-pr-package-generation.sh" \
  ".github/scripts/prepare-preserved-pr-package-generation.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/verify-preserved-package-source.sh" \
  ".github/scripts/verify-preserved-package-source.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/classify-pr-staging.sh" \
  ".github/scripts/classify-pr-staging.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-classify-pr-staging.sh" \
  ".github/scripts/test-classify-pr-staging.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/materialize-exact-package-generations.sh" \
  ".github/scripts/materialize-exact-package-generations.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-materialize-exact-package-generations.sh" \
  ".github/scripts/test-materialize-exact-package-generations.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/materialize-durable-package-generation.sh" \
  ".github/scripts/materialize-durable-package-generation.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/publish-durable-package-generation.sh" \
  ".github/scripts/publish-durable-package-generation.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-package-generation.sh" \
  ".github/scripts/test-package-generation.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-publish-durable-package-generation.sh" \
  ".github/scripts/test-publish-durable-package-generation.sh"
assert_matches ci_control_changed_files \
  ".github/workflows/promote-package-generation.yml" \
  ".github/workflows/promote-package-generation.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/preserve-pr-package-generation.yml" \
  ".github/workflows/preserve-pr-package-generation.yml"
assert_matches ci_control_changed_files \
  ".github/scripts/recover-canonical-indexes.sh" \
  ".github/scripts/recover-canonical-indexes.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-recover-canonical-indexes.sh" \
  ".github/scripts/test-recover-canonical-indexes.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/state-lock.sh" \
  ".github/scripts/state-lock.sh"
assert_matches ci_control_changed_files \
  ".github/scripts/test-state-lock.sh" \
  ".github/scripts/test-state-lock.sh"
assert_matches ci_control_changed_files \
  "scripts/release-index-state.sh" \
  "scripts/release-index-state.sh"
assert_matches ci_control_changed_files \
  ".github/workflows/staging-cleanup.yml" \
  ".github/workflows/staging-cleanup.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/force-rebuild.yml" \
  ".github/workflows/force-rebuild.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/reusable-package-source-publish.yml" \
  ".github/workflows/reusable-package-source-publish.yml"
assert_matches ci_control_changed_files \
  "tests/scripts/ci-run-test-suite-groups.test.sh" \
  "tests/scripts/ci-run-test-suite-groups.test.sh"

echo "ci-scope path classifier tests passed"
