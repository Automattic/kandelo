#!/usr/bin/env bash
# Turn one exact, fully validated PR-staging closure into a local durable
# package-generation bundle. This script performs no release writes.
set -euo pipefail

SOURCE_TAG=""
PACKAGE_SOURCE_ROOT=""
PACKAGE_SOURCE_SHA=""
EXPECTED_ABI=""
ROOT_PACKAGE="rootfs"
ARCH="wasm32"
REPOSITORY=""
OUTPUT_DIR=""
SOURCE_XTASK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-tag) SOURCE_TAG="$2"; shift 2 ;;
    --package-source-root) PACKAGE_SOURCE_ROOT="$2"; shift 2 ;;
    --package-source-sha) PACKAGE_SOURCE_SHA="$2"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="$2"; shift 2 ;;
    --root-package) ROOT_PACKAGE="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --repository) REPOSITORY="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --source-xtask) SOURCE_XTASK="$2"; shift 2 ;;
    *) echo "prepare-durable-package-generation: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$SOURCE_TAG" =~ ^pr-[1-9][0-9]*-staging$ ]] ||
   ! [[ "$PACKAGE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$ROOT_PACKAGE" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
   ! [[ "$ARCH" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
   [ "$REPOSITORY" != "Automattic/kandelo" ] ||
   [ ! -d "$PACKAGE_SOURCE_ROOT" ] || [ -L "$PACKAGE_SOURCE_ROOT" ] ||
   [ ! -f "$SOURCE_XTASK" ] || [ -L "$SOURCE_XTASK" ] ||
   [ ! -x "$SOURCE_XTASK" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ]; then
  echo "prepare-durable-package-generation: exact source tag, SHA, ABI, root, arch, repository, checkout, xtask, and output are required" >&2
  exit 2
fi
if [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  echo "prepare-durable-package-generation: output already exists: $OUTPUT_DIR" >&2
  exit 2
fi
if [ "${GITHUB_SERVER_URL:-https://github.com}" != "https://github.com" ]; then
  echo "prepare-durable-package-generation: only github.com release identities are supported" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTHORITY_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
if [ "$(git -C "$PACKAGE_SOURCE_ROOT" rev-parse HEAD)" != "$PACKAGE_SOURCE_SHA" ] ||
   [ -n "$(git -C "$PACKAGE_SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "prepare-durable-package-generation: package-source checkout is not the exact clean SHA" >&2
  exit 2
fi
grep -Fxq "pub const ABI_VERSION: u32 = $EXPECTED_ABI;" \
  "$PACKAGE_SOURCE_ROOT/crates/shared/src/lib.rs" || {
  echo "prepare-durable-package-generation: package-source checkout does not declare the selected ABI" >&2
  exit 1
}
if ! git -C "$AUTHORITY_ROOT" merge-base --is-ancestor \
    "$PACKAGE_SOURCE_SHA" HEAD; then
  echo "prepare-durable-package-generation: package-source SHA is not retained in current main history" >&2
  exit 1
fi

PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$PARENT"
TMP_ROOT="$(mktemp -d "$PARENT/.durable-package-generation.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

release_json="$TMP_ROOT/source-release.json"
tag_json="$TMP_ROOT/source-tag.json"
gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" >"$release_json"
gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" >"$tag_json"
jq -e \
  --arg tag "$SOURCE_TAG" \
  --arg sha "$PACKAGE_SOURCE_SHA" '
    .tag_name == $tag and .target_commitish == $sha and
    .draft == false and .prerelease == true and
    (.id | type == "number" and . > 0)
  ' "$release_json" >/dev/null || {
  echo "prepare-durable-package-generation: source staging release does not bind the exact package-source SHA" >&2
  exit 1
}
jq -e \
  --arg tag "$SOURCE_TAG" \
  --arg sha "$PACKAGE_SOURCE_SHA" '
    .ref == ("refs/tags/" + $tag) and
    .object.type == "commit" and .object.sha == $sha
  ' "$tag_json" >/dev/null || {
  echo "prepare-durable-package-generation: source staging tag is not a direct reference to the package-source SHA" >&2
  exit 1
}

run_source_xtask_without_credentials() {
  # WHY: the exact source xtask determines package identities, but it never
  # needs release-write, package-write, OIDC, or checkout credentials. The
  # workflow also runs this script in a read-only job with persisted checkout
  # credentials disabled; this environment boundary is defense in depth.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    "$SOURCE_XTASK" "$@"
}

run_source_xtask_without_credentials staging-reuse expected \
  --registry "$PACKAGE_SOURCE_ROOT/packages/registry" \
  --expected-abi "$EXPECTED_ABI" \
  --output "$TMP_ROOT/full-expected.json"

env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_URL \
  -u ACTIONS_RUNTIME_TOKEN \
  python3 "$SCRIPT_DIR/package-generation.py" select \
    --program-packages \
      "$PACKAGE_SOURCE_ROOT/packages/registry/program-packages.json" \
    --full-expected-ledger "$TMP_ROOT/full-expected.json" \
    --root-package "$ROOT_PACKAGE" \
    --arch "$ARCH" \
    --expected-abi "$EXPECTED_ABI" \
    --projection-out "$TMP_ROOT/projection.json" \
    --expected-out "$TMP_ROOT/expected.json"

GITHUB_REPOSITORY="$REPOSITORY" \
  bash "$SCRIPT_DIR/validate-staging-release.sh" \
    --tag "$SOURCE_TAG" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --mode current \
    --materialize \
    --output-dir "$TMP_ROOT/validated" \
    --xtask "$SOURCE_XTASK"

# WHY: the staging index can contain unrelated entries whose URLs still name
# the temporary release. Rebuilding from only the verified closure archives
# makes it impossible for a hidden staging fallback to enter the durable index.
run_source_xtask_without_credentials build-index \
  --abi "$EXPECTED_ABI" \
  --generator "Durable package generation from $PACKAGE_SOURCE_SHA" \
  --archives-dir "$TMP_ROOT/validated/archives" \
  --out "$TMP_ROOT/minimal-index.toml" \
  --generated-at "1970-01-01T00:00:00Z"

if grep -E '^fallback_[A-Za-z0-9_]*[[:space:]]*=' \
     "$TMP_ROOT/minimal-index.toml" >/dev/null ||
   grep -F "$SOURCE_TAG" "$TMP_ROOT/minimal-index.toml" >/dev/null ||
   grep -E '^archive_url = "([^"]*[/]|https?:)' \
     "$TMP_ROOT/minimal-index.toml" >/dev/null; then
  echo "prepare-durable-package-generation: minimal index retained a non-local archive URL" >&2
  exit 1
fi

# The staging release is mutable. Recheck both identities after downloading
# and validating every byte so a concurrent move cannot bridge two sources.
gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" >"$release_json"
gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" >"$tag_json"
release_id="$(jq -er '.id | select(type == "number" and . > 0)' "$release_json")"
gh api --paginate --slurp \
  "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" \
  >"$TMP_ROOT/source-asset-pages-after.json"
jq '[.[][]] | sort_by(.name) | map({name,state,size,digest})' \
  "$TMP_ROOT/source-asset-pages-after.json" \
  >"$TMP_ROOT/source-assets-after.json"
jq 'sort_by(.name) | map({name,state,size,digest})' \
  "$TMP_ROOT/validated/assets.json" \
  >"$TMP_ROOT/source-assets-before.json"
if ! jq -e \
    --arg tag "$SOURCE_TAG" \
    --arg sha "$PACKAGE_SOURCE_SHA" '
      .tag_name == $tag and .target_commitish == $sha and
      .draft == false and .prerelease == true
    ' "$release_json" >/dev/null ||
   ! jq -e \
    --arg tag "$SOURCE_TAG" \
    --arg sha "$PACKAGE_SOURCE_SHA" '
      .ref == ("refs/tags/" + $tag) and
      .object.type == "commit" and .object.sha == $sha
    ' "$tag_json" >/dev/null ||
   ! cmp \
     "$TMP_ROOT/source-assets-before.json" \
     "$TMP_ROOT/source-assets-after.json" >/dev/null
then
  echo "prepare-durable-package-generation: source staging identity changed during validation" >&2
  exit 1
fi

env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_URL \
  -u ACTIONS_RUNTIME_TOKEN \
  python3 "$SCRIPT_DIR/package-generation.py" prepare \
    --repository "$REPOSITORY" \
    --package-source-sha "$PACKAGE_SOURCE_SHA" \
    --source-tag "$SOURCE_TAG" \
    --source-index "$TMP_ROOT/validated/source-index.toml" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/validated/snapshot.json" \
    --localized-index "$TMP_ROOT/minimal-index.toml" \
    --archives-dir "$TMP_ROOT/validated/archives" \
    --output-dir "$TMP_ROOT/output"

mv "$TMP_ROOT/output" "$OUTPUT_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT
echo "prepare-durable-package-generation: prepared $(jq -r .tag "$OUTPUT_DIR/generation.json")"
