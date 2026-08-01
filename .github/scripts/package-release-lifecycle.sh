#!/usr/bin/env bash
# Own the draft-to-immutable transition for package-index releases.
set -euo pipefail

COMMAND="${1:-}"
if [ -n "$COMMAND" ]; then shift; fi

TAG=""
TARGET_COMMIT=""
TITLE=""
BODY_FILE=""
PRERELEASE=""
CANONICAL_SOURCE_SHA=""
ALLOW_GRANDFATHERED_ABI42=false
RETRY_DELAY_SECONDS="${PACKAGE_RELEASE_RETRY_DELAY_SECONDS:-2}"
MAX_RELEASE_PAGES="${PACKAGE_RELEASE_MAX_RELEASE_PAGES:-50}"
MAX_ASSET_PAGES="${PACKAGE_RELEASE_MAX_ASSET_PAGES:-100}"
SEAL_NAME="kandelo-package-release-seal-v1.json"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --target-commit) TARGET_COMMIT="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --prerelease) PRERELEASE="$2"; shift 2 ;;
    --canonical-source-sha) CANONICAL_SOURCE_SHA="$2"; shift 2 ;;
    --allow-grandfathered-abi42)
      ALLOW_GRANDFATHERED_ABI42=true
      shift
      ;;
    *) echo "package-release-lifecycle: unknown flag $1" >&2; exit 2 ;;
  esac
done

case "$COMMAND" in
  ensure-draft|seal-publish|state) ;;
  *)
    echo "package-release-lifecycle: command must be ensure-draft, seal-publish, or state" >&2
    exit 2
    ;;
esac
if ! [[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$ ]] ||
   ! [[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
   [ -z "$TITLE" ] || [ ! -f "$BODY_FILE" ] || [ -L "$BODY_FILE" ] ||
   { [ "$PRERELEASE" != true ] && [ "$PRERELEASE" != false ]; }; then
  echo "package-release-lifecycle: exact tag, commit, title, body file, and prerelease state are required" >&2
  exit 2
fi
for value in RETRY_DELAY_SECONDS MAX_RELEASE_PAGES MAX_ASSET_PAGES; do
  if ! [[ "${!value}" =~ ^[0-9]+$ ]]; then
    echo "package-release-lifecycle: $value must be a non-negative integer" >&2
    exit 2
  fi
done
if [ "$MAX_RELEASE_PAGES" = 0 ] || [ "$MAX_ASSET_PAGES" = 0 ]; then
  echo "package-release-lifecycle: pagination bounds must be positive" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
NORMALIZED_REPOSITORY="$(printf '%s' "$REPOSITORY" | tr '[:upper:]' '[:lower:]')"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=.github/scripts/github-api-get.sh
source "$SCRIPT_DIR/github-api-get.sh"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
RELEASE_JSON="$TMP_ROOT/release.json"
ASSETS_JSON="$TMP_ROOT/assets.json"
BODY="$(cat "$BODY_FILE")"

if [ -n "$CANONICAL_SOURCE_SHA" ] && {
     [ "$NORMALIZED_REPOSITORY" != automattic/kandelo ] ||
     [ "$TAG" != "binaries-abi-v${TAG#binaries-abi-v}" ] ||
     ! [[ "$TAG" =~ ^binaries-abi-v[1-9][0-9]*$ ]] ||
     ! [[ "$CANONICAL_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]];
   }; then
  echo "package-release-lifecycle: canonical authority requires the matching Automattic/kandelo ABI release and exact SHA" >&2
  exit 2
fi

require_write_authority() {
  [ -n "$CANONICAL_SOURCE_SHA" ] || return 0
  # WHY: GitHub reconciliation may outlive the authority check performed by
  # the caller. Recheck protected main immediately beside every release write.
  GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
    bash "$SCRIPT_DIR/require-exact-kandelo-main.sh" \
      --repository Automattic/kandelo \
      --source-sha "$CANONICAL_SOURCE_SHA" >/dev/null
}

pause_before_retry() {
  if [ "$RETRY_DELAY_SECONDS" -gt 0 ]; then
    sleep "$RETRY_DELAY_SECONDS"
  fi
}

gh_retry() {
  local attempt=1
  while true; do
    if "$@"; then return 0; fi
    if [ "$attempt" -ge 4 ]; then return 1; fi
    echo "package-release-lifecycle: GitHub command failed; retrying: $*" >&2
    pause_before_retry
    attempt=$((attempt + 1))
  done
}

validate_release_identity() {
  jq -e \
    --arg tag "$TAG" \
    --arg target "$TARGET_COMMIT" \
    --arg title "$TITLE" \
    --arg body "$BODY" \
    --argjson prerelease "$PRERELEASE" '
      type == "object" and
      .tag_name == $tag and
      .target_commitish == $target and
      .name == $title and
      .body == $body and
      .prerelease == $prerelease and
      (.id | type == "number" and . > 0) and
      (.draft | type == "boolean") and
      (.immutable | type == "boolean")
    ' "$RELEASE_JSON" >/dev/null || {
      echo "package-release-lifecycle: release identity is malformed or differs from the requested release" >&2
      return 1
    }
}

fetch_release_pages() {
  local output="$1" page page_json count reached_end=false
  : >"$output.jsonl"
  for ((page = 1; page <= MAX_RELEASE_PAGES; page++)); do
    page_json="$(gh_retry gh api \
      "/repos/${REPOSITORY}/releases?per_page=100&page=${page}")"
    jq -e 'type == "array"' <<<"$page_json" >/dev/null || {
      echo "package-release-lifecycle: malformed release page $page" >&2
      return 1
    }
    jq -c '.[]' <<<"$page_json" >>"$output.jsonl"
    count="$(jq 'length' <<<"$page_json")"
    if [ "$count" -lt 100 ]; then reached_end=true; break; fi
  done
  if [ "$reached_end" != true ]; then
    echo "package-release-lifecycle: release discovery reached its safety bound" >&2
    return 1
  fi
  if [ -s "$output.jsonl" ]; then
    jq -s . "$output.jsonl" >"$output"
  else
    printf '[]\n' >"$output"
  fi
}

discover_release() {
  local releases="$TMP_ROOT/releases.json" matches
  fetch_release_pages "$releases"
  matches="$(jq -c --arg tag "$TAG" '[.[] | select(.tag_name == $tag)]' \
    "$releases")"
  case "$(jq 'length' <<<"$matches")" in
    0) return 44 ;;
    1) jq '.[0]' <<<"$matches" >"$RELEASE_JSON" ;;
    *)
      echo "package-release-lifecycle: multiple releases claim tag $TAG" >&2
      return 1
      ;;
  esac
  validate_release_identity
}

refresh_release_by_id() {
  local id="$1"
  GITHUB_API_CONTEXT=package-release-lifecycle \
    GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
    github_api_get_json "/repos/${REPOSITORY}/releases/${id}" \
      "$RELEASE_JSON"
  validate_release_identity
}

release_state() {
  local draft immutable
  draft="$(jq -r .draft "$RELEASE_JSON")"
  immutable="$(jq -r .immutable "$RELEASE_JSON")"
  if [ "$draft" = true ]; then
    [ "$immutable" = false ] || {
      echo "package-release-lifecycle: draft release unexpectedly reports immutable=true" >&2
      return 1
    }
    printf 'draft\n'
    return 0
  fi
  if [ "$immutable" = true ]; then
    printf 'immutable\n'
    return 0
  fi
  # WHY: release immutability is not retroactive. Only the known ABI 42
  # package ledger may retain its existing transaction protocol; a broad
  # opt-out would silently create new mutable package releases.
  if [ "$ALLOW_GRANDFATHERED_ABI42" = true ] &&
     [ "$NORMALIZED_REPOSITORY" = automattic/kandelo ] &&
     [ "$TAG" = binaries-abi-v42 ] &&
     [ "$PRERELEASE" = false ]; then
    printf 'grandfathered-mutable\n'
    return 0
  fi
  echo "package-release-lifecycle: public release is mutable and is not the grandfathered ABI 42 ledger" >&2
  return 1
}

create_or_discover_draft() {
  local attempt=1 create_json="$TMP_ROOT/create.json" rc id
  while [ "$attempt" -le 4 ]; do
    require_write_authority
    if gh api --method POST "/repos/${REPOSITORY}/releases" \
      -f "tag_name=$TAG" \
      -f "target_commitish=$TARGET_COMMIT" \
      -f "name=$TITLE" \
      -f "body=$BODY" \
      -f make_latest=false \
      -F draft=true \
      -F "prerelease=$PRERELEASE" >"$create_json"
    then
      id="$(jq -er '.id | select(type == "number" and . > 0)' \
        "$create_json" 2>/dev/null || true)"
      if [ -n "$id" ] && refresh_release_by_id "$id"; then return 0; fi
    else
      echo "package-release-lifecycle: create response was ambiguous; reconciling" >&2
    fi
    rc=0
    discover_release || rc=$?
    if [ "$rc" -eq 0 ]; then return 0; fi
    if [ "$rc" -ne 44 ]; then return 1; fi
    [ "$attempt" -ge 4 ] || pause_before_retry
    attempt=$((attempt + 1))
  done
  echo "package-release-lifecycle: draft creation remained uncertain" >&2
  return 1
}

ensure_release() {
  local rc=0
  discover_release || rc=$?
  if [ "$rc" -eq 44 ]; then
    create_or_discover_draft
  elif [ "$rc" -ne 0 ]; then
    return 1
  fi
  release_state
}

refresh_assets() {
  local id page page_json count reached_end=false lines="$TMP_ROOT/assets.jsonl"
  id="$(jq -r .id "$RELEASE_JSON")"
  : >"$lines"
  for ((page = 1; page <= MAX_ASSET_PAGES; page++)); do
    page_json="$(gh_retry gh api \
      "/repos/${REPOSITORY}/releases/${id}/assets?per_page=100&page=${page}")"
    if ! jq -e '
      type == "array" and all(.[];
        (.id | type == "number" and . > 0) and
        (.name | type == "string" and length > 0) and
        .state == "uploaded" and
        (.size | type == "number" and . >= 0 and floor == .) and
        (.digest | type == "string" and
          test("^sha256:[0-9a-f]{64}$")))
    ' <<<"$page_json" >/dev/null; then
      echo "package-release-lifecycle: malformed asset page $page" >&2
      return 1
    fi
    jq -c '.[]' <<<"$page_json" >>"$lines"
    count="$(jq 'length' <<<"$page_json")"
    if [ "$count" -lt 100 ]; then reached_end=true; break; fi
  done
  if [ "$reached_end" != true ]; then
    echo "package-release-lifecycle: asset discovery reached its safety bound" >&2
    return 1
  fi
  if [ -s "$lines" ]; then jq -s . "$lines" >"$ASSETS_JSON"
  else printf '[]\n' >"$ASSETS_JSON"; fi
  jq -e '
    ([.[].id] | length == (unique | length)) and
    ([.[].name] | length == (unique | length))
  ' "$ASSETS_JSON" >/dev/null || {
    echo "package-release-lifecycle: duplicate release asset identity" >&2
    return 1
  }
}

seal_file() {
  local output="$1"
  jq -nS \
    --arg repository "$REPOSITORY" \
    --arg tag "$TAG" \
    --arg target_commit "$TARGET_COMMIT" \
    --arg title "$TITLE" \
    --arg body "$BODY" \
    --argjson prerelease "$PRERELEASE" \
    --slurpfile assets "$ASSETS_JSON" '
      {
        schema_version: 1,
        kind: "kandelo-package-release-seal",
        repository: $repository,
        tag: $tag,
        target_commit: $target_commit,
        title: $title,
        body: $body,
        prerelease: $prerelease,
        assets: ($assets[0]
          | map(select(.name != "kandelo-package-release-seal-v1.json"))
          | map({name, size, sha256: (.digest | sub("^sha256:"; ""))})
          | sort_by(.name))
      }
    ' >"$output"
}

download_asset() {
  local id="$1" output="$2"
  gh_retry gh api -H 'Accept: application/octet-stream' \
    "/repos/${REPOSITORY}/releases/assets/${id}" >"$output"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_or_upload_seal() {
  local expected="$TMP_ROOT/expected-seal.json" existing id actual upload_dir
  refresh_assets
  if [ "$(jq --arg name "$SEAL_NAME" \
      '[.[] | select(.name != $name)] | length' "$ASSETS_JSON")" = 0 ]; then
    echo "package-release-lifecycle: refusing to publish an empty package release" >&2
    return 1
  fi
  seal_file "$expected"
  existing="$(jq -c --arg name "$SEAL_NAME" \
    '[.[] | select(.name == $name)]' "$ASSETS_JSON")"
  if [ "$(jq 'length' <<<"$existing")" = 0 ]; then
    if [ "$(jq -r .draft "$RELEASE_JSON")" != true ]; then
      echo "package-release-lifecycle: public release lacks its inventory seal" >&2
      return 1
    fi
    upload_dir="$TMP_ROOT/upload"
    mkdir -p "$upload_dir"
    cp "$expected" "$upload_dir/$SEAL_NAME"
    require_write_authority
    if ! gh release upload "$TAG" --repo "$REPOSITORY" \
      "$upload_dir/$SEAL_NAME"; then
      echo "package-release-lifecycle: seal upload was ambiguous; reconciling" >&2
    fi
    refresh_assets
    existing="$(jq -c --arg name "$SEAL_NAME" \
      '[.[] | select(.name == $name)]' "$ASSETS_JSON")"
  fi
  if [ "$(jq 'length' <<<"$existing")" != 1 ]; then
    echo "package-release-lifecycle: inventory seal is not uniquely visible" >&2
    return 1
  fi
  id="$(jq -r '.[0].id' <<<"$existing")"
  actual="$TMP_ROOT/actual-seal.json"
  download_asset "$id" "$actual"
  if ! cmp "$expected" "$actual"; then
    echo "package-release-lifecycle: existing inventory seal differs from current release state" >&2
    return 1
  fi
  if [ "$(jq -r '.[0].size' <<<"$existing")" != "$(wc -c <"$expected" | tr -d '[:space:]')" ] ||
     [ "$(jq -r '.[0].digest' <<<"$existing")" != "sha256:$(sha256_file "$expected")" ]; then
    echo "package-release-lifecycle: inventory seal metadata differs from its bytes" >&2
    return 1
  fi
}

validate_direct_tag() {
  local tag_json="$TMP_ROOT/tag.json" rc=0
  GITHUB_API_CONTEXT=package-release-lifecycle \
    github_api_get_json "/repos/${REPOSITORY}/git/ref/tags/${TAG}" \
      "$tag_json" || rc=$?
  if [ "$rc" -ne 0 ]; then return "$rc"; fi
  jq -e --arg tag "$TAG" --arg sha "$TARGET_COMMIT" '
    .ref == ("refs/tags/" + $tag) and
    .object.type == "commit" and .object.sha == $sha
  ' "$tag_json" >/dev/null || {
    echo "package-release-lifecycle: release tag is not the exact direct commit reference" >&2
    return 1
  }
}

ensure_direct_tag() {
  local rc=0 attempt=1
  validate_direct_tag || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi
  if [ "$rc" -ne 44 ]; then return 1; fi
  while [ "$attempt" -le 4 ]; do
    require_write_authority
    if ! gh api --method POST "/repos/${REPOSITORY}/git/refs" \
      -f "ref=refs/tags/${TAG}" -f "sha=${TARGET_COMMIT}" >/dev/null; then
      echo "package-release-lifecycle: tag creation was ambiguous; reconciling" >&2
    fi
    rc=0
    validate_direct_tag || rc=$?
    if [ "$rc" -eq 0 ]; then return 0; fi
    if [ "$rc" -ne 44 ]; then return 1; fi
    [ "$attempt" -ge 4 ] || pause_before_retry
    attempt=$((attempt + 1))
  done
  echo "package-release-lifecycle: direct tag creation remained uncertain" >&2
  return 1
}

publish_and_reconcile() {
  local id attempt=1
  id="$(jq -r .id "$RELEASE_JSON")"
  while [ "$attempt" -le 4 ]; do
    refresh_release_by_id "$id"
    if [ "$(jq -r .draft "$RELEASE_JSON")" = false ]; then return 0; fi
    require_write_authority
    if ! gh api --method PATCH "/repos/${REPOSITORY}/releases/${id}" \
      -f make_latest=false \
      -F draft=false \
      -F "prerelease=$PRERELEASE" >/dev/null; then
      echo "package-release-lifecycle: publish response was ambiguous; reconciling" >&2
    fi
    refresh_release_by_id "$id"
    if [ "$(jq -r .draft "$RELEASE_JSON")" = false ]; then return 0; fi
    [ "$attempt" -ge 4 ] || pause_before_retry
    attempt=$((attempt + 1))
  done
  echo "package-release-lifecycle: release did not become public" >&2
  return 1
}

seal_publish() {
  local state
  state="$(ensure_release)"
  if [ "$state" = grandfathered-mutable ]; then
    echo "package-release-lifecycle: retaining grandfathered mutable $TAG" >&2
    printf '%s\n' "$state"
    return 0
  fi
  verify_or_upload_seal
  if [ "$state" = draft ]; then
    # WHY: GitHub locks both the release and its tag at publication. Verify or
    # create the exact lightweight tag before that irreversible transition.
    ensure_direct_tag
    publish_and_reconcile
  fi
  refresh_release_by_id "$(jq -r .id "$RELEASE_JSON")"
  if [ "$(release_state)" != immutable ]; then
    echo "package-release-lifecycle: release did not become immutable" >&2
    return 1
  fi
  verify_or_upload_seal
  validate_direct_tag
  printf 'immutable\n'
}

case "$COMMAND" in
  ensure-draft) ensure_release ;;
  state)
    discover_release
    release_state
    ;;
  seal-publish) seal_publish ;;
esac
