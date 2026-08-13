#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
PUBLISHER="$REPO_ROOT/.github/scripts/publish-abi-staging-request.sh"
REQUEST="$REPO_ROOT/tools/xtask/tests/fixtures/abi-staging/request/current-request.json"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-publish-abi-staging-request: $*" >&2
  exit 1
}

[[ -x $PUBLISHER ]] || fail "publisher is absent or not executable"
mkdir -p "$TMP_ROOT/bin"
cp "$REQUEST" "$TMP_ROOT/request.json"

cat >"$TMP_ROOT/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
[[ -z ${GH_TOKEN+x} && -z ${GITHUB_TOKEN+x} ]] || exit 1
output=
while (($#)); do
  case "$1" in
    --output) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n $output ]]
cp "$(dirname "$0")/../request.json" "$output"
: >"$(dirname "$0")/../anonymous-readback"
FAKE_CURL
chmod +x "$TMP_ROOT/bin/curl"

cat >"$TMP_ROOT/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$FAKE_STATE/calls.log"
printf '\n' >>"$FAKE_STATE/calls.log"

release_json() {
  local draft=true immutable=false target=$EXPECT_TARGET prerelease=true
  [[ -f $FAKE_STATE/published || $FAKE_RELEASE_MODE == public-identical ||
     $FAKE_RELEASE_MODE == immutable-empty ]] && draft=false immutable=true
  [[ $FAKE_RELEASE_MODE == wrong-target ]] && target=$(printf '9%.0s' {1..40})
  [[ $FAKE_RELEASE_MODE == wrong-prerelease ]] && prerelease=false
  jq -cn --arg tag "$EXPECT_TAG" --arg target "$target" \
    --arg title "$EXPECT_TITLE" --arg body "$EXPECT_BODY" \
    --argjson prerelease "$prerelease" --argjson draft "$draft" \
    --argjson immutable "$immutable" \
    '{id:71,tag_name:$tag,target_commitish:$target,name:$title,body:$body,prerelease:$prerelease,draft:$draft,immutable:$immutable}'
}

asset_pages() {
  local url=$EXPECT_URL
  if [[ $FAKE_RELEASE_MODE == draft-untagged && ! -f $FAKE_STATE/published ]]; then
    url="https://github.com/Automattic/kandelo/releases/download/untagged-0123456789abcdef0123/${EXPECT_NAME}"
  elif [[ $FAKE_RELEASE_MODE == draft-hostile && ! -f $FAKE_STATE/published ]]; then
    url=$EXPECT_DRAFT_URL
  fi
  if [[ -f $FAKE_STATE/uploaded || $FAKE_RELEASE_MODE == draft-identical ||
        $FAKE_RELEASE_MODE == public-identical || $FAKE_RELEASE_MODE == collision ]]; then
    jq -cn --arg name "$EXPECT_NAME" --arg url "$url" \
      --arg digest "sha256:$EXPECT_DIGEST" --argjson bytes "$EXPECT_BYTES" \
      '[[{id:81,name:$name,browser_download_url:$url,state:"uploaded",size:$bytes,digest:$digest}]]'
  elif [[ $FAKE_RELEASE_MODE == multiple ]]; then
    jq -cn --arg name "$EXPECT_NAME" --arg url "$EXPECT_URL" \
      --arg digest "sha256:$EXPECT_DIGEST" --argjson bytes "$EXPECT_BYTES" \
      '[[{id:81,name:$name,browser_download_url:$url,state:"uploaded",size:$bytes,digest:$digest},{id:82,name:$name,browser_download_url:$url,state:"uploaded",size:$bytes,digest:$digest}]]'
  else
    printf '[[]]\n'
  fi
}

release_exists() {
  [[ -f $FAKE_STATE/created || $FAKE_RELEASE_MODE != absent ]]
}

if [[ ${1:-} == api ]]; then
  shift
  method=GET
  endpoint=
  while (($#)); do
    case "$1" in
      --method) method=$2; shift 2 ;;
      --paginate|--slurp) shift ;;
      -H|-f|-F) shift 2 ;;
      *) endpoint=$1; shift ;;
    esac
  done
  case "$method:$endpoint" in
    GET:*/git/ref/heads/main)
      main_target=$EXPECT_TARGET
      [[ $FAKE_RELEASE_MODE == wrong-main ]] && main_target=$(printf '7%.0s' {1..40})
      jq -cn --arg target "$main_target" \
        '{ref:"refs/heads/main",object:{type:"commit",sha:$target}}'
      ;;
    GET:*/git/ref/tags/*)
      if [[ $FAKE_RELEASE_MODE == absent && ! -f $FAKE_STATE/tag-created ]]; then
        exit 1
      fi
      tag_target=$EXPECT_TARGET
      [[ $FAKE_RELEASE_MODE == wrong-tag-target ]] && tag_target=$(printf '8%.0s' {1..40})
      jq -cn --arg tag "$EXPECT_TAG" --arg target "$tag_target" \
        '{ref:("refs/tags/"+$tag),object:{type:"commit",sha:$target}}'
      ;;
    POST:*/git/refs)
      [[ ${FAKE_TAG_FAILURE:-0} == 1 ]] && exit 1
      : >"$FAKE_STATE/tag-created"
      jq -cn --arg tag "$EXPECT_TAG" --arg target "$EXPECT_TARGET" \
        '{ref:("refs/tags/"+$tag),object:{type:"commit",sha:$target}}'
      ;;
    GET:*/releases\?*)
      if release_exists; then
        release_json | jq -s '[.]'
      else
        printf '[[]]\n'
      fi
      ;;
    GET:*/releases/71)
      release_exists || exit 1
      release_json
      ;;
    GET:*/releases/71/assets?*) asset_pages ;;
    GET:*/releases/assets/81)
      if [[ $FAKE_RELEASE_MODE == collision ]]; then
        printf 'different bytes\n'
      else
        cat "$REQUEST"
      fi
      ;;
    POST:*/releases)
      : >"$FAKE_STATE/created"
      [[ ${FAKE_CREATE_FAILURE:-0} == 1 ]] && exit 1
      release_json
      ;;
    PATCH:*/releases/71)
      : >"$FAKE_STATE/published"
      [[ ${FAKE_PATCH_FAILURE:-0} == 1 ]] && exit 1
      release_json
      ;;
    *) echo "unexpected fake gh api call: $method $endpoint" >&2; exit 2 ;;
  esac
elif [[ ${1:-} == release && ${2:-} == upload ]]; then
  [[ -f $FAKE_STATE/published || $FAKE_RELEASE_MODE == public-identical ||
     $FAKE_RELEASE_MODE == immutable-empty ]] && {
    echo "Cannot upload assets to an immutable release" >&2
    exit 1
  }
  : >"$FAKE_STATE/uploaded"
  [[ ${FAKE_UPLOAD_FAILURE:-0} == 1 ]] && exit 1
else
  echo "unexpected fake gh call: $*" >&2
  exit 2
fi
FAKE_GH
chmod +x "$TMP_ROOT/bin/gh"

HEAD=$(jq -r '.build_source.commit' "$REQUEST")
DIGEST=$(shasum -a 256 "$REQUEST" | awk '{print $1}')
ASSET_NAME="candidate-request-${HEAD}-sha256-${DIGEST}.json"
TAG="abi-staging-pr-19-sha256-${DIGEST}"
TARGET=$(printf '3%.0s' {1..40})
URL="https://github.com/Automattic/kandelo/releases/download/${TAG}/${ASSET_NAME}"
BYTES=$(wc -c <"$REQUEST" | tr -d ' ')
TITLE='ABI staging request for PR #19'
BODY='Public, nonendorsed exact-head request. Promotion requires separate protected verification and admission.'

write_plan() {
  local action=$1 output=$2
  jq -cnS \
    --arg action "$action" --arg asset_name "$ASSET_NAME" \
    --arg asset_sha256 "$DIGEST" --arg public_download_url "$URL" \
    --arg repository Automattic/kandelo --arg tag "$TAG" \
    --argjson asset_bytes "$BYTES" --argjson pull_request_number 19 \
    '{action:$action,asset_bytes:$asset_bytes,asset_name:$asset_name,asset_sha256:$asset_sha256,public_download_url:$public_download_url,pull_request_number:$pull_request_number,repository:$repository,tag:$tag}' \
    >"$output"
}

invoke() {
  local state=$1 mode=$2
  shift 2
  env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$state/output" \
    ABI_STAGING_REQUEST_RETRY_DELAY_SECONDS=0 \
    FAKE_STATE="$state" FAKE_RELEASE_MODE="$mode" \
    EXPECT_TAG="$TAG" EXPECT_TARGET="$TARGET" EXPECT_NAME="$ASSET_NAME" \
    EXPECT_URL="$URL" EXPECT_DIGEST="$DIGEST" EXPECT_BYTES="$BYTES" \
    EXPECT_TITLE="$TITLE" EXPECT_BODY="$BODY" REQUEST="$REQUEST" "$@" \
    "$PUBLISHER" --repository Automattic/kandelo \
      --protected-target "$TARGET" --plan "$state/plan.json" --request "$REQUEST"
}

run_case() {
  local name=$1 release_mode=$2 expected_outcome=$3
  local state="$TMP_ROOT/$name"
  mkdir -p "$state"
  write_plan create-prerelease "$state/plan.json"
  if invoke "$state" "$release_mode"; then
    [[ $expected_outcome == success ]] || fail "$name unexpectedly succeeded"
    grep -Fq 'release_id=71' "$state/output" || fail "$name omitted release output"
    grep -Fq 'asset_id=81' "$state/output" || fail "$name omitted asset output"
  else
    [[ $expected_outcome == failure ]] || fail "$name unexpectedly failed"
  fi
  if [[ -f $state/calls.log ]]; then
    ! grep -Eiq -- '--clobber|method DELETE|release delete|method PATCH .*/git/refs' \
      "$state/calls.log" || fail "$name attempted a destructive operation or tag move"
  fi
}

run_case absent absent success
[[ -f $TMP_ROOT/anonymous-readback ]] || fail "absent case omitted anonymous readback"
grep -Fq -- '--method POST /repos/Automattic/kandelo/git/refs' "$TMP_ROOT/absent/calls.log" ||
  fail "absent case did not create an exact direct tag"
create_line=$(grep -n -- '--method POST /repos/Automattic/kandelo/releases' "$TMP_ROOT/absent/calls.log" | cut -d: -f1)
upload_line=$(grep -n -- 'release upload' "$TMP_ROOT/absent/calls.log" | cut -d: -f1)
publish_line=$(grep -n -- '--method PATCH /repos/Automattic/kandelo/releases/71' "$TMP_ROOT/absent/calls.log" | cut -d: -f1)
[[ $create_line -lt $upload_line && $upload_line -lt $publish_line ]] ||
  fail "request was not uploaded to a draft before immutable publication"
[[ $(grep -c -- '/git/ref/heads/main' "$TMP_ROOT/absent/calls.log") -ge 3 ]] ||
  fail "publisher did not recapture protected main before every mutation"

run_case draft-empty draft-empty success
run_case draft-untagged draft-untagged success
run_case draft-identical draft-identical success
run_case public-identical public-identical success
! grep -Eq -- 'release upload|--method (POST|PATCH) /repos/.*/releases' \
  "$TMP_ROOT/public-identical/calls.log" || fail "immutable retry attempted a Release write"
run_case collision collision failure
run_case duplicate multiple failure
run_case immutable-empty immutable-empty failure
run_case wrong-target wrong-target failure
run_case wrong-prerelease wrong-prerelease failure
run_case wrong-tag-target wrong-tag-target failure
run_case wrong-main wrong-main failure
! grep -Eq -- '--method (POST|PATCH)|release upload' "$TMP_ROOT/wrong-main/calls.log" ||
  fail "wrong protected main reached a GitHub mutation"

for hostile_url in \
  "https://evil.invalid/Automattic/kandelo/releases/download/untagged-0123456789abcdef0123/${ASSET_NAME}" \
  "https://github.com/other/kandelo/releases/download/untagged-0123456789abcdef0123/${ASSET_NAME}" \
  "https://github.com/Automattic/kandelo/releases/download/untagged-nothex/${ASSET_NAME}" \
  "https://github.com/Automattic/kandelo/releases/download/untagged-0123456789abcdef0123/other.json"
do
  state="$TMP_ROOT/hostile-$(printf '%s' "$hostile_url" | shasum -a 256 | cut -c1-8)"
  mkdir -p "$state"
  write_plan append-asset "$state/plan.json"
  EXPECT_DRAFT_URL=$hostile_url invoke "$state" draft-hostile &&
    fail "hostile draft asset URL unexpectedly succeeded: $hostile_url"
done

state="$TMP_ROOT/upload-failure"
mkdir -p "$state"
write_plan append-asset "$state/plan.json"
invoke "$state" draft-empty FAKE_UPLOAD_FAILURE=1 ||
  fail "ambiguous upload was not reconciled"

state="$TMP_ROOT/patch-failure"
mkdir -p "$state"
write_plan append-asset "$state/plan.json"
invoke "$state" draft-empty FAKE_PATCH_FAILURE=1 ||
  fail "ambiguous publication was not reconciled"
[[ -f $state/uploaded ]] || fail "draft was published before its asset was secured"

state="$TMP_ROOT/preflight"
mkdir -p "$state"
write_plan append-asset "$state/plan.json"
jq '.asset_sha256 = ("0" * 64)' "$state/plan.json" >"$state/bad-plan.json"
mv "$state/bad-plan.json" "$state/plan.json"
if invoke "$state" draft-empty; then
  fail "invalid preflight unexpectedly succeeded"
fi
[[ ! -e $state/calls.log ]] || fail "invalid preflight reached GitHub"

state="$TMP_ROOT/wrong-issuer"
mkdir -p "$state"
cp "$REQUEST" "$state/request.json"
jq -cS '.issuance.issuer_workflow_ref =
  "Automattic/kandelo/.github/workflows/abi-staging-request-feed.yml@9999999999999999999999999999999999999999"' \
  "$state/request.json" >"$state/wrong-request.json"
wrong_digest=$(shasum -a 256 "$state/wrong-request.json" | awk '{print $1}')
wrong_name="candidate-request-${HEAD}-sha256-${wrong_digest}.json"
wrong_tag="abi-staging-pr-19-sha256-${wrong_digest}"
jq -cnS --arg name "$wrong_name" --arg digest "$wrong_digest" \
  --arg tag "$wrong_tag" \
  --arg url "https://github.com/Automattic/kandelo/releases/download/${wrong_tag}/${wrong_name}" \
  --argjson bytes "$(wc -c <"$state/wrong-request.json" | tr -d ' ')" \
  '{action:"create-prerelease",asset_bytes:$bytes,asset_name:$name,
    asset_sha256:$digest,public_download_url:$url,pull_request_number:19,
    repository:"Automattic/kandelo",tag:$tag}' >"$state/plan.json"
if env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$state/output" \
    ABI_STAGING_REQUEST_RETRY_DELAY_SECONDS=0 \
    FAKE_STATE="$state" FAKE_RELEASE_MODE=absent \
    EXPECT_TAG="$wrong_tag" EXPECT_TARGET="$TARGET" EXPECT_NAME="$wrong_name" \
    EXPECT_URL="https://github.com/Automattic/kandelo/releases/download/${wrong_tag}/${wrong_name}" \
    EXPECT_DIGEST="$wrong_digest" \
    EXPECT_BYTES="$(wc -c <"$state/wrong-request.json" | tr -d ' ')" \
    EXPECT_TITLE="$TITLE" EXPECT_BODY="$BODY" REQUEST="$state/wrong-request.json" \
    "$PUBLISHER" --repository Automattic/kandelo --protected-target "$TARGET" \
      --plan "$state/plan.json" --request "$state/wrong-request.json"
then
  fail "request with another issuer commit unexpectedly reached publication"
fi
[[ ! -e $state/calls.log ]] || fail "wrong issuer request reached GitHub"

echo "test-publish-abi-staging-request: PASS"
