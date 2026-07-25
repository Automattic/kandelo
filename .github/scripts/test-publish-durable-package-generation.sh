#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLISH_SOURCE="$SCRIPT_DIR/publish-durable-package-generation.sh"
MATERIALIZE="$SCRIPT_DIR/materialize-durable-package-generation.sh"
TOOL="$SCRIPT_DIR/package-generation.py"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/archives" "$TMP_ROOT/lock"

hex_a="$(printf 'a%.0s' {1..64})"
source_sha="$(printf '1%.0s' {1..40})"
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
      asset:"rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst",
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
    --expected-source-repository) source_repository="$2"; shift 2 ;;
    --expected-source-commit) source_commit="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "$(jq -r .abi_version "$expected")" = 42 ]
[ "$(jq -r .complete_current "$snapshot")" = true ]
[ -f "$archives/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst" ]
[ "$scope" = all ]
[ "$source_repository" = "https://github.com/Automattic/kandelo" ]
[ "$source_commit" = "1111111111111111111111111111111111111111" ]
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

# Execute the writer from a clean, exact temporary authority checkout. This
# lets the test exercise the same HEAD/tree binding as Actions even while a
# developer's source worktree contains the change under test.
mkdir -p "$TMP_ROOT/authority/.github/scripts"
cp \
  "$PUBLISH_SOURCE" \
  "$SCRIPT_DIR/github-api-get.sh" \
  "$SCRIPT_DIR/package-generation.py" \
  "$SCRIPT_DIR/verify-preserved-package-source.sh" \
  "$TMP_ROOT/authority/.github/scripts/"
git -C "$TMP_ROOT/authority" init -q
git -C "$TMP_ROOT/authority" config user.name "Kandelo test"
git -C "$TMP_ROOT/authority" config user.email test@example.invalid
git -C "$TMP_ROOT/authority" add .
git -C "$TMP_ROOT/authority" commit -qm \
  "[Packaging] Test exact publisher authority"
authority_sha="$(git -C "$TMP_ROOT/authority" rev-parse HEAD)"
PUBLISH="$TMP_ROOT/authority/.github/scripts/publish-durable-package-generation.sh"

run_publisher() {
  local remote="${1:-$TMP_ROOT/remote}"
  local receipt="${2:-$TMP_ROOT/receipt.json}"
  local bundle="${3:-$TMP_ROOT/bundle}"
  local expected_authority="${4:-}"
  local authority_args=()
  if [ "$(jq -r .format "$bundle/generation.json")" = \
       "kandelo-preserved-pr-package-generation-v1" ]; then
    expected_authority="${expected_authority:-$authority_sha}"
    authority_args+=(--expected-authority-sha "$expected_authority")
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
    GITHUB_REPOSITORY=Automattic/kandelo \
    GITHUB_RUN_ID=123 \
    GITHUB_RUN_ATTEMPT=1 \
    GITHUB_JOB=publish \
    GITHUB_WORKFLOW=test \
    GH_STUB_ROOT="$remote" \
    GH_SOURCE_ROOT="$TMP_ROOT/preserved-source" \
    AUTHORITY_REPO="$TMP_ROOT/authority" \
    MUTATE_SOURCE_AFTER_SEAL="${MUTATE_SOURCE_AFTER_SEAL:-}" \
    DIRTY_AUTHORITY_AFTER_SEAL="${DIRTY_AUTHORITY_AFTER_SEAL:-false}" \
    STALE_TAG_READS_AFTER_CREATE="${STALE_TAG_READS_AFTER_CREATE:-0}" \
    WRITE_LOG="$TMP_ROOT/writes.log" \
    LOCK_LOG="$TMP_ROOT/locks.log" \
    STATE_LOCK_SCRIPT="$TMP_ROOT/bin/state-lock" \
    PACKAGE_GENERATION_RETRY_DELAY_SECONDS=0 \
    bash "$PUBLISH" \
      --bundle "$bundle" \
      --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
      "${authority_args[@]}" \
      --lock-root "$TMP_ROOT/lock" \
      --receipt "$receipt"
}

mkdir "$TMP_ROOT/remote"
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
  --arg source_sha "$source_sha" \
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
jq -nS --arg source_sha "$source_sha" '{
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
  --package-source-sha "$source_sha" \
  --authority-sha "$authority_sha" \
  --source-capture "$TMP_ROOT/preserved-capture.json" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/snapshot.json" \
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
  --package-source-sha "$source_sha" \
  --authority-sha "$wrong_authority_sha" \
  --source-capture "$TMP_ROOT/preserved-capture.json" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/snapshot.json" \
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

# The shell-level consumer path must reject evidence-only preserved releases;
# the Python contract check alone is not sufficient evidence for this boundary.
preserved_tag="$(jq -r .tag "$TMP_ROOT/preserved-bundle/generation.json")"
if env \
    PATH="$TMP_ROOT/bin:$PATH" \
    GH_TOKEN=test-token \
    GITHUB_TOKEN=test-fallback-token \
    GH_STUB_ROOT="$TMP_ROOT/preserved-remote" \
    bash "$MATERIALIZE" \
      --tag "$preserved_tag" \
      --consumer-root "$TMP_ROOT/consumer" \
      --consumer-sha "$consumer_sha" \
      --consumer-xtask "$TMP_ROOT/bin/consumer-xtask" \
      --authority-xtask "$TMP_ROOT/bin/authority-xtask" \
      --repository Automattic/kandelo \
      --output-dir "$TMP_ROOT/preserved-materialized"; then
  echo "shell materializer admitted preserved PR evidence" >&2
  exit 1
fi

# A clean checkout at a different HEAD is still the wrong authority.
printf 'new head\n' >"$TMP_ROOT/authority/head-marker"
git -C "$TMP_ROOT/authority" add head-marker
git -C "$TMP_ROOT/authority" commit -qm \
  "[Packaging] Test moved publisher HEAD"
mkdir "$TMP_ROOT/moved-authority-head-remote"
: >"$TMP_ROOT/writes.log"
if run_publisher \
    "$TMP_ROOT/moved-authority-head-remote" \
    "$TMP_ROOT/moved-authority-head-receipt.json" \
    "$TMP_ROOT/preserved-bundle"; then
  echo "preserved writer accepted a different clean authority HEAD" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]

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
printf 'mutated public bytes\n' \
  >"$TMP_ROOT/remote/assets/rootfs-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
: >"$TMP_ROOT/writes.log"
if run_publisher; then
  echo "mutated public generation was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/writes.log" ]

echo "test-publish-durable-package-generation: ok"
