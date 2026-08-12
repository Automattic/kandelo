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

if [[ ! -x "$PUBLISHER" ]]; then
  fail "publisher is absent or not executable"
fi

mkdir -p "$TMP_ROOT/bin"
cat >"$TMP_ROOT/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$FAKE_STATE/calls.log"
printf '\n' >>"$FAKE_STATE/calls.log"

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
    GET:*/releases/tags/*)
      if [[ $FAKE_RELEASE_MODE == absent && ! -f $FAKE_STATE/created ]]; then
        exit 1
      fi
      target=$EXPECT_TARGET
      prerelease=true
      [[ $FAKE_RELEASE_MODE == wrong-target ]] && target=$(printf '9%.0s' {1..40})
      [[ $FAKE_RELEASE_MODE == wrong-prerelease ]] && prerelease=false
      jq -cn --arg tag "$EXPECT_TAG" --arg target "$target" \
        --argjson prerelease "$prerelease" \
        '{id:71,tag_name:$tag,target_commitish:$target,prerelease:$prerelease,draft:false}'
      ;;
    GET:*/releases/71/assets?*)
      if [[ -f $FAKE_STATE/uploaded ]]; then
        jq -cn --arg name "$EXPECT_NAME" --arg url "$EXPECT_URL" \
          '[[{id:81,name:$name,browser_download_url:$url}]]'
      elif [[ $FAKE_ASSET_MODE == none ]]; then
        printf '[[]]\n'
      elif [[ $FAKE_ASSET_MODE == multiple ]]; then
        jq -cn --arg name "$EXPECT_NAME" --arg url "$EXPECT_URL" \
          '[[{id:81,name:$name,browser_download_url:$url},{id:82,name:$name,browser_download_url:$url}]]'
      else
        jq -cn --arg name "$EXPECT_NAME" --arg url "$EXPECT_URL" \
          '[[{id:81,name:$name,browser_download_url:$url}]]'
      fi
      ;;
    GET:*/releases/assets/81)
      if [[ -f $FAKE_STATE/uploaded || $FAKE_ASSET_MODE == identical ]]; then
        cat "$REQUEST"
      else
        printf 'different bytes\n'
      fi
      ;;
    POST:*/releases)
      [[ ${FAKE_CREATE_FAILURE:-0} == 1 ]] && exit 1
      : >"$FAKE_STATE/created"
      jq -cn --arg tag "$EXPECT_TAG" --arg target "$EXPECT_TARGET" \
        '{id:71,tag_name:$tag,target_commitish:$target,prerelease:true,draft:false}'
      ;;
    PATCH:*/releases/71)
      [[ ${FAKE_PATCH_FAILURE:-0} == 1 ]] && exit 1
      printf '{"id":71}\n'
      ;;
    *) echo "unexpected fake gh api call: $method $endpoint" >&2; exit 2 ;;
  esac
elif [[ ${1:-} == release && ${2:-} == upload ]]; then
  [[ ${FAKE_UPLOAD_FAILURE:-0} == 1 ]] && exit 1
  : >"$FAKE_STATE/uploaded"
else
  echo "unexpected fake gh call: $*" >&2
  exit 2
fi
FAKE_GH
chmod +x "$TMP_ROOT/bin/gh"

HEAD=$(jq -r '.build_source.commit' "$REQUEST")
DIGEST=$(shasum -a 256 "$REQUEST" | awk '{print $1}')
ASSET_NAME="candidate-request-${HEAD}-sha256-${DIGEST}.json"
TAG=abi-staging-pr-19
TARGET=$(printf '3%.0s' {1..40})
URL="https://github.com/Automattic/kandelo/releases/download/${TAG}/${ASSET_NAME}"
BYTES=$(wc -c <"$REQUEST" | tr -d ' ')

write_plan() {
  local action=$1 output=$2
  jq -cnS \
    --arg action "$action" \
    --arg asset_name "$ASSET_NAME" \
    --arg asset_sha256 "$DIGEST" \
    --arg public_download_url "$URL" \
    --arg repository Automattic/kandelo \
    --arg tag "$TAG" \
    --argjson asset_bytes "$BYTES" \
    --argjson pull_request_number 19 \
    '{action:$action,asset_bytes:$asset_bytes,asset_name:$asset_name,asset_sha256:$asset_sha256,public_download_url:$public_download_url,pull_request_number:$pull_request_number,repository:$repository,tag:$tag}' \
    >"$output"
}

run_case() {
  local name=$1 release_mode=$2 asset_mode=$3 expected=$4
  local state="$TMP_ROOT/$name"
  mkdir -p "$state"
  write_plan create-prerelease "$state/plan.json"
  if env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$state/output" \
    FAKE_STATE="$state" FAKE_RELEASE_MODE="$release_mode" FAKE_ASSET_MODE="$asset_mode" \
    EXPECT_TAG="$TAG" EXPECT_TARGET="$TARGET" EXPECT_NAME="$ASSET_NAME" EXPECT_URL="$URL" \
    REQUEST="$REQUEST" "$PUBLISHER" --repository Automattic/kandelo \
    --protected-target "$TARGET" --plan "$state/plan.json" --request "$REQUEST"; then
    [[ $expected == success ]] || fail "$name unexpectedly succeeded"
    grep -Fq 'release_id=71' "$state/output" || fail "$name omitted release output"
    grep -Fq 'asset_id=81' "$state/output" || fail "$name omitted asset output"
  else
    [[ $expected == failure ]] || fail "$name unexpectedly failed"
  fi
  if [[ -f $state/calls.log ]]; then
    ! grep -Eiq -- '--clobber|method DELETE|release delete|refs/tags' "$state/calls.log" ||
      fail "$name attempted a destructive or mutable-tag operation"
  fi
}

run_case absent absent none success
run_case append correct none success
run_case identical correct identical success
run_case collision correct collision failure
run_case duplicate correct multiple failure
run_case wrong-target wrong-target none failure
run_case wrong-prerelease wrong-prerelease none failure

state="$TMP_ROOT/upload-failure"
mkdir -p "$state"
write_plan append-asset "$state/plan.json"
if env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$state/output" \
  FAKE_STATE="$state" FAKE_RELEASE_MODE=correct FAKE_ASSET_MODE=none FAKE_UPLOAD_FAILURE=1 \
  EXPECT_TAG="$TAG" EXPECT_TARGET="$TARGET" EXPECT_NAME="$ASSET_NAME" EXPECT_URL="$URL" \
  REQUEST="$REQUEST" "$PUBLISHER" --repository Automattic/kandelo \
  --protected-target "$TARGET" --plan "$state/plan.json" --request "$REQUEST"; then
  fail "upload failure unexpectedly succeeded"
fi

state="$TMP_ROOT/patch-failure"
mkdir -p "$state"
write_plan append-asset "$state/plan.json"
if env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$state/output" \
  FAKE_STATE="$state" FAKE_RELEASE_MODE=correct FAKE_ASSET_MODE=none FAKE_PATCH_FAILURE=1 \
  EXPECT_TAG="$TAG" EXPECT_TARGET="$TARGET" EXPECT_NAME="$ASSET_NAME" EXPECT_URL="$URL" \
  REQUEST="$REQUEST" "$PUBLISHER" --repository Automattic/kandelo \
  --protected-target "$TARGET" --plan "$state/plan.json" --request "$REQUEST"; then
  fail "description update failure unexpectedly succeeded"
fi
[[ -f $state/uploaded ]] || fail "description was updated before the asset was secured"

state="$TMP_ROOT/preflight"
mkdir -p "$state"
write_plan append-asset "$state/plan.json"
jq '.asset_sha256 = ("0" * 64)' "$state/plan.json" >"$state/bad-plan.json"
if env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$state/output" \
  FAKE_STATE="$state" FAKE_RELEASE_MODE=correct FAKE_ASSET_MODE=none \
  EXPECT_TAG="$TAG" EXPECT_TARGET="$TARGET" EXPECT_NAME="$ASSET_NAME" EXPECT_URL="$URL" \
  REQUEST="$REQUEST" "$PUBLISHER" --repository Automattic/kandelo \
  --protected-target "$TARGET" --plan "$state/bad-plan.json" --request "$REQUEST"; then
  fail "invalid preflight unexpectedly succeeded"
fi
[[ ! -e $state/calls.log ]] || fail "invalid preflight reached GitHub"

echo "test-publish-abi-staging-request: PASS"
