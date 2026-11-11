#!/usr/bin/env bash
# Manual pages for quickshell, which Quickshell ships without a manual page, as quickshell-docs.zip, a lazy archive mounted at /usr/.
#
# The third tier of docs/porting-guide.md "Shipping man pages":
# kandelo_man_pages_capture_help runs each command inside Kandelo for --help
# and --version, and help2man lays out exactly what it printed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OWNER="${WASM_POSIX_DEP_QUICKSHELL_DIR:?quickshell dependency dir required}"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
EPOCH="$(kandelo_man_pages_date_epoch "$(kandelo_man_pages_release_date "$VERSION" 0.3.1=2026-08-21)")"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [
    {"from": "$OWNER/quickshell.wasm", "to": "/usr/bin/quickshell"}
  ],
  "env": ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "quickshell", "path": "/usr/bin/quickshell"}
  ]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

# quickshell --version prints "Quickshell VERSION (revision ..., distributed
# by ...)"; help2man would name the page after the capitalized first word.
PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" quickshell "$PAGES/quickshell.1" \
    --source="Quickshell 0.3.1" \
    --version-string="quickshell (Quickshell) $(awk '{print $2}' "$CAP/quickshell.version")"
install_package_man_pages quickshell-docs "$PAGES" quickshell.1
