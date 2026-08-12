#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

host_target="$(rustc -vV | awk '/^host/ {print $2}')"
host_dist="$(mktemp -d)"
cleanup() {
  rm -rf -- "$host_dist"
}
trap cleanup EXIT

cargo build --release -p kandelo \
  -Z build-std=core,alloc
(
  cd host
  npx tsup --out-dir "$host_dist"
)
KANDELO_EVIDENCE_HOST_DIST="$host_dist" \
  npx tsx --test scripts/abi-staging-product-node-evidence.test.ts

(
  cd host
  npx vitest run \
    test/node-kernel-pipe-proxy.test.ts \
    test/abi-staging-product-builders.test.ts \
    test/homebrew-language-runtime-smoke.test.ts \
    test/homebrew-vfs-formula-layer.test.ts \
    test/lazy-vfs.test.ts \
    test/node-lazy-archive-runtime.test.ts \
)

host/node_modules/.bin/tsc \
  --noEmit \
  --target ES2024 \
  --lib ES2024,ES2024.SharedMemory,DOM \
  --module ESNext \
  --moduleResolution bundler \
  --allowImportingTsExtensions \
  --strict \
  --skipLibCheck \
  --types node \
  --typeRoots host/node_modules/@types \
  scripts/abi-staging-product-node-evidence.ts \
  scripts/abi-staging-product-node-evidence.test.ts

cargo test -p xtask --target "$host_target" \
  abi_staging::product_evidence
cargo test -p xtask --target "$host_target" \
  abi_staging::records
cargo test -p xtask --target "$host_target" \
  abi_staging::mini_lifecycle

cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging products check \
  --source images/vfs/products \
  --generated images/vfs/products/generated/catalog.json

cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging evidence-definitions check \
  --source abi/staging/evidence-definitions.toml \
  --generated abi/staging/evidence-definitions.generated.json

cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging request-policy check \
  --source abi/staging/request-policy.toml \
  --generated abi/staging/request-policy.generated.json

if rg -n '\b4[23]\b' \
  scripts/abi-staging-product-node-evidence.ts \
  scripts/abi-staging-product-node-evidence.test.ts \
  tools/xtask/src/abi_staging/product_evidence.rs; then
  echo "product evidence infrastructure contains a fixture-specific ABI literal" >&2
  exit 1
fi

if rg -n 'TODO|FIXME|PLACEHOLDER|placeholder' \
  scripts/abi-staging-product-node-evidence.ts \
  scripts/abi-staging-product-node-evidence.test.ts \
  tools/xtask/src/abi_staging/product_evidence.rs; then
  echo "product evidence infrastructure contains an unfinished placeholder" >&2
  exit 1
fi
