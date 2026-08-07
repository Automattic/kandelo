#!/usr/bin/env bash

# Effect-based changed-path classifiers. Each function reads a
# newline-delimited path list on stdin and prints matching paths.

ci_scope_paths_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

package_archive_changed_files() {
  local files static_matches declared_input_matches product_owned_matches
  files=$(cat)

  static_matches=$(printf '%s\n' "$files" | grep -E \
    -e '^packages/registry/' \
    -e '^sdk/(activate\.sh|config\.site|package(-lock)?\.json|tsconfig\.json)$' \
    -e '^sdk/(bin|kandelo|src)/' \
    -e '^tools/xtask/Cargo\.toml$' \
    -e '^tools/xtask/src/(archive_stage|archive_stage_cli|build_deps|host_tool_probe|main|package_archive_name|package_matrix|pkg_manifest|publication_policy|source_extract|util)\.rs$' \
    -e '^tools/mkrootfs/(bin|src)/' \
    -e '^tools/mkrootfs/(package(-lock)?\.json|tsconfig\.json)$' \
    -e '^crates/fork-instrument/(Cargo\.toml|src/)' \
    -e '^libc/(glue|musl-overlay)(/|$)' \
    -e '^libc/musl($|/)' \
    -e '^images/vfs/' \
    -e '^examples/lsof\.c$' \
    -e '^\.github/actions/(exact-main-package-rebuild|package-archive-build|package-toolchain|fetch-submodules|download-run-artifacts)/' \
    -e '^\.github/scripts/download-dependency-artifacts\.sh$' \
    -e '^(Cargo\.(lock|toml)|flake\.(nix|lock)|rust-toolchain\.toml|\.gitmodules|package(-lock)?\.json|host/package(-lock)?\.json|sdk/package(-lock)?\.json|tools/mkrootfs/package(-lock)?\.json)$' \
    -e '^scripts/(build-fork-instrument-tool|build-musl|check-libcxx-toolchain-version|dev-shell|install-local-binary|install-overlay-headers|run-wasm-fork-instrument)\.sh$' \
    | grep -vE \
      -e '^packages/registry/[^/]+/(demo|test)(/|$)' \
    || true)

  declared_input_matches=$(printf '%s\n' "$files" | package_declared_build_input_changed_files)
  product_owned_matches=$(printf '%s\n' "$files" |
    homebrew_product_owned_package_input_changed_files)

  # WHY: program-packages.json is generated resolver/materialization policy,
  # not a package recipe. Rebuilding every archive after refreshing only this
  # index wastes the staging matrix without changing any archive cache key.
  printf '%s\n%s\n' "$static_matches" "$declared_input_matches" |
    grep -vFx 'packages/registry/program-packages.json' |
    sed '/^$/d' | sort -u |
    comm -23 - <(printf '%s\n' "$product_owned_matches" |
      sed '/^$/d' | sort -u)
}

package_declared_build_input_changed_files() {
  local files
  files=$(cat)

  [ -d packages/registry ] || return 0

  printf '%s\n' "$files" | python3 "$ci_scope_paths_dir/package-build-input-matches.py" packages/registry
}

homebrew_product_owned_package_input_changed_files() {
  # WHY: these inputs used to belong only to the conventional shell archive.
  # They now define or validate the independent bottle-selection VFS used by
  # the exact Homebrew product gate, which independently composes and boots the
  # selected runtime in Node and Chromium. Sending a change through both owners
  # attempts to rebuild the unpublished, retiring shell archive and every
  # derived VFS identity without adding evidence.
  #
  # This is deliberately an exact reviewed ownership list, not a Homebrew path
  # wildcard. Add a path only when the exact product gate proves its complete
  # effect and focused tests establish that conventional package inputs still
  # stage normally.
  grep -Fx \
    -e 'homebrew/main-shell-homebrew-runtime-support.json' \
    -e 'homebrew/main-shell-lazy-artifact-lock.json' \
    -e 'homebrew/main-shell-selection-lock.json' \
    -e 'host/src/homebrew-runtime-support-materializer.ts' \
    -e 'host/src/homebrew-runtime-support.ts' \
    -e 'host/src/homebrew-vfs-builder.ts' \
    -e 'images/vfs/scripts/build-homebrew-flat-vfs-image.ts' \
    -e 'scripts/check-homebrew-main-shell-brewfile.mjs' \
    -e 'scripts/homebrew-prefix-campaign-executor.py' \
    || true
}

package_publish_flow_changed_files() {
  grep -E \
    -e '^\.github/scripts/verify-package-generation-ancestry\.sh$' \
    -e '^\.github/actions/detect-change-scope/(ci-scope-paths|test-ci-scope-paths)\.sh$' \
    -e '^\.github/workflows/(staging-build|prepare-merge|activate-merge-candidate|recover-rejected-merge-candidate|staging-cleanup|force-rebuild|reusable-package-source-publish|promote-package-generation|preserve-pr-package-generation)\.yml$' \
    -e '^\.github/actions/exact-main-package-rebuild/' \
    -e '^\.github/scripts/(activate-merge-candidate|classify-pr-staging|cleanup-merge-candidates|clone-rejected-merge-candidate|compose-staging-release-snapshots|delete-writable-release|download-verified-release-asset|fetch-canonical-index|find-release-by-tag|github-api-get|init-merge-candidate|latest-merge-gate-status|mark-merge-candidate-ready|materialize-durable-package-generation|materialize-exact-package-generations|package-release-lifecycle|prepare-current-authority-validator|prepare-durable-package-generation|prepare-preserved-pr-package-generation|publish-durable-package-generation|reconcile-merge-candidates|recover-canonical-indexes|require-exact-head-approval|require-exact-kandelo-main|select-package-archive-source|split-staging-package-ledger|state-lock|test-activate-merge-candidate|test-classify-pr-staging|test-cleanup-merge-candidates|test-clone-rejected-merge-candidate|test-delete-writable-release|test-download-verified-release-asset|test-exact-main-package-publication|test-fetch-canonical-index|test-find-release-by-tag|test-init-merge-candidate|test-latest-merge-gate-status|test-materialize-exact-package-generations|test-merge-candidate-workflows|test-package-generation|test-package-release-lifecycle|test-prepare-current-authority-validator|test-publish-durable-package-generation|test-reconcile-merge-candidates|test-recover-canonical-indexes|test-require-exact-head-approval|test-require-exact-kandelo-main|test-select-package-archive-source|test-split-staging-package-ledger|test-state-lock|test-validate-staging-release|test-verify-merge-candidate|validate-staging-release|verify-merge-candidate|verify-preserved-package-source)\.sh$' \
    -e '^\.github/scripts/package-generation\.py$' \
    -e '^tools/xtask/src/(build_deps|build_index|bundle_program|index_candidate|index_toml|index_update|package_archive_name|package_matrix|pkg_manifest|publication_policy|staging_reuse|update_pkg_manifest)\.rs$' \
    -e '^scripts/(compose-initial-index|homebrew-rootfs-publication-selection|index-has-current-entry|index-update|prepare-sdk-package|publish-package-source|release-index-state|sync-package-source|test-homebrew-rootfs-publication-selection)\.sh$' \
    -e '^tests/scripts/(index-update|package-publish-flow|release-index-state)\.sh$' \
    || true
}

binary_materialization_changed_files() {
  grep -E \
    -e '^packages/registry/program-packages\.json$' \
    -e '^tools/xtask/src/(index_candidate|index_toml|package_archive_name|remote_fetch|util)\.rs$' \
    -e '^scripts/(activate-local-shell-build-override|ci-homebrew-browser-mirror-state|fetch-binaries|install-local-binary|install-local-shell-artifact|materialize-ci-canonical-package-index|materialize-ci-publication-blockers|materialize-pr-overlays|materialize-resolver-binaries|pack-ci-test-workspace|resolve-binary|stage-portable-resolver-binaries|test-wasm-artifact-guards|validate-publication-blocker-report|wasm-artifact-guards)\.sh$' \
    -e '^scripts/(build-resolve-binary-bundle|test-resolve-binary-bundle)\.sh$' \
    -e '^scripts/resolve-binary\.(ts|bundle\.mjs|bundle\.LICENSES\.txt)$' \
    -e '^scripts/vfs-has-stale-abi\.mjs$' \
    -e '^host/src/binary-resolver\.ts$' \
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
    -e '^\.github/scripts/verify-package-generation-ancestry\.sh$' \
    -e '^\.github/workflows/(staging-build|prepare-merge|activate-merge-candidate|recover-rejected-merge-candidate|staging-cleanup|force-rebuild|reusable-package-source-publish|promote-package-generation|preserve-pr-package-generation)\.yml$' \
    -e '^\.github/actions/exact-main-package-rebuild/' \
    -e '^\.github/scripts/(activate-merge-candidate|classify-pr-staging|cleanup-merge-candidates|clone-rejected-merge-candidate|compose-staging-release-snapshots|delete-writable-release|download-verified-release-asset|fetch-canonical-index|find-release-by-tag|github-api-get|init-merge-candidate|latest-merge-gate-status|mark-merge-candidate-ready|materialize-durable-package-generation|materialize-exact-package-generations|package-release-lifecycle|prepare-current-authority-validator|prepare-durable-package-generation|prepare-preserved-pr-package-generation|publish-durable-package-generation|reconcile-merge-candidates|recover-canonical-indexes|require-exact-head-approval|require-exact-kandelo-main|select-package-archive-source|split-staging-package-ledger|state-lock|test-activate-merge-candidate|test-classify-pr-staging|test-cleanup-merge-candidates|test-clone-rejected-merge-candidate|test-delete-writable-release|test-download-verified-release-asset|test-exact-main-package-publication|test-fetch-canonical-index|test-find-release-by-tag|test-init-merge-candidate|test-latest-merge-gate-status|test-materialize-exact-package-generations|test-merge-candidate-workflows|test-package-generation|test-package-release-lifecycle|test-prepare-current-authority-validator|test-publish-durable-package-generation|test-reconcile-merge-candidates|test-recover-canonical-indexes|test-require-exact-head-approval|test-require-exact-kandelo-main|test-select-package-archive-source|test-split-staging-package-ledger|test-state-lock|test-validate-staging-release|test-verify-merge-candidate|validate-staging-release|verify-merge-candidate|verify-preserved-package-source)\.sh$' \
    -e '^\.github/scripts/package-generation\.py$' \
    -e '^tools/xtask/src/(index_candidate|index_toml|package_archive_name|package_matrix)\.rs$' \
    -e '^scripts/(activate-local-shell-build-override|ci-homebrew-browser-mirror-state|compose-initial-index|index-update|install-local-shell-artifact|materialize-ci-canonical-package-index|materialize-ci-publication-blockers|release-index-state|validate-publication-blocker-report)\.sh$' \
    -e '^tests/scripts/(index-update|package-publish-flow|release-index-state)\.sh$' \
    -e '^tests/scripts/ci-run-test-suite-groups\.test\.sh$' \
    -e '^\.github/actions/detect-change-scope/' \
    || true
}
