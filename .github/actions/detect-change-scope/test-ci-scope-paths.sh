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
assert_not_matches package_archive_changed_files \
  "tools/xtask/src/remote_fetch.rs" \
  "tools/xtask/src/remote_fetch.rs"
assert_not_matches package_archive_changed_files \
  "scripts/fetch-binaries.sh" \
  "scripts/fetch-binaries.sh"
assert_not_matches package_archive_changed_files \
  "packages/registry/php/test/php.test.ts" \
  "packages/registry/php/test/php.test.ts"
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
assert_matches package_archive_changed_files \
  "images/rootfs/etc/profile" \
  "images/rootfs/etc/profile"
assert_not_matches package_archive_changed_files \
  "host/src/process.ts" \
  "host/src/process.ts"
assert_not_matches package_archive_changed_files \
  ".github/workflows/staging-build.yml" \
  ".github/workflows/staging-build.yml"
assert_not_matches package_archive_changed_files \
  ".github/workflows/prepare-merge.yml" \
  ".github/workflows/prepare-merge.yml"

assert_matches binary_materialization_changed_files \
  "tools/xtask/src/remote_fetch.rs" \
  "tools/xtask/src/remote_fetch.rs"
assert_matches binary_materialization_changed_files \
  "scripts/fetch-binaries.sh" \
  "scripts/fetch-binaries.sh"
assert_matches binary_materialization_changed_files \
  "scripts/wasm-artifact-guards.sh" \
  "scripts/wasm-artifact-guards.sh"
assert_matches binary_materialization_changed_files \
  "scripts/test-wasm-artifact-guards.sh" \
  "scripts/test-wasm-artifact-guards.sh"
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
  "tests/scripts/index-update.sh" \
  "tests/scripts/index-update.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/activate-merge-candidate.sh" \
  ".github/scripts/activate-merge-candidate.sh"
assert_matches package_publish_flow_changed_files \
  ".github/scripts/test-activate-merge-candidate.sh" \
  ".github/scripts/test-activate-merge-candidate.sh"
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
  ".github/scripts/require-exact-head-approval.sh" \
  ".github/scripts/require-exact-head-approval.sh"
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
  ".github/scripts/test-validate-staging-release.sh" \
  ".github/scripts/test-validate-staging-release.sh"
assert_matches package_publish_flow_changed_files \
  "tools/xtask/src/staging_reuse.rs" \
  "tools/xtask/src/staging_reuse.rs"
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
  ".github/workflows/reusable-package-source-publish.yml" \
  ".github/workflows/reusable-package-source-publish.yml"
assert_not_matches package_publish_flow_changed_files \
  "tools/xtask/src/remote_fetch.rs" \
  "tools/xtask/src/remote_fetch.rs"

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

assert_matches ci_control_changed_files \
  ".github/actions/detect-change-scope/action.yml" \
  ".github/actions/detect-change-scope/action.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/staging-build.yml" \
  ".github/workflows/staging-build.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/prepare-merge.yml" \
  ".github/workflows/prepare-merge.yml"
assert_matches ci_control_changed_files \
  ".github/workflows/activate-merge-candidate.yml" \
  ".github/workflows/activate-merge-candidate.yml"
assert_matches ci_control_changed_files \
  ".github/scripts/activate-merge-candidate.sh" \
  ".github/scripts/activate-merge-candidate.sh"
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
  ".github/scripts/require-exact-head-approval.sh" \
  ".github/scripts/require-exact-head-approval.sh"
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
  ".github/scripts/test-validate-staging-release.sh" \
  ".github/scripts/test-validate-staging-release.sh"
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

echo "ci-scope path classifier tests passed"
