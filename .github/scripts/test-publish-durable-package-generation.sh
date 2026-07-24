#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLISH="$SCRIPT_DIR/publish-durable-package-generation.sh"
MATERIALIZE="$SCRIPT_DIR/materialize-durable-package-generation.sh"
TOOL="$SCRIPT_DIR/package-generation.py"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/archives" "$TMP_ROOT/lock"

hex_a="$(printf 'a%.0s' {1..64})"
source_sha="$(printf '1%.0s' {1..40})"
printf 'root archive\n' >"$TMP_ROOT/archives/rootfs.tar.zst"
printf 'source index\n' >"$TMP_ROOT/source-index.toml"
cat >"$TMP_ROOT/localized-index.toml" <<'EOF'
abi_version = 42
generated_at = "1970-01-01T00:00:00Z"
generator = "test"
archive_url = "rootfs.tar.zst"
EOF
if command -v sha256sum >/dev/null 2>&1; then
  archive_sha="$(sha256sum "$TMP_ROOT/archives/rootfs.tar.zst" | awk '{print $1}')"
else
  archive_sha="$(shasum -a 256 "$TMP_ROOT/archives/rootfs.tar.zst" | awk '{print $1}')"
fi
archive_size="$(wc -c <"$TMP_ROOT/archives/rootfs.tar.zst" | tr -d '[:space:]')"
jq -nS --arg a "$hex_a" '{
  schema:1,
  root_package:"rootfs",
  arch:"wasm32",
  entries:[{
    package:"rootfs",arch:"wasm32",
    manifest_sha256:$a,cache_key_sha:$a
  }]
}' >"$TMP_ROOT/projection.json"
jq -nS --arg a "$hex_a" '{
  abi_version:42,
  entries:[{
    package:"rootfs",kind:"program",arch:"wasm32",
    version:"1",revision:1,cache_key_sha:$a,git_inputs:[]
  }]
}' >"$TMP_ROOT/expected.json"
jq -nS \
  --arg a "$hex_a" \
  --arg archive_sha "$archive_sha" \
  --argjson archive_size "$archive_size" '{
    abi_version:42,
    release_tag:"pr-1079-staging",
    complete_current:true,
    entries:[{
      package:"rootfs",kind:"program",arch:"wasm32",
      version:"1",revision:1,cache_key_sha:$a,current:true,
      asset:"rootfs.tar.zst",
      archive_sha256:$archive_sha,
      size:$archive_size
    }]
  }' >"$TMP_ROOT/snapshot.json"
python3 "$TOOL" prepare \
  --repository Automattic/kandelo \
  --package-source-sha "$source_sha" \
  --source-tag pr-1079-staging \
  --source-index "$TMP_ROOT/source-index.toml" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/snapshot.json" \
  --localized-index "$TMP_ROOT/localized-index.toml" \
  --archives-dir "$TMP_ROOT/archives" \
  --output-dir "$TMP_ROOT/bundle" >/dev/null

cat >"$TMP_ROOT/bin/authority-xtask" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for name in \
  GH_TOKEN GITHUB_TOKEN \
  HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN \
  HOMEBREW_DOCKER_REGISTRY_TOKEN \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL \
  ACTIONS_RUNTIME_TOKEN; do
  [ -z "${!name:-}" ] || {
    echo "authority xtask inherited $name" >&2
    exit 97
  }
done
[ "$1 $2" = "staging-reuse validate-archives" ]
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-ledger) expected="$2"; shift 2 ;;
    --snapshot) snapshot="$2"; shift 2 ;;
    --archives-dir) archives="$2"; shift 2 ;;
    --scope) scope="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "$(jq -r .abi_version "$expected")" = 42 ]
[ "$(jq -r .complete_current "$snapshot")" = true ]
[ -f "$archives/rootfs.tar.zst" ]
[ "$scope" = all ]
EOF
chmod +x "$TMP_ROOT/bin/authority-xtask"

cat >"$TMP_ROOT/bin/state-lock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${LOCK_LOG:?}"
EOF
chmod +x "$TMP_ROOT/bin/state-lock"

cat >"$TMP_ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="${GH_STUB_ROOT:?}"
sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
release_json() {
  jq -n \
    --arg tag "$(cat "$root/tag")" \
    --arg target "$(cat "$root/target")" \
    --arg title "$(cat "$root/title")" \
    --arg body "$(cat "$root/body")" \
    --argjson draft "$(cat "$root/draft")" '{
      id:17,tag_name:$tag,target_commitish:$target,
      name:$title,body:$body,draft:$draft,
      prerelease:true,immutable:false
    }'
}
assets_json() {
  if [ ! -d "$root/assets" ]; then
    printf '[]\n'
    return
  fi
  i=0
  for path in "$root"/assets/*; do
    [ -f "$path" ] || continue
    i=$((i + 1))
    jq -cn \
      --arg name "${path##*/}" \
      --arg digest "sha256:$(sha_file "$path")" \
      --argjson size "$(wc -c <"$path" | tr -d '[:space:]')" \
      --argjson id "$((1000 + i))" \
      '{id:$id,name:$name,state:"uploaded",size:$size,digest:$digest}'
  done | jq -s .
}
emit_get() {
  local body="$1"
  if [ "$include" = true ]; then
    printf 'HTTP/1.1 200 OK\r\n\r\n'
  fi
  printf '%s\n' "$body"
}
emit_404() {
  if [ "$include" = true ]; then
    printf 'HTTP/1.1 404 Not Found\r\n\r\n'
  fi
  exit 1
}

if [ "$1 $2" = "release upload" ]; then
  mkdir -p "$root/assets"
  file="${!#}"
  cp "$file" "$root/assets/${file##*/}"
  printf 'upload %s\n' "${file##*/}" >>"${WRITE_LOG:?}"
  exit 0
fi
[ "$1" = api ] || exit 2
shift
include=false
paginate=false
slurp=false
method=GET
endpoint=""
fields=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --include) include=true; shift ;;
    --paginate) paginate=true; shift ;;
    --slurp) slurp=true; shift ;;
    --method) method="$2"; shift 2 ;;
    -H) shift 2 ;;
    -f|-F) fields+=("$2"); shift 2 ;;
    /*) endpoint="$1"; shift ;;
    *) shift ;;
  esac
done

if [ "$method" = POST ] && [[ "$endpoint" == */git/refs ]]; then
  for field in "${fields[@]}"; do
    case "$field" in
      ref=*) printf '%s' "${field#ref=refs/tags/}" >"$root/ref-tag" ;;
      sha=*) printf '%s' "${field#sha=}" >"$root/ref-sha" ;;
    esac
  done
  printf 'post-tag\n' >>"${WRITE_LOG:?}"
  printf '{}\n'
  exit 0
fi
if [ "$method" = POST ] && [[ "$endpoint" == */releases ]]; then
  mkdir -p "$root/assets"
  for field in "${fields[@]}"; do
    case "$field" in
      tag_name=*) printf '%s' "${field#tag_name=}" >"$root/tag" ;;
      target_commitish=*) printf '%s' "${field#target_commitish=}" >"$root/target" ;;
      name=*) printf '%s' "${field#name=}" >"$root/title" ;;
      body=*) printf '%s' "${field#body=}" >"$root/body" ;;
    esac
  done
  printf true >"$root/draft"
  : >"$root/release-exists"
  printf 'post-release\n' >>"${WRITE_LOG:?}"
  release_json
  exit 0
fi
if [ "$method" = PATCH ] && [[ "$endpoint" == */releases/17 ]]; then
  printf false >"$root/draft"
  printf 'patch-release\n' >>"${WRITE_LOG:?}"
  release_json
  exit 0
fi
if [[ "$endpoint" == */git/ref/tags/* ]]; then
  [ -f "$root/ref-tag" ] || emit_404
  emit_get "$(jq -n \
    --arg tag "$(cat "$root/ref-tag")" \
    --arg sha "$(cat "$root/ref-sha")" '{
      ref:("refs/tags/"+$tag),object:{type:"commit",sha:$sha}
    }')"
  exit 0
fi
if [[ "$endpoint" == */releases/tags/* ]]; then
  [ -f "$root/release-exists" ] || emit_404
  [ "$(cat "$root/draft")" = false ] || emit_404
  emit_get "$(release_json)"
  exit 0
fi
if [[ "$endpoint" == */releases/17/assets* ]]; then
  body="$(assets_json)"
  if [ "$paginate" = true ] && [ "$slurp" = true ]; then
    printf '[%s]\n' "$body"
  else
    emit_get "$body"
  fi
  exit 0
fi
if [[ "$endpoint" == */releases/17 ]]; then
  [ -f "$root/release-exists" ] || emit_404
  emit_get "$(release_json)"
  exit 0
fi
if [[ "$endpoint" == */releases\?per_page=100 ]]; then
  if [ -f "$root/release-exists" ]; then
    printf '[[%s]]\n' "$(release_json)"
  else
    printf '[[]]\n'
  fi
  exit 0
fi
if [[ "$endpoint" == */releases/assets/* ]]; then
  id="${endpoint##*/}"
  i=0
  for path in "$root"/assets/*; do
    [ -f "$path" ] || continue
    i=$((i + 1))
    if [ "$id" = "$((1000 + i))" ]; then
      cat "$path"
      exit 0
    fi
  done
fi
echo "unexpected gh request: method=$method endpoint=$endpoint" >&2
exit 2
EOF
chmod +x "$TMP_ROOT/bin/gh"

cat >"$TMP_ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
url="${!#}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
name="${url##*/}"
cp "${GH_STUB_ROOT:?}/assets/$name" "$output"
EOF
chmod +x "$TMP_ROOT/bin/curl"

run_publisher() {
  local remote="${1:-$TMP_ROOT/remote}"
  local receipt="${2:-$TMP_ROOT/receipt.json}"
  env \
    PATH="$TMP_ROOT/bin:$PATH" \
    GH_TOKEN=test-token \
    GITHUB_TOKEN=test-fallback-token \
    HOMEBREW_GITHUB_API_TOKEN=test-api-token \
    HOMEBREW_GITHUB_PACKAGES_TOKEN=test-packages-token \
    HOMEBREW_DOCKER_REGISTRY_TOKEN=test-registry-token \
    ACTIONS_ID_TOKEN_REQUEST_TOKEN=test-oidc-token \
    ACTIONS_ID_TOKEN_REQUEST_URL=https://example.invalid/oidc \
    ACTIONS_RUNTIME_TOKEN=test-runtime-token \
    GITHUB_REPOSITORY=Automattic/kandelo \
    GITHUB_RUN_ID=123 \
    GITHUB_RUN_ATTEMPT=1 \
    GITHUB_JOB=publish \
    GITHUB_WORKFLOW=test \
    GH_STUB_ROOT="$remote" \
    WRITE_LOG="$TMP_ROOT/writes.log" \
    LOCK_LOG="$TMP_ROOT/locks.log" \
    STATE_LOCK_SCRIPT="$TMP_ROOT/bin/state-lock" \
    PACKAGE_GENERATION_RETRY_DELAY_SECONDS=0 \
    bash "$PUBLISH" \
      --bundle "$TMP_ROOT/bundle" \
      --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
      --lock-root "$TMP_ROOT/lock" \
      --receipt "$receipt"
}

mkdir "$TMP_ROOT/remote"
: >"$TMP_ROOT/writes.log"
: >"$TMP_ROOT/locks.log"
run_publisher
[ "$(jq -r .application_sealed "$TMP_ROOT/receipt.json")" = true ]
[ "$(cat "$TMP_ROOT/remote/draft")" = false ]
[ "$(find "$TMP_ROOT/remote/assets" -type f | wc -l | tr -d '[:space:]')" = 3 ]
[ "$(tail -n 2 "$TMP_ROOT/writes.log" | head -n 1)" = "upload generation.json" ]
[ "$(tail -n 1 "$TMP_ROOT/writes.log")" = "patch-release" ]
sed 's/ .*//' "$TMP_ROOT/locks.log" | grep -Fxq acquire
grep -Fxq release "$TMP_ROOT/locks.log"

# A compatible exact consumer can materialize the anonymous release only after
# current authority revalidates archive manifests.
mkdir -p \
  "$TMP_ROOT/consumer/packages/registry" \
  "$TMP_ROOT/consumer/crates/shared/src"
jq -nS --arg a "$hex_a" '{
  format:"kandelo-program-packages-v2",
  packages:{
    rootfs:{
      manifestSha256:$a,
      arches:["wasm32"],
      cacheKeys:{wasm32:$a},
      dependencyClosures:{wasm32:[]}
    }
  }
}' >"$TMP_ROOT/consumer/packages/registry/program-packages.json"
cp "$TMP_ROOT/expected.json" \
  "$TMP_ROOT/consumer/packages/registry/.test-expected.json"
printf 'pub const ABI_VERSION: u32 = 42;\n' \
  >"$TMP_ROOT/consumer/crates/shared/src/lib.rs"
git -C "$TMP_ROOT/consumer" init -q
git -C "$TMP_ROOT/consumer" config user.name "Kandelo test"
git -C "$TMP_ROOT/consumer" config user.email test@example.invalid
git -C "$TMP_ROOT/consumer" add .
git -C "$TMP_ROOT/consumer" commit -qm "test consumer"
consumer_sha="$(git -C "$TMP_ROOT/consumer" rev-parse HEAD)"

cat >"$TMP_ROOT/bin/consumer-xtask" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for name in \
  GH_TOKEN GITHUB_TOKEN \
  HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN \
  HOMEBREW_DOCKER_REGISTRY_TOKEN \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL \
  ACTIONS_RUNTIME_TOKEN; do
  [ -z "${!name:-}" ] || exit 97
done
[ "$1 $2" = "staging-reuse expected" ]
shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --registry) registry="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) shift 2 ;;
  esac
done
cp "$registry/.test-expected.json" "$output"
EOF
chmod +x "$TMP_ROOT/bin/consumer-xtask"

tag="$(jq -r .tag "$TMP_ROOT/bundle/generation.json")"
env \
  PATH="$TMP_ROOT/bin:$PATH" \
  GH_TOKEN=test-token \
  GITHUB_TOKEN=test-fallback-token \
  HOMEBREW_GITHUB_API_TOKEN=test-api-token \
  HOMEBREW_GITHUB_PACKAGES_TOKEN=test-packages-token \
  HOMEBREW_DOCKER_REGISTRY_TOKEN=test-registry-token \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN=test-oidc-token \
  ACTIONS_ID_TOKEN_REQUEST_URL=https://example.invalid/oidc \
  ACTIONS_RUNTIME_TOKEN=test-runtime-token \
  GH_STUB_ROOT="$TMP_ROOT/remote" \
  bash "$MATERIALIZE" \
    --tag "$tag" \
    --consumer-root "$TMP_ROOT/consumer" \
    --consumer-sha "$consumer_sha" \
    --consumer-xtask "$TMP_ROOT/bin/consumer-xtask" \
    --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
    --repository Automattic/kandelo \
    --output-dir "$TMP_ROOT/materialized"
[ -f "$TMP_ROOT/materialized/release/generation.json" ]
[ -f "$TMP_ROOT/materialized/resolver/index.toml" ]
grep -Fxq "file://$TMP_ROOT/materialized/resolver/index.toml" \
  "$TMP_ROOT/materialized/index-url.txt"

# A public retry is verification-only. It must not upload, patch, recreate the
# release, or move the direct tag.
: >"$TMP_ROOT/writes.log"
run_publisher
[ ! -s "$TMP_ROOT/writes.log" ]

# An interrupted draft resumes from its exact verified subset. The seal is
# still uploaded last, and the existing asset is never overwritten.
mkdir -p "$TMP_ROOT/partial-remote/assets"
jq -r .tag "$TMP_ROOT/bundle/generation.json" >"$TMP_ROOT/partial-remote/tag"
jq -r .release.target_commitish "$TMP_ROOT/bundle/generation.json" \
  >"$TMP_ROOT/partial-remote/target"
jq -r .release.title "$TMP_ROOT/bundle/generation.json" \
  >"$TMP_ROOT/partial-remote/title"
jq -r .release.body "$TMP_ROOT/bundle/generation.json" \
  >"$TMP_ROOT/partial-remote/body"
cp "$TMP_ROOT/partial-remote/tag" "$TMP_ROOT/partial-remote/ref-tag"
cp "$TMP_ROOT/partial-remote/target" "$TMP_ROOT/partial-remote/ref-sha"
cp "$TMP_ROOT/bundle/index.toml" "$TMP_ROOT/partial-remote/assets/index.toml"
printf true >"$TMP_ROOT/partial-remote/draft"
: >"$TMP_ROOT/partial-remote/release-exists"
: >"$TMP_ROOT/writes.log"
run_publisher \
  "$TMP_ROOT/partial-remote" \
  "$TMP_ROOT/partial-receipt.json"
[ "$(cat "$TMP_ROOT/partial-remote/draft")" = false ]
[ "$(find "$TMP_ROOT/partial-remote/assets" -type f | wc -l | tr -d '[:space:]')" = 3 ]
if grep -Fxq "upload index.toml" "$TMP_ROOT/writes.log"; then
  echo "exact existing draft asset was overwritten" >&2
  exit 1
fi
[ "$(tail -n 2 "$TMP_ROOT/writes.log" | head -n 1)" = "upload generation.json" ]
[ "$(tail -n 1 "$TMP_ROOT/writes.log")" = "patch-release" ]

# A post-public mutation is detected and never repaired in place.
printf 'mutated public bytes\n' >"$TMP_ROOT/remote/assets/rootfs.tar.zst"
: >"$TMP_ROOT/writes.log"
if run_publisher; then
  echo "mutated public generation was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]

echo "test-publish-durable-package-generation: ok"
