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

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
export WASM_POSIX_DEPS_REGISTRY="$PACKAGE_SOURCE_ROOT/packages:$KANDELO_ROOT/packages/registry"
cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
  build-deps program-index-context-check

"$KANDELO_ROOT/scripts/sync-package-source.sh" \
  --package-source-root "$PACKAGE_SOURCE_ROOT" \
  --kandelo-root "$KANDELO_ROOT"

ABI="$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')"
TARGET_TAG="${TARGET_TAG:-binaries-abi-v${ABI}}"
BUILD_TIMESTAMP="$(git -C "$PACKAGE_SOURCE_ROOT" log -1 --format=%aI HEAD)"
BUILD_COMMIT="$(git -C "$PACKAGE_SOURCE_ROOT" rev-parse HEAD)"
if ! [[ "$BUILD_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "publish-package-source: package source must be an exact Git commit" >&2
  exit 2
fi
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

publication_ledger_for_roots() {
  local roots="$1"
  local output="$2"
  local blocked_output="${3:-}"
  local args=(
    staging-reuse expected
    --registry "$KANDELO_ROOT/packages/registry"
    --expected-abi "$ABI"
    --require-root "$roots"
    --output "$output"
  )
  if [ -n "$blocked_output" ]; then
    args+=(--blocked-output "$blocked_output")
  fi
  cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
    "${args[@]}"
}

# WHY: establish policy before any package or gallery asset can be uploaded.
# A named selection fails as one batch when blocked; `all` uses the same
# policy-filtered ledger semantics as force-rebuild. The archive writer then
# independently rechecks each admitted package.
REQUESTED_PACKAGES=()
while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  want_pkg "$pkg" || continue
  REQUESTED_PACKAGES+=("$pkg")
done < <(read_package_list)
[ "${#REQUESTED_PACKAGES[@]}" -gt 0 ] || {
  echo "publish-package-source: package selection is empty" >&2
  exit 1
}
if [ "$PACKAGE_SELECTION" = "all" ] || [ -z "$PACKAGE_SELECTION" ]; then
  policy_roots="all"
else
  policy_roots="$(IFS=,; echo "${REQUESTED_PACKAGES[*]}")"
fi
PUBLICATION_EXPECTED="$(mktemp "${RUNNER_TEMP:-/tmp}/package-publication-expected.XXXXXX")"
PUBLICATION_BLOCKERS="$(mktemp "${RUNNER_TEMP:-/tmp}/package-publication-blockers.XXXXXX")"
if ! publication_ledger_for_roots \
  "$policy_roots" "$PUBLICATION_EXPECTED" "$PUBLICATION_BLOCKERS"
then
  echo "publish-package-source: selected package publication is not admitted" >&2
  exit 1
fi
jq -e --argjson abi "$ABI" '
  type == "object" and
  keys == ["abi_version", "entries"] and
  .abi_version == $abi and
  (.entries | type) == "array" and
  ([.entries[].package] | length) ==
    ([.entries[].package] | unique | length) and
  all(.entries[];
    type == "object" and
    keys == ["blocker_chain", "package"] and
    (.package | type) == "string" and
    (.blocker_chain | type) == "array" and
    (.blocker_chain | length) > 0 and
    .blocker_chain[0] == .package and
    all(.blocker_chain[]; type == "string" and length > 0)
  )
' "$PUBLICATION_BLOCKERS" >/dev/null || {
  echo "publish-package-source: publication blocker report is malformed" >&2
  exit 1
}
SELECTED_PACKAGES=()
for pkg in "${REQUESTED_PACKAGES[@]}"; do
  pkg_dir="$KANDELO_ROOT/packages/registry/$pkg"
  [ -d "$pkg_dir" ] && [ -f "$pkg_dir/package.toml" ] &&
    [ -f "$pkg_dir/build.toml" ] || {
      echo "publish-package-source: requested package $pkg is missing publishable metadata after sync" >&2
      exit 1
    }
  if jq -e --arg package "$pkg" \
    'any(.entries[]; .package == $package)' \
    "$PUBLICATION_EXPECTED" >/dev/null
  then
    SELECTED_PACKAGES+=("$pkg")
  elif [ "$policy_roots" = "all" ] &&
    jq -e --arg package "$pkg" \
      'any(.entries[]; .package == $package)' \
      "$PUBLICATION_BLOCKERS" >/dev/null
  then
    blocker_chain="$(jq -r --arg package "$pkg" '
      first(.entries[] | select(.package == $package) | .blocker_chain) |
      join(" -> ")
    ' "$PUBLICATION_BLOCKERS")"
    echo "publish-package-source: omit $pkg (blocked by $blocker_chain)"
  else
    echo "publish-package-source: selected package $pkg has no publishable ledger entry" >&2
    exit 1
  fi
done
[ "${#SELECTED_PACKAGES[@]}" -gt 0 ] || {
  echo "publish-package-source: publication ledger selection is empty" >&2
  exit 1
}

publication_selected() {
  local wanted="$1"
  local selected
  for selected in "${SELECTED_PACKAGES[@]}"; do
    [ "$selected" = "$wanted" ] && return 0
  done
  return 1
}

build_publish_one() {
  local pkg="$1"
  local version="$2"
  local revision="$3"
  local arch="$4"
  local pkg_dir="$KANDELO_ROOT/packages/registry/$pkg"

  local sha short suffix out_dir archive_path archive_name policy_recheck
  jq -e \
    --arg package "$pkg" \
    --arg arch "$arch" \
    'any(.entries[]; .package == $package and .arch == $arch)' \
    "$PUBLICATION_EXPECTED" >/dev/null || {
      # WHY: a selected package/arch missing from the shared policy ledger is
      # not a build failure and must never create a failed canonical entry.
      echo "publish-package-source: $pkg/$arch is not admitted for publication" >&2
      exit 1
    }
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
      --binaries-dir "$KANDELO_ROOT/binaries" \
      --out "$out_dir" \
      --build-timestamp "$BUILD_TIMESTAMP" \
      --build-host "$BUILD_HOST" \
      --source-repository "https://github.com/${REPOSITORY}" \
      --source-commit "$BUILD_COMMIT" \
      --expected-cache-key-sha "$sha"
  then
    policy_recheck="$(mktemp "${RUNNER_TEMP:-/tmp}/package-publication-recheck.XXXXXX")"
    if ! publication_ledger_for_roots "$pkg" "$policy_recheck" ||
      ! jq -e \
        --arg package "$pkg" \
        --arg arch "$arch" \
        'any(.entries[]; .package == $package and .arch == $arch)' \
        "$policy_recheck" >/dev/null
    then
      rm -f "$policy_recheck"
      echo "publish-package-source: could not prove $pkg/$arch remains admitted; canonical index left unchanged" >&2
      return 1
    fi
    rm -f "$policy_recheck"
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
  publication_selected "$pkg" || continue

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

rm -f "$PUBLICATION_EXPECTED" "$PUBLICATION_BLOCKERS"
