#!/usr/bin/env bash
# Publish one exact manifest as a recoverable GitHub immutable release.
set -euo pipefail

MANIFEST=""
ASSET_ROOT=""
LOCK_ROOT=""
RECEIPT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --asset-root) ASSET_ROOT="$2"; shift 2 ;;
    --lock-root) LOCK_ROOT="$2"; shift 2 ;;
    --receipt) RECEIPT="$2"; shift 2 ;;
    *) echo "publish-immutable-github-release: unknown flag $1" >&2; exit 2 ;;
  esac
done

for required in MANIFEST ASSET_ROOT LOCK_ROOT RECEIPT; do
  if [ -z "${!required}" ]; then
    echo "publish-immutable-github-release: missing ${required,,}" >&2
    exit 2
  fi
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-$REPO_ROOT/.github/scripts/state-lock.sh}"
RETRY_DELAY="${IMMUTABLE_RELEASE_RETRY_DELAY_SECONDS:-2}"
if ! [[ "$RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  echo "publish-immutable-github-release: retry delay must be non-negative" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
NORMALIZED_MANIFEST="$TMP_ROOT/manifest.json"
STAGED_ASSETS="$TMP_ROOT/assets"
RELEASE_JSON="$TMP_ROOT/release.json"
ASSETS_JSON="$TMP_ROOT/assets.json"
LOCK_STATE="$TMP_ROOT/state-lock.env"
LOCK_ACQUIRED=false

release_state_lock() {
  if [ "$LOCK_ACQUIRED" = true ]; then
    (
      cd "$LOCK_ROOT"
      STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release
    )
    LOCK_ACQUIRED=false
  fi
}

cleanup() {
  release_state_lock >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

# The caller's handoff and manifest are inert input. Stage their exact bytes
# with both common token variables removed before checking or using a token.
env -u GH_TOKEN -u GITHUB_TOKEN PYTHONDONTWRITEBYTECODE=1 \
  python3 "$SCRIPT_DIR/validate-immutable-github-release-manifest.py" \
    --manifest "$MANIFEST" \
    --asset-root "$ASSET_ROOT" \
    --stage-dir "$STAGED_ASSETS" \
    --out-manifest "$NORMALIZED_MANIFEST"

REPOSITORY="$(jq -er '.repository' "$NORMALIZED_MANIFEST")"
TAG="$(jq -er '.tag' "$NORMALIZED_MANIFEST")"
TARGET_COMMIT="$(jq -er '.target_commitish' "$NORMALIZED_MANIFEST")"
TITLE="$(jq -er '.title' "$NORMALIZED_MANIFEST")"
BODY="$(jq -er '.body' "$NORMALIZED_MANIFEST")"

[ "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" = "$REPOSITORY" ] ||
  [ "${GITHUB_REPOSITORY,,}" = "$REPOSITORY" ] || {
  echo "publish-immutable-github-release: workflow repository differs from target repository" >&2
  exit 2
}
[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || {
  echo "publish-immutable-github-release: a GitHub token is required" >&2
  exit 2
}

# shellcheck source=.github/scripts/github-api-get.sh
. "$REPO_ROOT/.github/scripts/github-api-get.sh"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_bytes() {
  wc -c <"$1" | tr -d '[:space:]'
}

pause_before_retry() {
  if [ "$RETRY_DELAY" -gt 0 ]; then
    sleep "$RETRY_DELAY"
  fi
}

retry_command() {
  local attempt=1
  while ! "$@"; do
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "publish-immutable-github-release: command failed; reconciling before retry: $*" >&2
    pause_before_retry
    attempt=$((attempt + 1))
  done
}

fetch_paginated_arrays() {
  local endpoint="$1" output="$2" context="$3"
  local attempt=1 temporary="$TMP_ROOT/pages-$RANDOM.json"
  while true; do
    if gh api --paginate --slurp "$endpoint" >"$temporary" &&
       jq -e 'type == "array" and all(.[]; type == "array")' \
         "$temporary" >/dev/null
    then
      mv "$temporary" "$output"
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      echo "publish-immutable-github-release: $context pagination remained uncertain" >&2
      return 1
    fi
    echo "publish-immutable-github-release: $context pagination failed; retrying" >&2
    pause_before_retry
    attempt=$((attempt + 1))
  done
}

validate_release_identity() {
  jq -e --arg tag "$TAG" --arg target "$TARGET_COMMIT" \
    --arg title "$TITLE" --arg body "$BODY" '
    type == "object" and .tag_name == $tag and .target_commitish == $target and
    .name == $title and .body == $body and
    (.id | type == "number" and . > 0) and .prerelease == false and
    (.draft | type == "boolean") and (.immutable | type == "boolean")
  ' "$RELEASE_JSON" >/dev/null || {
    echo "publish-immutable-github-release: existing release identity is malformed or mismatched" >&2
    return 1
  }
  if [ "$(jq -r '.draft' "$RELEASE_JSON")" = false ] &&
     [ "$(jq -r '.immutable' "$RELEASE_JSON")" != true ]; then
    echo "publish-immutable-github-release: public release is not protected by GitHub immutable releases" >&2
    return 1
  fi
}

refresh_assets() {
  local release_id pages="$TMP_ROOT/asset-pages.json"
  release_id="$(jq -er '.id' "$RELEASE_JSON")"
  fetch_paginated_arrays \
    "/repos/${REPOSITORY}/releases/${release_id}/assets?per_page=100" \
    "$pages" "release asset" || return 1
  jq '[.[][]]' "$pages" >"$ASSETS_JSON"
  jq -e '
    type == "array" and length <= 256 and
    all(.[];
      type == "object" and
      (.id | type == "number" and . > 0) and
      (.name | type == "string" and length > 0) and
      (.state | type == "string") and
      (.size | type == "number" and . >= 0) and
      ((.digest == null) or (.digest | type == "string"))) and
    ([.[].id] | length == (unique | length)) and
    ([.[].name] | length == (unique | length))
  ' "$ASSETS_JSON" >/dev/null || {
    echo "publish-immutable-github-release: release contains malformed, duplicate, or too many assets" >&2
    return 1
  }
}

refresh_release_by_id() {
  local release_id="$1"
  GITHUB_API_CONTEXT=publish-immutable-github-release \
    github_api_get_json "/repos/${REPOSITORY}/releases/${release_id}" "$RELEASE_JSON" ||
    return $?
  validate_release_identity || return 1
  refresh_assets || return 1
}

refresh_public_release() {
  local rc=0 release_id
  GITHUB_API_CONTEXT=publish-immutable-github-release \
    github_api_get_json "/repos/${REPOSITORY}/releases/tags/${TAG}" "$RELEASE_JSON" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  validate_release_identity || return 1
  release_id="$(jq -er '.id' "$RELEASE_JSON")"
  refresh_release_by_id "$release_id" || return $?
}

discover_release() {
  local pages="$TMP_ROOT/release-pages.json" matches="$TMP_ROOT/release-matches.json"
  fetch_paginated_arrays "/repos/${REPOSITORY}/releases?per_page=100" \
    "$pages" "release discovery" || return 1
  jq --arg tag "$TAG" '[.[][] | select(.tag_name == $tag)]' \
    "$pages" >"$matches"
  case "$(jq -r 'length' "$matches")" in
    0) return 44 ;;
    1) jq '.[0]' "$matches" >"$RELEASE_JSON" ;;
    *)
      echo "publish-immutable-github-release: tag resolves to multiple releases" >&2
      return 1
      ;;
  esac
  refresh_release_by_id "$(jq -er '.id' "$RELEASE_JSON")"
}

create_or_discover_release() {
  local attempt=1 create_json="$TMP_ROOT/create.json" rc release_id
  while [ "$attempt" -le 4 ]; do
    : >"$create_json"
    if gh api --method POST "/repos/${REPOSITORY}/releases" \
      -f "tag_name=$TAG" -f "target_commitish=$TARGET_COMMIT" \
      -f "name=$TITLE" -f "body=$BODY" -f make_latest=false \
      -F draft=true -F prerelease=false >"$create_json"
    then
      release_id="$(jq -er '.id | select(type == "number" and . > 0)' \
        "$create_json")" || release_id=""
      if [ -n "$release_id" ] && refresh_release_by_id "$release_id"; then
        return 0
      fi
    else
      echo "publish-immutable-github-release: create response was ambiguous; reconciling" >&2
    fi

    rc=0
    discover_release || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    if [ "$rc" -ne 44 ]; then
      return 1
    fi
    if [ "$attempt" -lt 4 ]; then
      pause_before_retry
    fi
    attempt=$((attempt + 1))
  done
  echo "publish-immutable-github-release: release creation remained uncertain" >&2
  return 1
}

SELECTED_NAMES="$TMP_ROOT/selected-names.json"
SELECTED_MODE=""

select_asset_set() {
  local actual="$TMP_ROOT/actual-names.json" candidate actual_compact preferred_compact
  jq '[.[].name] | sort' "$ASSETS_JSON" >"$actual"
  actual_compact="$(jq -c . "$actual")"
  preferred_compact="$(jq -c '.preferred_asset_names' "$NORMALIZED_MANIFEST")"
  if [ "$actual_compact" = "$preferred_compact" ]; then
    jq '.preferred_asset_names' "$NORMALIZED_MANIFEST" >"$SELECTED_NAMES"
    SELECTED_MODE=preferred
    return 0
  fi

  while IFS= read -r candidate; do
    if [ "$actual_compact" = "$candidate" ]; then
      printf '%s\n' "$candidate" >"$SELECTED_NAMES"
      SELECTED_MODE=complete-existing
      return 0
    fi
  done < <(jq -c '.accepted_existing_asset_sets[]' "$NORMALIZED_MANIFEST")

  if [ "$(jq -r '.draft' "$RELEASE_JSON")" = true ] &&
     jq -e --slurpfile actual "$actual" '
       ($actual[0] - .preferred_asset_names) | length == 0
     ' "$NORMALIZED_MANIFEST" >/dev/null
  then
    jq '.preferred_asset_names' "$NORMALIZED_MANIFEST" >"$SELECTED_NAMES"
    SELECTED_MODE=preferred
    return 0
  fi

  echo "publish-immutable-github-release: release contains an unexpected or partial legacy asset set" >&2
  return 1
}

assert_inventory_still_allowed() {
  local actual="$TMP_ROOT/current-names.json"
  jq '[.[].name] | sort' "$ASSETS_JSON" >"$actual"
  if [ "$SELECTED_MODE" = preferred ]; then
    jq -e --slurpfile selected "$SELECTED_NAMES" '
      ([.[].name] - $selected[0]) | length == 0
    ' "$ASSETS_JSON" >/dev/null || {
      echo "publish-immutable-github-release: release gained an unexpected asset" >&2
      return 1
    }
  elif [ "$(jq -c . "$actual")" != "$(jq -c . "$SELECTED_NAMES")" ]; then
    echo "publish-immutable-github-release: accepted existing asset set changed" >&2
    return 1
  fi
}

assert_complete_asset_set() {
  local actual expected
  actual="$(jq -c '[.[].name] | sort' "$ASSETS_JSON")"
  expected="$(jq -c . "$SELECTED_NAMES")"
  if [ "$actual" != "$expected" ]; then
    echo "publish-immutable-github-release: release does not contain its complete exact asset set" >&2
    return 1
  fi
}

asset_declaration() {
  local name="$1"
  jq -ce --arg name "$name" '.assets[] | select(.name == $name)' \
    "$NORMALIZED_MANIFEST"
}

verify_authenticated_asset() {
  local name="$1" declaration asset expected_sha expected_bytes asset_id
  local downloaded="$TMP_ROOT/authenticated-$1"
  declaration="$(asset_declaration "$name")"
  expected_sha="$(jq -er '.sha256' <<<"$declaration")"
  expected_bytes="$(jq -er '.bytes' <<<"$declaration")"
  asset="$(jq -ce --arg name "$name" '.[] | select(.name == $name)' "$ASSETS_JSON")" || {
    echo "publish-immutable-github-release: asset $name is not uniquely visible" >&2
    return 1
  }
  jq -e --arg sha "sha256:${expected_sha}" --argjson bytes "$expected_bytes" '
    .state == "uploaded" and .size == $bytes and .digest == $sha
  ' <<<"$asset" >/dev/null || {
    echo "publish-immutable-github-release: asset $name metadata differs from its exact digest or size" >&2
    return 1
  }
  asset_id="$(jq -er '.id' <<<"$asset")"
  download_authenticated_asset() {
    gh api -H 'Accept: application/octet-stream' \
      "/repos/${REPOSITORY}/releases/assets/${asset_id}" >"$downloaded"
  }
  retry_command download_authenticated_asset || {
    echo "publish-immutable-github-release: authenticated readback failed for $name" >&2
    return 1
  }
  if [ "$(file_bytes "$downloaded")" != "$expected_bytes" ] ||
     [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
    echo "publish-immutable-github-release: authenticated digest readback failed for $name" >&2
    return 1
  fi
}

ensure_asset() {
  local name="$1" attempt=1 upload_rc
  while [ "$attempt" -le 4 ]; do
    refresh_release_by_id "$(jq -er '.id' "$RELEASE_JSON")"
    assert_inventory_still_allowed
    if jq -e --arg name "$name" 'any(.[]; .name == $name)' \
      "$ASSETS_JSON" >/dev/null
    then
      verify_authenticated_asset "$name"
      return 0
    fi
    if [ "$(jq -r '.draft' "$RELEASE_JSON")" != true ]; then
      echo "publish-immutable-github-release: public release is missing immutable asset $name" >&2
      return 1
    fi

    upload_rc=0
    gh release upload "$TAG" --repo "$REPOSITORY" "$STAGED_ASSETS/$name" || upload_rc=$?
    if [ "$upload_rc" -ne 0 ]; then
      echo "publish-immutable-github-release: upload response for $name was ambiguous; reconciling" >&2
    fi
    refresh_release_by_id "$(jq -er '.id' "$RELEASE_JSON")"
    assert_inventory_still_allowed
    if jq -e --arg name "$name" 'any(.[]; .name == $name)' \
      "$ASSETS_JSON" >/dev/null
    then
      verify_authenticated_asset "$name"
      return 0
    fi
    if [ "$attempt" -lt 4 ]; then
      pause_before_retry
    fi
    attempt=$((attempt + 1))
  done
  echo "publish-immutable-github-release: upload remained uncertain for $name" >&2
  return 1
}

validate_direct_tag() {
  local tag_json="$TMP_ROOT/tag.json" tag_rc=0
  GITHUB_API_CONTEXT=publish-immutable-github-release \
    github_api_get_json "/repos/${REPOSITORY}/git/ref/tags/${TAG}" "$tag_json" || tag_rc=$?
  if [ "$tag_rc" -ne 0 ]; then
    return "$tag_rc"
  fi
  jq -e --arg sha "$TARGET_COMMIT" --arg tag "$TAG" '
    .ref == ("refs/tags/" + $tag) and
    .object.type == "commit" and .object.sha == $sha
  ' "$tag_json" >/dev/null || {
    echo "publish-immutable-github-release: release tag is not a direct reference to the planned commit" >&2
    return 1
  }
}

# GitHub ignores target_commitish when a release tag already exists. Establish
# or verify the exact lightweight tag before making the release immutable, so a
# stale or annotated tag cannot poison an otherwise valid content release.
ensure_direct_tag() {
  local attempt=1 create_rc tag_rc
  tag_rc=0
  validate_direct_tag || tag_rc=$?
  if [ "$tag_rc" -eq 0 ]; then
    return 0
  fi
  if [ "$tag_rc" -ne 44 ]; then
    return 1
  fi

  while [ "$attempt" -le 4 ]; do
    create_rc=0
    gh api --method POST "/repos/${REPOSITORY}/git/refs" \
      -f "ref=refs/tags/${TAG}" -f "sha=${TARGET_COMMIT}" >/dev/null || create_rc=$?
    if [ "$create_rc" -ne 0 ]; then
      echo "publish-immutable-github-release: tag creation response was ambiguous; reconciling" >&2
    fi
    tag_rc=0
    validate_direct_tag || tag_rc=$?
    if [ "$tag_rc" -eq 0 ]; then
      return 0
    fi
    if [ "$tag_rc" -ne 44 ]; then
      return 1
    fi
    if [ "$attempt" -lt 4 ]; then
      pause_before_retry
    fi
    attempt=$((attempt + 1))
  done
  echo "publish-immutable-github-release: exact release tag creation remained uncertain" >&2
  return 1
}

publish_and_reconcile() {
  local attempt=1 release_id patch_rc
  release_id="$(jq -er '.id' "$RELEASE_JSON")"
  while [ "$attempt" -le 4 ]; do
    refresh_release_by_id "$release_id"
    if [ "$(jq -r '.draft' "$RELEASE_JSON")" = false ]; then
      return 0
    fi
    patch_rc=0
    gh api --method PATCH "/repos/${REPOSITORY}/releases/${release_id}" \
      -f make_latest=false -F draft=false -F prerelease=false >/dev/null || patch_rc=$?
    if [ "$patch_rc" -ne 0 ]; then
      echo "publish-immutable-github-release: publish response was ambiguous; reconciling" >&2
    fi
    refresh_release_by_id "$release_id"
    if [ "$(jq -r '.draft' "$RELEASE_JSON")" = false ]; then
      return 0
    fi
    if [ "$attempt" -lt 4 ]; then
      pause_before_retry
    fi
    attempt=$((attempt + 1))
  done
  echo "publish-immutable-github-release: release did not become public" >&2
  return 1
}

anonymous_url() {
  local encoded_name
  encoded_name="$(jq -rn --arg value "$1" '$value | @uri')"
  printf 'https://github.com/%s/releases/download/%s/%s\n' \
    "$REPOSITORY" "$TAG" "$encoded_name"
}

acquire_lock() {
  export STATE_LOCK_OWNER_DETAIL="${STATE_LOCK_OWNER_DETAIL:-immutable release ${TAG}}"
  (
    cd "$LOCK_ROOT"
    STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$TAG"
  )
  LOCK_ACQUIRED=true
}

acquire_lock

release_rc=0
refresh_public_release || release_rc=$?
if [ "$release_rc" -eq 44 ]; then
  release_rc=0
  discover_release || release_rc=$?
fi
if [ "$release_rc" -eq 44 ]; then
  create_or_discover_release
elif [ "$release_rc" -ne 0 ]; then
  echo "publish-immutable-github-release: release state is uncertain" >&2
  exit 1
fi

validate_release_identity
select_asset_set
if [ "$(jq -r '.draft' "$RELEASE_JSON")" = false ]; then
  validate_direct_tag
fi

while IFS= read -r name; do
  ensure_asset "$name"
done < <(jq -r '.[]' "$SELECTED_NAMES")

refresh_release_by_id "$(jq -er '.id' "$RELEASE_JSON")"
assert_inventory_still_allowed
assert_complete_asset_set

# Every byte is read through the authenticated release API after the complete
# set is visible and immediately before the irreversible publish transition.
while IFS= read -r name; do
  verify_authenticated_asset "$name"
done < <(jq -r '.[]' "$SELECTED_NAMES")

ensure_direct_tag
publish_and_reconcile
refresh_release_by_id "$(jq -er '.id' "$RELEASE_JSON")"
[ "$(jq -r '.draft' "$RELEASE_JSON")" = false ] || {
  echo "publish-immutable-github-release: release did not become public" >&2
  exit 1
}
assert_inventory_still_allowed
assert_complete_asset_set
validate_direct_tag

ASSET_RECEIPTS="$TMP_ROOT/asset-receipts.jsonl"
: >"$ASSET_RECEIPTS"
while IFS= read -r name; do
  declaration="$(asset_declaration "$name")"
  expected_sha="$(jq -er '.sha256' <<<"$declaration")"
  expected_bytes="$(jq -er '.bytes' <<<"$declaration")"
  asset_id="$(jq -er --arg name "$name" '.[] | select(.name == $name) | .id' \
    "$ASSETS_JSON")"
  url="$(anonymous_url "$name")"
  downloaded="$TMP_ROOT/anonymous-$name"
  if ! retry_command env -u GH_TOKEN -u GITHUB_TOKEN \
    curl --disable --fail --location --silent --show-error \
      --output "$downloaded" "$url"
  then
    echo "publish-immutable-github-release: anonymous readback failed for $name" >&2
    exit 1
  fi
  if [ "$(file_bytes "$downloaded")" != "$expected_bytes" ] ||
     [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
    echo "publish-immutable-github-release: anonymous digest readback failed for $name" >&2
    exit 1
  fi
  jq -cn --arg name "$name" --arg url "$url" --arg sha256 "$expected_sha" \
    --argjson bytes "$expected_bytes" --argjson asset_id "$asset_id" \
    '{name: $name, url: $url, sha256: $sha256, bytes: $bytes, asset_id: $asset_id}' \
    >>"$ASSET_RECEIPTS"
done < <(jq -r '.[]' "$SELECTED_NAMES")

release_id="$(jq -er '.id' "$RELEASE_JSON")"
release_state_lock

receipt_dir="$(dirname "$RECEIPT")"
mkdir -p "$receipt_dir"
receipt_tmp="$(mktemp "$receipt_dir/.immutable-release-receipt.XXXXXX")"
jq -nS \
  --arg repository "$REPOSITORY" \
  --arg tag "$TAG" \
  --arg target_commitish "$TARGET_COMMIT" \
  --argjson release_id "$release_id" \
  --slurpfile assets "$ASSET_RECEIPTS" '
    {
      schema: 1,
      status: "success",
      visibility: "public-anonymous-readback",
      repository: $repository,
      tag: $tag,
      target_commitish: $target_commitish,
      release_id: $release_id,
      immutable: true,
      assets: $assets
    }
  ' >"$receipt_tmp"
chmod 600 "$receipt_tmp"
mv "$receipt_tmp" "$RECEIPT"

echo "Published immutable release: https://github.com/${REPOSITORY}/releases/tag/${TAG}"
