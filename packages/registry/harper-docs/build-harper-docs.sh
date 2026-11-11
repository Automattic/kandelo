#!/usr/bin/env bash
# Manual pages for harper-cli and harper-ls, which Harper ships without manual pages, as harper-docs.zip, a lazy archive mounted at /usr/.
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
OWNER="${WASM_POSIX_DEP_HARPER_DIR:?harper dependency dir required}"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
EPOCH="$(kandelo_man_pages_date_epoch "$(kandelo_man_pages_release_date "$VERSION" 3.0.0=2026-10-27)")"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [
    {"from": "$OWNER/harper-cli.wasm", "to": "/usr/bin/harper-cli"},
    {"from": "$OWNER/harper-ls.wasm", "to": "/usr/bin/harper-ls"}
  ],
  "env": ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "harper-cli", "path": "/usr/bin/harper-cli"},
    {"name": "harper-ls", "path": "/usr/bin/harper-ls"}
  ]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" harper-cli "$PAGES/harper-cli.1" \
    --source="Harper 3.0.0"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" harper-ls "$PAGES/harper-ls.1" \
    --source="Harper 3.0.0"
install_package_man_pages harper-docs "$PAGES" harper-cli.1 harper-ls.1
