#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/publish-package-source.sh --package-source-root <dir> --kandelo-root <dir> [options]

Options:
  --packages <csv|all>      Packages to publish. Default: all.
  --target-tag <tag>        Release tag. Default: binaries-abi-v<ABI_VERSION>.
  --repo <owner/name>       GitHub release repository. Default: $GITHUB_REPOSITORY.
  --package-list <path>     Ordered package list. Default: <source>/packages.txt.

Builds packages from an external Kandelo package source and publishes archives
plus index.toml to a GitHub release. Run inside Kandelo's dev shell.
EOF
}

PACKAGE_SOURCE_ROOT=""
KANDELO_ROOT=""
PACKAGE_SELECTION="all"
TARGET_TAG=""
REPOSITORY="${GITHUB_REPOSITORY:-}"
PACKAGE_LIST=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package-source-root) PACKAGE_SOURCE_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --kandelo-root) KANDELO_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --packages) PACKAGE_SELECTION="$2"; shift 2 ;;
    --target-tag) TARGET_TAG="$2"; shift 2 ;;
    --repo) REPOSITORY="$2"; shift 2 ;;
    --package-list) PACKAGE_LIST="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "publish-package-source: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "publish-package-source: --$name is required" >&2
    usage
    exit 2
  fi
}

require package-source-root "$PACKAGE_SOURCE_ROOT"
require kandelo-root "$KANDELO_ROOT"
require repo "$REPOSITORY"

PACKAGE_LIST="${PACKAGE_LIST:-$PACKAGE_SOURCE_ROOT/packages.txt}"
[ -f "$PACKAGE_LIST" ] || {
  echo "publish-package-source: package list not found: $PACKAGE_LIST" >&2
  exit 2
}

cd "$KANDELO_ROOT"
source "$KANDELO_ROOT/sdk/activate.sh"

"$KANDELO_ROOT/scripts/sync-package-source.sh" \
  --package-source-root "$PACKAGE_SOURCE_ROOT" \
  --kandelo-root "$KANDELO_ROOT"

ABI="$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')"
TARGET_TAG="${TARGET_TAG:-binaries-abi-v${ABI}}"
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
BUILD_TIMESTAMP="$(git -C "$PACKAGE_SOURCE_ROOT" log -1 --format=%aI HEAD 2>/dev/null || date -u +%FT%TZ)"
BUILD_COMMIT="$(git -C "$PACKAGE_SOURCE_ROOT" rev-parse HEAD 2>/dev/null || echo local)"
BUILD_HOST="${REPOSITORY}@${BUILD_COMMIT}"

export GITHUB_REPOSITORY="$REPOSITORY"
export GITHUB_SHA="${GITHUB_SHA:-$BUILD_COMMIT}"

echo "publish-package-source: Kandelo ABI $ABI"
echo "publish-package-source: target release $REPOSITORY/$TARGET_TAG"

want_pkg() {
  local pkg="$1"
  if [ "$PACKAGE_SELECTION" = "all" ] || [ -z "$PACKAGE_SELECTION" ]; then
    return 0
  fi
  local normalized
  normalized="$(printf '%s' "$PACKAGE_SELECTION" | tr ',' ' ')"
  [[ " $normalized " == *" $pkg "* ]]
}

read_package_list() {
  sed -E 's/#.*$//' "$PACKAGE_LIST" | awk 'NF {print $1}'
}

build_publish_one() {
  local pkg="$1"
  local version="$2"
  local revision="$3"
  local arch="$4"
  local pkg_dir="$KANDELO_ROOT/packages/registry/$pkg"

  local sha short suffix out_dir archive_path archive_name
  sha="$(cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
    compute-cache-key-sha --package "$pkg_dir" --arch "$arch")"
  short="${sha:0:8}"
  suffix="-abi${ABI}-${arch}-${short}.tar.zst"

  if gh release view "$TARGET_TAG" --repo "$REPOSITORY" --json assets --jq '[.assets[].name]' 2>/dev/null \
      | jq -e --arg pre "${pkg}-" --arg suf "$suffix" 'any(.[]; startswith($pre) and endswith($suf))' >/dev/null; then
    echo "publish-package-source: skip $pkg/$arch ($short already published)"
    return 0
  fi

  out_dir="${RUNNER_TEMP:-/tmp}/kandelo-package-source-staged/$pkg-$arch"
  rm -rf "$out_dir"
  mkdir -p "$out_dir"

  echo "publish-package-source: staging $pkg $version rev$revision $arch"
  if ! cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
    archive-stage \
      --package "$pkg_dir" \
      --arch "$arch" \
      --out "$out_dir" \
      --build-timestamp "$BUILD_TIMESTAMP" \
      --build-host "$BUILD_HOST" \
      --expected-cache-key-sha "$sha"
  then
    bash "$KANDELO_ROOT/scripts/index-update.sh" \
      --target-tag "$TARGET_TAG" \
      --package "$pkg" \
      --version "$version" \
      --revision "$revision" \
      --arch "$arch" \
      --status failed \
      --error "archive-stage failed for $pkg/$arch"
    return 1
  fi

  archive_path="$(find "$out_dir" -name '*.tar.zst' -print -quit)"
  if [ -z "$archive_path" ]; then
    echo "publish-package-source: no archive produced for $pkg/$arch" >&2
    return 1
  fi
  archive_name="$(basename "$archive_path")"

  bash "$KANDELO_ROOT/scripts/index-update.sh" \
    --target-tag "$TARGET_TAG" \
    --package "$pkg" \
    --version "$version" \
    --revision "$revision" \
    --arch "$arch" \
    --status success \
    --archive-path "$archive_path" \
    --archive-name "$archive_name" \
    --cache-key-sha "$sha"
}

FAILED=()
while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  want_pkg "$pkg" || continue

  pkg_dir="$KANDELO_ROOT/packages/registry/$pkg"
  [ -d "$pkg_dir" ] || {
    echo "publish-package-source: package missing after sync: $pkg" >&2
    exit 1
  }

  version="$(sed -nE 's/^version *= *"([^"]+)".*/\1/p' "$pkg_dir/package.toml" | head -1)"
  revision="$(sed -nE 's/^revision *= *([0-9]+).*/\1/p' "$pkg_dir/build.toml" | head -1)"
  revision="${revision:-1}"
  arches="$(awk -F'[][]' '/^arches *=/ {print $2}' "$pkg_dir/package.toml" | tr -d ' "' | tr ',' ' ')"
  arches="${arches:-wasm32}"

  for arch in $arches; do
    if ! build_publish_one "$pkg" "$version" "$revision" "$arch"; then
      echo "publish-package-source: WARN $pkg/$arch failed; continuing" >&2
      FAILED+=("$pkg/$arch")
    fi
  done
done < <(read_package_list)

if [ -f "$PACKAGE_SOURCE_ROOT/gallery.json" ]; then
  if gh release view "$TARGET_TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
    gh release upload "$TARGET_TAG" --repo "$REPOSITORY" --clobber "$PACKAGE_SOURCE_ROOT/gallery.json"
    echo "publish-package-source: uploaded gallery.json"
  else
    echo "publish-package-source: gallery.json not uploaded because $TARGET_TAG does not exist yet" >&2
  fi
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "publish-package-source: ${#FAILED[@]} package build(s) failed:" >&2
  printf '  %s\n' "${FAILED[@]}" >&2
  exit 1
fi
