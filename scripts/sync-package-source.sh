#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/sync-package-source.sh --package-source-root <dir> --kandelo-root <dir>

Copies an external Kandelo package source's packages/* directories into a
Kandelo checkout's packages/registry/. Intended for CI or throwaway worktrees.
If a package still references examples/libs/ in its TOML files, the package is
also mirrored there for compatibility with older package-source recipes.
EOF
}

PACKAGE_SOURCE_ROOT=""
KANDELO_ROOT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package-source-root) PACKAGE_SOURCE_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --kandelo-root) KANDELO_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "sync-package-source: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$PACKAGE_SOURCE_ROOT" ] || [ -z "$KANDELO_ROOT" ]; then
  usage
  exit 2
fi

SOURCE_PACKAGES="$PACKAGE_SOURCE_ROOT/packages"
DEST_REGISTRY="$KANDELO_ROOT/packages/registry"

[ -d "$SOURCE_PACKAGES" ] || {
  echo "sync-package-source: package source has no packages/ directory: $SOURCE_PACKAGES" >&2
  exit 2
}
[ -d "$DEST_REGISTRY" ] || {
  echo "sync-package-source: Kandelo checkout has no packages/registry/: $DEST_REGISTRY" >&2
  exit 2
}

for pkg_dir in "$SOURCE_PACKAGES"/*; do
  [ -d "$pkg_dir" ] || continue
  pkg="$(basename "$pkg_dir")"
  dest="$DEST_REGISTRY/$pkg"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$pkg_dir"/. "$dest"/
  find "$dest" -name 'build-*.sh' -exec chmod +x {} +
  echo "sync-package-source: overlaid $pkg"

  if grep -Rqs 'examples/libs/' "$dest/package.toml" "$dest/build.toml" 2>/dev/null; then
    legacy_dest="$KANDELO_ROOT/examples/libs/$pkg"
    rm -rf "$legacy_dest"
    mkdir -p "$legacy_dest"
    cp -R "$pkg_dir"/. "$legacy_dest"/
    find "$legacy_dest" -name 'build-*.sh' -exec chmod +x {} +
    echo "sync-package-source: mirrored $pkg to examples/libs for legacy script_path"
  fi
done
