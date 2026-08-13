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
for command in gh jq curl shasum; do
  command -v "$command" >/dev/null || {
    echo "publish-abi-staging-request: $command is required" >&2
    exit 2
  }
done

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/public-home"
RETRY_DELAY=${ABI_STAGING_REQUEST_RETRY_DELAY_SECONDS:-1}
[[ $RETRY_DELAY =~ ^[0-9]+$ && $RETRY_DELAY -le 10 ]] || {
  echo "publish-abi-staging-request: retry delay is invalid" >&2
  exit 2
}

pause_before_retry() {
  ((RETRY_DELAY == 0)) || sleep "$RETRY_DELAY"
}

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
[[ $ASSET_SHA256 =~ ^[0-9a-f]{64}$ ]] || {
  echo "publish-abi-staging-request: invalid plan digest" >&2
  exit 1
}
[[ $TAG == "abi-staging-pr-${PR_NUMBER}-sha256-${ASSET_SHA256}" ]] || {
  echo "publish-abi-staging-request: plan tag mismatch" >&2
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
ISSUER_WORKFLOW_REF=$(jq -er '.issuance.issuer_workflow_ref' "$REQUEST")
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
EXPECTED_ISSUER_WORKFLOW_REF="${REPOSITORY}/.github/workflows/abi-staging-request-feed.yml@${PROTECTED_TARGET}"
[[ $ISSUER_WORKFLOW_REF == "$EXPECTED_ISSUER_WORKFLOW_REF" ]] || {
  echo "publish-abi-staging-request: request issuer workflow does not bind protected main" >&2
  exit 1
}
EXPECTED_NAME="candidate-request-${REQUEST_HEAD}-sha256-${ACTUAL_SHA256}.json"
EXPECTED_URL="https://github.com/${REPOSITORY}/releases/download/${TAG}/${EXPECTED_NAME}"
[[ $ASSET_NAME == "$EXPECTED_NAME" && $PUBLIC_URL == "$EXPECTED_URL" ]] || {
  echo "publish-abi-staging-request: request filename or public URL mismatch" >&2
  exit 1
}

TITLE="ABI staging request for PR #${PR_NUMBER}"
BODY="Public, nonendorsed exact-head request. Promotion requires separate protected verification and admission."
RELEASE_JSON="$TMP_ROOT/release.json"
ASSETS_JSON="$TMP_ROOT/assets.json"

validate_direct_tag() {
  jq -e --arg tag "$TAG" --arg target "$PROTECTED_TARGET" '
    .ref == ("refs/tags/" + $tag) and
    .object.type == "commit" and .object.sha == $target
  ' "$TMP_ROOT/tag.json" >/dev/null || {
    echo "publish-abi-staging-request: request tag is not a direct protected-commit reference" >&2
    return 1
  }
}

require_protected_main() {
  gh api "/repos/${REPOSITORY}/git/ref/heads/main" >"$TMP_ROOT/main.json" || return 1
  jq -e --arg target "$PROTECTED_TARGET" '
    .ref == "refs/heads/main" and
    .object.type == "commit" and .object.sha == $target
  ' "$TMP_ROOT/main.json" >/dev/null || {
    echo "publish-abi-staging-request: protected main moved during request publication" >&2
    return 1
  }
}

ensure_direct_tag() {
  local attempt
  for attempt in 1 2 3; do
    if gh api "/repos/${REPOSITORY}/git/ref/tags/${TAG}" >"$TMP_ROOT/tag.json" 2>/dev/null; then
      validate_direct_tag || return 1
      return
    fi
    pause_before_retry
    require_protected_main || return 1
    gh api --method POST "/repos/${REPOSITORY}/git/refs" \
      -f "ref=refs/tags/${TAG}" -f "sha=${PROTECTED_TARGET}" \
      >"$TMP_ROOT/tag-create.json" 2>/dev/null || true
    if gh api "/repos/${REPOSITORY}/git/ref/tags/${TAG}" >"$TMP_ROOT/tag.json" 2>/dev/null; then
      validate_direct_tag || return 1
      return
    fi
  done
  echo "publish-abi-staging-request: exact request tag creation remained uncertain" >&2
  return 1
}

validate_release_identity() {
  jq -e --arg tag "$TAG" --arg target "$PROTECTED_TARGET" \
    --arg title "$TITLE" --arg body "$BODY" '
    type == "object" and
    (.id | type == "number" and . >= 1 and floor == .) and
    .tag_name == $tag and .target_commitish == $target and
    .name == $title and .body == $body and .prerelease == true and
    (.draft | type == "boolean") and (.immutable | type == "boolean") and
    ((.draft == true and .immutable == false) or
     (.draft == false and .immutable == true))
  ' "$RELEASE_JSON" >/dev/null || {
    echo "publish-abi-staging-request: request Release identity or immutable state is invalid" >&2
    return 1
  }
}

refresh_assets() {
  local release_id pages="$TMP_ROOT/asset-pages.json"
  release_id=$(jq -er '.id' "$RELEASE_JSON") || return 1
  gh api --paginate --slurp \
    "/repos/${REPOSITORY}/releases/${release_id}/assets?per_page=100" >"$pages" || return 1
  jq -e '
    type == "array" and all(.[]; type == "array") and
    ([.[][]] | length <= 1) and
    all(.[][];
      (.id | type == "number" and . >= 1 and floor == .) and
      (.name | type == "string" and length >= 1 and length <= 512) and
      (.browser_download_url | type == "string" and startswith("https://")) and
      (.state | type == "string") and
      (.size | type == "number" and . >= 0 and floor == .) and
      ((.digest == null) or (.digest | type == "string")))
  ' "$pages" >/dev/null || {
    echo "publish-abi-staging-request: Release asset inventory is invalid" >&2
    return 1
  }
  jq '[.[][]]' "$pages" >"$ASSETS_JSON" || return 1
}

refresh_release() {
  local release_id=$1
  gh api "/repos/${REPOSITORY}/releases/${release_id}" >"$RELEASE_JSON" || return 1
  validate_release_identity || return 1
  refresh_assets || return 1
}

discover_release() {
  local pages="$TMP_ROOT/release-pages.json" matches="$TMP_ROOT/release-matches.json" release_id
  gh api --paginate --slurp "/repos/${REPOSITORY}/releases?per_page=100" >"$pages" || return 1
  jq -e 'type == "array" and all(.[]; type == "array") and ([.[][]] | length <= 4096)' \
    "$pages" >/dev/null || {
    echo "publish-abi-staging-request: Release discovery inventory is invalid or too large" >&2
    return 1
  }
  jq --arg tag "$TAG" '[.[][] | select(.tag_name == $tag)]' "$pages" >"$matches" || return 1
  case $(jq -r 'length' "$matches") in
    0) return 44 ;;
    1)
      release_id=$(jq -er '.[0].id' "$matches") || return 1
      refresh_release "$release_id" || return 1
      ;;
    *)
      echo "publish-abi-staging-request: request tag resolves to multiple Releases" >&2
      return 1
      ;;
  esac
}

CREATED=false
create_or_discover_release() {
  local attempt rc release_id
  for attempt in 1 2 3; do
    rc=0
    discover_release || rc=$?
    if [[ $rc == 0 ]]; then
      return
    elif [[ $rc != 44 ]]; then
      return 1
    fi
    require_protected_main || return 1
    if gh api --method POST "/repos/${REPOSITORY}/releases" \
      -f "tag_name=${TAG}" -f "target_commitish=${PROTECTED_TARGET}" \
      -f "name=${TITLE}" -f "body=${BODY}" -f make_latest=false \
      -F prerelease=true -F draft=true >"$TMP_ROOT/release-create.json"
    then
      release_id=$(jq -er '.id | select(type == "number" and . >= 1)' \
        "$TMP_ROOT/release-create.json" 2>/dev/null || true)
      if [[ -n $release_id ]] && refresh_release "$release_id"; then
        CREATED=true
        return
      fi
    fi
    pause_before_retry
  done
  echo "publish-abi-staging-request: draft request Release creation remained uncertain" >&2
  return 1
}

verify_authenticated_asset() {
  local asset_id
  jq -e --arg name "$ASSET_NAME" --arg url "$PUBLIC_URL" \
    --arg digest "sha256:${ASSET_SHA256}" --argjson bytes "$ASSET_BYTES" '
    length == 1 and .[0].name == $name and
    .[0].browser_download_url == $url and .[0].state == "uploaded" and
    .[0].size == $bytes and .[0].digest == $digest
  ' "$ASSETS_JSON" >/dev/null || {
    echo "publish-abi-staging-request: request asset metadata differs from its plan" >&2
    return 1
  }
  asset_id=$(jq -er '.[0].id' "$ASSETS_JSON") || return 1
  gh api -H 'Accept: application/octet-stream' \
    "/repos/${REPOSITORY}/releases/assets/${asset_id}" >"$TMP_ROOT/authenticated-request.json" ||
    return 1
  cmp -s "$REQUEST" "$TMP_ROOT/authenticated-request.json" || {
    echo "publish-abi-staging-request: authenticated request readback differs" >&2
    return 1
  }
}

ensure_asset() {
  local attempt release_id
  release_id=$(jq -er '.id' "$RELEASE_JSON") || return 1
  for attempt in 1 2 3; do
    if ! refresh_release "$release_id"; then
      pause_before_retry
      continue
    fi
    case $(jq -r 'length' "$ASSETS_JSON") in
      1)
        if verify_authenticated_asset; then
          return
        fi
        pause_before_retry
        continue
        ;;
      0) ;;
      *) return 1 ;;
    esac
    [[ $(jq -r '.draft' "$RELEASE_JSON") == true ]] || {
      echo "publish-abi-staging-request: immutable public request Release is missing its asset" >&2
      return 1
    }
    cp "$REQUEST" "$TMP_ROOT/$ASSET_NAME"
    require_protected_main || return 1
    gh release upload "$TAG" "$TMP_ROOT/$ASSET_NAME" --repo "$REPOSITORY" || true
    pause_before_retry
  done
  echo "publish-abi-staging-request: request asset upload remained uncertain" >&2
  return 1
}

seal_release() {
  local attempt release_id
  release_id=$(jq -er '.id' "$RELEASE_JSON") || return 1
  for attempt in 1 2 3; do
    if ! refresh_release "$release_id" || ! verify_authenticated_asset; then
      pause_before_retry
      continue
    fi
    if [[ $(jq -r '.draft' "$RELEASE_JSON") == false ]]; then
      return
    fi
    require_protected_main || return 1
    gh api --method PATCH "/repos/${REPOSITORY}/releases/${release_id}" \
      -f "name=${TITLE}" -f "body=${BODY}" -f make_latest=false \
      -F prerelease=true -F draft=false >"$TMP_ROOT/release-publish.json" || true
    pause_before_retry
  done
  echo "publish-abi-staging-request: request Release publication remained uncertain" >&2
  return 1
}

verify_anonymous_asset() {
  local attempt
  local -a public_env=(env -i PATH="$PATH" HOME="$TMP_ROOT/public-home")
  [[ -z ${SSL_CERT_FILE:-} ]] || public_env+=(SSL_CERT_FILE="$SSL_CERT_FILE")
  [[ -z ${NIX_SSL_CERT_FILE:-} ]] || public_env+=(NIX_SSL_CERT_FILE="$NIX_SSL_CERT_FILE")
  for attempt in 1 2 3 4; do
    if "${public_env[@]}" curl --disable --fail --location --silent --show-error \
        --connect-timeout 10 --max-time 60 "$PUBLIC_URL" \
        --output "$TMP_ROOT/anonymous-request.json" &&
      cmp -s "$REQUEST" "$TMP_ROOT/anonymous-request.json"
    then
      return
    fi
    pause_before_retry
  done
  echo "publish-abi-staging-request: anonymous immutable request readback failed" >&2
  return 1
}

ensure_direct_tag || exit 1
create_or_discover_release || exit 1
INITIAL_DRAFT=$(jq -r '.draft' "$RELEASE_JSON")
[[ $INITIAL_DRAFT == true || $INITIAL_DRAFT == false ]] || exit 1
ensure_asset || exit 1
seal_release || exit 1
RELEASE_ID=$(jq -er '.id' "$RELEASE_JSON") || exit 1
for attempt in 1 2 3; do
  if refresh_release "$RELEASE_ID" && verify_authenticated_asset; then
    break
  fi
  ((attempt < 3)) || {
    echo "publish-abi-staging-request: final authenticated reconciliation failed" >&2
    exit 1
  }
  pause_before_retry
done
[[ $(jq -r '.draft' "$RELEASE_JSON") == false &&
   $(jq -r '.immutable' "$RELEASE_JSON") == true ]] || {
  echo "publish-abi-staging-request: published request Release is not immutable" >&2
  exit 1
}
verify_anonymous_asset || exit 1

ASSET_ID=$(jq -er '.[0].id' "$ASSETS_JSON") || exit 1
if [[ $CREATED == true ]]; then
  ACTION=create-prerelease
elif [[ $INITIAL_DRAFT == true ]]; then
  ACTION=append-asset
else
  ACTION=asset-already-identical
fi
{
  printf 'release_id=%s\n' "$RELEASE_ID"
  printf 'asset_id=%s\n' "$ASSET_ID"
  printf 'asset_url=%s\n' "$PUBLIC_URL"
  printf 'action=%s\n' "$ACTION"
} >>"$GITHUB_OUTPUT"
