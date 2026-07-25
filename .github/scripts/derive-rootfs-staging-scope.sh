#!/usr/bin/env bash
# Derive the exact wasm32 package generation needed to build rootfs.
set -euo pipefail

REPO_ROOT=""
XTASK=""
OUTPUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --xtask) XTASK="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *)
      echo "derive-rootfs-staging-scope: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ] || [ -L "$REPO_ROOT" ] ||
   [ -z "$XTASK" ] || [ ! -f "$XTASK" ] || [ -L "$XTASK" ] || [ ! -x "$XTASK" ] ||
   [ -z "$OUTPUT" ] || [ "$OUTPUT" = / ]; then
  echo "derive-rootfs-staging-scope: regular repo root, xtask, and output are required" >&2
  exit 2
fi

REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
REGISTRY="$REPO_ROOT/packages/registry"
PROGRAM_INDEX="$REGISTRY/program-packages.json"
OUTPUT_PARENT="$(dirname "$OUTPUT")"

if [ ! -d "$REGISTRY" ] || [ -L "$REGISTRY" ] ||
   [ ! -f "$PROGRAM_INDEX" ] || [ -L "$PROGRAM_INDEX" ] ||
   [ ! -d "$OUTPUT_PARENT" ] || [ -L "$OUTPUT_PARENT" ] ||
   [ -e "$OUTPUT" ] || [ -L "$OUTPUT" ]; then
  echo "derive-rootfs-staging-scope: registry/index must be regular and output must be new" >&2
  exit 2
fi

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

index_sha_before="$(sha_file "$PROGRAM_INDEX")"

# WHY: this scope is an acceleration boundary, not an alternate source of
# package identity. Refuse a stale committed projection before selecting fewer
# builds, or an omitted generation could be mistaken for a current one.
WASM_POSIX_DEPS_REGISTRY="$REGISTRY" \
  "$XTASK" build-deps program-index-context-check \
    --source-repo-root "$REPO_ROOT"

index_sha_after="$(sha_file "$PROGRAM_INDEX")"
if [ "$index_sha_before" != "$index_sha_after" ]; then
  echo "derive-rootfs-staging-scope: program package index changed during validation" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "$OUTPUT_PARENT/.rootfs-staging-scope.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
cp "$PROGRAM_INDEX" "$TMP_ROOT/program-packages.json"
if [ "$(sha_file "$TMP_ROOT/program-packages.json")" != "$index_sha_before" ]; then
  echo "derive-rootfs-staging-scope: could not snapshot the validated program package index" >&2
  exit 1
fi

jq -e '
  def hex256:
    type == "string" and test("^[0-9a-f]{64}$");
  def package_name:
    type == "string" and test("^[a-z0-9][a-z0-9._-]*$");
  . as $index |
  $index.format == "kandelo-program-packages-v2" and
  ($index.identities | type == "object") and
  ($index.packages | type == "object") and
  ($index.packages.rootfs | type == "object") and
  ($index.packages.rootfs.arches == ["wasm32"]) and
  (($index.packages.rootfs.cacheKeys | keys) == ["wasm32"]) and
  (($index.packages.rootfs.dependencyClosures | keys) == ["wasm32"]) and
  ($index.packages.rootfs.manifestSha256 | hex256) and
  ($index.packages.rootfs.cacheKeys.wasm32 | hex256) and
  ($index.packages.rootfs.dependencyClosures.wasm32 |
    type == "array" and length > 0) and
  ($index.identities.rootfs.manifestSha256 ==
    $index.packages.rootfs.manifestSha256) and
  ($index.identities.rootfs.cacheKeys.wasm32 ==
    $index.packages.rootfs.cacheKeys.wasm32) and
  all($index.packages.rootfs.dependencyClosures.wasm32[];
    . as $dependency |
    (($dependency | keys) ==
      ["cacheKey", "manifestSha256", "packageName"]) and
    ($dependency.packageName | package_name) and
    ($dependency.packageName != "rootfs") and
    ($dependency.manifestSha256 | hex256) and
    ($dependency.cacheKey | hex256) and
    ($index.packages[$dependency.packageName] | type == "object") and
    ($index.packages[$dependency.packageName].arches | index("wasm32") != null) and
    ($index.packages[$dependency.packageName].manifestSha256 ==
      $dependency.manifestSha256) and
    ($index.packages[$dependency.packageName].cacheKeys.wasm32 ==
      $dependency.cacheKey) and
    ($index.identities[$dependency.packageName].manifestSha256 ==
      $dependency.manifestSha256) and
    ($index.identities[$dependency.packageName].cacheKeys.wasm32 ==
      $dependency.cacheKey)
  ) and
  (
    [$index.packages.rootfs.dependencyClosures.wasm32[].packageName] |
    length == (unique | length)
  )
' "$TMP_ROOT/program-packages.json" >/dev/null || {
  echo "derive-rootfs-staging-scope: invalid rootfs wasm32 projection" >&2
  exit 1
}

jq -S --arg source_index_sha256 "$index_sha_before" '
  {
    format: "kandelo-rootfs-staging-scope-v1",
    source_index_sha256: $source_index_sha256,
    root_package: "rootfs",
    arch: "wasm32",
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
' "$TMP_ROOT/program-packages.json" >"$TMP_ROOT/scope.json"

jq -e '
  (keys == [
    "arch",
    "entries",
    "format",
    "root_package",
    "source_index_sha256"
  ]) and
  .format == "kandelo-rootfs-staging-scope-v1" and
  .root_package == "rootfs" and
  .arch == "wasm32" and
  (.source_index_sha256 |
    type == "string" and test("^[0-9a-f]{64}$")) and
  (.entries | length > 1) and
  all(.entries[];
    (.arch == "wasm32") and
    (.package | type == "string" and
      test("^[a-z0-9][a-z0-9._-]*$")) and
    (.manifest_sha256 | type == "string" and
      test("^[0-9a-f]{64}$")) and
    (.cache_key_sha | type == "string" and
      test("^[0-9a-f]{64}$"))
  ) and
  ([.entries[] | [.package, .arch]] |
    length == (unique | length))
' "$TMP_ROOT/scope.json" >/dev/null || {
  echo "derive-rootfs-staging-scope: derived an invalid staging scope" >&2
  exit 1
}

mv "$TMP_ROOT/scope.json" "$OUTPUT"
count="$(jq -r '.entries | length' "$OUTPUT")"
echo "derive-rootfs-staging-scope: selected $count wasm32 package generations" >&2
