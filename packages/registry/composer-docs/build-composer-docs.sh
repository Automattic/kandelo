#!/usr/bin/env bash
# Ship a manual page for composer as composer-docs.zip, a lazy archive
# mounted at /usr/. Composer runs as the shell installs it: the
# composer.zip tree at /usr, with the php package's /usr/bin/php and bash
# as /bin/sh, the interpreter of the bin/composer launcher. Its
# --help is Symfony Console's help for the `list` command, which also
# describes the global options. Composer refuses to run as root, so the
# capture runs it as the shell's ordinary user.
#
# The program has no upstream manual page, so this is the third tier of
# docs/porting-guide.md "Shipping man pages": kandelo_man_pages_capture_help
# runs it inside Kandelo for --help and --version, and help2man lays out
# exactly what it printed. The page is dated with the release date of the
# source the program is built from.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
DATE="$(kandelo_man_pages_release_date "$VERSION" 2.10.3=2026-08-27)"

TREE="$WORK/composer-tree"
rm -rf "$TREE"
mkdir -p "$TREE"
unzip -q "${WASM_POSIX_DEP_COMPOSER_DIR:?}/composer.zip" -d "$TREE"
SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [
    {"from": "${WASM_POSIX_DEP_PHP_DIR:?}/php.wasm", "to": "/usr/bin/php"},
    {"from": "${WASM_POSIX_DEP_BASH_DIR:?}/bash.wasm", "to": "/bin/bash"}
  ],
  "trees": [{"from": "$TREE", "to": "/usr"}],
  "env": ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"],
  "uid": 1000, "gid": 1000,
  "commands": [{"name": "composer", "path": "/usr/bin/composer"}]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")" \
    kandelo_man_pages_help2man "$CAP" composer "$PAGES/composer.1" --source="Composer 2.10.3"
install_package_man_pages composer-docs "$PAGES" composer.1
