#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL="$SCRIPT_DIR/package-generation.py"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/archives" "$TMP_ROOT/lock"

# Run writer/materializer tests from a separate clean committed authority
# checkout. The production scripts intentionally reject dirty or substituted
# authority trees, including the working tree in which this test is running.
AUTHORITY_ROOT="$TMP_ROOT/authority"
mkdir -p "$AUTHORITY_ROOT/.github/scripts" "$AUTHORITY_ROOT/scripts"
for name in \
  publish-durable-package-generation.sh \
  materialize-durable-package-generation.sh \
  package-generation.py \
  github-api-get.sh \
  verify-preserved-package-source.sh
do
  cp "$SCRIPT_DIR/$name" "$AUTHORITY_ROOT/.github/scripts/$name"
done
cp "$SCRIPT_DIR/../../scripts/browser-binary-package-roots.mjs" \
  "$AUTHORITY_ROOT/scripts/browser-binary-package-roots.mjs"
git -C "$AUTHORITY_ROOT" init -q
git -C "$AUTHORITY_ROOT" config user.name "Kandelo test"
git -C "$AUTHORITY_ROOT" config user.email test@example.invalid
git -C "$AUTHORITY_ROOT" add .
git -C "$AUTHORITY_ROOT" commit -qm "test authority"
AUTHORITY_ROOT="$(git -C "$AUTHORITY_ROOT" rev-parse --show-toplevel)"
MATERIALIZE="$AUTHORITY_ROOT/.github/scripts/materialize-durable-package-generation.sh"

hex_a="$(printf 'a%.0s' {1..64})"
source_sha="$(git -C "$AUTHORITY_ROOT" rev-parse HEAD)"
authority_sha="$source_sha"
# WHY: the preserved producer is deliberately not the trusted publisher
# commit. This keeps the fixture honest about the evidence-only boundary.
preserved_source_sha="$(printf '5%.0s' {1..40})"
tree_sha="$(git -C "$AUTHORITY_ROOT" rev-parse 'HEAD^{tree}')"
cat >"$TMP_ROOT/rootfs-package.toml" <<'EOF'
kind = "program"
name = "rootfs"
version = "1"
EOF
if command -v sha256sum >/dev/null 2>&1; then
  root_manifest_sha="$(sha256sum "$TMP_ROOT/rootfs-package.toml" | awk '{print $1}')"
else
  root_manifest_sha="$(shasum -a 256 "$TMP_ROOT/rootfs-package.toml" | awk '{print $1}')"
fi
printf 'root archive\n' \
  >"$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
printf 'source index\n' >"$TMP_ROOT/source-index.toml"
cat >"$TMP_ROOT/localized-index.toml" <<'EOF'
abi_version = 42
generated_at = "1970-01-01T00:00:00Z"
generator = "test"
archive_url = "rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
EOF
if command -v sha256sum >/dev/null 2>&1; then
  archive_sha="$(sha256sum "$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" | awk '{print $1}')"
else
  archive_sha="$(shasum -a 256 "$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" | awk '{print $1}')"
fi
archive_size="$(wc -c <"$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" | tr -d '[:space:]')"
jq -nS --arg a "$hex_a" --arg manifest "$root_manifest_sha" '{
  schema:1,
  root_package:"rootfs",
  arch:"wasm32",
  entries:[{
    package:"rootfs",arch:"wasm32",
    manifest_sha256:$manifest,cache_key_sha:$a
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
    release_tag:"binaries-abi-v42",
    complete_current:true,
    entries:[{
      package:"rootfs",kind:"program",arch:"wasm32",
      version:"1",revision:1,cache_key_sha:$a,current:true,
      asset:"rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst",
      archive_sha256:$archive_sha,
      size:$archive_size
    }]
  }' >"$TMP_ROOT/snapshot.json"
jq -nS \
  --arg source "$source_sha" \
  --arg tree "$tree_sha" '{
    format:"kandelo-main-package-activation-v1",
    repository:"Automattic/kandelo",
    tag:"binaries-abi-v42",
    release_id:19,
    tag_sha:$source,
    default_ref:"main",
    package_source_sha:$source,
    tree_sha:$tree
  }' >"$TMP_ROOT/main-source-evidence.json"
python3 "$TOOL" prepare \
  --repository Automattic/kandelo \
  --package-source-sha "$source_sha" \
  --authority-sha "$source_sha" \
  --source-tag binaries-abi-v42 \
  --source-evidence "$TMP_ROOT/main-source-evidence.json" \
  --source-index "$TMP_ROOT/source-index.toml" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/snapshot.json" \
  --localized-index "$TMP_ROOT/localized-index.toml" \
  --archives-dir "$TMP_ROOT/archives" \
  --output-dir "$TMP_ROOT/bundle" >/dev/null

jq -nS --arg a "$hex_a" --arg manifest "$root_manifest_sha" '{
  schema:2,
  identity_algorithm:"kandelo-program-packages-v2-manifest-closure-v1",
  root_set:"browser-inputs",
  roots:["rootfs"],
  arch:"wasm32",
  closure:[{
    package:"rootfs",arch:"wasm32",
    kind:"program",disposition:"program-archive",
    manifest_sha256:$manifest,cache_key_sha:$a
  }]
}' >"$TMP_ROOT/browser-projection.json"
python3 "$TOOL" prepare \
  --repository Automattic/kandelo \
  --package-source-sha "$source_sha" \
  --authority-sha "$source_sha" \
  --source-tag binaries-abi-v42 \
  --source-evidence "$TMP_ROOT/main-source-evidence.json" \
  --source-index "$TMP_ROOT/source-index.toml" \
  --projection "$TMP_ROOT/browser-projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/snapshot.json" \
  --localized-index "$TMP_ROOT/localized-index.toml" \
  --archives-dir "$TMP_ROOT/archives" \
  --output-dir "$TMP_ROOT/browser-bundle" >/dev/null

jq -S \
  --arg a "$hex_a" \
  --arg manifest "$root_manifest_sha" '
    .roots = ["additional-browser-input", "rootfs"] |
    .closure = [
      {
        package:"additional-browser-input",arch:"wasm32",
        kind:"program",disposition:"program-archive",
        manifest_sha256:$manifest,cache_key_sha:$a
      },
      .closure[0]
    ]
  ' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/expanded-browser-projection.json"
jq -S --arg a "$hex_a" '
  .entries = [
    {
      package:"additional-browser-input",kind:"program",arch:"wasm32",
      version:"1",revision:1,cache_key_sha:$a,git_inputs:[]
    },
    .entries[0]
  ]
' "$TMP_ROOT/expected.json" >"$TMP_ROOT/expanded-browser-expected.json"

cat >"$TMP_ROOT/bin/authority-xtask" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for name in \
  GH_TOKEN GITHUB_TOKEN \
  HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN \
  HOMEBREW_DOCKER_REGISTRY_TOKEN \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL \
  ACTIONS_RUNTIME_TOKEN WASM_POSIX_DEPS_REGISTRY; do
  [ -z "${!name:-}" ] || {
    echo "authority xtask inherited $name" >&2
    exit 97
  }
done
action="$1 $2"
shift 2
projection_output=""
expected_output=""
bundle=""
package_source_sha=""
source_repository=""
root_set=""
roots_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-ledger) expected="$2"; shift 2 ;;
    --snapshot) snapshot="$2"; shift 2 ;;
    --bundle-dir) bundle="$2"; shift 2 ;;
    --archives-dir) bundle="$2"; shift 2 ;;
    --package-source-sha) package_source_sha="$2"; shift 2 ;;
    --expected-source-commit) package_source_sha="$2"; shift 2 ;;
    --expected-source-repository) source_repository="$2"; shift 2 ;;
    --projection-output) projection_output="$2"; shift 2 ;;
    --expected-output) expected_output="$2"; shift 2 ;;
    --root-set) root_set="$2"; shift 2 ;;
    --root-package) shift 2 ;;
    --roots-file) roots_file="$2"; shift 2 ;;
    --source-root|--expected-abi|--arch|--index|--assets|--release-tag|--release-base-url|--scope)
      shift 2
      ;;
    *) echo "unexpected authority xtask flag: $1" >&2; exit 2 ;;
  esac
done
case "$action" in
  "staging-reuse validate-generation")
    [ "$(jq -r .abi_version "$expected")" = 42 ]
    [ "$(jq -r .complete_current "$snapshot")" = true ]
    [ "$package_source_sha" = "${TEST_SOURCE_SHA:?}" ]
    [ -f "$bundle/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" ]
    ;;
  "staging-reuse validate-archives")
    [ "$(jq -r .abi_version "$expected")" = 42 ]
    [ "$(jq -r .complete_current "$snapshot")" = true ]
    [ "$package_source_sha" = "${TEST_SOURCE_SHA:?}" ]
    [ "$source_repository" = "https://github.com/Automattic/kandelo" ]
    [ -f "$bundle/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" ]
    ;;
  "staging-reuse scan-source")
    if [ "$root_set" = browser-inputs ]; then
      [ "$(cat "$roots_file")" = "${TEST_BROWSER_ROOTS:-rootfs}" ] || {
        echo "source root list is not canonical and unique" >&2
        exit 1
      }
      cp "${TEST_REDERIVED_BROWSER_PROJECTION:-${TEST_BROWSER_PROJECTION:?}}" \
        "$projection_output"
    else
      cp "${TEST_PROJECTION:?}" "$projection_output"
    fi
    cp "${TEST_REDERIVED_EXPECTED:-${TEST_EXPECTED:?}}" "$expected_output"
    ;;
  *)
    echo "unexpected authority xtask action: $action" >&2
    exit 2
    ;;
esac
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
source_root="${GH_SOURCE_ROOT:-}"
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
source_release_json() {
  jq -n \
    --arg target "${TEST_SOURCE_SHA:?}" '{
      id:19,tag_name:"binaries-abi-v42",target_commitish:$target,
      draft:false,prerelease:false
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
source_assets_json() {
  i=0
  for path in "$root"/source-assets/*; do
    [ -f "$path" ] || continue
    i=$((i + 1))
    jq -cn \
      --arg name "${path##*/}" \
      --arg digest "sha256:$(sha_file "$path")" \
      --argjson size "$(wc -c <"$path" | tr -d '[:space:]')" \
      --argjson id "$((2000 + i))" \
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

if [ "$1 $2" = "run download" ]; then
  run_id="$3"
  shift 3
  artifact=""
  destination=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --name) artifact="$2"; shift 2 ;;
      --dir) destination="$2"; shift 2 ;;
      --repo) shift 2 ;;
      *) shift ;;
    esac
  done
  [ "$run_id" = 903 ]
  [ -n "$artifact" ] && [ -d "$destination" ]
  cp "$source_root/run-archives/$artifact/"* "$destination/"
  printf 'verify-source\n' >>"${WRITE_LOG:?}"
  exit 0
fi
if [ "$1 $2" = "release upload" ]; then
  mkdir -p "$root/assets"
  file="${!#}"
  cp "$file" "$root/assets/${file##*/}"
  printf 'upload %s\n' "${file##*/}" >>"${WRITE_LOG:?}"
  if [ "${file##*/}" = generation.json ]; then
    case "${MUTATE_SOURCE_AFTER_SEAL:-}" in
      fallback)
        printf '%s\n' \
          '::warning::dependency artifact dep-wasm32 is absent; continuing without overlay' \
          >>"$source_root/rootfs-job.log"
        ;;
    esac
    if [ "${DIRTY_AUTHORITY_AFTER_SEAL:-false}" = true ]; then
      printf 'dirty\n' >"${AUTHORITY_REPO:?}/dirty-after-seal"
    fi
  fi
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

if [ "$method" = GET ] &&
   [ "$endpoint" = "/repos/Automattic/kandelo/releases/tags/pr-1079-staging" ]; then
  emit_get "$(cat "$source_root/release.json")"
  exit 0
fi
if [ "$method" = GET ] &&
   [ "$endpoint" = "/repos/Automattic/kandelo/git/ref/tags/pr-1079-staging" ]; then
  emit_get "$(cat "$source_root/tag.json")"
  exit 0
fi
if [ "$method" = GET ] &&
   [ "$endpoint" = "/repos/Automattic/kandelo/releases/901/assets?per_page=100" ]; then
  body="$(cat "$source_root/release-assets.json")"
  if [ "$paginate" = true ] && [ "$slurp" = true ]; then
    printf '[%s]\n' "$body"
  else
    emit_get "$body"
  fi
  exit 0
fi
if [ "$method" = GET ] &&
   [ "$endpoint" = "/repos/Automattic/kandelo/actions/runs/903" ]; then
  emit_get "$(cat "$source_root/run.json")"
  exit 0
fi
if [ "$method" = GET ] &&
   [ "$endpoint" = "/repos/Automattic/kandelo/actions/runs/903/jobs?per_page=100" ]; then
  body="$(jq -c '{jobs:.}' "$source_root/jobs.json")"
  if [ "$paginate" = true ] && [ "$slurp" = true ]; then
    printf '[%s]\n' "$body"
  else
    emit_get "$body"
  fi
  exit 0
fi
if [ "$method" = GET ] &&
   [ "$endpoint" = "/repos/Automattic/kandelo/actions/runs/903/artifacts?per_page=100" ]; then
  body="$(jq -c '{artifacts:.}' "$source_root/artifacts.json")"
  if [ "$paginate" = true ] && [ "$slurp" = true ]; then
    printf '[%s]\n' "$body"
  else
    emit_get "$body"
  fi
  exit 0
fi
if [ "$method" = GET ] &&
   [ "$endpoint" = "/repos/Automattic/kandelo/actions/jobs/904/logs" ]; then
  cat "$source_root/rootfs-job.log"
  exit 0
fi
if [ "$method" = GET ] &&
   [ "$endpoint" = "/repos/Automattic/kandelo/releases/assets/902" ]; then
  cat "$source_root/release-archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
  exit 0
fi

if [ "$method" = POST ] && [[ "$endpoint" == */git/refs ]]; then
  for field in "${fields[@]}"; do
    case "$field" in
      ref=*) printf '%s' "${field#ref=refs/tags/}" >"$root/ref-tag" ;;
      sha=*) printf '%s' "${field#sha=}" >"$root/ref-sha" ;;
    esac
  done
  if [ "${STALE_TAG_READS_AFTER_CREATE:-0}" -gt 0 ]; then
    printf '%s\n' "$STALE_TAG_READS_AFTER_CREATE" >"$root/stale-tag-reads"
  fi
  printf 'post-tag\n' >>"${WRITE_LOG:?}"
  jq -n \
    --arg tag "$(cat "$root/ref-tag")" \
    --arg sha "$(cat "$root/ref-sha")" '{
      ref:("refs/tags/"+$tag),object:{type:"commit",sha:$sha}
    }'
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
if [[ "$endpoint" == */git/ref/tags/binaries-abi-v42 ]]; then
  emit_get "$(jq -n --arg sha "${TEST_SOURCE_SHA:?}" '{
    ref:"refs/tags/binaries-abi-v42",object:{type:"commit",sha:$sha}
  }')"
  exit 0
fi
if [[ "$endpoint" == */git/ref/heads/main ]]; then
  emit_get "$(jq -n --arg sha "${TEST_SOURCE_SHA:?}" '{
    ref:"refs/heads/main",object:{type:"commit",sha:$sha}
  }')"
  exit 0
fi
if [[ "$endpoint" == */git/commits/"${TEST_SOURCE_SHA:?}" ]]; then
  emit_get "$(jq -n \
    --arg sha "$TEST_SOURCE_SHA" \
    --arg tree "${TEST_TREE_SHA:?}" '{
      sha:$sha,tree:{sha:$tree},parents:[]
    }')"
  exit 0
fi
if [[ "$endpoint" == */git/ref/tags/* ]]; then
  [ -f "$root/ref-tag" ] || emit_404
  if [ -f "$root/stale-tag-reads" ]; then
    stale_reads="$(cat "$root/stale-tag-reads")"
    if [ "$stale_reads" -gt 0 ]; then
      printf '%s\n' "$((stale_reads - 1))" >"$root/stale-tag-reads"
      emit_404
    fi
  fi
  emit_get "$(jq -n \
    --arg tag "$(cat "$root/ref-tag")" \
    --arg sha "$(cat "$root/ref-sha")" '{
      ref:("refs/tags/"+$tag),object:{type:"commit",sha:$sha}
    }')"
  exit 0
fi
if [[ "$endpoint" == */releases/tags/binaries-abi-v42 ]]; then
  emit_get "$(source_release_json)"
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
if [[ "$endpoint" == */releases/19/assets* ]]; then
  body="$(source_assets_json)"
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
  local bundle="${3:-$TMP_ROOT/bundle}"
  local expected_authority="${4:-$authority_sha}"
  local publisher_authority_root="${PUBLISHER_AUTHORITY_ROOT:-$AUTHORITY_ROOT}"
  local publisher_script
  local format bundle_source_sha
  local -a authority_args
  publisher_script="$publisher_authority_root/.github/scripts/publish-durable-package-generation.sh"
  format="$(jq -er .format "$bundle/generation.json")"
  # WHY: admitted and preserved bundles intentionally name different source
  # authorities, so every stubbed source check must follow the bundle under test.
  bundle_source_sha="$(jq -er .identity.package_source_sha "$bundle/generation.json")"
  if [ "$format" = kandelo-preserved-pr-package-generation-v1 ]; then
    authority_args=(--expected-authority-sha "$expected_authority")
  else
    authority_args=(
      --source-tag binaries-abi-v42
      --package-source-sha "$bundle_source_sha"
      --expected-abi 42
      --selection-kind "$(if [ "$(jq -r .identity.projection.schema "$bundle/generation.json")" = 2 ]; then printf browser-inputs; else printf root-package; fi)"
      --root-package rootfs
      --arch wasm32
      --authority-sha "$bundle_source_sha"
      --default-ref main
    )
  fi
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
    WASM_POSIX_DEPS_REGISTRY=/tmp/untrusted-registry \
    GITHUB_REPOSITORY=Automattic/kandelo \
    GITHUB_RUN_ID=123 \
    GITHUB_RUN_ATTEMPT=1 \
    GITHUB_JOB=publish \
    GITHUB_WORKFLOW=test \
    GH_STUB_ROOT="$remote" \
    GH_SOURCE_ROOT="$TMP_ROOT/preserved-source" \
    AUTHORITY_REPO="$publisher_authority_root" \
    MUTATE_SOURCE_AFTER_SEAL="${MUTATE_SOURCE_AFTER_SEAL:-}" \
    DIRTY_AUTHORITY_AFTER_SEAL="${DIRTY_AUTHORITY_AFTER_SEAL:-false}" \
    TEST_SOURCE_SHA="$bundle_source_sha" \
    TEST_TREE_SHA="$tree_sha" \
    TEST_PROJECTION="$TMP_ROOT/projection.json" \
    TEST_BROWSER_PROJECTION="$TMP_ROOT/browser-projection.json" \
    TEST_EXPECTED="$TMP_ROOT/expected.json" \
    NODE_EXPECTED_SCRIPT="$publisher_authority_root/scripts/browser-binary-package-roots.mjs" \
    NODE_EXPECTED_ROOT="$publisher_authority_root" \
    BROWSER_INPUT_ROOTS="${TEST_RUN_BROWSER_INPUT_ROOTS:-rootfs}" \
    STALE_TAG_READS_AFTER_CREATE="${STALE_TAG_READS_AFTER_CREATE:-0}" \
    WRITE_LOG="$TMP_ROOT/writes.log" \
    LOCK_LOG="$TMP_ROOT/locks.log" \
    STATE_LOCK_SCRIPT="$TMP_ROOT/bin/state-lock" \
    PACKAGE_GENERATION_RETRY_DELAY_SECONDS=0 \
    bash "$publisher_script" \
      --bundle "$bundle" \
      --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
      "${authority_args[@]}" \
      --lock-root "$TMP_ROOT/lock" \
      --receipt "$receipt"
}

mkdir -p "$TMP_ROOT/remote/source-assets"
cp "$TMP_ROOT/source-index.toml" "$TMP_ROOT/remote/source-assets/index.toml"
cp "$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" \
  "$TMP_ROOT/remote/source-assets/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
: >"$TMP_ROOT/writes.log"
: >"$TMP_ROOT/locks.log"
# Reproduce GitHub serving its cached pre-write 404 after accepting tag
# creation. Publication must reconcile the completed write without issuing a
# second POST or requiring a whole workflow retry.
STALE_TAG_READS_AFTER_CREATE=2 run_publisher
[ "$(jq -r .application_sealed "$TMP_ROOT/receipt.json")" = true ]
[ "$(cat "$TMP_ROOT/remote/draft")" = false ]
[ "$(find "$TMP_ROOT/remote/assets" -type f | wc -l | tr -d '[:space:]')" = 3 ]
[ "$(tail -n 2 "$TMP_ROOT/writes.log" | head -n 1)" = "upload generation.json" ]
[ "$(tail -n 1 "$TMP_ROOT/writes.log")" = "patch-release" ]
[ "$(grep -Fxc post-tag "$TMP_ROOT/writes.log")" = 1 ]
sed 's/ .*//' "$TMP_ROOT/locks.log" | grep -Fxq acquire
grep -Fxq release "$TMP_ROOT/locks.log"

# The common writer also publishes evidence-only preserved closures, including
# their supporting log before the manifest seal.
jq -S '.release_tag = "pr-1079-staging"' "$TMP_ROOT/snapshot.json" \
  >"$TMP_ROOT/preserved-snapshot.json"
mkdir "$TMP_ROOT/preserved-supporting"
printf 'selected program dependency artifacts:\n' \
  >"$TMP_ROOT/preserved-supporting/rootfs-job.log"
if command -v sha256sum >/dev/null 2>&1; then
  root_log_sha="$(sha256sum "$TMP_ROOT/preserved-supporting/rootfs-job.log" | awk '{print $1}')"
else
  root_log_sha="$(shasum -a 256 "$TMP_ROOT/preserved-supporting/rootfs-job.log" | awk '{print $1}')"
fi
root_log_size="$(wc -c <"$TMP_ROOT/preserved-supporting/rootfs-job.log" | tr -d '[:space:]')"
jq -nS \
  --arg source_sha "$preserved_source_sha" \
  --arg archive_sha "$archive_sha" \
  --arg log_sha "$root_log_sha" \
  --argjson archive_size "$archive_size" \
  --argjson log_size "$root_log_size" '{
    format:"kandelo-preserved-pr-source-capture-v1",
    repository:"Automattic/kandelo",
    package_source_sha:$source_sha,
    source_staging:{
      tag:"pr-1079-staging",release_id:901,
      observed_target_commitish:"old-anchor",
      observed_tag_object_sha:"2222222222222222222222222222222222222222",
      selected_assets:[{
        id:902,name:"rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst",
        bytes:$archive_size,sha256:$archive_sha
      }]
    },
    source_run:{
      id:903,attempt:1,event:"pull_request",
      workflow_path:".github/workflows/staging-build.yml",
      head_sha:$source_sha,
      root_job:{
        id:904,name:"matrix-build (wasm32, rootfs, test)",
        log_sha256:$log_sha,log_bytes:$log_size
      },
      selected_artifacts:[{
        id:905,name:"rootfs-wasm32",bytes:$archive_size,
        archive_name:"rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst",
        archive_bytes:$archive_size,archive_sha256:$archive_sha
      }]
    }
  }' >"$TMP_ROOT/preserved-capture.json"

mkdir -p \
  "$TMP_ROOT/preserved-source/release-archives" \
  "$TMP_ROOT/preserved-source/run-archives/rootfs-wasm32"
cp "$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" \
  "$TMP_ROOT/preserved-source/release-archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
cp "$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" \
  "$TMP_ROOT/preserved-source/run-archives/rootfs-wasm32/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
cp "$TMP_ROOT/preserved-supporting/rootfs-job.log" \
  "$TMP_ROOT/preserved-source/rootfs-job.log"
jq -nS '{
  id:901,tag_name:"pr-1079-staging",target_commitish:"old-anchor",
  draft:false,prerelease:true
}' >"$TMP_ROOT/preserved-source/release.json"
jq -nS '{
  ref:"refs/tags/pr-1079-staging",
  object:{type:"commit",sha:"2222222222222222222222222222222222222222"}
}' >"$TMP_ROOT/preserved-source/tag.json"
jq -nS \
  --arg archive_sha "$archive_sha" \
  --argjson archive_size "$archive_size" '[{
    id:902,name:"rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst",state:"uploaded",
    size:$archive_size,digest:("sha256:" + $archive_sha)
  }]' >"$TMP_ROOT/preserved-source/release-assets.json"
jq -nS --arg source_sha "$preserved_source_sha" '{
  id:903,run_attempt:1,event:"pull_request",
  path:".github/workflows/staging-build.yml",head_sha:$source_sha,
  status:"completed",conclusion:"cancelled"
}' >"$TMP_ROOT/preserved-source/run.json"
jq -nS '[{
  id:904,name:"matrix-build (wasm32, rootfs, test)",
  status:"completed",conclusion:"success"
}]' >"$TMP_ROOT/preserved-source/jobs.json"
jq -nS --argjson archive_size "$archive_size" '[{
  id:905,name:"rootfs-wasm32",expired:false,
  size_in_bytes:$archive_size,workflow_run:{id:903}
}]' >"$TMP_ROOT/preserved-source/artifacts.json"

python3 "$TOOL" prepare-preserved \
  --repository Automattic/kandelo \
  --package-source-sha "$preserved_source_sha" \
  --authority-sha "$authority_sha" \
  --source-capture "$TMP_ROOT/preserved-capture.json" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/preserved-snapshot.json" \
  --localized-index "$TMP_ROOT/localized-index.toml" \
  --archives-dir "$TMP_ROOT/archives" \
  --supporting-assets-dir "$TMP_ROOT/preserved-supporting" \
  --output-dir "$TMP_ROOT/preserved-bundle" >/dev/null

wrong_authority_sha="$(printf '4%.0s' {1..40})"
mkdir "$TMP_ROOT/wrong-authority-remote"
: >"$TMP_ROOT/writes.log"
if run_publisher \
    "$TMP_ROOT/wrong-authority-remote" \
    "$TMP_ROOT/wrong-authority-receipt.json" \
    "$TMP_ROOT/preserved-bundle" \
    "$wrong_authority_sha"; then
  echo "preserved writer accepted the wrong expected authority" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]

python3 "$TOOL" prepare-preserved \
  --repository Automattic/kandelo \
  --package-source-sha "$preserved_source_sha" \
  --authority-sha "$wrong_authority_sha" \
  --source-capture "$TMP_ROOT/preserved-capture.json" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/preserved-snapshot.json" \
  --localized-index "$TMP_ROOT/localized-index.toml" \
  --archives-dir "$TMP_ROOT/archives" \
  --supporting-assets-dir "$TMP_ROOT/preserved-supporting" \
  --output-dir "$TMP_ROOT/preserved-wrong-manifest-authority" >/dev/null
mkdir "$TMP_ROOT/wrong-manifest-authority-remote"
: >"$TMP_ROOT/writes.log"
if run_publisher \
    "$TMP_ROOT/wrong-manifest-authority-remote" \
    "$TMP_ROOT/wrong-manifest-authority-receipt.json" \
    "$TMP_ROOT/preserved-wrong-manifest-authority"; then
  echo "preserved writer accepted a mismatched manifest authority" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]

# A clean checkout is still the wrong authority when its HEAD differs from the
# reviewed commit sealed into the preserved manifest.
git clone -q "$AUTHORITY_ROOT" "$TMP_ROOT/different-clean-authority"
git -C "$TMP_ROOT/different-clean-authority" config user.name "Kandelo test"
git -C "$TMP_ROOT/different-clean-authority" config user.email test@example.invalid
printf 'different clean authority\n' \
  >"$TMP_ROOT/different-clean-authority/authority-change"
git -C "$TMP_ROOT/different-clean-authority" add authority-change
git -C "$TMP_ROOT/different-clean-authority" \
  commit -qm "test different clean authority"
mkdir "$TMP_ROOT/different-clean-authority-remote"
: >"$TMP_ROOT/writes.log"
if PUBLISHER_AUTHORITY_ROOT="$TMP_ROOT/different-clean-authority" \
   run_publisher \
     "$TMP_ROOT/different-clean-authority-remote" \
     "$TMP_ROOT/different-clean-authority-receipt.json" \
     "$TMP_ROOT/preserved-bundle"; then
  echo "preserved writer accepted a different clean authority HEAD" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]

printf 'dirty\n' >"$TMP_ROOT/authority/untracked-dirty"
mkdir "$TMP_ROOT/dirty-authority-remote"
: >"$TMP_ROOT/writes.log"
if run_publisher \
    "$TMP_ROOT/dirty-authority-remote" \
    "$TMP_ROOT/dirty-authority-receipt.json" \
    "$TMP_ROOT/preserved-bundle"; then
  echo "preserved writer accepted a dirty authority checkout" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]
rm "$TMP_ROOT/authority/untracked-dirty"

mkdir "$TMP_ROOT/preserved-remote"
: >"$TMP_ROOT/writes.log"
run_publisher \
  "$TMP_ROOT/preserved-remote" \
  "$TMP_ROOT/preserved-receipt.json" \
  "$TMP_ROOT/preserved-bundle"
[ "$(find "$TMP_ROOT/preserved-remote/assets" -type f | wc -l | tr -d '[:space:]')" = 4 ]
grep -Fxq "upload rootfs-job.log" "$TMP_ROOT/writes.log"
[ "$(jq -r .application_sealed "$TMP_ROOT/preserved-receipt.json")" = true ]
seal_line="$(grep -nFx "upload generation.json" "$TMP_ROOT/writes.log" | cut -d: -f1)"
patch_line="$(grep -nFx "patch-release" "$TMP_ROOT/writes.log" | cut -d: -f1)"
source_verify_count="$(grep -cFx "verify-source" "$TMP_ROOT/writes.log")"
first_source_verify="$(
  grep -nFx "verify-source" "$TMP_ROOT/writes.log" | cut -d: -f1 | sed -n 1p
)"
second_source_verify="$(
  grep -nFx "verify-source" "$TMP_ROOT/writes.log" | cut -d: -f1 | sed -n 2p
)"
[ "$source_verify_count" = 2 ]
[ "$first_source_verify" -lt "$seal_line" ]
[ "$seal_line" -lt "$second_source_verify" ]
[ "$second_source_verify" -lt "$patch_line" ]

# Once public, an exact verification-only retry performs no write boundary and
# therefore must not depend on temporary PR staging evidence that may be gone.
mv "$TMP_ROOT/preserved-source" "$TMP_ROOT/preserved-source-after-public"
: >"$TMP_ROOT/writes.log"
run_publisher \
  "$TMP_ROOT/preserved-remote" \
  "$TMP_ROOT/preserved-public-retry-receipt.json" \
  "$TMP_ROOT/preserved-bundle"
[ ! -s "$TMP_ROOT/writes.log" ]
mv "$TMP_ROOT/preserved-source-after-public" "$TMP_ROOT/preserved-source"

assert_source_json_rejected() {
  local label="$1" relative="$2" filter="$3"
  local source_file="$TMP_ROOT/preserved-source/$relative"
  local backup="$TMP_ROOT/preserved-source/$relative.$label.backup"
  local remote="$TMP_ROOT/source-reject-$label"
  cp "$source_file" "$backup"
  jq "$filter" "$backup" >"$source_file"
  mkdir "$remote"
  : >"$TMP_ROOT/writes.log"
  if run_publisher \
      "$remote" \
      "$TMP_ROOT/source-reject-$label-receipt.json" \
      "$TMP_ROOT/preserved-bundle"; then
    echo "preserved writer accepted changed source evidence: $label" >&2
    exit 1
  fi
  if grep -Fxq "upload generation.json" "$TMP_ROOT/writes.log" ||
     grep -Fxq "patch-release" "$TMP_ROOT/writes.log"; then
    echo "preserved writer crossed a publication boundary after $label" >&2
    exit 1
  fi
  mv "$backup" "$source_file"
}

assert_source_json_rejected \
  release release.json '.target_commitish = "moved-release-target"'
assert_source_json_rejected \
  tag tag.json '.object.sha = "3333333333333333333333333333333333333333"'
assert_source_json_rejected \
  run run.json '.head_sha = "3333333333333333333333333333333333333333"'
assert_source_json_rejected \
  path run.json '.path = ".github/workflows/other.yml"'
assert_source_json_rejected attempt run.json '.run_attempt = 2'
assert_source_json_rejected job jobs.json '.[0].conclusion = "failure"'
assert_source_json_rejected artifact artifacts.json '.[0].id = 999'
assert_source_json_rejected missing artifacts.json '. = []'
assert_source_json_rejected \
  duplicate artifacts.json '. + [(.[0] | .id = 906)]'
assert_source_json_rejected \
  moved release-assets.json '.[0].id = 999'

cp \
  "$TMP_ROOT/preserved-source/release-archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" \
  "$TMP_ROOT/preserved-source/release-archive.backup"
printf 'mutated release archive\n' \
  >"$TMP_ROOT/preserved-source/release-archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
mkdir "$TMP_ROOT/source-reject-release-bytes"
: >"$TMP_ROOT/writes.log"
if run_publisher \
    "$TMP_ROOT/source-reject-release-bytes" \
    "$TMP_ROOT/source-reject-release-bytes-receipt.json" \
    "$TMP_ROOT/preserved-bundle"; then
  echo "preserved writer accepted mutated selected release bytes" >&2
  exit 1
fi
if grep -Fxq "upload generation.json" "$TMP_ROOT/writes.log" ||
   grep -Fxq "patch-release" "$TMP_ROOT/writes.log"; then
  echo "preserved writer published after selected release-byte mutation" >&2
  exit 1
fi
mv \
  "$TMP_ROOT/preserved-source/release-archive.backup" \
  "$TMP_ROOT/preserved-source/release-archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"

cp \
  "$TMP_ROOT/preserved-source/run-archives/rootfs-wasm32/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" \
  "$TMP_ROOT/preserved-source/run-archive.backup"
printf 'mutated run archive\n' \
  >"$TMP_ROOT/preserved-source/run-archives/rootfs-wasm32/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
mkdir "$TMP_ROOT/source-reject-run-bytes"
: >"$TMP_ROOT/writes.log"
if run_publisher \
    "$TMP_ROOT/source-reject-run-bytes" \
    "$TMP_ROOT/source-reject-run-bytes-receipt.json" \
    "$TMP_ROOT/preserved-bundle"; then
  echo "preserved writer accepted mutated same-run artifact bytes" >&2
  exit 1
fi
if grep -Fxq "upload generation.json" "$TMP_ROOT/writes.log" ||
   grep -Fxq "patch-release" "$TMP_ROOT/writes.log"; then
  echo "preserved writer published after same-run byte mutation" >&2
  exit 1
fi
mv \
  "$TMP_ROOT/preserved-source/run-archive.backup" \
  "$TMP_ROOT/preserved-source/run-archives/rootfs-wasm32/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"

# A fresh second read occurs after the seal upload and immediately before the
# draft can become public. Moving selected log evidence in that interval must
# leave an application-sealed draft and never patch it public.
cp "$TMP_ROOT/preserved-source/rootfs-job.log" \
  "$TMP_ROOT/preserved-source/rootfs-job.before-public.backup"
mkdir "$TMP_ROOT/source-moves-before-public"
: >"$TMP_ROOT/writes.log"
if MUTATE_SOURCE_AFTER_SEAL=fallback run_publisher \
    "$TMP_ROOT/source-moves-before-public" \
    "$TMP_ROOT/source-moves-before-public-receipt.json" \
    "$TMP_ROOT/preserved-bundle"; then
  echo "preserved writer published after source moved post-seal" >&2
  exit 1
fi
[ -f "$TMP_ROOT/source-moves-before-public/assets/generation.json" ]
[ "$(cat "$TMP_ROOT/source-moves-before-public/draft")" = true ]
if grep -Fxq "patch-release" "$TMP_ROOT/writes.log"; then
  echo "preserved writer patched public after post-seal source mutation" >&2
  exit 1
fi
mv \
  "$TMP_ROOT/preserved-source/rootfs-job.before-public.backup" \
  "$TMP_ROOT/preserved-source/rootfs-job.log"

# The authority tree is checked again after the second source read, not just at
# process startup.
mkdir "$TMP_ROOT/authority-dirties-before-public"
: >"$TMP_ROOT/writes.log"
if DIRTY_AUTHORITY_AFTER_SEAL=true run_publisher \
    "$TMP_ROOT/authority-dirties-before-public" \
    "$TMP_ROOT/authority-dirties-before-public-receipt.json" \
    "$TMP_ROOT/preserved-bundle"; then
  echo "preserved writer published after authority changed post-seal" >&2
  exit 1
fi
[ -f "$TMP_ROOT/authority-dirties-before-public/assets/generation.json" ]
[ "$(cat "$TMP_ROOT/authority-dirties-before-public/draft")" = true ]
if grep -Fxq "patch-release" "$TMP_ROOT/writes.log"; then
  echo "preserved writer patched public with a dirty authority tree" >&2
  exit 1
fi
rm "$TMP_ROOT/authority/dirty-after-seal"

# A compatible exact consumer can materialize the anonymous release only after
# current authority revalidates archive manifests.
mkdir -p \
  "$TMP_ROOT/consumer/packages/registry" \
  "$TMP_ROOT/consumer/crates/shared/src" \
  "$TMP_ROOT/consumer/scripts"
jq -nS --arg a "$hex_a" --arg manifest "$root_manifest_sha" '{
  format:"kandelo-program-packages-v2",
  identities:{
    rootfs:{manifestSha256:$manifest,cacheKeys:{wasm32:$a}}
  },
  packages:{
    rootfs:{
      manifestSha256:$manifest,
      arches:["wasm32"],
      cacheKeys:{wasm32:$a},
      dependencyClosures:{wasm32:[]}
    }
  }
}' >"$TMP_ROOT/consumer/packages/registry/program-packages.json"
mkdir "$TMP_ROOT/consumer/packages/registry/rootfs"
cp "$TMP_ROOT/rootfs-package.toml" \
  "$TMP_ROOT/consumer/packages/registry/rootfs/package.toml"
cp "$TMP_ROOT/expected.json" \
  "$TMP_ROOT/consumer/packages/registry/.test-expected.json"
printf 'pub const ABI_VERSION: u32 = 42;\n' \
  >"$TMP_ROOT/consumer/crates/shared/src/lib.rs"
printf '// exact consumer browser-root authority fixture\n' \
  >"$TMP_ROOT/consumer/scripts/browser-binary-package-roots.mjs"
git -C "$TMP_ROOT/consumer" init -q
git -C "$TMP_ROOT/consumer" config user.name "Kandelo test"
git -C "$TMP_ROOT/consumer" config user.email test@example.invalid
git -C "$TMP_ROOT/consumer" add .
git -C "$TMP_ROOT/consumer" commit -qm "test consumer"
consumer_sha="$(git -C "$TMP_ROOT/consumer" rev-parse HEAD)"

cat >"$TMP_ROOT/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for name in \
  GH_TOKEN GITHUB_TOKEN \
  HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN \
  HOMEBREW_DOCKER_REGISTRY_TOKEN \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL \
  ACTIONS_RUNTIME_TOKEN WASM_POSIX_DEPS_REGISTRY; do
  [ -z "${!name:-}" ] || {
    echo "browser root authority inherited $name" >&2
    exit 97
  }
done
[ "$#" -eq 9 ]
[ "$1" = "${NODE_EXPECTED_SCRIPT:?}" ]
[ "$2 $4 $6 $8" = "--source-root --arch --exclude-package --include-package" ]
[ "$3" = "${NODE_EXPECTED_ROOT:?}" ]
[ "$5" = wasm32 ]
[ "$7" = shell ]
[ "$9" = rootfs ]
printf '%s\n' "${BROWSER_INPUT_ROOTS:-rootfs}"
EOF
chmod +x "$TMP_ROOT/bin/node"

# Preserved releases retain evidence only. The ordinary consumer path must
# reject their distinct tag before attempting to download or activate bytes.
preserved_tag="$(jq -er .tag "$TMP_ROOT/preserved-bundle/generation.json")"
if bash "$MATERIALIZE" \
    --tag "$preserved_tag" \
    --consumer-root "$TMP_ROOT/consumer" \
    --consumer-sha "$consumer_sha" \
    --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
    --repository Automattic/kandelo \
    --output-dir "$TMP_ROOT/preserved-materialized"; then
  echo "ordinary materializer accepted a preserved evidence tag" >&2
  exit 1
fi
[ ! -e "$TMP_ROOT/preserved-materialized" ]

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
  WASM_POSIX_DEPS_REGISTRY=/tmp/untrusted-registry \
  GH_STUB_ROOT="$TMP_ROOT/remote" \
  TEST_SOURCE_SHA="$source_sha" \
  TEST_TREE_SHA="$tree_sha" \
  TEST_PROJECTION="$TMP_ROOT/projection.json" \
  TEST_BROWSER_PROJECTION="$TMP_ROOT/browser-projection.json" \
  TEST_EXPECTED="$TMP_ROOT/expected.json" \
  bash "$MATERIALIZE" \
    --tag "$tag" \
    --consumer-root "$TMP_ROOT/consumer" \
    --consumer-sha "$consumer_sha" \
    --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
    --repository Automattic/kandelo \
    --required-package-source-sha "$source_sha" \
    --output-dir "$TMP_ROOT/materialized"
[ -f "$TMP_ROOT/materialized/release/generation.json" ]
[ -f "$TMP_ROOT/materialized/resolver/index.toml" ]
grep -Fxq "file://$TMP_ROOT/materialized/resolver/index.toml" \
  "$TMP_ROOT/materialized/index-url.txt"

# Matching package recipes are not enough for a canonical producer. Requiring
# the consumer commit here would attempt to treat an equal projection as the
# build authority even though this generation records another exact-main SHA.
if env \
    PATH="$TMP_ROOT/bin:$PATH" \
    GH_TOKEN=test-token \
    GITHUB_TOKEN=test-fallback-token \
    HOMEBREW_GITHUB_API_TOKEN=test-api-token \
    HOMEBREW_GITHUB_PACKAGES_TOKEN=test-packages-token \
    HOMEBREW_DOCKER_REGISTRY_TOKEN=test-registry-token \
    ACTIONS_ID_TOKEN_REQUEST_TOKEN=test-oidc-token \
    ACTIONS_ID_TOKEN_REQUEST_URL=https://example.invalid/oidc \
    ACTIONS_RUNTIME_TOKEN=test-runtime-token \
    WASM_POSIX_DEPS_REGISTRY=/tmp/untrusted-registry \
    GH_STUB_ROOT="$TMP_ROOT/remote" \
    TEST_SOURCE_SHA="$source_sha" \
    TEST_TREE_SHA="$tree_sha" \
    TEST_PROJECTION="$TMP_ROOT/projection.json" \
    TEST_BROWSER_PROJECTION="$TMP_ROOT/browser-projection.json" \
    TEST_EXPECTED="$TMP_ROOT/expected.json" \
    bash "$MATERIALIZE" \
      --tag "$tag" \
      --consumer-root "$TMP_ROOT/consumer" \
      --consumer-sha "$consumer_sha" \
      --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
      --repository Automattic/kandelo \
      --required-package-source-sha "$consumer_sha" \
      --output-dir "$TMP_ROOT/wrong-source-materialized"; then
  echo "materializer accepted a generation from another exact-main source" >&2
  exit 1
fi
[ ! -e "$TMP_ROOT/wrong-source-materialized" ]

# A browser-inputs generation uses the same append-only publisher, but
# materialization independently derives the named roots from the exact clean
# consumer checkout before activating any resolver bytes.
mkdir -p "$TMP_ROOT/browser-remote/source-assets"
cp "$TMP_ROOT/source-index.toml" \
  "$TMP_ROOT/browser-remote/source-assets/index.toml"
cp "$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" \
  "$TMP_ROOT/browser-remote/source-assets/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
: >"$TMP_ROOT/writes.log"
: >"$TMP_ROOT/locks.log"
run_publisher \
  "$TMP_ROOT/browser-remote" \
  "$TMP_ROOT/browser-receipt.json" \
  "$TMP_ROOT/browser-bundle"
[ "$(jq -r .application_sealed "$TMP_ROOT/browser-receipt.json")" = true ]
[ "$(find "$TMP_ROOT/browser-remote/assets" -type f | wc -l | tr -d '[:space:]')" = 3 ]
browser_tag="$(jq -r .tag "$TMP_ROOT/browser-bundle/generation.json")"
[[ "$browser_tag" =~ ^package-generation-browser-inputs-wasm32-abi-v42-sha256-[0-9a-f]{64}$ ]]

# A transferred bundle can be perfectly self-consistent yet omit a package
# that exact main now imports. The writer must independently derive the source
# projection and reject before its first release write.
mkdir -p "$TMP_ROOT/incomplete-remote/source-assets"
cp "$TMP_ROOT/source-index.toml" \
  "$TMP_ROOT/incomplete-remote/source-assets/index.toml"
cp "$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" \
  "$TMP_ROOT/incomplete-remote/source-assets/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
: >"$TMP_ROOT/writes.log"
if TEST_REDERIVED_BROWSER_PROJECTION="$TMP_ROOT/expanded-browser-projection.json" \
   TEST_REDERIVED_EXPECTED="$TMP_ROOT/expanded-browser-expected.json" \
   TEST_BROWSER_ROOTS=$'additional-browser-input\nrootfs' \
   TEST_RUN_BROWSER_INPUT_ROOTS=$'additional-browser-input\nrootfs' \
   run_publisher \
     "$TMP_ROOT/incomplete-remote" \
     "$TMP_ROOT/incomplete-receipt.json" \
     "$TMP_ROOT/browser-bundle"; then
  echo "publisher accepted an internally consistent incomplete browser bundle" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]

if env \
    PATH="$TMP_ROOT/bin:$PATH" \
    GH_TOKEN=test-token \
    GITHUB_TOKEN=test-fallback-token \
    HOMEBREW_GITHUB_API_TOKEN=test-api-token \
    HOMEBREW_GITHUB_PACKAGES_TOKEN=test-packages-token \
    HOMEBREW_DOCKER_REGISTRY_TOKEN=test-registry-token \
    ACTIONS_ID_TOKEN_REQUEST_TOKEN=test-oidc-token \
    ACTIONS_ID_TOKEN_REQUEST_URL=https://example.invalid/oidc \
    ACTIONS_RUNTIME_TOKEN=test-runtime-token \
    WASM_POSIX_DEPS_REGISTRY=/tmp/untrusted-registry \
    GH_STUB_ROOT="$TMP_ROOT/browser-remote" \
    TEST_SOURCE_SHA="$source_sha" \
    TEST_TREE_SHA="$tree_sha" \
    TEST_PROJECTION="$TMP_ROOT/projection.json" \
    TEST_BROWSER_PROJECTION="$TMP_ROOT/browser-projection.json" \
    TEST_EXPECTED="$TMP_ROOT/expected.json" \
    NODE_EXPECTED_SCRIPT="$AUTHORITY_ROOT/scripts/browser-binary-package-roots.mjs" \
    NODE_EXPECTED_ROOT="$TMP_ROOT/consumer" \
    BROWSER_INPUT_ROOTS=$'rootfs\nrootfs' \
    bash "$MATERIALIZE" \
      --tag "$browser_tag" \
      --consumer-root "$TMP_ROOT/consumer" \
      --consumer-sha "$consumer_sha" \
      --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
      --repository Automattic/kandelo \
      --output-dir "$TMP_ROOT/rejected-browser-materialization"; then
  echo "browser materialization accepted duplicate authoritative roots" >&2
  exit 1
fi
[ ! -e "$TMP_ROOT/rejected-browser-materialization" ]

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
  WASM_POSIX_DEPS_REGISTRY=/tmp/untrusted-registry \
  GH_STUB_ROOT="$TMP_ROOT/browser-remote" \
  TEST_SOURCE_SHA="$source_sha" \
  TEST_TREE_SHA="$tree_sha" \
  TEST_PROJECTION="$TMP_ROOT/projection.json" \
  TEST_BROWSER_PROJECTION="$TMP_ROOT/browser-projection.json" \
  TEST_EXPECTED="$TMP_ROOT/expected.json" \
  NODE_EXPECTED_SCRIPT="$AUTHORITY_ROOT/scripts/browser-binary-package-roots.mjs" \
  NODE_EXPECTED_ROOT="$TMP_ROOT/consumer" \
  BROWSER_INPUT_ROOTS=rootfs \
  bash "$MATERIALIZE" \
    --tag "$browser_tag" \
    --consumer-root "$TMP_ROOT/consumer" \
    --consumer-sha "$consumer_sha" \
    --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
    --repository Automattic/kandelo \
    --required-package-source-sha "$source_sha" \
    --output-dir "$TMP_ROOT/browser-materialized"
[ -f "$TMP_ROOT/browser-materialized/release/generation.json" ]
[ -f "$TMP_ROOT/browser-materialized/resolver/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" ]

# A public retry is verification-only. It must not upload, patch, recreate the
# release, or move the direct tag.
: >"$TMP_ROOT/writes.log"
run_publisher
[ ! -s "$TMP_ROOT/writes.log" ]

# An interrupted draft resumes from its exact verified subset. The seal is
# still uploaded last, and the existing asset is never overwritten.
mkdir -p "$TMP_ROOT/partial-remote/assets" "$TMP_ROOT/partial-remote/source-assets"
cp "$TMP_ROOT/source-index.toml" \
  "$TMP_ROOT/partial-remote/source-assets/index.toml"
cp "$TMP_ROOT/archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" \
  "$TMP_ROOT/partial-remote/source-assets/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
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
printf 'mutated public bytes\n' \
  >"$TMP_ROOT/remote/assets/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
: >"$TMP_ROOT/writes.log"
if run_publisher; then
  echo "mutated public generation was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]

echo "test-publish-durable-package-generation: ok"
