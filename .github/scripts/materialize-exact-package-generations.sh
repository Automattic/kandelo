#!/usr/bin/env bash
# Materialize one or two architecture-specific durable generations into the
# only resolver index/cache that a canonical producer is allowed to consume.
set -euo pipefail

WASM32_TAG=""
WASM64_TAG=""
SELECTION_KIND=""
CONSUMER_ROOT=""
CONSUMER_SHA=""
AUTHORITY_XTASK=""
REPOSITORY=""
OUTPUT_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --wasm32-tag) WASM32_TAG="$2"; shift 2 ;;
    --wasm64-tag) WASM64_TAG="$2"; shift 2 ;;
    --selection-kind) SELECTION_KIND="$2"; shift 2 ;;
    --consumer-root) CONSUMER_ROOT="$2"; shift 2 ;;
    --consumer-sha) CONSUMER_SHA="$2"; shift 2 ;;
    --authority-xtask) AUTHORITY_XTASK="$2"; shift 2 ;;
    --repository) REPOSITORY="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *)
      echo "materialize-exact-package-generations: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

case "$SELECTION_KIND" in
  browser-inputs)
    if ! [[ "$WASM32_TAG" =~ ^package-generation-browser-inputs-wasm32-abi-v[1-9][0-9]*-sha256-[0-9a-f]{64}$ ]] ||
       { [ -n "$WASM64_TAG" ] &&
         ! [[ "$WASM64_TAG" =~ ^package-generation-browser-inputs-wasm64-abi-v[1-9][0-9]*-sha256-[0-9a-f]{64}$ ]]; }; then
      echo "materialize-exact-package-generations: browser-inputs requires architecture-bound browser-inputs content tags" >&2
      exit 2
    fi
    ;;
  rootfs-wasm32)
    # WHY: schema-1 rootfs is the deliberately narrow recovery input for the
    # first Bash/Dinit/M4 bottle wave. Requiring an explicit selection kind
    # prevents a caller from relabeling it as the wider browser-input
    # generation.
    if ! [[ "$WASM32_TAG" =~ ^package-generation-rootfs-wasm32-abi-v[1-9][0-9]*-sha256-[0-9a-f]{64}$ ]] ||
       [ -n "$WASM64_TAG" ]; then
      echo "materialize-exact-package-generations: rootfs-wasm32 requires one rootfs wasm32 content tag and no wasm64 tag" >&2
      exit 2
    fi
    ;;
  *)
    echo "materialize-exact-package-generations: --selection-kind must be browser-inputs or rootfs-wasm32" >&2
    exit 2
    ;;
esac

if ! [[ "$CONSUMER_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   [ "$REPOSITORY" != "Automattic/kandelo" ] ||
   [ ! -d "$CONSUMER_ROOT" ] || [ -L "$CONSUMER_ROOT" ] ||
   [ ! -f "$AUTHORITY_XTASK" ] || [ -L "$AUTHORITY_XTASK" ] ||
   [ ! -x "$AUTHORITY_XTASK" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ]; then
  echo "materialize-exact-package-generations: exact generation, consumer, authority, repository, and output are required" >&2
  exit 2
fi
if [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  echo "materialize-exact-package-generations: output already exists: $OUTPUT_DIR" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$PARENT"
TMP_ROOT="$(mktemp -d "$PARENT/.exact-package-generations.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

materialize_generation() {
  local tag="$1"
  local output="$2"
  bash "$SCRIPT_DIR/materialize-durable-package-generation.sh" \
    --tag "$tag" \
    --consumer-root "$CONSUMER_ROOT" \
    --consumer-sha "$CONSUMER_SHA" \
    --authority-xtask "$AUTHORITY_XTASK" \
    --repository "$REPOSITORY" \
    --required-package-source-sha "$CONSUMER_SHA" \
    --output-dir "$output"
}

materialize_generation "$WASM32_TAG" "$TMP_ROOT/wasm32"
if [ -n "$WASM64_TAG" ]; then
  materialize_generation "$WASM64_TAG" "$TMP_ROOT/wasm64"
fi

mkdir -p "$TMP_ROOT/output/resolver" "$TMP_ROOT/output/generations"
cp "$TMP_ROOT/wasm32/release/generation.json" \
  "$TMP_ROOT/output/generations/wasm32.json"
cp "$TMP_ROOT/wasm32/package-generation-input.json" \
  "$TMP_ROOT/output/generations/wasm32.input.json"

if [ -n "$WASM64_TAG" ]; then
  cp "$TMP_ROOT/wasm64/release/generation.json" \
    "$TMP_ROOT/output/generations/wasm64.json"
  cp "$TMP_ROOT/wasm64/package-generation-input.json" \
    "$TMP_ROOT/output/generations/wasm64.input.json"
  jq -S '.identity.expected_ledger' \
    "$TMP_ROOT/wasm64/release/generation.json" \
    >"$TMP_ROOT/wasm64-expected.json"
  # WHY: the resolver accepts one index URL, while durable generations are
  # architecture-specific. Compose only the two independently validated local
  # indexes; consulting the mutable canonical index here could silently add an
  # archive that was not sealed for this exact main commit.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    -u ACTIONS_RUNTIME_TOKEN \
    -u WASM_POSIX_DEPS_REGISTRY \
    "$AUTHORITY_XTASK" staging-reuse compose \
      --base-index "$TMP_ROOT/wasm32/resolver/index.toml" \
      --overlay-index "$TMP_ROOT/wasm64/resolver/index.toml" \
      --overlay-expected-ledger "$TMP_ROOT/wasm64-expected.json" \
      --output "$TMP_ROOT/output/resolver/index.toml"
else
  cp "$TMP_ROOT/wasm32/resolver/index.toml" \
    "$TMP_ROOT/output/resolver/index.toml"
fi

link_generation_archives() {
  local resolver="$1"
  local archive
  while IFS= read -r -d '' archive; do
    local name="${archive##*/}"
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*\.tar\.zst$ ]] || {
      echo "materialize-exact-package-generations: invalid archive name: $name" >&2
      exit 1
    }
    [ ! -e "$TMP_ROOT/output/resolver/$name" ] &&
      [ ! -L "$TMP_ROOT/output/resolver/$name" ] || {
      echo "materialize-exact-package-generations: duplicate archive name: $name" >&2
      exit 1
    }
    ln "$archive" "$TMP_ROOT/output/resolver/$name"
  done < <(
    find "$resolver" -mindepth 1 -maxdepth 1 -type f \
      ! -name index.toml -print0
  )
}

link_generation_archives "$TMP_ROOT/wasm32/resolver"
if [ -n "$WASM64_TAG" ]; then
  link_generation_archives "$TMP_ROOT/wasm64/resolver"
fi

while IFS= read -r archive_name; do
  [ -f "$TMP_ROOT/output/resolver/$archive_name" ] &&
    [ ! -L "$TMP_ROOT/output/resolver/$archive_name" ] || {
    echo "materialize-exact-package-generations: composed index lacks $archive_name" >&2
    exit 1
  }
done < <(
  sed -nE 's/^archive_url = "([^"]+)"$/\1/p' \
    "$TMP_ROOT/output/resolver/index.toml"
)

printf 'file://%s/resolver/index.toml\n' "$OUTPUT_DIR" \
  >"$TMP_ROOT/output/index-url.txt"
mv "$TMP_ROOT/output" "$OUTPUT_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT
echo "materialize-exact-package-generations: activated exact-main resolver at $OUTPUT_DIR"
