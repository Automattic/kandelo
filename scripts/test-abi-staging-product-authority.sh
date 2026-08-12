#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo "usage: $0" >&2
  exit 2
fi

: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

require_documented_boundary() {
  local file="$1"
  local text="$2"
  if ! grep -Fq "$text" "$file"; then
    echo "$file does not document the ABI staging foundation boundary: $text" >&2
    exit 1
  fi
}

require_documented_boundary docs/abi-versioning.md \
  "The checked-in ABI staging foundation is local and inert."
require_documented_boundary docs/package-management.md \
  "Canonical VFS product manifests are the lasting product authority."
require_documented_boundary docs/browser-support.md \
  "Pages placement is owned only by the Pages VFS product registry."
require_documented_boundary docs/repository-organization.md \
  "Hosted ABI staging is not operational in this foundation."
require_documented_boundary docs/future-improvements.md \
  "Model semantic ABI transitions in Rust-owned machine-readable data"
require_documented_boundary docs/future-improvements.md \
  "Preserve all external build sources in deduplicated content-addressed custody"
require_documented_boundary docs/future-improvements.md \
  "Ship ABI-matched POSIX and Kandelo manual pages"

host_target="$(rustc -vV | awk '/^host/ {print $2}')"

cargo test -p xtask --target "$host_target" abi_staging
cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging products check \
  --source images/vfs/products \
  --generated images/vfs/products/generated/catalog.json
cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging registries check \
  --catalog images/vfs/products/generated/catalog.json \
  --pages apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
  --pages-generated apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
  --tests tests/vfs-products.toml \
  --tests-generated tests/vfs-products.generated.json
cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging guard-codes check \
  --source abi/staging/guard-codes.toml \
  --generated abi/staging/guard-codes.generated.json

npx tsx --test \
  scripts/vfs-product-catalog.test.mjs \
  scripts/check-pages-vfs-product-registry.test.mjs \
  scripts/run-vfs-product-builder.test.ts

(
  cd host
  npx vitest run \
    test/vfs-product-builder-contract.test.ts \
    test/abi-staging-mini-vfs.test.ts
)

bash scripts/test-abi-staging-mini-lifecycle.sh

echo "ABI staging product-authority foundation: PASS"
