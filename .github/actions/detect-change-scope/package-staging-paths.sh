#!/usr/bin/env bash

# Print changed paths that can affect package staging outputs. Callers pipe a
# newline-delimited file list in.
package_staging_changed_files() {
  grep -E \
    -e '^(packages/registry|crates|libc|tools/xtask|images/vfs|abi)/' \
    -e '^host/src/(binary-resolver|channel|constants|dylink|kernel|kernel-worker|node-kernel-host|node-kernel-protocol|node-kernel-worker-entry|platform/|shared-|statfs|thread-allocator|types|vfs/|wasi-|worker-adapter|worker-entry|worker-main|worker-protocol|generated/abi)\.?' \
    -e '^examples/lsof\.c$' \
    -e '^(Cargo\.(lock|toml)|flake\.(nix|lock)|rust-toolchain\.toml|\.gitmodules|package(-lock)?\.json|host/package(-lock)?\.json)$' \
    -e '^scripts/(build-[^/]+|dev-shell|fetch-binaries|index-has-current-entry|index-update|install-local-binary|materialize-pr-overlays|resolve-binary)\.sh$' \
    || true
}
