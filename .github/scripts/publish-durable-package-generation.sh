#!/usr/bin/env bash
# Publish one validated content-addressed package generation. This common
# writer supports admitted durable generations and evidence-only preserved PR
# closures; both are application-sealed and read-only after publication.
set -euo pipefail

BUNDLE=""
LOCK_ROOT=""
RECEIPT=""
AUTHORITY_XTASK=""
SOURCE_TAG=""
PACKAGE_SOURCE_SHA=""
EXPECTED_ABI=""
SELECTION_KIND=""
ROOT_PACKAGE=""
ARCH=""
AUTHORITY_SHA=""
DEFAULT_REF=""
EXPECTED_AUTHORITY_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    --lock-root) LOCK_ROOT="$2"; shift 2 ;;
    --receipt) RECEIPT="$2"; shift 2 ;;
    --authority-xtask) AUTHORITY_XTASK="$2"; shift 2 ;;
    --source-tag) SOURCE_TAG="$2"; shift 2 ;;
    --package-source-sha) PACKAGE_SOURCE_SHA="$2"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="$2"; shift 2 ;;
    --selection-kind) SELECTION_KIND="$2"; shift 2 ;;
    --root-package) ROOT_PACKAGE="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --authority-sha) AUTHORITY_SHA="$2"; shift 2 ;;
    --default-ref) DEFAULT_REF="$2"; shift 2 ;;
    --expected-authority-sha) EXPECTED_AUTHORITY_SHA="$2"; shift 2 ;;
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
current_authority_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
authority_tree="$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')"
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
VALIDATOR_ASSETS="$TMP_ROOT/validator-assets.json"
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
GENERATION_FORMAT="$(jq -er .format "$MANIFEST")"
expected_ledger="$TMP_ROOT/expected-ledger.json"
validated_snapshot="$TMP_ROOT/validated-snapshot.json"
jq -S '.identity.expected_ledger' "$MANIFEST" >"$expected_ledger"
jq -S '.identity.validated_snapshot' "$MANIFEST" >"$validated_snapshot"
REPOSITORY="$(jq -er '.identity.repository' "$MANIFEST")"
TAG="$(jq -er '.tag' "$MANIFEST")"
TARGET_COMMIT="$(jq -er '.release.target_commitish' "$MANIFEST")"
TITLE="$(jq -er '.release.title' "$MANIFEST")"
BODY="$(jq -er '.release.body' "$MANIFEST")"
package_source_sha="$(jq -er '.identity.package_source_sha' "$MANIFEST")"
manifest_abi="$(jq -er '.identity.abi_version' "$MANIFEST")"
manifest_arch="$(jq -er '.identity.projection.arch' "$MANIFEST")"
projection_schema="$(jq -er '.identity.projection.schema' "$MANIFEST")"
PRESERVED_FORMAT="kandelo-preserved-pr-package-generation-v1"
ADMITTED_FORMAT="kandelo-package-generation-v1"
IS_PRESERVED=false

verify_authority_checkout() {
  if [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$EXPECTED_AUTHORITY_SHA" ] ||
     [ "$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')" != "$authority_tree" ] ||
     [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    echo "publish-durable-package-generation: publisher authority HEAD/tree changed" >&2
    return 1
  fi
}

if [ "$GENERATION_FORMAT" = "$PRESERVED_FORMAT" ]; then
  IS_PRESERVED=true
  if ! [[ "$EXPECTED_AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]] ||
     [ "$current_authority_sha" != "$EXPECTED_AUTHORITY_SHA" ] ||
     [ "$(jq -er .identity.authority_sha "$MANIFEST")" != "$EXPECTED_AUTHORITY_SHA" ] ||
     [ "$TARGET_COMMIT" != "$package_source_sha" ] ||
     [ -n "$SOURCE_TAG$PACKAGE_SOURCE_SHA$EXPECTED_ABI$SELECTION_KIND$ROOT_PACKAGE$ARCH$AUTHORITY_SHA$DEFAULT_REF" ]; then
    echo "publish-durable-package-generation: preserved generation differs from its publisher authority or dispatch" >&2
    exit 2
  fi
  # WHY: a preserved bundle was prepared by a separate read-only job. Before
  # trusting it for writes, bind both the manifest and executing scripts to the
  # exact clean default-branch commit selected by this workflow dispatch.
  verify_authority_checkout
elif [ "$GENERATION_FORMAT" = "$ADMITTED_FORMAT" ]; then
  if [ -n "$EXPECTED_AUTHORITY_SHA" ] ||
     ! [[ "$SOURCE_TAG" =~ ^binaries-abi-v[1-9][0-9]*$ ]] ||
     ! [[ "$PACKAGE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
     ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
     ! [[ "$ARCH" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
     ! [[ "$AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]] ||
     [ "$DEFAULT_REF" != main ] ||
     { [ "$SELECTION_KIND" != root-package ] &&
       [ "$SELECTION_KIND" != browser-inputs ]; } ||
     [ "$current_authority_sha" != "$AUTHORITY_SHA" ] ||
     [ "$AUTHORITY_SHA" != "$PACKAGE_SOURCE_SHA" ] ||
     [ "$SOURCE_TAG" != "binaries-abi-v$EXPECTED_ABI" ] ||
     [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    echo "publish-durable-package-generation: writer authority is not the exact clean activated main SHA" >&2
    exit 2
  fi
  manifest_source_tag="$(jq -er '.identity.source_activation.evidence.tag' "$MANIFEST")"
  if [ "$TARGET_COMMIT" != "$PACKAGE_SOURCE_SHA" ] ||
     [ "$package_source_sha" != "$PACKAGE_SOURCE_SHA" ] ||
     [ "$manifest_abi" != "$EXPECTED_ABI" ] ||
     [ "$manifest_arch" != "$ARCH" ] ||
     [ "$manifest_source_tag" != "$SOURCE_TAG" ]; then
    echo "publish-durable-package-generation: generation manifest differs from dispatch inputs" >&2
    exit 2
  fi
  case "$SELECTION_KIND:$projection_schema" in
    root-package:1)
      [ "$(jq -er '.identity.projection.root_package' "$MANIFEST")" = "$ROOT_PACKAGE" ] || {
        echo "publish-durable-package-generation: root-package dispatch differs from generation" >&2
        exit 2
      }
      ;;
    browser-inputs:2)
      [ "$ROOT_PACKAGE" = rootfs ] &&
        [ "$(jq -er '.identity.projection.root_set' "$MANIFEST")" = browser-inputs ] &&
        [ "$(jq -er '.identity.authority_sha' "$MANIFEST")" = "$AUTHORITY_SHA" ] || {
        echo "publish-durable-package-generation: browser-inputs dispatch differs from generation" >&2
        exit 2
      }
      ;;
    *)
      echo "publish-durable-package-generation: selection kind and projection schema disagree" >&2
      exit 2
      ;;
  esac

  manifest_projection="$TMP_ROOT/manifest-projection.json"
  rederived_projection="$TMP_ROOT/rederived-projection.json"
  rederived_expected="$TMP_ROOT/rederived-expected.json"
  jq -S '.identity.projection' "$MANIFEST" >"$manifest_projection"
  source_selection_args=()
  if [ "$SELECTION_KIND" = browser-inputs ]; then
    browser_roots_script="$REPO_ROOT/scripts/browser-binary-package-roots.mjs"
    if [ ! -f "$browser_roots_script" ] || [ -L "$browser_roots_script" ]; then
      echo "publish-durable-package-generation: exact main lacks the browser root scanner" >&2
      exit 2
    fi
    # WHY: the writer is a separate trust boundary from preparation. Rebuilding
    # architecture-scoped browser roots from its own exact-main checkout
    # prevents an internally consistent but incomplete transferred bundle from
    # becoming canonical.
    browser_root_args=(--arch "$ARCH" --exclude-package shell)
    if [ "$ARCH" = wasm32 ]; then
      browser_root_args+=(--include-package rootfs)
    fi
    env -u GH_TOKEN -u GITHUB_TOKEN \
      -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
      -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_URL \
      -u ACTIONS_RUNTIME_TOKEN \
      -u WASM_POSIX_DEPS_REGISTRY \
      node "$browser_roots_script" \
        --source-root "$REPO_ROOT" \
        "${browser_root_args[@]}" >"$TMP_ROOT/browser-inputs-roots.txt"
    source_selection_args=(
      --root-set browser-inputs
      --roots-file "$TMP_ROOT/browser-inputs-roots.txt"
    )
  else
    source_selection_args=(--root-package "$ROOT_PACKAGE")
  fi
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    -u WASM_POSIX_DEPS_REGISTRY \
    "$AUTHORITY_XTASK" staging-reuse scan-source \
      --source-root "$REPO_ROOT" \
      --expected-abi "$EXPECTED_ABI" \
      --arch "$ARCH" \
      "${source_selection_args[@]}" \
      --projection-output "$TMP_ROOT/rederived-projection.raw.json" \
      --expected-output "$TMP_ROOT/rederived-expected.raw.json"
  jq -S . "$TMP_ROOT/rederived-projection.raw.json" >"$rederived_projection"
  jq -S . "$TMP_ROOT/rederived-expected.raw.json" >"$rederived_expected"
  if ! cmp "$manifest_projection" "$rederived_projection" >/dev/null ||
     ! cmp "$expected_ledger" "$rederived_expected" >/dev/null; then
    echo "publish-durable-package-generation: transferred bundle differs from the exact-main source projection" >&2
    exit 2
  fi
else
  echo "publish-durable-package-generation: unsupported generation format" >&2
  exit 2
fi

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

verify_preserved_source_evidence() {
  [ "$IS_PRESERVED" = true ] || return 0
  # WHY: the read-only prepare job observed a mutable source. The release
  # writer must independently reconstruct that evidence using only reviewed
  # current-authority code before either irreversible publication boundary.
  bash "$SCRIPT_DIR/verify-preserved-package-source.sh" --bundle "$BUNDLE"
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
        state: "uploaded",
        size: $generation_bytes,
        digest: ("sha256:" + $generation_sha)
      },
      {
        name: "index.toml",
        state: "uploaded",
        size: $index_bytes,
        digest: ("sha256:" + $index_sha)
      }
    ] +
    [.identity.archives[] | {
      name,
      state: "uploaded",
      size: .bytes,
      digest: ("sha256:" + .sha256)
    }] |
    sort_by(.name)
  ' "$MANIFEST" >"$VALIDATOR_ASSETS"
validate_local_generation() {
  if [ "$IS_PRESERVED" = true ]; then
    env -u GH_TOKEN -u GITHUB_TOKEN \
      -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
      -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_URL \
      -u ACTIONS_RUNTIME_TOKEN \
      -u WASM_POSIX_DEPS_REGISTRY \
      "$AUTHORITY_XTASK" staging-reuse validate-archives \
        --expected-ledger "$expected_ledger" \
        --snapshot "$validated_snapshot" \
        --archives-dir "$BUNDLE" \
        --scope all \
        --expected-source-repository "https://github.com/$REPOSITORY" \
        --expected-source-commit "$package_source_sha"
    return
  fi
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    -u WASM_POSIX_DEPS_REGISTRY \
    "$AUTHORITY_XTASK" staging-reuse validate-generation \
      --expected-ledger "$expected_ledger" \
      --snapshot "$validated_snapshot" \
      --index "$BUNDLE/index.toml" \
      --assets "$VALIDATOR_ASSETS" \
      --bundle-dir "$BUNDLE" \
      --release-tag "$TAG" \
      --release-base-url "https://github.com/$REPOSITORY/releases/download/$TAG/" \
      --package-source-sha "$PACKAGE_SOURCE_SHA"
}

validate_local_generation
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
    }] +
    [(.identity.supporting_assets // [])[] | {
      name: .name, sha256: .sha256, bytes: .bytes, seal: false
    }] |
    sort_by(.name)
  ' "$MANIFEST" >"$EXPECTED_ASSETS"
jq -e '
  type == "array" and length >= 3 and
  ([.[].name] | length == (unique | length)) and
  ([.[] | select(.seal == true) | .name] == ["generation.json"])
' "$EXPECTED_ASSETS" >/dev/null

validate_live_main_source() {
  local source_release="$TMP_ROOT/live-source-release.json"
  local source_tag_ref="$TMP_ROOT/live-source-tag.json"
  local default_ref_value="$TMP_ROOT/live-default-ref.json"
  local source_commit="$TMP_ROOT/live-source-commit.json"
  local source_pages="$TMP_ROOT/live-source-asset-pages.json"
  local source_assets="$TMP_ROOT/live-source-assets.json"
  local source_evidence="$TMP_ROOT/live-source-evidence.json"
  local source_release_id
  gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" >"$source_release"
  gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" >"$source_tag_ref"
  gh api "/repos/$REPOSITORY/git/ref/heads/$DEFAULT_REF" >"$default_ref_value"
  gh api "/repos/$REPOSITORY/git/commits/$PACKAGE_SOURCE_SHA" >"$source_commit"
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    python3 "$SCRIPT_DIR/package-generation.py" main-source-evidence \
      --repository "$REPOSITORY" \
      --source-tag "$SOURCE_TAG" \
      --default-ref "$DEFAULT_REF" \
      --package-source-sha "$PACKAGE_SOURCE_SHA" \
      --release "$source_release" \
      --tag-ref "$source_tag_ref" \
      --default-ref-value "$default_ref_value" \
      --source-commit "$source_commit" \
      --output "$source_evidence"
  jq -cS '.identity.source_activation.evidence' "$MANIFEST" \
    >"$TMP_ROOT/manifest-source-evidence.json"
  cmp "$TMP_ROOT/manifest-source-evidence.json" "$source_evidence" >/dev/null || {
    echo "publish-durable-package-generation: live main activation differs from generation evidence" >&2
    return 1
  }
  [ "$(jq -er .tree_sha "$source_evidence")" = "$authority_tree" ] || {
    echo "publish-durable-package-generation: live main tree differs from writer authority" >&2
    return 1
  }
  source_release_id="$(jq -er '.id' "$source_release")"
  gh api --paginate --slurp \
    "/repos/$REPOSITORY/releases/$source_release_id/assets?per_page=100" \
    >"$source_pages"
  jq '[.[][]] | sort_by(.name) | map({name,state,size,digest})' \
    "$source_pages" >"$source_assets"
  jq -e --slurpfile manifest "$MANIFEST" '
    . as $assets |
    ($manifest[0]) as $generation |
    ([{
      name:"index.toml",
      state:"uploaded",
      size:$generation.identity.source_activation.index_bytes,
      digest:("sha256:" + $generation.identity.source_activation.index_sha256)
    }] +
    [$generation.identity.validated_snapshot.entries[] | {
      name:.asset,
      state:"uploaded",
      size,
      digest:("sha256:" + .archive_sha256)
    }]) as $wanted |
    all($wanted[];
      . as $entry |
      ([$assets[] | select(.name == $entry.name)] == [$entry])
    )
  ' "$source_assets" >/dev/null || {
    echo "publish-durable-package-generation: canonical package assets changed after preparation" >&2
    return 1
  }
  if [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$AUTHORITY_SHA" ] ||
     [ "$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')" != "$authority_tree" ] ||
     [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    echo "publish-durable-package-generation: writer authority changed during validation" >&2
    return 1
  fi
}

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
    type == "array" and length <= 266 and
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

validate_direct_tag_json() {
  local tag_json="$1"
  jq -e --arg tag "$TAG" --arg sha "$TARGET_COMMIT" '
    .ref == ("refs/tags/" + $tag) and
    .object.type == "commit" and .object.sha == $sha
  ' "$tag_json" >/dev/null || {
    echo "publish-durable-package-generation: generation tag does not directly reference its declared release target" \
      >&2
    return 1
  }
}

validate_direct_tag() {
  local tag_json="$TMP_ROOT/tag.json" rc=0
  GITHUB_API_CONTEXT=publish-durable-package-generation \
    github_api_get_json \
      "/repos/$REPOSITORY/git/ref/tags/$TAG" "$tag_json" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  validate_direct_tag_json "$tag_json"
}

wait_for_direct_tag() {
  local attempt=1 rc=0
  while true; do
    rc=0
    validate_direct_tag || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    if [ "$rc" -ne 44 ]; then
      return 1
    fi
    if [ "$attempt" -ge 4 ]; then
      echo "publish-durable-package-generation: created generation tag did not become readable" >&2
      return 1
    fi
    echo "publish-durable-package-generation: generation tag is not readable yet; retrying" >&2
    pause_before_retry
    attempt=$((attempt + 1))
  done
}

ensure_direct_tag() {
  local create_json="$TMP_ROOT/create-tag.json" rc=0
  validate_direct_tag || rc=$?
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  if [ "$rc" -ne 44 ]; then
    return 1
  fi
  if gh api --method POST "/repos/$REPOSITORY/git/refs" \
      -f "ref=refs/tags/$TAG" -f "sha=$TARGET_COMMIT" >"$create_json"; then
    validate_direct_tag_json "$create_json"
  else
    # The request may have committed even when its response was lost. Reconcile
    # through a cache-bypassing read instead of issuing a second write.
    echo "publish-durable-package-generation: tag creation was ambiguous; reconciling" >&2
  fi
  wait_for_direct_tag
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

[ "$IS_PRESERVED" = true ] || validate_live_main_source
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
refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
assert_inventory_allowed
seal_missing=false
if ! jq -e 'any(.[]; .name == "generation.json")' \
    "$ASSETS_JSON" >/dev/null; then
  seal_missing=true
fi
if [ "$IS_PRESERVED" = false ] || [ "$seal_missing" = true ]; then
  # Rehash and semantically revalidate the complete local bundle immediately
  # before the application seal can make it public.
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
  validate_local_generation
fi
if [ "$seal_missing" = true ] && [ "$IS_PRESERVED" = true ]; then
  verify_preserved_source_evidence
  verify_authority_checkout
elif [ "$IS_PRESERVED" = false ]; then
  validate_live_main_source
fi
ensure_asset generation.json

refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
assert_complete_inventory
while IFS= read -r name; do
  verify_authenticated_asset "$name"
done < <(jq -r '.[].name' "$EXPECTED_ASSETS")
validate_direct_tag
if [ "$(jq -r .draft "$RELEASE_JSON")" = true ]; then
  if [ "$IS_PRESERVED" = true ]; then
    verify_preserved_source_evidence
    verify_authority_checkout
  else
    validate_live_main_source
  fi
elif [ "$IS_PRESERVED" = false ]; then
  validate_live_main_source
fi
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

# The application seal does not rely on GitHub release immutability.
# Re-snapshot the public identity after anonymous downloads so the receipt
# never describes an inventory that changed during its own verification window.
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

echo "Published application-sealed package generation: https://github.com/$REPOSITORY/releases/tag/$TAG"
