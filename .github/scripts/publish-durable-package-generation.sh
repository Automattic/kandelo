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
PRODUCER_SHA=""
PRODUCER_ROOT=""
VALIDATED_MAIN_SHA=""
VALIDATION_METHOD=""
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
    --producer-sha) PRODUCER_SHA="$2"; shift 2 ;;
    --producer-root) PRODUCER_ROOT="$2"; shift 2 ;;
    --validated-main-sha) VALIDATED_MAIN_SHA="$2"; shift 2 ;;
    --validation-method) VALIDATION_METHOD="$2"; shift 2 ;;
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
legacy_dispatch=false
v2_dispatch=false
preserved_dispatch=false
if [[ "$PACKAGE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] &&
   [ -z "$PRODUCER_SHA" ] && [ -z "$VALIDATED_MAIN_SHA" ]; then
  legacy_dispatch=true
elif [ -z "$PACKAGE_SOURCE_SHA" ] &&
     [[ "$PRODUCER_SHA" =~ ^[0-9a-f]{40}$ ]] &&
     [[ "$VALIDATED_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]] &&
     [[ "$VALIDATION_METHOD" =~ ^(identical-git-tree-v1|identical-package-cache-projection-v1)$ ]]; then
  v2_dispatch=true
elif [[ "$EXPECTED_AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]] &&
     [ -z "$SOURCE_TAG$PACKAGE_SOURCE_SHA$PRODUCER_SHA$PRODUCER_ROOT" ] &&
     [ -z "$VALIDATED_MAIN_SHA$VALIDATION_METHOD$EXPECTED_ABI" ] &&
     [ -z "$SELECTION_KIND$ROOT_PACKAGE$ARCH$AUTHORITY_SHA$DEFAULT_REF" ]; then
  preserved_dispatch=true
else
  echo "publish-durable-package-generation: exactly one complete admitted or preserved provenance mode is required" >&2
  exit 2
fi
if [ "$preserved_dispatch" = false ] &&
   { ! [[ "$SOURCE_TAG" =~ ^(binaries-abi-v[1-9][0-9]*|pr-[1-9][0-9]*-staging|preserved-package-generation-[A-Za-z0-9._-]+)$ ]] ||
     ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
     ! [[ "$ARCH" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
     ! [[ "$AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]] ||
     [ "$DEFAULT_REF" != main ] ||
     { [ "$SELECTION_KIND" != root-package ] &&
       [ "$SELECTION_KIND" != browser-inputs ]; }; }; then
  echo "publish-durable-package-generation: admitted dispatch metadata is incomplete" >&2
  exit 2
fi
if [ "$v2_dispatch" = true ] &&
   [ "$VALIDATION_METHOD" = identical-package-cache-projection-v1 ] &&
   ! [[ "$SOURCE_TAG" =~ ^preserved-package-generation- ]]; then
  echo "publish-durable-package-generation: cache-projection admission requires the exact published preserved-generation tag" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
authority_tree="$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')"
writer_authority_sha="$AUTHORITY_SHA"
[ "$preserved_dispatch" = false ] || writer_authority_sha="$EXPECTED_AUTHORITY_SHA"
if [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$writer_authority_sha" ] ||
   [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "publish-durable-package-generation: writer authority is not the exact clean workflow SHA" >&2
  exit 2
fi
if [ "$v2_dispatch" = true ]; then
  producer_tree="$authority_tree"
  if [ "$VALIDATION_METHOD" = identical-package-cache-projection-v1 ]; then
    if [ ! -d "$PRODUCER_ROOT" ] || [ -L "$PRODUCER_ROOT" ]; then
      echo "publish-durable-package-generation: cache projection requires an inert producer checkout" >&2
      exit 2
    fi
    producer_tree="$(git -C "$PRODUCER_ROOT" rev-parse 'HEAD^{tree}')"
    if [ "$(git -C "$PRODUCER_ROOT" rev-parse HEAD)" != "$PRODUCER_SHA" ] ||
       [ -n "$(git -C "$PRODUCER_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
      echo "publish-durable-package-generation: producer checkout differs from the cache-projection producer" >&2
      exit 2
    fi
  fi
fi
if { [ "$legacy_dispatch" = true ] &&
     { [ "$AUTHORITY_SHA" != "$PACKAGE_SOURCE_SHA" ] ||
       [ "$SOURCE_TAG" != "binaries-abi-v$EXPECTED_ABI" ]; }; } ||
   { [ "$v2_dispatch" = true ] &&
     { [ "$AUTHORITY_SHA" != "$VALIDATED_MAIN_SHA" ] ||
       { [[ "$SOURCE_TAG" =~ ^binaries-abi-v ]] &&
         [ "$SOURCE_TAG" != "binaries-abi-v$EXPECTED_ABI" ]; }; }; }; then
  echo "publish-durable-package-generation: writer authority, source tag, and dispatch provenance disagree" >&2
  exit 2
fi
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
expected_ledger="$TMP_ROOT/expected-ledger.json"
validated_snapshot="$TMP_ROOT/validated-snapshot.json"
jq -S '.identity.expected_ledger' "$MANIFEST" >"$expected_ledger"
jq -S '.identity.validated_snapshot' "$MANIFEST" >"$validated_snapshot"
REPOSITORY="$(jq -er '.identity.repository' "$MANIFEST")"
TAG="$(jq -er '.tag' "$MANIFEST")"
TARGET_COMMIT="$(jq -er '.release.target_commitish' "$MANIFEST")"
TITLE="$(jq -er '.release.title' "$MANIFEST")"
BODY="$(jq -er '.release.body' "$MANIFEST")"
manifest_abi="$(jq -er '.identity.abi_version' "$MANIFEST")"
manifest_arch="$(jq -er '.identity.projection.arch' "$MANIFEST")"
projection_schema="$(jq -er '.identity.projection.schema' "$MANIFEST")"
manifest_format="$(jq -er '.format' "$MANIFEST")"
IS_PRESERVED=false
if [ "$preserved_dispatch" = true ]; then
  IS_PRESERVED=true
  if [ "$manifest_format" != kandelo-preserved-pr-package-generation-v1 ] ||
     [ "$(jq -er .identity.authority_sha "$MANIFEST")" != "$EXPECTED_AUTHORITY_SHA" ] ||
     [ "$(jq -er .identity.admission "$MANIFEST")" != none ] ||
     [ "$TARGET_COMMIT" != "$(jq -er .identity.package_source_sha "$MANIFEST")" ]; then
    echo "publish-durable-package-generation: preserved generation differs from dispatch authority" >&2
    exit 2
  fi
  ARCHIVE_PRODUCER_SHA="$(jq -er .identity.package_source_sha "$MANIFEST")"
  archive_source_args=(--package-source-sha "$ARCHIVE_PRODUCER_SHA")
else
manifest_source_tag="$(jq -er '
  if .format == "kandelo-package-generation-v1"
  then .identity.source_activation.evidence.tag
  else .identity.producer.evidence.tag
  end
' "$MANIFEST")"
if [ "$manifest_abi" != "$EXPECTED_ABI" ] ||
   [ "$manifest_arch" != "$ARCH" ] ||
   [ "$manifest_source_tag" != "$SOURCE_TAG" ]; then
  echo "publish-durable-package-generation: generation manifest differs from dispatch inputs" >&2
  exit 2
fi
if [ "$legacy_dispatch" = true ]; then
  if [ "$manifest_format" != kandelo-package-generation-v1 ] ||
     [ "$TARGET_COMMIT" != "$PACKAGE_SOURCE_SHA" ]; then
    echo "publish-durable-package-generation: v1 generation differs from dispatch provenance" >&2
    exit 2
  fi
  ARCHIVE_PRODUCER_SHA="$PACKAGE_SOURCE_SHA"
  generation_source_field=source_activation
else
  # WHY: the generation release belongs to reviewed main M, but the archive
  # validator must compare embedded build commits to the actual producer S.
  if [ "$manifest_format" != kandelo-package-generation-v2 ] ||
     [ "$TARGET_COMMIT" != "$VALIDATED_MAIN_SHA" ] ||
     [ "$(jq -er '.identity.producer.evidence.producer_sha' "$MANIFEST")" != "$PRODUCER_SHA" ] ||
     [ "$(jq -er '.identity.validated_against_main.commit' "$MANIFEST")" != "$VALIDATED_MAIN_SHA" ] ||
     [ "$(jq -er '.identity.validated_against_main.method' "$MANIFEST")" != "$VALIDATION_METHOD" ]; then
    echo "publish-durable-package-generation: v2 generation differs from dispatch provenance" >&2
    exit 2
  fi
  ARCHIVE_PRODUCER_SHA="$PRODUCER_SHA"
  generation_source_field=producer
fi
if [ "$(jq -er '.identity.authority_sha' "$MANIFEST")" != "$AUTHORITY_SHA" ]; then
  echo "publish-durable-package-generation: manifest authority differs from the writer" >&2
  exit 2
fi
archive_source_args=(--package-source-sha "$ARCHIVE_PRODUCER_SHA")
# WHY: the existing validator's legacy flag means "the exact commit embedded
# in every selected archive." For v2 that truthful archive producer is H/S,
# even though validated current main M remains publication authority.
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
  if [ "$VALIDATION_METHOD" = identical-package-cache-projection-v1 ]; then
    env -u GH_TOKEN -u GITHUB_TOKEN \
      -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
      -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_URL \
      -u ACTIONS_RUNTIME_TOKEN \
      -u WASM_POSIX_DEPS_REGISTRY \
      node "$browser_roots_script" \
        --source-root "$PRODUCER_ROOT" \
        "${browser_root_args[@]}" \
        >"$TMP_ROOT/producer-browser-inputs-roots.txt"
    cmp "$TMP_ROOT/browser-inputs-roots.txt" \
      "$TMP_ROOT/producer-browser-inputs-roots.txt" >/dev/null || {
      echo "publish-durable-package-generation: producer and current main browser package roots differ" >&2
      exit 2
    }
  fi
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
    --expected-output "$TMP_ROOT/rederived-expected.raw.json" \
    --components-output "$TMP_ROOT/rederived-components.raw.json"
jq -S . "$TMP_ROOT/rederived-projection.raw.json" >"$rederived_projection"
jq -S . "$TMP_ROOT/rederived-expected.raw.json" >"$rederived_expected"
if ! cmp "$manifest_projection" "$rederived_projection" >/dev/null ||
   ! cmp "$expected_ledger" "$rederived_expected" >/dev/null; then
  echo "publish-durable-package-generation: transferred bundle differs from the exact-main source projection" >&2
  exit 2
fi
if [ "$VALIDATION_METHOD" = identical-package-cache-projection-v1 ]; then
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    -u WASM_POSIX_DEPS_REGISTRY \
    "$AUTHORITY_XTASK" staging-reuse scan-source \
      --source-root "$PRODUCER_ROOT" \
      --expected-abi "$EXPECTED_ABI" \
      --arch "$ARCH" \
      "${source_selection_args[@]}" \
      --projection-output "$TMP_ROOT/producer-projection.raw.json" \
      --expected-output "$TMP_ROOT/producer-expected.raw.json" \
      --components-output "$TMP_ROOT/producer-components.raw.json"
  jq -S . "$TMP_ROOT/producer-projection.raw.json" \
    >"$TMP_ROOT/producer-projection.json"
  jq -S . "$TMP_ROOT/producer-expected.raw.json" \
    >"$TMP_ROOT/producer-expected.json"
  jq -S . "$TMP_ROOT/producer-components.raw.json" \
    >"$TMP_ROOT/producer-components.json"
  jq -S . "$TMP_ROOT/rederived-components.raw.json" \
    >"$TMP_ROOT/rederived-components.json"
  if ! cmp "$rederived_projection" \
       "$TMP_ROOT/producer-projection.json" >/dev/null ||
     ! cmp "$rederived_expected" \
       "$TMP_ROOT/producer-expected.json" >/dev/null ||
     ! cmp "$TMP_ROOT/rederived-components.json" \
       "$TMP_ROOT/producer-components.json" >/dev/null; then
    echo "publish-durable-package-generation: producer and current-main selected package build inputs differ" >&2
    exit 2
  fi
fi
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

verify_authority_checkout() {
  local expected="$AUTHORITY_SHA"
  [ "$IS_PRESERVED" = false ] || expected="$EXPECTED_AUTHORITY_SHA"
  if [ "$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" != "$expected" ] ||
     [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    echo "publish-durable-package-generation: publisher authority HEAD/tree changed" >&2
    return 1
  fi
}

verify_producer_checkout() {
  if [ "$VALIDATION_METHOD" = identical-package-cache-projection-v1 ] &&
     { [ "$(git -C "$PRODUCER_ROOT" rev-parse HEAD)" != "$PRODUCER_SHA" ] ||
       [ "$(git -C "$PRODUCER_ROOT" rev-parse 'HEAD^{tree}')" != "$producer_tree" ] ||
       [ -n "$(git -C "$PRODUCER_ROOT" status --porcelain=v1 --untracked-files=all)" ]; }; then
    echo "publish-durable-package-generation: producer checkout changed" >&2
    return 1
  fi
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
    "${archive_source_args[@]}"
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

require_pr_staging_retention() {
  local pr_number pr_json="$TMP_ROOT/retained-source-pr.json"
  if [[ "$SOURCE_TAG" =~ ^pr-([1-9][0-9]*)-staging$ ]]; then
    pr_number="${BASH_REMATCH[1]}"
    gh api "/repos/$REPOSITORY/pulls/$pr_number" >"$pr_json"
    # WHY: this workflow runs after merge, when ordinary close-event cleanup
    # would otherwise be free to delete the source halfway through a publish.
    jq -e --argjson number "$pr_number" '
      .number == $number and .state == "closed" and
      .merged_at != null and
      any(.labels[]?; .name == "retain-package-staging")
    ' "$pr_json" >/dev/null || {
      echo "publish-durable-package-generation: PR staging source is not retained for post-merge promotion" >&2
      return 1
    }
  fi
}

capture_live_main_source_snapshot() {
  local prefix="$1"
  local source_release="$TMP_ROOT/$prefix-source-release.json"
  local source_tag_ref="$TMP_ROOT/$prefix-source-tag.json"
  local default_ref_value="$TMP_ROOT/$prefix-main-ref.json"
  local producer_commit="$TMP_ROOT/$prefix-producer-commit.json"
  local main_commit="$TMP_ROOT/$prefix-main-commit.json"
  local source_pages="$TMP_ROOT/$prefix-source-asset-pages.json"
  local source_assets="$TMP_ROOT/$prefix-source-assets.json"
  local snapshot="$TMP_ROOT/$prefix-source-snapshot.json"
  local source_release_id

  require_pr_staging_retention
  gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" >"$source_release"
  gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" >"$source_tag_ref"
  gh api "/repos/$REPOSITORY/git/ref/heads/$DEFAULT_REF" >"$default_ref_value"
  source_release_id="$(jq -er '.id | select(type == "number" and . > 0)' \
    "$source_release")"
  gh api --paginate --slurp \
    "/repos/$REPOSITORY/releases/$source_release_id/assets?per_page=100" \
    >"$source_pages"
  jq -e 'type == "array" and all(.[]; type == "array")' \
    "$source_pages" >/dev/null
  jq '[.[][]]' "$source_pages" >"$source_assets"

  if [ "$legacy_dispatch" = true ]; then
    printf 'null\n' >"$producer_commit"
    gh api "/repos/$REPOSITORY/git/commits/$PACKAGE_SOURCE_SHA" >"$main_commit"
  else
    gh api "/repos/$REPOSITORY/git/commits/$PRODUCER_SHA" >"$producer_commit"
    gh api "/repos/$REPOSITORY/git/commits/$VALIDATED_MAIN_SHA" >"$main_commit"
  fi

  # WHY: these are the remote fields that authorize publication. Presentation
  # URLs and download counters are deliberately excluded because they do not
  # identify source bytes and may change after an authenticated read.
  jq -nS \
    --arg mode "$(if [ "$legacy_dispatch" = true ]; then printf legacy; else printf v2; fi)" \
    --slurpfile release "$source_release" \
    --slurpfile tag "$source_tag_ref" \
    --slurpfile main_ref "$default_ref_value" \
    --slurpfile producer_commit "$producer_commit" \
    --slurpfile main_commit "$main_commit" \
    --slurpfile assets "$source_assets" '
      def direct_ref:
        {ref, object:{type:.object.type, sha:.object.sha}};
      def commit_identity:
        if . == null then null
        else {
          sha,
          tree:{sha:.tree.sha},
          parents:[.parents[]? | {sha}]
        }
        end;
      {
        mode:$mode,
        release:($release[0] | {
          id,tag_name,target_commitish,name,body,draft,prerelease,immutable
        }),
        direct_tag:($tag[0] | direct_ref),
        main_ref:($main_ref[0] | direct_ref),
        producer_commit:($producer_commit[0] | commit_identity),
        main_commit:($main_commit[0] | commit_identity),
        assets:($assets[0] |
          map({id,name,state,size,digest}) | sort_by(.name))
      }
    ' >"$snapshot"
}

assert_live_main_source_snapshot() {
  local prefix="$1"
  local baseline="$TMP_ROOT/live-main-source-baseline.json"
  local observed="$TMP_ROOT/$prefix-source-snapshot.json"

  capture_live_main_source_snapshot "$prefix"
  if [ -f "$baseline" ]; then
    cmp "$baseline" "$observed" >/dev/null || {
      echo "publish-durable-package-generation: live publication source changed" >&2
      return 1
    }
  else
    cp "$observed" "$baseline"
  fi
}

authorize_publication_mutation() {
  verify_authority_checkout
  verify_producer_checkout
  if [ "$IS_PRESERVED" = false ]; then
    if [ ! -f "$TMP_ROOT/live-main-source-baseline.json" ]; then
      validate_live_main_source
    else
      # WHY: the full semantic check establishes this immutable baseline.
      # Every write then takes one fresh, bounded remote snapshot so a long
      # upload sequence cannot publish after main, the producer tag/release,
      # commit metadata, or source assets move.
      assert_live_main_source_snapshot live-before-mutation
    fi
  fi
}

validate_live_main_source() {
  local source_release="$TMP_ROOT/live-before-source-release.json"
  local source_tag_ref="$TMP_ROOT/live-before-source-tag.json"
  local producer_commit="$TMP_ROOT/live-before-producer-commit.json"
  local default_ref_value="$TMP_ROOT/live-before-main-ref.json"
  local main_commit="$TMP_ROOT/live-before-main-commit.json"
  local source_assets="$TMP_ROOT/live-before-source-assets.json"
  local producer_evidence="$TMP_ROOT/live-producer-evidence.json"
  local main_validation="$TMP_ROOT/live-main-validation.json"
  local producer_tree_json="$TMP_ROOT/live-producer-tree.json"
  local main_tree_json="$TMP_ROOT/live-main-tree.json"
  local cache_projection="$TMP_ROOT/live-cache-projection.json"
  local preserved_manifest="$TMP_ROOT/live-preserved-generation.json"
  local source_evidence_extra_args=()
  local generation_digest generation_id generation_size

  assert_live_main_source_snapshot live-before
  if [[ "$SOURCE_TAG" =~ ^preserved-package-generation- ]]; then
    generation_id="$(jq -er '
      [.[] | select(
        .name == "generation.json" and .state == "uploaded" and
        (.id | type == "number" and . > 0) and
        (.size | type == "number" and . > 0 and . <= 4194304) and
        (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
      )] |
      if length == 1 then .[0].id else empty end
    ' "$source_assets")"
    gh api -H 'Accept: application/octet-stream' \
      "/repos/$REPOSITORY/releases/assets/$generation_id" \
      >"$preserved_manifest"
    generation_size="$(jq -er --argjson id "$generation_id" \
      '.[] | select(.id == $id) | .size' "$source_assets")"
    generation_digest="$(jq -er --argjson id "$generation_id" \
      '.[] | select(.id == $id) | .digest | sub("^sha256:";"")' \
      "$source_assets")"
    [ "$(file_bytes "$preserved_manifest")" = "$generation_size" ] &&
      [ "$(sha256_file "$preserved_manifest")" = "$generation_digest" ] || {
      echo "publish-durable-package-generation: preserved producer seal differs from GitHub metadata" >&2
      return 1
    }
    source_evidence_extra_args=(
      --preserved-manifest "$preserved_manifest"
      --release-assets "$source_assets"
    )
  fi
  if [ "$legacy_dispatch" = true ]; then
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
        --source-commit "$main_commit" \
        --output "$main_validation"
    jq -cS '.identity.source_activation.evidence' "$MANIFEST" \
      >"$TMP_ROOT/manifest-main-validation.json"
    cmp "$TMP_ROOT/manifest-main-validation.json" "$main_validation" >/dev/null || {
      echo "publish-durable-package-generation: live main activation differs from generation evidence" >&2
      return 1
    }
    [ "$(jq -er .tree_sha "$main_validation")" = "$authority_tree" ] || {
      echo "publish-durable-package-generation: live main tree differs from writer authority" >&2
      return 1
    }
  else
    # WHY: both names can move independently after preparation. Re-deriving
    # both receipts with current-main code closes that race before writes and
    # again before the seal and public transition.
    env -u GH_TOKEN -u GITHUB_TOKEN \
      -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
      -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_URL \
      -u ACTIONS_RUNTIME_TOKEN \
      python3 "$SCRIPT_DIR/package-generation.py" producer-release-evidence \
        --repository "$REPOSITORY" \
        --source-tag "$SOURCE_TAG" \
        --producer-sha "$PRODUCER_SHA" \
        --release "$source_release" \
        --tag-ref "$source_tag_ref" \
        --producer-commit "$producer_commit" \
        "${source_evidence_extra_args[@]}" \
        --output "$producer_evidence"
    env -u GH_TOKEN -u GITHUB_TOKEN \
      -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
      -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
      -u ACTIONS_ID_TOKEN_REQUEST_URL \
      -u ACTIONS_RUNTIME_TOKEN \
      python3 "$SCRIPT_DIR/package-generation.py" main-validation-evidence \
        --repository "$REPOSITORY" \
        --default-ref "$DEFAULT_REF" \
        --validated-main-sha "$VALIDATED_MAIN_SHA" \
        --abi-version "$EXPECTED_ABI" \
        --method "$VALIDATION_METHOD" \
        --default-ref-value "$default_ref_value" \
        --main-commit "$main_commit" \
        --abi-snapshot "$REPO_ROOT/abi/snapshot.json" \
        --output "$main_validation"
    jq -cS '.identity.producer.evidence' "$MANIFEST" \
      >"$TMP_ROOT/manifest-producer-evidence.json"
    jq -cS '.identity.validated_against_main' "$MANIFEST" \
      >"$TMP_ROOT/manifest-main-validation.json"
    if ! cmp "$TMP_ROOT/manifest-producer-evidence.json" \
         "$producer_evidence" >/dev/null ||
       ! cmp "$TMP_ROOT/manifest-main-validation.json" \
         "$main_validation" >/dev/null ||
       [ "$(jq -er .producer_tree_sha "$producer_evidence")" != "$producer_tree" ] ||
       [ "$(jq -er .tree_sha "$main_validation")" != "$authority_tree" ]; then
      echo "publish-durable-package-generation: live producer/current-main evidence differs from the generation" >&2
      return 1
    fi
    if [ "$VALIDATION_METHOD" = identical-git-tree-v1 ]; then
      [ "$producer_tree" = "$authority_tree" ] || {
        echo "publish-durable-package-generation: producer and current-main Git trees differ" >&2
        return 1
      }
    else
      gh api "/repos/$REPOSITORY/git/trees/$producer_tree?recursive=1" \
        >"$producer_tree_json"
      gh api "/repos/$REPOSITORY/git/trees/$authority_tree?recursive=1" \
        >"$main_tree_json"
      env -u GH_TOKEN -u GITHUB_TOKEN \
        -u HOMEBREW_GITHUB_API_TOKEN \
        -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
        -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
        -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
        -u ACTIONS_ID_TOKEN_REQUEST_URL \
        -u ACTIONS_RUNTIME_TOKEN \
        -u WASM_POSIX_DEPS_REGISTRY \
        python3 "$SCRIPT_DIR/package-generation.py" cache-projection-evidence \
          --producer-sha "$PRODUCER_SHA" \
          --producer-tree-sha "$producer_tree" \
          --validated-main-sha "$VALIDATED_MAIN_SHA" \
          --validated-main-tree-sha "$authority_tree" \
          --producer-projection "$TMP_ROOT/producer-projection.json" \
          --producer-expected-ledger "$TMP_ROOT/producer-expected.json" \
          --main-projection "$rederived_projection" \
          --main-expected-ledger "$rederived_expected" \
          --producer-components "$TMP_ROOT/producer-components.json" \
          --main-components "$TMP_ROOT/rederived-components.json" \
          --producer-tree "$producer_tree_json" \
          --main-tree "$main_tree_json" \
          --output "$cache_projection"
      jq -cS '.identity.cache_projection' "$MANIFEST" \
        >"$TMP_ROOT/manifest-cache-projection.json"
      cmp "$TMP_ROOT/manifest-cache-projection.json" \
        "$cache_projection" >/dev/null || {
        echo "publish-durable-package-generation: live package cache projection evidence differs from the generation" >&2
        return 1
      }
    fi
  fi
  jq -e --arg source_field "$generation_source_field" \
    --slurpfile manifest "$MANIFEST" '
    (map({name,state,size,digest})) as $assets |
    ($manifest[0]) as $generation |
    ([{
      name:"index.toml",
      state:"uploaded",
      size:$generation.identity[$source_field].index_bytes,
      digest:("sha256:" + $generation.identity[$source_field].index_sha256)
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
    echo "publish-durable-package-generation: producer package assets changed after preparation" >&2
    return 1
  }
  # WHY: cache scans and recursive tree reads can be slow. Re-reading every
  # mutable remote authority field closes the interval between the evidence
  # used above and the publication decision made by the caller.
  assert_live_main_source_snapshot live-after
  if [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$AUTHORITY_SHA" ] ||
     [ "$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')" != "$authority_tree" ] ||
     [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ] ||
     { [ "$VALIDATION_METHOD" = identical-package-cache-projection-v1 ] &&
       { [ "$(git -C "$PRODUCER_ROOT" rev-parse HEAD)" != "$PRODUCER_SHA" ] ||
         [ "$(git -C "$PRODUCER_ROOT" rev-parse 'HEAD^{tree}')" != "$producer_tree" ] ||
         [ -n "$(git -C "$PRODUCER_ROOT" status --porcelain=v1 --untracked-files=all)" ]; }; }; then
    echo "publish-durable-package-generation: writer authority changed during validation" >&2
    return 1
  fi
}

validate_publication_source() {
  if [ "$IS_PRESERVED" = true ]; then
    verify_authority_checkout
    verify_preserved_source_evidence
  else
    validate_live_main_source
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
    echo "publish-durable-package-generation: generation tag does not directly reference the validated release target" >&2
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
  authorize_publication_mutation
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
  authorize_publication_mutation
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
  authorize_publication_mutation
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
  authorize_publication_mutation
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

# WHY: an already-public preserved release is immutable application evidence;
# retrying its readback must not depend on the temporary PR staging source
# still existing. Admitted generations still revalidate their live authority
# here because their source tag/main relationship is part of admission.
[ "$IS_PRESERVED" = true ] || validate_publication_source
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
    "${archive_source_args[@]}"
# WHY: archive uploads can take long enough for main, producer tags, assets, or
# ABI snapshot state to change. Recheck after those writes but before adding
# generation.json, whose presence makes the asset set application-complete.
# A preserved retry whose seal already exists crosses no source-dependent write
# boundary, so it intentionally does not require the temporary source again.
refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
if [ "$IS_PRESERVED" = false ] ||
   ! jq -e 'any(.[]; .name == "generation.json")' \
      "$ASSETS_JSON" >/dev/null; then
  validate_publication_source
fi
ensure_asset generation.json

refresh_release_by_id "$(jq -er .id "$RELEASE_JSON")"
assert_complete_inventory
while IFS= read -r name; do
  verify_authenticated_asset "$name"
done < <(jq -r '.[].name' "$EXPECTED_ASSETS")
validate_direct_tag
# WHY: sealing a draft is still reversible; publishing it is not. Require the
# same current-main and producer evidence again at that irreversible boundary.
# A public preserved retry has no publication boundary left to authorize.
if [ "$IS_PRESERVED" = false ] ||
   [ "$(jq -r .draft "$RELEASE_JSON")" = true ]; then
  validate_publication_source
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
if [ "$legacy_dispatch" = true ] || [ "$preserved_dispatch" = true ]; then
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
else
  identity_sha="$(jq -er .identity_sha256 "$MANIFEST")"
  producer_tag_sha="$(jq -er .identity.producer.evidence.tag_sha "$MANIFEST")"
  jq -nS \
    --arg repository "$REPOSITORY" \
    --arg tag "$TAG" \
    --arg target_commitish "$TARGET_COMMIT" \
    --arg identity_sha256 "$identity_sha" \
    --arg source_tag "$SOURCE_TAG" \
    --arg producer_tag_sha "$producer_tag_sha" \
    --arg producer_sha "$PRODUCER_SHA" \
    --arg validated_main_sha "$VALIDATED_MAIN_SHA" \
    --argjson release_id "$release_id" \
    --slurpfile generation "$MANIFEST" \
    --slurpfile assets "$asset_receipts" '
      {
        schema:2,
        status:"success",
        visibility:"public-anonymous-readback",
        repository:$repository,
        tag:$tag,
        target_commitish:$target_commitish,
        identity_sha256:$identity_sha256,
        producer:{
          release_tag:$source_tag,
          release_anchor_commit:$producer_tag_sha,
          archive_commit:$producer_sha
        },
        validated_against_main:{
          commit:$validated_main_sha,
          method:$generation[0].identity.validated_against_main.method,
          cache_projection:$generation[0].identity.cache_projection
        },
        release_id:$release_id,
        application_sealed:true,
        assets:$assets
      }
    ' >"$receipt_tmp"
fi
chmod 600 "$receipt_tmp"
mv "$receipt_tmp" "$RECEIPT"

echo "Published application-sealed package generation: https://github.com/$REPOSITORY/releases/tag/$TAG"
