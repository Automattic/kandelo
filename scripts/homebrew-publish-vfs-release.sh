#!/usr/bin/env bash
# Publish one exact browser-proven Homebrew VFS bundle as an immutable public release.
set -euo pipefail

HANDOFF=""
TAP_ROOT=""
TAP_REPOSITORY=""
TAP_NAME=""
TAP_COMMIT=""
FORMULA=""
KANDELO_COMMIT=""
ABI=""
BOTTLE_RELEASE_TAG=""
RECEIPT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --handoff) HANDOFF="$2"; shift 2 ;;
    --tap-root) TAP_ROOT="$2"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="$2"; shift 2 ;;
    --tap-name) TAP_NAME="$2"; shift 2 ;;
    --tap-commit) TAP_COMMIT="$2"; shift 2 ;;
    --formula) FORMULA="$2"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="$2"; shift 2 ;;
    --abi) ABI="$2"; shift 2 ;;
    --bottle-release-tag) BOTTLE_RELEASE_TAG="$2"; shift 2 ;;
    --receipt) RECEIPT="$2"; shift 2 ;;
    *) echo "homebrew-publish-vfs-release: unknown flag $1" >&2; exit 2 ;;
  esac
done

for required in HANDOFF TAP_ROOT TAP_REPOSITORY TAP_NAME TAP_COMMIT FORMULA KANDELO_COMMIT ABI BOTTLE_RELEASE_TAG RECEIPT; do
  if [ -z "${!required}" ]; then
    echo "homebrew-publish-vfs-release: missing ${required,,}" >&2
    exit 2
  fi
done

[ "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" = "$TAP_REPOSITORY" ] || {
  echo "homebrew-publish-vfs-release: workflow repository differs from target tap" >&2
  exit 2
}
[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || {
  echo "homebrew-publish-vfs-release: a GitHub token is required" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=.github/scripts/github-api-get.sh
. "$REPO_ROOT/.github/scripts/github-api-get.sh"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-$REPO_ROOT/.github/scripts/state-lock.sh}"
LOCK_STATE="$(mktemp)"
TMP_ROOT="$(mktemp -d)"

release_lock() {
  (
    cd "$TAP_ROOT"
    STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release
  ) || true
  rm -rf "$TMP_ROOT" "$LOCK_STATE"
}
trap release_lock EXIT

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

retry() {
  local attempt=1 delay=2
  while ! "$@"; do
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "homebrew-publish-vfs-release: command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

validator_args=(
  validate
  --handoff "$HANDOFF"
  --tap-root "$TAP_ROOT"
  --tap-repository "$TAP_REPOSITORY"
  --tap-name "$TAP_NAME"
  --tap-commit "$TAP_COMMIT"
  --formula "$FORMULA"
  --kandelo-commit "$KANDELO_COMMIT"
  --abi "$ABI"
  --bottle-release-tag "$BOTTLE_RELEASE_TAG"
)
# The credentialed finalizer treats the handoff only as inert data. The exact
# validator runs again with token variables removed before any GitHub write.
env -u GH_TOKEN -u GITHUB_TOKEN python3 "$SCRIPT_DIR/homebrew-vfs-release.py" \
  "${validator_args[@]}" >/dev/null

descriptor="$HANDOFF/kandelo-homebrew-vfs.json"
tag="$(jq -er '.release.tag' "$descriptor")"
[ "$tag" = "homebrew-vfs-sha256-$(jq -er '.image.sha256' "$descriptor")" ] || {
  echo "homebrew-publish-vfs-release: descriptor release tag is not content-addressed" >&2
  exit 2
}

export STATE_LOCK_OWNER_DETAIL="immutable Homebrew VFS ${FORMULA}/wasm32"
(
  cd "$TAP_ROOT"
  STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$tag"
)

release_json="$TMP_ROOT/release.json"
release_id=""

refresh_public_release() {
  GITHUB_API_CONTEXT=homebrew-publish-vfs-release \
    github_api_get_json "/repos/${TAP_REPOSITORY}/releases/tags/${tag}" "$release_json"
}

refresh_release() {
  [ -n "$release_id" ] || {
    echo "homebrew-publish-vfs-release: release id is unavailable" >&2
    return 2
  }
  GITHUB_API_CONTEXT=homebrew-publish-vfs-release \
    github_api_get_json "/repos/${TAP_REPOSITORY}/releases/${release_id}" "$release_json"
}

discover_draft_release() {
  local pages="$TMP_ROOT/releases-pages.json"
  local matches="$TMP_ROOT/releases-matches.json"
  fetch_release_pages() {
    gh api --paginate --slurp \
      "/repos/${TAP_REPOSITORY}/releases?per_page=100" >"$pages" &&
      jq -e 'type == "array" and all(.[]; type == "array")' "$pages" >/dev/null
  }
  retry fetch_release_pages || return 1
  jq --arg tag "$tag" '[.[][] | select(.tag_name == $tag)]' \
    "$pages" >"$matches"
  case "$(jq -r 'length' "$matches")" in
    0) return 44 ;;
    1) jq '.[0]' "$matches" >"$release_json" ;;
    *)
      echo "homebrew-publish-vfs-release: release tag resolves to multiple releases" >&2
      return 1
      ;;
  esac
}

release_rc=0
refresh_public_release || release_rc=$?
if [ "$release_rc" -eq 44 ]; then
  # GitHub's release-by-tag endpoint deliberately hides drafts. Search the
  # authenticated release list before creating anything so an interrupted
  # publication can resume from its exact draft.
  release_rc=0
  discover_draft_release || release_rc=$?
fi
if [ "$release_rc" -eq 44 ]; then
  create_json="$TMP_ROOT/create.json"
  if ! retry gh api --method POST "/repos/${TAP_REPOSITORY}/releases" \
    -f "tag_name=$tag" \
    -f "target_commitish=$TAP_COMMIT" \
    -f "name=Browser-proven Homebrew VFS ${FORMULA}" \
    -f "body=Content-addressed Kandelo Homebrew VFS image and lazy shell layer. Provenance and exact Node/Chromium acceptance evidence are attached." \
    -f make_latest=false \
    -F draft=true -F prerelease=false >"$create_json"
  then
    # A lost create response is accepted only if the exact draft is now
    # discoverable through the authenticated release list.
    release_rc=0
    discover_draft_release || release_rc=$?
  else
    cp "$create_json" "$release_json"
    release_rc=0
  fi
fi
if [ "$release_rc" -ne 0 ]; then
  echo "homebrew-publish-vfs-release: release state is uncertain" >&2
  exit 1
fi
release_id="$(jq -er '.id | select(type == "number" and . > 0)' "$release_json")"
release_rc=0
refresh_release || release_rc=$?
if [ "$release_rc" -ne 0 ]; then
  echo "homebrew-publish-vfs-release: release state is uncertain" >&2
  exit 1
fi

validate_release() {
  jq -e \
    --arg tag "$tag" \
    --arg target "$TAP_COMMIT" '
      type == "object" and
      .tag_name == $tag and
      .target_commitish == $target and
      (.id | type == "number" and . > 0) and
      .prerelease == false and
      (.draft | type == "boolean") and
      (.immutable | type == "boolean") and
      (.assets | type == "array")
    ' "$release_json" >/dev/null || {
      echo "homebrew-publish-vfs-release: existing release identity is malformed or mismatched" >&2
      return 1
    }
  if [ "$(jq -r '.draft' "$release_json")" = false ] && \
     [ "$(jq -r '.immutable' "$release_json")" != true ]; then
    echo "homebrew-publish-vfs-release: public release is not protected by GitHub immutable releases" >&2
    return 1
  fi
}
validate_release

validate_tag_target() {
  local tag_json="$TMP_ROOT/tag.json"
  GITHUB_API_CONTEXT=homebrew-publish-vfs-release \
    github_api_get_json "/repos/${TAP_REPOSITORY}/git/ref/tags/${tag}" "$tag_json"
  jq -e --arg sha "$TAP_COMMIT" --arg tag "$tag" '
    .ref == ("refs/tags/" + $tag) and
    .object.type == "commit" and .object.sha == $sha
  ' "$tag_json" >/dev/null || {
    echo "homebrew-publish-vfs-release: release tag is not a direct immutable reference to the planned tap commit" >&2
    return 1
  }
}
if [ "$(jq -r '.draft' "$release_json")" = false ]; then
  validate_tag_target
fi

expected_names="$TMP_ROOT/expected-names.json"
printf '%s\n' \
  kandelo-homebrew.vfs.zst \
  kandelo-homebrew-vfs-report.json \
  kandelo-homebrew-node-evidence.json \
  kandelo-homebrew-browser-evidence.json \
  kandelo-homebrew-vfs.json \
  kandelo-homebrew-shell-layer.zip \
  kandelo-homebrew-shell-layer.json \
  | jq -Rsc 'split("\n")[:-1] | sort' >"$expected_names"

assert_asset_names_are_bounded() {
  jq -e --slurpfile expected "$expected_names" '
    [.assets[].name] as $names |
    ($names | length) == ($names | unique | length) and
    (($names - $expected[0]) | length) == 0
  ' "$release_json" >/dev/null || {
    echo "homebrew-publish-vfs-release: release contains duplicate or unexpected assets" >&2
    return 1
  }
}
assert_asset_names_are_bounded

ensure_asset() {
  local name="$1" path="$HANDOFF/$1" expected_sha expected_bytes asset id downloaded upload_dir
  expected_sha="$(sha256_file "$path")"
  expected_bytes="$(file_bytes "$path")"
  refresh_release
  validate_release
  assert_asset_names_are_bounded
  asset="$(jq -c --arg name "$name" '[.assets[] | select(.name == $name)]' "$release_json")"
  if [ "$(jq 'length' <<<"$asset")" -gt 1 ]; then
    echo "homebrew-publish-vfs-release: duplicate immutable asset $name" >&2
    return 1
  fi
  if [ "$(jq 'length' <<<"$asset")" -eq 0 ]; then
    if [ "$(jq -r '.draft' "$release_json")" != true ]; then
      echo "homebrew-publish-vfs-release: public release is missing immutable asset $name" >&2
      return 1
    fi
    upload_dir="$TMP_ROOT/upload-$name"
    mkdir "$upload_dir"
    cp "$path" "$upload_dir/$name"
    if ! retry gh release upload "$tag" --repo "$TAP_REPOSITORY" "$upload_dir/$name"; then
      echo "homebrew-publish-vfs-release: upload response for $name was ambiguous; reconciling" >&2
    fi
    refresh_release
    validate_release
    assert_asset_names_are_bounded
    asset="$(jq -c --arg name "$name" '[.assets[] | select(.name == $name)]' "$release_json")"
  fi
  if [ "$(jq 'length' <<<"$asset")" -ne 1 ]; then
    echo "homebrew-publish-vfs-release: immutable asset $name is not uniquely visible" >&2
    return 1
  fi
  id="$(jq -er '.[0].id' <<<"$asset")"
  downloaded="$TMP_ROOT/authenticated-$name"
  retry gh api -H 'Accept: application/octet-stream' \
    "/repos/${TAP_REPOSITORY}/releases/assets/${id}" >"$downloaded"
  if [ "$(file_bytes "$downloaded")" != "$expected_bytes" ] || \
     [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
    echo "homebrew-publish-vfs-release: immutable asset $name has different bytes" >&2
    return 1
  fi
}

ensure_asset kandelo-homebrew.vfs.zst
ensure_asset kandelo-homebrew-vfs-report.json
ensure_asset kandelo-homebrew-node-evidence.json
ensure_asset kandelo-homebrew-browser-evidence.json
ensure_asset kandelo-homebrew-vfs.json
ensure_asset kandelo-homebrew-shell-layer.zip
ensure_asset kandelo-homebrew-shell-layer.json

refresh_release
validate_release
assert_asset_names_are_bounded
actual_names="$(jq -c '[.assets[].name] | sort' "$release_json")"
expected_names_value="$(jq -c . "$expected_names")"
[ "$actual_names" = "$expected_names_value" ] || {
  echo "homebrew-publish-vfs-release: draft does not contain the exact asset set" >&2
  exit 1
}

release_id="$(jq -er '.id' "$release_json")"
if [ "$(jq -r '.draft' "$release_json")" = true ]; then
  if ! retry gh api --method PATCH "/repos/${TAP_REPOSITORY}/releases/${release_id}" \
    -f make_latest=false -F draft=false -F prerelease=false >/dev/null
  then
    # Publishing may have succeeded even when the response was lost. Reconcile
    # from GitHub instead of treating an ambiguous response as proof of failure.
    echo "homebrew-publish-vfs-release: publish response was ambiguous; reconciling" >&2
  fi
fi
refresh_release
validate_release
[ "$(jq -r '.draft' "$release_json")" = false ] || {
  echo "homebrew-publish-vfs-release: release did not become public" >&2
  exit 1
}
assert_asset_names_are_bounded
[ "$(jq -c '[.assets[].name] | sort' "$release_json")" = "$expected_names_value" ] || {
  echo "homebrew-publish-vfs-release: public release does not contain the exact asset set" >&2
  exit 1
}

validate_tag_target

anonymous_manifest="$TMP_ROOT/anonymous.jsonl"
: >"$anonymous_manifest"
for name in \
  kandelo-homebrew.vfs.zst \
  kandelo-homebrew-vfs-report.json \
  kandelo-homebrew-node-evidence.json \
  kandelo-homebrew-browser-evidence.json \
  kandelo-homebrew-vfs.json \
  kandelo-homebrew-shell-layer.zip \
  kandelo-homebrew-shell-layer.json
do
  source="$HANDOFF/$name"
  downloaded="$TMP_ROOT/anonymous-$name"
  url="https://github.com/${TAP_REPOSITORY}/releases/download/${tag}/${name}"
  if ! retry env -u GH_TOKEN -u GITHUB_TOKEN \
    curl --disable --fail --location --silent --show-error \
      --output "$downloaded" "$url"
  then
    echo "homebrew-publish-vfs-release: anonymous readback request failed for $name" >&2
    exit 1
  fi
  expected_sha="$(sha256_file "$source")"
  expected_bytes="$(file_bytes "$source")"
  if [ "$(file_bytes "$downloaded")" != "$expected_bytes" ] || \
     [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
    echo "homebrew-publish-vfs-release: anonymous readback failed for $name" >&2
    exit 1
  fi
  jq -cn --arg name "$name" --arg url "$url" --arg sha256 "$expected_sha" \
    --argjson bytes "$expected_bytes" \
    '{name: $name, url: $url, sha256: $sha256, bytes: $bytes}' >>"$anonymous_manifest"
done

mkdir -p "$(dirname "$RECEIPT")"
lazy_descriptor="$HANDOFF/kandelo-homebrew-shell-layer.json"
jq -nS \
  --arg repository "$TAP_REPOSITORY" \
  --arg tag "$tag" \
  --arg tap_commit "$TAP_COMMIT" \
  --arg formula "$FORMULA" \
  --arg descriptor_url "https://github.com/${TAP_REPOSITORY}/releases/download/${tag}/kandelo-homebrew-vfs.json" \
  --arg image_url "$(jq -er '.image.url' "$descriptor")" \
  --arg image_sha256 "$(jq -er '.image.sha256' "$descriptor")" \
  --argjson image_bytes "$(jq -er '.image.bytes' "$descriptor")" \
  --arg lazy_descriptor_url "https://github.com/${TAP_REPOSITORY}/releases/download/${tag}/kandelo-homebrew-shell-layer.json" \
  --arg lazy_archive_url "$(jq -er '.archive.url' "$lazy_descriptor")" \
  --arg lazy_archive_sha256 "$(jq -er '.archive.sha256' "$lazy_descriptor")" \
  --arg lazy_archive_asset "$(jq -er '.archive.asset' "$lazy_descriptor")" \
  --argjson lazy_archive_bytes "$(jq -er '.archive.bytes' "$lazy_descriptor")" \
  --argjson lazy_archive_entries "$(jq -er '.archive.entry_count' "$lazy_descriptor")" \
  --slurpfile assets "$anonymous_manifest" '
    {
      schema: 1,
      status: "success",
      visibility: "public-anonymous-readback",
      repository: $repository,
      tag: $tag,
      tap_commit: $tap_commit,
      formula: $formula,
      arch: "wasm32",
      descriptor_url: $descriptor_url,
      image: {url: $image_url, sha256: $image_sha256, bytes: $image_bytes},
      lazy_layer: {
        descriptor_url: $lazy_descriptor_url,
        archive: {
          asset: $lazy_archive_asset,
          url: $lazy_archive_url,
          sha256: $lazy_archive_sha256,
          bytes: $lazy_archive_bytes,
          entry_count: $lazy_archive_entries
        }
      },
      assets: $assets
    }
  ' >"$RECEIPT"

echo "Published immutable Homebrew VFS descriptor: https://github.com/${TAP_REPOSITORY}/releases/download/${tag}/kandelo-homebrew-vfs.json"
echo "Published immutable Homebrew lazy layer descriptor: https://github.com/${TAP_REPOSITORY}/releases/download/${tag}/kandelo-homebrew-shell-layer.json"
