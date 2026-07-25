#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FREEZE="$SCRIPT_DIR/freeze-homebrew-prepublication-generation.sh"
ACTIVATE="$SCRIPT_DIR/activate-homebrew-prepublication-generation.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/assets"

hex_a="$(printf 'a%.0s' {1..64})"
hex_b="$(printf 'b%.0s' {1..64})"
hex_c="$(printf 'c%.0s' {1..64})"
for root in generation consumer; do
  mkdir -p "$TMP_ROOT/$root/packages/registry"
  jq -nS --arg a "$hex_a" --arg b "$hex_b" '{
    format: "kandelo-program-packages-v2",
    packages: {
      rootfs: {
        manifestSha256: $b,
        arches: ["wasm32"],
        cacheKeys: {wasm32: $b},
        dependencyClosures: {
          wasm32: [{
            packageName: "dep",
            manifestSha256: $a,
            cacheKey: $a
          }]
        },
        members: []
      }
    }
  }' >"$TMP_ROOT/$root/packages/registry/program-packages.json"
  git -C "$TMP_ROOT/$root" init -q
  git -C "$TMP_ROOT/$root" config user.name "Kandelo test"
  git -C "$TMP_ROOT/$root" config user.email "test@example.invalid"
  git -C "$TMP_ROOT/$root" add packages/registry/program-packages.json
  git -C "$TMP_ROOT/$root" commit -qm "test projection"
done

jq -nS --arg a "$hex_a" --arg b "$hex_b" '{
  abi_version: 42,
  entries: [
    {package:"dep",kind:"program",arch:"wasm32",version:"1",revision:1,cache_key_sha:$a,git_inputs:[]},
    {package:"rootfs",kind:"program",arch:"wasm32",version:"1",revision:1,cache_key_sha:$b,git_inputs:[]},
    {package:"unvalidated",kind:"program",arch:"wasm32",version:"1",revision:1,cache_key_sha:$a,git_inputs:[]}
  ]
}' >"$TMP_ROOT/full-expected.json"
for root in generation consumer; do
  cp "$TMP_ROOT/full-expected.json" \
    "$TMP_ROOT/$root/packages/registry/.test-expected.json"
  git -C "$TMP_ROOT/$root" add packages/registry/.test-expected.json
  git -C "$TMP_ROOT/$root" commit -qm "test expected ledger"
done
generation_sha="$(git -C "$TMP_ROOT/generation" rev-parse HEAD)"
consumer_sha="$(git -C "$TMP_ROOT/consumer" rev-parse HEAD)"

printf 'dep archive\n' >"$TMP_ROOT/assets/dep.tar.zst"
printf 'rootfs archive\n' >"$TMP_ROOT/assets/rootfs.tar.zst"
printf 'unvalidated archive\n' >"$TMP_ROOT/assets/unvalidated.tar.zst"
cat >"$TMP_ROOT/assets/index.toml" <<'EOF'
abi_version = 42
archive_url = "https://github.com/Automattic/kandelo/releases/download/pr-1079-staging/dep.tar.zst"
archive_url = "https://github.com/Automattic/kandelo/releases/download/pr-1079-staging/rootfs.tar.zst"
archive_url = "https://github.com/Automattic/kandelo/releases/download/pr-1079-staging/unvalidated.tar.zst"
EOF

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
asset_record() {
  local name="$1"
  local path="$TMP_ROOT/assets/$name"
  jq -n \
    --arg name "$name" \
    --arg digest "sha256:$(sha_file "$path")" \
    --argjson size "$(wc -c <"$path" | tr -d '[:space:]')" \
    '{name:$name,state:"uploaded",size:$size,digest:$digest}'
}
ASSETS="$(
  jq -s '.' < <(
    asset_record index.toml
    asset_record dep.tar.zst
    asset_record rootfs.tar.zst
    asset_record unvalidated.tar.zst
  )
)"

cat >"$TMP_ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = api ] && [[ "$*" == *'/releases/tags/'* ]]; then
  printf '17\n'
elif [ "$1" = api ] && [[ "$*" == *'/assets?per_page=100'* ]]; then
  printf '[%s]\n' "${GH_STUB_ASSETS:?}"
elif [ "$1 $2" = "release download" ]; then
  pattern=""; dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "${GH_STUB_ASSET_ROOT:?}/$pattern" "$dir/$pattern"
else
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi
EOF
chmod +x "$TMP_ROOT/bin/gh"

cat >"$TMP_ROOT/bin/xtask" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for credential_name in \
  GH_TOKEN GITHUB_TOKEN \
  HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN \
  HOMEBREW_DOCKER_REGISTRY_TOKEN; do
  [ -z "${!credential_name:-}" ] || {
    echo "xtask inherited $credential_name" >&2
    exit 97
  }
done
action="${1:-} ${2:-}"
if [ "$action" = "staging-reuse expected" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --registry) registry="$2"; shift 2 ;;
      --output) output="$2"; shift 2 ;;
      *) shift 2 ;;
    esac
  done
  cp "${registry:?}/.test-expected.json" "$output"
  exit 0
fi
if [ "$action" = "staging-reuse validate" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --expected-ledger) expected="$2"; shift 2 ;;
      --output) output="$2"; shift 2 ;;
      --localized-index) localized="$2"; shift 2 ;;
      *) shift 2 ;;
    esac
  done
  [ "$(jq -r '.entries | length' "$expected")" = 2 ]
  cp "${GH_STUB_ASSET_ROOT:?}/index.toml" "$localized"
  sha_file() {
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | awk '{print $1}'
    else
      shasum -a 256 "$1" | awk '{print $1}'
    fi
  }
  jq -nS \
    --arg dep_sha "$(sha_file "${GH_STUB_ASSET_ROOT:?}/dep.tar.zst")" \
    --arg root_sha "$(sha_file "${GH_STUB_ASSET_ROOT:?}/rootfs.tar.zst")" \
    --arg hex_a "${HEX_A:?}" \
    --arg hex_b "${HEX_B:?}" \
    --argjson dep_size "$(wc -c <"${GH_STUB_ASSET_ROOT:?}/dep.tar.zst")" \
    --argjson root_size "$(wc -c <"${GH_STUB_ASSET_ROOT:?}/rootfs.tar.zst")" '{
      abi_version:42,
      release_tag:"pr-1079-staging",
      complete_current:true,
      entries:[
        {package:"dep",kind:"program",arch:"wasm32",version:"1",revision:1,cache_key_sha:$hex_a,current:true,asset:"dep.tar.zst",archive_sha256:$dep_sha,size:$dep_size},
        {package:"rootfs",kind:"program",arch:"wasm32",version:"1",revision:1,cache_key_sha:$hex_b,current:true,asset:"rootfs.tar.zst",archive_sha256:$root_sha,size:$root_size}
      ]
    }' >"$output"
  exit 0
fi
if [ "$action" = "staging-reuse validate-archives" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --archives-dir) archives="$2"; shift 2 ;;
      *) shift 2 ;;
    esac
  done
  [ -f "$archives/dep.tar.zst" ]
  [ -f "$archives/rootfs.tar.zst" ]
  [ ! -e "$archives/unvalidated.tar.zst" ]
  exit 0
fi
if [ "${1:-}" = build-index ]; then
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --archives-dir) archives="$2"; shift 2 ;;
      --out) output="$2"; shift 2 ;;
      *) shift 2 ;;
    esac
  done
  [ -f "$archives/dep.tar.zst" ] && [ -f "$archives/rootfs.tar.zst" ]
  [ ! -e "$archives/unvalidated.tar.zst" ]
  cat >"$output" <<INDEX
abi_version = 42
archive_url = "dep.tar.zst"
archive_url = "rootfs.tar.zst"
INDEX
  exit 0
fi
if [ "$action" = "index-candidate seed" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --canonical-index) input="$2"; shift 2 ;;
      --candidate-index) output="$2"; shift 2 ;;
      --canonical-index-url) url="$2"; shift 2 ;;
      *) shift 2 ;;
    esac
  done
  base="${url%/*}/"
  sed "s#archive_url = \"#archive_url = \"${base}#" "$input" >"$output"
  exit 0
fi
echo "unexpected xtask invocation: $*" >&2
exit 1
EOF
chmod +x "$TMP_ROOT/bin/xtask"

env \
  PATH="$TMP_ROOT/bin:$PATH" \
  GH_TOKEN=test-release-token \
  GITHUB_TOKEN=test-fallback-token \
  HOMEBREW_GITHUB_API_TOKEN=test-api-token \
  HOMEBREW_GITHUB_PACKAGES_TOKEN=test-packages-token \
  HOMEBREW_DOCKER_REGISTRY_TOKEN=test-registry-token \
  GH_STUB_ASSETS="$ASSETS" \
  GH_STUB_ASSET_ROOT="$TMP_ROOT/assets" \
  HEX_A="$hex_a" \
  HEX_B="$hex_b" \
  bash "$FREEZE" \
    --tag pr-1079-staging \
    --generation-root "$TMP_ROOT/generation" \
    --consumer-root "$TMP_ROOT/consumer" \
    --expected-abi 42 \
    --generation-sha "$generation_sha" \
    --consumer-sha "$consumer_sha" \
    --repository Automattic/kandelo \
    --output-dir "$TMP_ROOT/sealed" \
    --xtask "$TMP_ROOT/bin/xtask"

[ "$(jq -r '.package_count' "$TMP_ROOT/sealed/manifest.json")" = 2 ]
grep -Fq '/pr-1079-staging/dep.tar.zst' "$TMP_ROOT/sealed/index.toml"
grep -Fq '/pr-1079-staging/rootfs.tar.zst' "$TMP_ROOT/sealed/index.toml"
if grep -Fq unvalidated "$TMP_ROOT/sealed/index.toml"; then
  echo "unvalidated extra staging entry escaped into the frozen index" >&2
  exit 1
fi

env_file="$TMP_ROOT/github-env"
bash "$ACTIVATE" \
  --bundle "$TMP_ROOT/sealed" \
  --expected-tag pr-1079-staging \
  --expected-generation-sha "$generation_sha" \
  --expected-consumer-sha "$consumer_sha" \
  --expected-abi 42 \
  --github-env "$env_file"
grep -Fxq "WASM_POSIX_BINARY_INDEX_URL=file://$TMP_ROOT/sealed/index.toml" "$env_file"

refresh_manifest_binding() {
  local bundle="$1"
  local name="$2"
  local sha size
  sha="$(sha_file "$bundle/$name")"
  size="$(wc -c <"$bundle/$name" | tr -d '[:space:]')"
  jq -S \
    --arg name "$name" \
    --arg sha "$sha" \
    --argjson size "$size" \
    '.files[$name] = {sha256: $sha, size: $size}' \
    "$bundle/manifest.json" >"$bundle/manifest.next.json"
  mv "$bundle/manifest.next.json" "$bundle/manifest.json"
}

# Every ancillary file is byte-bound, not merely checked for a plausible
# entry count.
for name in projection.json expected-ledger.json snapshot.json assets.json; do
  tampered="$TMP_ROOT/tampered-${name%.json}"
  cp -R "$TMP_ROOT/sealed" "$tampered"
  printf '\n' >>"$tampered/$name"
  if bash "$ACTIVATE" \
      --bundle "$tampered" \
      --expected-tag pr-1079-staging \
      --expected-generation-sha "$generation_sha" \
      --expected-consumer-sha "$consumer_sha" \
      --expected-abi 42 \
      --github-env "$TMP_ROOT/rejected-${name%.json}-env"; then
    echo "modified $name was activated" >&2
    exit 1
  fi
done

# Even a manifest-authorized replacement must preserve the same exact
# package/arch/cache-key identity set across all three ledgers.
cp -R "$TMP_ROOT/sealed" "$TMP_ROOT/identity-mismatch"
jq --arg cache_key "$hex_c" \
  '.entries[0].cache_key_sha = $cache_key' \
  "$TMP_ROOT/identity-mismatch/projection.json" \
  >"$TMP_ROOT/identity-mismatch/projection.next.json"
mv "$TMP_ROOT/identity-mismatch/projection.next.json" \
  "$TMP_ROOT/identity-mismatch/projection.json"
refresh_manifest_binding "$TMP_ROOT/identity-mismatch" projection.json
if bash "$ACTIVATE" \
    --bundle "$TMP_ROOT/identity-mismatch" \
    --expected-tag pr-1079-staging \
    --expected-generation-sha "$generation_sha" \
    --expected-consumer-sha "$consumer_sha" \
    --expected-abi 42 \
    --github-env "$TMP_ROOT/rejected-identity-env"; then
  echo "mismatched sealed package identities were activated" >&2
  exit 1
fi

# Snapshot archive identities must still name the exact release asset record.
cp -R "$TMP_ROOT/sealed" "$TMP_ROOT/asset-mismatch"
jq --arg digest "sha256:$hex_c" \
  '(.[] | select(.name == "dep.tar.zst")).digest = $digest' \
  "$TMP_ROOT/asset-mismatch/assets.json" \
  >"$TMP_ROOT/asset-mismatch/assets.next.json"
mv "$TMP_ROOT/asset-mismatch/assets.next.json" \
  "$TMP_ROOT/asset-mismatch/assets.json"
refresh_manifest_binding "$TMP_ROOT/asset-mismatch" assets.json
if bash "$ACTIVATE" \
    --bundle "$TMP_ROOT/asset-mismatch" \
    --expected-tag pr-1079-staging \
    --expected-generation-sha "$generation_sha" \
    --expected-consumer-sha "$consumer_sha" \
    --expected-abi 42 \
    --github-env "$TMP_ROOT/rejected-asset-env"; then
  echo "mismatched sealed release asset identity was activated" >&2
  exit 1
fi

# The generation/consumer equality check is the bridge's central safety
# boundary: a workflow descendant may reuse F's bytes only while its package
# identities still describe those exact bytes.
cp -R "$TMP_ROOT/consumer" "$TMP_ROOT/consumer-drift"
jq --arg cache_key "$hex_c" \
  '.packages.rootfs.cacheKeys.wasm32 = $cache_key' \
  "$TMP_ROOT/consumer-drift/packages/registry/program-packages.json" \
  >"$TMP_ROOT/consumer-drift/program-packages.next.json"
mv "$TMP_ROOT/consumer-drift/program-packages.next.json" \
  "$TMP_ROOT/consumer-drift/packages/registry/program-packages.json"
git -C "$TMP_ROOT/consumer-drift" add packages/registry/program-packages.json
git -C "$TMP_ROOT/consumer-drift" commit -qm "drift rootfs identity"
drift_sha="$(git -C "$TMP_ROOT/consumer-drift" rev-parse HEAD)"
if env \
    PATH="$TMP_ROOT/bin:$PATH" \
    GH_TOKEN=test-release-token \
    GITHUB_TOKEN=test-fallback-token \
    HOMEBREW_GITHUB_API_TOKEN=test-api-token \
    HOMEBREW_GITHUB_PACKAGES_TOKEN=test-packages-token \
    HOMEBREW_DOCKER_REGISTRY_TOKEN=test-registry-token \
    GH_STUB_ASSETS="$ASSETS" \
    GH_STUB_ASSET_ROOT="$TMP_ROOT/assets" \
    HEX_A="$hex_a" \
    HEX_B="$hex_b" \
    bash "$FREEZE" \
      --tag pr-1079-staging \
      --generation-root "$TMP_ROOT/generation" \
      --consumer-root "$TMP_ROOT/consumer-drift" \
      --expected-abi 42 \
      --generation-sha "$generation_sha" \
      --consumer-sha "$drift_sha" \
      --repository Automattic/kandelo \
      --output-dir "$TMP_ROOT/drift-sealed" \
      --xtask "$TMP_ROOT/bin/xtask"; then
  echo "consumer package-identity drift reused the generation archives" >&2
  exit 1
fi

# Expected-ledger drift must fail even when the committed rootfs projection
# and all package cache keys remain byte-identical.
cp -R "$TMP_ROOT/consumer" "$TMP_ROOT/consumer-ledger-drift"
jq '(.entries[] | select(.package == "dep")).revision = 2' \
  "$TMP_ROOT/consumer-ledger-drift/packages/registry/.test-expected.json" \
  >"$TMP_ROOT/consumer-ledger-drift/packages/registry/expected.next.json"
mv "$TMP_ROOT/consumer-ledger-drift/packages/registry/expected.next.json" \
  "$TMP_ROOT/consumer-ledger-drift/packages/registry/.test-expected.json"
git -C "$TMP_ROOT/consumer-ledger-drift" add packages/registry/.test-expected.json
git -C "$TMP_ROOT/consumer-ledger-drift" commit -qm "drift expected ledger only"
ledger_drift_sha="$(git -C "$TMP_ROOT/consumer-ledger-drift" rev-parse HEAD)"
if env \
    PATH="$TMP_ROOT/bin:$PATH" \
    GH_TOKEN=test-release-token \
    GITHUB_TOKEN=test-fallback-token \
    HOMEBREW_GITHUB_API_TOKEN=test-api-token \
    HOMEBREW_GITHUB_PACKAGES_TOKEN=test-packages-token \
    HOMEBREW_DOCKER_REGISTRY_TOKEN=test-registry-token \
    GH_STUB_ASSETS="$ASSETS" \
    GH_STUB_ASSET_ROOT="$TMP_ROOT/assets" \
    HEX_A="$hex_a" \
    HEX_B="$hex_b" \
    bash "$FREEZE" \
      --tag pr-1079-staging \
      --generation-root "$TMP_ROOT/generation" \
      --consumer-root "$TMP_ROOT/consumer-ledger-drift" \
      --expected-abi 42 \
      --generation-sha "$generation_sha" \
      --consumer-sha "$ledger_drift_sha" \
      --repository Automattic/kandelo \
      --output-dir "$TMP_ROOT/ledger-drift-sealed" \
      --xtask "$TMP_ROOT/bin/xtask"; then
  echo "consumer expected-ledger drift reused the generation archives" >&2
  exit 1
fi

printf '\n# changed\n' >>"$TMP_ROOT/sealed/index.toml"
if bash "$ACTIVATE" \
    --bundle "$TMP_ROOT/sealed" \
    --expected-tag pr-1079-staging \
    --expected-generation-sha "$generation_sha" \
    --expected-consumer-sha "$consumer_sha" \
    --expected-abi 42 \
    --github-env "$TMP_ROOT/rejected-env"; then
  echo "modified frozen index was activated" >&2
  exit 1
fi

echo "prepublication generation freeze tests passed"
