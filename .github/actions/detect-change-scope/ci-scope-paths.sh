#!/usr/bin/env bash

# Effect-based changed-path classifiers. Each function reads a
# newline-delimited path list on stdin and prints matching paths.

ci_scope_paths_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

package_archive_changed_files() {
  local files static_matches declared_input_matches
  files=$(cat)

  static_matches=$(printf '%s\n' "$files" | grep -E \
    -e '^packages/registry/' \
    -e '^sdk/(activate\.sh|config\.site|package(-lock)?\.json|tsconfig\.json)$' \
    -e '^sdk/(bin|kandelo|src)/' \
    -e '^tools/xtask/Cargo\.toml$' \
    -e '^tools/xtask/src/(archive_stage|archive_stage_cli|build_deps|host_tool_probe|main|pkg_manifest|source_extract|util)\.rs$' \
    -e '^tools/mkrootfs/(bin|src)/' \
    -e '^tools/mkrootfs/(package(-lock)?\.json|tsconfig\.json)$' \
    -e '^crates/fork-instrument/(Cargo\.toml|src/)' \
    -e '^libc/(glue|musl-overlay)(/|$)' \
    -e '^libc/musl($|/)' \
    -e '^images/vfs/' \
    -e '^examples/lsof\.c$' \
    -e '^\.github/actions/(package-archive-build|package-toolchain|fetch-submodules|download-run-artifacts)/' \
    -e '^\.github/scripts/download-dependency-artifacts\.sh$' \
    -e '^(Cargo\.(lock|toml)|flake\.(nix|lock)|rust-toolchain\.toml|\.gitmodules|package(-lock)?\.json|host/package(-lock)?\.json|sdk/package(-lock)?\.json|tools/mkrootfs/package(-lock)?\.json)$' \
    -e '^scripts/(build-fork-instrument-tool|build-musl|check-libcxx-toolchain-version|dev-shell|install-local-binary|install-overlay-headers|run-wasm-fork-instrument)\.sh$' \
    | grep -vE \
      -e '^packages/registry/[^/]+/(demo|test)(/|$)' \
    || true)

  declared_input_matches=$(printf '%s\n' "$files" | package_declared_build_input_changed_files)

  printf '%s\n%s\n' "$static_matches" "$declared_input_matches" | sed '/^$/d' | sort -u
}

package_declared_build_input_changed_files() {
  local files
  files=$(cat)

  [ -d packages/registry ] || return 0

  printf '%s\n' "$files" | python3 "$ci_scope_paths_dir/package-build-input-matches.py" packages/registry
}

package_publish_flow_changed_files() {
  grep -E \
    -e '^\.github/actions/detect-change-scope/(ci-scope-paths|test-ci-scope-paths)\.sh$' \
    -e '^\.github/workflows/(staging-build|prepare-merge|activate-merge-candidate|recover-rejected-merge-candidate|staging-cleanup|force-rebuild|reusable-package-source-publish)\.yml$' \
    -e '^\.github/scripts/(activate-merge-candidate|cleanup-merge-candidates|clone-rejected-merge-candidate|compose-staging-release-snapshots|download-verified-release-asset|fetch-canonical-index|github-api-get|init-merge-candidate|latest-merge-gate-status|mark-merge-candidate-ready|reconcile-merge-candidates|recover-canonical-indexes|require-exact-head-approval|select-package-archive-source|state-lock|test-activate-merge-candidate|test-cleanup-merge-candidates|test-clone-rejected-merge-candidate|test-download-verified-release-asset|test-fetch-canonical-index|test-init-merge-candidate|test-latest-merge-gate-status|test-merge-candidate-workflows|test-reconcile-merge-candidates|test-recover-canonical-indexes|test-require-exact-head-approval|test-select-package-archive-source|test-state-lock|test-validate-staging-release|test-verify-merge-candidate|validate-staging-release|verify-merge-candidate)\.sh$' \
    -e '^tools/xtask/src/(build_index|bundle_program|index_candidate|index_toml|index_update|staging_reuse|update_pkg_manifest)\.rs$' \
    -e '^scripts/(compose-initial-index|index-has-current-entry|index-update|prepare-sdk-package|publish-package-source|release-index-state|sync-package-source)\.sh$' \
    -e '^tests/scripts/(index-update|package-publish-flow|release-index-state)\.sh$' \
    || true
}

binary_materialization_changed_files() {
  grep -E \
    -e '^tools/xtask/src/(index_toml|remote_fetch|util)\.rs$' \
    -e '^scripts/(fetch-binaries|install-local-binary|materialize-pr-overlays|resolve-binary|test-wasm-artifact-guards|wasm-artifact-guards)\.sh$' \
    -e '^scripts/vfs-has-stale-abi\.mjs$' \
    -e '^tests/package-system/' \
    || true
}

kernel_runtime_changed_files() {
  grep -E \
    -e '^(crates|libc|tests/libc|tests/posix|tests/sortix|host|programs|abi)/' \
    -e '^(Cargo\.(lock|toml)|flake\.(nix|lock)|rust-toolchain\.toml|\.gitmodules)$' \
    -e '^scripts/(build-musl|build-libcxx|build-programs|check-abi-version|check-libcxx-toolchain-version|ci-run-test-suite|dev-shell|run-libc-tests|run-posix-tests|run-sortix-tests)\.sh$' \
    -e '^examples/run-example\.ts$' \
    || true
}

ci_control_changed_files() {
  grep -E \
    -e '^\.github/workflows/(staging-build|prepare-merge|activate-merge-candidate|recover-rejected-merge-candidate|staging-cleanup|force-rebuild|reusable-package-source-publish)\.yml$' \
    -e '^\.github/scripts/(activate-merge-candidate|cleanup-merge-candidates|clone-rejected-merge-candidate|compose-staging-release-snapshots|download-verified-release-asset|fetch-canonical-index|github-api-get|init-merge-candidate|latest-merge-gate-status|mark-merge-candidate-ready|reconcile-merge-candidates|recover-canonical-indexes|require-exact-head-approval|select-package-archive-source|state-lock|test-activate-merge-candidate|test-cleanup-merge-candidates|test-clone-rejected-merge-candidate|test-download-verified-release-asset|test-fetch-canonical-index|test-init-merge-candidate|test-latest-merge-gate-status|test-merge-candidate-workflows|test-reconcile-merge-candidates|test-recover-canonical-indexes|test-require-exact-head-approval|test-select-package-archive-source|test-state-lock|test-validate-staging-release|test-verify-merge-candidate|validate-staging-release|verify-merge-candidate)\.sh$' \
    -e '^scripts/(compose-initial-index|index-update|release-index-state)\.sh$' \
    -e '^tests/scripts/(index-update|package-publish-flow|release-index-state)\.sh$' \
    -e '^tests/scripts/ci-run-test-suite-groups\.test\.sh$' \
    -e '^\.github/actions/detect-change-scope/' \
    || true
}
