#!/usr/bin/env bash
# Manual pages for toybox's dmesg and logger, as toybox-docs.zip, a lazy
# archive mounted at /usr/.
#
# The third tier of docs/porting-guide.md "Shipping man pages": toybox
# has no pages, only the help built into each applet, so
# kandelo_man_pages_capture_help runs each applet inside Kandelo for
# --help and help2man lays out what it printed.
#
# Toybox writes each option at column 0 with a tab before its
# description, and help2man reads an option only from an indented line,
# so the copy given to help2man indents those lines and puts two spaces
# where the tab was. No word changes. Every applet's --version prints
# only "toybox VERSION", so the page is told the applet's name.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OWNER="${WASM_POSIX_DEP_TOYBOX_DIR:?toybox dependency dir required}"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
EPOCH="$(kandelo_man_pages_date_epoch "$(kandelo_man_pages_release_date "$VERSION" 0.8.15=2026-10-03)")"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<JSON
{
  "files": [
    {"from": "$OWNER/dmesg.wasm", "to": "/usr/bin/dmesg"},
    {"from": "$OWNER/logger.wasm", "to": "/usr/bin/logger"}
  ],
  "env": ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "dmesg", "path": "/usr/bin/dmesg"},
    {"name": "logger", "path": "/usr/bin/logger"}
  ]
}
JSON
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

LAID_OUT="$WORK/help-laid-out"
PAGES="$WORK/pages"
rm -rf "$LAID_OUT" "$PAGES"
mkdir -p "$LAID_OUT"
for name in dmesg logger; do
    grep -qx "toybox $VERSION" "$CAP/$name.version" || {
        echo "build-toybox-docs: $name --version is not \"toybox $VERSION\"" >&2
        exit 1
    }
    cp "$CAP/$name.version" "$LAID_OUT/$name.version"
    sed -E 's/^(-[^[:space:]]+)	/  \1  /' "$CAP/$name.help" > "$LAID_OUT/$name.help"
    # The first line after the usage line describes the applet and names
    # the page. (Toybox prints a "Toybox VERSION" header before the usage.)
    summary="$(awk 'seen && NF { print; exit } /^usage: / { seen = 1 }' "$CAP/$name.help")"
    summary="${summary%.}"
    [ -n "$summary" ] || { echo "build-toybox-docs: no summary in $name --help" >&2; exit 1; }
    SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$LAID_OUT" "$name" "$PAGES/$name.1" \
        --source="toybox $VERSION" --version-string="$name (toybox) $VERSION" \
        --name="$summary"
done
install_package_man_pages toybox-docs "$PAGES" dmesg.1 logger.1
