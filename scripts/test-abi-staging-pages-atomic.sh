#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo "usage: $0" >&2
  exit 2
fi

: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-pages-atomic.XXXXXX")"
deployment_root="$test_root/deployment"
source_root="$test_root/complete-site"
legacy_activation="$repo_root/abi/staging/pages-activation.toml"
observe_activation="$test_root/pages-observe.toml"
active_activation="$test_root/pages-active.toml"

cleanup() {
  case "$test_root" in
    "${TMPDIR:-/tmp}"/kandelo-pages-atomic.*)
      rm -rf -- "$test_root"
      ;;
  esac
}
trap cleanup EXIT

fail() {
  echo "test-abi-staging-pages-atomic: $*" >&2
  exit 1
}

mkdir -p "$deployment_root/sites/prior" "$source_root/browser" \
  "$source_root/guide" "$source_root/api" "$source_root/products/base" \
  "$source_root/.well-known/kandelo"
printf 'prior complete site\n' >"$deployment_root/sites/prior/index.html"
printf '{"kind":"prior-site","path":"sites/prior","schema":1}\n' \
  >"$deployment_root/current-site.json"
cp "$deployment_root/current-site.json" "$test_root/prior-pointer.json"
cp "$deployment_root/sites/prior/index.html" "$test_root/prior-index.html"

printf 'browser\n' >"$source_root/browser/index.html"
printf 'guide\n' >"$source_root/guide/index.html"
printf 'api\n' >"$source_root/api/index.html"
printf 'canonical vfs\n' >"$source_root/products/base/base.vfs.zst"
printf 'schema = 1\nkind = "kandelo-pages-activation"\nmode = "observe"\n' \
  >"$observe_activation"
printf 'schema = 1\nkind = "kandelo-pages-activation"\nmode = "active"\n' \
  >"$active_activation"

node - "$source_root" "$test_root" <<'NODE'
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const source = process.argv[2];
const root = process.argv[3];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sort = (value) => Array.isArray(value)
  ? value.map(sort)
  : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, sort(child)]))
  : value;
const canonical = (value) => Buffer.from(JSON.stringify(sort(value)) + "\n");
const identity = (path) => {
  const body = readFileSync(join(source, path));
  return { bytes: body.length, path, sha256: sha(body) };
};
const initialProductPath = "products/base/base.vfs.zst";
const initialProduct = identity(initialProductPath);
const productPath = `products/base/sha256-${initialProduct.sha256}/base-18.vfs.zst`;
mkdirSync(join(source, `products/base/sha256-${initialProduct.sha256}`));
renameSync(join(source, initialProductPath), join(source, productPath));
const productFile = identity(productPath);
const readiness = {
  blockers: [],
  kind: "kandelo-pages-readiness",
  pages_registry: {
    path: "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
    products: [{ id: "base", load: "eager" }],
    sha256: "4".repeat(64),
  },
  products: [{
    admissions: [{
      immutable_reference: `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/base/admissions@sha256:${"5".repeat(64)}`,
      record_sha256: "5".repeat(64),
    }],
    browser_receipts: [{ id: "base-browser", sha256: "6".repeat(64) }],
    builder_report_sha256: "7".repeat(64),
    id: "base",
    load: "eager",
    manifest_sha256: "8".repeat(64),
    node_receipts: [{ id: "base-node", sha256: "9".repeat(64) }],
    resolved_inputs_sha256: "a".repeat(64),
    runtime_evidence_sha256: "b".repeat(64),
    vfs_bytes: productFile.bytes,
    vfs_sha256: productFile.sha256,
  }],
  ready: true,
  schema: 1,
  site_metadata_sha256: "c".repeat(64),
  source: {
    commit: "1".repeat(40),
    repository: "Automattic/kandelo",
    tree: "2".repeat(40),
  },
  target_abi: { snapshot_sha256: "3".repeat(64), version: 18 },
};
const readinessBytes = canonical(readiness);
writeFileSync(join(root, "ready.json"), readinessBytes);
writeFileSync(join(root, "held.json"), canonical({
  ...readiness,
  blockers: [{
    detail: "base has no exact admission",
    guard_code: "pages_product_incomplete",
    kind: "missing-admission",
    product_id: "base",
  }],
  products: [],
  ready: false,
}));
const files = [
  identity("api/index.html"),
  identity("browser/index.html"),
  identity("guide/index.html"),
  productFile,
].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const site = {
  builds: {
    api: identity("api/index.html"),
    browser: identity("browser/index.html"),
    documentation: identity("guide/index.html"),
  },
  files,
  kind: "kandelo-pages-site-manifest",
  pages_registry: readiness.pages_registry,
  products: [{ ...readiness.products[0], path: productFile.path }],
  readiness_record_sha256: sha(readinessBytes),
  schema: 1,
  site_metadata_sha256: readiness.site_metadata_sha256,
  source: readiness.source,
  target_abi: readiness.target_abi,
};
writeFileSync(join(root, "site.json"), canonical(site));
writeFileSync(
  join(source, ".well-known/kandelo/pages-deployment.json"),
  canonical(site),
);
NODE

cd "$repo_root"
npx tsx scripts/abi-staging-pages-readiness.ts assemble-site \
  --activation "$legacy_activation" \
  --readiness "$test_root/held.json" \
  --site-manifest "$test_root/site.json" \
  --source-tree "$source_root" \
  --deployment-root "$deployment_root" \
  --max-bytes 1048576
cmp "$test_root/prior-pointer.json" "$deployment_root/current-site.json"
cmp "$test_root/prior-index.html" "$deployment_root/sites/prior/index.html"
[ "$(find "$deployment_root/sites" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 1 ] ||
  fail "held readiness created a partial site"

cp -R "$source_root" "$test_root/broken-site"
find "$test_root/broken-site/products/base" -type f -name '*.vfs.zst' \
  -exec mv -- {} "$test_root/missing-product.vfs.zst" \;
[ -f "$test_root/missing-product.vfs.zst" ] ||
  fail "fixture did not remove its exact product file"
if npx tsx scripts/abi-staging-pages-readiness.ts assemble-site \
  --activation "$active_activation" \
  --readiness "$test_root/ready.json" \
  --site-manifest "$test_root/site.json" \
  --source-tree "$test_root/broken-site" \
  --deployment-root "$deployment_root" \
  --max-bytes 1048576; then
  fail "an incomplete sibling site was accepted"
fi
cmp "$test_root/prior-pointer.json" "$deployment_root/current-site.json"
cmp "$test_root/prior-index.html" "$deployment_root/sites/prior/index.html"
[ "$(find "$deployment_root/sites" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 1 ] ||
  fail "failed assembly left a partial output"

npx tsx scripts/abi-staging-pages-readiness.ts assemble-site \
  --activation "$legacy_activation" \
  --readiness "$test_root/ready.json" \
  --site-manifest "$test_root/site.json" \
  --source-tree "$source_root" \
  --deployment-root "$deployment_root" \
  --max-bytes 1048576

cmp "$test_root/prior-pointer.json" "$deployment_root/current-site.json"
cmp "$test_root/prior-index.html" "$deployment_root/sites/prior/index.html"
[ "$(find "$deployment_root/sites" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 2 ] ||
  fail "legacy activation did not retain exactly one inert complete sibling"

npx tsx scripts/abi-staging-pages-readiness.ts assemble-site \
  --activation "$observe_activation" \
  --readiness "$test_root/ready.json" \
  --site-manifest "$test_root/site.json" \
  --source-tree "$source_root" \
  --deployment-root "$deployment_root" \
  --max-bytes 1048576

cmp "$test_root/prior-pointer.json" "$deployment_root/current-site.json"

npx tsx scripts/abi-staging-pages-readiness.ts assemble-site \
  --activation "$active_activation" \
  --readiness "$test_root/ready.json" \
  --site-manifest "$test_root/site.json" \
  --source-tree "$source_root" \
  --deployment-root "$deployment_root" \
  --max-bytes 1048576

selected="$(node -e 'const fs=require("fs"); const p=process.argv[1]; process.stdout.write(JSON.parse(fs.readFileSync(p)).path)' "$deployment_root/current-site.json")"
[ "$selected" != "sites/prior" ] || fail "complete site did not replace the selection"
[ -f "$deployment_root/$selected/.well-known/kandelo/pages-deployment.json" ] ||
  fail "selected site lacks its exact deployment manifest"
cmp "$test_root/prior-index.html" "$deployment_root/sites/prior/index.html"

echo "ABI staging Pages atomic assembly: PASS"
