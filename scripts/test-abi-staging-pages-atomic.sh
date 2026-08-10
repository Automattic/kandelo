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
source_root="$test_root/ready-producer/output/source-tree"
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

mkdir -p "$deployment_root/sites/prior"
printf 'prior complete site\n' >"$deployment_root/sites/prior/index.html"
printf '{"kind":"prior-site","path":"sites/prior","schema":1}\n' \
  >"$deployment_root/current-site.json"
cp "$deployment_root/current-site.json" "$test_root/prior-pointer.json"
cp "$deployment_root/sites/prior/index.html" "$test_root/prior-index.html"

printf 'schema = 1\nkind = "kandelo-pages-activation"\nmode = "observe"\n' \
  >"$observe_activation"
printf 'schema = 1\nkind = "kandelo-pages-activation"\nmode = "active"\n' \
  >"$active_activation"

cd "$repo_root"
npx tsx scripts/abi-staging-pages-producer-fixture.ts \
  produce "$test_root/ready-producer" ready
npx tsx scripts/abi-staging-pages-producer-fixture.ts \
  produce "$test_root/held-producer" missing-admission
cp "$test_root/ready-producer/output/readiness.json" "$test_root/ready.json"
cp "$test_root/ready-producer/output/site-manifest.json" "$test_root/site.json"
cp "$test_root/held-producer/output/readiness.json" "$test_root/held.json"

npx tsx scripts/abi-staging-pages-readiness.ts assemble-site \
  --activation "$legacy_activation" \
  --readiness "$test_root/held.json" \
  --site-manifest "$test_root/site.json" \
  --source-tree "$source_root" \
  --deployment-root "$deployment_root" \
  --max-bytes 16777216
cmp "$test_root/prior-pointer.json" "$deployment_root/current-site.json"
cmp "$test_root/prior-index.html" "$deployment_root/sites/prior/index.html"
[ "$(find "$deployment_root/sites" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 1 ] ||
  fail "held readiness created a partial site"

cp -R "$source_root" "$test_root/broken-site"
find "$test_root/broken-site/products" -type f -name '*.vfs.zst' \
  -exec mv -- {} "$test_root/missing-product.vfs.zst" \;
[ -f "$test_root/missing-product.vfs.zst" ] ||
  fail "fixture did not remove its exact product file"
if npx tsx scripts/abi-staging-pages-readiness.ts assemble-site \
  --activation "$active_activation" \
  --readiness "$test_root/ready.json" \
  --site-manifest "$test_root/site.json" \
  --source-tree "$test_root/broken-site" \
  --deployment-root "$deployment_root" \
  --max-bytes 16777216; then
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
  --max-bytes 16777216

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
  --max-bytes 16777216

cmp "$test_root/prior-pointer.json" "$deployment_root/current-site.json"

npx tsx scripts/abi-staging-pages-readiness.ts assemble-site \
  --activation "$active_activation" \
  --readiness "$test_root/ready.json" \
  --site-manifest "$test_root/site.json" \
  --source-tree "$source_root" \
  --deployment-root "$deployment_root" \
  --max-bytes 16777216

selected="$(node -e 'const fs=require("fs"); const p=process.argv[1]; process.stdout.write(JSON.parse(fs.readFileSync(p)).path)' "$deployment_root/current-site.json")"
[ "$selected" != "sites/prior" ] || fail "complete site did not replace the selection"
[ -f "$deployment_root/$selected/.well-known/kandelo/pages-deployment.json" ] ||
  fail "selected site lacks its exact deployment manifest"
cmp "$test_root/prior-index.html" "$deployment_root/sites/prior/index.html"

echo "ABI staging Pages atomic assembly: PASS"
