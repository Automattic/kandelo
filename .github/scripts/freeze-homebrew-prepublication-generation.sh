#!/usr/bin/env bash
# Seal the exact rootfs runtime generation from a mutable PR-staging release.
#
# The output intentionally contains a minimal index rather than the staging
# release's full index. A staging release may contain unrelated or failed
# entries; only archives validated against the exact rootfs closure may become
# resolver inputs for bottle publication.
set -euo pipefail

TAG=""
GENERATION_ROOT=""
CONSUMER_ROOT=""
EXPECTED_ABI=""
GENERATION_SHA=""
CONSUMER_SHA=""
REPOSITORY=""
OUTPUT_DIR=""
XTASK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --generation-root) GENERATION_ROOT="$2"; shift 2 ;;
    --consumer-root) CONSUMER_ROOT="$2"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="$2"; shift 2 ;;
    --generation-sha) GENERATION_SHA="$2"; shift 2 ;;
    --consumer-sha) CONSUMER_SHA="$2"; shift 2 ;;
    --repository) REPOSITORY="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --xtask) XTASK="$2"; shift 2 ;;
    *) echo "freeze-homebrew-prepublication-generation: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$TAG" =~ ^pr-[1-9][0-9]*-staging$ ]] ||
   ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$GENERATION_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$CONSUMER_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   [ "$REPOSITORY" != "Automattic/kandelo" ] ||
   [ ! -d "$GENERATION_ROOT" ] || [ -L "$GENERATION_ROOT" ] ||
   [ ! -d "$CONSUMER_ROOT" ] || [ -L "$CONSUMER_ROOT" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ] ||
   [ ! -x "$XTASK" ]; then
  echo "freeze-homebrew-prepublication-generation: exact tag, ABI, SHAs, roots, repository, output, and xtask are required" >&2
  exit 2
fi
if [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  echo "freeze-homebrew-prepublication-generation: output already exists: $OUTPUT_DIR" >&2
  exit 2
fi
[ "$(git -C "$GENERATION_ROOT" rev-parse HEAD)" = "$GENERATION_SHA" ] || {
  echo "freeze-homebrew-prepublication-generation: generation checkout differs from the trusted SHA" >&2
  exit 2
}
[ -z "$(git -C "$GENERATION_ROOT" status --porcelain=v1 --untracked-files=all)" ] || {
  echo "freeze-homebrew-prepublication-generation: generation checkout is dirty" >&2
  exit 2
}
[ "$(git -C "$CONSUMER_ROOT" rev-parse HEAD)" = "$CONSUMER_SHA" ] || {
  echo "freeze-homebrew-prepublication-generation: consumer checkout differs from the planned SHA" >&2
  exit 2
}
[ -z "$(git -C "$CONSUMER_ROOT" status --porcelain=v1 --untracked-files=all)" ] || {
  echo "freeze-homebrew-prepublication-generation: consumer checkout is dirty" >&2
  exit 2
}

# WHY: the GitHub token is needed only for the immutable release snapshot and
# asset downloads. Keep it out of projection work and every package/index
# transformation so package-controlled inputs cannot observe publication
# credentials.
RELEASE_GH_TOKEN="${GH_TOKEN:-}"
RELEASE_GITHUB_TOKEN="${GITHUB_TOKEN:-}"
unset GH_TOKEN GITHUB_TOKEN
unset HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN
unset HOMEBREW_DOCKER_REGISTRY_TOKEN

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$PARENT"
TMP_ROOT="$(mktemp -d "$PARENT/.homebrew-prepublication-generation.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

run_xtask_without_credentials() {
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    "$XTASK" "$@"
}

projection_for() {
  local root="$1"
  local output="$2"
  local source="$root/packages/registry/program-packages.json"
  [ -f "$source" ] && [ ! -L "$source" ] || {
    echo "freeze-homebrew-prepublication-generation: program package projection must be a regular file" >&2
    return 2
  }
  jq -e '
    .format == "kandelo-program-packages-v2" and
    (.packages.rootfs.arches == ["wasm32"]) and
    (.packages.rootfs.cacheKeys.wasm32 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.packages.rootfs.manifestSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.packages.rootfs.dependencyClosures.wasm32 | type == "array" and length > 0) and
    all(.packages.rootfs.dependencyClosures.wasm32[];
      (.packageName | type == "string" and test("^[a-z0-9][a-z0-9._-]*$")) and
      (.manifestSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.cacheKey | type == "string" and test("^[0-9a-f]{64}$")))
  ' "$source" >/dev/null || {
    echo "freeze-homebrew-prepublication-generation: invalid rootfs program package projection" >&2
    return 2
  }
  jq -S '
    {
      schema: 1,
      entries: (
        (
          .packages.rootfs.dependencyClosures.wasm32 |
          map({
            package: .packageName,
            arch: "wasm32",
            manifest_sha256: .manifestSha256,
            cache_key_sha: .cacheKey
          })
        ) + [{
          package: "rootfs",
          arch: "wasm32",
          manifest_sha256: .packages.rootfs.manifestSha256,
          cache_key_sha: .packages.rootfs.cacheKeys.wasm32
        }] |
        sort_by(.package, .arch)
      )
    }
  ' "$source" >"$output"
  jq -e '
    (.entries | length) > 1 and
    ([.entries[].package] | length == (unique | length))
  ' "$output" >/dev/null || {
    echo "freeze-homebrew-prepublication-generation: rootfs closure contains duplicate packages" >&2
    return 2
  }
}

projection_for "$GENERATION_ROOT" "$TMP_ROOT/generation-projection.json"
projection_for "$CONSUMER_ROOT" "$TMP_ROOT/consumer-projection.json"
# WHY: F owns the staging archive identities, while H owns the publishing
# workflow. Comparing both projections prevents a workflow-only descendant
# from silently consuming F's archives after any package/cache-key drift.
cmp "$TMP_ROOT/generation-projection.json" "$TMP_ROOT/consumer-projection.json" || {
  echo "freeze-homebrew-prepublication-generation: generation and consumer rootfs identities differ" >&2
  exit 1
}

expected_ledger_for() {
  local root="$1"
  local output="$2"
  local full
  full="$TMP_ROOT/$(basename "$output").full"
  run_xtask_without_credentials staging-reuse expected \
    --registry "$root/packages/registry" \
    --expected-abi "$EXPECTED_ABI" \
    --output "$full"
  jq -S --slurpfile projection "$TMP_ROOT/generation-projection.json" '
    ($projection[0].entries | map(.package)) as $packages |
    .entries |= map(select(.arch == "wasm32" and (.package as $name | $packages | index($name))))
  ' "$full" >"$output"
  jq -e --argjson expected_abi "$EXPECTED_ABI" \
    --slurpfile projection "$TMP_ROOT/generation-projection.json" '
    .abi_version == $expected_abi and
    (.entries | length) == ($projection[0].entries | length) and
    (.entries | all(.[]; . as $entry |
      any($projection[0].entries[];
        .package == $entry.package and
        .arch == $entry.arch and
        .cache_key_sha == $entry.cache_key_sha)))
  ' "$output" >/dev/null
  rm "$full"
}

expected_ledger_for "$GENERATION_ROOT" "$TMP_ROOT/generation-expected.json"
expected_ledger_for "$CONSUMER_ROOT" "$TMP_ROOT/consumer-expected.json"
cmp "$TMP_ROOT/generation-expected.json" "$TMP_ROOT/consumer-expected.json" || {
  echo "freeze-homebrew-prepublication-generation: generation and consumer expected ledgers differ" >&2
  exit 1
}

GH_TOKEN="$RELEASE_GH_TOKEN" \
  GITHUB_TOKEN="$RELEASE_GITHUB_TOKEN" \
  GITHUB_REPOSITORY="$REPOSITORY" \
  bash "$SCRIPT_DIR/validate-staging-release.sh" \
    --tag "$TAG" \
    --expected-ledger "$TMP_ROOT/generation-expected.json" \
    --mode current \
    --materialize \
    --output-dir "$TMP_ROOT/validated" \
    --xtask "$XTASK"

# WHY: validate-staging-release localizes relative asset names. Rebuilding from
# only the fully validated archives removes every unrelated staging entry;
# seeding then gives those exact entries stable URLs under the reviewed tag.
run_xtask_without_credentials build-index \
    --abi "$EXPECTED_ABI" \
    --generator "Homebrew prepublication rootfs generation from $GENERATION_SHA" \
    --archives-dir "$TMP_ROOT/validated/archives" \
    --out "$TMP_ROOT/minimal-index.toml" \
    --generated-at "1970-01-01T00:00:00Z"
run_xtask_without_credentials index-candidate seed \
    --canonical-index "$TMP_ROOT/minimal-index.toml" \
    --candidate-index "$TMP_ROOT/index.toml" \
    --canonical-index-url "https://github.com/$REPOSITORY/releases/download/$TAG/index.toml" \
    --expected-abi "$EXPECTED_ABI" \
    --generated-at "1970-01-01T00:00:00Z" \
    --generator "Homebrew sealed prepublication rootfs generation"

package_count="$(jq -r '.entries | length' "$TMP_ROOT/generation-projection.json")"
archive_url_count="$(grep -c '^archive_url = ' "$TMP_ROOT/index.toml" || true)"
[ "$archive_url_count" = "$package_count" ] || {
  echo "freeze-homebrew-prepublication-generation: frozen index entry count differs from the validated closure" >&2
  exit 1
}
if grep '^archive_url = ' "$TMP_ROOT/index.toml" |
    grep -Fv "archive_url = \"https://github.com/$REPOSITORY/releases/download/$TAG/" >/dev/null; then
  echo "freeze-homebrew-prepublication-generation: frozen index contains an unsealed archive URL" >&2
  exit 1
fi

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

mkdir "$TMP_ROOT/output"
cp "$TMP_ROOT/index.toml" "$TMP_ROOT/output/index.toml"
cp "$TMP_ROOT/generation-projection.json" "$TMP_ROOT/output/projection.json"
cp "$TMP_ROOT/generation-expected.json" "$TMP_ROOT/output/expected-ledger.json"
cp "$TMP_ROOT/validated/snapshot.json" "$TMP_ROOT/output/snapshot.json"
cp "$TMP_ROOT/validated/assets.json" "$TMP_ROOT/output/assets.json"

# WHY: downstream jobs receive one same-run artifact, but each file still
# needs an explicit byte identity. Binding every evidence file prevents a
# same-count projection, ledger, snapshot, or asset inventory from being
# substituted independently of the frozen index.
printf '{}\n' >"$TMP_ROOT/files.json"
for name in index.toml projection.json expected-ledger.json snapshot.json assets.json; do
  file_sha="$(sha_file "$TMP_ROOT/output/$name")"
  file_size="$(wc -c <"$TMP_ROOT/output/$name" | tr -d '[:space:]')"
  jq -S \
    --arg name "$name" \
    --arg sha256 "$file_sha" \
    --argjson size "$file_size" \
    '. + {($name): {sha256: $sha256, size: $size}}' \
    "$TMP_ROOT/files.json" >"$TMP_ROOT/files.next.json"
  mv "$TMP_ROOT/files.next.json" "$TMP_ROOT/files.json"
done

jq -nS \
  --arg repository "$REPOSITORY" \
  --arg staging_tag "$TAG" \
  --arg generation_sha "$GENERATION_SHA" \
  --arg consumer_sha "$CONSUMER_SHA" \
  --argjson abi_version "$EXPECTED_ABI" \
  --argjson package_count "$package_count" \
  --slurpfile files "$TMP_ROOT/files.json" \
  '{
    schema: 2,
    repository: $repository,
    staging_tag: $staging_tag,
    generation_sha: $generation_sha,
    consumer_sha: $consumer_sha,
    abi_version: $abi_version,
    package_count: $package_count,
    files: $files[0]
  }' >"$TMP_ROOT/output/manifest.json"

mv "$TMP_ROOT/output" "$OUTPUT_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT
echo "freeze-homebrew-prepublication-generation: sealed $package_count packages from $TAG"
