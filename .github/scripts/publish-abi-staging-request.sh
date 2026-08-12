#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: publish-abi-staging-request.sh \
  --repository OWNER/REPOSITORY \
  --protected-target FULL_SHA \
  --plan CANONICAL_PLAN_JSON \
  --request CANONICAL_REQUEST_JSON
USAGE
  exit 2
}

REPOSITORY=
PROTECTED_TARGET=
PLAN=
REQUEST=
while (($#)); do
  case "$1" in
    --repository) REPOSITORY=${2:-}; shift 2 ;;
    --protected-target) PROTECTED_TARGET=${2:-}; shift 2 ;;
    --plan) PLAN=${2:-}; shift 2 ;;
    --request) REQUEST=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done

[[ $REPOSITORY =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || usage
[[ $PROTECTED_TARGET =~ ^[0-9a-f]{40}$ ]] || usage
[[ -n $PLAN && -f $PLAN && ! -L $PLAN ]] || usage
[[ -n $REQUEST && -f $REQUEST && ! -L $REQUEST ]] || usage
[[ -n ${GH_TOKEN:-} ]] || {
  echo "publish-abi-staging-request: GH_TOKEN is required" >&2
  exit 2
}
[[ -n ${GITHUB_OUTPUT:-} ]] || {
  echo "publish-abi-staging-request: GITHUB_OUTPUT is required" >&2
  exit 2
}
command -v gh >/dev/null || {
  echo "publish-abi-staging-request: gh is required" >&2
  exit 2
}
command -v jq >/dev/null || {
  echo "publish-abi-staging-request: jq is required" >&2
  exit 2
}

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

jq -e -cS . "$PLAN" >"$TMP_ROOT/plan.canonical" || {
  echo "publish-abi-staging-request: plan is invalid JSON" >&2
  exit 1
}
cmp -s "$PLAN" "$TMP_ROOT/plan.canonical" || {
  echo "publish-abi-staging-request: plan is not canonical JSON" >&2
  exit 1
}
jq -e '
  keys == [
    "action", "asset_bytes", "asset_name", "asset_sha256",
    "public_download_url", "pull_request_number", "repository", "tag"
  ] and
  (.action | IN("create-prerelease", "append-asset", "asset-already-identical", "reject-name-collision")) and
  (.asset_bytes | type == "number" and . >= 1 and floor == .) and
  (.pull_request_number | type == "number" and . >= 1 and floor == .) and
  (.repository | type == "string") and
  (.tag | type == "string") and
  (.asset_name | type == "string") and
  (.asset_sha256 | type == "string") and
  (.public_download_url | type == "string")
' "$PLAN" >/dev/null || {
  echo "publish-abi-staging-request: plan has an invalid shape" >&2
  exit 1
}

PLAN_REPOSITORY=$(jq -r '.repository' "$PLAN")
PLAN_ACTION=$(jq -r '.action' "$PLAN")
TAG=$(jq -r '.tag' "$PLAN")
ASSET_NAME=$(jq -r '.asset_name' "$PLAN")
ASSET_SHA256=$(jq -r '.asset_sha256' "$PLAN")
ASSET_BYTES=$(jq -r '.asset_bytes' "$PLAN")
PUBLIC_URL=$(jq -r '.public_download_url' "$PLAN")
PR_NUMBER=$(jq -r '.pull_request_number' "$PLAN")

[[ $PLAN_REPOSITORY == "$REPOSITORY" ]] || {
  echo "publish-abi-staging-request: plan repository mismatch" >&2
  exit 1
}
[[ $TAG == "abi-staging-pr-${PR_NUMBER}" ]] || {
  echo "publish-abi-staging-request: plan tag mismatch" >&2
  exit 1
}
[[ $ASSET_SHA256 =~ ^[0-9a-f]{64}$ ]] || {
  echo "publish-abi-staging-request: invalid plan digest" >&2
  exit 1
}
[[ $PLAN_ACTION != reject-name-collision ]] || {
  echo "publish-abi-staging-request: protected plan rejects an asset-name collision" >&2
  exit 1
}

jq -e -cS . "$REQUEST" >"$TMP_ROOT/request.canonical" || {
  echo "publish-abi-staging-request: request is invalid JSON" >&2
  exit 1
}
cmp -s "$REQUEST" "$TMP_ROOT/request.canonical" || {
  echo "publish-abi-staging-request: request is not canonical JSON" >&2
  exit 1
}
ACTUAL_BYTES=$(wc -c <"$REQUEST" | tr -d ' ')
ACTUAL_SHA256=$(shasum -a 256 "$REQUEST" | awk '{print $1}')
[[ $ACTUAL_BYTES == "$ASSET_BYTES" && $ACTUAL_SHA256 == "$ASSET_SHA256" ]] || {
  echo "publish-abi-staging-request: request bytes do not match the plan" >&2
  exit 1
}

REQUEST_REPOSITORY=$(jq -er '.pull_request.repository' "$REQUEST")
REQUEST_PR=$(jq -er '.pull_request.number' "$REQUEST")
REQUEST_HEAD=$(jq -er '.build_source.commit' "$REQUEST")
AUTHORIZATION_HEAD=$(jq -er '.issuance.authorization.head' "$REQUEST")
AUTHORIZATION_MODE=$(jq -er '.issuance.authorization.mode' "$REQUEST")
[[ $REQUEST_REPOSITORY == "$REPOSITORY" && $REQUEST_PR == "$PR_NUMBER" ]] || {
  echo "publish-abi-staging-request: request pull-request identity mismatch" >&2
  exit 1
}
[[ $REQUEST_HEAD =~ ^[0-9a-f]{40}$ ]] || {
  echo "publish-abi-staging-request: request head is not a full lowercase SHA" >&2
  exit 1
}
[[ $AUTHORIZATION_MODE == same-repository && $AUTHORIZATION_HEAD == "$REQUEST_HEAD" ]] || {
  echo "publish-abi-staging-request: request is not exact-head same-repository authorized" >&2
  exit 1
}
EXPECTED_NAME="candidate-request-${REQUEST_HEAD}-sha256-${ACTUAL_SHA256}.json"
EXPECTED_URL="https://github.com/${REPOSITORY}/releases/download/${TAG}/${EXPECTED_NAME}"
[[ $ASSET_NAME == "$EXPECTED_NAME" && $PUBLIC_URL == "$EXPECTED_URL" ]] || {
  echo "publish-abi-staging-request: request filename or public URL mismatch" >&2
  exit 1
}

RELEASE_JSON="$TMP_ROOT/release.json"
if gh api "/repos/${REPOSITORY}/releases/tags/${TAG}" >"$RELEASE_JSON" 2>"$TMP_ROOT/release-get.err"; then
  ACTION=append-asset
else
  gh api --method POST "/repos/${REPOSITORY}/releases" \
    -f "tag_name=${TAG}" \
    -f "target_commitish=${PROTECTED_TARGET}" \
    -f "name=ABI staging requests for PR #${PR_NUMBER}" \
    -f "body=Public candidate requests are nonendorsed inputs. Identity, verification, and admission remain separate." \
    -F prerelease=true \
    -F draft=false >"$RELEASE_JSON"
  ACTION=create-prerelease
fi

jq -e \
  --arg tag "$TAG" \
  --arg target "$PROTECTED_TARGET" '
    (.id | type == "number" and . >= 1 and floor == .) and
    .tag_name == $tag and
    .target_commitish == $target and
    .prerelease == true and
    .draft == false
  ' "$RELEASE_JSON" >/dev/null || {
  echo "publish-abi-staging-request: existing Release identity or flags are invalid" >&2
  exit 1
}
RELEASE_ID=$(jq -r '.id' "$RELEASE_JSON")

list_assets() {
  local output=$1
  gh api --paginate --slurp \
    "/repos/${REPOSITORY}/releases/${RELEASE_ID}/assets?per_page=100" >"$output"
  jq -e '
    type == "array" and all(.[]; type == "array") and
    ([.[][]] | length <= 4096) and
    all(.[][];
      (keys | sort) as $keys |
      ($keys | index("id")) != null and
      ($keys | index("name")) != null and
      ($keys | index("browser_download_url")) != null and
      (.id | type == "number" and . >= 1 and floor == .) and
      (.name | type == "string" and length >= 1 and length <= 512) and
      (.browser_download_url | type == "string" and startswith("https://"))
    )
  ' "$output" >/dev/null || {
    echo "publish-abi-staging-request: Release asset inventory is invalid or too large" >&2
    exit 1
  }
}

ASSET_PAGES="$TMP_ROOT/assets.json"
list_assets "$ASSET_PAGES"
MATCH_COUNT=$(jq --arg name "$ASSET_NAME" '[.[][] | select(.name == $name)] | length' "$ASSET_PAGES")
if [[ $MATCH_COUNT == 0 ]]; then
  cp "$REQUEST" "$TMP_ROOT/$ASSET_NAME"
  gh release upload "$TAG" "$TMP_ROOT/$ASSET_NAME" --repo "$REPOSITORY"
  [[ $ACTION == create-prerelease ]] || ACTION=append-asset
  list_assets "$ASSET_PAGES"
  MATCH_COUNT=$(jq --arg name "$ASSET_NAME" '[.[][] | select(.name == $name)] | length' "$ASSET_PAGES")
elif [[ $MATCH_COUNT == 1 ]]; then
  EXISTING_ASSET_ID=$(jq -r --arg name "$ASSET_NAME" '.[][] | select(.name == $name) | .id' "$ASSET_PAGES")
  gh api -H 'Accept: application/octet-stream' \
    "/repos/${REPOSITORY}/releases/assets/${EXISTING_ASSET_ID}" >"$TMP_ROOT/existing-request.json"
  cmp -s "$REQUEST" "$TMP_ROOT/existing-request.json" || {
    echo "publish-abi-staging-request: immutable asset-name collision" >&2
    exit 1
  }
  ACTION=asset-already-identical
else
  echo "publish-abi-staging-request: duplicate exact-name Release assets" >&2
  exit 1
fi

[[ $MATCH_COUNT == 1 ]] || {
  echo "publish-abi-staging-request: upload did not create exactly one named asset" >&2
  exit 1
}
ASSET_ID=$(jq -r --arg name "$ASSET_NAME" '.[][] | select(.name == $name) | .id' "$ASSET_PAGES")
ASSET_URL=$(jq -r --arg name "$ASSET_NAME" '.[][] | select(.name == $name) | .browser_download_url' "$ASSET_PAGES")
[[ $ASSET_URL == "$PUBLIC_URL" ]] || {
  echo "publish-abi-staging-request: published asset URL mismatch" >&2
  exit 1
}

# Descriptive prose is deliberately updated last and is never read as
# authority. If this call is interrupted, a retry rediscovers and verifies the
# already-appended immutable asset before repairing the prose.
gh api --method PATCH "/repos/${REPOSITORY}/releases/${RELEASE_ID}" \
  -f "body=Public, nonendorsed exact-head request feed for PR #${PR_NUMBER}. Request assets are append-only; promotion requires separate protected verification and admission." \
  >/dev/null

{
  printf 'release_id=%s\n' "$RELEASE_ID"
  printf 'asset_id=%s\n' "$ASSET_ID"
  printf 'asset_url=%s\n' "$ASSET_URL"
  printf 'action=%s\n' "$ACTION"
} >>"$GITHUB_OUTPUT"
