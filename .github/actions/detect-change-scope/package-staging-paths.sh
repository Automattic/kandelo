#!/usr/bin/env bash

# Print changed paths that can affect package staging outputs. Callers pipe a
# newline-delimited file list in.
package_staging_changed_files() {
  grep -E \
    -e '^packages/(registry|sets)/' \
    -e '^sdk/' \
    -e '^tools/(xtask|mkrootfs)/' \
    -e '^crates/fork-instrument/' \
    -e '^libc/(glue|musl-overlay)(/|$)' \
    -e '^libc/musl($|/)' \
    -e '^images/vfs/' \
    -e '^abi/' \
    -e '^examples/lsof\.c$' \
    -e '^(Cargo\.(lock|toml)|flake\.(nix|lock)|rust-toolchain\.toml|\.gitmodules|package(-lock)?\.json|host/package(-lock)?\.json|sdk/package(-lock)?\.json|tools/mkrootfs/package(-lock)?\.json)$' \
    -e '^scripts/(build-fork-instrument-tool|build-musl|compose-initial-index|dev-shell|fetch-binaries|index-has-current-entry|index-update|install-local-binary|install-overlay-headers|materialize-pr-overlays|prepare-sdk-package|publish-package-source|resolve-binary|sync-package-source)\.sh$' \
    || true
}
