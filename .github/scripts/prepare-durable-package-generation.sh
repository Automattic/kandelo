#!/usr/bin/env bash
# Turn one exact, fully validated main-activated closure into a local durable
# package-generation bundle. This script performs no release writes.
set -euo pipefail

SOURCE_TAG=""
PACKAGE_SOURCE_ROOT=""
PACKAGE_SOURCE_SHA=""
AUTHORITY_SHA=""
DEFAULT_REF=""
EXPECTED_ABI=""
ROOT_PACKAGE=""
BROWSER_INPUTS=false
ARCH="wasm32"
REPOSITORY=""
OUTPUT_DIR=""
AUTHORITY_XTASK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-tag) SOURCE_TAG="$2"; shift 2 ;;
    --package-source-root) PACKAGE_SOURCE_ROOT="$2"; shift 2 ;;
    --package-source-sha) PACKAGE_SOURCE_SHA="$2"; shift 2 ;;
    --authority-sha) AUTHORITY_SHA="$2"; shift 2 ;;
    --default-ref) DEFAULT_REF="$2"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="$2"; shift 2 ;;
    --root-package) ROOT_PACKAGE="$2"; shift 2 ;;
    --browser-inputs) BROWSER_INPUTS=true; shift ;;
    --arch) ARCH="$2"; shift 2 ;;
    --repository) REPOSITORY="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --authority-xtask) AUTHORITY_XTASK="$2"; shift 2 ;;
    *) echo "prepare-durable-package-generation: unknown flag $1" >&2; exit 2 ;;
  esac
done

selection_count=0
[ -n "$ROOT_PACKAGE" ] && selection_count=$((selection_count + 1))
[ "$BROWSER_INPUTS" = true ] && selection_count=$((selection_count + 1))
if ! [[ "$SOURCE_TAG" =~ ^binaries-abi-v[1-9][0-9]*$ ]] ||
   ! [[ "$PACKAGE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   [ "$DEFAULT_REF" != main ] ||
   ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
   [ "$selection_count" -ne 1 ] ||
   { [ -n "$ROOT_PACKAGE" ] &&
     ! [[ "$ROOT_PACKAGE" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; } ||
   ! [[ "$ARCH" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
   [ "$REPOSITORY" != "Automattic/kandelo" ] ||
   [ ! -d "$PACKAGE_SOURCE_ROOT" ] || [ -L "$PACKAGE_SOURCE_ROOT" ] ||
   [ ! -f "$AUTHORITY_XTASK" ] || [ -L "$AUTHORITY_XTASK" ] ||
   [ ! -x "$AUTHORITY_XTASK" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ]; then
  echo "prepare-durable-package-generation: exact source tag, SHA, ABI, one package selection, arch, repository, checkout, authority xtask, and output are required" >&2
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
authority_sha="$(git -C "$AUTHORITY_ROOT" rev-parse HEAD)"
authority_tree="$(git -C "$AUTHORITY_ROOT" rev-parse 'HEAD^{tree}')"
if [ "$SOURCE_TAG" != "binaries-abi-v$EXPECTED_ABI" ] ||
   [ "$PACKAGE_SOURCE_SHA" != "$AUTHORITY_SHA" ] ||
   [ "$authority_sha" != "$AUTHORITY_SHA" ] ||
   [ "$(git -C "$PACKAGE_SOURCE_ROOT" rev-parse HEAD)" != "$PACKAGE_SOURCE_SHA" ] ||
   [ -n "$(git -C "$PACKAGE_SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ] ||
   [ -n "$(git -C "$AUTHORITY_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "prepare-durable-package-generation: package source and authority must be the exact clean activated main SHA" >&2
  exit 2
fi
grep -Fxq "pub const ABI_VERSION: u32 = $EXPECTED_ABI;" \
  "$PACKAGE_SOURCE_ROOT/crates/shared/src/lib.rs" || {
  echo "prepare-durable-package-generation: package-source checkout does not declare the selected ABI" >&2
  exit 1
}

PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$PARENT"
TMP_ROOT="$(mktemp -d "$PARENT/.durable-package-generation.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

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

release_json="$TMP_ROOT/source-release.json"
tag_json="$TMP_ROOT/source-tag.json"
default_ref_json="$TMP_ROOT/default-ref.json"
source_commit_json="$TMP_ROOT/source-commit.json"
gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" >"$release_json"
gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" >"$tag_json"
gh api "/repos/$REPOSITORY/git/ref/heads/$DEFAULT_REF" >"$default_ref_json"
gh api "/repos/$REPOSITORY/git/commits/$PACKAGE_SOURCE_SHA" >"$source_commit_json"
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
    --release "$release_json" \
    --tag-ref "$tag_json" \
    --default-ref-value "$default_ref_json" \
    --source-commit "$source_commit_json" \
    --output "$TMP_ROOT/main-source-evidence.json"
if [ "$(jq -er .tree_sha "$TMP_ROOT/main-source-evidence.json")" != "$authority_tree" ]; then
  echo "prepare-durable-package-generation: activated main tree differs from the authority checkout" >&2
  exit 1
fi
source_evidence_args=(
  --source-evidence "$TMP_ROOT/main-source-evidence.json"
)

run_authority_xtask_without_credentials() {
  # WHY: exact main source is inert input. Only the current authority parser
  # may interpret its manifests and checked identity records.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    -u WASM_POSIX_DEPS_REGISTRY \
    "$AUTHORITY_XTASK" "$@"
}

selection_args=()
if [ "$BROWSER_INPUTS" = true ]; then
  browser_roots_script="$AUTHORITY_ROOT/scripts/browser-binary-package-roots.mjs"
  if [ ! -f "$browser_roots_script" ] || [ -L "$browser_roots_script" ]; then
    echo "prepare-durable-package-generation: current authority lacks the browser root scanner" >&2
    exit 1
  fi
  # WHY: the durable identity must bind the browser imports owned by this
  # exact source checkout. A caller-provided list could silently omit a newly
  # imported program even when the resulting archive union happened to match.
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
      --source-root "$PACKAGE_SOURCE_ROOT" \
      "${browser_root_args[@]}" >"$TMP_ROOT/browser-inputs-roots.txt"
  selection_args=(
    --root-set browser-inputs
    --roots-file "$TMP_ROOT/browser-inputs-roots.txt"
  )
else
  selection_args=(--root-package "$ROOT_PACKAGE")
fi

run_authority_xtask_without_credentials staging-reuse scan-source \
  --source-root "$PACKAGE_SOURCE_ROOT" \
  --expected-abi "$EXPECTED_ABI" \
  --arch "$ARCH" \
  "${selection_args[@]}" \
  --projection-output "$TMP_ROOT/projection.json" \
  --expected-output "$TMP_ROOT/expected.json"

GITHUB_REPOSITORY="$REPOSITORY" \
  bash "$SCRIPT_DIR/validate-staging-release.sh" \
    --tag "$SOURCE_TAG" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --mode current \
    --materialize \
    --output-dir "$TMP_ROOT/validated" \
    --xtask "$AUTHORITY_XTASK"

# WHY: the staging index can contain unrelated entries whose URLs still name
# the temporary release. Rebuilding from only the verified closure archives
# makes it impossible for a hidden staging fallback to enter the durable index.
run_authority_xtask_without_credentials build-index \
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

# The canonical release and default branch are mutable. Recheck every source
# relationship after validating the bytes so an activation or branch move
# cannot bridge two identities.
release_after_json="$TMP_ROOT/source-release-after.json"
tag_after_json="$TMP_ROOT/source-tag-after.json"
default_ref_after_json="$TMP_ROOT/default-ref-after.json"
source_commit_after_json="$TMP_ROOT/source-commit-after.json"
gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" >"$release_after_json"
gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" >"$tag_after_json"
gh api "/repos/$REPOSITORY/git/ref/heads/$DEFAULT_REF" \
  >"$default_ref_after_json"
gh api "/repos/$REPOSITORY/git/commits/$PACKAGE_SOURCE_SHA" \
  >"$source_commit_after_json"
release_id="$(jq -er '.id | select(type == "number" and . > 0)' \
  "$release_after_json")"
gh api --paginate --slurp \
  "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" \
  >"$TMP_ROOT/source-asset-pages-after.json"
jq '[.[][]] | sort_by(.name) | map({name,state,size,digest})' \
  "$TMP_ROOT/source-asset-pages-after.json" \
  >"$TMP_ROOT/source-assets-after.json"
jq 'sort_by(.name) | map({name,state,size,digest})' \
  "$TMP_ROOT/validated/assets.json" \
  >"$TMP_ROOT/source-assets-before.json"
if ! env -u GH_TOKEN -u GITHUB_TOKEN \
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
      --release "$release_after_json" \
      --tag-ref "$tag_after_json" \
      --default-ref-value "$default_ref_after_json" \
      --source-commit "$source_commit_after_json" \
      --output "$TMP_ROOT/main-source-evidence-after.json" ||
   ! cmp "$TMP_ROOT/main-source-evidence.json" \
     "$TMP_ROOT/main-source-evidence-after.json" >/dev/null ||
   ! cmp "$TMP_ROOT/source-assets-before.json" \
     "$TMP_ROOT/source-assets-after.json" >/dev/null ||
   [ "$(git -C "$AUTHORITY_ROOT" rev-parse HEAD)" != "$AUTHORITY_SHA" ] ||
   [ "$(git -C "$AUTHORITY_ROOT" rev-parse 'HEAD^{tree}')" != "$authority_tree" ] ||
   [ "$(git -C "$PACKAGE_SOURCE_ROOT" rev-parse HEAD)" != "$PACKAGE_SOURCE_SHA" ] ||
   [ "$(git -C "$PACKAGE_SOURCE_ROOT" rev-parse 'HEAD^{tree}')" != "$authority_tree" ] ||
   [ -n "$(git -C "$AUTHORITY_ROOT" status --porcelain=v1 --untracked-files=all)" ] ||
   [ -n "$(git -C "$PACKAGE_SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "prepare-durable-package-generation: activated main source changed during validation" >&2
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
    --authority-sha "$AUTHORITY_SHA" \
    --source-tag "$SOURCE_TAG" \
    "${source_evidence_args[@]}" \
    --source-index "$TMP_ROOT/validated/source-index.toml" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/validated/snapshot.json" \
    --localized-index "$TMP_ROOT/minimal-index.toml" \
    --archives-dir "$TMP_ROOT/validated/archives" \
    --output-dir "$TMP_ROOT/output"

generation_sha="$(sha256_file "$TMP_ROOT/output/generation.json")"
generation_bytes="$(file_bytes "$TMP_ROOT/output/generation.json")"
jq -S \
  --arg generation_sha "$generation_sha" \
  --argjson generation_bytes "$generation_bytes" '
    [
      {
        name: "generation.json",
        state: "uploaded",
        size: $generation_bytes,
        digest: ("sha256:" + $generation_sha)
      },
      {
        name: .index.name,
        state: "uploaded",
        size: .index.bytes,
        digest: ("sha256:" + .index.sha256)
      }
    ] +
    [.identity.archives[] | {
      name,
      state: "uploaded",
      size: .bytes,
      digest: ("sha256:" + .sha256)
    }] |
    sort_by(.name)
  ' "$TMP_ROOT/output/generation.json" >"$TMP_ROOT/output-assets.json"
jq -S '.identity.expected_ledger' "$TMP_ROOT/output/generation.json" \
  >"$TMP_ROOT/output-expected.json"
jq -S '.identity.validated_snapshot' "$TMP_ROOT/output/generation.json" \
  >"$TMP_ROOT/output-snapshot.json"
run_authority_xtask_without_credentials staging-reuse validate-generation \
  --expected-ledger "$TMP_ROOT/output-expected.json" \
  --snapshot "$TMP_ROOT/output-snapshot.json" \
  --index "$TMP_ROOT/output/index.toml" \
  --assets "$TMP_ROOT/output-assets.json" \
  --bundle-dir "$TMP_ROOT/output" \
  --release-tag "$(jq -er .tag "$TMP_ROOT/output/generation.json")" \
  --release-base-url "https://github.com/$REPOSITORY/releases/download/$(jq -er .tag "$TMP_ROOT/output/generation.json")/" \
  --package-source-sha "$PACKAGE_SOURCE_SHA"

mv "$TMP_ROOT/output" "$OUTPUT_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT
echo "prepare-durable-package-generation: prepared $(jq -r .tag "$OUTPUT_DIR/generation.json")"
