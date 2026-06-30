#!/usr/bin/env bash
set -euo pipefail

ACTION_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=ci-scope-paths.sh
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
  "tools/xtask/src/platform_artifacts.rs" \
  "tools/xtask/src/platform_artifacts.rs"
assert_matches binary_materialization_changed_files \
  "platform/artifacts/manifest.json" \
  "platform/artifacts/manifest.json"
assert_matches binary_materialization_changed_files \
  "scripts/fetch-binaries.sh" \
  "scripts/fetch-binaries.sh"
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
  "tests/scripts/index-update.sh" \
  "tests/scripts/index-update.sh"
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

echo "ci-scope path classifier tests passed"
