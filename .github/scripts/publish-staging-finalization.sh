#!/usr/bin/env bash
# Publish a complete staging snapshot with one writer and one index update.
set -euo pipefail

TARGET_TAG=""
TARGET_SHA=""
FINAL_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-tag) TARGET_TAG="$2"; shift 2 ;;
    --target-sha) TARGET_SHA="$2"; shift 2 ;;
    --final-dir) FINAL_DIR="$2"; shift 2 ;;
    *) echo "publish-staging-finalization: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$TARGET_TAG" =~ ^pr-[1-9][0-9]*-staging$ ]] ||
   ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   [ ! -f "$FINAL_DIR/index.toml" ] ||
   [ ! -f "$FINAL_DIR/assets.json" ] ||
   [ ! -d "$FINAL_DIR/archives" ]; then
  echo "publish-staging-finalization: valid target tag/SHA and finalization directory are required" >&2
  exit 2
fi
PR_NUMBER="${TARGET_TAG#pr-}"
PR_NUMBER="${PR_NUMBER%-staging}"
if ! jq -e '
    type == "array" and
    all(.[];
      (.name | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+,-]*$")) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.size | type == "number" and . > 0 and floor == .)) and
    (map(.name) | length) == (map(.name) | unique | length)
  ' "$FINAL_DIR/assets.json" >/dev/null; then
  echo "publish-staging-finalization: final asset plan is malformed" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-.github/scripts/state-lock.sh}"
DOWNLOAD_SCRIPT="${DOWNLOAD_SCRIPT:-.github/scripts/download-verified-release-asset.sh}"
TMP_ROOT="$(mktemp -d)"
LOCK_STATE="$TMP_ROOT/state-lock.env"
LOCKED=0

cleanup() {
  if [ "$LOCKED" = 1 ]; then
    STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_size() {
  wc -c <"$1" | tr -d '[:space:]'
}

gh_retry() {
  local attempt=1 delay="${STAGING_PUBLISH_RETRY_SECONDS:-2}"
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "::warning::staging GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

ensure_release() {
  local error="$TMP_ROOT/release-view.err"
  if gh release view "$TARGET_TAG" --repo "$REPOSITORY" >/dev/null 2>"$error"; then
    return 0
  fi
  if ! grep -Eqi 'not found|HTTP 404|release does not exist' "$error"; then
    # A transient lookup is not evidence of absence. Retry the read before
    # deciding whether creation is safe.
    if gh_retry gh release view "$TARGET_TAG" --repo "$REPOSITORY" >/dev/null; then
      return 0
    fi
  fi
  if ! gh release create "$TARGET_TAG" \
      --repo "$REPOSITORY" \
      --target "$TARGET_SHA" \
      --title "$TARGET_TAG" \
      --prerelease \
      --notes "PR #${PR_NUMBER} staging build"; then
    echo "publish-staging-finalization: release creation response was ambiguous; reconciling" >&2
  fi
  gh_retry gh release view "$TARGET_TAG" --repo "$REPOSITORY" >/dev/null
}

asset_download_matches() {
  local name="$1" sha="$2" size="$3" output="$4"
  RELEASE_DOWNLOAD_RETRY_SECONDS="${STAGING_PUBLISH_RETRY_SECONDS:-2}" \
    bash "$DOWNLOAD_SCRIPT" \
      --tag "$TARGET_TAG" \
      --asset "$name" \
      --sha256 "$sha" \
      --size "$size" \
      --output "$output"
}

asset_exists() {
  local name="$1"
  gh api "/repos/$REPOSITORY/releases/tags/$TARGET_TAG" \
    --jq ".assets[] | select(.name == \"$name\") | .id" |
    grep -q '^[0-9][0-9]*$'
}

publish_immutable_archive() {
  local name="$1" sha="$2" size="$3"
  local source="$FINAL_DIR/archives/$name"
  local attempt verify
  if [ ! -f "$source" ] || [ -L "$source" ] ||
     [ "$(file_size "$source")" != "$size" ] ||
     [ "$(sha256_file "$source")" != "$sha" ]; then
    echo "publish-staging-finalization: local archive differs from plan: $name" >&2
    return 1
  fi

  for attempt in 1 2 3 4; do
    verify="$TMP_ROOT/pre-index-$attempt-$name"
    if asset_exists "$name"; then
      if asset_download_matches "$name" "$sha" "$size" "$verify"; then
        echo "publish-staging-finalization: reusing exact immutable archive $name"
        return 0
      fi
      # WHY: archive names carry package identity and a cache-key prefix.
      # Replacing different bytes under that name would make an already-read
      # index non-reproducible, so fail instead of using --clobber.
      echo "publish-staging-finalization: existing immutable archive differs from the final plan: $name" >&2
      return 1
    fi

    if ! gh release upload "$TARGET_TAG" --repo "$REPOSITORY" "$source"; then
      echo "::warning::archive upload response was ambiguous; reconciling $name" >&2
    fi
    if asset_exists "$name" &&
       asset_download_matches "$name" "$sha" "$size" "$verify"; then
      return 0
    fi
    if [ "$attempt" -lt 4 ]; then
      delay=$(( ${STAGING_PUBLISH_RETRY_SECONDS:-2} * (2 ** (attempt - 1)) ))
      sleep "$delay"
    fi
  done
  echo "publish-staging-finalization: archive was not exactly visible after retries: $name" >&2
  return 1
}

publish_index_once() {
  local source="$FINAL_DIR/index.toml" sha size attempt verify
  sha="$(sha256_file "$source")"
  size="$(file_size "$source")"
  for attempt in 1 2 3 4; do
    if ! gh release upload "$TARGET_TAG" --repo "$REPOSITORY" --clobber "$source"; then
      echo "::warning::index upload response was ambiguous; reconciling" >&2
    fi
    verify="$TMP_ROOT/index-$attempt.toml"
    if asset_download_matches index.toml "$sha" "$size" "$verify"; then
      return 0
    fi
    if [ "$attempt" -lt 4 ]; then
      delay=$(( ${STAGING_PUBLISH_RETRY_SECONDS:-2} * (2 ** (attempt - 1)) ))
      sleep "$delay"
    fi
  done
  echo "publish-staging-finalization: complete index was not visible after retries" >&2
  return 1
}

export STATE_LOCK_OWNER_DETAIL="single-writer staging finalizer, PR ${PR_NUMBER}"
STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$TARGET_TAG"
LOCKED=1
ensure_release

while IFS= read -r asset; do
  publish_immutable_archive \
    "$(jq -r .name <<<"$asset")" \
    "$(jq -r .sha256 <<<"$asset")" \
    "$(jq -r .size <<<"$asset")"
done < <(jq -c '.[]' "$FINAL_DIR/assets.json")

# The only mutable write is deliberately last: every URL in these complete
# bytes already names an uploaded, re-read archive under this target tag.
publish_index_once

# Re-read every referenced archive after index publication. This final pass
# proves the release still exposes the exact self-contained transaction, not
# merely that each individual upload once returned success.
while IFS= read -r asset; do
  name="$(jq -r .name <<<"$asset")"
  asset_download_matches \
    "$name" \
    "$(jq -r .sha256 <<<"$asset")" \
    "$(jq -r .size <<<"$asset")" \
    "$TMP_ROOT/final-$name"
done < <(jq -c '.[]' "$FINAL_DIR/assets.json")

echo "publish-staging-finalization: published and re-read complete snapshot $TARGET_TAG"
