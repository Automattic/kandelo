#!/usr/bin/env bash
set -euo pipefail

ACTION_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=package-staging-paths.sh
. "$ACTION_DIR/package-staging-paths.sh"

filter_paths() {
  printf '%s\n' "$@" | package_staging_changed_files
}

assert_selected() {
  local path="$1"
  local out
  shift
  out="$(filter_paths "$@")"
  if ! printf '%s\n' "$out" | grep -qx "$path"; then
    echo "expected package staging path to be selected: $path" >&2
    echo "output:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

assert_not_selected() {
  local path="$1"
  local out
  shift
  out="$(filter_paths "$@")"
  if printf '%s\n' "$out" | grep -qx "$path"; then
    echo "expected package staging path to be ignored: $path" >&2
    echo "output:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

assert_selected \
  "packages/registry/wordpress/setup.sh" \
  "packages/registry/wordpress/setup.sh"
assert_selected \
  "packages/registry/nethack/patches/local.patch" \
  "packages/registry/nethack/patches/local.patch"

assert_not_selected \
  "packages/registry/php/test/php.test.ts" \
  "packages/registry/php/test/php.test.ts"
assert_not_selected \
  "packages/registry/nginx/demo/run.sh" \
  "packages/registry/nginx/demo/run.sh"
assert_not_selected \
  "packages/sets/ci.toml" \
  "packages/sets/ci.toml"
assert_not_selected \
  "abi/snapshot.json" \
  "abi/snapshot.json"

assert_selected "sdk/src/lib/flags.ts" "sdk/src/lib/flags.ts"
assert_selected "sdk/bin/wasm32posix-cc" "sdk/bin/wasm32posix-cc"
assert_not_selected "sdk/test/cc.test.ts" "sdk/test/cc.test.ts"

assert_selected "tools/xtask/src/build_deps.rs" "tools/xtask/src/build_deps.rs"
assert_not_selected "tools/xtask/src/remote_fetch.rs" "tools/xtask/src/remote_fetch.rs"
assert_not_selected "tools/xtask/src/dump_abi.rs" "tools/xtask/src/dump_abi.rs"
assert_not_selected "tools/xtask/README.md" "tools/xtask/README.md"
assert_selected "tools/mkrootfs/src/builder.ts" "tools/mkrootfs/src/builder.ts"
assert_not_selected "tools/mkrootfs/test/builder.test.ts" "tools/mkrootfs/test/builder.test.ts"
assert_selected "host/src/vfs/memory-fs.ts" "host/src/vfs/memory-fs.ts"
assert_selected "host/src/vfs/sharedfs-vendor.ts" "host/src/vfs/sharedfs-vendor.ts"
assert_selected "images/rootfs/etc/profile" "images/rootfs/etc/profile"
assert_not_selected "host/src/process.ts" "host/src/process.ts"

assert_selected "crates/fork-instrument/src/main.rs" "crates/fork-instrument/src/main.rs"
assert_selected \
  "scripts/run-wasm-fork-instrument.sh" \
  "scripts/run-wasm-fork-instrument.sh"
assert_not_selected \
  "scripts/index-current-entry-built-by.sh" \
  "scripts/index-current-entry-built-by.sh"
assert_not_selected \
  "crates/fork-instrument/tests/instrument.rs" \
  "crates/fork-instrument/tests/instrument.rs"
assert_selected \
  ".github/actions/package-archive-build/action.yml" \
  ".github/actions/package-archive-build/action.yml"
assert_selected \
  ".github/actions/package-toolchain/action.yml" \
  ".github/actions/package-toolchain/action.yml"
assert_selected \
  ".github/actions/download-run-artifacts/action.yml" \
  ".github/actions/download-run-artifacts/action.yml"
assert_selected \
  ".github/scripts/download-dependency-artifacts.sh" \
  ".github/scripts/download-dependency-artifacts.sh"
assert_not_selected \
  ".github/workflows/staging-build.yml" \
  ".github/workflows/staging-build.yml"
assert_not_selected \
  ".github/workflows/prepare-merge.yml" \
  ".github/workflows/prepare-merge.yml"

echo "package-staging path filter tests passed"
