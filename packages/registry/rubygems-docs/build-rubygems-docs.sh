#!/usr/bin/env bash
# Ship a manual page for gem, the RubyGems command bundled with Ruby, as
# rubygems-docs.zip, a lazy archive mounted at /usr/. gem runs from the
# ruby.zip tree the shell installs.
#
# RubyGems has no upstream manual page, so this is the third tier of
# docs/porting-guide.md "Shipping man pages": kandelo_man_pages_capture_help
# runs gem inside Kandelo and help2man lays out exactly what it printed.
# The help text is `gem help commands`, the command list `gem --help`
# points to: help2man recognizes section headings only at the start of a
# line, and `gem --help` indents all of its own, so help2man would run its
# usage and example lines together into one misleading paragraph. The
# page is dated with the release date of the Ruby that bundles this gem.
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
DATE="$(kandelo_man_pages_release_date "$VERSION" 4.0.5=2026-05-20)"

TREE="$WORK/ruby-tree"
rm -rf "$TREE"
mkdir -p "$TREE"
unzip -q "${WASM_POSIX_DEP_RUBY_BROWSER_BUNDLE_DIR:?}/ruby.zip" -d "$TREE"
SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "trees": [{"from": "$TREE", "to": "/usr"}],
  "commands": [{"name": "gem", "path": "/usr/bin/gem", "help": ["help", "commands"]}]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")" \
    kandelo_man_pages_help2man "$CAP" gem "$PAGES/gem.1" --source="Ruby 4.0.5"
install_package_man_pages rubygems-docs "$PAGES" gem.1
