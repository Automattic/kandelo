#!/usr/bin/env bash
# Ship a manual page for ninja as ninja-docs.zip, a lazy archive mounted at
# /usr/.
#
# Upstream has no manual page (its manual is doc/manual.asciidoc, a user
# guide rather than a page), so this is the third tier of
# docs/porting-guide.md "Shipping man pages": kandelo_man_pages_capture_help
# runs ninja inside Kandelo for --help and --version, and help2man lays out
# exactly what it printed. ninja prints its usage on standard error. The
# page is dated with the release date of the source ninja is built from.
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
DATE="$(kandelo_man_pages_release_date "$VERSION" 1.13.2=2025-11-20)"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [{"from": "${WASM_POSIX_DEP_NINJA_DIR:?}/ninja.wasm", "to": "/usr/bin/ninja"}],
  "commands": [{"name": "ninja", "path": "/usr/bin/ninja", "stream": "stderr"}]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")" \
    kandelo_man_pages_help2man "$CAP" ninja "$PAGES/ninja.1" \
    --name="a small build system with a focus on speed" \
    --source="Ninja $VERSION"
install_package_man_pages ninja-docs "$PAGES" ninja.1
