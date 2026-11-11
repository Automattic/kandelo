#!/usr/bin/env bash
# Manual pages for wasm-opt, which Binaryen ships without a manual page, as binaryen-docs.zip, a lazy archive mounted at /usr/.
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
OWNER="${WASM_POSIX_DEP_BINARYEN_DIR:?binaryen dependency dir required}"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
EPOCH="$(kandelo_man_pages_date_epoch "$(kandelo_man_pages_release_date "$VERSION" 126=2026-02-13)")"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [
    {"from": "$OWNER/wasm-opt.wasm", "to": "/usr/bin/wasm-opt"}
  ],
  "env": ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "wasm-opt", "path": "/usr/bin/wasm-opt"}
  ]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" wasm-opt "$PAGES/wasm-opt.1" \
    --source="Binaryen 126"
install_package_man_pages binaryen-docs "$PAGES" wasm-opt.1
