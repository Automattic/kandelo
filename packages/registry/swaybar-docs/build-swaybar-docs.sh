#!/usr/bin/env bash
# Manual pages for swaybar, which sway ships without a page of its own (sway-bar(5) documents its configuration), as swaybar-docs.zip, a lazy archive mounted at /usr/.
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
OWNER="${WASM_POSIX_DEP_SWAY_DIR:?sway dependency dir required}"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
EPOCH="$(kandelo_man_pages_date_epoch "$(kandelo_man_pages_release_date "$VERSION" 1.12=2026-05-25)")"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [
    {"from": "$OWNER/swaybar.wasm", "to": "/usr/bin/swaybar"}
  ],
  "env": ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "swaybar", "path": "/usr/bin/swaybar", "stream": "stderr"}
  ]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" swaybar "$PAGES/swaybar.1" \
    --source="sway 1.12"
install_package_man_pages swaybar-docs "$PAGES" swaybar.1
