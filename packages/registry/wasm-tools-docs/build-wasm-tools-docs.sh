#!/usr/bin/env bash
# Manual page for wasm-tools, which ships without one, as
# wasm-tools-docs.zip, a lazy archive mounted at /usr/.
#
# The third tier of docs/porting-guide.md "Shipping man pages":
# kandelo_man_pages_capture_help runs wasm-tools inside Kandelo for --help
# and --version, and help2man lays out exactly what it printed. Its
# --help lists the subcommands; each has its own `wasm-tools help <cmd>`.
# The help has no one-line summary for the NAME line, so the page takes
# upstream's own, the crate's Cargo.toml description.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OWNER="${WASM_POSIX_DEP_WASM_TOOLS_DIR:?wasm-tools dependency dir required}"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
EPOCH="$(kandelo_man_pages_date_epoch "$(kandelo_man_pages_release_date "$VERSION" 1.263.0=2026-10-30)")"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<JSON
{
  "files": [
    {"from": "$OWNER/wasm-tools.wasm", "to": "/usr/bin/wasm-tools"}
  ],
  "env": ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "wasm-tools", "path": "/usr/bin/wasm-tools"}
  ]
}
JSON
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" wasm-tools "$PAGES/wasm-tools.1" \
    --source="wasm-tools $VERSION" \
    --name="CLI tools for interoperating with WebAssembly files"
install_package_man_pages wasm-tools-docs "$PAGES" wasm-tools.1
