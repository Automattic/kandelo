#!/usr/bin/env bash
# Publish one validated content-addressed package generation. Public
# generations are read-only under this contract even when repository-wide
# GitHub release immutability cannot be enabled.
set -euo pipefail

BUNDLE=""
LOCK_ROOT=""
RECEIPT=""
AUTHORITY_XTASK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    --lock-root) LOCK_ROOT="$2"; shift 2 ;;
    --receipt) RECEIPT="$2"; shift 2 ;;
    --authority-xtask) AUTHORITY_XTASK="$2"; shift 2 ;;
    *) echo "publish-durable-package-generation: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$BUNDLE" ] || [ -L "$BUNDLE" ] ||
   [ ! -d "$LOCK_ROOT" ] || [ -L "$LOCK_ROOT" ] ||
   [ ! -f "$AUTHORITY_XTASK" ] || [ -L "$AUTHORITY_XTASK" ] ||
   [ ! -x "$AUTHORITY_XTASK" ] ||
   [ -z "$RECEIPT" ]; then
  echo "publish-durable-package-generation: regular bundle, lock root, and receipt are required" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-$REPO_ROOT/.github/scripts/state-lock.sh}"
RETRY_DELAY="${PACKAGE_GENERATION_RETRY_DELAY_SECONDS:-2}"
if ! [[ "$RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  echo "publish-durable-package-generation: retry delay must be non-negative" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
RELEASE_JSON="$TMP_ROOT/release.json"
ASSETS_JSON="$TMP_ROOT/assets.json"
EXPECTED_ASSETS="$TMP_ROOT/expected-assets.json"
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

# Validate inert bundle bytes before reading any field that controls a write.
env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_URL \
  -u ACTIONS_RUNTIME_TOKEN \
  PYTHONDONTWRITEBYTECODE=1 \
  python3 "$SCRIPT_DIR/package-generation.py" validate \
    --bundle "$BUNDLE" >/dev/null

MANIFEST="$BUNDLE/generation.json"
expected_ledger="$TMP_ROOT/expected-ledger.json"
validated_snapshot="$TMP_ROOT/validated-snapshot.json"
jq -S '.identity.expected_ledger' "$MANIFEST" >"$expected_ledger"
jq -S '.identity.validated_snapshot' "$MANIFEST" >"$validated_snapshot"
# WHY: hashes prove these are the promoted bytes; parsing every embedded
# archive manifest again with current authority proves they still implement
# the package ledger the manifest claims. The writer never executes source
# generation code.
env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_URL \
  -u ACTIONS_RUNTIME_TOKEN \
  "$AUTHORITY_XTASK" staging-reuse validate-archives \
    --expected-ledger "$expected_ledger" \
    --snapshot "$validated_snapshot" \
    --archives-dir "$BUNDLE" \
    --scope all

REPOSITORY="$(jq -er '.identity.repository' "$MANIFEST")"
TAG="$(jq -er '.tag' "$MANIFEST")"
TARGET_COMMIT="$(jq -er '.release.target_commitish' "$MANIFEST")"
TITLE="$(jq -er '.release.title' "$MANIFEST")"
BODY="$(jq -er '.release.body' "$MANIFEST")"

if [ "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" != "$REPOSITORY" ]; then
  echo "publish-durable-package-generation: workflow repository differs from generation repository" >&2
  exit 2
fi
if [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  echo "publish-durable-package-generation: a GitHub token is required" >&2
  exit 2
fi

# shellcheck source=/dev/null
. "$SCRIPT_DIR/github-api-get.sh"

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
  [ "$RETRY_DELAY" -eq 0 ] || sleep "$RETRY_DELAY"
}
retry_command() {
  local attempt=1
  while ! "$@"; do
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "publish-durable-package-generation: operation failed; reconciling before retry" >&2
    pause_before_retry
    attempt=$((attempt + 1))
  done
}

generation_sha="$(sha256_file "$MANIFEST")"
generation_bytes="$(file_bytes "$MANIFEST")"
index_sha="$(sha256_file "$BUNDLE/index.toml")"
index_bytes="$(file_bytes "$BUNDLE/index.toml")"
jq -S \
  --arg generation_sha "$generation_sha" \
  --argjson generation_bytes "$generation_bytes" \
  --arg index_sha "$index_sha" \
  --argjson index_bytes "$index_bytes" '
    [
      {
        name: "generation.json",
        sha256: $generation_sha,
        bytes: $generation_bytes,
        seal: true
      },
      {
        name: "index.toml",
        sha256: $index_sha,
        bytes: $index_bytes,
        seal: false
      }
    ] +
    [.identity.archives[] | {
      name: .name, sha256: .sha256, bytes: .bytes, seal: false
    }] |
    sort_by(.name)
  ' "$MANIFEST" >"$EXPECTED_ASSETS"
jq -e '
  type == "array" and length >= 3 and
  ([.[].name] | length == (unique | length)) and
  ([.[] | select(.seal == true) | .name] == ["generation.json"])
' "$EXPECTED_ASSETS" >/dev/null

validate_release_identity() {
  jq -e \
    --arg tag "$TAG" \
    --arg target "$TARGET_COMMIT" \
    --arg title "$TITLE" \
    --arg body "$BODY" '
      .tag_name == $tag and .target_commitish == $target and
      .name == $title and .body == $body and
      .prerelease == true and
      (.id | type == "number" and . > 0) and
      (.draft | type == "boolean")
    ' "$RELEASE_JSON" >/dev/null || {
    echo "publish-durable-package-generation: release identity is malformed or mismatched" >&2
    return 1
  }
}

refresh_assets() {
  local release_id pages="$TMP_ROOT/asset-pages.json"
  release_id="$(jq -er '.id' "$RELEASE_JSON")"
  gh api --paginate --slurp \
    "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" >"$pages"
  jq -e 'type == "array" and all(.[]; type == "array")' "$pages" >/dev/null
  jq '[.[][]]' "$pages" >"$ASSETS_JSON"
  # WHY: one generation may contain the bounded 256-archive closure plus its
  # resolver index and generation.json seal.
  jq -e '
    type == "array" and length <= 258 and
    all(.[]; (
      (.id | type == "number" and . > 0) and
      (.name | type == "string" and length > 0) and
      (.state | type == "string") and
      (.size | type == "number" and . >= 0) and
      ((.digest == null) or (.digest | type == "string"))
    )) and
    ([.[].id] | length == (unique | length)) and
    ([.[].name] | length == (unique | length))
  ' "$ASSETS_JSON" >/dev/null || {
    echo "publish-durable-package-generation: release asset inventory is malformed" >&2
    return 1
  }
}

refresh_release_by_id() {
  local release_id="$1"
  GITHUB_API_CONTEXT=publish-durable-package-generation \
    github_api_get_json \
      "/repos/$REPOSITORY/releases/$release_id" "$RELEASE_JSON"
  validate_release_identity
  refresh_assets
}

refresh_public_release() {
  local rc=0
  GITHUB_API_CONTEXT=publish-durable-package-generation \
    github_api_get_json \
      "/repos/$REPOSITORY/releases/tags/$TAG" "$RELEASE_JSON" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  refresh_release_by_id "$(jq -er '.id' "$RELEASE_JSON")"
}

discover_release() {
  local pages="$TMP_ROOT/release-pages.json" matches="$TMP_ROOT/release-matches.json"
  gh api --paginate --slurp "/repos/$REPOSITORY/releases?per_page=100" >"$pages"
  jq -e 'type == "array" and all(.[]; type == "array")' "$pages" >/dev/null
  jq --arg tag "$TAG" '[.[][] | select(.tag_name == $tag)]' "$pages" >"$matches"
  case "$(jq -r length "$matches")" in
    0) return 44 ;;
    1) jq '.[0]' "$matches" >"$RELEASE_JSON" ;;
    *)
      echo "publish-durable-package-generation: multiple releases use the generation tag" >&2
      return 1
      ;;
  esac
  refresh_release_by_id "$(jq -er '.id' "$RELEASE_JSON")"
}

validate_direct_tag() {
  local tag_json="$TMP_ROOT/tag.json" rc=0
  GITHUB_API_CONTEXT=publish-durable-package-generation \
    github_api_get_json \
      "/repos/$REPOSITORY/git/ref/tags/$TAG" "$tag_json" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  jq -e --arg tag "$TAG" --arg sha "$TARGET_COMMIT" '
    .ref == ("refs/tags/" + $tag) and
    .object.type == "commit" and .object.sha == $sha
  ' "$tag_json" >/dev/null || {
    echo "publish-durable-package-generation: generation tag does not directly reference the package-source SHA" >&2
    return 1
  }
}

ensure_direct_tag() {
  local rc=0
  validate_direct_tag || rc=$?
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  if [ "$rc" -ne 44 ]; then
    return 1
  fi
  gh api --method POST "/repos/$REPOSITORY/git/refs" \
    -f "ref=refs/tags/$TAG" -f "sha=$TARGET_COMMIT" >/dev/null || true
  validate_direct_tag
}

create_or_discover_release() {
  local create_json="$TMP_ROOT/create.json" rc=0 release_id
  if gh api --method POST "/repos/$REPOSITORY/releases" \
      -f "tag_name=$TAG" \
      -f "target_commitish=$TARGET_COMMIT" \
      -f "name=$TITLE" \
      -f "body=$BODY" \
      -f make_latest=false \
      -F draft=true \
      -F prerelease=true >"$create_json"
  then
    release_id="$(jq -er '.id' "$create_json")"
    refresh_release_by_id "$release_id"
    return 0
  fi
  echo "publish-durable-package-generation: release creation was ambiguous; reconciling" >&2
  discover_release || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
}

assert_inventory_allowed() {
  jq -e --slurpfile expected "$EXPECTED_ASSETS" '
    ([.[].name] - [$expected[0][].name]) | length == 0
  ' "$ASSETS_JSON" >/dev/null || {
    echo "publish-durable-package-generation: release contains an unexpected asset" >&2
    return 1
  }
  if jq -e 'any(.[]; .name == "generation.json")' "$ASSETS_JSON" >/dev/null; then
    jq -e --slurpfile expected "$EXPECTED_ASSETS" '
      ([.[].name] | sort) == ([$expected[0][].name] | sort)
    ' "$ASSETS_JSON" >/dev/null || {
      echo "publish-durable-package-generation: sealed release has an incomplete inventory" >&2
      return 1
    }
  fi
}

assert_complete_inventory() {
  jq -e --slurpfile expected "$EXPECTED_ASSETS" '
    ([.[].name] | sort) == ([$expected[0][].name] | sort)
  ' "$ASSETS_JSON" >/dev/null || {
    echo "publish-durable-package-generation: release does not contain the exact asset set" >&2
    return 1
  }
}

asset_declaration() {
  jq -ce --arg name "$1" '.[] | select(.name == $name)' "$EXPECTED_ASSETS"
}

verify_authenticated_asset() {
  local name="$1" declaration asset asset_id expected_sha expected_bytes
  local downloaded="$TMP_ROOT/authenticated-$1"
  declaration="$(asset_declaration "$name")"
  expected_sha="$(jq -er .sha256 <<<"$declaration")"
  expected_bytes="$(jq -er .bytes <<<"$declaration")"
  asset="$(jq -ce --arg name "$name" '.[] | select(.name == $name)' \
    "$ASSETS_JSON")" || {
    echo "publish-durable-package-generation: asset $name is not uniquely visible" >&2
    return 1
  }
  jq -e --arg sha "sha256:$expected_sha" --argjson bytes "$expected_bytes" '
    .state == "uploaded" and .size == $bytes and .digest == $sha
  ' <<<"$asset" >/dev/null || {
    echo "publish-durable-package-generation: asset metadata differs for $name" >&2
    return 1
  }
  asset_id="$(jq -er .id <<<"$asset")"
  download_asset() {
    gh api -H 'Accept: application/octet-stream' \
      "/repos/$REPOSITORY/releases/assets/$asset_id" >"$downloaded"
  }
  retry_command download_asset || return 1
  [ "$(file_bytes "$downloaded")" = "$expected_bytes" ] &&
    [ "$(sha256_file "$downloaded")" = "$expected_sha" ] || {
    echo "publish-durable-package-generation: authenticated bytes differ for $name" >&2
    return 1
  }
}

ensure_asset() {
  local name="$1"
  refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
  assert_inventory_allowed
  if jq -e --arg name "$name" 'any(.[]; .name == $name)' \
      "$ASSETS_JSON" >/dev/null; then
    verify_authenticated_asset "$name"
    return 0
  fi
  if [ "$(jq -r .draft "$RELEASE_JSON")" != true ]; then
    echo "publish-durable-package-generation: public generation is missing $name" >&2
    return 1
  fi
  gh release upload "$TAG" --repo "$REPOSITORY" "$BUNDLE/$name" || true
  refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
  assert_inventory_allowed
  verify_authenticated_asset "$name"
}

publish_release() {
  local release_id
  release_id="$(jq -er .id "$RELEASE_JSON")"
  if [ "$(jq -r .draft "$RELEASE_JSON")" = false ]; then
    return 0
  fi
  gh api --method PATCH "/repos/$REPOSITORY/releases/$release_id" \
    -f make_latest=false -F draft=false -F prerelease=true >/dev/null || true
  refresh_release_by_id "$release_id"
  [ "$(jq -r .draft "$RELEASE_JSON")" = false ] || {
    echo "publish-durable-package-generation: release did not become public" >&2
    return 1
  }
}

STATE_LOCK_OWNER_DETAIL="${STATE_LOCK_OWNER_DETAIL:-package generation $TAG}" \
  STATE_LOCK_STATE_FILE="$LOCK_STATE" \
  bash -c 'cd "$1" && bash "$2" acquire "$3"' \
    bash "$LOCK_ROOT" "$STATE_LOCK_SCRIPT" "$TAG"
LOCK_ACQUIRED=true

ensure_direct_tag
release_rc=0
refresh_public_release || release_rc=$?
if [ "$release_rc" -eq 44 ]; then
  release_rc=0
  discover_release || release_rc=$?
fi
if [ "$release_rc" -eq 44 ]; then
  create_or_discover_release
elif [ "$release_rc" -ne 0 ]; then
  echo "publish-durable-package-generation: release state is uncertain" >&2
  exit 1
fi

validate_release_identity
assert_inventory_allowed
if [ "$(jq -r .draft "$RELEASE_JSON")" = false ]; then
  assert_complete_inventory
fi

# Upload every transitive input before generation.json. Its presence is the
# application-level seal used to distinguish a resumable draft from a complete
# generation.
while IFS= read -r name; do
  ensure_asset "$name"
done < <(jq -r '.[] | select(.seal == false) | .name' "$EXPECTED_ASSETS")
ensure_asset generation.json

refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
assert_complete_inventory
while IFS= read -r name; do
  verify_authenticated_asset "$name"
done < <(jq -r '.[].name' "$EXPECTED_ASSETS")
validate_direct_tag
publish_release

refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
assert_complete_inventory
validate_direct_tag

asset_receipts="$TMP_ROOT/asset-receipts.jsonl"
: >"$asset_receipts"
while IFS= read -r name; do
  declaration="$(asset_declaration "$name")"
  expected_sha="$(jq -er .sha256 <<<"$declaration")"
  expected_bytes="$(jq -er .bytes <<<"$declaration")"
  url="https://github.com/$REPOSITORY/releases/download/$TAG/$name"
  downloaded="$TMP_ROOT/anonymous-$name"
  retry_command env -u GH_TOKEN -u GITHUB_TOKEN \
    curl --disable --fail --location --silent --show-error \
      --output "$downloaded" "$url" || {
    echo "publish-durable-package-generation: anonymous readback failed for $name" >&2
    exit 1
  }
  [ "$(file_bytes "$downloaded")" = "$expected_bytes" ] &&
    [ "$(sha256_file "$downloaded")" = "$expected_sha" ] || {
    echo "publish-durable-package-generation: anonymous bytes differ for $name" >&2
    exit 1
  }
  jq -cn \
    --arg name "$name" \
    --arg url "$url" \
    --arg sha256 "$expected_sha" \
    --argjson bytes "$expected_bytes" \
    '{name:$name,url:$url,sha256:$sha256,bytes:$bytes}' >>"$asset_receipts"
done < <(jq -r '.[].name' "$EXPECTED_ASSETS")

# GitHub does not enforce immutability for this repository. Re-snapshot the
# public identity after anonymous downloads so the receipt never describes an
# inventory that changed during its own verification window.
refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
[ "$(jq -r .draft "$RELEASE_JSON")" = false ] || {
  echo "publish-durable-package-generation: public release reverted to draft" >&2
  exit 1
}
assert_complete_inventory
validate_direct_tag

release_id="$(jq -er .id "$RELEASE_JSON")"
release_state_lock
receipt_dir="$(dirname "$RECEIPT")"
mkdir -p "$receipt_dir"
receipt_tmp="$(mktemp "$receipt_dir/.package-generation-receipt.XXXXXX")"
jq -nS \
  --arg repository "$REPOSITORY" \
  --arg tag "$TAG" \
  --arg target_commitish "$TARGET_COMMIT" \
  --argjson release_id "$release_id" \
  --slurpfile assets "$asset_receipts" '
    {
      schema:1,
      status:"success",
      visibility:"public-anonymous-readback",
      repository:$repository,
      tag:$tag,
      target_commitish:$target_commitish,
      release_id:$release_id,
      application_sealed:true,
      assets:$assets
    }
  ' >"$receipt_tmp"
chmod 600 "$receipt_tmp"
mv "$receipt_tmp" "$RECEIPT"

echo "Published durable package generation: https://github.com/$REPOSITORY/releases/tag/$TAG"
