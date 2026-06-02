#!/usr/bin/env bash

# Print changed paths that can affect package staging outputs. Callers pipe a
# newline-delimited file list in.
package_staging_changed_files() {
  grep -E \
    -e '^packages/registry/' \
    -e '^sdk/(activate\.sh|config\.site|package(-lock)?\.json|tsconfig\.json)$' \
    -e '^sdk/(bin|kandelo|src)/' \
    -e '^tools/xtask/(Cargo\.toml|src/)' \
    -e '^tools/mkrootfs/(bin|src)/' \
    -e '^tools/mkrootfs/(package(-lock)?\.json|tsconfig\.json)$' \
    -e '^crates/fork-instrument/(Cargo\.toml|src/)' \
    -e '^libc/(glue|musl-overlay)(/|$)' \
    -e '^libc/musl($|/)' \
    -e '^images/vfs/' \
    -e '^examples/lsof\.c$' \
    -e '^(Cargo\.(lock|toml)|flake\.(nix|lock)|rust-toolchain\.toml|\.gitmodules|package(-lock)?\.json|host/package(-lock)?\.json|sdk/package(-lock)?\.json|tools/mkrootfs/package(-lock)?\.json)$' \
    -e '^scripts/(build-fork-instrument-tool|build-musl|compose-initial-index|dev-shell|fetch-binaries|index-has-current-entry|index-update|install-local-binary|install-overlay-headers|materialize-pr-overlays|prepare-sdk-package|publish-package-source|resolve-binary|run-wasm-fork-instrument|sync-package-source)\.sh$' \
    | grep -vE \
      -e '^packages/registry/[^/]+/(demo|test)(/|$)' \
    || true
}
