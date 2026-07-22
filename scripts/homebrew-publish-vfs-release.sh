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
lazy_layer_asset="kandelo-homebrew-${FORMULA}-layer.bin"
lazy_layer_descriptor_asset="kandelo-homebrew-${FORMULA}-layer.json"
lazy_descriptor="$HANDOFF/$lazy_layer_descriptor_asset"
acceptance_tag="$(jq -er '.release.tag' "$descriptor")"
[ "$acceptance_tag" = "homebrew-vfs-sha256-$(jq -er '.image.sha256' "$descriptor")" ] || {
  echo "homebrew-publish-vfs-release: descriptor release tag is not content-addressed" >&2
  exit 2
}
runtime_tag="$(jq -er '.release.tag' "$lazy_descriptor")"
[ "$runtime_tag" = "homebrew-runtime-layer-sha256-$(jq -er '.bundle.sha256' "$lazy_descriptor")" ] || {
  echo "homebrew-publish-vfs-release: lazy layer release tag is not content-addressed" >&2
  exit 2
}
[ "$runtime_tag" != "$acceptance_tag" ] || {
  echo "homebrew-publish-vfs-release: VFS and runtime layer share a release identity" >&2
  exit 2
}

acceptance_expected="$TMP_ROOT/acceptance-expected.json"
printf '%s\n' \
  kandelo-homebrew.vfs.zst \
  kandelo-homebrew-vfs-report.json \
  kandelo-homebrew-node-evidence.json \
  kandelo-homebrew-browser-evidence.json \
  kandelo-homebrew-vfs.json \
  | jq -Rsc 'split("\n")[:-1] | sort' >"$acceptance_expected"
runtime_expected="$TMP_ROOT/runtime-expected.json"
printf '%s\n' \
  "$lazy_layer_asset" \
  "$lazy_layer_descriptor_asset" \
  | jq -Rsc 'split("\n")[:-1] | sort' >"$runtime_expected"
legacy_acceptance_expected="$TMP_ROOT/legacy-acceptance-expected.json"
printf '%s\n' \
  kandelo-homebrew.vfs.zst \
  kandelo-homebrew-vfs-report.json \
  kandelo-homebrew-node-evidence.json \
  kandelo-homebrew-browser-evidence.json \
  kandelo-homebrew-vfs.json \
  "$lazy_layer_asset" \
  "$lazy_layer_descriptor_asset" \
  | jq -Rsc 'split("\n")[:-1] | sort' >"$legacy_acceptance_expected"

# Old schema-3 publications placed both lazy assets in the VFS release. They
# are immutable and cannot be removed. An existing release may retain that
# exact complete legacy name set, but new VFS releases contain only acceptance
# assets and no unknown or partial legacy set is accepted.
acceptance_allowed="$legacy_acceptance_expected"

publish_bundle() {
  local tag="$1" label="$2" title="$3" body="$4"
  local expected_names="$5" allowed_names="$6" allow_legacy="$7"
  local anonymous_manifest="$8"
  local bundle_root="$TMP_ROOT/$label" release_json="$TMP_ROOT/$label-release.json"
  local release_id="" release_rc=0 create_json selected_names="$expected_names"
  mkdir "$bundle_root"

  export STATE_LOCK_OWNER_DETAIL="immutable Homebrew ${label} ${FORMULA}/wasm32"
  (
    cd "$TAP_ROOT"
    STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" acquire "$tag"
  )

  refresh_public_release() {
    GITHUB_API_CONTEXT=homebrew-publish-vfs-release \
      github_api_get_json "/repos/${TAP_REPOSITORY}/releases/tags/${tag}" "$release_json"
  }
  refresh_release() {
    [ -n "$release_id" ] || {
      echo "homebrew-publish-vfs-release: $label release id is unavailable" >&2
      return 2
    }
    GITHUB_API_CONTEXT=homebrew-publish-vfs-release \
      github_api_get_json "/repos/${TAP_REPOSITORY}/releases/${release_id}" "$release_json"
  }
  discover_draft_release() {
    local pages="$bundle_root/releases-pages.json"
    local matches="$bundle_root/releases-matches.json"
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
        echo "homebrew-publish-vfs-release: $label tag resolves to multiple releases" >&2
        return 1
        ;;
    esac
  }
  validate_release() {
    jq -e --arg tag "$tag" --arg target "$TAP_COMMIT" '
      type == "object" and .tag_name == $tag and .target_commitish == $target and
      (.id | type == "number" and . > 0) and .prerelease == false and
      (.draft | type == "boolean") and (.immutable | type == "boolean") and
      (.assets | type == "array")
    ' "$release_json" >/dev/null || {
      echo "homebrew-publish-vfs-release: existing $label identity is malformed or mismatched" >&2
      return 1
    }
    if [ "$(jq -r '.draft' "$release_json")" = false ] && \
       [ "$(jq -r '.immutable' "$release_json")" != true ]; then
      echo "homebrew-publish-vfs-release: public release is not protected by GitHub immutable releases" >&2
      return 1
    fi
  }
  validate_tag_target() {
    local tag_json="$bundle_root/tag.json"
    GITHUB_API_CONTEXT=homebrew-publish-vfs-release \
      github_api_get_json "/repos/${TAP_REPOSITORY}/git/ref/tags/${tag}" "$tag_json"
    jq -e --arg sha "$TAP_COMMIT" --arg tag "$tag" '
      .ref == ("refs/tags/" + $tag) and
      .object.type == "commit" and .object.sha == $sha
    ' "$tag_json" >/dev/null || {
      echo "homebrew-publish-vfs-release: $label tag is not a direct immutable reference to the planned tap commit" >&2
      return 1
    }
  }
  assert_asset_names_are_bounded() {
    jq -e --argjson allow_legacy "$allow_legacy" \
      --slurpfile expected "$expected_names" --slurpfile allowed "$allowed_names" '
      [.assets[].name] as $names |
      ($names | length) == ($names | unique | length) and
      (
        (($names - $expected[0]) | length) == 0 or
        ($allow_legacy and (($names | sort) == $allowed[0]))
      )
    ' "$release_json" >/dev/null || {
      echo "homebrew-publish-vfs-release: $label release contains duplicate, unexpected, or partial legacy assets" >&2
      return 1
    }
  }
  select_asset_set() {
    local actual allowed
    actual="$(jq -c '[.assets[].name] | sort' "$release_json")"
    allowed="$(jq -c . "$allowed_names")"
    if [ "$allow_legacy" = true ] && [ "$actual" = "$allowed" ]; then
      selected_names="$allowed_names"
    else
      selected_names="$expected_names"
    fi
  }
  assert_complete_asset_set() {
    local actual expected
    actual="$(jq -c '[.assets[].name] | sort' "$release_json")"
    expected="$(jq -c . "$selected_names")"
    if [ "$actual" != "$expected" ]; then
      echo "homebrew-publish-vfs-release: $label release does not contain a complete exact asset set" >&2
      return 1
    fi
  }
  ensure_asset() {
    local name="$1" path="$HANDOFF/$1" expected_sha expected_bytes asset id downloaded upload_dir
    expected_sha="$(sha256_file "$path")"
    expected_bytes="$(file_bytes "$path")"
    refresh_release
    validate_release
    assert_asset_names_are_bounded
    asset="$(jq -c --arg name "$name" '[.assets[] | select(.name == $name)]' "$release_json")"
    if [ "$(jq 'length' <<<"$asset")" -gt 1 ]; then
      echo "homebrew-publish-vfs-release: duplicate immutable $label asset $name" >&2
      return 1
    fi
    if [ "$(jq 'length' <<<"$asset")" -eq 0 ]; then
      if [ "$(jq -r '.draft' "$release_json")" != true ]; then
        echo "homebrew-publish-vfs-release: public $label release is missing immutable asset $name" >&2
        return 1
      fi
      upload_dir="$bundle_root/upload-$name"
      mkdir "$upload_dir"
      cp "$path" "$upload_dir/$name"
      if ! retry gh release upload "$tag" --repo "$TAP_REPOSITORY" "$upload_dir/$name"; then
        echo "homebrew-publish-vfs-release: upload response for $label asset $name was ambiguous; reconciling" >&2
      fi
      refresh_release
      validate_release
      assert_asset_names_are_bounded
      asset="$(jq -c --arg name "$name" '[.assets[] | select(.name == $name)]' "$release_json")"
    fi
    if [ "$(jq 'length' <<<"$asset")" -ne 1 ]; then
      echo "homebrew-publish-vfs-release: immutable $label asset $name is not uniquely visible" >&2
      return 1
    fi
    id="$(jq -er '.[0].id' <<<"$asset")"
    downloaded="$bundle_root/authenticated-$name"
    retry gh api -H 'Accept: application/octet-stream' \
      "/repos/${TAP_REPOSITORY}/releases/assets/${id}" >"$downloaded"
    if [ "$(file_bytes "$downloaded")" != "$expected_bytes" ] || \
       [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
      echo "homebrew-publish-vfs-release: immutable $label asset $name has different bytes" >&2
      return 1
    fi
  }

  refresh_public_release || release_rc=$?
  if [ "$release_rc" -eq 44 ]; then
    release_rc=0
    discover_draft_release || release_rc=$?
  fi
  if [ "$release_rc" -eq 44 ]; then
    create_json="$bundle_root/create.json"
    if ! retry gh api --method POST "/repos/${TAP_REPOSITORY}/releases" \
      -f "tag_name=$tag" -f "target_commitish=$TAP_COMMIT" \
      -f "name=$title" -f "body=$body" -f make_latest=false \
      -F draft=true -F prerelease=false >"$create_json"
    then
      release_rc=0
      discover_draft_release || release_rc=$?
    else
      cp "$create_json" "$release_json"
      release_rc=0
    fi
  fi
  [ "$release_rc" -eq 0 ] || {
    echo "homebrew-publish-vfs-release: $label release state is uncertain" >&2
    return 1
  }
  release_id="$(jq -er '.id | select(type == "number" and . > 0)' "$release_json")"
  refresh_release
  validate_release
  assert_asset_names_are_bounded
  select_asset_set
  if [ "$(jq -r '.draft' "$release_json")" = false ]; then
    validate_tag_target
  fi

  mapfile -t expected_asset_names < <(jq -r '.[]' "$selected_names")
  for name in "${expected_asset_names[@]}"; do
    ensure_asset "$name"
  done
  refresh_release
  validate_release
  assert_asset_names_are_bounded
  assert_complete_asset_set

  if [ "$(jq -r '.draft' "$release_json")" = true ]; then
    if ! gh api --method PATCH "/repos/${TAP_REPOSITORY}/releases/${release_id}" \
      -f make_latest=false -F draft=false -F prerelease=false >/dev/null
    then
      echo "homebrew-publish-vfs-release: $label publish response was ambiguous; reconciling" >&2
    fi
  fi
  refresh_release
  validate_release
  [ "$(jq -r '.draft' "$release_json")" = false ] || {
    echo "homebrew-publish-vfs-release: $label release did not become public" >&2
    return 1
  }
  assert_asset_names_are_bounded
  assert_complete_asset_set
  validate_tag_target

  : >"$anonymous_manifest"
  for name in "${expected_asset_names[@]}"; do
    local source="$HANDOFF/$name" downloaded="$bundle_root/anonymous-$name"
    local url="https://github.com/${TAP_REPOSITORY}/releases/download/${tag}/${name}"
    local expected_sha expected_bytes
    if ! retry env -u GH_TOKEN -u GITHUB_TOKEN \
      curl --disable --fail --location --silent --show-error \
        --output "$downloaded" "$url"
    then
      echo "homebrew-publish-vfs-release: anonymous $label readback failed for $name" >&2
      return 1
    fi
    expected_sha="$(sha256_file "$source")"
    expected_bytes="$(file_bytes "$source")"
    if [ "$(file_bytes "$downloaded")" != "$expected_bytes" ] || \
       [ "$(sha256_file "$downloaded")" != "$expected_sha" ]; then
      echo "homebrew-publish-vfs-release: anonymous $label digest readback failed for $name" >&2
      return 1
    fi
    jq -cn --arg name "$name" --arg url "$url" --arg sha256 "$expected_sha" \
      --argjson bytes "$expected_bytes" \
      '{name: $name, url: $url, sha256: $sha256, bytes: $bytes}' \
      >>"$anonymous_manifest"
  done

  (
    cd "$TAP_ROOT"
    STATE_LOCK_STATE_FILE="$LOCK_STATE" bash "$STATE_LOCK_SCRIPT" release
  )
}

acceptance_manifest="$TMP_ROOT/acceptance-anonymous.jsonl"
runtime_manifest="$TMP_ROOT/runtime-anonymous.jsonl"
publish_bundle \
  "$acceptance_tag" acceptance \
  "Browser-proven Homebrew VFS ${FORMULA}" \
  "Content-addressed Kandelo Homebrew VFS image with exact Node and Chromium evidence." \
  "$acceptance_expected" "$acceptance_allowed" true "$acceptance_manifest"
publish_bundle \
  "$runtime_tag" runtime-layer \
  "Bottle-backed Homebrew runtime layer ${FORMULA}" \
  "Closed lazy runtime-layer bundle bound to its base shell, bottle provenance, payload inventory, and exact acceptance evidence." \
  "$runtime_expected" "$runtime_expected" false "$runtime_manifest"

mkdir -p "$(dirname "$RECEIPT")"
lazy_descriptor="$HANDOFF/$lazy_layer_descriptor_asset"
jq -nS \
  --arg repository "$TAP_REPOSITORY" \
  --arg tag "$acceptance_tag" \
  --arg runtime_tag "$runtime_tag" \
  --arg tap_commit "$TAP_COMMIT" \
  --arg formula "$FORMULA" \
  --arg descriptor_url "https://github.com/${TAP_REPOSITORY}/releases/download/${acceptance_tag}/kandelo-homebrew-vfs.json" \
  --arg image_url "$(jq -er '.image.url' "$descriptor")" \
  --arg image_sha256 "$(jq -er '.image.sha256' "$descriptor")" \
  --argjson image_bytes "$(jq -er '.image.bytes' "$descriptor")" \
  --arg lazy_descriptor_url "https://github.com/${TAP_REPOSITORY}/releases/download/${runtime_tag}/${lazy_layer_descriptor_asset}" \
  --arg lazy_payload_url "$(jq -er '
    [.deferred_trees[0].transports[] | select(.kind == "bundle-release")] |
    if length == 1 then .[0].url else error("missing bundle release transport") end
  ' "$lazy_descriptor")" \
  --arg lazy_payload_sha256 "$(jq -er '.deferred_trees[0].content.sha256' "$lazy_descriptor")" \
  --arg lazy_payload_asset "$lazy_layer_asset" \
  --arg lazy_payload_decoder "$(jq -er '.deferred_trees[0].content.decoder' "$lazy_descriptor")" \
  --arg lazy_payload_media_type "$(jq -er '.deferred_trees[0].content.media_type' "$lazy_descriptor")" \
  --argjson lazy_payload_bytes "$(jq -er '.deferred_trees[0].content.bytes' "$lazy_descriptor")" \
  --argjson lazy_payload_entries "$(jq -er '.deferred_trees[0].inventory.entry_count' "$lazy_descriptor")" \
  --slurpfile acceptance_assets "$acceptance_manifest" \
  --slurpfile assets "$runtime_manifest" '
    {
      schema: 2,
      status: "success",
      visibility: "public-anonymous-readback",
      repository: $repository,
      tag: $tag,
      acceptance_release: {tag: $tag, descriptor_url: $descriptor_url},
      tap_commit: $tap_commit,
      formula: $formula,
      arch: "wasm32",
      descriptor_url: $descriptor_url,
      image: {url: $image_url, sha256: $image_sha256, bytes: $image_bytes},
      lazy_layer: {
        release_tag: $runtime_tag,
        descriptor_url: $lazy_descriptor_url,
        deferred_trees: [{
          content: {
            media_type: $lazy_payload_media_type,
            decoder: $lazy_payload_decoder,
            sha256: $lazy_payload_sha256,
            bytes: $lazy_payload_bytes
          },
          transport: {
            kind: "bundle-release",
            asset: $lazy_payload_asset,
            url: $lazy_payload_url
          },
          entry_count: $lazy_payload_entries
        }]
      },
      acceptance_assets: $acceptance_assets,
      assets: $assets
    }
  ' >"$RECEIPT"

echo "Published immutable Homebrew VFS descriptor: https://github.com/${TAP_REPOSITORY}/releases/download/${acceptance_tag}/kandelo-homebrew-vfs.json"
echo "Published immutable Homebrew lazy layer descriptor: https://github.com/${TAP_REPOSITORY}/releases/download/${runtime_tag}/${lazy_layer_descriptor_asset}"
