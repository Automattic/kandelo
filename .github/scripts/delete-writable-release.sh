#!/usr/bin/env bash
set -euo pipefail

RELEASE_ID=""
TAG=""
LOCK_HELD=false
RETRY_DELAY_SECONDS="${RELEASE_DELETE_RETRY_DELAY_SECONDS:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-id)
      RELEASE_ID="$2"
      shift 2
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    --lock-held)
      LOCK_HELD=true
      shift
      ;;
    *)
      echo "delete-writable-release: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$RELEASE_ID" =~ ^[1-9][0-9]*$ ]]; then
  echo "delete-writable-release: --release-id must be positive" >&2
  exit 2
fi
if ! [[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
   [ "${#TAG}" -gt 255 ]; then
  echo "delete-writable-release: --tag must name a safe release tag" >&2
  exit 2
fi
if ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "delete-writable-release: retry delay must be non-negative" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-$SCRIPT_DIR/state-lock.sh}"
# shellcheck source=.github/scripts/github-api-get.sh
source "$SCRIPT_DIR/github-api-get.sh"

TMP_ROOT="$(mktemp -d)"
LOCK_STATE="$TMP_ROOT/state-lock.env"
ACQUIRED_LOCK=false

cleanup() {
  if [ "$ACQUIRED_LOCK" = true ]; then
    STATE_LOCK_STATE_FILE="$LOCK_STATE" \
      bash "$STATE_LOCK_SCRIPT" release || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

if [ "$LOCK_HELD" = false ]; then
  # WHY: checking a tag target and deleting it are separate GitHub API calls.
  # The same lock used by staging publication prevents a cooperating writer
  # from replacing the ref between those calls.
  export STATE_LOCK_OWNER_DETAIL="writable release cleanup, $TAG"
  STATE_LOCK_STATE_FILE="$LOCK_STATE" \
    bash "$STATE_LOCK_SCRIPT" acquire "$TAG"
  ACQUIRED_LOCK=true
fi

release_json="$TMP_ROOT/release.json"

refresh_release() {
  GITHUB_API_CONTEXT=delete-writable-release \
    GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
    github_api_get_json \
      "/repos/${REPOSITORY}/releases/${RELEASE_ID}" "$release_json"
}

release_state() {
  if ! jq -e --arg tag "$TAG" --argjson id "$RELEASE_ID" '
      .id == $id and
      .tag_name == $tag and
      (.draft | type == "boolean") and
      (.immutable | type == "boolean") and
      (.prerelease | type == "boolean") and
      ((.draft and .immutable) | not)
    ' "$release_json" >/dev/null
  then
    echo "delete-writable-release: release $TAG response is malformed or" \
      "mismatched" >&2
    return 1
  fi
  if [ "$(jq -r .immutable "$release_json")" = true ]; then
    printf 'immutable\n'
  else
    printf 'writable\n'
  fi
}

delete_release() {
  local attempt=1
  local delay="$RETRY_DELAY_SECONDS"
  local response="$TMP_ROOT/delete-response"
  local errors="$TMP_ROOT/delete-errors"
  local status rc state

  while true; do
    : > "$response"
    : > "$errors"
    if gh api --include -H 'Cache-Control: no-cache' --method DELETE \
        "/repos/${REPOSITORY}/releases/${RELEASE_ID}" \
        >"$response" 2>"$errors"; then
      status=$(sed -nE \
        '1s#^HTTP/[0-9.]+ ([0-9]{3}).*#\1#p' "$response")
      if [ "$status" = 204 ]; then
        echo "delete-writable-release: deleted release $TAG"
        return 0
      fi
      echo "delete-writable-release: release DELETE returned "\
        "unexpected HTTP ${status:-unknown}" >&2
    fi

    # WHY: a concurrent cleanup or a lost response can make DELETE report an
    # error after the intended state has already been reached. Confirm absence
    # before deciding whether the operation needs another attempt.
    rc=0
    refresh_release || rc=$?
    if [ "$rc" -eq 44 ]; then
      echo "delete-writable-release: release $TAG is already absent"
      return 0
    fi
    if [ "$rc" -eq 0 ]; then
      if ! state=$(release_state); then return 1; fi
      if [ "$state" = immutable ]; then
        echo "delete-writable-release: retaining newly immutable $TAG"
        return 42
      fi
    else
      echo "delete-writable-release: cannot confirm release $TAG state" >&2
    fi
    if [ "$attempt" -ge 4 ]; then
      cat "$errors" >&2
      echo "delete-writable-release: failed to delete release $TAG" >&2
      return 1
    fi
    cat "$errors" >&2
    echo "delete-writable-release: retrying release deletion in ${delay}s" \
      >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

read_tag_target() {
  local output="$1"
  local tag_json="$TMP_ROOT/tag.json"
  local rc=0

  GITHUB_API_CONTEXT=delete-writable-release \
    GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
    github_api_get_json \
      "/repos/${REPOSITORY}/git/ref/tags/${TAG}" "$tag_json" || rc=$?
  if [ "$rc" -eq 44 ]; then
    printf -v "$output" '%s' ""
    return 0
  fi
  [ "$rc" -eq 0 ] || return 1
  if ! jq -e --arg ref "refs/tags/$TAG" '
      .ref == $ref and
      (.object.type == "commit" or .object.type == "tag") and
      (.object.sha | type == "string" and test("^[0-9a-f]{40}$"))
    ' "$tag_json" >/dev/null
  then
    echo "delete-writable-release: tag $TAG response is malformed" >&2
    return 1
  fi
  printf -v "$output" '%s' "$(jq -r .object.sha "$tag_json")"
}

git_auth_header() {
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  [ -n "$token" ] || return 1
  printf 'AUTHORIZATION: basic %s' \
    "$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
}

git_remote() {
  local header
  if header="$(git_auth_header 2>/dev/null)"; then
    git \
      -c "http.https://github.com/.extraheader=" \
      -c "http.https://github.com/.extraheader=$header" \
      "$@"
  else
    git "$@"
  fi
}

delete_observed_tag() {
  local observed_target="$1"
  local attempt=1
  local delay="$RETRY_DELAY_SECONDS"
  local ref="refs/tags/$TAG"
  local current_target=""

  while true; do
    # WHY: GitHub's REST ref deletion has no compare-and-delete operation. A
    # force-with-lease removes only the exact ref object observed while the
    # release still existed, so a replaced tag survives cleanup.
    if git_remote push \
        --force-with-lease="$ref:$observed_target" origin ":$ref"; then
      echo "delete-writable-release: deleted tag $TAG"
      return 0
    fi
    if ! read_tag_target current_target; then
      echo "delete-writable-release: cannot confirm tag $TAG state" >&2
    elif [ -z "$current_target" ]; then
      echo "delete-writable-release: tag $TAG is already absent"
      return 0
    elif [ "$current_target" != "$observed_target" ]; then
      echo "delete-writable-release: refusing replaced tag $TAG" >&2
      return 1
    fi
    if [ "$attempt" -ge 4 ]; then
      echo "delete-writable-release: failed to delete tag $TAG" >&2
      return 1
    fi
    echo "delete-writable-release: retrying tag deletion in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

rc=0
refresh_release || rc=$?
if [ "$rc" -eq 44 ]; then
  # The ID came from bounded release discovery. If it disappeared before the
  # lock was acquired, do not risk deleting a same-named replacement tag.
  tag_target=""
  if ! read_tag_target tag_target; then
    echo "delete-writable-release: cannot determine tag $TAG state" >&2
    exit 1
  fi
  echo "delete-writable-release: release $TAG is already absent"
  if [ -n "$tag_target" ]; then
    echo "delete-writable-release: retaining unowned tag $TAG"
  fi
  exit 0
fi
if [ "$rc" -ne 0 ]; then
  echo "delete-writable-release: cannot determine release $TAG state" >&2
  exit 1
fi
if ! state=$(release_state); then exit 1; fi
if [ "$state" = immutable ]; then
  echo "delete-writable-release: retaining immutable release $TAG"
  exit 0
fi

tag_target_before=""
if ! read_tag_target tag_target_before; then
  echo "delete-writable-release: cannot determine tag $TAG state" >&2
  exit 1
fi

delete_rc=0
delete_release || delete_rc=$?
case "$delete_rc" in
  0) ;;
  42) exit 0 ;;
  *) exit "$delete_rc" ;;
esac

# A public replacement is visible through get-by-tag. A replacement draft is
# hidden there, which is why cooperating writers and this cleaner also share
# the per-tag state lock.
replacement_json="$TMP_ROOT/replacement.json"
rc=0
GITHUB_API_CONTEXT=delete-writable-release \
  GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
  github_api_get_json \
    "/repos/${REPOSITORY}/releases/tags/${TAG}" \
    "$replacement_json" || rc=$?
if [ "$rc" -eq 0 ]; then
  if ! jq -e --argjson id "$RELEASE_ID" \
      '.id == $id' "$replacement_json" >/dev/null
  then
    echo "delete-writable-release: retaining tag for a replacement release" \
      >&2
    exit 1
  fi
elif [ "$rc" -ne 44 ]; then
  echo "delete-writable-release: cannot exclude a replacement release" >&2
  exit 1
fi

tag_target_after=""
if ! read_tag_target tag_target_after; then
  echo "delete-writable-release: cannot verify tag $TAG before deletion" >&2
  exit 1
fi
if [ -z "$tag_target_after" ]; then
  echo "delete-writable-release: tag $TAG is already absent"
  exit 0
fi
if [ -z "$tag_target_before" ] ||
   [ "$tag_target_after" != "$tag_target_before" ]; then
  echo "delete-writable-release: refusing replaced tag $TAG" >&2
  exit 1
fi

delete_observed_tag "$tag_target_before"
