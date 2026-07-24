#!/usr/bin/env bash
# Validate a same-run sealed generation artifact and expose its local index.
set -euo pipefail

BUNDLE=""
EXPECTED_TAG=""
EXPECTED_GENERATION_SHA=""
EXPECTED_CONSUMER_SHA=""
EXPECTED_ABI=""
GITHUB_ENV_FILE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    --expected-tag) EXPECTED_TAG="$2"; shift 2 ;;
    --expected-generation-sha) EXPECTED_GENERATION_SHA="$2"; shift 2 ;;
    --expected-consumer-sha) EXPECTED_CONSUMER_SHA="$2"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="$2"; shift 2 ;;
    --github-env) GITHUB_ENV_FILE="$2"; shift 2 ;;
    *) echo "activate-homebrew-prepublication-generation: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$BUNDLE" ] || [ -L "$BUNDLE" ] ||
   ! [[ "$EXPECTED_TAG" =~ ^pr-[1-9][0-9]*-staging$ ]] ||
   ! [[ "$EXPECTED_GENERATION_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$EXPECTED_CONSUMER_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
   [ -z "$GITHUB_ENV_FILE" ]; then
  echo "activate-homebrew-prepublication-generation: exact bundle, tag, SHAs, ABI, and GITHUB_ENV are required" >&2
  exit 2
fi
for name in index.toml manifest.json projection.json expected-ledger.json snapshot.json assets.json; do
  [ -f "$BUNDLE/$name" ] && [ ! -L "$BUNDLE/$name" ] || {
    echo "activate-homebrew-prepublication-generation: missing regular $name" >&2
    exit 2
  }
done

manifest="$BUNDLE/manifest.json"
jq -e \
  --arg tag "$EXPECTED_TAG" \
  --arg generation "$EXPECTED_GENERATION_SHA" \
  --arg consumer "$EXPECTED_CONSUMER_SHA" \
  --argjson abi "$EXPECTED_ABI" '
    keys == [
      "abi_version", "consumer_sha", "files", "generation_sha",
      "package_count", "repository", "schema", "staging_tag"
    ] and
    .schema == 2 and
    .repository == "Automattic/kandelo" and
    .staging_tag == $tag and
    .generation_sha == $generation and
    .consumer_sha == $consumer and
    .abi_version == $abi and
    (.package_count | type == "number" and . > 1 and floor == .) and
    (.files | keys) == [
      "assets.json", "expected-ledger.json", "index.toml",
      "projection.json", "snapshot.json"
    ] and
    all(.files[]; (
      keys == ["sha256", "size"] and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.size | type == "number" and . > 0 and floor == .)
    ))
  ' "$manifest" >/dev/null || {
  echo "activate-homebrew-prepublication-generation: manifest does not bind the planned generation" >&2
  exit 1
}

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
for name in index.toml projection.json expected-ledger.json snapshot.json assets.json; do
  actual_sha="$(sha_file "$BUNDLE/$name")"
  actual_size="$(wc -c <"$BUNDLE/$name" | tr -d '[:space:]')"
  expected_sha="$(jq -r --arg name "$name" '.files[$name].sha256' "$manifest")"
  expected_size="$(jq -r --arg name "$name" '.files[$name].size' "$manifest")"
  [ "$actual_sha" = "$expected_sha" ] && [ "$actual_size" = "$expected_size" ] || {
    echo "activate-homebrew-prepublication-generation: $name differs from the sealed manifest" >&2
    exit 1
  }
done

package_count="$(jq -r '.package_count' "$manifest")"
jq -e --argjson count "$package_count" '
  .schema == 1 and
  (.entries | length) == $count and
  all(.entries[]; (
    keys == ["arch", "cache_key_sha", "manifest_sha256", "package"] and
    (.package | type == "string" and test("^[a-z0-9][a-z0-9._-]*$")) and
    .arch == "wasm32" and
    (.cache_key_sha | type == "string" and test("^[0-9a-f]{64}$")) and
    (.manifest_sha256 | type == "string" and test("^[0-9a-f]{64}$"))
  )) and
  ([.entries[] | [.package, .arch, .cache_key_sha]] |
    length == (unique | length))
' "$BUNDLE/projection.json" >/dev/null || {
  echo "activate-homebrew-prepublication-generation: invalid sealed package projection" >&2
  exit 1
}
jq -e --argjson count "$package_count" --argjson abi "$EXPECTED_ABI" '
  .abi_version == $abi and
  (.entries | length) == $count and
  all(.entries[]; (
    (.package | type == "string" and test("^[a-z0-9][a-z0-9._-]*$")) and
    .arch == "wasm32" and
    (.cache_key_sha | type == "string" and test("^[0-9a-f]{64}$"))
  )) and
  ([.entries[] | [.package, .arch, .cache_key_sha]] |
    length == (unique | length))
' "$BUNDLE/expected-ledger.json" >/dev/null || {
  echo "activate-homebrew-prepublication-generation: invalid sealed expected ledger" >&2
  exit 1
}
jq -e --argjson count "$package_count" --argjson abi "$EXPECTED_ABI" \
  --arg tag "$EXPECTED_TAG" '
    .abi_version == $abi and .release_tag == $tag and
    .complete_current == true and
    (.entries | length) == $count and
    all(.entries[]; (
      .current == true and
      (.package | type == "string" and test("^[a-z0-9][a-z0-9._-]*$")) and
      .arch == "wasm32" and
      (.cache_key_sha | type == "string" and test("^[0-9a-f]{64}$")) and
      (.asset | type == "string" and
        test("^[A-Za-z0-9][A-Za-z0-9._-]*\\.tar\\.zst$")) and
      (.archive_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.size | type == "number" and . > 0 and floor == .)
    )) and
    ([.entries[] | [.package, .arch, .cache_key_sha]] |
      length == (unique | length))
  ' "$BUNDLE/snapshot.json" >/dev/null || {
  echo "activate-homebrew-prepublication-generation: invalid sealed staging snapshot" >&2
  exit 1
}
jq -e '
  type == "array" and
  all(.[]; (
    (.name | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
    (.state | type == "string") and
    (.size | type == "number" and . >= 0 and floor == .) and
    ((.digest == null) or
      (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")))
  )) and
  ([.[].name] | length == (unique | length))
' "$BUNDLE/assets.json" >/dev/null || {
  echo "activate-homebrew-prepublication-generation: invalid sealed release asset inventory" >&2
  exit 1
}

identity_root="$(mktemp -d)"
trap 'rm -rf "$identity_root"' EXIT
identity_set() {
  jq -r '.entries[] | [.package, .arch, .cache_key_sha] | @tsv' "$1" |
    LC_ALL=C sort >"$2"
}
identity_set "$BUNDLE/projection.json" "$identity_root/projection"
identity_set "$BUNDLE/expected-ledger.json" "$identity_root/expected"
identity_set "$BUNDLE/snapshot.json" "$identity_root/snapshot"
if ! cmp "$identity_root/projection" "$identity_root/expected" >/dev/null ||
   ! cmp "$identity_root/projection" "$identity_root/snapshot" >/dev/null; then
  echo "activate-homebrew-prepublication-generation: sealed package identities disagree" >&2
  exit 1
fi

jq -e --slurpfile assets "$BUNDLE/assets.json" '
  all(.entries[];
    . as $entry |
      (([ $assets[0][] | select(.name == $entry.asset) ] | length) == 1 and
       ([ $assets[0][] | select(.name == $entry.asset) ][0] |
         .state == "uploaded" and
         .size == $entry.size and
         .digest == ("sha256:" + $entry.archive_sha256))))
' "$BUNDLE/snapshot.json" >/dev/null || {
  echo "activate-homebrew-prepublication-generation: sealed snapshot assets disagree" >&2
  exit 1
}

index_path="$(cd "$BUNDLE" && pwd)/index.toml"
printf 'WASM_POSIX_BINARY_INDEX_URL=file://%s\n' "$index_path" >>"$GITHUB_ENV_FILE"
rm -rf "$identity_root"
trap - EXIT
echo "activate-homebrew-prepublication-generation: using file://$index_path"
