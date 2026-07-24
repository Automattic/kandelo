#!/usr/bin/env bash
# Download and validate one public durable package generation, then expose a
# local resolver index only when an exact consumer checkout has the same
# selected package projection and expected ledger.
set -euo pipefail

TAG=""
CONSUMER_ROOT=""
CONSUMER_SHA=""
CONSUMER_XTASK=""
AUTHORITY_XTASK=""
REPOSITORY=""
OUTPUT_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --consumer-root) CONSUMER_ROOT="$2"; shift 2 ;;
    --consumer-sha) CONSUMER_SHA="$2"; shift 2 ;;
    --consumer-xtask) CONSUMER_XTASK="$2"; shift 2 ;;
    --authority-xtask) AUTHORITY_XTASK="$2"; shift 2 ;;
    --repository) REPOSITORY="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "materialize-durable-package-generation: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$TAG" =~ ^package-generation-[a-z0-9][a-z0-9._-]*-[a-z0-9][a-z0-9._-]*-abi-v[1-9][0-9]*-sha256-[0-9a-f]{64}$ ]] ||
   ! [[ "$CONSUMER_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   [ "$REPOSITORY" != "Automattic/kandelo" ] ||
   [ ! -d "$CONSUMER_ROOT" ] || [ -L "$CONSUMER_ROOT" ] ||
   [ ! -f "$CONSUMER_XTASK" ] || [ -L "$CONSUMER_XTASK" ] ||
   [ ! -x "$CONSUMER_XTASK" ] ||
   [ ! -f "$AUTHORITY_XTASK" ] || [ -L "$AUTHORITY_XTASK" ] ||
   [ ! -x "$AUTHORITY_XTASK" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ]; then
  echo "materialize-durable-package-generation: exact tag, consumer, xtasks, repository, and output are required" >&2
  exit 2
fi
if [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  echo "materialize-durable-package-generation: output already exists: $OUTPUT_DIR" >&2
  exit 2
fi
if [ "$(git -C "$CONSUMER_ROOT" rev-parse HEAD)" != "$CONSUMER_SHA" ] ||
   [ -n "$(git -C "$CONSUMER_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "materialize-durable-package-generation: consumer checkout is not the exact clean SHA" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$PARENT"
TMP_ROOT="$(mktemp -d "$PARENT/.materialized-package-generation.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir "$TMP_ROOT/bundle"

release_json="$TMP_ROOT/release.json"
tag_json="$TMP_ROOT/tag.json"
asset_pages="$TMP_ROOT/asset-pages.json"
assets_json="$TMP_ROOT/assets.json"
gh api "/repos/$REPOSITORY/releases/tags/$TAG" >"$release_json"
gh api "/repos/$REPOSITORY/git/ref/tags/$TAG" >"$tag_json"
release_id="$(jq -er '.id | select(type == "number" and . > 0)' "$release_json")"
gh api --paginate --slurp \
  "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" >"$asset_pages"
jq -e 'type == "array" and all(.[]; type == "array")' "$asset_pages" >/dev/null
jq '[.[][]]' "$asset_pages" >"$assets_json"
# WHY: one generation may contain the bounded 256-archive closure plus its
# resolver index and generation.json seal.
jq -e '
  type == "array" and length >= 3 and length <= 258 and
  all(.[]; (
    (.id | type == "number" and . > 0) and
    (.name | type == "string" and length > 0) and
    .state == "uploaded" and
    (.size | type == "number" and . > 0 and . <= 2147483648) and
    (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  )) and
  ([.[].size] | add) <= 17179869184 and
  ([.[].id] | length == (unique | length)) and
  ([.[].name] | length == (unique | length))
' "$assets_json" >/dev/null || {
  echo "materialize-durable-package-generation: public asset inventory is malformed or unbounded" >&2
  exit 1
}

generation_size="$(jq -er '
  [.[] | select(.name == "generation.json")] as $matches |
  if (($matches | length) == 1 and $matches[0].size <= 4194304)
  then $matches[0].size
  else empty
  end
' "$assets_json")"
generation_digest="$(jq -er '
  .[] | select(.name == "generation.json") | .digest | sub("^sha256:";"")
' "$assets_json")"
generation_url="https://github.com/$REPOSITORY/releases/download/$TAG/generation.json"
env -u GH_TOKEN -u GITHUB_TOKEN \
  curl --disable --fail --location --silent --show-error \
    --max-filesize "$generation_size" \
    --output "$TMP_ROOT/bundle/generation.json" "$generation_url"

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
file_bytes() {
  wc -c <"$1" | tr -d '[:space:]'
}
if [ "$(file_bytes "$TMP_ROOT/bundle/generation.json")" != "$generation_size" ] ||
   [ "$(sha_file "$TMP_ROOT/bundle/generation.json")" != "$generation_digest" ]; then
  echo "materialize-durable-package-generation: public generation.json differs from GitHub metadata" >&2
  exit 1
fi

manifest="$TMP_ROOT/bundle/generation.json"
# compare-consumer fully validates the canonical manifest before selecting the
# consumer closure. The source-specific xtask computes identities without any
# publication or Actions credentials.
run_without_credentials() {
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    "$@"
}
abi_version="$(jq -er '.identity.abi_version' "$manifest")"
root_package="$(jq -er '.identity.projection.root_package' "$manifest")"
arch="$(jq -er '.identity.projection.arch' "$manifest")"
grep -Fxq "pub const ABI_VERSION: u32 = $abi_version;" \
  "$CONSUMER_ROOT/crates/shared/src/lib.rs" || {
  echo "materialize-durable-package-generation: consumer checkout declares a different ABI" >&2
  exit 1
}
run_without_credentials "$CONSUMER_XTASK" staging-reuse expected \
  --registry "$CONSUMER_ROOT/packages/registry" \
  --expected-abi "$abi_version" \
  --output "$TMP_ROOT/consumer-full-expected.json"
manifest_tag="$(run_without_credentials \
  python3 "$SCRIPT_DIR/package-generation.py" compare-consumer \
    --generation-manifest "$manifest" \
    --program-packages \
      "$CONSUMER_ROOT/packages/registry/program-packages.json" \
    --full-expected-ledger "$TMP_ROOT/consumer-full-expected.json")"
[ "$manifest_tag" = "$TAG" ] || {
  echo "materialize-durable-package-generation: public manifest belongs to another tag" >&2
  exit 1
}
package_source_sha="$(jq -er '.identity.package_source_sha' "$manifest")"
release_title="$(jq -er '.release.title' "$manifest")"
release_body="$(jq -er '.release.body' "$manifest")"
if ! jq -e \
    --arg tag "$TAG" \
    --arg source "$package_source_sha" \
    --arg title "$release_title" \
    --arg body "$release_body" '
      .tag_name == $tag and .target_commitish == $source and
      .name == $title and .body == $body and
      .draft == false and .prerelease == true
    ' "$release_json" >/dev/null ||
   ! jq -e --arg tag "$TAG" --arg source "$package_source_sha" '
      .ref == ("refs/tags/" + $tag) and
      .object.type == "commit" and .object.sha == $source
    ' "$tag_json" >/dev/null
then
  echo "materialize-durable-package-generation: release/tag identity differs from generation.json" >&2
  exit 1
fi

expected_assets="$TMP_ROOT/expected-assets.json"
jq -S '
  [
    {
      name:"generation.json",
      sha256:"",
      bytes:0
    },
    {
      name:.index.name,
      sha256:.index.sha256,
      bytes:.index.bytes
    }
  ] +
  [.identity.archives[] | {name:.name,sha256:.sha256,bytes:.bytes}]
' "$manifest" |
  jq \
    --arg generation_sha "$generation_digest" \
    --argjson generation_bytes "$generation_size" '
      map(
        if .name == "generation.json"
        then .sha256 = $generation_sha | .bytes = $generation_bytes
        else .
        end
      ) | sort_by(.name)
    ' >"$expected_assets"
jq -e --slurpfile expected "$expected_assets" '
  . as $assets |
  ([$assets[].name] | sort) == ([$expected[0][].name] | sort) and
  all($expected[0][];
    . as $wanted |
    ([ $assets[] | select(.name == $wanted.name) ] | length) == 1)
' "$assets_json" >/dev/null

# The jq expression above proves exact names. Check each GitHub digest/size,
# then fetch anonymous bytes so public visibility is part of activation.
while IFS=$'\t' read -r name digest size; do
  jq -e --arg name "$name" --arg digest "sha256:$digest" \
    --argjson size "$size" '
      [.[] | select(.name == $name)] as $matches |
      ($matches | length) == 1 and
      $matches[0].state == "uploaded" and
      $matches[0].size == $size and
      $matches[0].digest == $digest
    ' "$assets_json" >/dev/null
  if [ "$name" != generation.json ]; then
    url="https://github.com/$REPOSITORY/releases/download/$TAG/$name"
    env -u GH_TOKEN -u GITHUB_TOKEN \
      curl --disable --fail --location --silent --show-error \
        --max-filesize "$size" \
        --output "$TMP_ROOT/bundle/$name" "$url"
  fi
  if [ "$(file_bytes "$TMP_ROOT/bundle/$name")" != "$size" ] ||
     [ "$(sha_file "$TMP_ROOT/bundle/$name")" != "$digest" ]; then
    echo "materialize-durable-package-generation: public bytes differ for $name" >&2
    exit 1
  fi
done < <(jq -r '.[] | [.name,.sha256,(.bytes|tostring)] | @tsv' "$expected_assets")

localized_index="$TMP_ROOT/localized-index.toml"
run_without_credentials python3 "$SCRIPT_DIR/package-generation.py" validate \
  --bundle "$TMP_ROOT/bundle" \
  --expected-tag "$TAG" \
  --localized-index-out "$localized_index" >/dev/null
jq -S '.identity.expected_ledger' "$manifest" >"$TMP_ROOT/expected.json"
jq -S '.identity.validated_snapshot' "$manifest" >"$TMP_ROOT/snapshot.json"
run_without_credentials "$AUTHORITY_XTASK" staging-reuse validate-archives \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/snapshot.json" \
  --archives-dir "$TMP_ROOT/bundle" \
  --scope all

# Recheck mutable GitHub metadata after all downloads to close the same race as
# promotion. A changed public release is rejected even if cached bytes remain.
gh api "/repos/$REPOSITORY/releases/tags/$TAG" >"$TMP_ROOT/release-after.json"
gh api "/repos/$REPOSITORY/git/ref/tags/$TAG" >"$TMP_ROOT/tag-after.json"
gh api --paginate --slurp \
  "/repos/$REPOSITORY/releases/$release_id/assets?per_page=100" \
  >"$TMP_ROOT/asset-pages-after.json"
jq '[.[][]] | sort_by(.name) |
  map({id,name,state,size,digest})' "$TMP_ROOT/asset-pages-after.json" \
  >"$TMP_ROOT/assets-after.json"
jq 'sort_by(.name) | map({id,name,state,size,digest})' "$assets_json" \
  >"$TMP_ROOT/assets-before.json"
if ! jq -e \
    --arg tag "$TAG" \
    --arg source "$package_source_sha" \
    --arg title "$release_title" \
    --arg body "$release_body" '
      .tag_name == $tag and .target_commitish == $source and
      .name == $title and .body == $body and
      .draft == false and .prerelease == true
    ' "$TMP_ROOT/release-after.json" >/dev/null ||
   ! jq -e --arg tag "$TAG" --arg source "$package_source_sha" '
      .ref == ("refs/tags/" + $tag) and
      .object.type == "commit" and .object.sha == $source
    ' "$TMP_ROOT/tag-after.json" >/dev/null ||
   ! cmp "$TMP_ROOT/assets-before.json" "$TMP_ROOT/assets-after.json" >/dev/null
then
  echo "materialize-durable-package-generation: release identity changed during materialization" >&2
  exit 1
fi

mkdir "$TMP_ROOT/output" "$TMP_ROOT/output/resolver"
cp "$localized_index" "$TMP_ROOT/output/resolver/index.toml"
while IFS= read -r name; do
  ln "$TMP_ROOT/bundle/$name" "$TMP_ROOT/output/resolver/$name"
done < <(jq -r '.identity.archives[].name' "$manifest")
mv "$TMP_ROOT/bundle" "$TMP_ROOT/output/release"
printf 'file://%s/resolver/index.toml\n' "$OUTPUT_DIR" \
  >"$TMP_ROOT/output/index-url.txt"
mv "$TMP_ROOT/output" "$OUTPUT_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT
echo "materialize-durable-package-generation: activated $TAG for consumer $CONSUMER_SHA ($root_package $arch ABI $abi_version)"
