#!/usr/bin/env bash
# Turn one release's archives from immutable producer S into a local durable
# package-generation bundle after validating S against current main. The
# release tag is only an independently rechecked asset locator. This script
# performs no release writes.
set -euo pipefail

SOURCE_TAG=""
PRODUCER_ROOT=""
PRODUCER_SHA=""
VALIDATED_MAIN_SHA=""
VALIDATION_METHOD=""
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
    --producer-root|--package-source-root) PRODUCER_ROOT="$2"; shift 2 ;;
    --producer-sha) PRODUCER_SHA="$2"; shift 2 ;;
    --validated-main-sha) VALIDATED_MAIN_SHA="$2"; shift 2 ;;
    --validation-method) VALIDATION_METHOD="$2"; shift 2 ;;
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
if ! [[ "$SOURCE_TAG" =~ ^(binaries-abi-v[1-9][0-9]*|pr-[1-9][0-9]*-staging(-run-[1-9][0-9]*-attempt-[1-9][0-9]*)?|preserved-package-generation-[A-Za-z0-9._-]+)$ ]] ||
   ! [[ "$PRODUCER_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$VALIDATED_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$VALIDATION_METHOD" =~ ^(identical-git-tree-v1|identical-package-cache-projection-v1)$ ]] ||
   ! [[ "$AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   [ "$DEFAULT_REF" != main ] ||
   ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
   [ "$selection_count" -ne 1 ] ||
   { [ -n "$ROOT_PACKAGE" ] &&
     ! [[ "$ROOT_PACKAGE" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; } ||
   ! [[ "$ARCH" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
   [ "$REPOSITORY" != "Automattic/kandelo" ] ||
   [ ! -d "$PRODUCER_ROOT" ] || [ -L "$PRODUCER_ROOT" ] ||
   [ ! -f "$AUTHORITY_XTASK" ] || [ -L "$AUTHORITY_XTASK" ] ||
   [ ! -x "$AUTHORITY_XTASK" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ]; then
  echo "prepare-durable-package-generation: exact producer tag/SHA, validation method, validated main SHA, ABI, one package selection, arch, repository, checkouts, authority xtask, and output are required" >&2
  exit 2
fi
if [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  echo "prepare-durable-package-generation: output already exists: $OUTPUT_DIR" >&2
  exit 2
fi
if [ "$VALIDATION_METHOD" = identical-package-cache-projection-v1 ] &&
   ! [[ "$SOURCE_TAG" =~ ^preserved-package-generation- ]]; then
  # WHY: the mutable PR tag is only a discovery aid. Compatibility admission
  # starts from the exact content tag returned by the completed preservation
  # dispatch, so a guessed pre-dispatch tag can never identify producer bytes.
  echo "prepare-durable-package-generation: cache-projection admission requires the exact published preserved-generation tag" >&2
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
producer_tree="$(git -C "$PRODUCER_ROOT" rev-parse 'HEAD^{tree}')"
if { [[ "$SOURCE_TAG" =~ ^binaries-abi-v ]] &&
     [ "$SOURCE_TAG" != "binaries-abi-v$EXPECTED_ABI" ]; } ||
   [ "$VALIDATED_MAIN_SHA" != "$AUTHORITY_SHA" ] ||
   [ "$authority_sha" != "$AUTHORITY_SHA" ] ||
   [ "$(git -C "$PRODUCER_ROOT" rev-parse HEAD)" != "$PRODUCER_SHA" ] ||
   { [ "$VALIDATION_METHOD" = identical-git-tree-v1 ] &&
     [ "$producer_tree" != "$authority_tree" ]; } ||
   [ -n "$(git -C "$PRODUCER_ROOT" status --porcelain=v1 --untracked-files=all)" ] ||
   [ -n "$(git -C "$AUTHORITY_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "prepare-durable-package-generation: producer and clean current-main authority do not satisfy the selected validation method" >&2
  exit 2
fi
grep -Fxq "pub const ABI_VERSION: u32 = $EXPECTED_ABI;" \
  "$AUTHORITY_ROOT/crates/shared/src/lib.rs" || {
  echo "prepare-durable-package-generation: current main does not declare the selected ABI" >&2
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

require_pr_staging_retention() {
  local pr_number pr_json="$TMP_ROOT/retained-source-pr.json"
  if [[ "$SOURCE_TAG" =~ ^pr-([1-9][0-9]*)-staging(-run-[1-9][0-9]*-attempt-[1-9][0-9]*)?$ ]]; then
    pr_number="${BASH_REMATCH[1]}"
    gh api "/repos/$REPOSITORY/pulls/$pr_number" >"$pr_json"
    # WHY: promotion is necessarily post-merge. The retention label makes the
    # source release lifetime explicit so close-event cleanup cannot race this
    # read-only preparation transaction.
    jq -e --argjson number "$pr_number" '
      .number == $number and .state == "closed" and
      .merged_at != null and
      any(.labels[]?; .name == "retain-package-staging")
    ' "$pr_json" >/dev/null || {
      echo "prepare-durable-package-generation: PR staging source is not retained for post-merge promotion" >&2
      return 1
    }
  fi
}

release_json="$TMP_ROOT/producer-release.json"
tag_json="$TMP_ROOT/producer-tag.json"
producer_commit_json="$TMP_ROOT/producer-commit.json"
default_ref_json="$TMP_ROOT/main-ref.json"
main_commit_json="$TMP_ROOT/main-commit.json"
require_pr_staging_retention
gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" >"$release_json"
gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" >"$tag_json"
gh api "/repos/$REPOSITORY/git/commits/$PRODUCER_SHA" >"$producer_commit_json"
gh api "/repos/$REPOSITORY/git/ref/heads/$DEFAULT_REF" >"$default_ref_json"
gh api "/repos/$REPOSITORY/git/commits/$VALIDATED_MAIN_SHA" >"$main_commit_json"
producer_evidence_extra_args=()
if [[ "$SOURCE_TAG" =~ ^preserved-package-generation- ]]; then
  release_id="$(jq -er '.id | select(type == "number" and . > 0)' "$release_json")"
  gh api --paginate --slurp \
    "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" \
    >"$TMP_ROOT/producer-asset-pages.json"
  jq -e 'type == "array" and all(.[]; type == "array")' \
    "$TMP_ROOT/producer-asset-pages.json" >/dev/null
  jq '[.[][]]' "$TMP_ROOT/producer-asset-pages.json" \
    >"$TMP_ROOT/producer-assets.json"
  generation_id="$(jq -er '
    [.[] | select(
      .name == "generation.json" and .state == "uploaded" and
      (.id | type == "number" and . > 0) and
      (.size | type == "number" and . > 0 and . <= 4194304) and
      (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
    )] |
    if length == 1 then .[0].id else empty end
  ' "$TMP_ROOT/producer-assets.json")"
  gh api -H 'Accept: application/octet-stream' \
    "/repos/$REPOSITORY/releases/assets/$generation_id" \
    >"$TMP_ROOT/preserved-generation.json"
  generation_size="$(jq -er --argjson id "$generation_id" \
    '.[] | select(.id == $id) | .size' "$TMP_ROOT/producer-assets.json")"
  generation_sha="$(jq -er --argjson id "$generation_id" \
    '.[] | select(.id == $id) | .digest | sub("^sha256:";"")' \
    "$TMP_ROOT/producer-assets.json")"
  if [ "$(file_bytes "$TMP_ROOT/preserved-generation.json")" != "$generation_size" ] ||
     [ "$(sha256_file "$TMP_ROOT/preserved-generation.json")" != "$generation_sha" ]; then
    echo "prepare-durable-package-generation: preserved application seal differs from GitHub metadata" >&2
    exit 1
  fi
  producer_evidence_extra_args=(
    --preserved-manifest "$TMP_ROOT/preserved-generation.json"
    --release-assets "$TMP_ROOT/producer-assets.json"
  )
fi
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
    --release "$release_json" \
    --tag-ref "$tag_json" \
    --producer-commit "$producer_commit_json" \
    "${producer_evidence_extra_args[@]}" \
    --output "$TMP_ROOT/producer-evidence.json"

verify_preserved_v2_ancestry() {
  local evidence="$1" preservation_authority format
  format="$(jq -er \
    '.preserved_manifest.format // ""' "$evidence")"
  [ -n "$format" ] || return 0
  case "$format" in
    kandelo-preserved-pr-package-generation-v1)
      return 0
      ;;
    kandelo-preserved-package-generation-v2)
      preservation_authority="$(jq -er \
        '.preserved_manifest.identity.authority_sha' "$evidence")"
      ;;
    *)
      echo "prepare-durable-package-generation: preserved source format is unsupported" >&2
      return 1
      ;;
  esac
  # WHY: admission is a separate trust boundary from preservation. Recheck
  # the sealed canonical producer's complete protected-main chain here.
  bash "$SCRIPT_DIR/verify-package-generation-ancestry.sh" \
    --repository-root "$AUTHORITY_ROOT" \
    --producer-sha "$PRODUCER_SHA" \
    --preservation-authority-sha "$preservation_authority" \
    --current-authority-sha "$AUTHORITY_SHA"
}

verify_preserved_v2_ancestry "$TMP_ROOT/producer-evidence.json"
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
    --default-ref-value "$default_ref_json" \
    --main-commit "$main_commit_json" \
    --abi-snapshot "$AUTHORITY_ROOT/abi/snapshot.json" \
    --output "$TMP_ROOT/main-validation.json"
if [ "$(jq -er .producer_tree_sha "$TMP_ROOT/producer-evidence.json")" != "$producer_tree" ] ||
   [ "$(jq -er .tree_sha "$TMP_ROOT/main-validation.json")" != "$authority_tree" ] ||
   [ "$(jq -er .method "$TMP_ROOT/main-validation.json")" != "$VALIDATION_METHOD" ] ||
   { [ "$VALIDATION_METHOD" = identical-git-tree-v1 ] &&
     [ "$producer_tree" != "$authority_tree" ]; }; then
  echo "prepare-durable-package-generation: producer and validated main evidence does not bind the selected validation method" >&2
  exit 1
fi

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
      --source-root "$AUTHORITY_ROOT" \
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
      echo "prepare-durable-package-generation: producer and current main browser package roots differ" >&2
      exit 1
    }
  fi
  selection_args=(
    --root-set browser-inputs
    --roots-file "$TMP_ROOT/browser-inputs-roots.txt"
  )
else
  selection_args=(--root-package "$ROOT_PACKAGE")
fi

# WHY: S supplies only immutable bytes and provenance. Deriving selection with
# M prevents historical workflow code from interpreting or narrowing inputs.
run_authority_xtask_without_credentials staging-reuse scan-source-admitted \
  --source-root "$AUTHORITY_ROOT" \
  --expected-abi "$EXPECTED_ABI" \
  --arch "$ARCH" \
  "${selection_args[@]}" \
  --projection-output "$TMP_ROOT/projection.json" \
  --expected-output "$TMP_ROOT/expected.json" \
  --components-output "$TMP_ROOT/components.json"

cache_projection_args=()
if [ "$VALIDATION_METHOD" = identical-package-cache-projection-v1 ]; then
  # WHY: current main's scanner interprets both inert source trees. The
  # evidence requires an identical selected build-input closure and pins the
  # exact validator transition through each recursive Git tree. Unrelated
  # leaves need not match because the closure proves they are not package
  # inputs.
  run_authority_xtask_without_credentials staging-reuse scan-source \
    --source-root "$PRODUCER_ROOT" \
    --expected-abi "$EXPECTED_ABI" \
    --arch "$ARCH" \
    "${selection_args[@]}" \
    --projection-output "$TMP_ROOT/producer-projection.json" \
    --expected-output "$TMP_ROOT/producer-expected.json" \
    --components-output "$TMP_ROOT/producer-components.json"
  producer_tree_json="$TMP_ROOT/producer-tree.json"
  main_tree_json="$TMP_ROOT/main-tree.json"
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
      --main-projection "$TMP_ROOT/projection.json" \
      --main-expected-ledger "$TMP_ROOT/expected.json" \
      --producer-components "$TMP_ROOT/producer-components.json" \
      --main-components "$TMP_ROOT/components.json" \
      --producer-tree "$producer_tree_json" \
      --main-tree "$main_tree_json" \
      --output "$TMP_ROOT/cache-projection.json"
  cache_projection_args=(
    --cache-projection "$TMP_ROOT/cache-projection.json"
  )
fi

GITHUB_REPOSITORY="$REPOSITORY" \
  bash "$SCRIPT_DIR/validate-staging-release.sh" \
    --tag "$SOURCE_TAG" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --mode current \
    --materialize \
    --output-dir "$TMP_ROOT/validated" \
    --xtask "$AUTHORITY_XTASK"

if [ "${#producer_evidence_extra_args[@]}" -gt 0 ]; then
  mkdir "$TMP_ROOT/preserved-bundle"
  cp "$TMP_ROOT/preserved-generation.json" \
    "$TMP_ROOT/preserved-bundle/generation.json"
  cp "$TMP_ROOT/validated/source-index.toml" \
    "$TMP_ROOT/preserved-bundle/index.toml"
  cp "$TMP_ROOT/validated/archives/"*.tar.zst "$TMP_ROOT/preserved-bundle/"
  while IFS=$'\t' read -r name sha size; do
    bash "$SCRIPT_DIR/download-verified-release-asset.sh" \
      --tag "$SOURCE_TAG" \
      --asset "$name" \
      --sha256 "$sha" \
      --size "$size" \
      --output "$TMP_ROOT/preserved-bundle/$name"
  done < <(
    jq -r '
      .identity.supporting_assets[] |
      [.name,.sha256,(.bytes | tostring)] | @tsv
    ' "$TMP_ROOT/preserved-generation.json"
  )
  # WHY: the nested manifest is not merely descriptive provenance. Rebuilding
  # its complete bundle from the public release proves the application seal,
  # archive inventory, and root-job log bytes before any admission decision.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    PYTHONDONTWRITEBYTECODE=1 \
    python3 "$SCRIPT_DIR/package-generation.py" validate \
      --bundle "$TMP_ROOT/preserved-bundle" \
      --expected-tag "$SOURCE_TAG" >/dev/null
fi

# WHY: the staging index can contain unrelated entries whose URLs still name
# the temporary release. Rebuilding from only the verified closure archives
# makes it impossible for a hidden staging fallback to enter the durable index.
run_authority_xtask_without_credentials build-index \
  --abi "$EXPECTED_ABI" \
  --generator "Durable package generation from producer $PRODUCER_SHA validated against main $VALIDATED_MAIN_SHA" \
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

# The producer release and default branch are mutable GitHub names. Recheck
# every relationship after validating the bytes so neither can bridge two
# identities.
release_after_json="$TMP_ROOT/producer-release-after.json"
tag_after_json="$TMP_ROOT/producer-tag-after.json"
producer_commit_after_json="$TMP_ROOT/producer-commit-after.json"
default_ref_after_json="$TMP_ROOT/main-ref-after.json"
main_commit_after_json="$TMP_ROOT/main-commit-after.json"
require_pr_staging_retention
gh api "/repos/$REPOSITORY/releases/tags/$SOURCE_TAG" >"$release_after_json"
gh api "/repos/$REPOSITORY/git/ref/tags/$SOURCE_TAG" >"$tag_after_json"
gh api "/repos/$REPOSITORY/git/commits/$PRODUCER_SHA" \
  >"$producer_commit_after_json"
gh api "/repos/$REPOSITORY/git/ref/heads/$DEFAULT_REF" \
  >"$default_ref_after_json"
gh api "/repos/$REPOSITORY/git/commits/$VALIDATED_MAIN_SHA" \
  >"$main_commit_after_json"
release_id="$(jq -er '.id | select(type == "number" and . > 0)' \
  "$release_after_json")"
gh api --paginate --slurp \
  "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" \
  >"$TMP_ROOT/source-asset-pages-after.json"
jq '[.[][]]' "$TMP_ROOT/source-asset-pages-after.json" \
  >"$TMP_ROOT/producer-assets-after.json"
jq 'sort_by(.name) | map({name,state,size,digest})' \
  "$TMP_ROOT/producer-assets-after.json" \
  >"$TMP_ROOT/source-assets-after.json"
producer_evidence_after_extra_args=()
if [ "${#producer_evidence_extra_args[@]}" -gt 0 ]; then
  producer_evidence_after_extra_args=(
    --preserved-manifest "$TMP_ROOT/preserved-generation.json"
    --release-assets "$TMP_ROOT/producer-assets-after.json"
  )
fi
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
    python3 "$SCRIPT_DIR/package-generation.py" producer-release-evidence \
      --repository "$REPOSITORY" \
      --source-tag "$SOURCE_TAG" \
      --producer-sha "$PRODUCER_SHA" \
      --release "$release_after_json" \
      --tag-ref "$tag_after_json" \
      --producer-commit "$producer_commit_after_json" \
      "${producer_evidence_after_extra_args[@]}" \
      --output "$TMP_ROOT/producer-evidence-after.json" ||
   ! env -u GH_TOKEN -u GITHUB_TOKEN \
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
       --default-ref-value "$default_ref_after_json" \
       --main-commit "$main_commit_after_json" \
       --abi-snapshot "$AUTHORITY_ROOT/abi/snapshot.json" \
       --output "$TMP_ROOT/main-validation-after.json" ||
   ! cmp "$TMP_ROOT/producer-evidence.json" \
     "$TMP_ROOT/producer-evidence-after.json" >/dev/null ||
   ! cmp "$TMP_ROOT/main-validation.json" \
     "$TMP_ROOT/main-validation-after.json" >/dev/null ||
   ! cmp "$TMP_ROOT/source-assets-before.json" \
     "$TMP_ROOT/source-assets-after.json" >/dev/null ||
   [ "$(git -C "$AUTHORITY_ROOT" rev-parse HEAD)" != "$AUTHORITY_SHA" ] ||
   [ "$(git -C "$AUTHORITY_ROOT" rev-parse 'HEAD^{tree}')" != "$authority_tree" ] ||
   [ "$(git -C "$PRODUCER_ROOT" rev-parse HEAD)" != "$PRODUCER_SHA" ] ||
   [ "$(git -C "$PRODUCER_ROOT" rev-parse 'HEAD^{tree}')" != "$producer_tree" ] ||
   { [ "$VALIDATION_METHOD" = identical-git-tree-v1 ] &&
     [ "$producer_tree" != "$authority_tree" ]; } ||
   [ -n "$(git -C "$AUTHORITY_ROOT" status --porcelain=v1 --untracked-files=all)" ] ||
   [ -n "$(git -C "$PRODUCER_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "prepare-durable-package-generation: producer or current-main validation changed during preparation" >&2
  exit 1
fi
verify_preserved_v2_ancestry "$TMP_ROOT/producer-evidence-after.json"

env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_URL \
  -u ACTIONS_RUNTIME_TOKEN \
  python3 "$SCRIPT_DIR/package-generation.py" prepare \
    --repository "$REPOSITORY" \
    --producer-sha "$PRODUCER_SHA" \
    --authority-sha "$AUTHORITY_SHA" \
    --source-tag "$SOURCE_TAG" \
    --producer-evidence "$TMP_ROOT/producer-evidence.json" \
    --main-validation "$TMP_ROOT/main-validation.json" \
    "${cache_projection_args[@]}" \
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
# WHY: this legacy validator flag names the commit embedded by the archives,
# which is producer H/S under v2 rather than publication authority M.
run_authority_xtask_without_credentials staging-reuse validate-generation \
  --expected-ledger "$TMP_ROOT/output-expected.json" \
  --snapshot "$TMP_ROOT/output-snapshot.json" \
  --index "$TMP_ROOT/output/index.toml" \
  --assets "$TMP_ROOT/output-assets.json" \
  --bundle-dir "$TMP_ROOT/output" \
  --release-tag "$(jq -er .tag "$TMP_ROOT/output/generation.json")" \
  --release-base-url "https://github.com/$REPOSITORY/releases/download/$(jq -er .tag "$TMP_ROOT/output/generation.json")/" \
  --source-release-tag "$SOURCE_TAG" \
  --package-source-sha "$PRODUCER_SHA"

mv "$TMP_ROOT/output" "$OUTPUT_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT
echo "prepare-durable-package-generation: prepared $(jq -r .tag "$OUTPUT_DIR/generation.json")"
