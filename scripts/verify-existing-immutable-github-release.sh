#!/usr/bin/env bash
# Verify one already-public immutable GitHub Release without mutating it.
set -euo pipefail

MANIFEST=""
ASSET_ROOT=""
RECEIPT=""
EXACT_TARGET_COMMIT_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --asset-root) ASSET_ROOT="$2"; shift 2 ;;
    --receipt) RECEIPT="$2"; shift 2 ;;
    --exact-target-commit-sha) EXACT_TARGET_COMMIT_SHA="$2"; shift 2 ;;
    *)
      echo "verify-existing-immutable-github-release: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

for required in MANIFEST ASSET_ROOT RECEIPT; do
  if [ -z "${!required}" ]; then
    echo "verify-existing-immutable-github-release: missing ${required,,}" >&2
    exit 2
  fi
done
if ! [[ "$EXACT_TARGET_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "verify-existing-immutable-github-release: --exact-target-commit-sha must be one lowercase 40-character SHA" >&2
  exit 2
fi
[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || {
  echo "verify-existing-immutable-github-release: a GitHub token is required for read-only metadata queries" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RETRY_DELAY="${IMMUTABLE_RELEASE_RETRY_DELAY_SECONDS:-2}"
if ! [[ "$RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  echo "verify-existing-immutable-github-release: retry delay must be non-negative" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
NORMALIZED_MANIFEST="$TMP_ROOT/manifest.json"
STAGED_ASSETS="$TMP_ROOT/assets"
RELEASE_JSON="$TMP_ROOT/release.json"
ASSETS_JSON="$TMP_ROOT/assets.json"
ASSET_RECEIPTS="$TMP_ROOT/asset-receipts.jsonl"
trap 'rm -rf "$TMP_ROOT"' EXIT

# WHY: the local mirror handoff is inert evidence. Normalize and stage it with
# credentials removed before any authenticated metadata read, so a malformed
# handoff cannot influence how the token-bearing process selects a release.
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
if [ "$TARGET_COMMIT" != "$EXACT_TARGET_COMMIT_SHA" ]; then
  echo "verify-existing-immutable-github-release: manifest target differs from the admitted release authority" >&2
  exit 2
fi
[ "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" = "$REPOSITORY" ] ||
  [ "${GITHUB_REPOSITORY,,}" = "$REPOSITORY" ] || {
  echo "verify-existing-immutable-github-release: workflow repository differs from release repository" >&2
  exit 2
}

# The consume-only lane accepts exactly the preferred collection. Supporting a
# legacy or partial asset set here could make an old release appear equivalent
# to the mirror that the current sealed shell re-derived.
jq -e '.accepted_existing_asset_sets == []' \
  "$NORMALIZED_MANIFEST" >/dev/null || {
  echo "verify-existing-immutable-github-release: existing mirror manifest must require its preferred asset set" >&2
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
    echo "verify-existing-immutable-github-release: read failed; retrying: $*" >&2
    pause_before_retry
    attempt=$((attempt + 1))
  done
}

fetch_paginated_arrays() {
  local endpoint="$1" output="$2"
  local attempt=1 temporary="$TMP_ROOT/pages-$RANDOM.json"
  while true; do
    if gh api --paginate --slurp "$endpoint" >"$temporary" &&
       jq -e 'type == "array" and all(.[]; type == "array")' \
         "$temporary" >/dev/null
    then
      jq '[.[][]]' "$temporary" >"$output"
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      echo "verify-existing-immutable-github-release: release asset pagination remained uncertain" >&2
      return 1
    fi
    pause_before_retry
    attempt=$((attempt + 1))
  done
}

GITHUB_API_CONTEXT=verify-existing-immutable-github-release \
  github_api_get_json \
    "/repos/${REPOSITORY}/releases/tags/${TAG}" "$RELEASE_JSON" || {
  echo "verify-existing-immutable-github-release: admitted immutable release is unavailable" >&2
  exit 1
}

jq -e \
  --arg tag "$TAG" \
  --arg target "$TARGET_COMMIT" \
  --arg title "$TITLE" \
  --arg body "$BODY" '
  type == "object" and
  .tag_name == $tag and .target_commitish == $target and
  .name == $title and .body == $body and
  (.id | type == "number" and . > 0) and
  .draft == false and .prerelease == false and .immutable == true
' "$RELEASE_JSON" >/dev/null || {
  echo "verify-existing-immutable-github-release: existing release identity is malformed, mutable, or mismatched" >&2
  exit 1
}

release_id="$(jq -er '.id' "$RELEASE_JSON")"
fetch_paginated_arrays \
  "/repos/${REPOSITORY}/releases/${release_id}/assets?per_page=100" \
  "$ASSETS_JSON"
jq -e '
  type == "array" and length <= 256 and
  all(.[];
    type == "object" and
    (.id | type == "number" and . > 0) and
    (.name | type == "string" and length > 0) and
    .state == "uploaded" and
    (.size | type == "number" and . > 0) and
    (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))) and
  ([.[].id] | length == (unique | length)) and
  ([.[].name] | length == (unique | length))
' "$ASSETS_JSON" >/dev/null || {
  echo "verify-existing-immutable-github-release: release asset metadata is malformed" >&2
  exit 1
}

actual_names="$(jq -c '[.[].name] | sort' "$ASSETS_JSON")"
expected_names="$(jq -c '.preferred_asset_names | sort' "$NORMALIZED_MANIFEST")"
if [ "$actual_names" != "$expected_names" ]; then
  echo "verify-existing-immutable-github-release: release asset inventory differs from the exact mirror" >&2
  exit 1
fi

tag_json="$TMP_ROOT/tag.json"
GITHUB_API_CONTEXT=verify-existing-immutable-github-release \
  github_api_get_json \
    "/repos/${REPOSITORY}/git/ref/tags/${TAG}" "$tag_json" || {
  echo "verify-existing-immutable-github-release: exact release tag is unavailable" >&2
  exit 1
}
jq -e --arg tag "$TAG" --arg target "$TARGET_COMMIT" '
  .ref == ("refs/tags/" + $tag) and
  .object.type == "commit" and .object.sha == $target
' "$tag_json" >/dev/null || {
  echo "verify-existing-immutable-github-release: release tag does not directly name its admitted authority" >&2
  exit 1
}

anonymous_url() {
  local encoded_name
  encoded_name="$(jq -rn --arg value "$1" '$value | @uri')"
  printf 'https://github.com/%s/releases/download/%s/%s\n' \
    "$REPOSITORY" "$TAG" "$encoded_name"
}

: >"$ASSET_RECEIPTS"
while IFS= read -r name; do
  declaration="$(jq -ce --arg name "$name" \
    '.assets[] | select(.name == $name)' "$NORMALIZED_MANIFEST")"
  expected_sha="$(jq -er '.sha256' <<<"$declaration")"
  expected_bytes="$(jq -er '.bytes' <<<"$declaration")"
  remote="$(jq -ce --arg name "$name" \
    '.[] | select(.name == $name)' "$ASSETS_JSON")" || {
    echo "verify-existing-immutable-github-release: asset $name is not uniquely visible" >&2
    exit 1
  }
  asset_id="$(jq -er '.id' <<<"$remote")"
  jq -e --arg digest "sha256:${expected_sha}" \
    --argjson bytes "$expected_bytes" '
    .state == "uploaded" and .size == $bytes and .digest == $digest
  ' <<<"$remote" >/dev/null || {
    echo "verify-existing-immutable-github-release: asset $name metadata differs from the exact mirror" >&2
    exit 1
  }

  url="$(anonymous_url "$name")"
  downloaded="$TMP_ROOT/anonymous-$asset_id"
  if ! retry_command env -u GH_TOKEN -u GITHUB_TOKEN \
    curl --disable --fail --location --silent --show-error \
      --output "$downloaded" "$url"
  then
    echo "verify-existing-immutable-github-release: anonymous readback failed for $name" >&2
    exit 1
  fi
  if [ "$(file_bytes "$downloaded")" != "$expected_bytes" ] ||
     [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
    echo "verify-existing-immutable-github-release: anonymous digest readback failed for $name" >&2
    exit 1
  fi
  jq -cn \
    --arg name "$name" \
    --arg url "$url" \
    --arg sha256 "$expected_sha" \
    --argjson bytes "$expected_bytes" \
    --argjson asset_id "$asset_id" \
    '{name: $name, url: $url, sha256: $sha256, bytes: $bytes, asset_id: $asset_id}' \
    >>"$ASSET_RECEIPTS"
done < <(jq -r '.preferred_asset_names[]' "$NORMALIZED_MANIFEST")

receipt_dir="$(dirname "$RECEIPT")"
mkdir -p "$receipt_dir"
receipt_tmp="$(mktemp "$receipt_dir/.immutable-release-verification.XXXXXX")"
jq -nS \
  --arg repository "$REPOSITORY" \
  --arg tag "$TAG" \
  --arg target_commitish "$TARGET_COMMIT" \
  --argjson release_id "$release_id" \
  --slurpfile assets "$ASSET_RECEIPTS" '
  {
    schema: 1,
    status: "success",
    operation: "verified-existing",
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

echo "Verified existing immutable release: https://github.com/${REPOSITORY}/releases/tag/${TAG}"
